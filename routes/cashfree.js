// routes/cashfree.js
const express = require("express");
const router  = express.Router();
const Payment           = require("../models/Payment");
const WalletTransaction = require("../models/WalletTransaction");
const Receipt           = require("../models/Receipt");
const Session           = require("../models/session");
const User              = require("../models/User");
const caMiddleware      = require("../middleware/caMiddleware");
const {
  verifyCashfreeWebhook,
  fetchPaymentStatus,
  fetchOrderDetails,
  fetchSettlements,
} = require("../services/cashfreeVerify");

// ── WEBHOOK ──────────────────────────────────────────────────────────────────
// POST /api/cashfree/webhook
// NO caMiddleware here — Cashfree is an external server with NO JWT token.
// Security is handled by HMAC signature verification below.
router.post("/webhook", async (req, res) => {
  const rawBody  = req.rawBody;
  const signature = req.headers["x-webhook-signature"];
  const timestamp = req.headers["x-webhook-timestamp"];

  // ── 1. Guard: rawBody must exist ──────────────────────────────────────────
  if (!rawBody) {
    console.warn("[CF Webhook] ❌ Empty rawBody — middleware order issue in app.js");
    return res.status(400).json({ error: "Empty body" });
  }

  // ── 2. Verify HMAC signature ──────────────────────────────────────────────
  if (!verifyCashfreeWebhook(rawBody, signature, timestamp)) {
    console.warn("[CF Webhook] ❌ Invalid signature — rejected");
    return res.status(401).json({ error: "Invalid signature" });
  }

  // ── 3. Parse event ────────────────────────────────────────────────────────
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  const eventType = event?.type;
  const data      = event?.data;
  console.log(`[CF Webhook] ✅ Event: ${eventType} | Order: ${data?.order?.order_id}`);

  // ── 4. Respond 200 immediately so Cashfree doesn't retry ─────────────────
  res.status(200).json({ received: true });

  // ── 5. Process event asynchronously (after response sent) ─────────────────
  try {
    switch (eventType) {

      // ── PAYMENT SUCCESS ────────────────────────────────────────────────────
      case "PAYMENT_SUCCESS": {
        const orderId   = data?.order?.order_id;
        const paymentId = data?.payment?.cf_payment_id?.toString();
        const amount    = parseFloat(data?.payment?.payment_amount) || 0;
        const method    = data?.payment?.payment_method;
        const bankRef   = data?.payment?.bank_reference;

        if (!orderId) break;

        const payment = await Payment.findOneAndUpdate(
          { orderId },
          {
            $set: {
              status:        "SUCCESS",
              cfPaymentId:   paymentId,
              paymentMethod: JSON.stringify(method),
              bankReference: bankRef,
              amount,
              paidAt:        new Date(),
            },
          },
          { new: true }
        );

        if (!payment) {
          console.warn(`[CF Webhook] ⚠ Payment record not found for order ${orderId}`);
          break;
        }

        // ── Wallet topup ──────────────────────────────────────────────────
        if (payment.type === "wallet_topup" || payment.purpose === "wallet_topup") {
          const user = await User.findById(payment.userId);
          if (!user) break;

          // Idempotency check
          const existing = await WalletTransaction.findOne({ orderId, type: "topup" });
          if (existing) {
            console.log(`[CF Webhook] Duplicate topup for order ${orderId} — skipped`);
            break;
          }

          const balanceBefore = user.walletBalance || 0;
          const balanceAfter  = balanceBefore + amount;

          await User.findByIdAndUpdate(payment.userId, {
            $inc: { walletBalance: amount },
          });

          await WalletTransaction.create({
            userId:       payment.userId,
            type:         "topup",
            amount,
            balanceBefore,
            balanceAfter,
            orderId,
            paymentId:    payment._id,
            initiatedBy:  "cashfree_webhook",
            description:  `Wallet topup via Cashfree — Order ${orderId}`,
          });

          console.log(`[CF Webhook] ✅ Wallet credited ₹${amount} for user ${payment.userId}`);
        }

        // ── Direct session payment ─────────────────────────────────────────
        if (payment.type === "session" || payment.purpose === "session") {
          await Session.findOneAndUpdate(
            { paymentOrderId: orderId },
            { $set: { paymentStatus: "paid", paymentVerifiedAt: new Date() } }
          );
          console.log(`[CF Webhook] ✅ Session payment confirmed for order ${orderId}`);
        }

        break;
      }

      // ── PAYMENT FAILED / DROPPED ───────────────────────────────────────────
      case "PAYMENT_FAILED":
      case "PAYMENT_USER_DROPPED": {
        const orderId = data?.order?.order_id;
        if (!orderId) break;

        await Payment.findOneAndUpdate(
          { orderId },
          {
            $set: {
              status:     eventType === "PAYMENT_FAILED" ? "FAILED" : "DROPPED",
              failedAt:   new Date(),
              failReason: data?.error_details?.error_description || eventType,
            },
          }
        );

        await Session.findOneAndUpdate(
          { paymentOrderId: orderId, status: "pending" },
          { $set: { status: "cancelled", cancelReason: "Payment failed" } }
        );

        console.log(`[CF Webhook] ⚠ Payment ${eventType} for order ${orderId}`);
        break;
      }

      // ── REFUND STATUS ──────────────────────────────────────────────────────
      case "REFUND_STATUS_WEBHOOK": {
        const orderId   = data?.order?.order_id;
        const refundId  = data?.refund?.cf_refund_id?.toString();
        const status    = data?.refund?.refund_status; // SUCCESS, PENDING, CANCELLED
        const refundAmt = parseFloat(data?.refund?.refund_amount) || 0;

        if (!orderId) break;

        const receipt = await Receipt.findOneAndUpdate(
          { "refund.orderId": orderId },
          {
            $set: {
              "refund.status":       status === "SUCCESS" ? "completed" : status?.toLowerCase(),
              "refund.cfRefundId":   refundId,
              "refund.processedAt":  status === "SUCCESS" ? new Date() : undefined,
            },
          },
          { new: true }
        );

        if (status === "SUCCESS" && receipt?.refund?.mode === "wallet") {
          // Idempotency check
          const existingRefundTx = await WalletTransaction.findOne({ orderId, type: "refund" });
          if (existingRefundTx) {
            console.log(`[CF Webhook] Duplicate refund for order ${orderId} — skipped`);
            break;
          }

          const user = await User.findById(receipt.userId);
          if (user) {
            const balBefore = user.walletBalance || 0;
            await User.findByIdAndUpdate(receipt.userId, {
              $inc: { walletBalance: refundAmt },
            });
            await WalletTransaction.create({
              userId:        receipt.userId,
              type:          "refund",
              amount:        refundAmt,
              balanceBefore: balBefore,
              balanceAfter:  balBefore + refundAmt,
              orderId,
              description:   `Refund from session ${receipt.sessionId || "?"} — CF Refund ${refundId}`,
              initiatedBy:   "cashfree_webhook",
            });
            console.log(`[CF Webhook] ✅ Wallet refund ₹${refundAmt} for user ${receipt.userId}`);
          }
        }

        console.log(`[CF Webhook] Refund ${status} for order ${orderId}`);
        break;
      }

      default:
        console.log(`[CF Webhook] Unhandled event type: ${eventType}`);
    }
  } catch (err) {
    console.error("[CF Webhook] ❌ Handler error:", err);
    // Don't re-throw — 200 already sent to Cashfree
  }
});

