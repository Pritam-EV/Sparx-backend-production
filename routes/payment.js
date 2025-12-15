const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const router = express.Router();

const CASHFREE_BASE_URL =
  process.env.CASHFREE_ENV === "PROD"
    ? "https://api.cashfree.com"
    : "https://sandbox.cashfree.com";

router.post("/orders", async (req, res) => {
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

    return res.status(200).json({
      success: true,
      order: response.data, // contains order_token
    });
  } catch (error) {
    console.error("Cashfree order creation failed:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Cashfree order creation failed",
    });
  }
});

module.exports = router;
