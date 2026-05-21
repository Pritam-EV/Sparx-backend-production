// routes/accountant.js
// READ-ONLY financial data route — accessible by admin + accountant roles only.
// No write/update/delete operations exist on this route.

const express = require("express");
const router  = express.Router();
const caMiddleware   = require("../middleware/caMiddleware");
const authMiddleware = require("../middleware/authMiddleware");
const WalletTransaction = require("../models/WalletTransaction");
const Receipt  = require("../models/Receipt");
const Session  = require("../models/session");
const User     = require("../models/User");
const ExcelJS  = require("exceljs");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const r2 = (n) => Math.round((n || 0) * 100) / 100;

/**
 * Build date range from query params.
 * Supports: today | month | quarter_fy | fy | custom (from+to)
 * All quarters are FINANCIAL (Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar)
 */
function buildDateRange(query) {
  const now = new Date();

  if (query.from && query.to) {
    const from = new Date(query.from);
    const to   = new Date(query.to);
    to.setHours(23, 59, 59, 999);
    return { from, to, label: "Custom" };
  }

  const period = query.period || "fy";
  let from, to, label;

  to = new Date(now);
  to.setHours(23, 59, 59, 999);

  // Determine current Indian Financial Year start
  const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fyStart = new Date(fyStartYear, 3, 1);       // April 1
  const fyEnd   = new Date(fyStartYear + 1, 2, 31, 23, 59, 59, 999); // March 31

  switch (period) {
    case "today":
      from  = new Date(now);
      from.setHours(0, 0, 0, 0);
      label = "Today";
      break;

    case "month": {
      from  = new Date(now.getFullYear(), now.getMonth(), 1);
      label = now.toLocaleString("en-IN", { month: "long", year: "numeric" });
      break;
    }

    case "quarter_fy": {
      // Financial quarters: Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar
      const m = now.getMonth(); // 0-indexed
      let qStartMonth, qNum;
      if      (m >= 3 && m <= 5)  { qStartMonth = 3;  qNum = 1; }
      else if (m >= 6 && m <= 8)  { qStartMonth = 6;  qNum = 2; }
      else if (m >= 9 && m <= 11) { qStartMonth = 9;  qNum = 3; }
      else                         { qStartMonth = 0;  qNum = 4; } // Jan-Mar

      const qYear = (qNum === 4) ? now.getFullYear() : now.getFullYear();
      from  = new Date(qYear, qStartMonth, 1);
      label = `Q${qNum} FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)}`;
      break;
    }

    case "fy":
    default:
      from  = fyStart;
      to    = fyEnd;
      label = `FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)}`;
      break;
  }

  return { from, to, label };
}

