const mongoose = require("mongoose");
const Session = require("../models/session");
const Device = require("../models/device");
const mqttClient = require('../mqttClient');
const Coupon = require('../models/Coupon');
const CouponReservation = require('../models/CouponReservation');
const Receipt = require('../models/Receipt');
const crypto = require("crypto");
function rand(len = 8) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len).toUpperCase();
}


async function logCommand(sessionId, { type, topic, payload, mqtt = {} }) {
  await Session.updateOne(
    { _id: sessionId },
    { $push: { commands: { at: new Date(), type, topic, payload, mqtt } } }
  );
}


// ✅ GET /api/sessions/active
// controllers/sessionController.js
const getActiveSession = async (req, res) => {
  try {
    const userId = req.user.userId;
    console.log(`Fetching active session for user ${userId}`);

    // 1) Find active session for this user
    const session = await Session.findOne({ userId, status: 'active' }).lean();
    if (!session) {
      console.warn('No active session found');
      return res.status(404).json({ error: 'No active session' });
    }

    // 2) Try get the linked device
    const device = await Device.findOne({ device_id: session.deviceId }).lean();

    // 3) Prefer session.latest* fields, fallback to device fields
    const voltage = (typeof session.latestVoltage === 'number' && session.latestVoltage !== 0)
      ? session.latestVoltage
      : (device ? Number(device.voltage) || 0 : 0);

    const current = (typeof session.latestCurrent === 'number' && session.latestCurrent !== 0)
      ? session.latestCurrent
      : (device ? Number(device.current) || 0 : 0);

    const power = (typeof session.latestPower === 'number' && session.latestPower !== 0)
      ? session.latestPower
      : (device ? Number(device.power) || 0 : 0);

    const relayState = device && typeof device.relayOn === 'boolean'
      ? (device.relayOn ? 'ON' : 'OFF')
      : 'OFF';

    // 4) Prepare response data for FE
    const responseData = {
      sessionId: session.sessionId,
      transactionId: session.transactionId,
      deviceId: session.deviceId,
      energySelected: session.energySelected,
      amountPaid: session.amountPaid,
      energyConsumed: Number(session.energyConsumed) || 0,
      startDate: session.startDate,
      startTime: session.startTime,
      voltage,
      current,
      power,
      relayState,
      status: device ? device.status : "Unknown"
    };

    console.log('[DEBUG] getActiveSession responseData:', responseData);
    return res.json(responseData);

  } catch (error) {
    console.error('Error in getActiveSession:', error);
    return res.status(500).json({ error: 'Server error fetching active session' });
  }
};


