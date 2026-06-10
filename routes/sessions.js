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
// GET /api/sessions/all?status=&deviceId=&search=&project=&from=&to=&page=1&limit=500
router.get("/all", authMiddleware, async (req, res) => {
  try {
    const {
      status,
      deviceId,
      search,
      project,        // ← NEW
      from,
      to,
      page = 1,
      limit = 1000,
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

    /* ================= PROJECT FILTER (NEW) ================= */
    if (project) {
      const projectDevices = await Device.find(
        { project },
        "device_id"
      ).lean();
      const projectDeviceIds = projectDevices.map((d) => d.device_id);

      if (!projectDeviceIds.length) {
        // No devices in this project → return empty immediately
        return res.json({ total: 0, page: 1, limit: parseInt(limit), sessions: [] });
      }

      // If owner restriction already set, intersect; otherwise set directly
      if (q.deviceId?.$in) {
        const intersect = projectDeviceIds.filter((id) =>
          q.deviceId.$in.includes(id)
        );
        q.deviceId = { $in: intersect.length ? intersect : ["__none__"] };
      } else {
        q.deviceId = { $in: projectDeviceIds };
      }
    }

    if (status) q.status = status;
    if (deviceId) q.deviceId = deviceId; // explicit deviceId overrides project filter

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
        "ratePerKwh endTrigger lastUpdate updatedAt telemetry " +        // ← space added
        "latestVoltage latestCurrent latestPower"
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
    devices.forEach((d) => { deviceMap[d.device_id] = d; });

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

        latestVoltage: lastTele?.voltage ?? s.latestVoltage ?? null,
        latestCurrent: lastTele?.current ?? s.latestCurrent ?? null,

        lastUpdate: s.lastUpdate ?? lastTele?.timestamp ?? s.updatedAt ?? s.endTime ?? s.startTime,

        user: s.userId
          ? {
              _id: s.userId._id,
              name: s.userId.name,
              email: s.userId.email,
              mobile: s.userId.mobile,
            }
          : null,

        device: device
          ? {
              _id: device._id,
              device_id: device.device_id,
              project: device.project ?? null,   // ← expose project in response too
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

    res.json({ total, page: pageNum, limit: lim, sessions: shaped });
  } catch (error) {
    console.error("Error fetching sessions:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/sessions/admin/filters
// Returns distinct projects from devices that have had any session
router.get("/admin/filters", authMiddleware, async (req, res) => {
  try {
    const deviceIds = await Session.distinct("deviceId");
    const devices = await Device.find(
      { device_id: { $in: deviceIds }, project: { $exists: true, $ne: "" } },
      { project: 1 }
    ).lean();
    const projects = [...new Set(devices.map((d) => d.project).filter(Boolean))].sort();
    res.json({ projects });
  } catch (err) {
    console.error("Session filters fetch error:", err);
    res.status(500).json({ error: "Could not fetch filters" });
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
router.post("/payment-success",authMiddleware, async (req, res) => {
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



// GET /api/sessions/device-eta/:deviceId
// Returns estimated end time of the active session on a device (public info — no private data exposed)
router.get('/device-eta/:deviceId', authMiddleware, async (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const session = await Session.findOne({ deviceId, status: 'active' })
      .select('estimatedEndTime startTime energySelected energyConsumed')
      .lean();

    if (!session) {
      return res.status(404).json({ error: 'No active session on this device' });
    }

    return res.json({
      estimatedEndTime: session.estimatedEndTime || null,
      startTime: session.startTime || null,
      // progress hint — helps FE show "X% done, ~Ym left" without exposing PII
      energyProgressPercent: session.energySelected > 0
        ? Math.round((session.energyConsumed / session.energySelected) * 100)
        : 0,
    });
  } catch (err) {
    console.error('device-eta error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});
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
