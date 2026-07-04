// routes/payment.js
const express  = require("express");
const axios    = require("axios");
const { v4: uuidv4 } = require("uuid");
const crypto   = require("crypto");
const router   = express.Router();

const Payment           = require("../models/Payment");
const User              = require("../models/User");
const Refund            = require("../models/Refund");
const WalletTransaction = require("../models/WalletTransaction");
const Wallet            = require("../models/Wallet");
const authMiddleware    = require("../middleware/authMiddleware");
const { creditWallet }  = require("../services/walletService");

const CASHFREE_BASE_URL =
  process.env.CASHFREE_ENV === "PROD"
    ? "https://api.cashfree.com"
    : "https://sandbox.cashfree.com";

// ─── Admin guard helper ───────────────────────────────────────────────────────
async function adminOnly(req, res, next) {
  try {
    if (req.user?.role === "admin") return next();
    const u = await User.findById(req.user.userId).select("role").lean();
    if (u?.role === "admin") return next();
    return res.status(403).json({ message: "Forbidden — admins only" });
  } catch (e) {
    return res.status(500).json({ message: "Server error" });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// EXISTING ROUTES — unchanged
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/payment/order
router.post("/order", authMiddleware, async (req, res) => {
  try {
    const { amount, deviceId } = req.body;

    if (!amount) {
      return res.status(400).json({ success: false, message: "Amount is required" });
    }

    const orderId   = `order_${uuidv4()}`;
    const returnUrl =
      req.body.returnUrl ||
      `${process.env.CLIENT_URL}/payment-success?order_id={order_id}`;

    const user = await User.findById(req.user.userId, { name: 1, mobile: 1 }, { lean: true }).exec();

    const payload = {
      order_id:       orderId,
      order_amount:   Number(amount),
      order_currency: "INR",
      customer_details: {
        customer_id:    req.user.userId,
        customer_name:  user.name,
        customer_email: "vjratechnologies@gmail.com",
        customer_phone: user.mobile,
      },
      order_meta: {
        return_url:      returnUrl,
        payment_methods: "cc,dc,nb,upi",
      },
    };

    const response = await axios.post(`${CASHFREE_BASE_URL}/pg/orders`, payload, {
      headers: {
        "Content-Type":    "application/json",
        "x-client-id":     process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version":   "2023-08-01",
      },
    });

    // console.log("🌍 Cashfree BASE:", CASHFREE_BASE_URL, "🔑 Cashfree ENV:", process.env.CASHFREE_ENV);

    await Payment.create({
      orderId,
      userId:    req.user?.userId,
      deviceId,
      amountPaid: Number(amount),
      currency:  "INR",
      status:    "PENDING",
      gateway:   "cashfree",
      rawResponse: response.data,
    });

    // console.log("✅ Cashfree order created:", {
    //   orderId,
    //   cfOrderId:        response.data.order_id,
    //   paymentSessionId: response.data.payment_session_id,
    // });

    return res.status(200).json({
      success:          true,
      order:            response.data,
      paymentSessionId: response.data?.payment_session_id,
    });
  } catch (error) {
    console.error("Cashfree order creation failed:", error?.response?.data || error.message);
    return res.status(500).json({ success: false, message: "Cashfree order creation failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/webhook
// Handles: PAYMENT_SUCCESS, PAYMENT_FAILED  (existing)
//          REFUND_STATUS_WEBHOOOK            (new — note Cashfree's typo is intentional)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"];

    if (!signature || !req.rawBody) {
      console.error("❌ Missing webhook signature or raw body");
      return res.status(400).send("Invalid webhook");
    }

const timestamp = req.headers["x-webhook-timestamp"];

const expectedSignature = crypto
  .createHmac("sha256", process.env.CASHFREE_SECRET_KEY)
  .update(timestamp + req.rawBody)   // ← this is the fix
  .digest("base64");

    if (signature !== expectedSignature) {
      console.error("❌ Invalid Cashfree webhook signature");
      return res.status(401).send("Invalid signature");
    }

    const event = req.body;

    // ── PAYMENT_SUCCESS (existing logic — unchanged) ──────────────────────────
    if (event.type === "PAYMENT_SUCCESS") {
      const orderId = event.data.order.order_id;
      const payment = event.data.payment;

      // console.log("✅ Cashfree payment success:", orderId);

      await Payment.updateOne(
        { orderId, status: { $ne: "SUCCESS" } },
        {
          $set: {
            status:        "SUCCESS",
            paymentMethod: payment.payment_method,
            paymentGroup:  payment.payment_group,
            cfPaymentId:   payment.cf_payment_id,
            bankReference: payment.bank_reference || null,
            paidAt:        new Date(payment.payment_time),
            rawResponse:   event,
          },
        }
      );

      // Wallet topup credit (existing logic — unchanged)
      if (orderId.startsWith("wlt_") && !orderId.startsWith("wlt_pay_")) {
        const pmt = await Payment.findOne({ orderId });
        if (pmt && pmt.status !== "WALLET_CREDITED") {
          try {
            await creditWallet({
              userId:        pmt.userId.toString(),
              amount:        pmt.amountPaid,
              type:          "topup",
              orderId,
              description:   "Wallet topup via Cashfree webhook",
              idempotencyKey: `topup_${orderId}`,
            });
            await Payment.updateOne({ orderId }, { $set: { status: "SUCCESS" } });
          } catch (e) {
            console.error("Webhook wallet credit failed:", e.message);
          }
        }
      }
    }

    // ── PAYMENT_FAILED (existing logic — unchanged) ───────────────────────────
    if (event.type === "PAYMENT_FAILED") {
      const orderId = event.data.order.order_id;
      // console.log("❌ Cashfree payment failed:", orderId);

      await Payment.updateOne(
        { orderId },
        {
          $set: {
            status:        "FAILED",
            failureReason: event.data.payment?.payment_message || null,
            rawResponse:   event,
          },
        }
      );
    }

    // ── REFUND_STATUS_WEBHOOOK (new) ─────────────────────────────────────────
    // Cashfree fires this for every refund status change:
    // PENDING → SUCCESS (money sent to bank, arnNumber available)
    // PENDING → CANCELLED / ONHOLD
    if (event.type === "REFUND_STATUS_WEBHOOK") {
      const r           = event.data.refund;
      const cfRefundId  = r.cf_refund_id;
      const newStatus   = r.refund_status; // "PENDING" | "SUCCESS" | "CANCELLED" | "ONHOLD"

      const statusMap = {
        PENDING:   "PENDING",
        SUCCESS:   "SUCCESS",
        CANCELLED: "CANCELLED",
        ONHOLD:    "ONHOLD",
      };

      const updateFields = {
        status:            statusMap[newStatus] || "PENDING",
        statusDescription: r.status_description || null,
        rawResponse:       event,
      };

      // On SUCCESS — save the ARN (bank proof) and processedAt timestamp
      if (newStatus === "SUCCESS") {
        updateFields.arnNumber   = r.refund_arn || null;
        updateFields.processedAt = new Date();
      }

      const updated = await Refund.findOneAndUpdate(
        { cfRefundId },
        { $set: updateFields },
        { new: true }
      );

      if (updated) {
        // console.log(`🔄 Refund ${cfRefundId} → ${newStatus}${newStatus === "SUCCESS" ? ` | ARN: ${r.refund_arn}` : ""}`);
      } else {
        // cfRefundId not found — could be the very first webhook before we stored it
        // Try matching by refundId in case cf_refund_id wasn't set at creation time
        console.warn(`⚠️ Refund not found for cfRefundId: ${cfRefundId}`);
      }
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("Webhook error");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payment/verify  (existing — unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/verify", async (req, res) => {
  try {
    const { orderId } = req.query;

    if (!orderId) {
      return res.status(400).json({ success: false, message: "Order ID missing" });
    }

    // FREE / ZERO PAYMENT — skip verification
    if (orderId?.startsWith("FREE_")) {
      await Payment.updateOne(
        { orderId },
        { $set: { status: "SUCCESS", gateway: "free", paymentMethod: "free", paidAt: new Date() } },
        { upsert: true }
      );
      return res.json({ success: true, status: "successful", gateway: "free" });
    }

    // console.log("🔍 Verifying payment for:", orderId);

    const payment = await Payment.findOne({ orderId });

    if (!payment) {
      console.warn("⚠️ Payment not found for:", orderId);
      const response = await axios.get(`${CASHFREE_BASE_URL}/pg/orders/${orderId}`, {
        headers: {
          "x-client-id":     process.env.CASHFREE_APP_ID,
          "x-client-secret": process.env.CASHFREE_SECRET_KEY,
          "x-api-version":   "2023-08-01",
        },
      });
      return res.status(response.status).json({
        success: true,
        message: response.data?.message,
        status:  response.data?.order_status
          ? (response.data.order_status === "PAID"
              ? "successful"
              : response.data.order_status === "TERMINATED"
              ? "cancelled"
              : response.data.order_status === "TERMINATION_REQUESTED"
              ? "pending"
              : "failed")
          : "failed",
      });
    }

    if (payment.status === "SUCCESS") {
      return res.json({ success: true, status: "successful", payment });
    }

    if (payment.status === "PENDING") {
      // console.log("⏳ Payment pending in DB, checking Cashfree...");
      const response = await axios.get(`${CASHFREE_BASE_URL}/pg/orders/${orderId}`, {
        headers: {
          "x-client-id":     process.env.CASHFREE_APP_ID,
          "x-client-secret": process.env.CASHFREE_SECRET_KEY,
          "x-api-version":   "2023-08-01",
        },
      });

      const orderStatus = response.data?.order_status;
      // console.log("🔍 Cashfree order status:", orderStatus);

      if (orderStatus === "PAID") {
        await Payment.updateOne(
          { orderId },
          { $set: { status: "SUCCESS", paidAt: new Date(), rawResponse: response.data } }
        );
        return res.json({ success: true, status: "successful" });
      }

      if (orderStatus === "FAILED" || orderStatus === "CANCELLED") {
        await Payment.updateOne(
          { orderId },
          { $set: { status: "FAILED", rawResponse: response.data } }
        );
        return res.status(400).json({ success: false, message: "Payment failed" });
      }

      return res.status(202).json({ success: false, message: "Payment pending" });
    }
  } catch (err) {
    console.error("❌ Verify route crashed:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payment/my-transactions  (existing — unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/my-transactions", authMiddleware, async (req, res) => {
  try {
    const userId  = req.user.userId;
    const Receipt = require("../models/Receipt");

    const payments = await Payment.find({
      userId,
      type: { $ne: "wallet_topup" },
    })
      .sort({ createdAt: -1 }).limit(100)
      .select("orderId sessionId deviceId amountPaid currency status paymentMethod paymentGroup cfPaymentId bankReference failureReason paidAt createdAt gateway type")
      .lean();

    const orderIds = payments.map(p => p.orderId).filter(Boolean);

    const receipts = await Receipt.find({
      transactionId: { $in: orderIds },
      userId,
      "refund.status": { $in: ["initiated", "processed", "failed"] },
    }, {
      transactionId: 1, receiptId: 1, amountPaid: 1, refundAmount: 1,
      "refund.status": 1, "refund.refundId": 1, "refund.failureReason": 1,
      "refund.processedAt": 1, createdAt: 1,
    }).lean();

    const refundEntries = receipts.map(r => ({
      _id:                `refund_${r._id}`,
      orderId:            r.transactionId,
      amountPaid:         r.refundAmount ?? r.amountPaid ?? 0,
      status:             "REFUND",
      refundId:           r.refund?.refundId || null,
      refundStatus:       r.refund?.status,
      refundFailureReason: r.refund?.failureReason || null,
      paidAt:             r.refund?.processedAt || r.createdAt,
      createdAt:          r.refund?.processedAt || r.createdAt,
      isRefundEntry:      true,
    }));

    const walletTxns = await WalletTransaction.find({
      userId,
      type: { $in: ["topup", "refund", "admin_credit"] },
    })
      .sort({ createdAt: -1 }).limit(100)
      .select("type amount description orderId sessionId idempotencyKey createdAt")
      .lean();

    const walletEntries = walletTxns.map(w => ({
      _id:           `wallet_${w._id}`,
      orderId:       w.orderId || w.idempotencyKey || `wallet_${w._id}`,
      amountPaid:    w.amount,
      status:        w.type === "topup" ? "TOPUP" : "WALLET_REFUND",
      walletTxnType: w.type,
      description:   w.description || "",
      paidAt:        w.createdAt,
      createdAt:     w.createdAt,
      isWalletEntry: true,
    }));

    const taggedPayments = payments.map(p => ({
      ...p,
      txnSource: p.gateway === "wallet" ? "wallet_pay" : "gateway",
    }));

    const allTransactions = [...taggedPayments, ...refundEntries, ...walletEntries]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({ success: true, transactions: allTransactions });
  } catch (err) {
    console.error("❌ Error fetching transactions:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// NEW ROUTE — POST /api/payment/refund
// Admin initiates a refund — either to wallet (instant) or bank (via Cashfree)
// Body: { orderId, refundAmount, refundNote, destination: "wallet"|"bank" }
// ═════════════════════════════════════════════════════════════════════════════
router.post("/refund", authMiddleware, adminOnly, async (req, res) => {
  try {
    const {
      orderId,
      refundAmount,
      refundNote  = "Admin refund",
      destination = "bank",
    } = req.body;

    if (!orderId || !refundAmount) {
      return res.status(400).json({ success: false, message: "orderId and refundAmount are required" });
    }

    const amount = Number(refundAmount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid refund amount" });
    }

    // ── Find the original successful payment ───────────────────────────────────
    const payment = await Payment.findOne({ orderId, status: "SUCCESS" });
    if (!payment) {
      return res.status(404).json({ success: false, message: "Original successful payment not found for this orderId" });
    }

    if (amount > payment.amountPaid) {
      return res.status(400).json({ success: false, message: `Refund amount ₹${amount} exceeds original payment ₹${payment.amountPaid}` });
    }

    // ── Check if a full refund was already issued for this order ───────────────
    const existingFullRefund = await Refund.findOne({
      orderId,
      refundType: "FULL",
      status:     { $in: ["PENDING", "SUCCESS", "INITIATED"] },
    });
    if (existingFullRefund) {
      return res.status(400).json({ success: false, message: "A full refund already exists for this order" });
    }

    const refundId   = `refund_${uuidv4()}`;
    const refundType = amount < payment.amountPaid ? "PARTIAL" : "FULL";

    // ══════════════════════════════════════════════════════════════════════════
    // DESTINATION: WALLET  — instant, no Cashfree call
    // ══════════════════════════════════════════════════════════════════════════
    if (destination === "wallet") {
      const { creditWallet: cw } = require("../services/walletService");

      const walletTxn = await cw({
        userId:         payment.userId.toString(),
        amount,
        type:           "refund",
        orderId,
        description:    refundNote,
        idempotencyKey: refundId,
        initiatedBy:    "admin",
        ip:             req.ip,
      });

      const refundDoc = await Refund.create({
        userId:       payment.userId,
        paymentId:    payment._id,
        walletTxnId:  walletTxn?._id,
        orderId,
        sessionId:    payment.sessionId || null,
        refundId,
        refundAmount: amount,
        refundType,
        destination:  "wallet",
        status:       "SUCCESS",    // wallet credit is instant
        refundNote,
        initiatedBy:  "admin",
        initiatedAt:  new Date(),
        processedAt:  new Date(),
      });

      // console.log(`✅ Wallet refund SUCCESS: ${refundId} | ₹${amount} → userId: ${payment.userId}`);
      return res.json({ success: true, refund: refundDoc });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DESTINATION: BANK — call Cashfree refund API
    // ══════════════════════════════════════════════════════════════════════════
    const cfPayload = {
      refund_amount: amount,
      refund_id:     refundId,
      refund_note:   refundNote,
    };

    let cfData;
    try {
      const cfRes = await axios.post(
        `${CASHFREE_BASE_URL}/pg/orders/${orderId}/refunds`,
        cfPayload,
        {
          headers: {
            "Content-Type":    "application/json",
            "x-client-id":     process.env.CASHFREE_APP_ID,
            "x-client-secret": process.env.CASHFREE_SECRET_KEY,
            "x-api-version":   "2023-08-01",
          },
        }
      );
      cfData = cfRes.data;
    } catch (cfErr) {
      const msg = cfErr?.response?.data?.message || cfErr.message;
      console.error("❌ Cashfree refund API error:", msg);
      return res.status(502).json({ success: false, message: `Cashfree error: ${msg}` });
    }

    // cfData.cf_refund_id, cfData.refund_status (usually "PENDING" at this point)
    // console.log(`✅ Cashfree refund initiated: ${refundId} | cf_refund_id: ${cfData.cf_refund_id} | status: ${cfData.refund_status}`);

    // Create a WalletTransaction ledger entry so the wallet ledger has a record
    // (balance is NOT touched — this is bank-bound, not wallet)
    let walletTxnId;
    try {
      const wt = await WalletTransaction.create({
        userId:         payment.userId,
        type:           "refund_bank",
        amount,
        balanceBefore:  0,   // bank refund doesn't touch wallet
        balanceAfter:   0,
        orderId,
        paymentId:      payment._id,
        description:    refundNote,
        idempotencyKey: refundId,
        initiatedBy:    "admin",
        ip:             req.ip,
      });
      walletTxnId = wt._id;
    } catch (wtErr) {
      // Non-fatal — log and continue, Refund doc is more important
      console.warn("⚠️ WalletTransaction ledger entry failed:", wtErr.message);
    }

    // Create the Refund document — source of truth for bank refund tracking
    const refundDoc = await Refund.create({
      userId:            payment.userId,
      paymentId:         payment._id,
      walletTxnId:       walletTxnId || null,
      orderId,
      sessionId:         payment.sessionId || null,
      refundId,
      cfRefundId:        cfData.cf_refund_id,
      refundAmount:      amount,
      refundType,
      destination:       "bank",
      status:            "PENDING",     // Cashfree will update via REFUND_STATUS_WEBHOOOK
      refundNote,
      statusDescription: cfData.status_description || "Refund initiated with Cashfree",
      initiatedBy:       "admin",
      initiatedAt:       new Date(),
      rawResponse:       cfData,
    });

    return res.json({ success: true, refund: refundDoc });

  } catch (err) {
    console.error("❌ Refund route error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// NEW ROUTE — GET /api/payment/refund/:refundId
// Admin polls for latest status of a specific refund (fallback if webhook missed)
// ═════════════════════════════════════════════════════════════════════════════
router.get("/refund/:refundId", authMiddleware, adminOnly, async (req, res) => {
  try {
    const refundDoc = await Refund.findOne({ refundId: req.params.refundId }).lean();
    if (!refundDoc) return res.status(404).json({ success: false, message: "Refund not found" });

    // If still PENDING and it's a bank refund, optionally re-fetch from Cashfree
    if (refundDoc.status === "PENDING" && refundDoc.cfRefundId && refundDoc.orderId) {
      try {
        const cfRes = await axios.get(
          `${CASHFREE_BASE_URL}/pg/orders/${refundDoc.orderId}/refunds/${refundDoc.cfRefundId}`,
          {
            headers: {
              "x-client-id":     process.env.CASHFREE_APP_ID,
              "x-client-secret": process.env.CASHFREE_SECRET_KEY,
              "x-api-version":   "2023-08-01",
            },
          }
        );

        const latest = cfRes.data;
        const statusMap = { PENDING: "PENDING", SUCCESS: "SUCCESS", CANCELLED: "CANCELLED", ONHOLD: "ONHOLD" };
        const mappedStatus = statusMap[latest.refund_status] || "PENDING";

        if (mappedStatus !== refundDoc.status) {
          const update = {
            status:            mappedStatus,
            statusDescription: latest.status_description || null,
            rawResponse:       latest,
          };
          if (mappedStatus === "SUCCESS") {
            update.arnNumber   = latest.refund_arn || null;
            update.processedAt = new Date();
          }
          await Refund.findOneAndUpdate({ refundId: req.params.refundId }, { $set: update });
          return res.json({ success: true, refund: { ...refundDoc, ...update } });
        }
      } catch (pollErr) {
        console.warn("Cashfree refund poll failed (returning DB state):", pollErr.message);
      }
    }

    return res.json({ success: true, refund: refundDoc });
  } catch (err) {
    console.error("Refund status fetch error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/process-initiated-refund
// Admin processes an INITIATED bank refund → calls Cashfree and marks PENDING
// Body: { refundDocId }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/process-initiated-refund", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { refundDocId } = req.body;
    if (!refundDocId) {
      return res.status(400).json({ success: false, message: "refundDocId is required" });
    }

    // Find the INITIATED refund doc
    const refundDoc = await Refund.findOne({
      _id: refundDocId,
      status: "INITIATED",
      destination: "bank",
    });
    if (!refundDoc) {
      return res.status(404).json({
        success: false,
        message: "Refund not found or already processed",
      });
    }

    // Verify original payment exists and was successful
    const payment = await Payment.findOne({
      orderId: refundDoc.orderId,
      status: "SUCCESS",
    });
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Original successful payment not found for this order",
      });
    }

    // Call Cashfree Refund API
    const cfPayload = {
      refund_amount: refundDoc.refundAmount,
      refund_id:     refundDoc.refundId,
      refund_note:   refundDoc.refundNote || `Refund for session ${refundDoc.sessionId}`,
    };

    let cfData;
    try {
      const cfRes = await axios.post(
        `${CASHFREE_BASE_URL}/pg/orders/${refundDoc.orderId}/refunds`,
        cfPayload,
        {
          headers: {
            "Content-Type":    "application/json",
            "x-client-id":     process.env.CASHFREE_APP_ID,
            "x-client-secret": process.env.CASHFREE_SECRET_KEY,
            "x-api-version":   "2023-08-01",
          },
        }
      );
      cfData = cfRes.data;
    } catch (cfErr) {
      const msg = cfErr?.response?.data?.message || cfErr.message;
      console.error("❌ Cashfree refund API error:", msg);

      // Mark refund as FAILED in DB
      await Refund.findByIdAndUpdate(refundDocId, {
        $set: {
          status:            "FAILED",
          statusDescription: msg,
          rawResponse:       cfErr?.response?.data || {},
        },
      });

      return res.status(502).json({ success: false, message: `Cashfree error: ${msg}` });
    }

    // Update Refund doc → PENDING with cfRefundId
    const updated = await Refund.findByIdAndUpdate(
      refundDocId,
      {
        $set: {
          status:            "PENDING",
          cfRefundId:        cfData.cf_refund_id || null,
          statusDescription: cfData.status_description || "Sent to Cashfree, awaiting bank",
          initiatedBy:       "admin",
          rawResponse:       cfData,
        },
      },
      { new: true }
    );

    // console.log(`✅ Refund INITIATED→PENDING: ${refundDoc.refundId} | cf_refund_id: ${cfData.cf_refund_id}`);
    return res.json({ success: true, refund: updated });

  } catch (err) {
    console.error("❌ process-initiated-refund error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});


module.exports = router;