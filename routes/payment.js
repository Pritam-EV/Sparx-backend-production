const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const router = express.Router();
const Payment = require("../models/Payment");
const User = require("../models/User");
const authMiddleware = require("../middleware/authMiddleware");
const CASHFREE_BASE_URL =
  process.env.CASHFREE_ENV === "PROD"
    ? "https://api.cashfree.com"
    : "https://sandbox.cashfree.com";


router.post("/order", authMiddleware, async (req, res) => {
  try {
    const { amount, /* customer, */ deviceId } = req.body;

    if (!amount) {
      return res.status(400).json({
        success: false,
        message: "Amount is required",
      });
    }

    const orderId = `order_${uuidv4()}`;
      
    const returnUrl =
      req.body.returnUrl ||
      `${process.env.CLIENT_URL}/payment-success?order_id={order_id}`;

    const user = await User.findById(
      req.user.userId,
      { name: 1, mobile: 1 },
      { lean: true }
    ).exec();

    const payload = {
      order_id: orderId,
      order_amount: Number(amount),
      order_currency: "INR",
      customer_details: {
        customer_id: req.user.userId, /* customer?.id || "guest_user", */
        customer_name: user.name,
        customer_email: "vjratechnologies@gmail.com", /*customer?.email || "guest@example.com", */
        customer_phone: user.mobile /* customer?.phone || "9999999999", */
      },

      order_meta: {
        return_url: returnUrl,
        payment_methods: "cc,dc,nb,upi",
      },

    };

    const response = await axios.post(
      `${CASHFREE_BASE_URL}/pg/orders`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "x-client-id": process.env.CASHFREE_APP_ID,
          "x-client-secret": process.env.CASHFREE_SECRET_KEY,
          "x-api-version": "2023-08-01",
        },
      }
    );
    console.log("🌍 Cashfree BASE:", CASHFREE_BASE_URL, "🔑 Cashfree ENV:", process.env.CASHFREE_ENV);

    // ✅ CREATE PAYMENT RECORD (PENDING)
    await Payment.create({
      orderId,
      userId: req.user?.userId,
      deviceId,
      amountPaid: Number(amount),
      currency: "INR",
      status: "PENDING",
      gateway: "cashfree",
      rawResponse: response.data,
    });
    console.log("✅ Cashfree order created:", {
      orderId,
      cfOrderId: response.data.order_id,
      paymentSessionId: response.data.payment_session_id,
    });

    return res.status(200).json({
      success: true,
      order: response.data,
      paymentSessionId: response.data?.payment_session_id,
    });
  } catch (error) {
    console.error(
      "Cashfree order creation failed:",
      error?.response?.data || error.message
    );
    return res.status(500).json({
      success: false,
      message: "Cashfree order creation failed",
    });
  }
});



router.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"];

    if (!signature || !req.rawBody) {
      console.error("❌ Missing webhook signature or raw body");
      return res.status(400).send("Invalid webhook");
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.CASHFREE_WEBHOOK_SECRET)
      .update(req.rawBody) // ✅ RAW BODY, NOT JSON.stringify
      .digest("base64");

    if (signature !== expectedSignature) {
      console.error("❌ Invalid Cashfree webhook signature");
      return res.status(401).send("Invalid signature");
    }

const event = req.body;

if (event.type === "PAYMENT_SUCCESS") {
  const orderId = event.data.order.order_id;
  const payment = event.data.payment;

  console.log("✅ Cashfree payment success:", orderId);

await Payment.updateOne(
  { orderId, status: { $ne: "SUCCESS" } },
  {
    $set: {
        status: "SUCCESS",
        paymentMethod: payment.payment_method,
        paymentGroup: payment.payment_group,          // ← add
        cfPaymentId: payment.cf_payment_id,
        bankReference: payment.bank_reference || null, // ← add
        paidAt: new Date(payment.payment_time),
        rawResponse: event,
    },
  }
);

  // NEW: if this is a wallet topup order, credit wallet
  if (orderId.startsWith("wlt_") && !orderId.startsWith("wlt_pay_")) {
    const { creditWallet } = require("../services/walletService");
    const payment = await Payment.findOne({ orderId });
    if (payment && payment.status !== "WALLET_CREDITED") {
      try {
        await creditWallet({
          userId: payment.userId.toString(),
          amount: payment.amountPaid,
          type: "topup",
          orderId,
          description: "Wallet topup via Cashfree webhook",
          idempotencyKey: `topup_${orderId}`,
        });
        await Payment.updateOne({ orderId }, { $set: { status: "SUCCESS" } });
      } catch (e) {
        console.error("Webhook wallet credit failed:", e.message);
      }
    }
  }

}

if (event.type === "PAYMENT_FAILED") {
  const orderId = event.data.order.order_id;

  console.log("❌ Cashfree payment failed:", orderId);

  await Payment.updateOne(
    { orderId },
    {
      $set: {
        status: "FAILED",
        failureReason: event.data.payment?.payment_message || null,
        rawResponse: event,
      },
    }
  );
}


    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("Webhook error");
  }
});


router.get("/verify", async (req, res) => {
  try {
    const { orderId } = req.query;

      if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order ID missing",
      });
    }
