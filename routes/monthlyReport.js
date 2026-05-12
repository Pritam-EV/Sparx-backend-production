// routes/monthlyReport.js
// ─────────────────────────────────────────────────────────────────────────────
//  Monthly Report: aggregates charging receipts + EB charges into one
//  comprehensive financial report for a given project + month.
//
//  Endpoints:
//    GET /api/reports/owner/monthly?project=PROJ_A&month=2026-05
//    GET /api/reports/owner/available-months?project=PROJ_A
// ─────────────────────────────────────────────────────────────────────────────
const express         = require('express');
const router          = express.Router();
const auth            = require('../middleware/authMiddleware');
const authorizeRoles  = require('../middleware/roleMiddleware');
const Device          = require('../models/device');
const Receipt         = require('../models/Receipt');
const ElectricityBill = require('../models/ElectricityBill');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Safe 2-decimal rounding */
const r2 = (n) => Number((Number(n) || 0).toFixed(2));

/** Parse YYYY-MM into a Date range covering the full calendar month (UTC) */
const monthToDateRange = (month) => {
  const [year, mon] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0, 0));
  const end   = new Date(Date.UTC(year, mon,     0, 23, 59, 59, 999));
  return { start, end };
};

/** Extract amount from a ChargeLine sub-doc */
const chargeAmt = (line) =>
  line && typeof line.amount === 'number' ? line.amount : 0;