// ✅ POST /api/sessions/start
const startSession = async (req, res) => {
  try {
    const {
      sessionId,
      deviceId,
      startTime,
      startDate,
      energySelected,
      amountSelected,
      discountApplied,
      amountPaid,
      startEnergy
    } = req.body;
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: userId missing" });
    }
    const userObjectId = new mongoose.Types.ObjectId(userId);

    let transactionId = req.body.transactionId;
if (!transactionId) {
  transactionId = `FREE_${rand(12)}`;
}

    

    // 1) Validate required fields
    if (
      !sessionId ||
      !deviceId ||
      !transactionId ||
      !startTime ||
      !startDate ||
      energySelected === undefined ||
      amountPaid === undefined
    ) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    // 2) Duplicate transaction check
    if (await Session.findOne({ transactionId })) {
      return res.status(409).json({ error: "Transaction already exists." });
    }

    // 3) Device lookup & availability check
    const device = await Device.findOne({ device_id: deviceId });
    if (!device) {
      return res.status(404).json({ error: "Device not found." });
    }
    if (device.status === "Occupied") {
      return res.status(409).json({ error: "Device is currently occupied." });
    }
    // ✅ Always derive ratePerKwh from device at start time
    const ratePerKwh = Number(device.rate ?? 20);


        // inside startSession handler, after validation of required fields, etc.
const { couponCode, reservationId } = req.body;

// Consume coupon if supplied
let consumedCoupon = null;
if (couponCode) {
  const codeUpper = String(couponCode).trim().toUpperCase();
  const coupon = await Coupon.findOne({ code: codeUpper, isActive: true });
  if (!coupon) {
    return res.status(400).json({ error: 'Coupon invalid at start' });
  }
  // check expiry & allowedUsers/devices again for safety
  if (coupon.expiryDate && coupon.expiryDate < new Date()) return res.status(400).json({ error: 'Coupon expired' });
  if (coupon.allowedUsers && coupon.allowedUsers.length > 0) {
    const allowed = coupon.allowedUsers.some(u => u.toString() === req.user.userId.toString());
    if (!allowed) return res.status(403).json({ error: 'Coupon not valid for this user' });
  }
  if (coupon.allowedDevices && coupon.allowedDevices.length > 0) {
    if (!coupon.allowedDevices.includes(deviceId)) {
      return res.status(403).json({ error: 'Coupon not valid for this device' });
    }
  }

  // If reservationId exists, validate reservation belongs to this user and hasn't expired
  if (reservationId) {
// Find reservation by id (reservationId is expected as string)
      const resv = await CouponReservation.findOne({ _id: reservationId, couponId: coupon._id });
      if (!resv) {
        return res.status(400).json({ error: 'Coupon reservation invalid or expired' });
      }
      // ensure reservation belongs to user and device
      if (resv.userId.toString() !== req.user.userId.toString() || resv.deviceId !== deviceId) {
        return res.status(403).json({ error: 'Reservation does not match user/device' });
      }

      // Atomically increment usageCount only if current usageCount < usageLimit (or unlimited)
      if (coupon.usageLimit == null) {
       await Coupon.updateOne(
        { _id: coupon._id },
        {
          $set: {
            usageCount: Number(coupon.usageCount || 0) + 1
          }
        }
      );

      } else {
        const updated = await Coupon.findOneAndUpdate(
           { _id: coupon._id },
            {
              $set: {
                usageCount: Number(coupon.usageCount || 0) + 1
              }
            },
          { new: true }
        );
        if (!updated) {
          return res.status(400).json({ error: 'Coupon usage limit reached' });
        }
      }
      // delete reservation now that it's consumed
      await CouponReservation.deleteOne({ _id: resv._id });


    consumedCoupon = coupon; // mark consumed
  } else {
    // No reservation - attempt atomic consumption directly
    if (coupon.usageLimit == null) {
      await Coupon.updateOne(
        { _id: coupon._id },
        {
          $set: {
            usageCount: Number(coupon.usageCount || 0) + 1
          }
        }
      );

    } else {
      const updated = await Coupon.findOneAndUpdate(
        { _id: coupon.id, usageLimit: null },
        { $set: { usageCount: Number(coupon.usageCount || 0) + 1 } },
        { new: true }
      );
      // Similar for usageLimit check, replace $inc with $set: { usageCount: current + 1 }

      if (!updated) return res.status(400).json({ error: 'Coupon usage limit reached' });
    }
    consumedCoupon = coupon;
  }
}
    // 4) Create new session and save
      const newSession = new Session({
        sessionId,
        deviceId,
        transactionId,
        userId: userId,        // Mongoose will cast string to ObjectId
        startTime: new Date(startTime),
        startDate,
        energySelected,
        amountPaid,
        amountSelected,
        discountApplied, 
        status: "active",
        ratePerKwh
      });
    await newSession.save();

    const Payment = require("../models/Payment");

await Payment.updateOne(
  { orderId: transactionId },
  {
    $set: {
      sessionId: sessionId,
      deviceId: deviceId,
      userId: userId,
    },
  }
);


    // 5) Update device and publish MQTT start command
    device.status = "Occupied";
    device.current_session_id = newSession._id;
    device.relayOn = true;
    await device.save();

      const topic = `viz/${deviceId}/sessionCommand`;

      // Line 120: CORRECT PASSCASE PAYLOAD
      const payload = {
        command: "start",
        SessionId: sessionId,           // ✅ Firmware expects PascalCase
        UserId: userId,                 // ✅ Firmware expects PascalCase  
        TransactionId: transactionId,
        SelectedEnergy: parseFloat(energySelected),
        AmountPaid: parseFloat(amountPaid),
      };


    console.log("📡 Publishing START to device:", topic, payload);
    // log the intent
    await logCommand(newSession._id, {
      type: "start",
      topic,
      payload,
      mqtt: { publishedAt: new Date() }
    });
mqttClient.publish(
  topic,
  JSON.stringify(payload),
  { qos: 1, retain: false },
  (err) => {
    if (err) {
      console.error("❌ MQTT publish failed:", err);
    } else {
      console.log(`✅ MQTT start command sent to ${deviceId}`);
    }
  }
);
return res.status(201).json({
  message: "Session started successfully.",
  session: newSession,
});






  } catch (err) {
    console.error("Error starting session:", err);
    return res.status(500).json({ error: "Failed to start session." });
  }
};


