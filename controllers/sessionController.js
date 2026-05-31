const mongoose = require("mongoose");
const Session = require("../models/session");
const Device = require("../models/device");
const mqttClient = require('../mqttClient');
const Coupon = require('../models/Coupon');
const CouponReservation = require('../models/CouponReservation');
const Receipt = require('../models/Receipt');
const User = require('../models/User');
const crypto = require("crypto");
const { creditWallet } = require("../services/walletService");
const Payment = require("../models/Payment");
const Refund = require('../models/Refund');
function rand(len = 8) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len).toUpperCase();
}


async function logCommand(sessionId, { type, topic, payload, mqtt = {} }) {
  await Session.updateOne(
    { _id: sessionId },
    { $push: { commands: { at: new Date(), type, topic, payload, mqtt } } }
  );
}

function getFinancialYearSegment(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12

  // FY starts in April
  let startYear, endYear;
  if (month >= 4) {
    startYear = year;
    endYear = year + 1;
  } else {
    startYear = year - 1;
    endYear = year;
  }

  // 2026-27 → "202627"
  const start = String(startYear);
  const end = String(endYear).slice(-2);
  return `${start}${end}`;
}

async function generateReceiptId({ isFreeViz, now = new Date() }) {
  const month = String(now.getMonth() + 1).padStart(2, '0'); // "05"

  if (isFreeViz) {
    // VIZTEST-05-001 style
    const prefix = `VIZTEST-${month}-`;

    const last = await Receipt
      .findOne({ receiptId: { $regex: `^${prefix}` } })
      .sort({ createdAt: -1 })
      .lean();

    let nextSeries = 1;
    if (last?.receiptId) {
      const parts = last.receiptId.split('-');
      const lastNum = parts[2] || '';
      const parsed = parseInt(lastNum, 10);
      if (!Number.isNaN(parsed)) nextSeries = parsed + 1;
    }

    const series = String(nextSeries).padStart(3, '0'); // 001, 002...
    return `${prefix}${series}`;
  }

  // Main GST series: VIZ-202627-05-0001
  const fySegment = getFinancialYearSegment(now); // "202627"
  const prefix = `VIZ-${fySegment}-${month}-`;

  const last = await Receipt
    .findOne({ receiptId: { $regex: `^${prefix}` } })
    .sort({ createdAt: -1 })
    .lean();

  let nextSeries = 1;
  if (last?.receiptId) {
    const parts = last.receiptId.split('-');
    const lastNum = parts[3] || '';
    const parsed = parseInt(lastNum, 10);
    if (!Number.isNaN(parsed)) nextSeries = parsed + 1;
  }

  const series = String(nextSeries).padStart(4, '0'); // 0001, 0002...
  return `${prefix}${series}`;
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
      estimatedEndTime: session.estimatedEndTime || null, 
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
        ratePerKwh,
        paymentGateway: req.body.paymentGateway || "cashfree",
      });
    await newSession.save();



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


