// routes/cashfree.js
"use strict";

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


// ════════════════════════════════════════════════════════════════════════════
// WEBHOOK  POST /api/cashfree/webhook
// ════════════════════════════════════════════════════════════════════════════
// NO caMiddleware here — Cashfree is an external server with no JWT.
// Security is handled by HMAC signature verification.
router.post("/webhook", async (req, res) => {
  const rawBody   = req.rawBody;
  const signature = req.headers["x-webhook-signature"];
  const timestamp = req.headers["x-webhook-timestamp"];

  // ── 1. Guard: rawBody must exist ─────────────────────────────────────────
  if (!rawBody) {
    console.warn("[CF Webhook] ❌ Empty rawBody — check middleware order in app.js");
    return res.status(400).json({ error: "Empty body" });
  }

  // ── 2. Verify HMAC signature ─────────────────────────────────────────────
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

  // ── 4. Respond 200 immediately so Cashfree does not retry ────────────────
  res.status(200).json({ received: true });

  // ── 5. Process event asynchronously (after response sent) ─────────────────
  try {
    switch (eventType) {

      // ── PAYMENT_SUCCESS ──────────────────────────────────────────────────
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
          // Idempotency check — MUST be before any DB write
          const existing = await WalletTransaction.findOne({ orderId, type: "topup" });
          if (existing) {
            console.log(`[CF Webhook] Duplicate topup for order ${orderId} — skipped`);
            break; // ← break is inside switch case, correctly stops further processing
          }

          const user = await User.findById(payment.userId);
          if (!user) {
            console.warn(`[CF Webhook] ⚠ User not found for topup order ${orderId}`);
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
          break; // Done — do NOT fall through to session block
        }

        // ── Direct session payment ────────────────────────────────────────
        if (payment.type === "session" || payment.purpose === "session") {
          await Session.findOneAndUpdate(
            { paymentOrderId: orderId },
            { $set: { paymentStatus: "paid", paymentVerifiedAt: new Date() } }
          );
          console.log(`[CF Webhook] ✅ Session payment confirmed for order ${orderId}`);
        }

        break;
      }

      // ── PAYMENT_FAILED / PAYMENT_USER_DROPPED ────────────────────────────
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

        // Cancel any pending session waiting on this payment
        await Session.findOneAndUpdate(
          { paymentOrderId: orderId, status: "pending" },
          { $set: { status: "cancelled", cancelReason: "Payment failed or dropped" } }
        );

        console.log(`[CF Webhook] ⚠ Payment ${eventType} for order ${orderId}`);
        break;
      }

      // ── REFUND_STATUS_WEBHOOK ────────────────────────────────────────────
      case "REFUND_STATUS_WEBHOOK": {
        const orderId   = data?.order?.order_id;
        const refundId  = data?.refund?.cf_refund_id?.toString();
        const status    = data?.refund?.refund_status; // SUCCESS | PENDING | CANCELLED
        const refundAmt = parseFloat(data?.refund?.refund_amount) || 0;

        if (!orderId) break;

        // Build $set conditionally — do NOT write undefined into the document
        const refundUpdate = {
          "refund.status":     status === "SUCCESS" ? "completed" : status?.toLowerCase(),
          "refund.cfRefundId": refundId,
        };
        if (status === "SUCCESS") {
          refundUpdate["refund.processedAt"] = new Date();
        }

        const receipt = await Receipt.findOneAndUpdate(
          { "refund.orderId": orderId },
          { $set: refundUpdate },
          { new: true }
        );

        if (status !== "SUCCESS" || !receipt) {
          console.log(`[CF Webhook] Refund ${status} for order ${orderId} — no wallet action needed`);
          break;
        }

        const refundMode = receipt?.refund?.mode; // "wallet" | "bank"

        // ── Refund back to wallet ────────────────────────────────────────
        if (refundMode === "wallet") {
          const existingTx = await WalletTransaction.findOne({ orderId, type: "refund" });
          if (existingTx) {
            console.log(`[CF Webhook] Duplicate wallet-refund for order ${orderId} — skipped`);
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
              description:   `Wallet refund — Session ${receipt.sessionId || "?"} · CF ${refundId}`,
              initiatedBy:   "cashfree_webhook",
            });
            console.log(`[CF Webhook] ✅ Wallet refund ₹${refundAmt} for user ${receipt.userId}`);
          }
          break;
        }

        // ── Refund to bank (audit trail WalletTransaction of type refund_bank) ─
        if (refundMode === "bank") {
          const existingTx = await WalletTransaction.findOne({ orderId, type: "refund_bank" });
          if (existingTx) {
            console.log(`[CF Webhook] Duplicate bank-refund for order ${orderId} — skipped`);
            break;
          }

          const user = await User.findById(receipt.userId);
          if (user) {
            // Bank refund does NOT touch walletBalance — it's Cashfree crediting user's bank.
            // We only create an audit entry so the CA wallet ledger is complete.
            const bal = user.walletBalance || 0;
            await WalletTransaction.create({
              userId:        receipt.userId,
              type:          "refund_bank",
              amount:        refundAmt,
              balanceBefore: bal,
              balanceAfter:  bal, // balance unchanged — money goes to bank, not wallet
              orderId,
              description:   `Bank refund — Session ${receipt.sessionId || "?"} · CF ${refundId}`,
              initiatedBy:   "cashfree_webhook",
            });
            console.log(`[CF Webhook] ✅ Bank refund audit entry ₹${refundAmt} for user ${receipt.userId}`);
          }
          break;
        }

        console.log(`[CF Webhook] Refund ${status} for order ${orderId} — mode: ${refundMode}`);
        break;
      }

      // ── SETTLEMENT_STATUS_WEBHOOK ────────────────────────────────────────
      case "SETTLEMENT_STATUS_WEBHOOK": {
        // Cashfree fires this when a settlement batch is processed.
        // We log it; actual recon is done via /api/cashfree/settlements.
        const settlementId = data?.settlement?.cf_settlement_id;
        const settledAmt   = data?.settlement?.settlement_amount;
        const settledAt    = data?.settlement?.settlement_date;
        console.log(`[CF Webhook] Settlement ${settlementId} — ₹${settledAmt} on ${settledAt}`);
        // Future: upsert into a CashfreeSettlement model here for automated recon
        break;
      }

      default:
        console.log(`[CF Webhook] Unhandled event type: ${eventType}`);
    }
  } catch (err) {
    console.error("[CF Webhook] ❌ Async handler error:", err);
    // Never re-throw — 200 already sent to Cashfree
  }
});


