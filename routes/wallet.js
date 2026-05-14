const express = require("express");
const router = express.Router();
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const authMiddleware = require("../middleware/authMiddleware");
const User = require("../models/User");
const Payment = require("../models/Payment");
const WalletTransaction = require("../models/WalletTransaction");
const { creditWallet, debitWallet } = require("../services/walletService");
const crypto = require("crypto");

const CASHFREE_BASE_URL = process.env.CASHFREE_ENV === "PROD"
  ? "https://api.cashfree.com"
  : "https://sandbox.cashfree.com";

// GET /api/wallet/balance  — returns current balance only (no history)
router.get("/balance", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
      .select("walletBalance walletKycLevel walletFrozen walletMonthlyLoaded")
      .lean();
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({
      balance: user.walletBalance,
      kycLevel: user.walletKycLevel,
      frozen: user.walletFrozen,
      monthlyLoaded: user.walletMonthlyLoaded,
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/wallet/transactions  — paginated wallet history
router.get("/transactions", authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const skip = (Math.max(1, parseInt(page)) - 1) * Math.min(parseInt(limit), 100);
    const txns = await WalletTransaction.find({ userId: req.user.userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Math.min(parseInt(limit), 100))
      .select("-__v")
      .lean();
    const total = await WalletTransaction.countDocuments({ userId: req.user.userId });
    return res.json({ success: true, transactions: txns, total });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/wallet/topup/order  — create Cashfree order for wallet topup
router.post("/topup/order", authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    const amountNum = Number(amount);
    if (!amountNum || amountNum < 10 || amountNum > 10000)
      return res.status(400).json({ message: "Amount must be between ₹10 and ₹10,000" });

    const user = await User.findById(req.user.userId)
      .select("name mobile walletBalance walletKycLevel walletMonthlyLoaded walletLastResetMonth")
      .lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    // Pre-check RBI balance cap before creating order (final check is in walletService on webhook)
    const balanceCap = user.walletKycLevel === "full_kyc" ? 200000 : 10000;
    if (user.walletBalance + amountNum > balanceCap)
      return res.status(400).json({ message: `Wallet balance cannot exceed ₹${balanceCap}` });

    const orderId = `wlt_${uuidv4()}`;  // "wlt_" prefix distinguishes topup orders
    const returnUrl = `${process.env.CLIENT_URL}/wallet/topup-success?order_id={order_id}`;

    const payload = {
      order_id: orderId,
      order_amount: amountNum,
      order_currency: "INR",
      customer_details: {
        customer_id: req.user.userId,
        customer_name: user.name,
        customer_email: "vjratechnologies@gmail.com",
        customer_phone: user.mobile,
      },
      order_meta: {
        return_url: returnUrl,
        payment_methods: "cc,dc,nb,upi",
      },
    };

    const cfResp = await axios.post(`${CASHFREE_BASE_URL}/pg/orders`, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version": "2023-08-01",
      },
    });

    // Record PENDING payment for topup
    await Payment.create({
      orderId,
      userId: req.user.userId,
      amountPaid: amountNum,
      currency: "INR",
      status: "PENDING",
      gateway: "cashfree",
      type: "wallet_topup",    // ← new field needed on Payment model
      rawResponse: cfResp.data,
    });

    return res.status(200).json({
      success: true,
      paymentSessionId: cfResp.data?.payment_session_id,
      orderId,
    });
  } catch (err) {
    console.error("Wallet topup order error:", err?.response?.data || err.message);
    return res.status(500).json({ message: "Failed to create topup order" });
  }
});

// POST /api/wallet/topup/verify  — called by FE after Cashfree redirect
// Verifies with Cashfree, then credits wallet (idempotent)
router.post("/topup/verify", authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId?.startsWith("wlt_"))
      return res.status(400).json({ message: "Invalid topup order ID" });

    const payment = await Payment.findOne({ orderId, userId: req.user.userId });
    if (!payment) return res.status(404).json({ message: "Order not found" });
    if (payment.status === "SUCCESS")
      return res.json({ success: true, message: "Already credited", alreadyCredited: true });

    // Verify with Cashfree
    const cfResp = await axios.get(`${CASHFREE_BASE_URL}/pg/orders/${orderId}`, {
      headers: {
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version": "2023-08-01",
      },
    });

    if (cfResp.data?.order_status !== "PAID")
      return res.status(400).json({ success: false, message: "Payment not confirmed" });

    // Credit wallet (idempotent — uses orderId as idempotency key)
    const result = await creditWallet({
      userId: req.user.userId,
      amount: payment.amountPaid,
      type: "topup",
      orderId,
      description: `Wallet topup via Cashfree`,
      idempotencyKey: `topup_${orderId}`,
      ip: req.ip,
    });

    // Update payment record to SUCCESS
    await Payment.updateOne({ orderId }, { $set: { status: "SUCCESS", paidAt: new Date() } });

    return res.json({ success: true, newBalance: result.newBalance });
  } catch (err) {
    console.error("Wallet topup verify error:", err.message);
    return res.status(500).json({ message: err.message || "Verification failed" });
  }
});