// ─── ROUTE 1: KPI Summary ──────────────────────────────────────────────────────
// GET /api/accountant/summary
// Returns 4 wallet KPI cards — always uses current FY for topup/debit cards.
router.get("/summary", caMiddleware, async (req, res) => {
  try {
    // Card 1 & 2: always FY-scoped
    const { from: fyFrom, to: fyTo, label: fyLabel } = buildDateRange({ period: "fy" });

    const [topupAgg, debitAgg, liveBalanceAgg, liveSessionAgg] = await Promise.all([

      // Card 1: Total wallet topups this FY
      WalletTransaction.aggregate([
        { $match: { type: "topup", createdAt: { $gte: fyFrom, $lte: fyTo } } },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }
      ]),

      // Card 2: Actual wallet consumption (debits) this FY
      WalletTransaction.aggregate([
        { $match: { type: "debit", createdAt: { $gte: fyFrom, $lte: fyTo } } },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }
      ]),

      // Card 3: Live aggregate wallet balance across ALL users
      User.aggregate([
        { $match: { walletBalance: { $gt: 0 } } },
        { $group: { _id: null, totalFloat: { $sum: "$walletBalance" }, userCount: { $sum: 1 } } }
      ]),

      // Card 4: Live amount in active wallet-paid sessions (amountUsed so far)
      Session.aggregate([
        { $match: { status: "active", paymentGateway: "wallet" } },
        { $group: { _id: null, totalAmountUsed: { $sum: "$amountUsed" }, sessionCount: { $sum: 1 } } }
      ]),
    ]);

    res.json({
      fyLabel,
      fyPeriod: { from: fyFrom, to: fyTo },

      // Card 1
      totalTopup: {
        amount: r2(topupAgg[0]?.total || 0),
        count:  topupAgg[0]?.count  || 0,
        label:  fyLabel,
      },

      // Card 2
      totalConsumption: {
        amount: r2(debitAgg[0]?.total || 0),
        count:  debitAgg[0]?.count  || 0,
        label:  fyLabel,
      },

      // Card 3
      liveWalletBalance: {
        totalFloat: r2(liveBalanceAgg[0]?.totalFloat || 0),
        userCount:  liveBalanceAgg[0]?.userCount    || 0,
      },

      // Card 4
      liveSessionAmount: {
        totalAmountUsed: r2(liveSessionAgg[0]?.totalAmountUsed || 0),
        activeSessions:  liveSessionAgg[0]?.sessionCount      || 0,
      },
    });

  } catch (err) {
    console.error("CA summary error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── ROUTE 2: Invoice Register (Receipts table for CA) ────────────────────────
// GET /api/accountant/invoices?period=fy&page=1&limit=50&search=
router.get("/invoices", caMiddleware, async (req, res) => {
  try {
    const { from, to, label } = buildDateRange(req.query);
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    // Build match filter
    const match = { createdAt: { $gte: from, $lte: to } };

    if (req.query.search) {
      const re = new RegExp(req.query.search, "i");
      match.$or = [
        { receiptId:  re },
        { userName:   re },
        { userMobile: re },
        { userGstin:  re },
        { deviceId:   re },
        { deviceCity: re },
      ];
    }

    const registeredState = (process.env.REGISTERED_STATE || "Maharashtra").toLowerCase();

    // Sort
    const sortField = req.query.sortBy  || "createdAt";
    const sortDir   = req.query.sortDir === "asc" ? 1 : -1;

    const [receipts, total] = await Promise.all([
      Receipt.find(match)
        .sort({ [sortField]: sortDir })
        .skip(skip)
        .limit(limit)
        .lean(),
      Receipt.countDocuments(match),
    ]);

    // Map to CA-facing invoice objects
    const data = receipts.map(r => {
      const isIntra = (r.deviceState || "").toLowerCase() === registeredState;
      const gst     = r2(r.gstAmount || 0);

      return {
        invoiceNo:      r.receiptId,
        date:           r.createdAt,
        customerName:   r.userName      || "—",
        customerMobile: r.userMobile    || "—",
        customerGstin:  r.userGstin     || "",        // empty = B2C
        placeOfSupply:  r.deviceState   || "—",
        deviceId:       r.deviceId,
        deviceCity:     r.deviceCity    || "—",
        paymentMode:    r.paymentGateway || "cashfree", // ← directly from Receipt now
        energykWh:      r2(r.energyConsumed),
        ratePerKwh:     r2(r.userRatePerKwh),
        taxableAmount:  r2(r.taxableAmount),
        cgst:           isIntra ? r2(gst / 2) : 0,
        sgst:           isIntra ? r2(gst / 2) : 0,
        igst:           isIntra ? 0 : gst,
        totalGst:       gst,
        discount:       r2(r.discountApplied),
        totalAmount:    r2(r.totalAmount),
        amountPaid:     r2(r.amountPaid),
        refundAmount:   r2(r.refundAmount || 0),
        supplyType:     isIntra ? "Intra-State" : "Inter-State",
        invoiceType:    r.userGstin ? "B2B" : "B2C",
      };
    });

    // Period-level totals for footer row
    const totalsAgg = await Receipt.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          taxableAmount: { $sum: "$taxableAmount" },
          gstAmount:     { $sum: "$gstAmount" },
          totalAmount:   { $sum: "$totalAmount" },
          discounts:     { $sum: "$discountApplied" },
          refunds:       { $sum: "$refundAmount" },
          count:         { $sum: 1 },
        }
      }
    ]);
    const totals = totalsAgg[0] || {};

    res.json({
      period: { from, to, label },
      page, limit, total,
      totalPages: Math.ceil(total / limit),
      periodTotals: {
        taxableAmount: r2(totals.taxableAmount),
        gstAmount:     r2(totals.gstAmount),
        totalAmount:   r2(totals.totalAmount),
        discounts:     r2(totals.discounts),
        refunds:       r2(totals.refunds),
        count:         totals.count || 0,
      },
      data,
    });

  } catch (err) {
    console.error("CA invoices error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── ROUTE 3: Wallet Topups (paginated) ───────────────────────────────────────
// GET /api/accountant/wallet-topups?period=fy&page=1&limit=50
router.get("/wallet-topups", caMiddleware, async (req, res) => {
  try {
    const { from, to, label } = buildDateRange(req.query);
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
      WalletTransaction.countDocuments({ type: "topup", createdAt: { $gte: from, $lte: to } }),
    ]);

    res.json({
      period: { from, to, label },
      page, limit, total,
      totalPages: Math.ceil(total / limit),
      data: transactions.map(t => ({
        _id:           t._id,
        date:          t.createdAt,
        userName:      t.userId?.name    || "—",
        userMobile:    t.userId?.mobile  || "—",
        userEmail:     t.userId?.email   || "—",
        amount:        r2(t.amount),
        balanceBefore: r2(t.balanceBefore),
        balanceAfter:  r2(t.balanceAfter),
        orderId:       t.orderId         || "—",
        description:   t.description     || "—",
      })),
    });
  } catch (err) {
    console.error("CA wallet-topups error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── ROUTE 4: Wallet Debits (charging session deductions) ─────────────────────
// GET /api/accountant/wallet-debits?period=fy&page=1&limit=50
router.get("/wallet-debits", caMiddleware, async (req, res) => {
  try {
    const { from, to, label } = buildDateRange(req.query);
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
      WalletTransaction.countDocuments({ type: "debit", createdAt: { $gte: from, $lte: to } }),
    ]);

    res.json({
      period: { from, to, label },
      page, limit, total,
      totalPages: Math.ceil(total / limit),
      data: transactions.map(t => ({
        _id:           t._id,
        date:          t.createdAt,
        userName:      t.userId?.name    || "—",
        userMobile:    t.userId?.mobile  || "—",
        amount:        r2(t.amount),
        balanceBefore: r2(t.balanceBefore),
        balanceAfter:  r2(t.balanceAfter),
        sessionId:     t.sessionId       || "—",
        description:   t.description     || "—",
      })),
    });
  } catch (err) {
    console.error("CA wallet-debits error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── ROUTE 5: Excel Export ────────────────────────────────────────────────────
// GET /api/accountant/export?period=month  (or period=quarter_fy etc.)
router.get("/export", caMiddleware, async (req, res) => {
  try {
    const { from, to, label } = buildDateRange(req.query);
    const registeredState = (process.env.REGISTERED_STATE || "Maharashtra").toLowerCase();

    const [receipts, topups, debits] = await Promise.all([
      Receipt.find({ createdAt: { $gte: from, $lte: to } }).sort({ createdAt: 1 }).lean(),
      WalletTransaction.find({ type: "topup", createdAt: { $gte: from, $lte: to } })
        .populate("userId", "name mobile email").sort({ createdAt: 1 }).lean(),
      WalletTransaction.find({ type: "debit", createdAt: { $gte: from, $lte: to } })
        .populate("userId", "name mobile email").sort({ createdAt: 1 }).lean(),
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator  = "Sparx EV — VJRA Technologies Pvt Ltd";
    wb.created  = new Date();

    const headerStyle = (color) => ({
      font: { bold: true, color: { argb: "FFFFFFFF" }, size: 10 },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: color } },
      alignment: { horizontal: "center", vertical: "middle" },
      border: {
        bottom: { style: "thin", color: { argb: "FF000000" } }
      }
    });

    const currency = (ws, col, startRow, endRow) => {
      for (let r = startRow; r <= endRow; r++) {
        const cell = ws.getCell(`${col}${r}`);
        cell.numFmt = '₹#,##0.00';
      }
    };

    // ── Sheet 1: Invoice Register ──────────────────────────────────────────────
    const ws1 = wb.addWorksheet("Invoice Register");
    ws1.columns = [
      { header: "Invoice No.",       key: "invoiceNo",      width: 22 },
      { header: "Date",              key: "date",           width: 20 },
      { header: "Customer Name",     key: "customerName",   width: 24 },
      { header: "Mobile",            key: "mobile",         width: 14 },
      { header: "GSTIN",             key: "gstin",          width: 20 },
      { header: "Place of Supply",   key: "placeOfSupply",  width: 18 },
      { header: "Supply Type",       key: "supplyType",     width: 14 },
      { header: "Invoice Type",      key: "invoiceType",    width: 12 },
      { header: "Payment Mode",      key: "paymentMode",    width: 14 },
      { header: "Energy (kWh)",      key: "energykWh",      width: 13 },
      { header: "Rate/kWh (Ex-GST)", key: "rate",           width: 18 },
      { header: "Taxable Amt (₹)",   key: "taxable",        width: 16 },
      { header: "CGST 9% (₹)",       key: "cgst",           width: 13 },
      { header: "SGST 9% (₹)",       key: "sgst",           width: 13 },
      { header: "IGST 18% (₹)",      key: "igst",           width: 13 },
      { header: "Total GST (₹)",     key: "totalGst",       width: 14 },
      { header: "Discount (₹)",      key: "discount",       width: 13 },
      { header: "Invoice Total (₹)", key: "totalAmount",    width: 16 },
      { header: "Amount Paid (₹)",   key: "amountPaid",     width: 16 },
      { header: "Refund (₹)",        key: "refund",         width: 12 },
    ];

    const s1 = headerStyle("FF1E3A5F");
    ws1.getRow(1).eachCell(cell => Object.assign(cell, s1));
    ws1.getRow(1).height = 22;

    receipts.forEach(r => {
      const isIntra = (r.deviceState || "").toLowerCase() === registeredState;
      const gst = r2(r.gstAmount || 0);
      ws1.addRow({
        invoiceNo:    r.receiptId,
        date:         new Date(r.createdAt).toLocaleString("en-IN"),
        customerName: r.userName      || "",
        mobile:       r.userMobile    || "",
        gstin:        r.userGstin     || "",
        placeOfSupply:r.deviceState   || "",
        supplyType:   isIntra ? "Intra-State" : "Inter-State",
        invoiceType:  r.userGstin ? "B2B" : "B2C",
        paymentMode:  (r.paymentGateway || "cashfree").toUpperCase(),
        energykWh:    r2(r.energyConsumed),
        rate:         r2(r.userRatePerKwh),
        taxable:      r2(r.taxableAmount),
        cgst:         isIntra ? r2(gst / 2) : 0,
        sgst:         isIntra ? r2(gst / 2) : 0,
        igst:         isIntra ? 0 : gst,
        totalGst:     gst,
        discount:     r2(r.discountApplied),
        totalAmount:  r2(r.totalAmount),
        amountPaid:   r2(r.amountPaid),
        refund:       r2(r.refundAmount || 0),
      });
    });

    // Totals row
    const totalRow1 = ws1.addRow({
      invoiceNo:   `TOTAL (${receipts.length} invoices)`,
      taxable:     r2(receipts.reduce((s,r) => s+(r.taxableAmount||0), 0)),
      cgst:        r2(receipts.reduce((s,r) => { const i=(r.deviceState||"").toLowerCase()===registeredState; return s+(i?(r.gstAmount||0)/2:0); }, 0)),
      sgst:        r2(receipts.reduce((s,r) => { const i=(r.deviceState||"").toLowerCase()===registeredState; return s+(i?(r.gstAmount||0)/2:0); }, 0)),
      igst:        r2(receipts.reduce((s,r) => { const i=(r.deviceState||"").toLowerCase()===registeredState; return s+(!i?(r.gstAmount||0):0); }, 0)),
      totalGst:    r2(receipts.reduce((s,r) => s+(r.gstAmount||0), 0)),
      discount:    r2(receipts.reduce((s,r) => s+(r.discountApplied||0), 0)),
      totalAmount: r2(receipts.reduce((s,r) => s+(r.totalAmount||0), 0)),
      amountPaid:  r2(receipts.reduce((s,r) => s+(r.amountPaid||0), 0)),
      refund:      r2(receipts.reduce((s,r) => s+(r.refundAmount||0), 0)),
    });
    totalRow1.font = { bold: true };
    totalRow1.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" } };

    // ── Sheet 2: Wallet Topups ─────────────────────────────────────────────────
    const ws2 = wb.addWorksheet("Wallet Topups");
    ws2.columns = [
      { header: "Date",            key: "date",          width: 22 },
      { header: "Customer Name",   key: "name",          width: 24 },
      { header: "Mobile",          key: "mobile",        width: 14 },
      { header: "Email",           key: "email",         width: 28 },
      { header: "Amount (₹)",      key: "amount",        width: 14 },
      { header: "Bal. Before (₹)", key: "balBefore",     width: 16 },
      { header: "Bal. After (₹)",  key: "balAfter",      width: 16 },
      { header: "Cashfree OrderID",key: "orderId",       width: 26 },
    ];
    const s2 = headerStyle("FF1E5631");
    ws2.getRow(1).eachCell(cell => Object.assign(cell, s2));
    ws2.getRow(1).height = 22;

    topups.forEach(t => {
      ws2.addRow({
        date:      new Date(t.createdAt).toLocaleString("en-IN"),
        name:      t.userId?.name    || "",
        mobile:    t.userId?.mobile  || "",
        email:     t.userId?.email   || "",
        amount:    r2(t.amount),
        balBefore: r2(t.balanceBefore),
        balAfter:  r2(t.balanceAfter),
        orderId:   t.orderId || "",
      });
    });
    const topupTotal = ws2.addRow({ date: `TOTAL (${topups.length} topups)`, amount: r2(topups.reduce((s,t)=>s+(t.amount||0),0)) });
    topupTotal.font = { bold: true };
    topupTotal.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };

    // ── Sheet 3: Wallet Debits ─────────────────────────────────────────────────
    const ws3 = wb.addWorksheet("Charging Debits");
    ws3.columns = [
      { header: "Date",            key: "date",       width: 22 },
      { header: "Customer Name",   key: "name",       width: 24 },
      { header: "Mobile",          key: "mobile",     width: 14 },
      { header: "Amount (₹)",      key: "amount",     width: 14 },
      { header: "Bal. Before (₹)", key: "balBefore",  width: 16 },
      { header: "Bal. After (₹)",  key: "balAfter",   width: 16 },
      { header: "Session ID",      key: "sessionId",  width: 28 },
      { header: "Description",     key: "desc",       width: 30 },
    ];
    const s3 = headerStyle("FF4A0E0E");
    ws3.getRow(1).eachCell(cell => Object.assign(cell, s3));
    ws3.getRow(1).height = 22;

    debits.forEach(d => {
      ws3.addRow({
        date:      new Date(d.createdAt).toLocaleString("en-IN"),
        name:      d.userId?.name    || "",
        mobile:    d.userId?.mobile  || "",
        amount:    r2(d.amount),
        balBefore: r2(d.balanceBefore),
        balAfter:  r2(d.balanceAfter),
        sessionId: d.sessionId  || "",
        desc:      d.description || "",
      });
    });
    const debitTotal = ws3.addRow({ date: `TOTAL (${debits.length} debits)`, amount: r2(debits.reduce((s,d)=>s+(d.amount||0),0)) });
    debitTotal.font = { bold: true };
    debitTotal.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };

    // ── Sheet 4: GSTR-1 Summary ────────────────────────────────────────────────
    const ws4 = wb.addWorksheet("GSTR-1 Summary");
    ws4.mergeCells("A1:G1");
    ws4.getCell("A1").value = "GSTR-1 SUMMARY — Sparx EV / VJRA Technologies Pvt Ltd";
    ws4.getCell("A1").font  = { bold: true, size: 13 };
    ws4.getCell("A2").value = `Period: ${from.toDateString()} → ${to.toDateString()}`;
    ws4.getCell("A3").value = `Generated: ${new Date().toLocaleString("en-IN")}`;
    ws4.getCell("A4").value = `Registered State: ${process.env.REGISTERED_STATE || "Maharashtra"}`;

    ws4.addRow([]);
    const hRow = ws4.addRow(["Section", "Taxable (₹)", "CGST (₹)", "SGST (₹)", "IGST (₹)", "Total GST (₹)", "No. of Invoices"]);
    const s4 = headerStyle("FF1E3A5F");
    hRow.eachCell(cell => Object.assign(cell, s4));
    hRow.height = 20;

    const b2cIntra = receipts.filter(r => !r.userGstin && (r.deviceState||"").toLowerCase()===registeredState);
    const b2cInter = receipts.filter(r => !r.userGstin && (r.deviceState||"").toLowerCase()!==registeredState);
    const b2bIntra = receipts.filter(r =>  r.userGstin && (r.deviceState||"").toLowerCase()===registeredState);
    const b2bInter = receipts.filter(r =>  r.userGstin && (r.deviceState||"").toLowerCase()!==registeredState);

    const sT  = arr => r2(arr.reduce((s,r)=>s+(r.taxableAmount||0),0));
    const sG  = arr => r2(arr.reduce((s,r)=>s+(r.gstAmount||0),0));

    [
      ["B2C — Intra-State (CGST+SGST)", b2cIntra, true],
      ["B2C — Inter-State (IGST)",      b2cInter, false],
      ["B2B — Intra-State (CGST+SGST)", b2bIntra, true],
      ["B2B — Inter-State (IGST)",      b2bInter, false],
    ].forEach(([lbl, arr, intra]) => {
      const tax = sT(arr), gst = sG(arr);
      ws4.addRow([
        lbl, tax,
        intra ? r2(gst/2) : 0,
        intra ? r2(gst/2) : 0,
        intra ? 0 : gst,
        gst, arr.length,
      ]);
    });

    const allTax  = sT(receipts), allGst = sG(receipts);
    const allCGST = r2([...b2cIntra,...b2bIntra].reduce((s,r)=>s+(r.gstAmount||0)/2,0));
    const allIGST = r2([...b2cInter,...b2bInter].reduce((s,r)=>s+(r.gstAmount||0),0));
    const gRow = ws4.addRow(["GRAND TOTAL", allTax, allCGST, allCGST, allIGST, allGst, receipts.length]);
    gRow.font = { bold: true, size: 11 };
    gRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" } };

    ws4.columns = [
      {width:34},{width:16},{width:14},{width:14},{width:14},{width:16},{width:18}
    ];

    // Stream
    const filename = `Sparx_CA_${label.replace(/\s+/g,"_")}_${Date.now()}.xlsx`;
    res.setHeader("Content-Type",        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error("CA Excel export error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

// ─── ROUTE 6: Create accountant user (admin only) ─────────────────────────────
// POST /api/accountant/create-user
router.post("/create-user", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access only" });
    }
    const { name, mobile, email } = req.body;
    if (!name || !mobile) {
      return res.status(400).json({ error: "name and mobile are required" });
    }

    let user = await User.findOne({ mobile });
    if (user) {
      if (user.role === "accountant") {
        return res.status(400).json({ error: "Already an accountant" });
      }
      user.role = "accountant";
      await user.save();
      return res.json({ message: "Promoted to accountant", user: { _id: user._id, name: user.name, mobile: user.mobile } });
    }

    user = new User({ name, mobile, email: email || undefined, role: "accountant", phoneVerified: false });
    await user.save();
    res.status(201).json({ message: "Accountant created. Login via OTP.", user: { _id: user._id, name: user.name, mobile: user.mobile } });
  } catch (err) {
    console.error("Create accountant error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;