// ─── MANUAL VERIFY: fetch live status from Cashfree API ─────────────────────
// GET /api/cashfree/verify/:orderId
router.get("/verify/:orderId", caMiddleware, async (req, res) => {
  const { orderId } = req.params;
  const [cfResult, dbPayment] = await Promise.all([
    fetchPaymentStatus(orderId),
    Payment.findOne({ orderId }).lean(),
  ]);

  if (!cfResult.success) {
    return res.status(502).json({ error: cfResult.error });
  }

  const cfLatest = cfResult.payments?.[0] || null;
  const cfStatus = cfLatest?.payment_status || "UNKNOWN";
  const dbStatus = dbPayment?.status || "NOT_FOUND";
  const mismatch = cfStatus !== dbStatus;

  res.json({
    orderId,
    cashfree: {
      status:         cfStatus,
      amount:         cfLatest?.payment_amount,
      method:         cfLatest?.payment_method,
      cf_payment_id:  cfLatest?.cf_payment_id,
      bank_reference: cfLatest?.bank_reference,
      payment_time:   cfLatest?.payment_completion_time,
    },
    database: {
      status:  dbStatus,
      amount:  dbPayment?.amount,
      paidAt:  dbPayment?.paidAt,
      type:    dbPayment?.type,
      purpose: dbPayment?.purpose,
    },
    mismatch,
    action: mismatch
      ? `DB shows ${dbStatus} but Cashfree shows ${cfStatus}. Manual reconciliation needed.`
      : "Records match.",
  });
});

// ─── SETTLEMENTS ──────────────────────────────────────────────────────────────
// GET /api/cashfree/settlements?from=2026-07-01&to=2026-07-31
router.get("/settlements", caMiddleware, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to dates required" });

  const cfResult = await fetchSettlements(from, to);
  if (!cfResult.success) return res.status(502).json({ error: cfResult.error });

  const fromDate = new Date(from);
  const toDate   = new Date(to + "T23:59:59.999Z");

  const [dbReceipts] = await Receipt.aggregate([
    { $match: { createdAt: { $gte: fromDate, $lte: toDate } } },
    {
      $group: {
        _id: null,
        totalBilled:    { $sum: "$totalAmount" },
        totalPgCharges: { $sum: { $ifNull: ["$paymentCharges", 0] } },
        totalRefunds:   { $sum: { $ifNull: ["$refundAmount", 0] } },
        count:          { $sum: 1 },
        cashfreeOrders: { $sum: { $cond: [{ $eq: ["$paymentGateway", "cashfree"] }, 1, 0] } },
      },
    },
  ]);

  const settlements = cfResult.settlements || [];
  const cfTotal = settlements.reduce((s, item) => s + (item.settlement_amount || 0), 0);
  const dbNet   = (dbReceipts?.totalBilled    || 0)
                - (dbReceipts?.totalPgCharges || 0)
                - (dbReceipts?.totalRefunds   || 0);

  res.json({
    period: { from, to },
    cashfree: {
      settlementCount: settlements.length,
      totalSettled:    cfTotal,
      settlements,
    },
    database: {
      invoiceCount:  dbReceipts?.count          || 0,
      cashfreeOrders: dbReceipts?.cashfreeOrders || 0,
      totalBilled:   dbReceipts?.totalBilled    || 0,
      pgCharges:     dbReceipts?.totalPgCharges || 0,
      refunds:       dbReceipts?.totalRefunds   || 0,
      netExpected:   dbNet,
    },
    reconciliation: {
      difference: parseFloat((cfTotal - dbNet).toFixed(2)),
      status:     Math.abs(cfTotal - dbNet) < 1 ? "MATCHED" : "MISMATCH",
      note:       Math.abs(cfTotal - dbNet) < 1
        ? "Cashfree settlements match your database records."
        : `Difference of ₹${Math.abs(cfTotal - dbNet).toFixed(2)} — check for pending settlements or untracked refunds.`,
    },
  });
});

module.exports = router;