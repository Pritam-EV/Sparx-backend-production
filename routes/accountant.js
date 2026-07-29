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
const axios = require("axios");
// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Cashfree Settlement helpers ──────────────────────────────────────────────
const CF_BASE = "https://api.cashfree.com/pg";
const CF_HEADERS = {
  "x-api-version": "2023-08-01",
  "x-client-id":     process.env.CASHFREE_APP_ID,
  "x-client-secret": process.env.CASHFREE_SECRET_KEY,
  "Content-Type":    "application/json",
};


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
        // Card 2: Net wallet consumption = debits - wallet refunds this FY
        WalletTransaction.aggregate([
        {
            $match: {
            type: { $in: ["debit", "refund"] },
            createdAt: { $gte: fyFrom, $lte: fyTo }
            }
        },
        {
            $group: {
            _id: null,
            totalDebits:  { $sum: { $cond: [{ $eq: ["$type", "debit"]   }, "$amount", 0] } },
            totalRefunds: { $sum: { $cond: [{ $eq: ["$type", "refund"]  }, "$amount", 0] } },
            debitCount:   { $sum: { $cond: [{ $eq: ["$type", "debit"]   }, 1, 0] } },
            refundCount:  { $sum: { $cond: [{ $eq: ["$type", "refund"]  }, 1, 0] } },
            }
        }
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
        // Card 2 — was: debitAgg[0]?.total
        totalConsumption: {
        amount: r2((debitAgg[0]?.totalDebits || 0) - (debitAgg[0]?.totalRefunds || 0)),
        count:  debitAgg[0]?.debitCount || 0,
        label:  fyLabel,
        // bonus fields for transparency — visible in browser console/network tab
        grossDebits:  r2(debitAgg[0]?.totalDebits  || 0),
        walletRefunds: r2(debitAgg[0]?.totalRefunds || 0),
        refundCount:  debitAgg[0]?.refundCount || 0,
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


// ─── ROUTE 1b: Financial Summary (period-aware, for Overview KPI cards) ────────
// GET /api/accountant/financial-summary?period=month  (or fy, quarter_fy, today, custom)
// Returns combined Receipt + WalletTransaction aggregates for the period.
router.get("/financial-summary", caMiddleware, async (req, res) => {
  try {
    const { from, to, label } = buildDateRange(req.query);
    const registeredState = (process.env.REGISTERED_STATE || "Maharashtra").toLowerCase().trim();
    const projectId = req.query.projectId || null; // NEW
    // Build base match for Receipts
    const receiptMatch = { createdAt: { $gte: from, $lte: to } };
    if (projectId) {
      receiptMatch.projectId = new mongoose.Types.ObjectId(projectId); // NEW
    }
    const [receiptAgg, walletAgg, liveBalanceAgg, liveSessionAgg] = await Promise.all([
      
      // Receipt aggregates: gross billing, GST, PG charges, owner payable, platform margin, refunds, discounts
      Receipt.aggregate([
        { $match: { createdAt: { $gte: from, $lte: to } } },
        {
          $addFields: {
            _pos: { $toLower: { $trim: { input: { $ifNull: ["$placeOfSupply", { $ifNull: ["$deviceState", ""] }] } } } }
          }
        },
        {
          $group: {
            _id: null,
            // Gross billing
            grossBilling:    { $sum: "$totalAmount" },
            taxableAmount:   { $sum: "$taxableAmount" },
            totalGst:        { $sum: "$gstAmount" },
            // GST split
            totalCgst: { $sum: { $cond: [{ $eq: ["$_pos", registeredState] }, { $divide: [{ $ifNull: ["$gstAmount", 0] }, 2] }, 0] } },
            totalSgst: { $sum: { $cond: [{ $eq: ["$_pos", registeredState] }, { $divide: [{ $ifNull: ["$gstAmount", 0] }, 2] }, 0] } },
            totalIgst: { $sum: { $cond: [{ $ne: ["$_pos", registeredState] }, { $ifNull: ["$gstAmount", 0] }, 0] } },
            // Income & deductions
            platformIncome:  { $sum: { $ifNull: ["$vjraMarginAmount", 0] } },
            pgCharges:       { $sum: { $ifNull: ["$paymentCharges",   0] } },
            ownerPayable:    { $sum: { $ifNull: ["$ownerPayout",       0] } },
            electricityCost: { $sum: { $ifNull: ["$electricityCost",  0] } },
            discounts:       { $sum: { $ifNull: ["$discountApplied",  0] } },
            refunds:         { $sum: { $ifNull: ["$refundAmount",      0] } },
            // Cashfree vs wallet breakdown
            cashfreeRevenue: { $sum: { $cond: [{ $eq: ["$paymentGateway", "cashfree"] }, "$totalAmount", 0] } },
            walletRevenue:   { $sum: { $cond: [{ $eq: ["$paymentGateway", "wallet"]   }, "$totalAmount", 0] } },
            freeRevenue:     { $sum: { $cond: [{ $eq: ["$paymentGateway", "free"]     }, "$totalAmount", 0] } },
            invoiceCount:    { $sum: 1 },
            b2bCount:        { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$userGstin", ""] } }, 0] }, 1, 0] } },
          }
        }
      ]),

      // Wallet aggregates: topups (advances received), debits (advances utilised), wallet refunds
      WalletTransaction.aggregate([
        { $match: { createdAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: null,
            walletTopups:      { $sum: { $cond: [{ $eq: ["$type", "topup"]       }, "$amount", 0] } },
            walletDebits:      { $sum: { $cond: [{ $eq: ["$type", "debit"]       }, "$amount", 0] } },
            walletRefunds:     { $sum: { $cond: [{ $eq: ["$type", "refund"]      }, "$amount", 0] } },
            bankRefunds:       { $sum: { $cond: [{ $eq: ["$type", "refund_bank"] }, "$amount", 0] } },
            adminCredits:      { $sum: { $cond: [{ $eq: ["$type", "admin_credit"]}, "$amount", 0] } },
            adminDebits:       { $sum: { $cond: [{ $eq: ["$type", "admin_debit"] }, "$amount", 0] } },
            topupCount:        { $sum: { $cond: [{ $eq: ["$type", "topup"]       }, 1, 0] } },
            debitCount:        { $sum: { $cond: [{ $eq: ["$type", "debit"]       }, 1, 0] } },
            refundCount:       { $sum: { $cond: [{ $in: ["$type", ["refund", "refund_bank"]] }, 1, 0] } },
          }
        }
      ]),

      // Live wallet float (always live regardless of period)
      User.aggregate([
        { $match: { walletBalance: { $gt: 0 } } },
        { $group: { _id: null, totalFloat: { $sum: "$walletBalance" }, userCount: { $sum: 1 } } }
      ]),

      // Live active wallet sessions
      Session.aggregate([
        { $match: { status: "active", paymentGateway: "wallet" } },
        { $group: { _id: null, totalAmountUsed: { $sum: "$amountUsed" }, sessionCount: { $sum: 1 } } }
      ]),
    ]);

    const rec = receiptAgg[0] || {};
    const wal = walletAgg[0]  || {};

    res.json({
      period: { from, to, label },

      // ── Billing & Tax ────────────────────────────────────────────────────────
      grossBilling:    r2(rec.grossBilling),
      taxableAmount:   r2(rec.taxableAmount),
      totalGst:        r2(rec.totalGst),
      cgst:            r2(rec.totalCgst),
      sgst:            r2(rec.totalSgst),
      igst:            r2(rec.totalIgst),
      invoiceCount:    rec.invoiceCount || 0,
      b2bCount:        rec.b2bCount    || 0,

      // ── Income & Deductions ───────────────────────────────────────────────────
      platformIncome:  r2(rec.platformIncome),
      pgCharges:       r2(rec.pgCharges),
      ownerPayable:    r2(rec.ownerPayable),
      electricityCost: r2(rec.electricityCost),
      discounts:       r2(rec.discounts),
      refundsIssued:   r2(rec.refunds),

      // ── Payment mode split ───────────────────────────────────────────────────
      cashfreeRevenue: r2(rec.cashfreeRevenue),
      walletRevenue:   r2(rec.walletRevenue),
      freeRevenue:     r2(rec.freeRevenue),

      // ── Wallet Ledger (period) ────────────────────────────────────────────────
      walletTopups:    r2(wal.walletTopups),    // Customer Advances Received
      walletDebits:    r2(wal.walletDebits),    // Advances Utilised
      walletRefunds:   r2(wal.walletRefunds),   // Refund to Wallet
      bankRefunds:     r2(wal.bankRefunds),     // Refund to Bank
      adminCredits:    r2(wal.adminCredits),
      adminDebits:     r2(wal.adminDebits),
      topupCount:      wal.topupCount  || 0,
      debitCount:      wal.debitCount  || 0,
      refundCount:     wal.refundCount || 0,

      // ── Live (always real-time) ───────────────────────────────────────────────
      liveWalletFloat:     r2(liveBalanceAgg[0]?.totalFloat      || 0),
      liveWalletUsers:     liveBalanceAgg[0]?.userCount           || 0,
      liveSessionAmount:   r2(liveSessionAgg[0]?.totalAmountUsed || 0),
      liveActiveSessions:  liveSessionAgg[0]?.sessionCount        || 0,
    });

  } catch (err) {
    console.error("CA financial-summary error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// ─── ROUTE 2: Invoice Register (Receipts table for CA) ────────────────────────
// GET /api/accountant/invoices?period=fy&page=1&limit=50&search=
// ─── ROUTE 2: Invoice Register ─────────────────────────────────────────────
// Changes vs old version:
//  1. userName now sourced from Receipt.userName directly (already snapshotted)
//  2. customerMobile removed from response
//  3. placeOfSupply uses r.placeOfSupply (new field) falling back to r.deviceState
//  4. CGST/SGST/IGST bifurcation: intra = CGST+SGST, inter = IGST only
//  5. supplyType derived from placeOfSupply vs REGISTERED_STATE
//  6. invoiceNo = receiptId (as specified)

router.get("/invoices", caMiddleware, async (req, res) => {
  try {
    const { from, to, label } = buildDateRange(req.query);
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    const match = { createdAt: { $gte: from, $lte: to } };

    if (req.query.search) {
      const re = new RegExp(req.query.search, "i");
      match.$or = [
        { receiptId:  re },
        { userName:   re },
        { userGstin:  re },
        { deviceId:   re },
        { deviceCity: re },
        { placeOfSupply: re },
      ];
    }

    if (req.query.projectId) {
      match.projectId = new mongoose.Types.ObjectId(req.query.projectId);
    }

    const registeredState = (process.env.REGISTERED_STATE || "Maharashtra").toLowerCase().trim();

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

    const data = receipts.map(r => {
      // placeOfSupply: use new field, fall back to deviceState for old receipts
      const pos     = (r.placeOfSupply || r.deviceState || "").trim();
      const isIntra = pos.toLowerCase() === registeredState;
      const gst     = r2(r.gstAmount || 0);

      return {
        invoiceNo:     r.receiptId,           // receipt ID as invoice no.
        date:          r.createdAt,
        customerName:  r.userName || "—",     // from receipt snapshot directly
        customerGstin: r.userGstin || "",     // empty = B2C
        placeOfSupply: pos || "—",
        deviceId:      r.deviceId,
        deviceCity:    r.deviceCity || "—",
        paymentMode:   r.paymentGateway || "cashfree",
        taxableAmount: r2(r.taxableAmount),
        cgst:  isIntra ? r2(gst / 2) : 0,    // 9% only if intra-state
        sgst:  isIntra ? r2(gst / 2) : 0,    // 9% only if intra-state
        igst:  isIntra ? 0 : gst,             // 18% only if inter-state
        totalGst:      gst,
        discount:      r2(r.discountApplied),
        totalAmount:   r2(r.totalAmount),
        supplyType:    isIntra ? "Intra-State" : "Inter-State",
        invoiceType:   r.userGstin ? "B2B" : "B2C",
      };
    });

    // Period totals (split cgst/sgst/igst correctly in aggregate too)
    const totalsAgg = await Receipt.aggregate([
      { $match: match },
      {
        $addFields: {
          _pos: { $toLower: { $trim: { input: { $ifNull: ["$placeOfSupply", { $ifNull: ["$deviceState", ""] }] } } } }
        }
      },
      {
        $group: {
          _id:           null,
          taxableAmount: { $sum: "$taxableAmount" },
          totalCgst:     { $sum: { $cond: [{ $eq: ["$_pos", registeredState] }, { $divide: [{ $ifNull: ["$gstAmount", 0] }, 2] }, 0] } },
          totalSgst:     { $sum: { $cond: [{ $eq: ["$_pos", registeredState] }, { $divide: [{ $ifNull: ["$gstAmount", 0] }, 2] }, 0] } },
          totalIgst:     { $sum: { $cond: [{ $ne: ["$_pos", registeredState] }, { $ifNull: ["$gstAmount", 0] }, 0] } },
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
        cgst:          r2(totals.totalCgst),
        sgst:          r2(totals.totalSgst),
        igst:          r2(totals.totalIgst),
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
        .populate("userId", "name")
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
        .populate("userId", "name  ").sort({ createdAt: 1 }).lean(),
      WalletTransaction.find({ type: "debit", createdAt: { $gte: from, $lte: to } })
        .populate("userId", "name ").sort({ createdAt: 1 }).lean(),
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator  = "VIZ EV — VJRA Technologies LLP";
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
        placeOfSupply: r.placeOfSupply || r.deviceState || "",
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
    ws4.getCell("A1").value = "GSTR-1 SUMMARY — VIZ EV / VJRA Technologies LLP";
    ws4.getCell("A1").font  = { bold: true, size: 13 };
    ws4.getCell("A2").value = `Period: ${from.toDateString()} → ${to.toDateString()}`;
    ws4.getCell("A3").value = `Generated: ${new Date().toLocaleString("en-IN")}`;
    ws4.getCell("A4").value = `Registered State: ${process.env.REGISTERED_STATE || "Maharashtra"}`;

    ws4.addRow([]);
    const hRow = ws4.addRow(["Section", "Taxable (₹)", "CGST (₹)", "SGST (₹)", "IGST (₹)", "Total GST (₹)", "No. of Invoices"]);
    const s4 = headerStyle("FF1E3A5F");
    hRow.eachCell(cell => Object.assign(cell, s4));
    hRow.height = 20;

    const b2cIntra = receipts.filter(r => !r.userGstin &&  (r.placeOfSupply||r.deviceState||"").toLowerCase()===registeredState);
    const b2cInter = receipts.filter(r => !r.userGstin && ((r.placeOfSupply||r.deviceState||"").toLowerCase()!==registeredState));
    const b2bIntra = receipts.filter(r =>  r.userGstin &&  (r.placeOfSupply||r.deviceState||"").toLowerCase()===registeredState);
    const b2bInter = receipts.filter(r =>  r.userGstin && ((r.placeOfSupply||r.deviceState||"").toLowerCase()!==registeredState));
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

        // ── Sheet 5: Owner Settlement ──────────────────────────────────────────────
    const ws5 = wb.addWorksheet("Owner Settlement");
    ws5.columns = [
      { header: "Owner Name",       key: "ownerName",      width: 26 },
      { header: "Mobile",           key: "mobile",         width: 16 },
      { header: "Email",            key: "email",          width: 28 },
      { header: "No. of Sessions",  key: "sessions",       width: 14 },
      { header: "Gross Billing (₹)",key: "gross",          width: 18 },
      { header: "GST (₹)",          key: "gst",            width: 14 },
      { header: "PG Charges (₹)",   key: "pg",             width: 14 },
      { header: "EB Cost (₹)",      key: "eb",             width: 14 },
      { header: "VJRA Margin (₹)",  key: "vjra",           width: 16 },
      { header: "Owner Payout (₹)", key: "payout",         width: 16 },
      { header: "Energy (kWh)",     key: "energy",         width: 14 },
    ];
    const s5 = headerStyle("FF4A1942");
    ws5.getRow(1).eachCell(cell => Object.assign(cell, s5));
    ws5.getRow(1).height = 22;

    // Group receipts by ownerId
    const ownerMap = {};
    receipts.forEach(r => {
      const key = String(r.ownerId || "unknown");
      if (!ownerMap[key]) {
        ownerMap[key] = {
          ownerName: r.ownerName || "Unknown",
          mobile: r.ownerMobile || "",
          email: r.ownerEmail || "",
          sessions: 0, gross: 0, gst: 0, pg: 0, eb: 0, vjra: 0, payout: 0, energy: 0,
        };
      }
      const o = ownerMap[key];
      o.sessions++;
      o.gross  += r.totalAmount    || 0;
      o.gst    += r.gstAmount      || 0;
      o.pg     += r.paymentCharges || 0;
      o.eb     += r.electricityCost|| 0;
      o.vjra   += r.vjraMarginAmount|| 0;
      o.payout += r.ownerPayout    || 0;
      o.energy += r.energyConsumed || 0;
    });

    Object.values(ownerMap).forEach(o => {
      ws5.addRow({
        ownerName: o.ownerName,
        mobile:    o.mobile,
        email:     o.email,
        sessions:  o.sessions,
        gross:     r2(o.gross),
        gst:       r2(o.gst),
        pg:        r2(o.pg),
        eb:        r2(o.eb),
        vjra:      r2(o.vjra),
        payout:    r2(o.payout),
        energy:    r2(o.energy),
      });
    });
    const ownerTotalRow = ws5.addRow({
      ownerName: `TOTAL (${Object.keys(ownerMap).length} owners)`,
      sessions:  receipts.length,
      gross:     r2(Object.values(ownerMap).reduce((s,o) => s+o.gross,  0)),
      gst:       r2(Object.values(ownerMap).reduce((s,o) => s+o.gst,   0)),
      pg:        r2(Object.values(ownerMap).reduce((s,o) => s+o.pg,    0)),
      eb:        r2(Object.values(ownerMap).reduce((s,o) => s+o.eb,    0)),
      vjra:      r2(Object.values(ownerMap).reduce((s,o) => s+o.vjra,  0)),
      payout:    r2(Object.values(ownerMap).reduce((s,o) => s+o.payout,0)),
      energy:    r2(Object.values(ownerMap).reduce((s,o) => s+o.energy,0)),
    });
    ownerTotalRow.font = { bold: true };
    ownerTotalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8D5F5" } };

    // ── Sheet 6: Refunds & Adjustments ────────────────────────────────────────
    const ws6 = wb.addWorksheet("Refunds");
    ws6.columns = [
      { header: "Date",            key: "date",        width: 22 },
      { header: "Invoice No.",     key: "invoiceNo",   width: 22 },
      { header: "Customer",        key: "customer",    width: 24 },
      { header: "Session ID",      key: "sessionId",   width: 28 },
      { header: "Payment Mode",    key: "mode",        width: 14 },
      { header: "Invoice Amt (₹)", key: "invoiceAmt",  width: 16 },
      { header: "Refund Amt (₹)",  key: "refundAmt",   width: 14 },
      { header: "Refund Mode",     key: "refundMode",  width: 14 },
      { header: "Refund Status",   key: "status",      width: 16 },
      { header: "Refund ID",       key: "refundId",    width: 24 },
      { header: "Processed At",    key: "processedAt", width: 22 },
    ];
    const s6 = headerStyle("FF7F1D1D");
    ws6.getRow(1).eachCell(cell => Object.assign(cell, s6));
    ws6.getRow(1).height = 22;

    const refundReceipts = receipts.filter(r => (r.refundAmount || 0) > 0);
    refundReceipts.forEach(r => {
      ws6.addRow({
        date:        new Date(r.createdAt).toLocaleString("en-IN"),
        invoiceNo:   r.receiptId,
        customer:    r.userName || "",
        sessionId:   r.sessionId,
        mode:        (r.paymentGateway || "cashfree").toUpperCase(),
        invoiceAmt:  r2(r.totalAmount),
        refundAmt:   r2(r.refundAmount),
        refundMode:  r.refund?.status === "wallet_refunded" ? "WALLET" : "BANK",
        status:      r.refund?.status  || "—",
        refundId:    r.refund?.refundId || "",
        processedAt: r.refund?.processedAt ? new Date(r.refund.processedAt).toLocaleString("en-IN") : "",
      });
    });
    if (refundReceipts.length > 0) {
      const refTotalRow = ws6.addRow({
        date: `TOTAL (${refundReceipts.length} refunds)`,
        invoiceAmt: r2(refundReceipts.reduce((s,r) => s+(r.totalAmount||0), 0)),
        refundAmt:  r2(refundReceipts.reduce((s,r) => s+(r.refundAmount||0),0)),
      });
      refTotalRow.font = { bold: true };
      refTotalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
    }

    // Stream
    const filename = `VIZ_CA_${label.replace(/\s+/g,"_")}_${Date.now()}.xlsx`;
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

// ─── ROUTE 7: Owner Settlement Register ────────────────────────────────────────
// GET /api/accountant/owner-settlement?period=month&page=1&limit=50
// Returns per-owner aggregated payout summary + individual receipt breakdown.
router.get("/owner-settlement", caMiddleware, async (req, res) => {
  try {
    const { from, to, label } = buildDateRange(req.query);
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    // Per-owner aggregate summary
    const ownerAgg = await Receipt.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: "$ownerId",
          ownerName:       { $first: "$ownerName" },
          ownerEmail:      { $first: "$ownerEmail" },
          ownerMobile:     { $first: "$ownerMobile" },
          invoiceCount:    { $sum: 1 },
          grossBilling:    { $sum: "$totalAmount" },
          taxableAmount:   { $sum: "$taxableAmount" },
          gstAmount:       { $sum: "$gstAmount" },
          ownerPayout:     { $sum: "$ownerPayout" },
          vjraMargin:      { $sum: "$vjraMarginAmount" },
          pgCharges:       { $sum: "$paymentCharges" },
          electricityCost: { $sum: "$electricityCost" },
          energyConsumed:  { $sum: "$energyConsumed" },
          refundsIssued:   { $sum: "$refundAmount" },
          discounts:       { $sum: "$discountApplied" },
        }
      },
      { $sort: { ownerPayout: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]);

    const totalOwnersAgg = await Receipt.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: "$ownerId" } },
      { $count: "total" },
    ]);

    // Period-level totals (for summary bar)
    const periodAgg = await Receipt.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: null,
          totalOwnerPayout:  { $sum: "$ownerPayout" },
          totalVjraMargin:   { $sum: "$vjraMarginAmount" },
          totalGrossBilling: { $sum: "$totalAmount" },
          totalPgCharges:    { $sum: "$paymentCharges" },
          totalElectricity:  { $sum: "$electricityCost" },
          totalEnergy:       { $sum: "$energyConsumed" },
          invoiceCount:      { $sum: 1 },
        }
      }
    ]);

    const totals = periodAgg[0] || {};
    const total  = totalOwnersAgg[0]?.total || 0;

    res.json({
      period: { from, to, label },
      page, limit, total,
      totalPages: Math.ceil(total / limit),
      periodTotals: {
        totalOwnerPayout:  r2(totals.totalOwnerPayout),
        totalVjraMargin:   r2(totals.totalVjraMargin),
        totalGrossBilling: r2(totals.totalGrossBilling),
        totalPgCharges:    r2(totals.totalPgCharges),
        totalElectricity:  r2(totals.totalElectricity),
        totalEnergyKwh:    r2(totals.totalEnergy),
        invoiceCount:      totals.invoiceCount || 0,
      },
      data: ownerAgg.map(o => ({
        ownerId:         o._id,
        ownerName:       o.ownerName  || "Unknown Owner",
        ownerEmail:      o.ownerEmail || "—",
        ownerMobile:     o.ownerMobile || "—",
        invoiceCount:    o.invoiceCount,
        grossBilling:    r2(o.grossBilling),
        taxableAmount:   r2(o.taxableAmount),
        gstAmount:       r2(o.gstAmount),
        ownerPayout:     r2(o.ownerPayout),
        vjraMargin:      r2(o.vjraMargin),
        pgCharges:       r2(o.pgCharges),
        electricityCost: r2(o.electricityCost),
        energyKwh:       r2(o.energyConsumed),
        refundsIssued:   r2(o.refundsIssued),
        discounts:       r2(o.discounts),
        // Net cashflow = grossBilling - pgCharges - ownerPayout = vjraMargin
        vjraNet:         r2((o.vjraMargin || 0) - (o.pgCharges || 0)),
      })),
    });

  } catch (err) {
    console.error("CA owner-settlement error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// ─── ROUTE 8: Refunds & Adjustments Register ──────────────────────────────────
// GET /api/accountant/refunds?period=month&page=1&limit=50
// Returns all refund entries from both Receipt and WalletTransaction.
router.get("/refunds", caMiddleware, async (req, res) => {
  try {
    const { from, to, label } = buildDateRange(req.query);
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

        const receiptMatch = {
      createdAt: { $gte: from, $lte: to },
      refundAmount: { $gt: 0 }
    };

        const refunds = await Receipt.aggregate([
      { $match: receiptMatch },
      { $project: {
          receiptId: 1, createdAt: 1, userName: 1,
          refundAmount: 1, totalAmount: 1, paymentGateway: 1,
          "refund.status": 1, "refund.failureReason": 1,
          sessionId: 1
      }},
      { $sort: { createdAt: -1 } }
    ]);

    res.json({ data: refunds, period: { from, to, label } });
    

    // Get receipts that have any refund (refundAmount > 0)
    const [receiptRefunds, walletRefunds, totalReceipt, totalWallet] = await Promise.all([

      Receipt.find({
        createdAt: { $gte: from, $lte: to },
        refundAmount: { $gt: 0 }
      })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      WalletTransaction.find({
        createdAt: { $gte: from, $lte: to },
        type: { $in: ["refund", "refund_bank"] }
      })
        .populate("userId", "name mobile email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Receipt.countDocuments({ createdAt: { $gte: from, $lte: to }, refundAmount: { $gt: 0 } }),
      WalletTransaction.countDocuments({ createdAt: { $gte: from, $lte: to }, type: { $in: ["refund", "refund_bank"] } }),
    ]);

    // Period totals for refunds
    const [refundTotalsAgg, walletRefundTotalsAgg] = await Promise.all([
      Receipt.aggregate([
        { $match: receiptMatch },
        { $group: {
            _id: null,
            totalRefundAmount: { $sum: "$refundAmount" },
            count: { $sum: 1 },
            walletRefunded: { $sum: { $cond: [{ $eq: ["$refund.status", "wallet_refunded"] }, "$refundAmount", 0] } },
            bankRefunded:   { $sum: { $cond: [{ $eq: ["$refund.status", "processed"]       }, "$refundAmount", 0] } },
          }
        }
      ]),
      WalletTransaction.aggregate([
        { $match: { createdAt: { $gte: from, $lte: to }, type: { $in: ["refund", "refund_bank"] } } },
        { $group: {
            _id: null,
            totalWalletRefund: { $sum: { $cond: [{ $eq: ["$type", "refund"]      }, "$amount", 0] } },
            totalBankRefund:   { $sum: { $cond: [{ $eq: ["$type", "refund_bank"] }, "$amount", 0] } },
            walletCount: { $sum: { $cond: [{ $eq: ["$type", "refund"]      }, 1, 0] } },
            bankCount:   { $sum: { $cond: [{ $eq: ["$type", "refund_bank"] }, 1, 0] } },
          }
        }
      ]),
    ]);

    const rt  = refundTotalsAgg[0]  || {};
    const wrt = walletRefundTotalsAgg[0] || {};

    res.json({
      period: { from, to, label },
      periodTotals: {
        receiptRefunds:   r2(rt.totalRefundAmount),
        walletRefunds:    r2(wrt.totalWalletRefund),
        bankRefunds:      r2(wrt.totalBankRefund),
        totalRefunds:     r2((rt.totalRefundAmount || 0) + (wrt.totalBankRefund || 0)),
        receiptCount:     rt.count || 0,
        walletCount:      wrt.walletCount || 0,
        bankCount:        wrt.bankCount   || 0,
      },
      // Receipt-level refunds (source: Receipt.refundAmount)
      receiptRefunds: {
        total: totalReceipt,
        data: receiptRefunds.map(r => ({
          source:        "receipt",
          date:          r.createdAt,
          invoiceNo:     r.receiptId,
          customerName:  r.userName   || "—",
          sessionId:     r.sessionId,
          refundAmount:  r2(r.refundAmount),
          refundMode:    r.refund?.status === "wallet_refunded" ? "Wallet" : r.refund?.status === "processed" ? "Bank" : r.refund?.status || "—",
          refundStatus:  r.refund?.status || "—",
          refundId:      r.refund?.refundId || "—",
          processedAt:   r.refund?.processedAt || null,
          reason:        r.refund?.failureReason || "Session under-utilised",
          originalAmount: r2(r.totalAmount),
          paymentMode:   r.paymentGateway,
        })),
      },
      // Wallet-level refunds (source: WalletTransaction type=refund/refund_bank)
      walletRefunds: {
        total: totalWallet,
        data: walletRefunds.map(t => ({
          source:       "wallet",
          date:         t.createdAt,
          type:         t.type,
          customerName: t.userId?.name   || "—",
          userMobile:   t.userId?.mobile || "—",
          amount:       r2(t.amount),
          balanceBefore: r2(t.balanceBefore),
          balanceAfter:  r2(t.balanceAfter),
          sessionId:    t.sessionId  || "—",
          orderId:      t.orderId    || "—",
          description:  t.description || "—",
          initiatedBy:  t.initiatedBy,
        })),
      },
    });

  } catch (err) {
    console.error("CA refunds error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// ─── ROUTE 9: Cashfree Reconciliation (PG-side vs our records) ────────────────
// GET /api/accountant/cashfree-recon?period=month
// Currently derives expected collections from our Receipt + WalletTransaction data.
// When Cashfree webhook/settlement model is available, actual_settled will come from DB.
// This stub is ready to be extended with real Cashfree settlement data.
router.get("/cashfree-recon", caMiddleware, async (req, res) => {
  try {
    const { from, to, label } = buildDateRange(req.query);

    const [receiptAgg, topupAgg] = await Promise.all([
      // Direct Cashfree receipts (paymentGateway=cashfree)
      Receipt.aggregate([
        { $match: { createdAt: { $gte: from, $lte: to }, paymentGateway: "cashfree" } },
        { $group: {
            _id: null,
            totalCollected:   { $sum: "$totalAmount" },
            totalPgCharges:   { $sum: "$paymentCharges" },
            totalRefunds:     { $sum: "$refundAmount" },
            count: { $sum: 1 },
          }
        }
      ]),
      // Wallet topups (also go through Cashfree)
      WalletTransaction.aggregate([
        { $match: { type: "topup", createdAt: { $gte: from, $lte: to } } },
        { $group: {
            _id: null,
            totalTopups: { $sum: "$amount" },
            count: { $sum: 1 },
          }
        }
      ]),
    ]);

    const ra = receiptAgg[0] || {};
    const ta = topupAgg[0]   || {};

    const totalCashfreeCollections = r2((ra.totalCollected || 0) + (ta.totalTopups || 0));
    const totalPgCharges           = r2(ra.totalPgCharges  || 0);
    const totalRefundsViaCashfree  = r2(ra.totalRefunds    || 0);
    const expectedSettlement       = r2(totalCashfreeCollections - totalPgCharges - totalRefundsViaCashfree);

    res.json({
      period: { from, to, label },
      // Our records
      ourRecords: {
        directSessionCollections: r2(ra.totalCollected || 0),
        sessionCount:             ra.count || 0,
        walletTopupCollections:   r2(ta.totalTopups || 0),
        topupCount:               ta.count || 0,
        totalCashfreeCollections,
        pgChargesDeducted:        totalPgCharges,
        refundsDeducted:          totalRefundsViaCashfree,
        expectedSettlement,       // what Cashfree should settle to our bank
      },
      // Actual Cashfree settlement (to be filled from Cashfree webhook/Settlement model)
      // When you add a CashfreeSettlement model, replace these with actual DB queries
      cashfreeActual: {
        available: false,         // flip to true once Settlement model exists
        settledAmount: null,
        settlementBatches: [],
        note: "Connect Cashfree Settlement API or webhook to populate actual data. Expected vs actual variance will show here.",
      },
      variance: {
        amount: null,             // expectedSettlement - cashfreeActual.settledAmount
        status: "pending_integration",
      },
    });

  } catch (err) {
    console.error("CA cashfree-recon error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── ROUTE: List Settlements ──────────────────────────────────────────────────
// GET /api/accountant/settlements?from=YYYY-MM-DD&to=YYYY-MM-DD&cursor=...
router.get("/settlements", caMiddleware, async (req, res) => {
  try {
    const { from, to, cursor, limit = "20" } = req.query;

    // Build Cashfree query
    const params = new URLSearchParams({ count: String(Math.min(Number(limit), 200)) });
    if (cursor) params.append("cursor", cursor);

    // If date range provided, use the /settlements endpoint with pagination
    const cfUrl = `${CFBASE}/settlements?${params.toString()}`;
    const cfRes = await axios.get(cfUrl, { headers: CF_HEADERS });

    const settlements = cfRes.data?.data || [];

    // Filter by date range client-side if provided (Cashfree doesn't filter by date on this endpoint)
    const filtered = from && to
      ? settlements.filter(s => {
          const raw = s.settlementdate || s.createdat;
          if (!raw) return false;
          // Compare just the date string prefix (YYYY-MM-DD) to avoid TZ issues
          const dateStr = raw.substring(0, 10); // "2026-07-15"
          return dateStr >= from.toISOString().substring(0, 10) && 
                dateStr <= to.toISOString().substring(0, 10);
        })
      : settlements;

    // Aggregate totals for this page
    const totals = filtered.reduce((acc, s) => ({
      totalSettled:  acc.totalSettled  + (s.settlement_amount || 0),
      totalOrders:   acc.totalOrders   + (s.cf_count          || 0),
      totalCharges:  acc.totalCharges  + (s.service_charge    || 0) + (s.service_tax || 0),
    }), { totalSettled: 0, totalOrders: 0, totalCharges: 0 });

    // Cross-reference with your Receipt collection using order IDs from Cashfree settlements
    // (shallow ref — full drill-down is per /settlements/:id/orders)
    const settledOrderIds = [];
    filtered.forEach(s => { if (s.cf_id) settledOrderIds.push(s.cf_id); });

    res.json({
      settlements: filtered,
      cursor: cfRes.data?.cursor || null,
      totals,
    });

  } catch (err) {
    console.error("CF settlements fetch error:", err?.response?.data || err.message);
    res.status(500).json({
      error: err?.response?.data?.message || "Failed to fetch settlements from Cashfree"
    });
  }
});

// ─── ROUTE: Settlement Orders (drill-down) ────────────────────────────────────
// GET /api/accountant/settlements/:settlementId/orders?cursor=...
router.get("/settlements/:settlementId/orders", caMiddleware, async (req, res) => {
  try {
    const { settlementId } = req.params;
    const { cursor, limit = "50" } = req.query;

    const params = new URLSearchParams({ count: String(Math.min(Number(limit), 200)) });
    if (cursor) params.append("cursor", cursor);

    const cfUrl = `${CF_BASE}/settlements/recon?${params.toString()}`;

    // Cashfree's settlement recon endpoint
    const cfRes = await axios.post(
      `${CF_BASE}/settlements/recon`,
      { pagination: { limit: Number(limit), cursor: cursor || null }, filters: { cf_settlement_id: Number(settlementId) } },
      { headers: CF_HEADERS }
    );

    const orders = cfRes.data?.data || [];

    // Cross-reference with your Receipts/Payments in MongoDB
    const cfOrderIds = orders.map(o => o.order_id).filter(Boolean);
    const [receipts, payments] = await Promise.all([
      Receipt.find({ cashfreeOrderId: { $in: cfOrderIds } }).select("receiptId totalAmount gstAmount paymentGateway createdAt userName").lean(),
      Payment.find({ cfOrderId: { $in: cfOrderIds } }).select("cfOrderId cfPaymentId amount status createdAt type").lean(),
    ]);

    const receiptMap = {};
    receipts.forEach(r => { receiptMap[r.cashfreeOrderId] = r; });
    const paymentMap = {};
    payments.forEach(p => { paymentMap[p.cfOrderId] = p; });

    // Enrich orders with your DB data
    const enriched = orders.map(o => ({
      ...o,
      _receipt: receiptMap[o.order_id] || null,
      _payment: paymentMap[o.order_id] || null,
    }));

    // Recon summary
    const cfTotal    = orders.reduce((s, o) => s + (o.order_amount || 0), 0);
    const localTotal = receipts.reduce((s, r) => s + (r.totalAmount || 0), 0);
    const diffAmount = +(cfTotal - localTotal).toFixed(2);
    const matchedCount = orders.filter(o => receiptMap[o.order_id]).length;

    res.json({
      settlementId,
      orders: enriched,
      cursor: cfRes.data?.cursor || null,
      recon: {
        cfOrderCount:    orders.length,
        localMatchCount: matchedCount,
        unmatchedCount:  orders.length - matchedCount,
        cfTotalAmount:   +cfTotal.toFixed(2),
        localTotalAmount: +localTotal.toFixed(2),
        diffAmount,
        isBalanced: diffAmount === 0,
      },
    });

  } catch (err) {
    console.error("CF settlement orders error:", err?.response?.data || err.message);
    res.status(500).json({
      error: err?.response?.data?.message || "Failed to fetch settlement orders"
    });
  }
});

// ─── ROUTE: Settlement Recon Summary (for CA dashboard) ───────────────────────
// GET /api/accountant/settlements/summary?period=month
router.get("/settlements/summary", caMiddleware, async (req, res) => {
  try {
    const { from, to, label } = buildDateRange(req.query);

    // Fetch settlements from Cashfree for the period
    // Use multiple pages if needed
    let allSettlements = [];
    let cursor = null;
    let pageCount = 0;

    do {
      const params = new URLSearchParams({ count: "200" });
      if (cursor) params.append("cursor", cursor);
      const cfRes = await axios.get(`${CF_BASE}/settlements?${params.toString()}`, { headers: CF_HEADERS });
      const page  = cfRes.data?.data || [];
      cursor      = cfRes.data?.cursor || null;

      // Filter to period
      const inRange = page.filter(s => {
        const d = new Date(s.settlement_date || s.created_at);
        return d >= from && d <= to;
      });
      allSettlements = allSettlements.concat(inRange);

      // Stop if we've gone past the from date (settlements are sorted desc)
      const oldest = page[page.length - 1];
      if (oldest && new Date(oldest.settlement_date || oldest.created_at) < from) break;
      pageCount++;
    } while (cursor && pageCount < 10);

    // Your Receipt totals for same period (for recon)
    const receiptAgg = await Receipt.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, paymentGateway: "cashfree" } },
      { $group: {
        _id: null,
        totalBilled:     { $sum: "$totalAmount" },
        totalPgCharges:  { $sum: { $ifNull: ["$paymentCharges", 0] } },
        totalRefunds:    { $sum: { $ifNull: ["$refundAmount", 0] } },
        count: { $sum: 1 },
      }}
    ]);

    const cfTotal     = allSettlements.reduce((s, x) => s + (x.settlement_amount || 0), 0);
    const cfCharges   = allSettlements.reduce((s, x) => s + (x.service_charge || 0) + (x.service_tax || 0), 0);
    const cfOrders    = allSettlements.reduce((s, x) => s + (x.cf_count || 0), 0);
    const rec         = receiptAgg[0] || {};
    const netExpected = (rec.totalBilled || 0) - (rec.totalPgCharges || 0) - (rec.totalRefunds || 0);
    const diffAmount  = +(cfTotal - netExpected).toFixed(2);

    res.json({
      period: { from, to, label },
      cf: {
        settlementCount: allSettlements.length,
        totalSettled:    +cfTotal.toFixed(2),
        totalCharges:    +cfCharges.toFixed(2),
        totalOrders:     cfOrders,
      },
      local: {
        cashfreeInvoices: rec.count || 0,
        totalBilled:      +(rec.totalBilled || 0).toFixed(2),
        totalPgCharges:   +(rec.totalPgCharges || 0).toFixed(2),
        totalRefunds:     +(rec.totalRefunds || 0).toFixed(2),
        netExpected:      +netExpected.toFixed(2),
      },
      recon: {
        diffAmount,
        isBalanced:  diffAmount === 0,
        withinTolerance: Math.abs(diffAmount) < 1,
      },
      settlements: allSettlements.slice(0, 10), // latest 10 for preview
    });

  } catch (err) {
    console.error("CF settlement summary error:", err?.response?.data || err.message);
    res.status(500).json({
      error: err?.response?.data?.message || "Failed to fetch settlement summary"
    });
  }
});

// ─── ROUTE: List projects for CA filter dropdown ────────────────────────────
router.get("/projects", caMiddleware, async (req, res) => {
  try {
    // Project model — adjust import at top of file if needed
    const Device = require('../models/device');
    const projects = await Project.find({}, "_id name location")
      .sort({ name: 1 })
      .lean();
    res.json({ projects });
  } catch (err) {
    console.error("CA projects list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;