// routes/electricityBill.js
// ─────────────────────────────────────────────────────────────────────────────
//  Endpoint map:
//
//  [ADMIN]
//  POST   /api/eb/admin/upload                    Create / update EB for project+month
//  GET    /api/eb/admin/list                       List all EB records (paginated)
//  GET    /api/eb/admin/pending-count              Count of payment_submitted records (badge)
//  GET    /api/eb/admin/:id                        Single EB detail
//  PATCH  /api/eb/admin/:id/verify-payment         Confirm owner payment received
//  PATCH  /api/eb/admin/:id/mark-eb-paid           Mark EB as paid to MSEB
//  PATCH  /api/eb/admin/:id/void                   Void an incorrect EB record
//
//  [OWNER]
//  GET    /api/eb/owner/projects                   List VJRA projects the owner has devices in
//  GET    /api/eb/owner/:project/:month            Get EB + payment state for owner view
//  POST   /api/eb/owner/:id/record-payment         Owner submits txnId + amount
//
//  [BOTH]
//  GET    /api/eb/:id/download-pdf                 Get 1-hour signed Firebase URL for EB PDF
// ─────────────────────────────────────────────────────────────────────────────
const express        = require('express');
const router         = express.Router();
const mongoose       = require('mongoose');
const auth           = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/roleMiddleware');
const { parseAndUploadEB } = require('../middleware/uploadEB');
const { getSignedUrl, deleteStorageFile } = require('../firebaseAdmin');
const ElectricityBill = require('../models/ElectricityBill');
const Device          = require('../models/device');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse numeric charge fields from req.body into the charges sub-document */
const parseCharges = (body) => {
  const num = (v) => (v !== undefined && v !== '' ? Number(v) : 0);
  return {
    energyCharges:         { amount: num(body.energyCharges),         remarks: body.energyChargesRemarks         || '' },
    wheelingCharges:       { amount: num(body.wheelingCharges),       remarks: body.wheelingChargesRemarks       || '' },
    demandCharges:         { amount: num(body.demandCharges),         remarks: body.demandChargesRemarks         || '' },
    fac:                   { amount: num(body.fac),                   remarks: body.facRemarks                   || '' },
    fixedCharges:          { amount: num(body.fixedCharges),          remarks: body.fixedChargesRemarks          || '' },
    electricityDuty:       { amount: num(body.electricityDuty),       remarks: body.electricityDutyRemarks       || '' },
    meterRent:             { amount: num(body.meterRent),             remarks: body.meterRentRemarks             || '' },
    powerFactorAdjustment: { amount: num(body.powerFactorAdjustment), remarks: body.powerFactorAdjustmentRemarks || '' },
    delayedPaymentCharges: { amount: num(body.delayedPaymentCharges), remarks: body.delayedPaymentChargesRemarks || '' },
    regulatoryCharges:     { amount: num(body.regulatoryCharges),     remarks: body.regulatoryChargesRemarks     || '' },
    otherCharges: { amount: 0, remarks: '' },  // legacy field, kept for schema compat
  };
};

/** Validate YYYY-MM format */
const isValidMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