// ════════════════════════════════════════════════════════════════════════════
// MANUAL VERIFY   GET /api/cashfree/verify/:orderId
// CA use: check live Cashfree status vs DB for a specific order
// ════════════════════════════════════════════════════════════════════════════
router.get("/verify/:orderId", caMiddleware, async (req, res) => {
  try {
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
    const dbStatus = dbPayment?.status        || "NOT_FOUND";
    const mismatch = cfStatus !== dbStatus;

    return res.json({
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
        userId:  dbPayment?.userId,
      },
      mismatch,
      action: mismatch
        ? `DB shows "${dbStatus}" but Cashfree shows "${cfStatus}". Use /heal/${orderId} to fix.`
        : "Records match — no action needed.",
    });
  } catch (err) {
    console.error("[CF Verify] Error:", err);
    return res.status(500).json({ error: "Server error during verification" });
  }
});


// ════════════════════════════════════════════════════════════════════════════
// HEAL / FORCE-RECONCILE   POST /api/cashfree/heal/:orderId
// CA use: for the reconciliation panel — forces DB to match live Cashfree status
// ════════════════════════════════════════════════════════════════════════════
router.post("/heal/:orderId", caMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;

    // Fetch latest state from Cashfree
    const cfResult = await fetchOrderDetails(orderId);
    if (!cfResult.success) {
      return res.status(502).json({ error: cfResult.error || "Cashfree API error" });
    }

    const order    = cfResult.order;
    const cfStatus = order?.order_status; // PAID | ACTIVE | EXPIRED | CANCELLED

    const dbPayment = await Payment.findOne({ orderId }).lean();
    if (!dbPayment) {
      return res.status(404).json({ error: `No Payment record found for order ${orderId}` });
    }

    const actions = [];

    // ── Already in terminal match state — nothing to do ──────────────────
    const terminalMap = { PAID: "SUCCESS", EXPIRED: "FAILED", CANCELLED: "FAILED" };
    const targetStatus = terminalMap[cfStatus];

    if (!targetStatus) {
      return res.json({
        orderId,
        cfStatus,
        message: `Order is in non-terminal state "${cfStatus}" — cannot heal yet. Retry after payment completes.`,
        healed: false,
      });
    }

    if (dbPayment.status === targetStatus) {
      return res.json({
        orderId,
        message: `DB already shows "${targetStatus}" — no heal needed.`,
        healed: false,
      });
    }

    // ── Update Payment record ─────────────────────────────────────────────
    await Payment.findOneAndUpdate(
      { orderId },
      {
        $set: {
          status:   targetStatus,
          healedAt: new Date(),
          healNote: `Healed from Cashfree order status "${cfStatus}"`,
        },
      }
    );
    actions.push(`Payment status set to ${targetStatus}`);

    // ── If healed to SUCCESS: replay topup / session logic ────────────────
    if (targetStatus === "SUCCESS") {
      if (dbPayment.type === "wallet_topup" || dbPayment.purpose === "wallet_topup") {
        const existing = await WalletTransaction.findOne({ orderId, type: "topup" });
        if (!existing) {
          const user = await User.findById(dbPayment.userId);
          if (user) {
            const balBefore = user.walletBalance || 0;
            const amt       = dbPayment.amount   || 0;
            await User.findByIdAndUpdate(dbPayment.userId, { $inc: { walletBalance: amt } });
            await WalletTransaction.create({
              userId: dbPayment.userId, type: "topup", amount: amt,
              balanceBefore: balBefore, balanceAfter: balBefore + amt,
              orderId, paymentId: dbPayment._id,
              initiatedBy: "heal_api",
              description: `Wallet topup healed — Order ${orderId}`,
            });
            actions.push(`Wallet credited ₹${amt}`);
          }
        } else {
          actions.push("Wallet topup already exists — skipped");
        }
      }

      if (dbPayment.type === "session" || dbPayment.purpose === "session") {
        await Session.findOneAndUpdate(
          { paymentOrderId: orderId },
          { $set: { paymentStatus: "paid", paymentVerifiedAt: new Date() } }
        );
        actions.push("Session payment status set to paid");
      }
    }

    return res.json({
      orderId,
      previousStatus: dbPayment.status,
      newStatus:      targetStatus,
      healed:         true,
      actions,
    });

  } catch (err) {
    console.error("[CF Heal] Error:", err);
    return res.status(500).json({ error: "Server error during heal" });
  }
});