async function completeSessionInternal({
  sessionId, endTime, endTrigger, deltaEnergy,
  amountUsed, currentEnergy, deviceIdOverride, sendStopMqtt = false
}) {

  // ── ATOMIC LOCK: only one caller wins this update ──────────────────────
  // Replace the old findOne + status check with an atomic findOneAndUpdate.
  // If session is already "completed" or "completing", the $ne filter won't match
  // and we get null back — safe no-op for the losing caller.
  const session = await Session.findOneAndUpdate(
    { sessionId, status: { $in: ["active", "paused"] } },   // only grab if still live
    { $set: { status: "completing" } },                      // mark in-flight immediately
    { new: false }                                           // return OLD doc (pre-update)
  );

  if (!session) {
    // Already completing or completed — return existing receipt safely
    const existingSession = await Session.findOne({ sessionId });
    const existingReceipt = await Receipt.findOne({ sessionId });
    return { session: existingSession, receipt: existingReceipt };
  }

  // From here only ONE caller proceeds — the other got null above
  const device = await Device.findOne({ device_id: deviceIdOverride || session.deviceId });

  if (deltaEnergy !== undefined) session.energyConsumed = Number(deltaEnergy) || 0;
  if (amountUsed !== undefined) session.amountUsed = amountUsed;

  const rate = session.ratePerKwh ?? device?.rate ?? 20;
  const energyConsumed = Number(session.energyConsumed || 0);
  const amountUtilized = Number((energyConsumed * rate).toFixed(2));
  const refund = Number(Math.max(0, Number(session.amountPaid || 0) - amountUtilized).toFixed(2));

  // Save final completed state (overwrite "completing")
  await Session.updateOne({ sessionId }, {
    $set: {
      energyConsumed,
      amountUsed: amountUtilized,
      endTime: new Date(endTime),
      endTrigger,
      status: "completed",
      endEnergy: currentEnergy || (session.startEnergy || 0) + energyConsumed,
    }
  });

  if (device) {
    device.status = "Available";
    device.current_session_id = null;
    device.relayOn = false;
    await device.save();
  }

  // ── RECEIPT (idempotent via unique sessionId index) ────────────────────
  let receipt = await Receipt.findOne({ sessionId: session.sessionId });
  if (!receipt) {
    const GST_RATE = 0.18;
    const userRatePerKwh = Number(device?.commercial?.userRatePerKwh ?? device?.rate ?? session.ratePerKwh ?? 0);
    let effectiveUserRatePerKwh = userRatePerKwh;
    if (!device?.commercial?.userRatePerKwh && device?.rate) {
      effectiveUserRatePerKwh = Number((Number(device.rate) / (1 + GST_RATE)).toFixed(6));
    }

    const energy = Number(energyConsumed || 0);
    const userRateInclGST = Number((effectiveUserRatePerKwh * 1.18).toFixed(2));
    const taxableAmount = Number((energy * effectiveUserRatePerKwh).toFixed(2));
    const gstAmount = Number((taxableAmount * GST_RATE).toFixed(2));
    const totalAmount = Number((taxableAmount + gstAmount).toFixed(2));
    const commissionPerKwh = Number(device?.commercial?.vjraMarginPerKwh ?? device?.commissionPerKwh ?? 0);
    const vjraMarginAmount = Number((commissionPerKwh * energy).toFixed(2));
    const pgPercent = Number(device?.commercial?.pgPercent ?? device?.PGPercent ?? 0);
    const paymentCharges = Number((Number(session.amountPaid || totalAmount) * (pgPercent / 100)).toFixed(2));
    const electricityCostPerKwh = Number(device?.commercial?.ownerSharePerKwh ?? 0);
    const electricityCost = Number((electricityCostPerKwh * energy).toFixed(2));
    let ownerPayout = Number((taxableAmount - vjraMarginAmount - electricityCost).toFixed(2));
    if (ownerPayout < 0) ownerPayout = 0;
    const refundAmount = Number(refund || 0);

    // Determine payment gateway for this session
    const paymentRecord = await Payment.findOne({ orderId: session.transactionId }).lean();
    const isWalletPay = paymentRecord?.gateway === "wallet";

    // ── Snapshot user and device metadata for receipt ─────────────────────
const userDoc = await User.findById(session.userId).select('name email mobile gstin').lean();

    // For wallet sessions: refund goes to wallet immediately → status = "wallet_refunded"
    // For cashfree sessions: refund is initiated via Cashfree → status = "initiated"
    let refundStatus = "not_applicable";
    if (refundAmount > 0) {
      refundStatus = isWalletPay ? "wallet_refunded" : "initiated";
    }
// Determine if this is FREEVIZ (test) receipt
// You don’t currently store couponCode on Session, so use amountPaid === 0 AND wallet/free payment gateway
const isZeroAmount = Number(session.amountPaid || 0) === 0;

// If you prefer strictly coupon-based:
// const isFreeViz = (paymentRecord?.couponCode === 'FREEVIZ'); // requires you to store couponCode in Payment

const isFreeViz = isZeroAmount; // for now: any zero-paid session → VIZTEST series

const receiptId = await generateReceiptId({
  isFreeViz,
  now: new Date(),
});

    receipt = new Receipt({
      receiptId,
      userId: session.userId,
      deviceId: session.deviceId,
      sessionId: session.sessionId,
      transactionId: session.transactionId,


  // ── USER SNAPSHOT (NEW) ──────────────────────────
  userName:     userDoc?.name   || "",
  userEmail:    userDoc?.email  || "",
  userMobile:   userDoc?.mobile || "",
  userGstin:    userDoc?.gstin  || "",

  // ── OWNER SNAPSHOT (NEW) ─────────────────────────
  ownerId:      device?.ownerId?.[0] || null,

  // ── DEVICE SNAPSHOT (NEW) ────────────────────────
  deviceCity:     device?.city     || "",
  deviceState:    device?.state    || "",
  deviceArea:     device?.area     || "",
  deviceLocation: device?.location || "",
  placeOfSupply:  device?.state    || "",   // ← KEY FIELD for GST bifurcation

  // ── PAYMENT GATEWAY (NEW) ────────────────────────
  paymentGateway: isWalletPay ? "wallet" : (session.paymentGateway || "cashfree"),


      energyConsumed: energy,
      energySelected: session.energySelected,
      amountSelected: session.amountSelected,
      amountPaid: Number(session.amountPaid || 0),
      userRatePerKwh: Number(effectiveUserRatePerKwh),
      userRateInclGST,
      taxableAmount,
      gstAmount,
      totalAmount,
      amountUtilized: Number(amountUtilized || 0),
      refundAmount,
      discountApplied: session.discountApplied || 0,
      commissionPerKwh: Number(commissionPerKwh),
      vjraMarginAmount,
      PGPercent: pgPercent,
      paymentCharges,
      electricityCostPerKwh,
      electricityCost,
      ownerPayout,
      refund: {
        status: refundStatus,
        refundId: refundAmount > 0 ? `REF${rand(8)}` : undefined,
        initiatedAt: refundAmount > 0 ? new Date() : undefined,
      }
    });
    await receipt.save();

    // ── After receipt is saved, handle Cashfree refund tracking ──────────
if (refundAmount > 0 && !isWalletPay) {
  const cfIdempotencyKey = `refund_${session.sessionId}`;
  const existingRefund = await Refund.findOne({ idempotencyKey: cfIdempotencyKey });

  if (!existingRefund) {
    try {
      await Refund.create({
        userId:          session.userId,
        orderId:         session.transactionId,
        sessionId:       session.sessionId,
        refundId:        `REF${rand(8)}`,
        refundAmount,
        refundType:      "PARTIAL",
        destination:     "bank",          // ← Cashfree paid = refund back to bank
        status:          "INITIATED",     // ← not yet sent to Cashfree
        refundNote:      `Auto-refund for unused energy — session ${session.sessionId}`,
        initiatedBy:     "system",
        initiatedAt:     new Date(),
        idempotencyKey:  cfIdempotencyKey,
        amountPaid:      Number(session.amountPaid || 0),
        amountUtilized,
        gateway:         "cashfree",
      });
      console.log(`📋 Cashfree refund doc INITIATED — ₹${refundAmount} for session ${session.sessionId}`);
    } catch (e) {
      console.error(`❌ Cashfree refund doc creation failed:`, e.message);
    }
  }
}

    // ── Wallet refund: only if wallet-paid AND refund > 0 ─────────────
// ── Wallet refund: only if wallet-paid AND refund > 0 ─────────────
if (refundAmount > 0 && isWalletPay) {
  const refundIdempotencyKey = `refund_${session.sessionId}`;

  // Check if a Refund doc already exists (idempotency guard)
  const existingRefund = await Refund.findOne({ idempotencyKey: refundIdempotencyKey });

  if (!existingRefund) {
    // 1. Credit the wallet
    try {
      await creditWallet({
        userId:         session.userId.toString(),
        amount:         refundAmount,
        type:           "refund",
        sessionId:      session.sessionId,
        orderId:        session.transactionId,
        description:    `Refund for unused charging — session ${session.sessionId}`,
        idempotencyKey: refundIdempotencyKey,
      });
    } catch (refundErr) {
      console.error(`❌ Wallet creditWallet failed for ${session.sessionId}:`, refundErr.message);
      // Don't return — still attempt to record the Refund doc below
    }

    // 2. Create the canonical Refund document (source of truth for admin panel)
    try {
      await Refund.create({
        userId:          session.userId,
        orderId:         session.transactionId,
        sessionId:       session.sessionId,
        refundId:        receipt.refund?.refundId || `REF${rand(8)}`,
        refundAmount,
        refundType:      "PARTIAL",           // always partial — unused portion of pre-paid amount
        destination:     "wallet",
        status:          "SUCCESS",
        refundNote:      `Refund for unused charging — session ${session.sessionId}`,
        initiatedBy:     "system",
        initiatedAt:     new Date(),
        processedAt:     new Date(),
        idempotencyKey:  refundIdempotencyKey,
        // analytics metadata
        amountPaid:      Number(session.amountPaid || 0),
        amountUtilized,
        gateway:         "wallet",
      });
      console.log(`✅ Refund doc created — ₹${refundAmount} → wallet, session ${session.sessionId}`);
    } catch (refDocErr) {
      // Log but don't crash — wallet was already credited
      console.error(`❌ Refund doc creation failed for ${session.sessionId}:`, refDocErr.message);
    }

    // 3. Stamp the receipt
    await Receipt.updateOne(
      { sessionId: session.sessionId },
      { $set: { "refund.processedAt": new Date() } }
    );

    console.log(`✅ Wallet refund ₹${refundAmount} complete for session ${session.sessionId}`);
  } else {
    console.log(`⚠️ Refund already processed for session ${session.sessionId} — skipping`);
  }
}
  }

  if (sendStopMqtt) {
    const topic = `viz/${deviceIdOverride || session.deviceId}/sessionCommand`;
    const payload = { command: "stop", SessionId: sessionId, endTrigger };
    await logCommand(session._id, { type: "stop", topic, payload, mqtt: { publishedAt: new Date() } });
    mqttClient.publish(topic, JSON.stringify(payload), { qos: 1, retain: false }, (err) => {
      if (err) console.error("❌ MQTT publish failed (stop):", err);
    });
  }

  return { session, receipt };
}