// ============================================================
//  ADMIN ROUTES
// ============================================================
// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/eb/admin/projects
//  Returns distinct projects that have at least one device with
//  commercial.electricityBearer === "VJRA". Used to populate the project
//  dropdown in the admin EB upload form.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/admin/projects',
  auth,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const devices = await Device.find({
        'commercial.electricityBearer': 'VJRA',
        project: { $exists: true, $ne: null, $ne: '' }
      })
        .select('project ownerId device_id')
        .populate('ownerId', 'name email')
        .lean();

      if (!devices.length) return res.json({ projects: [] });

      // Group devices by project
      const map = {};
      devices.forEach((d) => {
        const proj = d.project.trim();
        if (!map[proj]) {
          map[proj] = {
            project: proj,
            deviceCount: 0,
            owners: new Set(),
          };
        }
        map[proj].deviceCount += 1;
        // collect unique owner names
        const ownerArr = Array.isArray(d.ownerId) ? d.ownerId : [d.ownerId];
        ownerArr.forEach((o) => {
          if (o && o.name) map[proj].owners.add(o.name);
        });
      });

      const projects = Object.values(map).map((p) => ({
        project: p.project,
        deviceCount: p.deviceCount,
        ownerNames: [...p.owners],
      }));

      projects.sort((a, b) => a.project.localeCompare(b.project));

      return res.json({ projects });
    } catch (err) {
      console.error('[EB admin/projects]', err);
      return res.status(500).json({ error: 'Server error while fetching projects.' });
    }
  }
);
// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/eb/admin/upload
//  Create a new EB or update an existing one for the same project+month.
//  Accepts multipart/form-data (PDF optional).
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/admin/upload',
  auth,
  authorizeRoles('admin'),
  parseAndUploadEB,       // handles multipart + optional Firebase upload
  async (req, res) => {
    try {
      const { project, month } = req.body;

      if (!project || !project.trim()) {
        return res.status(400).json({ error: 'project is required.' });
      }
      if (!month || !isValidMonth(month.trim())) {
        return res.status(400).json({ error: 'month must be in YYYY-MM format.' });
      }

      const charges = parseCharges(req.body);

      // Parse the dynamic otherCharges array from frontend
let extraCharges = [];
try {
  const raw = body.otherCharges;  // could be a JSON string or undefined
  if (raw) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      extraCharges = parsed
        .filter(o => o.label && o.label.trim() && o.amount !== '')
        .map(o => ({ label: o.label.trim(), amount: Number(o.amount) || 0 }));
    }
  }
} catch (e) {
  extraCharges = [];
}
// Manually compute totals (pre-save hook won't run on findOneAndUpdate)
const amt = (line) => (line?.amount || 0);
const totalOwnerPayable = Number((
  amt(charges.wheelingCharges) +
  amt(charges.demandCharges) +
  amt(charges.fac) +
  amt(charges.fixedCharges) +
  amt(charges.electricityDuty) +
  amt(charges.meterRent) +
  amt(charges.powerFactorAdjustment) +
  amt(charges.delayedPaymentCharges) +
  amt(charges.regulatoryCharges) +
  amt(charges.otherCharges)
).toFixed(2));