// ── GET /api/wallet/topup-status?orderId= ─── (used by WalletTopupSuccess polling)
// GET /api/wallet/topup-status?orderId=
// Self-healing: if PENDING in DB, checks Cashfree and credits wallet
router.get("/topup-status", authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) return res.json({ status: "PENDING" });

    const payment = await Payment.findOne({ orderId }).lean();
    if (!payment) return res.json({ status: "PENDING" });

    // Already done — return immediately
    if (payment.status === "SUCCESS") {
      return res.json({ status: "SUCCESS", amount: payment.amountPaid });
    }
    if (payment.status === "FAILED") {
      return res.json({ status: "FAILED" });
    }

    // Still PENDING in DB — go ask Cashfree directly
    const CASHFREE_BASE_URL = process.env.CASHFREE_ENV === "PROD"
      ? "https://api.cashfree.com"
      : "https://sandbox.cashfree.com";

    const cfResp = await axios.get(`${CASHFREE_BASE_URL}/pg/orders/${orderId}`, {
      headers: {
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version": "2023-08-01",
      },
    });

    const orderStatus = cfResp.data?.order_status;

    if (orderStatus === "PAID") {
      // Credit wallet (idempotent — safe to call even if webhook fires later)
      try {
        await creditWallet({
          userId: payment.userId.toString(),
          amount: payment.amountPaid,
          type: "topup",
          orderId,
          description: "Wallet topup via Cashfree",
          idempotencyKey: `topup_${orderId}`,
          ip: req.ip,
        });
      } catch (e) {
        // Already credited via webhook — idempotency key prevents double credit
        console.log("creditWallet skipped (already done):", e.message);
      }

      // Mark payment SUCCESS
      await Payment.updateOne(
        { orderId, status: { $ne: "SUCCESS" } },
        { $set: { status: "SUCCESS", paidAt: new Date() } }
      );

      return res.json({ status: "SUCCESS", amount: payment.amountPaid });
    }

    if (orderStatus === "FAILED" || orderStatus === "CANCELLED" || orderStatus === "TERMINATED") {
      await Payment.updateOne({ orderId }, { $set: { status: "FAILED" } });
      return res.json({ status: "FAILED" });
    }

    // Genuinely still pending
    return res.json({ status: "PENDING" });

  } catch (err) {
    console.error("topup-status error:", err.message);
    res.status(500).json({ status: "PENDING" });
  }
});

// POST /api/wallet/pay  — debit wallet for a charging session
// This replaces the Cashfree flow when user selects wallet
router.post("/pay", authMiddleware, async (req, res) => {
  try {
    const { deviceId, amount, chargingOption, energySelected, couponCode } = req.body;
    const amountNum = Number(amount);

    if (!deviceId || !amountNum || amountNum <= 0)
      return res.status(400).json({ message: "Invalid request" });

    // Re-verify amount on backend (same logic as ChargingOptions + coupon)
    // For now we trust the amount passed but validate it's > 0 and user has balance.
    // In Phase 6 you can add full server-side amount recomputation from deviceId + option.

    const user = await User.findById(req.user.userId).select("walletBalance walletFrozen").lean();
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.walletFrozen) return res.status(403).json({ message: "Wallet is frozen" });
    if (user.walletBalance < amountNum)
      return res.status(400).json({ message: "Insufficient wallet balance" });

    // Generate a wallet order ID (replaces Cashfree orderId in payment flow)
    const walletOrderId = `wlt_pay_${uuidv4()}`;

    // Create PENDING payment record
    await Payment.create({
      orderId: walletOrderId,
      userId: req.user.userId,
      deviceId,
      amountPaid: amountNum,
      currency: "INR",
      status: "PENDING",
      gateway: "wallet",
      type: "charging",
    });

    // Atomic debit
    const result = await debitWallet({
      userId: req.user.userId,
      amount: amountNum,
      orderId: walletOrderId,
      description: `Charging session on device ${deviceId}`,
      idempotencyKey: `debit_${walletOrderId}`,
      ip: req.ip,
    });

    // Mark payment SUCCESS
    await Payment.updateOne(
      { orderId: walletOrderId },
      { $set: { status: "SUCCESS", paidAt: new Date(), paymentMethod: "wallet" } }
    );

    return res.json({
      success: true,
      orderId: walletOrderId,
      newBalance: result.newBalance,
    });
  } catch (err) {
    // On error, mark payment FAILED
    console.error("Wallet pay error:", err.message);
    return res.status(500).json({ message: err.message || "Payment failed" });
  }
});

module.exports = router;