// ✅ POST /api/sessions/pause
const pauseSession = async (req, res) => {
  try {
    const { sessionId, deviceId } = req.body;
    
    const session = await Session.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: "Session not found" });
    
    // Publish pause command
      const topic = `viz/${deviceId || session.deviceId}/sessionCommand`;
      const payload = { command: "pause", sessionId };

    
      await logCommand(session._id, {
        type: "pause",
        topic,
        payload,
        mqtt: { publishedAt: new Date() }
      });

      mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 }, async (err) => {
        if (err) {
          console.error("❌ MQTT pause failed:", err);
          await Session.updateOne(
            { _id: session._id, "commands.type": "pause" },
            { $set: { "commands.$.mqtt.error": String(err) } }
          );
          return res.status(500).json({ error: "Failed to pause session" });
        }
        await Session.updateOne(
          { _id: session._id },
          { $set: { lastUpdate: new Date() } }
        );
        console.log(`✅ MQTT pause sent to ${deviceId || session.deviceId}`);
        res.json({ message: "Session paused" });
      });

  } catch (err) {
    console.error("Error pausing session:", err);
    res.status(500).json({ error: "Failed to pause session" });
  }
};

// ✅ POST /api/sessions/resume  
const resumeSession = async (req, res) => {
  try {
    const { sessionId, deviceId } = req.body;
    
    const session = await Session.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: "Session not found" });
    
    // Publish resume command
    const topic = `viz/${deviceId || session.deviceId}/sessionCommand`;
    const payload = { command: "resume", sessionId };

    
        await logCommand(session._id, {
          type: "resume",
          topic,
          payload,
          mqtt: { publishedAt: new Date() }
        });

        mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 }, async (err) => {
          if (err) {
            console.error("❌ MQTT resume failed:", err);
            await Session.updateOne(
              { _id: session._id, "commands.type": "resume" },
              { $set: { "commands.$.mqtt.error": String(err) } }
            );
            return res.status(500).json({ error: "Failed to resume session" });
          }
          await Session.updateOne(
            { _id: session._id },
            { $set: { lastUpdate: new Date() } }
          );
          console.log(`✅ MQTT resume sent to ${deviceId || session.deviceId}`);
          res.json({ message: "Session resumed" });
        });

  } catch (err) {
    console.error("Error resuming session:", err);
    res.status(500).json({ error: "Failed to resume session" });
  }
};

