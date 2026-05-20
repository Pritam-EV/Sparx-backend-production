// routes/adminTransactions.js
const express            = require("express");
const router             = express.Router();
const authMiddleware     = require("../middleware/authMiddleware");
const WalletTransaction  = require("../models/WalletTransaction");
const Payment            = require("../models/Payment");
const Refund             = require("../models/Refund");
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

// ─── GET /api/admin/transactions ─────────────────────────────────────────────
// Query params:
//   tab        : "all" | "topup" | "charging" | "refund"   (default: "all")
//   search     : free-text on userName / mobile / orderId / refundId
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

    // ────────────────────────────────────────────────────────────────────────
    // 1. WalletTransaction — for topup / debit / admin_credit / admin_debit
    //    NOTE: we NO LONGER pull refund / refund_bank from here in the refund tab
    //          because Refund collection is now the source of truth for refunds.
    //          We still pull them for "all" tab so nothing disappears for legacy data.
    // ────────────────────────────────────────────────────────────────────────
    const walletTypeFilter = (() => {
      if (tab === "topup")    return { type: "topup" };
      if (tab === "charging") return { type: { $in: ["debit", "admin_debit"] } };
      if (tab === "refund")   return null; // refund tab uses Refund collection only
      // "all" — include everything except refund/refund_bank (those come from Refund collection)
      return { type: { $in: ["topup", "debit", "admin_credit", "admin_debit"] } };
    })();

    let walletDocs = [];
    if (walletTypeFilter !== null) {
      walletDocs = await WalletTransaction
        .find({ ...walletTypeFilter, ...dateQ })
        .sort({ createdAt: -1 })
        .lean();
    }

    // ────────────────────────────────────────────────────────────────────────
    // 2. Payment records (exclude PENDING always)
    // ────────────────────────────────────────────────────────────────────────
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

    // ────────────────────────────────────────────────────────────────────────
    // 3. Refund collection — for both "refund" tab and "all" tab
    //    This is the single source of truth for ALL refunds (wallet + bank)
    // ────────────────────────────────────────────────────────────────────────
    let refundDocs = [];
    if (tab === "refund" || tab === "all") {
      refundDocs = await Refund
        .find({ ...dateQ })
        .sort({ createdAt: -1 })
        .lean();
    }

    // ────────────────────────────────────────────────────────────────────────
    // 4. Hydrate user names for all three sources
    // ────────────────────────────────────────────────────────────────────────
    const userIdSet = new Set([
      ...walletDocs.map(d => d.userId?.toString()),
      ...paymentDocs.map(d => d.userId?.toString()),
      ...refundDocs.map(d => d.userId?.toString()),
    ].filter(Boolean));

    const userList = await User
      .find({ _id: { $in: [...userIdSet] } })
      .select("name mobile")
      .lean();

    const userMap = {};
    for (const u of userList) userMap[u._id.toString()] = { name: u.name, mobile: u.mobile };

    // ────────────────────────────────────────────────────────────────────────
    // 5. Normalise WalletTransaction docs
    // ────────────────────────────────────────────────────────────────────────
    const normWallet = walletDocs.map(d => {
      const uid  = d.userId?.toString();
      const user = userMap[uid] || { name: "Unknown", mobile: "—" };

      let category, subType;
      switch (d.type) {
        case "topup":        category = "topup";    subType = "Wallet Top-up";    break;
        case "debit":        category = "charging"; subType = "Charging Session"; break;
        case "admin_credit": category = "refund";   subType = "Admin Credit";     break;
        case "admin_debit":  category = "charging"; subType = "Admin Debit";      break;
        default:             category = "other";    subType = d.type;
      }

      return {
        _id:           d._id,
        source:        "wallet",
        category,
        subType,
        status:        "SUCCESS",
        amount:        d.amount,
        orderId:       d.orderId   || null,
        sessionId:     d.sessionId || null,
        description:   d.description || null,
        balanceBefore: d.balanceBefore,
        balanceAfter:  d.balanceAfter,
        initiatedBy:   d.initiatedBy,
        userId:        uid,
        userName:      user.name,
        userMobile:    user.mobile,
        createdAt:     d.createdAt,
      };
    });

    // ────────────────────────────────────────────────────────────────────────
    // 6. Normalise Payment docs
    // ────────────────────────────────────────────────────────────────────────
    const normPayment = paymentDocs.map(d => {
      const uid  = d.userId?.toString();
      const user = userMap[uid] || { name: "Unknown", mobile: "—" };
      const category = d.type === "wallet_topup" ? "topup" : "charging";
      const subType  = d.type === "wallet_topup"
        ? (d.gateway === "cashfree" ? "Wallet Top-up (Cashfree)" : "Wallet Top-up")
        : (d.gateway === "wallet"   ? "Charging (Wallet)"        : "Charging (Cashfree)");

      return {
        _id:           d._id,
        source:        "payment",
        category,
        subType,
        status:        d.status,
        amount:        d.amountPaid,
        orderId:       d.orderId       || null,
        sessionId:     d.sessionId     || null,
        deviceId:      d.deviceId      || null,
        gateway:       d.gateway,
        paymentMethod: d.paymentMethod || null,
        bankReference: d.bankReference || null,
        cfPaymentId:   d.cfPaymentId   || null,
        failureReason: d.failureReason || null,
        paidAt:        d.paidAt        || null,
        userId:        uid,
        userName:      user.name,
        userMobile:    user.mobile,
        createdAt:     d.createdAt,
      };
    });

    // ────────────────────────────────────────────────────────────────────────
    // 7. Normalise Refund docs — the key new section
    // ────────────────────────────────────────────────────────────────────────
    const normRefunds = refundDocs.map(d => {
      const uid  = d.userId?.toString();
      const user = userMap[uid] || { name: "Unknown", mobile: "—" };

      // subType drives the badge colour in the frontend
      const subType = (() => {
        if (d.destination === "wallet") return "Refund → Wallet";
        if (d.refundType  === "PARTIAL") return "Partial Refund → Bank";
        return "Refund → Bank";
      })();

      return {
        _id:               d._id,
        source:            "refund",           // distinct source for drawer logic
        category:          "refund",
        subType,
        status:            d.status,           // INITIATED/PENDING/SUCCESS/CANCELLED/ONHOLD/FAILED
        amount:            d.refundAmount,
        orderId:           d.orderId    || null,
        sessionId:         d.sessionId  || null,
        refundId:          d.refundId,         // your internal refund ID
        cfRefundId:        d.cfRefundId || null, // Cashfree's refund ID
        arnNumber:         d.arnNumber  || null, // bank ARN — proof of settlement
        refundNote:        d.refundNote || null,
        refundType:        d.refundType,        // FULL / PARTIAL
        destination:       d.destination,       // wallet / bank
        statusDescription: d.statusDescription || null,
        initiatedBy:       d.initiatedBy,
        initiatedAt:       d.initiatedAt,
        processedAt:       d.processedAt || null,
        userId:            uid,
        userName:          user.name,
        userMobile:        user.mobile,
        createdAt:         d.createdAt,
      };
    });

    // ────────────────────────────────────────────────────────────────────────
    // 8. De-duplicate: wallet topup + payment topup share orderId — keep wallet
    // ────────────────────────────────────────────────────────────────────────
    const walletOrderIds = new Set(normWallet.map(d => d.orderId).filter(Boolean));
    const dedupedPayments = normPayment.filter(
      d => !(d.orderId && walletOrderIds.has(d.orderId) && d.category === "topup")
    );

    // ────────────────────────────────────────────────────────────────────────
    // 9. Merge all three sources and sort by date
    // ────────────────────────────────────────────────────────────────────────
    let merged = [...normWallet, ...dedupedPayments, ...normRefunds]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // ────────────────────────────────────────────────────────────────────────
    // 10. Search filter
    // ────────────────────────────────────────────────────────────────────────
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      merged = merged.filter(d =>
        (d.userName     || "").toLowerCase().includes(q) ||
        (d.userMobile   || "").toLowerCase().includes(q) ||
        (d.orderId      || "").toLowerCase().includes(q) ||
        (d.sessionId    || "").toLowerCase().includes(q) ||
        (d.refundId     || "").toLowerCase().includes(q) ||
        (d.cfRefundId   || "").toLowerCase().includes(q) ||
        (d.subType      || "").toLowerCase().includes(q)
      );
    }

    // ────────────────────────────────────────────────────────────────────────
    // 11. Paginate
    // ────────────────────────────────────────────────────────────────────────
    const total     = merged.length;
    const paginated = merged.slice(skip, skip + limitNum);

    // ────────────────────────────────────────────────────────────────────────
    // 12. Summary stats (for KPI strip on frontend)
    // ────────────────────────────────────────────────────────────────────────
    const summary = {
      total,
      totalAmount:    merged.filter(d => d.status === "SUCCESS").reduce((s, d) => s + (d.amount || 0), 0),
      successCount:   merged.filter(d => d.status === "SUCCESS").length,
      failedCount:    merged.filter(d => d.status === "FAILED").length,
      // Refund-specific KPIs
      refundWallet:   normRefunds.filter(d => d.destination === "wallet").length,
      refundBank:     normRefunds.filter(d => d.destination === "bank").length,
      refundPending:  normRefunds.filter(d => d.status === "PENDING" || d.status === "INITIATED").length,
      refundOnHold:   normRefunds.filter(d => d.status === "ONHOLD").length,
    };

    return res.json({
      success:     true,
      page:        pageNum,
      limit:       limitNum,
      totalCount:  total,
      totalPages:  Math.ceil(total / limitNum),
      summary,
      transactions: paginated,
    });

  } catch (err) {
    console.error("Admin transactions error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;