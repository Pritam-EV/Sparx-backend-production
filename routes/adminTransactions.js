// routes/adminTransactions.js
const express            = require("express");
const router             = express.Router();
const authMiddleware     = require("../middleware/authMiddleware");
const WalletTransaction  = require("../models/WalletTransaction");
const Payment            = require("../models/Payment");
const User               = require("../models/User");

// ─── Admin guard ──────────────────────────────────────────────────────────────
async function adminOnly(req, res, next) {
  try {
    if (req.user?.role === "admin") return next();
    const u = await User.findById(req.user.userId).select("role").lean();
    if (u?.role === "admin") return next();
    return res.status(403).json({ message: "Forbidden" });
  } catch (e) {
    return res.status(500).json({ message: "Server error" });
  }
}

// ─── GET /api/admin/transactions ──────────────────────────────────────────────
// Query params:
//   tab        : "all" | "topup" | "charging" | "refund"   (default: "all")
//   search     : free-text on userName / mobile / orderId
//   page       : number (default 1)
//   limit      : number (default 30, max 100)
//   startDate  : ISO date string
//   endDate    : ISO date string
router.get("/", authMiddleware, adminOnly, async (req, res) => {
  try {
    const {
      tab       = "all",
      search    = "",
      page      = 1,
      limit     = 30,
      startDate,
      endDate,
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip     = (pageNum - 1) * limitNum;

    // ── Date filter ──────────────────────────────────────────────────────────
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate)   dateFilter.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
    const dateQ = Object.keys(dateFilter).length ? { createdAt: dateFilter } : {};

    // ── 1. WalletTransaction type filter per tab ──────────────────────────────
    const walletTypeFilter = (() => {
      if (tab === "topup")    return { type: "topup" };
      if (tab === "charging") return { type: "debit" };
      if (tab === "refund")   return { type: { $in: ["refund", "refund_bank", "admin_credit", "admin_debit"] } };
      return {};
    })();

    const walletDocs = await WalletTransaction
      .find({ ...walletTypeFilter, ...dateQ })
      .sort({ createdAt: -1 })
      .lean();

    // ── 2. Payment records (no PENDING) ──────────────────────────────────────
    let paymentDocs = [];
    if (tab !== "refund") {
      const paymentTypeFilter = (() => {
        if (tab === "topup")    return { type: "wallet_topup" };
        if (tab === "charging") return { type: "charging" };
        return {};
      })();
      paymentDocs = await Payment
        .find({ status: { $ne: "PENDING" }, ...paymentTypeFilter, ...dateQ })
        .sort({ createdAt: -1 })
        .lean();
    }

    // ── 3. Hydrate user names ─────────────────────────────────────────────────
    const userIdSet = new Set([
      ...walletDocs.map(d => d.userId?.toString()),
      ...paymentDocs.map(d => d.userId?.toString()),
    ].filter(Boolean));

    const userList = await User
      .find({ _id: { $in: [...userIdSet] } })
      .select("name mobile")
      .lean();

    const userMap = {};
    for (const u of userList) userMap[u._id.toString()] = { name: u.name, mobile: u.mobile };

    // ── 4. Normalise WalletTransaction ────────────────────────────────────────
    const normWallet = walletDocs.map(d => {
      const uid  = d.userId?.toString();
      const user = userMap[uid] || { name: "Unknown", mobile: "—" };

      let category, subType;
      switch (d.type) {
        case "topup":        category = "topup";    subType = "Wallet Top-up";    break;
        case "debit":        category = "charging"; subType = "Charging Session"; break;
        case "refund":       category = "refund";   subType = "Refund → Wallet";  break;
        case "refund_bank":  category = "refund";   subType = "Refund → Bank";    break;
        case "admin_credit": category = "refund";   subType = "Admin Credit";     break;
        case "admin_debit":  category = "charging"; subType = "Admin Debit";      break;
        default:             category = "other";    subType = d.type;
      }

      return {
        _id: d._id, source: "wallet", category, subType,
        status: "SUCCESS",
        amount: d.amount,
        orderId: d.orderId || null,
        sessionId: d.sessionId || null,
        description: d.description || null,
        balanceBefore: d.balanceBefore,
        balanceAfter:  d.balanceAfter,
        initiatedBy:  d.initiatedBy,
        userId: uid, userName: user.name, userMobile: user.mobile,
        createdAt: d.createdAt,
      };
    });

    // ── 5. Normalise Payment ──────────────────────────────────────────────────
    const normPayment = paymentDocs.map(d => {
      const uid  = d.userId?.toString();
      const user = userMap[uid] || { name: "Unknown", mobile: "—" };
      const category = d.type === "wallet_topup" ? "topup" : "charging";
      const subType  = d.type === "wallet_topup"
        ? (d.gateway === "cashfree" ? "Wallet Top-up (Cashfree)" : "Wallet Top-up")
        : (d.gateway === "wallet"   ? "Charging (Wallet)" : "Charging (Cashfree)");

      return {
        _id: d._id, source: "payment", category, subType,
        status: d.status,
        amount: d.amountPaid,
        orderId: d.orderId || null,
        sessionId: d.sessionId || null,
        deviceId: d.deviceId || null,
        gateway: d.gateway,
        paymentMethod: d.paymentMethod || null,
        bankReference: d.bankReference || null,
        cfPaymentId:   d.cfPaymentId   || null,
        failureReason: d.failureReason || null,
        paidAt: d.paidAt || null,
        userId: uid, userName: user.name, userMobile: user.mobile,
        createdAt: d.createdAt,
      };
    });

    // ── 6. De-duplicate: wallet topup + payment topup share orderId — keep wallet ──
    const walletOrderIds = new Set(normWallet.map(d => d.orderId).filter(Boolean));
    const dedupedPayments = normPayment.filter(
      d => !(d.orderId && walletOrderIds.has(d.orderId) && d.category === "topup")
    );

    // ── 7. Merge + sort ───────────────────────────────────────────────────────
    let merged = [...normWallet, ...dedupedPayments]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // ── 8. Search ─────────────────────────────────────────────────────────────
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      merged = merged.filter(d =>
        (d.userName   || "").toLowerCase().includes(q) ||
        (d.userMobile || "").toLowerCase().includes(q) ||
        (d.orderId    || "").toLowerCase().includes(q) ||
        (d.sessionId  || "").toLowerCase().includes(q) ||
        (d.subType    || "").toLowerCase().includes(q)
      );
    }

    // ── 9. Paginate ───────────────────────────────────────────────────────────
    const total     = merged.length;
    const paginated = merged.slice(skip, skip + limitNum);

    // ── 10. Summary stats ─────────────────────────────────────────────────────
    const summary = {
      total,
      totalAmount:  merged.filter(d => d.status === "SUCCESS").reduce((s, d) => s + (d.amount || 0), 0),
      successCount: merged.filter(d => d.status === "SUCCESS").length,
      failedCount:  merged.filter(d => d.status === "FAILED").length,
      refundWallet: merged.filter(d => d.subType === "Refund → Wallet").length,
      refundBank:   merged.filter(d => d.subType === "Refund → Bank").length,
    };

    return res.json({
      success: true, page: pageNum, limit: limitNum,
      totalCount: total, totalPages: Math.ceil(total / limitNum),
      summary, transactions: paginated,
    });
  } catch (err) {
    console.error("Admin transactions error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;