// ✅ POST /api/sessions/stop
const endSession = async (req, res) => {
  console.log("Stop request received:", req.body);
  try {
    const { sessionId, endTime, endTrigger, currentEnergy, deltaEnergy, amountUsed, deviceId } = req.body;

    if (!sessionId || !endTime || !endTrigger) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const session = await Session.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: "Session not found." });

    
    // 1️⃣ Define energyConsumed so it’s available
    const energyConsumed = session.energyConsumed || 0;

    // 2️⃣ Compute amountUtilized and refund
    const device = await Device.findOne({ device_id: deviceId || session.deviceId });
    const rate = session.ratePerKwh ?? device?.rate ?? 20;
    const amountUtilized = Number((energyConsumed * rate).toFixed(2));
    const refund = Number(Math.max(0, session.amountPaid - amountUtilized).toFixed(2));

    // Update session
    session.endTime = new Date(endTime);
    session.endTrigger = endTrigger;
    if (deltaEnergy !== undefined) session.energyConsumed = deltaEnergy;
    if (amountUsed !== undefined) session.amountUsed = amountUsed;
    session.status = "completed";
    session.endEnergy = currentEnergy || session.startEnergy + session.energyConsumed;
    await session.save();


    // Free up device
    if (device) {
      const rate = device.rate || 20;
      device.status = "Available";
      const energyConsumed = session.energyConsumed;
      const amountUtilized = Number((energyConsumed * rate).toFixed(2));
      const refund = Number(Math.max(0, session.amountPaid - amountUtilized).toFixed(2));
      device.current_session_id = null;
      device.relayOn = false;
      await device.save();
    }

      // ✨ Calculate commission & paymentCharges
      const commission = Number((device.rate * energyConsumed).toFixed(2));
      const pgPercent = device.PGPercent || 2;
      const paymentCharges = Number(((session.amountPaid * pgPercent) / 100).toFixed(2));
    
      const receipt = new Receipt({
    receiptId: `VIZ_${rand(10)}`,
    userId: session.userId,
    deviceId: session.deviceId,
    sessionId: session.sessionId,
    transactionId: session.transactionId,
    energyConsumed,
    energySelected: session.energySelected,
    amountSelected: session.amountSelected,
    amountPaid: session.amountPaid,
    ratePerKwh: session.ratePerKwh, // ✅ NEW (rate stored at session start)
    discountApplied: session.discountApplied || 0,
    amountUtilized,
    refund,
    commission,          // ✨ NEW
    paymentCharges       // ✨ NEW
  });
  await receipt.save();

    // Publish stop command
const topic = `viz/${deviceId || session.deviceId}/sessionCommand`;
const payload = { 
  command: "stop", 
  SessionId: sessionId,          // ✅ PascalCase
  endTrigger 
};

console.log("📡 Publishing STOP to device:", topic, payload);
await logCommand(session._id, {
  type: "stop",
  topic,
  payload,
  mqtt: { publishedAt: new Date() }
});

    mqttClient.publish(topic, JSON.stringify(payload), { qos: 1, retain: false }, (err) => {
      if (err) {
        console.error("❌ MQTT publish failed (stop):", err);
        return res.status(500).json({ error: "Session ended locally but failed to send stop command" });
      }
      console.log(`✅ MQTT stop command sent to ${deviceId || session.deviceId}`);
      res.status(200).json({ message: "Session ended successfully.", session });
    });

  } catch (err) {
    console.error("Error ending session:", err);
    res.status(500).json({ error: "Failed to end session." });
  }
};


/**
 * @desc   Get session by session ID
 * @route  GET /api/sessions/:sessionId
 * @access Private
 */
const getSessionById = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await Session.findOne({ sessionId });
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }
    res.status(200).json(session);
  } catch (err) {
    console.error("Error fetching session by ID:", err);
    res.status(500).json({ error: "Server error." });
  }
};

/**
 * @desc   Get live sensor data for a device
 * @route  GET /api/sessions/device/:deviceId/sensor
 * @access Private
 */
const getLiveDeviceSensorData = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const device = await Device.findOne({ device_id: deviceId });
    if (!device) {
      return res.status(404).json({ error: "Device not found." });
    }
    res.status(200).json({
      voltage: device.voltage || 0,
      current: device.current || 0,
      energy: device.energy || 0,
      status: device.status
    });
  } catch (err) {
    console.error("Error fetching live sensor data:", err);
    res.status(500).json({ error: "Server error." });
  }
};