// ─── GET /api/reports/owner/monthly ──────────────────────────────────────────
router.get(
  '/owner/monthly',
  auth,
  authorizeRoles('owner', 'admin'),
  async (req, res) => {
    try {
      const { project, month } = req.query;
      const userId = req.user.userId;

      // ── Input validation
      if (!project || !project.trim()) {
        return res.status(400).json({ error: 'project is required.' });
      }
      if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month.trim())) {
        return res.status(400).json({ error: 'month must be in YYYY-MM format.' });
      }

      // ── Authorization
      if (req.user.role !== 'admin') {
        const ownsDevice = await Device.exists({
          ownerId:                        { $in: [userId] },
          project:                        project.trim(),
          'commercial.electricityBearer': 'VJRA'
        });
        if (!ownsDevice) {
          return res.status(403).json({
            error: 'You do not have a VJRA-bearer device in this project.'
          });
        }
      }

      // ── 1. Fetch all VJRA devices in this project
      const deviceQuery = {
        project:                        project.trim(),
        'commercial.electricityBearer': 'VJRA'
      };
      if (req.user.role !== 'admin') deviceQuery.ownerId = { $in: [userId] };

      const devices = await Device.find(deviceQuery)
        .select('device_id charger_type rate location area city status commercial')
        .lean();

      if (!devices.length) {
        return res.json({
          project:  project.trim(),
          month:    month.trim(),
          ebStatus: 'not_generated',
          message:  'No VJRA devices found for this project.',
          devices:  []
        });
      }

      const deviceIds = devices.map(d => d.device_id);

      // ── 2. Fetch EB document for this project + month
      const eb = await ElectricityBill.findOne({
        project:  project.trim(),
        month:    month.trim(),
        isVoided: false
      }).lean();

      // ── 3. Aggregate charging receipts
      const { start, end } = monthToDateRange(month.trim());

      const [receiptAgg] = await Receipt.aggregate([
        {
          $match: {
            deviceId:  { $in: deviceIds },
            createdAt: { $gte: start, $lte: end }
          }
        },
        {
          $group: {
            _id:             null,
            sessionsCount:   { $sum: 1 },
            totalEnergy:     { $sum: { $ifNull: ['$energyConsumed',   0] } },
            taxableAmount:   { $sum: { $ifNull: ['$taxableAmount',    0] } },
            gstAmount:       { $sum: { $ifNull: ['$gstAmount',        0] } },
            grossRevenue:    { $sum: { $ifNull: ['$totalAmount',      0] } },
            vjraCommission:  { $sum: { $ifNull: ['$vjraMarginAmount', 0] } },
            pgCharges:       { $sum: { $ifNull: ['$paymentCharges',   0] } },
            totalRefund:     { $sum: { $ifNull: ['$refundAmount',     0] } },
            ownerPayout:     { $sum: { $ifNull: ['$ownerPayout',      0] } }
          }
        }
      ]);

      const cs = receiptAgg || {
        sessionsCount: 0, totalEnergy: 0,
        taxableAmount: 0, gstAmount: 0, grossRevenue: 0,
        vjraCommission: 0, pgCharges: 0, totalRefund: 0, ownerPayout: 0
      };

      // ── 4. Build EB charges block
      const ebCharges = eb
        ? {
            energyCharges:         { amount: r2(chargeAmt(eb.charges.energyCharges)),         remarks: eb.charges.energyCharges?.remarks         || '' },
            wheelingCharges:       { amount: r2(chargeAmt(eb.charges.wheelingCharges)),       remarks: eb.charges.wheelingCharges?.remarks       || '' },
            demandCharges:         { amount: r2(chargeAmt(eb.charges.demandCharges)),         remarks: eb.charges.demandCharges?.remarks         || '' },
            fac:                   { amount: r2(chargeAmt(eb.charges.fac)),                   remarks: eb.charges.fac?.remarks                   || '' },
            fixedCharges:          { amount: r2(chargeAmt(eb.charges.fixedCharges)),          remarks: eb.charges.fixedCharges?.remarks          || '' },
            electricityDuty:       { amount: r2(chargeAmt(eb.charges.electricityDuty)),       remarks: eb.charges.electricityDuty?.remarks       || '' },
            meterRent:             { amount: r2(chargeAmt(eb.charges.meterRent)),             remarks: eb.charges.meterRent?.remarks             || '' },
            powerFactorAdjustment: { amount: r2(chargeAmt(eb.charges.powerFactorAdjustment)), remarks: eb.charges.powerFactorAdjustment?.remarks || '' },
            delayedPaymentCharges: { amount: r2(chargeAmt(eb.charges.delayedPaymentCharges)), remarks: eb.charges.delayedPaymentCharges?.remarks || '' },
            regulatoryCharges:     { amount: r2(chargeAmt(eb.charges.regulatoryCharges)),     remarks: eb.charges.regulatoryCharges?.remarks     || '' },
            otherCharges:          { amount: r2(chargeAmt(eb.charges.otherCharges)),          remarks: eb.charges.otherCharges?.remarks          || '' },
            totalOwnerPayable: r2(eb.totalOwnerPayable),
            totalEBAmount:     r2(eb.totalEBAmount)
          }
        : {
            energyCharges:         { amount: 0, remarks: '' },
            wheelingCharges:       { amount: 0, remarks: '' },
            demandCharges:         { amount: 0, remarks: '' },
            fac:                   { amount: 0, remarks: '' },
            fixedCharges:          { amount: 0, remarks: '' },
            electricityDuty:       { amount: 0, remarks: '' },
            meterRent:             { amount: 0, remarks: '' },
            powerFactorAdjustment: { amount: 0, remarks: '' },
            delayedPaymentCharges: { amount: 0, remarks: '' },
            regulatoryCharges:     { amount: 0, remarks: '' },
            otherCharges:          { amount: 0, remarks: '' },
            totalOwnerPayable: 0,
            totalEBAmount:     0
          };

      // ── 5. Payout waterfall
      //
      //  grossRevenue           (charging revenue incl. GST collected from users)
      //  − lessOwnerEBShare     (owner's fixed EB charges paid back to VJRA)
      //  − lessVJRACommission   (VJRA platform fee, ₹2/kWh)
      //  − lessPGCharges        (Cashfree / PG fees)
      //  − lessGST              (GST collected → remitted to govt)
      //  ──────────────────────
      //  = netPayout            (VJRA transfers this to owner)
      //
      //  Note: energyCharges (VJRA's EB energy cost) are borne by VJRA
      //        and do NOT reduce the owner's payout.

      const grossRevenue       = r2(cs.grossRevenue);
      const lessOwnerEBShare   = r2(ebCharges.totalOwnerPayable);
      const lessVJRACommission = r2(cs.vjraCommission);
      const lessPGCharges      = r2(cs.pgCharges);
      const lessGST            = r2(cs.gstAmount);
      const netPayout          = r2(
        grossRevenue - lessOwnerEBShare - lessVJRACommission - lessPGCharges - lessGST
      );

      // ── 6. Final response
      return res.json({
        project: project.trim(),
        month:   month.trim(),

        ebStatus: eb ? eb.status : 'not_generated',
        hasPdf:   eb ? Boolean(eb.ebPdfPath) : false,
        ebId:     eb ? eb._id : null,

        chargingSummary: {
          sessionsCount:  cs.sessionsCount,
          totalEnergy:    r2(cs.totalEnergy),
          taxableAmount:  r2(cs.taxableAmount),
          gstAmount:      r2(cs.gstAmount),
          grossRevenue:   r2(cs.grossRevenue),
          vjraCommission: r2(cs.vjraCommission),
          pgCharges:      r2(cs.pgCharges),
          totalRefund:    r2(cs.totalRefund)
        },

        ebCharges,

        payoutCalculation: {
          grossRevenue,
          lessOwnerEBShare,
          lessVJRACommission,
          lessPGCharges,
          lessGST,
          netPayout
        },

        ownerPayment: eb ? (eb.ownerPayment || null) : null,
        msebPaidAt:   eb ? (eb.msebPaidAt   || null) : null,

        devices: devices.map(d => ({
          device_id:    d.device_id,
          charger_type: d.charger_type,
          rate:         d.rate,
          location:     d.location,
          area:         d.area,
          city:         d.city,
          status:       d.status
        }))
      });
    } catch (err) {
      console.error('[monthlyReport]', err);
      return res.status(500).json({
        error:  'Server error while generating monthly report.',
        detail: err.message
      });
    }
  }
);