// ✅ FREE / ZERO PAYMENT — skip verification
if (orderId?.startsWith("FREE_")) {
  await Payment.updateOne(
    { orderId },
    {
      $set: {
        status: "SUCCESS",
        gateway: "free",
        paymentMethod: "free",
        paidAt: new Date(),
      },
    },
    { upsert: true }
  );

  return res.json({
    success: true,
    status: "successful",
    gateway: "free",
  });
}


  console.log("🔍 Verifying payment for:", orderId);

    const payment = await Payment.findOne({ orderId });

    if (!payment) {
      console.warn("⚠️ Payment not found for:", orderId);

      const response = await axios.get(
        `${CASHFREE_BASE_URL}/pg/orders/${orderId}`,
        {
          headers: {
            "x-client-id": process.env.CASHFREE_APP_ID,
            "x-client-secret": process.env.CASHFREE_SECRET_KEY,
            "x-api-version": "2023-08-01",
          },
        }
      );

      return res.status(response.status).json({
        success: true,
        message: response.data?.message,
        status: response.data?.order_status ? (response.data.order_status == "PAID" ? "successful" : (response.data.order_status == "TERMINATED" ? "cancelled" : (response.data.order_status == "TERMINATION_REQUESTED" ? "pending" : "failed"))) : "failed"
      });
    }

// ✅ If already successful
if (payment.status === "SUCCESS") {
  return res.json({
    success: true,
    status: "successful",
    payment,
  });
}

// 🕒 If pending → verify from Cashfree directly
if (payment.status === "PENDING") {
  console.log("⏳ Payment pending in DB, checking Cashfree...");

  const response = await axios.get(
    `${CASHFREE_BASE_URL}/pg/orders/${orderId}`,
    {
      headers: {
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version": "2023-08-01",
      },
    }
  );

  const orderStatus = response.data?.order_status;

  console.log("🔍 Cashfree order status:", orderStatus);

  if (orderStatus === "PAID") {
    // 🔥 Update DB immediately
    await Payment.updateOne(
      { orderId },
      {
        $set: {
          status: "SUCCESS",
          paidAt: new Date(),
          rawResponse: response.data,
        },
      }
    );

    return res.json({
      success: true,
      status: "successful",
    });
  }

  if (orderStatus === "FAILED" || orderStatus === "CANCELLED") {
    await Payment.updateOne(
      { orderId },
      { $set: { status: "FAILED", rawResponse: response.data } }
    );

    return res.status(400).json({
      success: false,
      message: "Payment failed",
    });
  }

  // still pending
  return res.status(202).json({
    success: false,
    message: "Payment pending",
  });
}



  } catch (err) {
    console.error("❌ Verify route crashed:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
    
  }
});

// GET /api/payment/my-transactions
// Returns all payments for the logged-in user, newest first
// GET /api/payment/my-transactions
// GET /api/payment/my-transactions
// GET /api/payment/my-transactions
router.get("/my-transactions", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const Receipt = require("../models/Receipt");
    const WalletTransaction = require("../models/WalletTransaction");

    // 1. Payment records (gateway + wallet-pay charging)
// 1. Payment records — exclude wallet_topup (those come via WalletTransaction below)
const payments = await Payment.find({ 
  userId,
  type: { $ne: "wallet_topup" }   // ← ADD THIS LINE ONLY
})
  .sort({ createdAt: -1 }).limit(100)
  .select("orderId sessionId deviceId amountPaid currency status paymentMethod paymentGroup cfPaymentId bankReference failureReason paidAt createdAt gateway type")
  .lean();

    const orderIds = payments.map(p => p.orderId).filter(Boolean);

    // 2. Refund entries from Receipt model (unchanged)
    const receipts = await Receipt.find({
      transactionId: { $in: orderIds }, userId,
      "refund.status": { $exists: true, $ne: null },
    }, { transactionId:1, receiptId:1, amountPaid:1, "refund.status":1, "refund.refundId":1, "refund.failureReason":1, "refund.processedAt":1, "refund.amount":1, createdAt:1 }).lean();

    const refundEntries = receipts.filter(r => r.refund).map(r => ({
      _id: `refund_${r._id}`,
      orderId: r.transactionId,
      amountPaid: r.refund.amount ?? r.amountPaid ?? 0,
      status: "REFUND",
      refundId: r.refund.refundId || null,
      refundStatus: r.refund.status,
      refundFailureReason: r.refund.failureReason || null,
      paidAt: r.refund.processedAt || r.createdAt,
      createdAt: r.refund.processedAt || r.createdAt,
      isRefundEntry: true,
    }));

    // 3. ✨ NEW: Wallet topups & wallet refunds
    //    Skip type="charging" — those are already Payment records with gateway:"wallet"
    const walletTxns = await WalletTransaction.find({
      userId,
      type: { $ne: "charging" },
    })
      .sort({ createdAt: -1 }).limit(100)
      .select("type amount description orderId idempotencyKey createdAt status")
      .lean();

    const walletEntries = walletTxns.map(w => ({
      _id: `wallet_${w._id}`,
      orderId: w.orderId || w.idempotencyKey || `wallet_${w._id}`,
      amountPaid: w.amount,
      status: w.type === "topup" ? "TOPUP" : "WALLET_REFUND",
      walletTxnType: w.type,
      description: w.description || "",
      paidAt: w.createdAt,
      createdAt: w.createdAt,
      isWalletEntry: true,
    }));

    // 4. Tag payments with source, merge all, sort
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



module.exports = router;