// ════════════════════════════════════════════════════════════════════════════
// SETTLEMENTS   GET /api/cashfree/settlements?from=2026-07-01&to=2026-07-31
// CA use: compare Cashfree settled amount vs DB net expected
// ════════════════════════════════════════════════════════════════════════════
router.get("/settlements", caMiddleware, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: "from and to query params are required (YYYY-MM-DD)" });
    }

    const cfResult = await fetchSettlements(from, to);
    if (!cfResult.success) {
      return res.status(502).json({ error: cfResult.error });
    }

    // Build date range respecting server local time (IST)
    const fromDate = new Date(from);
    fromDate.setHours(0, 0, 0, 0);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const [dbReceipts] = await Receipt.aggregate([
      { $match: { createdAt: { $gte: fromDate, $lte: toDate } } },
      {
        $group: {
          _id:            null,
          totalBilled:    { $sum: "$totalAmount" },
          totalPgCharges: { $sum: { $ifNull: ["$paymentCharges", 0] } },
          totalRefunds:   { $sum: { $ifNull: ["$refundAmount",   0] } },
          count:          { $sum: 1 },
          cashfreeOrders: { $sum: { $cond: [{ $eq: ["$paymentGateway", "cashfree"] }, 1, 0] } },
          walletOrders:   { $sum: { $cond: [{ $eq: ["$paymentGateway", "wallet"]   }, 1, 0] } },
        },
      },
    ]);

    const settlements = cfResult.settlements || [];
    const cfTotal = settlements.reduce((s, item) => s + (parseFloat(item.settlement_amount) || 0), 0);

    // Net expected = only cashfree-collected amounts minus PG fees and refunds
    // (wallet sessions don't go through Cashfree settlement)
    const dbNet = (dbReceipts?.totalBilled    || 0)
                - (dbReceipts?.totalPgCharges || 0)
                - (dbReceipts?.totalRefunds   || 0);

    const diff = parseFloat((cfTotal - dbNet).toFixed(2));

    return res.json({
      period: { from, to },
      cashfree: {
        settlementCount: settlements.length,
        totalSettled:    parseFloat(cfTotal.toFixed(2)),
        settlements,
      },
      database: {
        invoiceCount:   dbReceipts?.count           || 0,
        cashfreeOrders: dbReceipts?.cashfreeOrders  || 0,
        walletOrders:   dbReceipts?.walletOrders    || 0,
        totalBilled:    dbReceipts?.totalBilled     || 0,
        pgCharges:      dbReceipts?.totalPgCharges  || 0,
        refunds:        dbReceipts?.totalRefunds    || 0,
        netExpected:    parseFloat(dbNet.toFixed(2)),
      },
      reconciliation: {
        difference: diff,
        status:     Math.abs(diff) < 1 ? "MATCHED" : "MISMATCH",
        note: Math.abs(diff) < 1
          ? "Cashfree settlements match your database records."
          : `Difference of ₹${Math.abs(diff).toFixed(2)} — check for pending settlements, untracked refunds, or wallet-paid sessions included in Cashfree totals.`,
      },
    });
  } catch (err) {
    console.error("[CF Settlements] Error:", err);
    return res.status(500).json({ error: "Server error fetching settlements" });
  }
});


