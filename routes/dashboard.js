// routes/dashboard.js
// Minimal data required by the customer landing page.
// This endpoint intentionally avoids returning full session/payment documents.

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const Session = require("../models/session");
const Payment = require("../models/Payment");
const User = require("../models/User");

router.get("/summary", authMiddleware, async (req, res) => {
  try {
    // 1. Get the user ID from the verified JWT token.
    const userIdString = req.user?.userId;

    if (!mongoose.Types.ObjectId.isValid(userIdString)) {
      return res.status(400).json({
        message: "Invalid userId in token.",
      });
    }

    const userId = new mongoose.Types.ObjectId(userIdString);

    // 2. Fetch only the wallet balance required by the dashboard.
    const user = await User.findById(userId)
      .select("walletBalance")
      .lean();

    if (!user) {
      return res.status(404).json({
        message: "User not found.",
      });
    }

    // 3. Fetch the user's active session, if one exists.
    // Follows the existing sessions route convention: endTime is null.
    const activeSessionDoc = await Session.findOne({
      userId,
      endTime: null,
    })
      .sort({ startTime: -1 })
      .select(
        "sessionId deviceId energySelected energyConsumed " +
        "amountPaid amountUsed ratePerKwh status startTime endTime"
      )
      .lean();

    // 4. Fetch only the latest session, not the complete session history.
    const lastSessionDoc = await Session.findOne({ userId })
      .sort({ startTime: -1 })
      .select(
        "sessionId deviceId energySelected energyConsumed " +
        "amountPaid amountUsed ratePerKwh status startTime endTime"
      )
      .lean();

    // 5. Fetch the latest successful charging payment.
    // Excludes wallet top-ups and never returns rawResponse.
    const paymentDoc = await Payment.findOne({
      userId,
      status: "SUCCESS",
      type: { $ne: "wallet_topup" },
    })
      .sort({ createdAt: -1 })
      .select(
        "orderId sessionId deviceId amountPaid currency status " +
        "paymentMethod paymentGroup gateway paidAt createdAt"
      )
      .lean();

    // 6. Return an explicit allowlist of session fields.
    const shapeSession = (session) => {
      if (!session) return null;

      return {
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        energySelected: session.energySelected ?? 0,
        energyConsumed: session.energyConsumed ?? 0,
        amountPaid: session.amountPaid ?? 0,
        amountUsed: session.amountUsed ?? 0,
        ratePerKwh: session.ratePerKwh ?? 0,
        status: session.status ?? null,
        startTime: session.startTime ?? null,
        endTime: session.endTime ?? null,
      };
    };

    // 7. Return only what the landing page needs.
    return res.status(200).json({
      success: true,

      wallet: {
        balance: user.walletBalance ?? 0,
      },

      activeSession: shapeSession(activeSessionDoc),

      lastSession: shapeSession(lastSessionDoc),

      lastSuccessfulPayment: paymentDoc
        ? {
            orderId: paymentDoc.orderId ?? null,
            sessionId: paymentDoc.sessionId ?? null,
            deviceId: paymentDoc.deviceId ?? null,
            amountPaid: paymentDoc.amountPaid ?? 0,
            currency: paymentDoc.currency ?? "INR",
            status: paymentDoc.status,
            paymentMethod: paymentDoc.paymentMethod ?? null,
            paymentGroup: paymentDoc.paymentGroup ?? null,
            gateway: paymentDoc.gateway ?? null,
            paidAt:
              paymentDoc.paidAt ??
              paymentDoc.createdAt ??
              null,
          }
        : null,
    });
  } catch (error) {
    console.error("Dashboard summary error:", error);

    return res.status(500).json({
      message: "Could not fetch dashboard summary.",
    });
  }
});

module.exports = router;