const getOwnerLiveChargingSessions = async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!mongoose.Types.ObjectId.isValid(ownerId)) {
      return res.status(400).json({ error: "Invalid ownerId" });
    }
    const ownerObjectId = new mongoose.Types.ObjectId(ownerId);

    // 1) Owner's devices (Device.ownerId is an array of ObjectIds)
    const devices = await Device.find({ ownerId: { $in: [ownerObjectId] } })
      .select("device_id location relayOn")
      .lean();

    if (!devices.length) return res.json({ sessions: [] });

    const deviceIds = devices.map((d) => d.device_id);
    const deviceMap = Object.fromEntries(devices.map((d) => [d.device_id, d]));

    // 2) Active sessions for those devices
    const sessions = await Session.find({
      deviceId: { $in: deviceIds },
      status: "active",
      endTime: null,
    })
      .populate("userId", "name vehicleNumber")
      .sort({ startTime: -1 })
      .lean();

    const shaped = sessions.map((s) => {
      const d = deviceMap[s.deviceId];
      const selected = Number(s.energySelected || 0);
      const consumed = Number(s.energyConsumed || 0);
      const progress = selected > 0 ? Math.min(100, (consumed / selected) * 100) : 0;

      return {
        sessionId: s.sessionId,
        deviceId: s.deviceId,
        address: d?.location || "—",
        relayOn: !!d?.relayOn,
        vehicleNumber: s.userId?.vehicleNumber || "—",
        userName: s.userId?.name || "—",
        startTime: s.startTime,
        energySelected: selected,
        energyConsumed: consumed,
        amountPaid: Number(s.amountPaid || 0),
        progressPercent: Math.round(progress),
      };
    });

    return res.json({ sessions: shaped });
  } catch (err) {
    console.error("getOwnerLiveChargingSessions error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};


const getOwnerPastSessions = async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!mongoose.Types.ObjectId.isValid(ownerId)) {
      return res.status(400).json({ error: "Invalid ownerId" });
    }
    const ownerObjectId = new mongoose.Types.ObjectId(ownerId);

    // 1) Owner's devices (ownerId is an array on Device)
    const devices = await Device.find({ ownerId: { $in: [ownerObjectId] } })
      .select("device_id location")
      .lean();

    if (!devices.length) return res.json({ sessions: [] });

    const deviceIds = devices.map((d) => d.device_id);
    const deviceMap = Object.fromEntries(devices.map((d) => [d.device_id, d]));

    // 2) Completed sessions for those devices
    const sessions = await Session.find({
      deviceId: { $in: deviceIds },
      status: "completed",
      endTime: { $ne: null },
    })
      .populate("userId", "name vehicleNumber")
      .sort({ endTime: -1 })
      .limit(200) // keep list fast; increase later if needed
      .lean();

    const shaped = sessions.map((s) => {
      const d = deviceMap[s.deviceId];
      const rate = Number(s.ratePerKwh || 0);
      const energy = Number(s.energyConsumed || 0);

      // amountUtilized in your backend logic is typically energyConsumed * ratePerKwh
      const amountUtilized = Number((energy * rate).toFixed(2));

      return {
        sessionId: s.sessionId,
        deviceId: s.deviceId,
        address: d?.location || "—",
        vehicleNumber: s.userId?.vehicleNumber || "—",
        startTime: s.startTime,
        endTime: s.endTime,
        energyUsed: Number(energy.toFixed(2)),
        amountUtilized,
      };
    });

    return res.json({ sessions: shaped });
  } catch (err) {
    console.error("getOwnerPastSessions error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

module.exports = {
  startSession,
  endSession,
  pauseSession, 
  resumeSession,
  getSessionById,
  getLiveDeviceSensorData,
  getActiveSession,
  getOwnerLiveChargingSessions,
  getOwnerPastSessions,
};