const totalEBAmount = Number((totalOwnerPayable + amt(charges.energyCharges)).toFixed(2));
const update = {
  charges,
  extraCharges,
  totalOwnerPayable,
  totalEBAmount,       // ← now actually saved
  lastUpdatedBy: req.user.userId
};

      // Attach PDF path only if a file was uploaded
      if (req.ebUpload) {
        update.ebPdfPath = req.ebUpload.storagePath;
      }

      // Upsert: create if not exists, update if exists
      // New records get status "uploaded" and uploadedBy set
      const eb = await ElectricityBill.findOneAndUpdate(
        { project: project.trim(), month: month.trim() },
        {
          $set: update,
          $setOnInsert: {
            project: project.trim(),
            month:   month.trim(),
            status:  'uploaded',
            uploadedBy: req.user.userId
          }
        },
        { upsert: true, new: true, runValidators: true }
      );

      return res.status(200).json({
        message: eb.wasNew ? 'EB created successfully.' : 'EB updated successfully.',
        eb
      });
    } catch (err) {
      if (err.code === 11000) {
        // Shouldn't reach here due to upsert, but guard anyway
        return res.status(409).json({ error: 'An EB for this project and month already exists.' });
      }
      console.error('[EB upload]', err);
      return res.status(500).json({ error: 'Server error while saving EB.', detail: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/eb/admin/list
//  All EB records with optional filters + pagination.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/admin/list',
  auth,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const {
        project,
        month,
        status,
        page  = 1,
        limit = 20
      } = req.query;

      const pageNum = Math.max(1, parseInt(page, 10)  || 1);
      const lim     = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
      const skip    = (pageNum - 1) * lim;

      const match = { isVoided: false };
      if (project) match.project = new RegExp(project.trim(), 'i');
      if (month)   match.month   = month.trim();
      if (status && ['uploaded','payment_submitted','payment_verified','eb_paid_to_mseb'].includes(status)) {
        match.status = status;
      }

      const [data] = await ElectricityBill.aggregate([
        { $match: match },
        {
          $facet: {
            list: [
              { $sort: { month: -1, createdAt: -1 } },
              { $skip: skip },
              { $limit: lim },
              {
                $project: {
                  project: 1, month: 1, status: 1,
                  totalEBAmount: 1, totalOwnerPayable: 1,
                  ebPdfPath: 1,
                  'charges.energyCharges.amount':         1,
                  'charges.wheelingCharges.amount':       1,
                  'charges.demandCharges.amount':         1,
                  'charges.fac.amount':                   1,
                  'charges.fixedCharges.amount':          1,
                  'charges.electricityDuty.amount':       1,
                  'charges.meterRent.amount':             1,
                  'charges.powerFactorAdjustment.amount': 1,
                  'charges.delayedPaymentCharges.amount': 1,
                  'charges.regulatoryCharges.amount':     1,
                  'charges.otherCharges.amount':          1,
                  'extraCharges':                          1,
                  'ownerPayment.txnId': 1,
                  'ownerPayment.amountPaid': 1,
                  'ownerPayment.submittedAt': 1,
                  'ownerPayment.verifiedAt': 1,
                  msebPaidAt: 1,
                  createdAt: 1, updatedAt: 1
                }
              }
            ],
            count: [{ $count: 'total' }],
            // Counts per status for the admin dashboard KPI bar
            statusCounts: [
              { $group: { _id: '$status', count: { $sum: 1 } } }
            ]
          }
        }
      ]);

      const list         = data?.list         || [];
      const total        = data?.count?.[0]?.total || 0;
      const statusCounts = (data?.statusCounts || []).reduce((acc, s) => {
        acc[s._id] = s.count;
        return acc;
      }, {});

      return res.json({
        page: pageNum, limit: lim, total,
        statusCounts,
        ebs: list
      });
    } catch (err) {
      console.error('[EB list]', err);
      return res.status(500).json({ error: 'Server error while fetching EB list.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/eb/admin/pending-count
//  Returns count of payment_submitted records — used for admin sidebar badge.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/admin/pending-count',
  auth,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const count = await ElectricityBill.countDocuments({
        status: 'payment_submitted',
        isVoided: false
      });
      return res.json({ count });
    } catch (err) {
      console.error('[EB pending-count]', err);
      return res.status(500).json({ error: 'Server error.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/eb/admin/:id
//  Full detail of a single EB record.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/admin/:id',
  auth,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: 'Invalid EB id.' });
      }
      const eb = await ElectricityBill.findById(req.params.id)
        .populate('uploadedBy',    'name email')
        .populate('lastUpdatedBy', 'name email')
        .populate('ownerPayment.verifiedBy', 'name email')
        .populate('msebPaidBy', 'name email')
        .lean();

      if (!eb) return res.status(404).json({ error: 'EB record not found.' });
      return res.json({ eb });
    } catch (err) {
      console.error('[EB get detail]', err);
      return res.status(500).json({ error: 'Server error.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /api/eb/admin/:id/verify-payment
//  Admin confirms that the owner’s bank transfer has been received.
//  Transitions: payment_submitted → payment_verified
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/admin/:id/verify-payment',
  auth,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: 'Invalid EB id.' });
      }

      const eb = await ElectricityBill.findOne({
        _id: req.params.id,
        isVoided: false
      });
      if (!eb) return res.status(404).json({ error: 'EB record not found.' });

      // Guard: only allow transition from payment_submitted
      if (eb.status !== 'payment_submitted') {
        return res.status(409).json({
          error: `Cannot verify payment. Current status is "${eb.status}". Owner must submit payment first.`
        });
      }

      eb.status                        = 'payment_verified';
      eb.ownerPayment.verifiedAt       = new Date();
      eb.ownerPayment.verifiedBy       = req.user.userId;
      eb.lastUpdatedBy                 = req.user.userId;

      await eb.save();

      return res.json({ message: 'Payment verified successfully.', eb });
    } catch (err) {
      console.error('[EB verify-payment]', err);
      return res.status(500).json({ error: 'Server error.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /api/eb/admin/:id/mark-eb-paid
//  Admin marks that VJRA has paid the EB to MSEB. Final state.
//  Transitions: payment_verified → eb_paid_to_mseb
//  (Admin CAN also do this from payment_submitted if owner paid outside the system)
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/admin/:id/mark-eb-paid',
  auth,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: 'Invalid EB id.' });
      }

      const eb = await ElectricityBill.findOne({
        _id: req.params.id,
        isVoided: false
      });
      if (!eb) return res.status(404).json({ error: 'EB record not found.' });

      const allowedFromStatuses = ['payment_verified', 'payment_submitted'];
      if (!allowedFromStatuses.includes(eb.status)) {
        return res.status(409).json({
          error: `Cannot mark as paid. Current status is "${eb.status}".`
        });
      }

      eb.status        = 'eb_paid_to_mseb';
      eb.msebPaidAt    = new Date();
      eb.msebPaidBy    = req.user.userId;
      eb.lastUpdatedBy = req.user.userId;

      await eb.save();

      return res.json({ message: 'EB marked as paid to MSEB.', eb });
    } catch (err) {
      console.error('[EB mark-eb-paid]', err);
      return res.status(500).json({ error: 'Server error.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /api/eb/admin/:id/void
//  Soft-delete: admin voids an incorrectly created EB.
//  Voided records are hidden from all list views but preserved for audit.
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/admin/:id/void',
  auth,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: 'Invalid EB id.' });
      }

      const eb = await ElectricityBill.findOne({ _id: req.params.id });
      if (!eb) return res.status(404).json({ error: 'EB record not found.' });

      if (eb.status === 'eb_paid_to_mseb') {
        return res.status(409).json({
          error: 'Cannot void an EB that has already been paid to MSEB.'
        });
      }

      eb.isVoided      = true;
      eb.lastUpdatedBy = req.user.userId;
      await eb.save();

      // Clean up the PDF from Firebase Storage if it exists
      if (eb.ebPdfPath) {
        await deleteStorageFile(eb.ebPdfPath);
      }

      return res.json({ message: 'EB voided successfully.' });
    } catch (err) {
      console.error('[EB void]', err);
      return res.status(500).json({ error: 'Server error.' });
    }
  }
);

