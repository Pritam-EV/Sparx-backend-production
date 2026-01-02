const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const router = express.Router();
const Payment = require("../models/Payment");

const CASHFREE_BASE_URL =
  process.env.CASHFREE_ENV === "PROD"
    ? "https://api.cashfree.com"
    : "https://sandbox.cashfree.com";


    
router.post("/order", async (req, res) => {
  try {
    const { amount, customer } = req.body;

    if (!amount) {
      return res.status(400).json({ success: false, message: "Amount is required" });
    }

    const orderId = `order_${uuidv4()}`;

    const payload = {
      order_id: orderId,
      order_amount: Number(amount),
      order_currency: "INR",
      customer_details: {
        customer_id: customer?.id || "guest_user",
        customer_email: customer?.email || "guest@example.com",
        customer_phone: customer?.phone || "9999999999",
      },
      order_meta: {
        return_url: `${process.env.CLIENT_URL}/payment-success?order_id={order_id}`,
        payment_methods: "cc,dc,ccc,ppc,nb,upi"
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

    return res.status(response.status).json({
      success: true,
      order: response.data, // contains order_token
      paymentSessionId: response.data?.payment_session_id
    });
  } catch (error) {
    console.error("Cashfree order creation failed:", error?.response?.data || error.message);
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
      const paymentId = event.data.payment.cf_payment_id;

      console.log("✅ Cashfree payment confirmed:", orderId);

      await Payment.updateOne(
        { orderId },
        {
          orderId,
          status: "PAID",
          paymentId,
          gateway: "cashfree",
          paidAt: new Date(),
        },
        { upsert: true }
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

// ✅ FREE / ZERO PAYMENT — skip verification
if (orderId?.startsWith("FREE_")) {
  return res.json({
    success: true,
    status: "successful",
    gateway: "free",
  });
}

  console.log("🔍 Verifying payment for:", orderId);
      if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order ID missing",
      });
    }
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

    if (payment.status !== "PAID") {
      console.warn("⚠️ Payment not completed:", payment.status);
      return res.status(400).json({
        success: false,
        message: "Payment not completed yet",
      });
    }

    console.log("✅ Payment verified:", orderId);


    return res.json({
      success: true,
      payment,
    });
  } catch (err) {
    console.error("❌ Verify route crashed:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

module.exports = router;