// ════════════════════════════════════════════════════════════════════════════
// MISMATCHED PAYMENTS SCAN   GET /api/cashfree/mismatches?days=7
// CA use: list all Payment records where DB status ≠ Cashfree status
// (checks only recent records to avoid rate-limiting the Cashfree API)
// ════════════════════════════════════════════════════════════════════════════
router.get("/mismatches", caMiddleware, async (req, res) => {
  try {
    const days    = parseInt(req.query.days) || 3;
    const since   = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const limit   = Math.min(parseInt(req.query.limit) || 50, 100);

    // Find payments that are NOT in a confirmed terminal state in DB
    const pendingPayments = await Payment.find({
      createdAt: { $gte: since },
      status:    { $in: ["PENDING", "INITIATED", "ACTIVE"] },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    if (pendingPayments.length === 0) {
      return res.json({
        scanned: 0,
        mismatches: [],
        message: `No pending payments in last ${days} days — all records look terminal.`,
      });
    }

    // Check each against Cashfree (sequential to avoid rate-limit)
    const mismatches = [];
    for (const p of pendingPayments) {
      try {
        const cfResult = await fetchPaymentStatus(p.orderId);
        if (!cfResult.success) continue;

        const cfStatus = cfResult.payments?.[0]?.payment_status || "UNKNOWN";
        if (cfStatus !== p.status && cfStatus !== "UNKNOWN") {
          mismatches.push({
            orderId:    p.orderId,
            dbStatus:   p.status,
            cfStatus,
            amount:     p.amount,
            type:       p.type || p.purpose,
            userId:     p.userId,
            createdAt:  p.createdAt,
            healUrl:    `/api/cashfree/heal/${p.orderId}`,
          });
        }
      } catch {
        // Skip individual order errors — don't fail the whole scan
      }
    }

    return res.json({
      scanned:    pendingPayments.length,
      mismatches: mismatches.length,
      data:       mismatches,
      message:    mismatches.length === 0
        ? `Scanned ${pendingPayments.length} pending payments — all match Cashfree.`
        : `Found ${mismatches.length} mismatch(es). Use POST /heal/:orderId to fix each.`,
    });
  } catch (err) {
    console.error("[CF Mismatches] Error:", err);
    return res.status(500).json({ error: "Server error scanning mismatches" });
  }
});


module.exports = router;