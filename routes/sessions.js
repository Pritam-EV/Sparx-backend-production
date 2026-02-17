const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require('../middleware/roleMiddleware');
const mongoose = require("mongoose");
const Session = require("../models/session");
const { body } = require('express-validator');
const Coupon = require('../models/Coupon');
const Device = require('../models/device');
const {
  startSession,
  endSession,
  pauseSession, 
  resumeSession,  
  getSessionByTransactionId,
  getSessionById,
  getLiveDeviceSensorData,
  getActiveSession,
  getOwnerLiveChargingSessions,
  getOwnerPastSessions,
  getOwnerAnalytics,
} = require("../controllers/sessionController");


// Example: Only admins can see all sessions in the system
// routes/sessions.js
// GET /api/sessions/all?status=&deviceId=&search=&from=&to=&page=1&limit=100
router.get("/all", authMiddleware, async (req, res) => {
  try {
    const {
      status,
      deviceId,
      search,
      from,
      to,
      page = 1,
      limit = 100,
    } = req.query;

    const q = {};

    /* ================= OWNER RESTRICTION ================= */
    if (req.user?.role === "owner") {
      const owned = await Device.find(
        { ownerId: req.user.userId },
        "device_id"
      );
      const ids = owned.map((d) => d.device_id);
      q.deviceId = { $in: ids.length ? ids : ["__none__"] };
    }

    if (status) q.status = status;
    if (deviceId) q.deviceId = deviceId;

    if (from || to) {
      q.startTime = {};
      if (from) q.startTime.$gte = new Date(from);
      if (to) q.startTime.$lte = new Date(to);
    }

    if (search) {
      q.$or = [
        { sessionId: new RegExp(search, "i") },
        { deviceId: new RegExp(search, "i") },
        { transactionId: new RegExp(search, "i") },
      ];
    }

    const pageNum = Math.max(1, parseInt(page));
    const lim = Math.min(Math.max(1, parseInt(limit)), 500);
    const skip = (pageNum - 1) * lim;

    /* ================= QUERY ================= */

    const sessions = await Session.find(q)
      .select(
        "sessionId deviceId transactionId userId startTime endTime status " +
        "energyConsumed energySelected amountPaid amountUsed discountApplied " +
        "ratePerKwh endTrigger lastUpdate updatedAt telemetry"
      )
      .populate("userId", "name email mobile")
      .sort({ startTime: -1 })
      .skip(skip)
      .limit(lim)
      .lean();

    /* ================= FETCH DEVICES + OWNERS ================= */

    const deviceIds = sessions.map((s) => s.deviceId);
    const devices = await Device.find({ device_id: { $in: deviceIds } })
      .populate("ownerId", "name email mobile")
      .lean();

    const deviceMap = {};
    devices.forEach((d) => {
      deviceMap[d.device_id] = d;
    });

    /* ================= SHAPE RESPONSE ================= */

    const shaped = sessions.map((s) => {
      const lastTele =
        Array.isArray(s.telemetry) && s.telemetry.length
          ? s.telemetry[s.telemetry.length - 1]
          : null;

      const device = deviceMap[s.deviceId];

      return {
        _id: s._id,
        sessionId: s.sessionId,
        deviceId: s.deviceId,
        transactionId: s.transactionId,
        status: s.status,

        startTime: s.startTime,
        endTime: s.endTime,
        endTrigger: s.endTrigger ?? null,

        energyConsumed: s.energyConsumed,
        energySelected: s.energySelected,

        amountPaid: s.amountPaid,
        amountUsed: s.amountUsed,
        discountApplied: s.discountApplied ?? 0,
        ratePerKwh: s.ratePerKwh ?? 0,

        latestVoltage: lastTele?.voltage ?? null,
        latestCurrent: lastTele?.current ?? null,

        lastUpdate:
          s.lastUpdate ?? s.updatedAt ?? s.endTime ?? s.startTime,

        /* ---------- USER ---------- */
        user: s.userId
          ? {
              _id: s.userId._id,
              name: s.userId.name,
              email: s.userId.email,
              mobile: s.userId.mobile,
            }
          : null,

        /* ---------- DEVICE + OWNER ---------- */
        device: device
          ? {
              _id: device._id,
              device_id: device.device_id,
              owner: device.ownerId
                ? {
                    _id: device.ownerId._id,
                    name: device.ownerId.name,
                    email: device.ownerId.email,
                    mobile: device.ownerId.mobile,
                  }
                : null,
            }
          : null,
      };
    });

    const total = await Session.countDocuments(q);

    res.json({
      total,
      page: pageNum,
      limit: lim,
      sessions: shaped,
    });
  } catch (error) {
    console.error("Error fetching sessions:", error);
    res.status(500).json({ message: "Server error" });
  }
});