// ============================================================
//  OWNER ROUTES
// ============================================================

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/eb/owner/projects
//  Returns the list of distinct projects where the owner has at least one device
//  with commercial.electricityBearer === "VJRA".
//  Also returns available months (EB records) per project.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/owner/projects',
  auth,
  authorizeRoles('owner', 'admin'),
  async (req, res) => {
    try {
      const userId = req.user.userId;

      // Find all VJRA devices owned by this user
      const devices = await Device.find({
        ownerId: { $in: [userId] },
        'commercial.electricityBearer': 'VJRA',
        project: { $exists: true, $ne: null, $ne: '' }
      }).select('project device_id').lean();

      if (!devices.length) {
        return res.json({ projects: [] });
      }

      const projects = [...new Set(devices.map(d => d.project))];

      // For each project, fetch available EB months (non-voided)
      const ebRecords = await ElectricityBill.find({
        project: { $in: projects },
        isVoided: false
      })
        .select('project month status totalOwnerPayable totalEBAmount')
        .sort({ month: -1 })
        .lean();

      // Group months by project
      const projectMap = projects.map((proj) => ({
        project: proj,
        deviceCount: devices.filter(d => d.project === proj).length,
        months: ebRecords
          .filter(r => r.project === proj)
          .map(r => ({
            month:             r.month,
            status:            r.status,
            totalOwnerPayable: r.totalOwnerPayable,
            totalEBAmount:     r.totalEBAmount,
            ebId:              r._id
          }))
      }));

      return res.json({ projects: projectMap });
    } catch (err) {
      console.error('[EB owner/projects]', err);
      return res.status(500).json({ error: 'Server error.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/eb/owner/:project/:month
//  Full EB detail for the owner’s view. Verifies the owner actually has
//  a VJRA device in the requested project before serving data.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/owner/:project/:month',
  auth,
  authorizeRoles('owner', 'admin'),
  async (req, res) => {
    try {
      const { project, month } = req.params;
      const userId = req.user.userId;

      if (!isValidMonth(month)) {
        return res.status(400).json({ error: 'month must be in YYYY-MM format.' });
      }

      // Authorization: confirm owner has a VJRA device in this project
      // (admins skip this check)
      if (req.user.role !== 'admin') {
        const ownsDevice = await Device.exists({
          ownerId: { $in: [userId] },
          project: project,
          'commercial.electricityBearer': 'VJRA'
        });
        if (!ownsDevice) {
          return res.status(403).json({
            error: 'You do not have a VJRA-bearer device in this project.'
          });
        }
      }

      const eb = await ElectricityBill.findOne({
        project,
        month,
        isVoided: false
      }).lean();

      if (!eb) {
        // EB not yet generated for this month — return a "not yet available" state
        return res.json({
          status: 'not_generated',
          message: 'The Electricity Bill for this month has not been generated yet. VJRA will update this section once the EB is received from MSEB.'
        });
      }

      // Strip internal audit fields before sending to owner
      const { uploadedBy, lastUpdatedBy, msebPaidBy, isVoided, __v, ...ownerView } = eb;

      // Never expose the raw Firebase storage path to the owner
      // They get a download URL via the separate /download-pdf endpoint
      delete ownerView.ebPdfPath;
      ownerView.hasPdf = Boolean(eb.ebPdfPath);

      return res.json({ eb: ownerView });
    } catch (err) {
      console.error('[EB owner detail]', err);
      return res.status(500).json({ error: 'Server error.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/eb/owner/:id/record-payment
//  Owner records their bank transfer (txnId + amount).
//  Transitions: uploaded → payment_submitted
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/owner/:id/record-payment',
  auth,
  authorizeRoles('owner', 'admin'),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: 'Invalid EB id.' });
      }

      const { txnId, amountPaid } = req.body;

      if (!txnId || !String(txnId).trim()) {
        return res.status(400).json({ error: 'txnId is required.' });
      }
      if (!amountPaid || isNaN(Number(amountPaid)) || Number(amountPaid) <= 0) {
        return res.status(400).json({ error: 'amountPaid must be a positive number.' });
      }

      const eb = await ElectricityBill.findOne({
        _id: req.params.id,
        isVoided: false
      });
      if (!eb) return res.status(404).json({ error: 'EB record not found.' });

      // Authorization: owner must have a VJRA device in this project
      if (req.user.role !== 'admin') {
        const ownsDevice = await Device.exists({
          ownerId: { $in: [req.user.userId] },
          project: eb.project,
          'commercial.electricityBearer': 'VJRA'
        });
        if (!ownsDevice) {
          return res.status(403).json({ error: 'Access denied.' });
        }
      }

      // Guard: only allow if status is "uploaded"
      // (allow re-submission only if admin has NOT yet verified)
      const submittableStatuses = ['uploaded'];
      if (!submittableStatuses.includes(eb.status)) {
        return res.status(409).json({
          error: `Payment already recorded. Current status: "${eb.status}".`
        });
      }

      eb.status              = 'payment_submitted';
      eb.ownerPayment        = {
        txnId:       String(txnId).trim(),
        amountPaid:  Number(Number(amountPaid).toFixed(2)),
        submittedAt: new Date()
      };
      eb.lastUpdatedBy = req.user.userId;

      await eb.save();

      return res.json({
        message: 'Payment recorded successfully. VJRA will verify and confirm shortly.',
        status: eb.status
      });
    } catch (err) {
      console.error('[EB record-payment]', err);
      return res.status(500).json({ error: 'Server error.' });
    }
  }
);

// ============================================================
//  SHARED ROUTE
// ============================================================

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/eb/:id/download-pdf
//  Generates a fresh 1-hour signed URL for the EB PDF.
//  Accessible to both admin and owner (with project ownership check).
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:id/download-pdf',
  auth,
  authorizeRoles('owner', 'admin'),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: 'Invalid EB id.' });
      }

      const eb = await ElectricityBill.findOne({
        _id: req.params.id,
        isVoided: false
      }).select('ebPdfPath project').lean();

      if (!eb)           return res.status(404).json({ error: 'EB record not found.' });
      if (!eb.ebPdfPath) return res.status(404).json({ error: 'No PDF has been uploaded for this EB yet.' });

      // Authorization: owner must have a VJRA device in this project
      if (req.user.role !== 'admin') {
        const ownsDevice = await Device.exists({
          ownerId: { $in: [req.user.userId] },
          project: eb.project,
          'commercial.electricityBearer': 'VJRA'
        });
        if (!ownsDevice) {
          return res.status(403).json({ error: 'Access denied.' });
        }
      }

      // Generate a 1-hour signed URL
      const signedUrl = await getSignedUrl(eb.ebPdfPath, 60 * 60 * 1000);

      return res.json({ url: signedUrl, expiresInSeconds: 3600 });
    } catch (err) {
      console.error('[EB download-pdf]', err);
      return res.status(500).json({ error: 'Could not generate download URL.' });
    }
  }
);

module.exports = router;