// ─── GET /api/reports/owner/available-months ─────────────────────────────────
//  Lightweight endpoint for the month-selector dropdown in the Owner Dashboard.
//  Returns months that have receipt data OR an EB record, merged into one list.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/owner/available-months',
  auth,
  authorizeRoles('owner', 'admin'),
  async (req, res) => {
    try {
      const { project } = req.query;
      const userId = req.user.userId;

      if (!project || !project.trim()) {
        return res.status(400).json({ error: 'project is required.' });
      }

      // Authorization
      if (req.user.role !== 'admin') {
        const ownsDevice = await Device.exists({
          ownerId:                        { $in: [userId] },
          project:                        project.trim(),
          'commercial.electricityBearer': 'VJRA'
        });
        if (!ownsDevice) {
          return res.status(403).json({ error: 'Access denied.' });
        }
      }

      const deviceQuery = {
        project:                        project.trim(),
        'commercial.electricityBearer': 'VJRA'
      };
      if (req.user.role !== 'admin') deviceQuery.ownerId = { $in: [userId] };
      const devices   = await Device.find(deviceQuery).select('device_id').lean();
      const deviceIds = devices.map(d => d.device_id);

      // Months from EB records
      const ebMonths = await ElectricityBill.find({
        project:  project.trim(),
        isVoided: false
      }).select('month status').sort({ month: -1 }).lean();

      // Months from receipts (grouped by YYYY-MM)
      const receiptMonths = await Receipt.aggregate([
        { $match: { deviceId: { $in: deviceIds } } },
        {
          $group: {
            _id:           { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
            sessionsCount: { $sum: 1 },
            totalEnergy:   { $sum: { $ifNull: ['$energyConsumed', 0] } }
          }
        },
        { $sort:  { _id: -1 } },
        { $limit: 24 }
      ]);

      // Merge into a unified month map
      const monthMap = {};

      ebMonths.forEach(e => {
        monthMap[e.month] = {
          month:    e.month,
          ebStatus: e.status,
          ebId:     e._id,
          hasEB:    true
        };
      });

      receiptMonths.forEach(r => {
        if (!monthMap[r._id]) {
          monthMap[r._id] = {
            month:    r._id,
            ebStatus: 'not_generated',
            ebId:     null,
            hasEB:    false
          };
        }
        monthMap[r._id].sessionsCount = r.sessionsCount;
        monthMap[r._id].totalEnergy   = r2(r.totalEnergy);
      });

      const months = Object.values(monthMap).sort((a, b) =>
        b.month.localeCompare(a.month)
      );

      return res.json({ project: project.trim(), months });
    } catch (err) {
      console.error('[available-months]', err);
      return res.status(500).json({ error: 'Server error.' });
    }
  }
);

module.exports = router;