// Owner/customer: fetch current user's sessions
router.get("/user-sessions", authMiddleware, async (req, res) => {
  try {
    const userIdString = req.user.userId;
    if (!mongoose.Types.ObjectId.isValid(userIdString)) {
      return res.status(400).json({ message: "Invalid userId in token." });
    }
    const userId = new mongoose.Types.ObjectId(userIdString);
    const sessions = await Session.find({ userId }).sort({ startTime: -1 });
    const activeSessions = sessions.filter(s => !s.endTime);
    const pastSessions = sessions.filter(s => s.endTime);
    res.json({ activeSessions, pastSessions });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// 3. Active session lookup (unchanged)
// Add this route for getting the active session of the authenticated user
router.get('/active', authMiddleware, getActiveSession);

// 4. Start session (Triggered after payment success)
router.post("/start", authMiddleware, startSession);

router.post("/pause", authMiddleware, pauseSession);

router.post("/resume", authMiddleware, resumeSession);

// 5. Stop session
router.post("/stop", authMiddleware, endSession);

// 6. Payment success webhook
router.post("/payment-success", async (req, res) => {
  const { transactionId, deviceId, sessionId, startTime, amountPaid, energySelected } = req.body;
  const userId = req.user.userId;                // ← capture userId
  try {
    if (!transactionId || !deviceId || !sessionId || !startTime) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    const existingSession = await Session.findOne({ transactionId });
    if (existingSession) {
      return res
        .status(200)
        .json({ message: "Session already exists", session: existingSession });
    }
    // ✅ Fetch actual device rate
const device = await Device.findOne({ device_id: deviceId }).lean();
const ratePerKwh = Number(device?.rate ?? 20);

    const newSession = await Session.create({
      sessionId,
      deviceId,
      transactionId,
      startTime,
      status: "active",
      amountPaid,
      energySelected,
      userId,      
      ratePerKwh,
    });
    res.status(200).json({ message: "Session created successfully after payment.", session: newSession });
  } catch (err) {
    console.error("Error handling payment success:", err);
    res.status(500).json({ error: "Failed to process payment success." });
  }
});

router.get("/owner/live-charging", authMiddleware, getOwnerLiveChargingSessions);
router.get("/owner/past-sessions", authMiddleware, getOwnerPastSessions);
router.get("/owner/analytics", authMiddleware, getOwnerAnalytics);

// 7. Update session data every 5 seconds
router.post("/update", async (req, res) => {
  const { sessionId, energyConsumed, amountUsed } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  const session = await Session.findOne({ sessionId });
  if (!session) return res.status(404).json({ error: "Session not found" });
  session.energyConsumed = energyConsumed;
  session.amountUsed = amountUsed;
  await session.save();
  res.json({ message: "Updated" });
});

// 9. Optional: fetch live sensor data for a device
router.get("/device/:deviceId/sensor", authMiddleware, getLiveDeviceSensorData);

// 2. Fetch session by session ID (for LiveSession page)
router.get("/:sessionId", authMiddleware, getSessionById);

// Protected route: authenticate user (e.g. via JWT or session)
router.post('/api/coupons/apply', authMiddleware, [
  body('code').isString().trim().escape(),
  body('deviceId').isString().trim(),
  body('amount').isNumeric()
], async (req, res) => {
  try {
    const { code, deviceId, amount } = req.body;
    const userId = req.user.id;  // assume auth middleware sets req.user

    // Fetch the coupon document
    const coupon = await Coupon.findOne({ code, isActive: true });
    if (!coupon) {
      return res.status(404).json({ error: 'Invalid coupon code' });
    }
    // Validate expiry
    if (coupon.expiryDate < new Date()) {
      return res.status(400).json({ error: 'Coupon has expired' });
    }
    // Check usage limit
    if (coupon.usageLimit != null && coupon.usageCount >= coupon.usageLimit) {
      return res.status(400).json({ error: 'Coupon usage limit reached' });
    }
    // Check allowed users/devices
    if (coupon.allowedUsers.length && !coupon.allowedUsers.includes(userId)) {
      return res.status(403).json({ error: 'Coupon not valid for this user' });
    }
    if (coupon.allowedDevices.length && !coupon.allowedDevices.includes(deviceId)) {
      return res.status(403).json({ error: 'Coupon not valid for this device' });
    }
    // Calculate discounted price on server (do NOT trust client calculation):contentReference[oaicite:6]{index=6}
    let newAmount = amount;
    if (coupon.discountType === 'amount') {
      newAmount = Math.max(amount - coupon.discountAmount, 0);
    } else {  // percent
      newAmount = Math.max(amount * (1 - coupon.discountAmount/100), 0);
    }
    newAmount = Math.round(newAmount * 100) / 100;  // round to 2 decimals if needed

    // Increment usage count atomically
    coupon.usageCount += 1;
    await coupon.save();

    // If final price is zero, generate a custom transaction ID
    if (newAmount === 0) {
      const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2)}`;
      return res.json({ newAmount, transactionId });
    }
    return res.json({ newAmount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