// ✅ POST /api/sessions/stop
const endSession = async (req, res) => {
  console.log("Stop request received:", req.body);
  try {
    const { sessionId, endTime, endTrigger, currentEnergy, deltaEnergy, amountUsed, deviceId } = req.body;
    if (!sessionId || !endTime || !endTrigger) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const { session, receipt } = await completeSessionInternal({
      sessionId,
      endTime,
      endTrigger,
      currentEnergy,
      deltaEnergy,
      amountUsed,
      deviceIdOverride: deviceId,
      sendStopMqtt: true
    });

    return res.status(200).json({ message: "Session ended successfully.", session, receipt });
  } catch (err) {
    console.error("Error ending session:", err);
    return res.status(500).json({ error: "Failed to end session." });
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


// GET /api/sessions/owner/analytics?timeType=DAILY&duration=1day&deviceIds=A,B
const getOwnerAnalytics = async (req, res) => {
  try {
    const ownerId = req.user.userId;
    const { timeType = "DAILY", duration = "1day", deviceIds = "" } = req.query;

    if (!mongoose.Types.ObjectId.isValid(ownerId)) {
      return res.status(400).json({ error: "Invalid ownerId" });
    }
    const ownerObjectId = new mongoose.Types.ObjectId(ownerId);

    // 1) Owner devices (device config needed for PG% and commissionPerKwh)
    const devices = await Device.find({ ownerId: { $in: [ownerObjectId] } })
      .select("device_id commissionPerKwh PGPercent")
      .lean();

    if (!devices.length) {
      return res.json({
        summary: { totalEnergy: 0, totalAmount: 0, totalProfit: 0, sessionsCount: 0 },
        overviewData: { energyByTime: [], amountByTime: [] },
        tableData: [],
      });
    }

    const deviceConfigMap = Object.fromEntries(
      devices.map((d) => [
        d.device_id,
        { commissionPerKwh: Number(d.commissionPerKwh || 0), pgPercent: Number(d.PGPercent || 0) },
      ])
    );

    // 2) selected devices
    let selectedDeviceIds = Object.keys(deviceConfigMap);
    if (deviceIds && deviceIds.trim()) {
      const provided = String(deviceIds)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      selectedDeviceIds = provided.filter((id) => deviceConfigMap[id]);
    }
    if (!selectedDeviceIds.length) {
      return res.json({
        summary: { totalEnergy: 0, totalAmount: 0, totalProfit: 0, sessionsCount: 0 },
        overviewData: { energyByTime: [], amountByTime: [] },
        tableData: [],
      });
    }

    // 3) date range
    const now = new Date();
    const endDate = new Date(now);
    endDate.setHours(23, 59, 59, 999);

    const startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);

    if (timeType === "DAILY") {
      if (duration === "1day") startDate.setDate(now.getDate() - 0);
      else if (duration === "7days") startDate.setDate(now.getDate() - 6);
      else if (duration === "30days") startDate.setDate(now.getDate() - 29);
    } else if (timeType === "MONTHLY") {
      if (duration === "3months") startDate.setMonth(now.getMonth() - 2);
      else if (duration === "6months") startDate.setMonth(now.getMonth() - 5);
      else if (duration === "12months") startDate.setMonth(now.getMonth() - 11);
      startDate.setDate(1);
    }

    startDate.setHours(0, 0, 0, 0);

    // 4) receipts query (use receipts only)
    const receipts = await Receipt.find({
      deviceId: { $in: selectedDeviceIds },
      createdAt: { $gte: startDate, $lte: endDate },
    })
      .select("deviceId energyConsumed amountUtilized ratePerKwh createdAt commission paymentCharges commissionPerKwh PGPercent")
      .lean();

    // 5) helpers
    const overviewMap = new Map(); // timeBucket -> { energy, amount }
    const tableData = [];

    const makeHourBucket = (dt) => {
      const d = new Date(dt);
      const hh = String(d.getHours()).padStart(2, "0");
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd} ${hh}:00`;
    };

    const makeDayBucket = (dt) => {
      const d = new Date(dt);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    };

    const makeMonthBucket = (dt) => {
      const d = new Date(dt);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      return `${yyyy}-${mm}`;
    };

    const addToBucket = (bucketKey, energy, amount) => {
      if (!overviewMap.has(bucketKey)) overviewMap.set(bucketKey, { energy: 0, amount: 0 });
      const b = overviewMap.get(bucketKey);
      b.energy += energy;
      b.amount += amount;
    };

    // 6) build overview + table
    for (const r of receipts) {
      const energy = Number(r.energyConsumed || 0);
      const amount = Number(r.amountUtilized || 0);
      const rate = Number(r.ratePerKwh || 0);

      // Use device config to calculate PG% and commissionPerKwh fields for table
      const commissionPerKwh = Number(r.commissionPerKwh || 0);
      const pgPercent = Number(r.PGPercent || 0);


      // IMPORTANT: you said commission + PG are already stored in receipts.
      // We will use receipt.commission and receipt.paymentCharges for math.
      const commission = Number(r.commission || 0);
      const pgCharge = Number(r.paymentCharges || 0);

      const profit = Number((amount - commission - pgCharge).toFixed(2));

      // bucket logic:
      // - DAILY + 1day => hourly
      // - DAILY + 7/30 => daily totals
      // - MONTHLY => monthly totals
      if (timeType === "DAILY" && duration === "1day") {
        addToBucket(makeHourBucket(r.createdAt), energy, amount);
      } else if (timeType === "DAILY") {
        addToBucket(makeDayBucket(r.createdAt), energy, amount);
      } else {
        addToBucket(makeMonthBucket(r.createdAt), energy, amount);
      }

      tableData.push({
        date: r.createdAt,
        deviceId: r.deviceId,
        energyConsumed: Number(energy.toFixed(2)),
        amountUtilized: Number(amount.toFixed(2)),
        ratePerKwh: Number(rate.toFixed(2)),
          // NEW: show these in table (amounts from receipt)
        commission: Number(r.commission || 0),
        paymentCharges: Number(r.paymentCharges || 0),
        commissionPerKwh: Number(r.commissionPerKwh || 0),
        PGPercent: Number(r.PGPercent || 0),
        profit,
        
      });
    }

    // 7) sort overview data
    const sortedBuckets = Array.from(overviewMap.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );

    const energyByTime = sortedBuckets.map(([time, v]) => ({
      time,
      value: Number(v.energy.toFixed(2)),
    }));

    const amountByTime = sortedBuckets.map(([time, v]) => ({
      time,
      value: Number(v.amount.toFixed(2)),
    }));

    // 8) summary
    const totalEnergy = Number(tableData.reduce((s, x) => s + x.energyConsumed, 0).toFixed(2));
    const totalAmount = Number(tableData.reduce((s, x) => s + x.amountUtilized, 0).toFixed(2));
    const totalProfit = Number(tableData.reduce((s, x) => s + x.profit, 0).toFixed(2));
    const sessionsCount = tableData.length;

    // 9) table sort desc
    tableData.sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.json({
      summary: { totalEnergy, totalAmount, totalProfit, sessionsCount },
      overviewData: { energyByTime, amountByTime },
      tableData,
      filters: { timeType, duration, selectedDeviceIds, dateRange: { start: startDate, end: endDate } },
    });
  } catch (err) {
    console.error("getOwnerAnalytics error:", err);
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
  getOwnerAnalytics,
  completeSessionInternal
};
