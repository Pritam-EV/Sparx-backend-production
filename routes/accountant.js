// routes/accountant.js
// READ-ONLY financial data route — accessible by admin + accountant roles only.
// No write/update/delete operations exist on this route.

const express = require("express");
const router = express.Router();
const caMiddleware = require("../middleware/caMiddleware");
const WalletTransaction = require("../models/WalletTransaction");
const Receipt = require("../models/Receipt");
const User = require("../models/User");
const ExcelJS = require("exceljs");

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Build a date range from a period string OR explicit from/to query params
function buildDateRange(query) {
  const now = new Date();
  let from, to;

  if (query.from && query.to) {
    from = new Date(query.from);
    to   = new Date(query.to);
    to.setHours(23, 59, 59, 999);
    return { from, to };
  }

  const period = query.period || "month";
  to = new Date(now);
  to.setHours(23, 59, 59, 999);

  switch (period) {
    case "today":
      from = new Date(now);
      from.setHours(0, 0, 0, 0);
      break;
    case "week":
      from = new Date(now);
      from.setDate(now.getDate() - 6);
      from.setHours(0, 0, 0, 0);
      break;
    case "month":
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "last_month": {
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      from = lm;
      to   = new Date(now.getFullYear(), now.getMonth(), 0);
      to.setHours(23, 59, 59, 999);
      break;
    }
    case "quarter": {
      const qStart = Math.floor(now.getMonth() / 3) * 3;
      from = new Date(now.getFullYear(), qStart, 1);
      break;
    }
    case "fy": {
      // Indian FY: Apr 1 – Mar 31
      const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      from = new Date(fyYear, 3, 1); // April 1
      to   = new Date(fyYear + 1, 2, 31, 23, 59, 59, 999); // March 31
      break;
    }
    case "year":
      from = new Date(now.getFullYear(), 0, 1);
      break;
    // GST month: "gst_month=2026-04" → lock to that calendar month
    case "gst_month": {
      const [y, m] = (query.gst_month || "").split("-").map(Number);
      if (y && m) {
        from = new Date(y, m - 1, 1);
        to   = new Date(y, m, 0, 23, 59, 59, 999);
      } else {
        from = new Date(now.getFullYear(), now.getMonth(), 1);
      }
      break;
    }
    default:
      from = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  return { from, to };
}

// Round to 2 decimal places safely
const r2 = (n) => Math.round((n || 0) * 100) / 100;

// ─── ROUTE 1: Summary KPIs ─────────────────────────────────────────────────────
// GET /api/accountant/summary?period=month
router.get("/summary", caMiddleware, async (req, res) => {
  try {
    const { from, to } = buildDateRange(req.query);

    // Wallet topups in period
    const topupAgg = await WalletTransaction.aggregate([
      { $match: { type: "topup", createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }
    ]);

    // Wallet debits (charging sessions) in period
    const debitAgg = await WalletTransaction.aggregate([
      { $match: { type: "debit", createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }
    ]);

    // Refunds in period
    const refundAgg = await WalletTransaction.aggregate([
      { $match: { type: { $in: ["refund", "refund_bank"] }, createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }
    ]);

    // Receipt / invoice stats in period
    const receiptAgg = await Receipt.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: null,
          grossRevenue:   { $sum: "$totalAmount" },
          taxableAmount:  { $sum: "$taxableAmount" },
          gstCollected:   { $sum: "$gstAmount" },
          discounts:      { $sum: "$discountApplied" },
          vjraMargin:     { $sum: "$vjraMarginAmount" },
          pgCharges:      { $sum: "$paymentCharges" },
          ownerPayouts:   { $sum: "$ownerPayout" },
          invoiceCount:   { $sum: 1 }
        }
      }
    ]);

    // All-time wallet float (total topups - total debits - total refunds)
    const allTopups  = await WalletTransaction.aggregate([
      { $match: { type: "topup" } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const allDebits  = await WalletTransaction.aggregate([
      { $match: { type: "debit" } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const allRefunds = await WalletTransaction.aggregate([
      { $match: { type: { $in: ["refund", "refund_bank"] } } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const totalWalletFloat = r2(
      (allTopups[0]?.total  || 0) -
      (allDebits[0]?.total  || 0) -
      (allRefunds[0]?.total || 0)
    );

    const t  = topupAgg[0]  || {};
    const d  = debitAgg[0]  || {};
    const rf = refundAgg[0] || {};
    const rc = receiptAgg[0]|| {};

    res.json({
      period: { from, to },
      walletTopups:    { total: r2(t.total),   count: t.count   || 0 },
      walletDebits:    { total: r2(d.total),   count: d.count   || 0 },
      refunds:         { total: r2(rf.total),  count: rf.count  || 0 },
      walletFloat:     totalWalletFloat,
      invoices: {
        count:        rc.invoiceCount  || 0,
        grossRevenue: r2(rc.grossRevenue),
        taxableAmount:r2(rc.taxableAmount),
        gstCollected: r2(rc.gstCollected),
        discounts:    r2(rc.discounts),
        vjraMargin:   r2(rc.vjraMargin),
        pgCharges:    r2(rc.pgCharges),
        ownerPayouts: r2(rc.ownerPayouts),
      }
    });
  } catch (err) {
    console.error("CA summary error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── ROUTE 2: Wallet Topups (paginated) ────────────────────────────────────────
// GET /api/accountant/wallet-topups?period=month&page=1&limit=50
router.get("/wallet-topups", caMiddleware, async (req, res) => {
  try {
    const { from, to } = buildDateRange(req.query);
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      WalletTransaction.find({ type: "topup", createdAt: { $gte: from, $lte: to } })
        .populate("userId", "name mobile email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WalletTransaction.countDocuments({ type: "topup", createdAt: { $gte: from, $lte: to } })
    ]);

    res.json({
      period: { from, to },
      page, limit,
      total,
      totalPages: Math.ceil(total / limit),
      data: transactions.map(t => ({
        _id:          t._id,
        date:         t.createdAt,
        userName:     t.userId?.name    || "—",
        userMobile:   t.userId?.mobile  || "—",
        userEmail:    t.userId?.email   || "—",
        amount:       r2(t.amount),
        balanceBefore:r2(t.balanceBefore),
        balanceAfter: r2(t.balanceAfter),
        orderId:      t.orderId         || "—",
        description:  t.description     || "—",
      }))
    });
  } catch (err) {
    console.error("CA wallet-topups error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── ROUTE 3: Wallet Debits (charging session deductions) ─────────────────────
// GET /api/accountant/wallet-debits?period=month&page=1&limit=50
router.get("/wallet-debits", caMiddleware, async (req, res) => {
  try {
    const { from, to } = buildDateRange(req.query);
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      WalletTransaction.find({ type: "debit", createdAt: { $gte: from, $lte: to } })
        .populate("userId", "name mobile email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WalletTransaction.countDocuments({ type: "debit", createdAt: { $gte: from, $lte: to } })
    ]);

    res.json({
      period: { from, to },
      page, limit,
      total,
      totalPages: Math.ceil(total / limit),
      data: transactions.map(t => ({
        _id:          t._id,
        date:         t.createdAt,
        userName:     t.userId?.name   || "—",
        userMobile:   t.userId?.mobile || "—",
        userEmail:    t.userId?.email  || "—",
        amount:       r2(t.amount),
        balanceBefore:r2(t.balanceBefore),
        balanceAfter: r2(t.balanceAfter),
        sessionId:    t.sessionId      || "—",
        description:  t.description    || "—",
      }))
    });
  } catch (err) {
    console.error("CA wallet-debits error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── ROUTE 4: Invoice Register (receipts with GST breakdown) ──────────────────
// GET /api/accountant/invoices?period=month&page=1&limit=50&search=&gstin=
router.get("/invoices", caMiddleware, async (req, res) => {
  try {
    const { from, to } = buildDateRange(req.query);
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);
    const skip   = (page - 1) * limit;

    // Optional search filters
    const matchFilter = { createdAt: { $gte: from, $lte: to } };
    if (req.query.search) {
      const re = new RegExp(req.query.search, "i");
      matchFilter.$or = [
        { userName: re },
        { userMobile: re },
        { receiptId: re },
        { deviceId: re }
      ];
    }
    if (req.query.gstin) {
      matchFilter.userGstin = new RegExp(req.query.gstin, "i");
    }

    const [receipts, total] = await Promise.all([
      Receipt.find(matchFilter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Receipt.countDocuments(matchFilter)
    ]);

    // Determine CGST/SGST vs IGST per invoice
    // If deviceState === process.env.REGISTERED_STATE → intra-state → CGST+SGST
    // Else → inter-state → IGST
    const registeredState = (process.env.REGISTERED_STATE || "Maharashtra").toLowerCase();

    const data = receipts.map(r => {
      const isIntraState = (r.deviceState || "").toLowerCase() === registeredState;
      const gst  = r2(r.gstAmount || 0);
      const cgst = isIntraState ? r2(gst / 2) : 0;
      const sgst = isIntraState ? r2(gst / 2) : 0;
      const igst = isIntraState ? 0 : gst;

      return {
        invoiceNo:      r.receiptId,
        date:           r.createdAt,
        customerName:   r.userName     || "—",
        customerMobile: r.userMobile   || "—",
        customerGstin:  r.userGstin    || "—",        // B2B if filled
        placeOfSupply:  r.deviceState  || "—",
        deviceId:       r.deviceId,
        deviceCity:     r.deviceCity   || "—",
        energykWh:      r.energyConsumed,
        ratePerKwh:     r2(r.userRatePerKwh),
        taxableAmount:  r2(r.taxableAmount),
        cgst,
        sgst,
        igst,
        totalGst:       gst,
        discount:       r2(r.discountApplied),
        totalAmount:    r2(r.totalAmount),
        amountPaid:     r2(r.amountPaid),
        refund:         r2(r.refundAmount || 0),
        supplyType:     isIntraState ? "Intra-State" : "Inter-State",
        invoiceType:    r.userGstin ? "B2B" : "B2C",
        vjraMargin:     r2(r.vjraMarginAmount || 0),
        pgCharges:      r2(r.paymentCharges   || 0),
        ownerPayout:    r2(r.ownerPayout      || 0),
      };
    });

    // Period totals
    const totalsAgg = await Receipt.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: null,
          taxableAmount:  { $sum: "$taxableAmount" },
          gstAmount:      { $sum: "$gstAmount" },
          totalAmount:    { $sum: "$totalAmount" },
          discounts:      { $sum: "$discountApplied" },
          refunds:        { $sum: "$refundAmount" },
          vjraMargin:     { $sum: "$vjraMarginAmount" },
          pgCharges:      { $sum: "$paymentCharges" },
        }
      }
    ]);
    const totals = totalsAgg[0] || {};

    res.json({
      period: { from, to },
      page, limit, total,
      totalPages: Math.ceil(total / limit),
      periodTotals: {
        taxableAmount: r2(totals.taxableAmount),
        gstAmount:     r2(totals.gstAmount),
        totalAmount:   r2(totals.totalAmount),
        discounts:     r2(totals.discounts),
        refunds:       r2(totals.refunds),
        vjraMargin:    r2(totals.vjraMargin),
        pgCharges:     r2(totals.pgCharges),
      },
      data
    });
  } catch (err) {
    console.error("CA invoices error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── ROUTE 5: Excel Export (for GST filing & record keeping) ──────────────────
// GET /api/accountant/export?period=gst_month&gst_month=2026-04
router.get("/export", caMiddleware, async (req, res) => {
  try {
    const { from, to } = buildDateRange(req.query);
    const registeredState = (process.env.REGISTERED_STATE || "Maharashtra").toLowerCase();

    // Fetch all data for the period (no pagination — full export)
    const [receipts, topups, debits] = await Promise.all([
      Receipt.find({ createdAt: { $gte: from, $lte: to } }).sort({ createdAt: 1 }).lean(),
      WalletTransaction.find({ type: "topup", createdAt: { $gte: from, $lte: to } })
        .populate("userId", "name mobile email").sort({ createdAt: 1 }).lean(),
      WalletTransaction.find({ type: "debit", createdAt: { $gte: from, $lte: to } })
        .populate("userId", "name mobile email").sort({ createdAt: 1 }).lean(),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Sparx EV — VJRA Technologies";
    workbook.created = new Date();

    const periodLabel = req.query.gst_month
      ? `GST_${req.query.gst_month}`
      : req.query.period || "period";

    // ── Sheet 1: Invoice Register (for GST filing) ─────────────────────────────
    const invSheet = workbook.addWorksheet("Invoice Register");
    invSheet.columns = [
      { header: "Invoice No.",       key: "invoiceNo",      width: 20 },
      { header: "Date",              key: "date",           width: 18 },
      { header: "Customer Name",     key: "customerName",   width: 22 },
      { header: "Mobile",            key: "customerMobile", width: 14 },
      { header: "GSTIN",             key: "customerGstin",  width: 20 },
      { header: "Place of Supply",   key: "placeOfSupply",  width: 18 },
      { header: "Device ID",         key: "deviceId",       width: 18 },
      { header: "City",              key: "deviceCity",     width: 16 },
      { header: "Supply Type",       key: "supplyType",     width: 14 },
      { header: "Invoice Type",      key: "invoiceType",    width: 12 },
      { header: "Energy (kWh)",      key: "energykWh",      width: 14 },
      { header: "Rate/kWh (Ex-GST)", key: "ratePerKwh",    width: 18 },
      { header: "Taxable Amount",    key: "taxableAmount",  width: 16 },
      { header: "CGST (9%)",         key: "cgst",           width: 12 },
      { header: "SGST (9%)",         key: "sgst",           width: 12 },
      { header: "IGST (18%)",        key: "igst",           width: 12 },
      { header: "Total GST",         key: "totalGst",       width: 12 },
      { header: "Discount",          key: "discount",       width: 12 },
      { header: "Total Invoice Amt", key: "totalAmount",    width: 18 },
      { header: "Amount Paid",       key: "amountPaid",     width: 14 },
      { header: "Refund",            key: "refund",         width: 12 },
    ];

    // Style header row
    invSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    invSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
    invSheet.getRow(1).alignment = { horizontal: "center" };

    receipts.forEach(r => {
      const isIntraState = (r.deviceState || "").toLowerCase() === registeredState;
      const gst  = r2(r.gstAmount || 0);
      invSheet.addRow({
        invoiceNo:      r.receiptId,
        date:           new Date(r.createdAt).toLocaleString("en-IN"),
        customerName:   r.userName     || "",
        customerMobile: r.userMobile   || "",
        customerGstin:  r.userGstin    || "",
        placeOfSupply:  r.deviceState  || "",
        deviceId:       r.deviceId,
        deviceCity:     r.deviceCity   || "",
        supplyType:     isIntraState ? "Intra-State" : "Inter-State",
        invoiceType:    r.userGstin ? "B2B" : "B2C",
        energykWh:      r.energyConsumed,
        ratePerKwh:     r2(r.userRatePerKwh),
        taxableAmount:  r2(r.taxableAmount),
        cgst:           isIntraState ? r2(gst / 2) : 0,
        sgst:           isIntraState ? r2(gst / 2) : 0,
        igst:           isIntraState ? 0 : gst,
        totalGst:       gst,
        discount:       r2(r.discountApplied),
        totalAmount:    r2(r.totalAmount),
        amountPaid:     r2(r.amountPaid),
        refund:         r2(r.refundAmount || 0),
      });
    });

    // Totals row
    const invTotalRow = invSheet.addRow({
      invoiceNo:    "TOTAL",
      taxableAmount: r2(receipts.reduce((s, r) => s + (r.taxableAmount || 0), 0)),
      cgst:         r2(receipts.reduce((s, r) => {
        const intra = (r.deviceState || "").toLowerCase() === registeredState;
        return s + (intra ? (r.gstAmount || 0) / 2 : 0);
      }, 0)),
      sgst:         r2(receipts.reduce((s, r) => {
        const intra = (r.deviceState || "").toLowerCase() === registeredState;
        return s + (intra ? (r.gstAmount || 0) / 2 : 0);
      }, 0)),
      igst:         r2(receipts.reduce((s, r) => {
        const intra = (r.deviceState || "").toLowerCase() === registeredState;
        return s + (!intra ? (r.gstAmount || 0) : 0);
      }, 0)),
      totalGst:     r2(receipts.reduce((s, r) => s + (r.gstAmount   || 0), 0)),
      discount:     r2(receipts.reduce((s, r) => s + (r.discountApplied || 0), 0)),
      totalAmount:  r2(receipts.reduce((s, r) => s + (r.totalAmount  || 0), 0)),
      amountPaid:   r2(receipts.reduce((s, r) => s + (r.amountPaid   || 0), 0)),
      refund:       r2(receipts.reduce((s, r) => s + (r.refundAmount || 0), 0)),
    });
    invTotalRow.font = { bold: true };
    invTotalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" } };

    // ── Sheet 2: Wallet Topups ─────────────────────────────────────────────────
    const topupSheet = workbook.addWorksheet("Wallet Topups");
    topupSheet.columns = [
      { header: "Date",           key: "date",          width: 20 },
      { header: "Customer Name",  key: "name",          width: 22 },
      { header: "Mobile",         key: "mobile",        width: 14 },
      { header: "Email",          key: "email",         width: 26 },
      { header: "Amount (₹)",     key: "amount",        width: 14 },
      { header: "Balance Before", key: "balanceBefore", width: 16 },
      { header: "Balance After",  key: "balanceAfter",  width: 16 },
      { header: "Cashfree Order", key: "orderId",       width: 24 },
    ];
    topupSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    topupSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E5631" } };

    topups.forEach(t => {
      topupSheet.addRow({
        date:          new Date(t.createdAt).toLocaleString("en-IN"),
        name:          t.userId?.name   || "",
        mobile:        t.userId?.mobile || "",
        email:         t.userId?.email  || "",
        amount:        r2(t.amount),
        balanceBefore: r2(t.balanceBefore),
        balanceAfter:  r2(t.balanceAfter),
        orderId:       t.orderId || "",
      });
    });

    // Totals
    const topupTotal = topupSheet.addRow({
      date: "TOTAL",
      amount: r2(topups.reduce((s, t) => s + (t.amount || 0), 0))
    });
    topupTotal.font = { bold: true };
    topupTotal.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };

    // ── Sheet 3: Charging Debits ──────────────────────────────────────────────
    const debitSheet = workbook.addWorksheet("Charging Debits");
    debitSheet.columns = [
      { header: "Date",           key: "date",          width: 20 },
      { header: "Customer Name",  key: "name",          width: 22 },
      { header: "Mobile",         key: "mobile",        width: 14 },
      { header: "Amount (₹)",     key: "amount",        width: 14 },
      { header: "Balance Before", key: "balanceBefore", width: 16 },
      { header: "Balance After",  key: "balanceAfter",  width: 16 },
      { header: "Session ID",     key: "sessionId",     width: 26 },
      { header: "Description",    key: "description",   width: 28 },
    ];
    debitSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    debitSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7B2D00" } };

    debits.forEach(d => {
      debitSheet.addRow({
        date:          new Date(d.createdAt).toLocaleString("en-IN"),
        name:          d.userId?.name   || "",
        mobile:        d.userId?.mobile || "",
        amount:        r2(d.amount),
        balanceBefore: r2(d.balanceBefore),
        balanceAfter:  r2(d.balanceAfter),
        sessionId:     d.sessionId  || "",
        description:   d.description || "",
      });
    });
    const debitTotal = debitSheet.addRow({
      date: "TOTAL",
      amount: r2(debits.reduce((s, d) => s + (d.amount || 0), 0))
    });
    debitTotal.font = { bold: true };
    debitTotal.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };

    // ── Sheet 4: GSTR-1 B2C Summary ───────────────────────────────────────────
    const gstrSheet = workbook.addWorksheet("GSTR-1 Summary");
    gstrSheet.addRow(["GSTR-1 SUMMARY REPORT — Sparx EV / VJRA Technologies Pvt Ltd"]);
    gstrSheet.addRow([`Period: ${from.toDateString()} to ${to.toDateString()}`]);
    gstrSheet.addRow([`Generated: ${new Date().toLocaleString("en-IN")}`]);
    gstrSheet.addRow([]);

    gstrSheet.addRow(["SECTION", "Taxable Value (₹)", "CGST (₹)", "SGST (₹)", "IGST (₹)", "Total GST (₹)", "No. of Invoices"]);
    gstrSheet.getRow(5).font = { bold: true };
    gstrSheet.getRow(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
    gstrSheet.getRow(5).font = { bold: true, color: { argb: "FFFFFFFF" } };

    // B2C intra-state
    const b2cIntra = receipts.filter(r => !r.userGstin && (r.deviceState||"").toLowerCase() === registeredState);
    const b2cInter = receipts.filter(r => !r.userGstin && (r.deviceState||"").toLowerCase() !== registeredState);
    const b2bIntra = receipts.filter(r =>  r.userGstin && (r.deviceState||"").toLowerCase() === registeredState);
    const b2bInter = receipts.filter(r =>  r.userGstin && (r.deviceState||"").toLowerCase() !== registeredState);

    const sumTaxable = arr => r2(arr.reduce((s, r) => s + (r.taxableAmount || 0), 0));
    const sumGST     = arr => r2(arr.reduce((s, r) => s + (r.gstAmount    || 0), 0));

    [
      ["B2C — Intra-State",  b2cIntra],
      ["B2C — Inter-State",  b2cInter],
      ["B2B — Intra-State",  b2bIntra],
      ["B2B — Inter-State",  b2bInter],
    ].forEach(([label, arr]) => {
      const isIntra = label.includes("Intra");
      const tax = sumTaxable(arr);
      const gst = sumGST(arr);
      gstrSheet.addRow([
        label,
        tax,
        isIntra ? r2(gst / 2) : 0,
        isIntra ? r2(gst / 2) : 0,
        isIntra ? 0 : gst,
        gst,
        arr.length,
      ]);
    });

    // Grand total row
    const allTax = sumTaxable(receipts);
    const allGST = sumGST(receipts);
    const allCGST = r2([...b2cIntra, ...b2bIntra].reduce((s, r) => s + (r.gstAmount || 0) / 2, 0));
    const allSGST = allCGST;
    const allIGST = r2([...b2cInter, ...b2bInter].reduce((s, r) => s + (r.gstAmount || 0), 0));
    const grandRow = gstrSheet.addRow(["GRAND TOTAL", allTax, allCGST, allSGST, allIGST, allGST, receipts.length]);
    grandRow.font = { bold: true };
    grandRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" } };

    gstrSheet.columns = [
      { width: 26 }, { width: 20 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 16 }
    ];

    // Stream the Excel file
    const filename = `Sparx_CA_${periodLabel}_${Date.now()}.xlsx`;
    res.setHeader("Content-Type",        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error("CA Excel export error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

// ─── ROUTE 6: Create accountant user (admin only) ─────────────────────────────
// POST /api/accountant/create-user
const authMiddleware = require("../middleware/authMiddleware");

router.post("/create-user", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access only" });
    }

    const { name, mobile, email } = req.body;
    if (!name || !mobile) {
      return res.status(400).json({ error: "name and mobile are required" });
    }

    // Check if user already exists
    let user = await User.findOne({ mobile });

    if (user) {
      if (user.role === "accountant") {
        return res.status(400).json({ error: "This user is already an accountant" });
      }
      // Promote existing user to accountant
      user.role = "accountant";
      await user.save();
      return res.json({ message: "User promoted to accountant", user: { _id: user._id, name: user.name, mobile: user.mobile, role: user.role } });
    }

    // Create new accountant user
    user = new User({
      name,
      mobile,
      email: email || undefined,
      role: "accountant",
      phoneVerified: false,
    });
    await user.save();

    res.status(201).json({
      message: "Accountant user created. They can log in with their mobile via OTP.",
      user: { _id: user._id, name: user.name, mobile: user.mobile, role: user.role }
    });
  } catch (err) {
    console.error("Create accountant error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;