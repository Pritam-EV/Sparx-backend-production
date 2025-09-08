const express = require("express");
const Razorpay = require("razorpay");
const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

router.post("/orders", async (req, res) => {
  const { amount } = req.body;

  try {
    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: `rcpt_${Math.floor(Math.random() * 100000)}`,
      payment_capture: 1
    });

    res.json({ success: true, order });
  } catch (err) {
    console.error("Razorpay error:", err);
    res.status(500).json({ success: false, error: "Razorpay order creation failed" });
  }
});

module.exports = router;
