// controllers/ownerReportController.js
// ─────────────────────────────────────────────────────────────────────────────
//  Handles all logic for the Owner Reports page (Analytics → Reports).
//  Only applies to projects where commercial.electricityBearer === 'VJRA'.
//
//  Endpoints (mounted in routes/monthlyReport.js):
//    GET  /api/reports/owner/monthly          Main report for a project+month
//    GET  /api/reports/owner/available-months Month list for project dropdown
//    GET  /api/reports/owner/projects         Projects the owner has VJRA devices in
//    GET  /api/reports/owner/pdf              Generate + stream report PDF
// ─────────────────────────────────────────────────────────────────────────────

const Device          = require('../models/device');
const Receipt         = require('../models/Receipt');
const ElectricityBill = require('../models/ElectricityBill');

// ─── Constants ────────────────────────────────────────────────────────────────

// VJRA bank details — update when live account is confirmed
const VJRA_BANK = {
  accountName:   'Vjra Technologies LLP',
  bankName:      'HDFC Bank',
  accountNumber:  'XXXXXXXXXXXX1234',
  ifsc:           'HDFC0001234',
  accountType:    'Current Account',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Round to 2 decimal places */
const r2 = (n) => Number((Number(n) || 0).toFixed(2));

/** Extract amount from a ChargeLine sub-doc */
const chargeAmt = (line) =>
  line && typeof line.amount === 'number' ? line.amount : 0;

/** Parse YYYY-MM into a full-calendar-month UTC Date range */
const monthToDateRange = (month) => {
  const [year, mon] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0, 0));
  const end   = new Date(Date.UTC(year, mon, 0, 23, 59, 59, 999));
  return { start, end };
};

/** Validate YYYY-MM format */
const isValidMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

// ─── Map an EB Mongoose doc → the shape OwnerReports.js expects ───────────────
const buildEbData = (eb) => {
  if (!eb) return null;
  const c = eb.charges || {};
  return {
    ebId:            eb._id,
    status:          eb.status,                         // 'uploaded' | 'payment_submitted' | 'payment_verified' | 'eb_paid_to_mseb'
    hasPdf:          Boolean(eb.ebPdfPath),
    // Individual charge lines
    energyCharges:         r2(chargeAmt(c.energyCharges)),
    wheelingCharges:       r2(chargeAmt(c.wheelingCharges)),
    demandCharges:         r2(chargeAmt(c.demandCharges)),
    fac:                   r2(chargeAmt(c.fac)),
    fixedCharges:          r2(chargeAmt(c.fixedCharges)),
    electricityDuty:       r2(chargeAmt(c.electricityDuty)),
    meterRent:             r2(chargeAmt(c.meterRent)),
    powerFactorAdjustment: r2(chargeAmt(c.powerFactorAdjustment)),
    delayedPaymentCharges: r2(chargeAmt(c.delayedPaymentCharges)),
    regulatoryCharges:     r2(chargeAmt(c.regulatoryCharges)),
    otherCharges:          r2(chargeAmt(c.otherCharges)),
    // Totals (computed by pre-save hook on ElectricityBill)
    totalOwnerPayable: r2(eb.totalOwnerPayable),   // owner owes VJRA this amount
    totalBillAmount:   r2(eb.totalEBAmount),        // full MSEB bill total
    // Remarks (admin notes per line)
    remarks: {
      energyCharges:         c.energyCharges?.remarks         || '',
      wheelingCharges:       c.wheelingCharges?.remarks       || '',
      demandCharges:         c.demandCharges?.remarks         || '',
      fac:                   c.fac?.remarks                   || '',
      fixedCharges:          c.fixedCharges?.remarks          || '',
      electricityDuty:       c.electricityDuty?.remarks       || '',
      meterRent:             c.meterRent?.remarks             || '',
      powerFactorAdjustment: c.powerFactorAdjustment?.remarks || '',
      delayedPaymentCharges: c.delayedPaymentCharges?.remarks || '',
      regulatoryCharges:     c.regulatoryCharges?.remarks     || '',
      otherCharges:          c.otherCharges?.remarks          || '',
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/reports/owner/monthly
//  Query params: project (required), month (required, YYYY-MM)
//
//  Response shape (OwnerReports.js depends on these exact keys):
//  {
//    status         : 'NO_DATA' | 'EB_UPLOADED' | 'EB_PROCESSED'
//    project        : string
//    month          : string
//    ownerName      : string
//    projectName    : string
//    ebData         : EbData | null
//    reportData     : ReportData | null
//    amountOwnerOwesVjra : number
//    paymentStatus  : 'PENDING' | 'SUBMITTED' | 'VERIFIED' | 'COMPLETE'
//    paymentRecord  : { transactionId, amountPaid, submittedAt } | null
//    bankDetails    : VjraBankDetails
//  }
// ─────────────────────────────────────────────────────────────────────────────
exports.getMonthlyReport = async (req, res) => {
  try {
    const { project, month } = req.query;
    const userId = req.user.userId;

    // ── Validation ────────────────────────────────────────────────────────────
    if (!project || !project.trim()) {
      return res.status(400).json({ error: 'project is required.' });
    }
    if (!month || !isValidMonth(month.trim())) {
      return res.status(400).json({ error: 'month must be in YYYY-MM format.' });
    }

    const proj  = project.trim();
    const mon   = month.trim();

    // ── Authorization ─────────────────────────────────────────────────────────
    if (req.user.role !== 'admin') {
      const ownsDevice = await Device.exists({
        ownerId:                        { $in: [userId] },
        project:                        proj,
        'commercial.electricityBearer': 'VJRA',
      });
      if (!ownsDevice) {
        return res.status(403).json({
          error: 'You do not have a VJRA-bearer device in this project.',
        });
      }
    }

    // ── 1. Devices in this project ────────────────────────────────────────────
    const deviceQuery = {
      project:                        proj,
      'commercial.electricityBearer': 'VJRA',
    };
    if (req.user.role !== 'admin') deviceQuery.ownerId = { $in: [userId] };

    const devices = await Device.find(deviceQuery)
      .select('device_id ownerId ownerName project location area city')
      .lean();

    if (!devices.length) {
      return res.json({
        status:  'NO_DATA',
        project: proj,
        month:   mon,
        message: 'No VJRA devices found for this project.',
      });
    }

    const deviceIds = devices.map((d) => d.device_id);

    // Derive owner name from first device (all devices in project → same owner)
    const ownerName   = devices[0]?.ownerName || '';
    const projectName = proj;

    // ── 2. Fetch EB for this project + month ──────────────────────────────────
    const eb = await ElectricityBill.findOne({
      project:  proj,
      month:    mon,
      isVoided: false,
    }).lean();

    // ── STATE: NO_DATA — No EB yet ────────────────────────────────────────────
    if (!eb) {
      return res.json({
        status:              'NO_DATA',
        project:              proj,
        month:                mon,
        ownerName,
        projectName,
        ebData:               null,
        reportData:           null,
        amountOwnerOwesVjra:  0,
        paymentStatus:        'PENDING',
        paymentRecord:        null,
        bankDetails:          VJRA_BANK,
      });
    }

    // ── 3. Aggregate charging receipts for this month ─────────────────────────
    const { start, end } = monthToDateRange(mon);

    const [agg] = await Receipt.aggregate([
      {
        $match: {
          deviceId:  { $in: deviceIds },
          createdAt: { $gte: start, $lte: end },
        },
      },
      {
        $group: {
          _id:            null,
          sessionsCount:  { $sum: 1 },
          totalEnergy:    { $sum: { $ifNull: ['$energyConsumed',   0] } },
          grossRevenue:   { $sum: { $ifNull: ['$totalAmount',      0] } },
          gstAmount:      { $sum: { $ifNull: ['$gstAmount',        0] } },
          taxableAmount:  { $sum: { $ifNull: ['$taxableAmount',    0] } },
          vjraCommission: { $sum: { $ifNull: ['$vjraMarginAmount', 0] } },
          pgCharges:      { $sum: { $ifNull: ['$paymentCharges',   0] } },
          totalRefund:    { $sum: { $ifNull: ['$refundAmount',     0] } },
        },
      },
    ]);

    const cs = agg || {
      sessionsCount: 0, totalEnergy: 0, grossRevenue: 0,
      gstAmount: 0, taxableAmount: 0, vjraCommission: 0,
      pgCharges: 0, totalRefund: 0,
    };

    // ── 4. Build EbData ───────────────────────────────────────────────────────
    const ebData = buildEbData(eb);

    // ── 5. Payout waterfall ───────────────────────────────────────────────────
    //
    //  AGREEMENT RULES:
    //   • Owner bears: wheeling + demand + FAC + fixed + electricityDuty +
    //                  meterRent + powerFactorAdjustment + delayedPayment +
    //                  regulatory + other  → stored as eb.totalOwnerPayable
    //   • VJRA bears:  energyCharges only
    //
    //  FORMULA:
    //   grossRevenue            = total charging revenue incl. GST
    //   − lessGST               = GST collected → remitted to govt
    //   − lessVJRACommission    = platform fee (from receipts)
    //   − lessPGCharges         = payment gateway fees
    //   − lessEnergyChargesVjra = VJRA pays this to MSEB on owner's behalf
    //   ─────────────────────────────────────────
    //   = netPayout             → VJRA transfers to owner
    //
    //   amountOwnerOwesVjra = totalOwnerPayable (owner must pay VJRA first)

    const grossRevenue       = r2(cs.grossRevenue);
    const gstAmount          = r2(cs.gstAmount);
    const vjraCommission     = r2(cs.vjraCommission);
    const pgCharges          = r2(cs.pgCharges);
    const energyChargesVjra  = r2(chargeAmt(eb.charges?.energyCharges));
    const fixedChargesOwner  = r2(eb.totalOwnerPayable);

    const netPayout = r2(
      grossRevenue - gstAmount - vjraCommission - pgCharges - energyChargesVjra
    );

    const reportData = {
      sessionsCount:   cs.sessionsCount,
      totalEnergy:     r2(cs.totalEnergy),
      grossRevenue,
      gstAmount,
      taxableAmount:   r2(cs.taxableAmount),
      vjraCommission,
      pgCharges,
      totalRefund:     r2(cs.totalRefund),
      energyChargesVjra,
      fixedChargesOwner,
      netPayout,
    };

    // ── 6. Owner payment status ───────────────────────────────────────────────
    const statusMap = {
      uploaded:           'PENDING',
      payment_submitted:  'SUBMITTED',
      payment_verified:   'VERIFIED',
      eb_paid_to_mseb:    'COMPLETE',
    };

    const paymentStatus = statusMap[eb.status] || 'PENDING';

    const paymentRecord = eb.ownerPayment?.txnId
      ? {
          transactionId: eb.ownerPayment.txnId,
          amountPaid:    r2(eb.ownerPayment.amountPaid),
          submittedAt:   eb.ownerPayment.submittedAt,
          verifiedAt:    eb.ownerPayment.verifiedAt || null,
        }
      : null;

    // ── 7. Final status flag for the UI ──────────────────────────────────────
    //  'EB_UPLOADED'  → show EB breakdown + payment section only
    //  'EB_PROCESSED' → show EB breakdown + payment + full report + downloads
    //
    //  We consider "processed" (revenue calculable) when receipt data exists
    //  OR when EB status is payment_verified / eb_paid_to_mseb.
    const isProcessed =
      cs.sessionsCount > 0 ||
      eb.status === 'payment_verified' ||
      eb.status === 'eb_paid_to_mseb';

    const reportStatus = isProcessed ? 'EB_PROCESSED' : 'EB_UPLOADED';

    return res.json({
      status:              reportStatus,
      project:             proj,
      month:               mon,
      ownerName,
      projectName,
      ebData,
      reportData,
      amountOwnerOwesVjra: r2(eb.totalOwnerPayable),
      paymentStatus,
      paymentRecord,
      bankDetails:         VJRA_BANK,
    });
  } catch (err) {
    console.error('[ownerReport/monthly]', err);
    return res.status(500).json({
      error:  'Server error while generating monthly report.',
      detail: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/reports/owner/projects
//  Returns projects + available EB months for the owner's project picker.
// ─────────────────────────────────────────────────────────────────────────────
exports.getOwnerProjects = async (req, res) => {
  try {
    const userId = req.user.userId;

    const devices = await Device.find({
      ownerId:                        { $in: [userId] },
      'commercial.electricityBearer': 'VJRA',
      project: { $exists: true, $nin: [null, ''] },
    })
      .select('project device_id location')
      .lean();

    if (!devices.length) {
      return res.json({ projects: [] });
    }

    const projectNames = [...new Set(devices.map((d) => d.project))];

    // Fetch EB records for these projects
    const ebRecords = await ElectricityBill.find({
      project:  { $in: projectNames },
      isVoided: false,
    })
      .select('project month status totalOwnerPayable totalEBAmount')
      .sort({ month: -1 })
      .lean();

    const projects = projectNames.map((proj) => ({
      project:     proj,
      deviceCount: devices.filter((d) => d.project === proj).length,
      months: ebRecords
        .filter((r) => r.project === proj)
        .map((r) => ({
          month:             r.month,
          status:            r.status,
          totalOwnerPayable: r.totalOwnerPayable,
          totalEBAmount:     r.totalEBAmount,
          ebId:              r._id,
        })),
    }));

    return res.json({ projects });
  } catch (err) {
    console.error('[ownerReport/projects]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/reports/owner/pdf
//  Streams a PDF report for the requested project+month.
//  Uses pdfkit — install: npm install pdfkit
//  Query params: project (required), month (required, YYYY-MM)
// ─────────────────────────────────────────────────────────────────────────────
exports.getReportPdf = async (req, res) => {
  try {
    const { project, month } = req.query;
    const userId = req.user.userId;

    if (!project || !project.trim()) {
      return res.status(400).json({ error: 'project is required.' });
    }
    if (!month || !isValidMonth(month.trim())) {
      return res.status(400).json({ error: 'month must be in YYYY-MM format.' });
    }

    const proj = project.trim();
    const mon  = month.trim();

    // Auth check
    if (req.user.role !== 'admin') {
      const ownsDevice = await Device.exists({
        ownerId:                        { $in: [userId] },
        project:                        proj,
        'commercial.electricityBearer': 'VJRA',
      });
      if (!ownsDevice) {
        return res.status(403).json({ error: 'Access denied.' });
      }
    }

    // Reuse the report-building logic
    const eb = await ElectricityBill.findOne({
      project: proj, month: mon, isVoided: false,
    }).lean();

    if (!eb) {
      return res.status(404).json({ error: 'No EB data found for this month.' });
    }

    const { start, end } = monthToDateRange(mon);
    const deviceQuery = { project: proj, 'commercial.electricityBearer': 'VJRA' };
    if (req.user.role !== 'admin') deviceQuery.ownerId = { $in: [userId] };
    const devices   = await Device.find(deviceQuery).select('device_id ownerName').lean();
    const deviceIds = devices.map((d) => d.device_id);

    const [agg] = await Receipt.aggregate([
      { $match: { deviceId: { $in: deviceIds }, createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id:            null,
          sessionsCount:  { $sum: 1 },
          totalEnergy:    { $sum: { $ifNull: ['$energyConsumed',   0] } },
          grossRevenue:   { $sum: { $ifNull: ['$totalAmount',      0] } },
          gstAmount:      { $sum: { $ifNull: ['$gstAmount',        0] } },
          vjraCommission: { $sum: { $ifNull: ['$vjraMarginAmount', 0] } },
          pgCharges:      { $sum: { $ifNull: ['$paymentCharges',   0] } },
        },
      },
    ]);

    const cs  = agg || { sessionsCount: 0, totalEnergy: 0, grossRevenue: 0, gstAmount: 0, vjraCommission: 0, pgCharges: 0 };
    const c   = eb.charges || {};
    const ebD = buildEbData(eb);

    const grossRevenue      = r2(cs.grossRevenue);
    const gstAmount         = r2(cs.gstAmount);
    const vjraCommission    = r2(cs.vjraCommission);
    const pgCharges         = r2(cs.pgCharges);
    const energyChargesVjra = r2(chargeAmt(c.energyCharges));
    const netPayout         = r2(grossRevenue - gstAmount - vjraCommission - pgCharges - energyChargesVjra);

    const ownerName = devices[0]?.ownerName || 'Owner';

    // ── Build PDF with pdfkit ─────────────────────────────────────────────────
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="VIZ_Report_${mon}_${proj.replace(/\s+/g, '_')}.pdf"`
    );
    doc.pipe(res);

    const fmt   = (n) => `Rs. ${Number(n || 0).toFixed(2)}`;
    const LINE  = 12;
    const BOLD  = 'Helvetica-Bold';
    const REG   = 'Helvetica';

    // Header bar
    doc.rect(0, 0, doc.page.width, 70).fill('#04BFBF');
    doc.fillColor('#ffffff')
       .font(BOLD).fontSize(20).text('VIZ EV — Monthly Report', 50, 20)
       .font(REG).fontSize(10)
       .text(`${mon}  |  Project: ${proj}  |  Owner: ${ownerName}`, 50, 48);
    doc.fillColor('#000000').moveDown(3);

    // Section helper
    const section = (title) => {
      doc.moveDown(0.5)
         .font(BOLD).fontSize(11).fillColor('#04BFBF').text(title.toUpperCase())
         .moveDown(0.2)
         .moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#04BFBF').lineWidth(0.8).stroke()
         .moveDown(0.4)
         .fillColor('#000000').font(REG).fontSize(10);
    };

    // Row helper
    const row = (label, value, bold = false) => {
      const y = doc.y;
      doc.font(bold ? BOLD : REG).fontSize(10)
         .text(label,  50, y, { continued: false, width: 350 });
      doc.font(bold ? BOLD : REG).fontSize(10)
         .text(value, 400, y, { width: 145, align: 'right' });
      doc.moveDown(0.35);
    };

    // ── EB Breakdown ─────────────────────────────────────────────────────────
    section('MSEB Electricity Bill Breakdown');
    row('Wheeling Charges',           fmt(ebD.wheelingCharges));
    row('Demand Charges',             fmt(ebD.demandCharges));
    row('Energy Charges (VJRA bears)',fmt(ebD.energyCharges));
    row('FAC (Fuel Adjustment)',       fmt(ebD.fac));
    row('Fixed Charges',              fmt(ebD.fixedCharges));
    row('Electricity Duty',           fmt(ebD.electricityDuty));
    row('Meter Rent',                 fmt(ebD.meterRent));
    row('Power Factor Adjustment',    fmt(ebD.powerFactorAdjustment));
    row('Delayed Payment Charges',    fmt(ebD.delayedPaymentCharges));
    row('Regulatory Charges',         fmt(ebD.regulatoryCharges));
    row('Other Charges',              fmt(ebD.otherCharges));
    doc.moveDown(0.3);
    row('TOTAL MSEB BILL',            fmt(ebD.totalBillAmount),       true);
    row('Amount Owner Owes to VJRA',  fmt(ebD.totalOwnerPayable),     true);

    // ── Monthly Revenue Report ────────────────────────────────────────────────
    section('Monthly Revenue Report');
    row('Total Revenue (incl. GST)',         fmt(grossRevenue));
    row('(-) GST @ 18%',                     fmt(gstAmount));
    row('(-) VJRA Commission',               fmt(vjraCommission));
    row('(-) Payment Gateway Charges',       fmt(pgCharges));
    row('(-) Energy Charges (VJRA bears)',   fmt(energyChargesVjra));
    doc.moveDown(0.3);

    // Highlight net payout
    const py = doc.y;
    doc.rect(50, py, 495, 28).fill('#fb923c');
    doc.fillColor('#ffffff').font(BOLD).fontSize(12)
       .text('Net Payout to Owner', 60, py + 8, { continued: false, width: 300 })
       .text(fmt(netPayout), 400, py + 8, { width: 145, align: 'right' });
    doc.fillColor('#000000').moveDown(2.5);

    // ── Payment Status ────────────────────────────────────────────────────────
    section('Payment Status');
    const statusMap = { uploaded: 'Pending', payment_submitted: 'Submitted by Owner', payment_verified: 'Verified by VJRA', eb_paid_to_mseb: 'EB Paid to MSEB' };
    row('EB Payment Status',  statusMap[eb.status] || eb.status);
    if (eb.ownerPayment?.txnId) {
      row('Transaction ID',   eb.ownerPayment.txnId);
      row('Amount Paid',      fmt(eb.ownerPayment.amountPaid));
    }

    // Footer
    const footerY = doc.page.height - 40;
    doc.fontSize(8).fillColor('#94a3b8').font(REG)
       .text(`Generated by VIZ-Smart Charging, a brand of Vjra Technologies LLP  •  ${new Date().toLocaleString('en-IN')}`, 50, footerY, { align: 'center', width: 495 });

    doc.end();
  } catch (err) {
    console.error('[ownerReport/pdf]', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'PDF generation failed.', detail: err.message });
    }
  }
};