// routes/owner.js

const express = require("express");
const mongoose = require("mongoose");

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const Device = require("../models/device");
const Session = require("../models/session");
const Receipt = require("../models/Receipt");
const DeviceTelemetry = require("../models/deviceTelemetry");

const DeviceRateAudit = require("../models/DeviceRateAudit");

const OwnerSettlement = require("../models/OwnerSettlement");
const ElectricityBill = require("../models/ElectricityBill");
const { escapeRegex } = require("../utils/ownerScope");

const router = express.Router();

// Every route in this router requires an authenticated owner.
router.use(authMiddleware, authorizeRoles("owner"));

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Default to 3 minutes. Set OWNER_DEVICE_ONLINE_THRESHOLD_MS in Render
// to match the device's actual heartbeat interval.
const ONLINE_THRESHOLD_MS =
  Math.max(
    30_000,
    Number(process.env.OWNER_DEVICE_ONLINE_THRESHOLD_MS) || 180_000
  );

const DEVICE_FIELDS =
  "device_id serialNumber project location status charger_type rate " +
  "area city state lat lng totalenergy meterType meterConsumerNumber " +
  "wifiSSID wifiPassword relayOn lastSeen onboardingStatus " +
  "onboardedAt updatedAt current_session_id";

function isValidOwnerId(ownerId) {
  return mongoose.Types.ObjectId.isValid(ownerId);
}

function getOwnerObjectId(req) {
  return new mongoose.Types.ObjectId(req.user.userId);
}

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function round3(value) {
  return Number((Number(value) || 0).toFixed(3));
}

function shapeOwnerReceipt(receipt) {
  return {
    receiptId: receipt.receiptId || "",
    deviceId: receipt.deviceId || "",
    createdAt: receipt.createdAt || null,

    vehicleNumber: receipt.vehicleNumber || "",
    vehicleModel: receipt.vehicleModel || "",

    totalAmount: round2(receipt.totalAmount),
    taxableAmount: round2(receipt.taxableAmount),
    gstAmount: round2(receipt.gstAmount),
    energyConsumed: round3(receipt.energyConsumed),
    ownerPayout: round2(receipt.ownerPayout),
  };
}

/**
 * Convert a date-only input such as 2026-10-01 into midnight in
 * Asia/Kolkata. Timestamp inputs containing a timezone are parsed normally.
 *
 * For date filters, `to` is an exclusive boundary:
 * from=2026-10-01&to=2026-10-17 includes October 1–16 in IST.
 */
function parseDateBoundary(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const input = value.trim();
  const dateOnlyMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);

    const utcMidnight = Date.UTC(year, month - 1, day);
    const candidate = new Date(utcMidnight - IST_OFFSET_MS);

    // Reject invalid dates such as 2026-02-31.
    const shifted = new Date(candidate.getTime() + IST_OFFSET_MS);

    if (
      shifted.getUTCFullYear() !== year ||
      shifted.getUTCMonth() !== month - 1 ||
      shifted.getUTCDate() !== day
    ) {
      return null;
    }

    return candidate;
  }

  const parsed = new Date(input);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getIstMidnight(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);

  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate()
    ) - IST_OFFSET_MS
  );
}

function getIstMonthStart(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);

  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      1
    ) - IST_OFFSET_MS
  );
}

function getPeriodRange(query) {
  const now = new Date();

  const defaultFrom = getIstMonthStart(now);
  const todayStart = getIstMidnight(now);
  const defaultTo = new Date(todayStart.getTime() + DAY_MS);

  const from = query.from
    ? parseDateBoundary(query.from)
    : defaultFrom;

  const to = query.to
    ? parseDateBoundary(query.to)
    : defaultTo;

  if (
    (query.from && !from) ||
    (query.to && !to)
  ) {
    return {
      error: "Invalid date. Use YYYY-MM-DD or a valid ISO timestamp.",
    };
  }

  if (!from || !to || from >= to) {
    return {
      error: "The start date must be earlier than the exclusive end date.",
    };
  }

  // Prevent accidentally querying an unbounded multi-year range.
  if (to.getTime() - from.getTime() > 400 * DAY_MS) {
    return {
      error: "The selected period cannot exceed 400 days.",
    };
  }

  const durationMs = to.getTime() - from.getTime();

  const defaultBucket =
    durationMs <= 2 * DAY_MS
      ? "hour"
      : durationMs <= 65 * DAY_MS
      ? "day"
      : durationMs <= 210 * DAY_MS
      ? "week"
      : "month";

  const bucket = query.bucket || defaultBucket;
  const validBuckets = ["hour", "day", "week", "month"];

  if (!validBuckets.includes(bucket)) {
    return {
      error: "Invalid bucket. Use hour, day, week or month.",
    };
  }

  return { from, to, bucket, durationMs };
}

function emptyReceiptSummary() {
  return {
    receiptCount: 0,
    energyConsumed: 0,
    taxableAmount: 0,
    gstAmount: 0,
    totalAmount: 0,
    ownerPayout: 0,
  };
}

/**
 * Owner finance and historical usage are calculated from Receipt records only.
 * deviceIds must be derived from the authenticated owner's devices.
 */
async function aggregateReceiptSummary(deviceIds, from, to) {
  if (!deviceIds.length) {
    return emptyReceiptSummary();
  }

  const [row] = await Receipt.aggregate([
    {
      $match: {
        deviceId: { $in: deviceIds },
        createdAt: { $gte: from, $lt: to },
      },
    },
    {
      $group: {
        _id: null,

        receiptCount: { $sum: 1 },

        energyConsumed: {
          $sum: { $ifNull: ["$energyConsumed", 0] },
        },

        taxableAmount: {
          $sum: { $ifNull: ["$taxableAmount", 0] },
        },

        gstAmount: {
          $sum: { $ifNull: ["$gstAmount", 0] },
        },

        totalAmount: {
          $sum: { $ifNull: ["$totalAmount", 0] },
        },

        ownerPayout: {
          $sum: { $ifNull: ["$ownerPayout", 0] },
        },
      },
    },
  ]);

  if (!row) {
    return emptyReceiptSummary();
  }

  return {
    receiptCount: Number(row.receiptCount || 0),
    energyConsumed: round3(row.energyConsumed),
    taxableAmount: round2(row.taxableAmount),
    gstAmount: round2(row.gstAmount),
    totalAmount: round2(row.totalAmount),
    ownerPayout: round2(row.ownerPayout),
  };
}

function getDeviceState(device, now = Date.now()) {
  const status = String(device.status || "unknown")
    .trim()
    .toLowerCase();

  const lastSeenMs = device.lastSeen
    ? new Date(device.lastSeen).getTime()
    : 0;

  const stale =
    !lastSeenMs ||
    Number.isNaN(lastSeenMs) ||
    now - lastSeenMs > ONLINE_THRESHOLD_MS;

  const faulty =
    status.includes("fault") ||
    status === "error";

  const explicitlyOffline = [
    "offline",
    "disconnected",
  ].includes(status);

  const offline =
    !faulty &&
    (explicitlyOffline || stale);

  const online = !faulty && !offline;

  return {
    online,
    offline,
    faulty,
    available: online && status === "available",
    occupied: online && status === "occupied",
    stale,
  };
}

function shapeDevice(device) {
  const state = getDeviceState(device);

  return {
    deviceId: device.device_id || "",
    serialNumber: device.serialNumber || "",
    project: device.project || "",
    location: device.location || "",
    status: device.status || "Unknown",
    chargerType: device.charger_type || "",

    rateInclGst: Number(device.rate || 0),

    area: device.area || "",
    city: device.city || "",
    state: device.state || "",

    lat: device.lat ?? null,
    lng: device.lng ?? null,

    meterConsumerNumber: device.meterConsumerNumber || "",
    meterType: device.meterType || "",

    totalEnergy: round3(device.totalenergy),

    wifiSSID: device.wifiSSID || "",
    wifiPassword: device.wifiPassword || "",

    relayOn: Boolean(device.relayOn),
    lastSeen: device.lastSeen || null,
    onboardingStatus: device.onboardingStatus || "pending",
    onboardedAt: device.onboardedAt || null,
    updatedAt: device.updatedAt || null,

    online: state.online,
    stale: state.stale,
  };
}

function emptyNetworkSummary() {
  return {
    total: 0,
    online: 0,
    available: 0,
    occupied: 0,
    offline: 0,
    faulty: 0,
  };
}

/**
 * GET /api/owner/overview
 *
 * Optional query:
 * ?from=2026-10-01&to=2026-10-17&bucket=day
 * &deviceId=VIZ1A05&project=GLIDE&city=Pune&state=Maharashtra
 */
router.get("/overview", async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!isValidOwnerId(ownerId)) {
      return res.status(400).json({
        error: "Invalid owner ID in authentication token.",
      });
    }

    const range = getPeriodRange(req.query);

    if (range.error) {
      return res.status(400).json({
        error: range.error,
      });
    }

    const { from, to, bucket, durationMs } = range;
    const ownerObjectId = getOwnerObjectId(req);

    // The owner scope is always applied before optional filters.
    const deviceFilter = {
      ownerId: ownerObjectId,
    };

    for (const field of ["project", "city", "state"]) {
      const value = req.query[field];

      if (typeof value === "string" && value.trim()) {
        deviceFilter[field] = value.trim();
      }
    }

    if (
      typeof req.query.deviceId === "string" &&
      req.query.deviceId.trim()
    ) {
      deviceFilter.device_id = req.query.deviceId.trim();
    }

    const devices = await Device.find(deviceFilter)
      .select(DEVICE_FIELDS)
      .sort({ device_id: 1 })
      .lean();

    // Do not reveal whether a device ID owned by somebody else exists.
    if (req.query.deviceId && devices.length === 0) {
      return res.status(404).json({
        error: "Device not found in your account.",
      });
    }

    const deviceIds = devices.map((device) => device.device_id);
    const network = emptyNetworkSummary();

    network.total = devices.length;

    const nowMs = Date.now();

    for (const device of devices) {
      const state = getDeviceState(device, nowMs);

      if (state.faulty) {
        network.faulty += 1;
      } else if (state.offline) {
        network.offline += 1;
      } else {
        network.online += 1;
      }

      if (state.available) network.available += 1;
      if (state.occupied) network.occupied += 1;
    }

    const activeFilter = {
      deviceId: { $in: deviceIds },
      status: { $in: ["active", "paused"] },
      endTime: null,
    };

    const [
      activeSessionsCount,
      activeSessionDocs,
      currentSummary,
      previousSummary,
    ] = await Promise.all([
      deviceIds.length
        ? Session.countDocuments(activeFilter)
        : Promise.resolve(0),

    deviceIds.length
    ? Session.find(activeFilter)
        .select(
            "sessionId deviceId status startTime estimatedEndTime " +
            "energyConsumed userId -_id"
        )
        .populate("userId", "vehicleNumber vehicleModel")
        .sort({ startTime: -1 })
        .limit(5)
        .lean()
    : Promise.resolve([]),

      aggregateReceiptSummary(deviceIds, from, to),

      aggregateReceiptSummary(
        deviceIds,
        new Date(from.getTime() - durationMs),
        from
      ),
    ]);

    const formatByBucket = {
      hour: "%Y-%m-%d %H:00",
      day: "%Y-%m-%d",
      week: "%G-W%V",
      month: "%Y-%m",
    };

    let trend = [];

    if (deviceIds.length) {
      trend = await Receipt.aggregate([
        {
          $match: {
            deviceId: { $in: deviceIds },
            createdAt: { $gte: from, $lt: to },
          },
        },
{
  $group: {
    _id: {
      $dateToString: {
        format: formatByBucket[bucket],
        date: "$createdAt",
        timezone: "Asia/Kolkata",
      },
    },

    receiptCount: { $sum: 1 },

    energyConsumed: {
      $sum: { $ifNull: ["$energyConsumed", 0] },
    },

    taxableAmount: {
      $sum: { $ifNull: ["$taxableAmount", 0] },
    },

    gstAmount: {
      $sum: { $ifNull: ["$gstAmount", 0] },
    },

    totalAmount: {
      $sum: { $ifNull: ["$totalAmount", 0] },
    },

    ownerPayout: {
      $sum: { $ifNull: ["$ownerPayout", 0] },
    },
  },
},
{ $sort: { _id: 1 } },
      ]);
    }

    const alerts = [];

    for (const device of devices) {
      const state = getDeviceState(device, nowMs);

      if (state.faulty) {
        alerts.push({
          type: "device_faulty",
          severity: "critical",
          deviceId: device.device_id,
          location: device.location || "",
          lastSeen: device.lastSeen || null,
          message: "Charger reports a fault status.",
        });
      } else if (state.offline) {
        alerts.push({
          type: "device_offline_or_stale",
          severity: "warning",
          deviceId: device.device_id,
          location: device.location || "",
          lastSeen: device.lastSeen || null,
          message: state.stale
            ? "Charger heartbeat is stale."
            : "Charger is offline.",
        });
      }
    }

const performance = {
  activeSessions: activeSessionsCount,

  receiptCount: currentSummary.receiptCount,
  energyConsumed: currentSummary.energyConsumed,
  taxableAmount: currentSummary.taxableAmount,
  gstAmount: currentSummary.gstAmount,
  totalAmount: currentSummary.totalAmount,
  ownerPayout: currentSummary.ownerPayout,
};

    return res.status(200).json({
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        timezone: "Asia/Kolkata",
        bucket,
      },

      network,

      performance,

      previousPeriod: {
        from: new Date(from.getTime() - durationMs).toISOString(),
        to: from.toISOString(),
        performance: previousSummary,
      },

trend: trend.map((row) => ({
  bucket: row._id,
  receiptCount: Number(row.receiptCount || 0),
  energyConsumed: round3(row.energyConsumed),
  taxableAmount: round2(row.taxableAmount),
  gstAmount: round2(row.gstAmount),
  totalAmount: round2(row.totalAmount),
  ownerPayout: round2(row.ownerPayout),
})),

activeSessionsPreview: activeSessionDocs.map((session) => ({
  sessionId: session.sessionId,
  deviceId: session.deviceId,
  status: session.status,
  startTime: session.startTime || null,
  estimatedEndTime: session.estimatedEndTime || null,
  energyConsumed: round3(session.energyConsumed),

  vehicleNumber: session.userId?.vehicleNumber || "",
  vehicleModel: session.userId?.vehicleModel || "",
})),

      // Current-state issues only; persistent alert history will be a later phase.
      alerts: alerts.slice(0, 8),

metadata: {
  generatedAt: new Date().toISOString(),
  onlineThresholdMs: ONLINE_THRESHOLD_MS,
  financialSource: "Receipt records only",
},
    });
  } catch (error) {
    console.error("Owner overview error:", error);

    return res.status(500).json({
      error: "Could not fetch owner overview.",
    });
  }
});

/**
 * GET /api/owner/devices
 *
 * Optional query:
 * ?search=VIZ&status=Available&city=Pune&page=1&limit=25
 */
router.get("/devices", async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!isValidOwnerId(ownerId)) {
      return res.status(400).json({
        error: "Invalid owner ID in authentication token.",
      });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 25)
    );

    const filter = {
      ownerId: getOwnerObjectId(req),
    };

    for (const field of ["project", "city", "state"]) {
      const value = req.query[field];

      if (typeof value === "string" && value.trim()) {
        filter[field] = value.trim();
      }
    }

    if (
      typeof req.query.status === "string" &&
      req.query.status.trim()
    ) {
      filter.status = new RegExp(
        "^" + escapeRegex(req.query.status.trim()) + "$",
        "i"
      );
    }

    if (
      typeof req.query.search === "string" &&
      req.query.search.trim()
    ) {
      const search = escapeRegex(req.query.search.trim());

      filter.$or = [
        { device_id: new RegExp(search, "i") },
        { project: new RegExp(search, "i") },
        { location: new RegExp(search, "i") },
        { city: new RegExp(search, "i") },
        { area: new RegExp(search, "i") },
      ];
    }

    const sortFieldMap = {
      deviceId: "device_id",
      status: "status",
      rate: "rate",
      city: "city",
      lastSeen: "lastSeen",
      updatedAt: "updatedAt",
    };

    const sortField =
      sortFieldMap[req.query.sortBy] || "updatedAt";

    const sortDirection =
      req.query.sortOrder === "asc" ? 1 : -1;

    const [total, documents] = await Promise.all([
      Device.countDocuments(filter),

      Device.find(filter)
        .select(DEVICE_FIELDS)
        .sort({ [sortField]: sortDirection })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    return res.status(200).json({
      items: documents.map(shapeDevice),

      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },

      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Owner devices fetch error:", error);

    return res.status(500).json({
      error: "Could not fetch owner devices.",
    });
  }
});

/**
 * GET /api/owner/devices/:deviceId
 *
 * Includes safe device details, latest telemetry snapshot and recent sessions.
 */
router.get("/devices/:deviceId", async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!isValidOwnerId(ownerId)) {
      return res.status(400).json({
        error: "Invalid owner ID in authentication token.",
      });
    }

    const deviceId = String(req.params.deviceId || "").trim();

    if (!deviceId) {
      return res.status(400).json({
        error: "Device ID is required.",
      });
    }

    // Ownership is part of the query. Never fetch by device ID alone.
    const device = await Device.findOne({
      ownerId: getOwnerObjectId(req),
      device_id: deviceId,
    })
      .select(DEVICE_FIELDS)
      .lean();

    if (!device) {
      return res.status(404).json({
        error: "Device not found in your account.",
      });
    }

    const telemetryCutoff = new Date(
      Date.now() - 24 * 60 * 60 * 1000
    );

const [
  latestTelemetry,
  activeSessions,
  recentReceipts,
] = await Promise.all([
DeviceTelemetry.findOne({
  deviceId,
  timestamp: { $gte: telemetryCutoff },
})
    .select("voltage current power timestamp -_id")
    .sort({ timestamp: -1 })
    .lean(),

  Session.find({
    deviceId,
    status: { $in: ["active", "paused"] },
    endTime: null,
  })
    .select(
      "sessionId deviceId status startTime estimatedEndTime " +
      "energyConsumed userId -_id"
    )
    .populate("userId", "vehicleNumber vehicleModel")
    .sort({ startTime: -1 })
    .limit(10)
    .lean(),

  Receipt.find({ deviceId })
    .select(
      "receiptId deviceId vehicleNumber vehicleModel createdAt " +
      "totalAmount taxableAmount gstAmount energyConsumed ownerPayout -_id"
    )
    .sort({ createdAt: -1 })
    .limit(10)
    .lean(),
]);

    const state = getDeviceState(device);

    const telemetry = latestTelemetry
      ? {
          voltage: Number(latestTelemetry.voltage || 0),
          current: Number(latestTelemetry.current || 0),
          power: Number(latestTelemetry.power || 0),
          timestamp: latestTelemetry.timestamp || null,

          isFresh:
            Boolean(latestTelemetry.timestamp) &&
            Date.now() - new Date(latestTelemetry.timestamp).getTime()
              <= ONLINE_THRESHOLD_MS,
        }
      : null;

    return res.status(200).json({
      device: {
        ...shapeDevice(device),
        lat: device.lat ?? null,
        lng: device.lng ?? null,
        totalEnergy: round3(device.totalenergy),
      },

      telemetry,

activeSessions: activeSessions.map((session) => ({
  sessionId: session.sessionId,
  deviceId: session.deviceId,
  status: session.status,
  startTime: session.startTime || null,
  estimatedEndTime: session.estimatedEndTime || null,
  energyConsumed: round3(session.energyConsumed),
  vehicleNumber: session.userId?.vehicleNumber || "",
  vehicleModel: session.userId?.vehicleModel || "",
})),

recentReceipts: recentReceipts.map(shapeOwnerReceipt),

      metadata: {
        generatedAt: new Date().toISOString(),
        deviceOnline: state.online,
      },
    });
  } catch (error) {
    console.error("Owner device detail error:", error);

    return res.status(500).json({
      error: "Could not fetch device details.",
    });
  }
});

// PATCH /api/owner/devices/:deviceId/details
//
// Owner-editable fields:
// meterConsumerNumber, meterType, location, city, state, lat, lng
//
// Serial number, device ID, Wi-Fi credentials, rate and runtime state
// cannot be modified through this endpoint.

router.patch("/devices/:deviceId/details", async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!isValidOwnerId(ownerId)) {
      return res.status(400).json({
        error: "Invalid owner ID in authentication token.",
      });
    }

    const deviceId = String(req.params.deviceId || "").trim();

    if (!deviceId) {
      return res.status(400).json({
        error: "Device ID is required.",
      });
    }

    const ownerObjectId = getOwnerObjectId(req);

    // Ownership is enforced in the database query.
    const device = await Device.findOne({
      ownerId: ownerObjectId,
      device_id: deviceId,
    });

    if (!device) {
      return res.status(404).json({
        error: "Device not found in your account.",
      });
    }

    const body = req.body || {};
    const updates = {};

    // Meter consumer / meter number.
    if (Object.prototype.hasOwnProperty.call(body, "meterConsumerNumber")) {
      if (
        body.meterConsumerNumber !== null &&
        typeof body.meterConsumerNumber !== "string"
      ) {
        return res.status(400).json({
          error: "Meter number must be text.",
        });
      }

      const meterNumber = String(
        body.meterConsumerNumber ?? ""
      ).trim();

      if (meterNumber.length > 100) {
        return res.status(400).json({
          error: "Meter number cannot exceed 100 characters.",
        });
      }

      updates.meterConsumerNumber = meterNumber || null;
    }

    // Meter type must match the Device schema enum.
    if (Object.prototype.hasOwnProperty.call(body, "meterType")) {
      if (typeof body.meterType !== "string") {
        return res.status(400).json({
          error: "Meter type must be text.",
        });
      }

      const meterType = body.meterType.trim();
      const validMeterTypes = [
        "Green Meter",
        "Commercial",
        "Residential",
      ];

      if (meterType && !validMeterTypes.includes(meterType)) {
        return res.status(400).json({
          error: "Invalid meter type.",
          allowedMeterTypes: validMeterTypes,
        });
      }

      updates.meterType = meterType || null;
    }

    // Editable location strings.
    for (const field of ["location", "city", "state"]) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) {
        continue;
      }

      if (typeof body[field] !== "string") {
        return res.status(400).json({
          error: `${field} must be text.`,
        });
      }

      const value = body[field].trim();
      const maxLength = field === "location" ? 300 : 100;

      if (!value || value.length > maxLength) {
        return res.status(400).json({
          error:
            field === "location"
              ? "Location is required and must not exceed 300 characters."
              : `${field} is required and must not exceed 100 characters.`,
        });
      }

      updates[field] = value;
    }

    // Latitude and longitude.
    for (const field of ["lat", "lng"]) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) {
        continue;
      }

      const rawValue = body[field];

      if (
        rawValue === null ||
        rawValue === undefined ||
        (typeof rawValue === "string" && !rawValue.trim())
      ) {
        return res.status(400).json({
          error: `${field} is required and must be a valid number.`,
        });
      }

      const value = Number(rawValue);

      if (!Number.isFinite(value)) {
        return res.status(400).json({
          error: `${field} must be a valid number.`,
        });
      }

      if (field === "lat" && (value < -90 || value > 90)) {
        return res.status(400).json({
          error: "Latitude must be between -90 and 90.",
        });
      }

      if (field === "lng" && (value < -180 || value > 180)) {
        return res.status(400).json({
          error: "Longitude must be between -180 and 180.",
        });
      }

      updates[field] = value;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: "No editable device fields were supplied.",
      });
    }

    Object.assign(device, updates);
    await device.save();

    return res.status(200).json({
      success: true,
      message: "Device details updated successfully.",
      device: shapeDevice(device.toObject()),
    });
  } catch (error) {
    console.error("Owner device-details update error:", error);

    return res.status(500).json({
      error: "Could not update device details.",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BATCH 2 HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_EXPORT_LIMIT = 10000;

async function getOwnerDeviceIds(ownerObjectId) {
  const devices = await Device.find({
    ownerId: ownerObjectId,
  })
    .select("device_id")
    .lean();

  return devices.map((device) => device.device_id);
}

function buildOptionalDateFilter(query, fieldName) {
  const from = query.from
    ? parseDateBoundary(query.from)
    : null;

  const to = query.to
    ? parseDateBoundary(query.to)
    : null;

  if ((query.from && !from) || (query.to && !to)) {
    return {
      error: "Invalid date. Use YYYY-MM-DD or a valid ISO timestamp.",
    };
  }

  if (from && to && from >= to) {
    return {
      error: "The start date must be earlier than the exclusive end date.",
    };
  }

  if (
    from &&
    to &&
    to.getTime() - from.getTime() > 400 * DAY_MS
  ) {
    return {
      error: "The selected period cannot exceed 400 days.",
    };
  }

  const range = {};

  if (from) range.$gte = from;
  if (to) range.$lt = to;

  return {
    from,
    to,
    filter: Object.keys(range).length
      ? { [fieldName]: range }
      : {},
  };
}

function csvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }

  let textValue =
    value instanceof Date
      ? value.toISOString()
      : String(value);

  // Protect spreadsheet users from formula injection in text fields.
  // Numeric values should be passed as numbers, not as preformatted strings.
  if (/^[=+\-@\t\r]/.test(textValue)) {
    textValue = "'" + textValue;
  }

  return `"${textValue.replace(/"/g, '""')}"`;
}

function sendOwnerCsv(res, filename, headers, rows) {
  const csv = [
    headers,
    ...rows,
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  return res.status(200).send("\uFEFF" + csv);
}

async function sendOwnerReceiptCsv(req, res, filename) {
  const ownerId = req.user.userId;

  if (!isValidOwnerId(ownerId)) {
    return res.status(400).json({
      error: "Invalid owner ID in authentication token.",
    });
  }

  const range = getPeriodRange(req.query);

  if (range.error) {
    return res.status(400).json({
      error: range.error,
    });
  }

  const { from, to } = range;
  const ownerObjectId = getOwnerObjectId(req);
  let deviceIds = await getOwnerDeviceIds(ownerObjectId);

  if (
    typeof req.query.deviceId === "string" &&
    req.query.deviceId.trim()
  ) {
    const requestedDeviceId = req.query.deviceId.trim();

    if (!deviceIds.includes(requestedDeviceId)) {
      return res.status(404).json({
        error: "Device not found in your account.",
      });
    }

    deviceIds = [requestedDeviceId];
  }

  const receipts = await Receipt.find({
    deviceId: { $in: deviceIds },
    createdAt: { $gte: from, $lt: to },
  })
    .select(
      "receiptId deviceId vehicleNumber vehicleModel createdAt " +
      "totalAmount taxableAmount gstAmount energyConsumed ownerPayout -_id"
    )
    .sort({ createdAt: -1 })
    .limit(OWNER_EXPORT_LIMIT + 1)
    .lean();

  if (receipts.length > OWNER_EXPORT_LIMIT) {
    return res.status(413).json({
      error:
        "The report exceeds 10,000 receipts. Narrow the date range or select a device.",
    });
  }

  const headers = [
    "Receipt ID",
    "Receipt Date",
    "Device ID",
    "Vehicle Number",
    "Vehicle Model",
    "Total Amount",
    "Taxable Amount",
    "GST Amount",
    "Energy Consumed (kWh)",
    "Owner Payout",
  ];

  const rows = receipts.map((receipt) => [
    receipt.receiptId || "",
    receipt.createdAt || "",
    receipt.deviceId || "",
    receipt.vehicleNumber || "",
    receipt.vehicleModel || "",
    round2(receipt.totalAmount),
    round2(receipt.taxableAmount),
    round2(receipt.gstAmount),
    round3(receipt.energyConsumed),
    round2(receipt.ownerPayout),
  ]);

  return sendOwnerCsv(res, filename, headers, rows);
}

function getOwnerSessionDateMatch(query) {
  const result = buildOptionalDateFilter(query, "startTime");

  if (result.error) {
    return result;
  }

  return {
    from: result.from,
    to: result.to,
    filter: result.filter,
  };
}

// PATCH /api/owner/devices/:deviceId/rate
//
// Body:
// {
//   "rateInclGst": 25,
//   "reason": "Updated tariff for the new electricity cost"
// }
//
// Public rate is GST-inclusive. commercial.userRatePerKwh is ex-GST.

router.patch("/devices/:deviceId/rate", async (req, res) => {
  let dbSession;

  try {
    const ownerId = req.user.userId;

    if (!isValidOwnerId(ownerId)) {
      return res.status(400).json({
        error: "Invalid owner ID in authentication token.",
      });
    }

    const deviceId = String(req.params.deviceId || "").trim();

    if (!deviceId) {
      return res.status(400).json({
        error: "Device ID is required.",
      });
    }

    const requestedRate = Number(req.body?.rateInclGst);
    const reason =
      typeof req.body?.reason === "string"
        ? req.body.reason.trim()
        : "";

    const maxRate =
      Number(process.env.OWNER_MAX_RATE_INCL_GST) || 1000;

    if (
      !Number.isFinite(requestedRate) ||
      requestedRate < 0.01 ||
      requestedRate > maxRate
    ) {
      return res.status(400).json({
        error: `Rate must be between ₹0.01 and ₹${maxRate} per kWh, including GST.`,
      });
    }

    if (reason.length < 5 || reason.length > 500) {
      return res.status(400).json({
        error: "Provide a reason between 5 and 500 characters.",
      });
    }

    const newRateInclGst = round2(requestedRate);
    const ownerObjectId = getOwnerObjectId(req);

    // GST-exclusive rate using the current 18% GST assumption.
    const newUserRatePerKwh = round2(newRateInclGst / 1.18);

    let result = {
      notFound: false,
      audit: null,
    };

    // Update the device and write its audit entry atomically.
    // MongoDB transactions require a replica set; MongoDB Atlas supports this.
    dbSession = await mongoose.startSession();

    await dbSession.withTransaction(async () => {
      const device = await Device.findOne({
        ownerId: ownerObjectId,
        device_id: deviceId,
      }).session(dbSession);

      if (!device) {
        result.notFound = true;
        return;
      }

      const previousRateInclGst = round2(device.rate || 0);

      const previousUserRatePerKwh =
        device.commercial?.userRatePerKwh ?? null;

      if (Math.abs(previousRateInclGst - newRateInclGst) < 0.005) {
        result.sameRate = true;
        result.currentRate = previousRateInclGst;
        return;
      }

      // Keep the existing one-entry rateHistory behavior for compatibility.
      device.setRate(
        newRateInclGst,
        String(ownerId),
        "owner"
      );

      // Keep the ex-GST pricing field aligned with the public tariff.
      device.commercial = device.commercial || {};
      device.commercial.userRatePerKwh = newUserRatePerKwh;

      await device.save({ session: dbSession });

      const [audit] = await DeviceRateAudit.create(
        [
          {
            ownerId: ownerObjectId,
            changedBy: ownerObjectId,
            changedByRole: "owner",
            deviceId,

            previousRateInclGst,
            newRateInclGst,

            previousUserRatePerKwh,
            newUserRatePerKwh,

            reason,
            changedAt: new Date(),
          },
        ],
        { session: dbSession }
      );

      result.audit = audit;
    });

    if (result.notFound) {
      return res.status(404).json({
        error: "Device not found in your account.",
      });
    }

    if (result.sameRate) {
      return res.status(400).json({
        error: "The new rate is the same as the current rate.",
        currentRateInclGst: result.currentRate,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Device rate updated successfully.",

      deviceId,
      rateInclGst: newRateInclGst,
      userRatePerKwh: newUserRatePerKwh,

      audit: result.audit
        ? {
            id: result.audit._id,
            reason: result.audit.reason,
            changedAt: result.audit.changedAt,
          }
        : null,
    });
  } catch (error) {
    console.error("Owner device-rate update error:", error);

    return res.status(500).json({
      error: "Could not update the device rate.",
    });
  } finally {
    if (dbSession) {
      await dbSession.endSession();
    }
  }
});

// GET /api/owner/devices/:deviceId/rate-history?limit=50

router.get(
  "/devices/:deviceId/rate-history",
  async (req, res) => {
    try {
      const ownerId = req.user.userId;

      if (!isValidOwnerId(ownerId)) {
        return res.status(400).json({
          error: "Invalid owner ID in authentication token.",
        });
      }

      const deviceId = String(req.params.deviceId || "").trim();

      const device = await Device.findOne({
        ownerId: getOwnerObjectId(req),
        device_id: deviceId,
      })
        .select("device_id rate")
        .lean();

      if (!device) {
        return res.status(404).json({
          error: "Device not found in your account.",
        });
      }

      const limit = Math.min(
        100,
        Math.max(1, parseInt(req.query.limit, 10) || 50)
      );

      const [items, total] = await Promise.all([
        DeviceRateAudit.find({
          ownerId: getOwnerObjectId(req),
          deviceId,
        })
          .sort({ changedAt: -1 })
          .limit(limit)
          .lean(),

        DeviceRateAudit.countDocuments({
          ownerId: getOwnerObjectId(req),
          deviceId,
        }),
      ]);

      return res.status(200).json({
        deviceId,
        currentRateInclGst: Number(device.rate || 0),
        items: items.map((item) => ({
          id: item._id,
          previousRateInclGst: item.previousRateInclGst,
          newRateInclGst: item.newRateInclGst,
          previousUserRatePerKwh: item.previousUserRatePerKwh,
          newUserRatePerKwh: item.newUserRatePerKwh,
          reason: item.reason,
          changedByRole: item.changedByRole,
          changedAt: item.changedAt,
        })),
        pagination: {
          limit,
          total,
          hasMore: total > limit,
        },
      });
    } catch (error) {
      console.error("Owner rate-history error:", error);

      return res.status(500).json({
        error: "Could not fetch device rate history.",
      });
    }
  }
);

// GET /api/owner/sessions
//
// Optional query parameters:
// ?page=1&limit=25
// &status=completed
// &deviceId=VIZ1A02
// &search=transaction
// &from=2026-10-01&to=2026-10-17

router.get("/sessions", async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!isValidOwnerId(ownerId)) {
      return res.status(400).json({
        error: "Invalid owner ID in authentication token.",
      });
    }

    const ownerObjectId = getOwnerObjectId(req);
    let deviceIds = await getOwnerDeviceIds(ownerObjectId);

    if (
      typeof req.query.deviceId === "string" &&
      req.query.deviceId.trim()
    ) {
      const requestedDeviceId = req.query.deviceId.trim();

      if (!deviceIds.includes(requestedDeviceId)) {
        return res.status(404).json({
          error: "Device not found in your account.",
        });
      }

      deviceIds = [requestedDeviceId];
    }

    const filter = {
      deviceId: { $in: deviceIds },
      status: { $in: ["active", "paused"] },
      endTime: null,
    };

    if (
      typeof req.query.status === "string" &&
      req.query.status.trim()
    ) {
      const status = req.query.status.trim().toLowerCase();

      if (!["active", "paused"].includes(status)) {
        return res.status(400).json({
          error:
            "This endpoint lists live sessions only. Use active or paused.",
        });
      }

      filter.status = status;
    }

    const dateMatch = getOwnerSessionDateMatch(req.query);

    if (dateMatch.error) {
      return res.status(400).json({
        error: dateMatch.error,
      });
    }

    Object.assign(filter, dateMatch.filter);

    if (
      typeof req.query.search === "string" &&
      req.query.search.trim()
    ) {
      const search = escapeRegex(req.query.search.trim());

      filter.$or = [
        { deviceId: new RegExp(search, "i") },
        { sessionId: new RegExp(search, "i") },
      ];
    }

    const page = Math.max(
      1,
      parseInt(req.query.page, 10) || 1
    );

    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 25)
    );

    const skip = (page - 1) * limit;

    const [sessions, total] = await Promise.all([
      Session.find(filter)
        .select(
          "sessionId deviceId status startTime estimatedEndTime " +
          "energyConsumed userId -_id"
        )
        .populate("userId", "vehicleNumber vehicleModel")
        .sort({ startTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Session.countDocuments(filter),
    ]);

    return res.status(200).json({
      items: sessions.map((session) => ({
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        status: session.status,
        startTime: session.startTime || null,
        estimatedEndTime: session.estimatedEndTime || null,
        energyConsumed: round3(session.energyConsumed),
        vehicleNumber: session.userId?.vehicleNumber || "",
        vehicleModel: session.userId?.vehicleModel || "",
      })),

      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },

      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Owner live sessions fetch error:", error);

    return res.status(500).json({
      error: "Could not fetch live sessions.",
    });
  }
});

// GET /api/owner/sessions/:sessionId

router.get("/sessions/:sessionId", async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!isValidOwnerId(ownerId)) {
      return res.status(400).json({
        error: "Invalid owner ID in authentication token.",
      });
    }

    const ownerObjectId = getOwnerObjectId(req);
    const deviceIds = await getOwnerDeviceIds(ownerObjectId);
    const sessionId = String(req.params.sessionId || "").trim();

    if (!sessionId) {
      return res.status(400).json({
        error: "Session ID is required.",
      });
    }

    const session = await Session.findOne({
      sessionId,
      deviceId: { $in: deviceIds },
      status: { $in: ["active", "paused"] },
      endTime: null,
    })
      .select(
        "sessionId deviceId status startTime estimatedEndTime " +
        "energyConsumed latestVoltage latestCurrent latestPower " +
        "lastUpdate userId -_id"
      )
      .populate("userId", "vehicleNumber vehicleModel")
      .lean();

    if (!session) {
      return res.status(404).json({
        error: "Live session not found in your account.",
      });
    }

    const device = await Device.findOne({
      ownerId: ownerObjectId,
      device_id: session.deviceId,
    })
      .select("device_id project location city state charger_type")
      .lean();

    return res.status(200).json({
      session: {
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        status: session.status,
        startTime: session.startTime || null,
        estimatedEndTime: session.estimatedEndTime || null,
        energyConsumed: round3(session.energyConsumed),

        latestVoltage: session.latestVoltage ?? null,
        latestCurrent: session.latestCurrent ?? null,
        latestPower: session.latestPower ?? null,
        lastUpdate: session.lastUpdate || null,

        vehicleNumber: session.userId?.vehicleNumber || "",
        vehicleModel: session.userId?.vehicleModel || "",
      },

      device: device
        ? {
            deviceId: device.device_id,
            project: device.project || "",
            location: device.location || "",
            city: device.city || "",
            state: device.state || "",
            chargerType: device.charger_type || "",
          }
        : null,
    });
  } catch (error) {
    console.error("Owner live session detail error:", error);

    return res.status(500).json({
      error: "Could not fetch live session details.",
    });
  }
});

// GET /api/owner/receipts provides receipt history and pagination.

router.get("/receipts", async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!isValidOwnerId(ownerId)) {
      return res.status(400).json({
        error: "Invalid owner ID in authentication token.",
      });
    }

    const ownerObjectId = getOwnerObjectId(req);
    let deviceIds = await getOwnerDeviceIds(ownerObjectId);

    if (
      typeof req.query.deviceId === "string" &&
      req.query.deviceId.trim()
    ) {
      const requestedDeviceId = req.query.deviceId.trim();

      if (!deviceIds.includes(requestedDeviceId)) {
        return res.status(404).json({
          error: "Device not found in your account.",
        });
      }

      deviceIds = [requestedDeviceId];
    }

    const filter = {
      deviceId: { $in: deviceIds },
    };

    const dateMatch = buildOptionalDateFilter(
      req.query,
      "createdAt"
    );

    if (dateMatch.error) {
      return res.status(400).json({
        error: dateMatch.error,
      });
    }

    Object.assign(filter, dateMatch.filter);

    if (
      typeof req.query.search === "string" &&
      req.query.search.trim()
    ) {
      const search = new RegExp(
        escapeRegex(req.query.search.trim()),
        "i"
      );

      filter.$or = [
        { receiptId: search },
        { deviceId: search },
        { vehicleNumber: search },
        { vehicleModel: search },
      ];
    }

    const page = Math.max(
      1,
      parseInt(req.query.page, 10) || 1
    );

    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 25)
    );

    const skip = (page - 1) * limit;

    const [receipts, total] = await Promise.all([
      Receipt.find(filter)
        .select(
          "receiptId deviceId vehicleNumber vehicleModel createdAt " +
          "totalAmount taxableAmount gstAmount energyConsumed ownerPayout -_id"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Receipt.countDocuments(filter),
    ]);

    return res.status(200).json({
      items: receipts.map(shapeOwnerReceipt),

      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },

      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Owner receipt history error:", error);

    return res.status(500).json({
      error: "Could not fetch owner receipt history.",
    });
  }
});


// GET /api/owner/receipts/:receiptId gives the owner-safe details for one receipt:
router.get("/receipts/:receiptId", async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!isValidOwnerId(ownerId)) {
      return res.status(400).json({
        error: "Invalid owner ID in authentication token.",
      });
    }

    const ownerObjectId = getOwnerObjectId(req);
    const deviceIds = await getOwnerDeviceIds(ownerObjectId);
    const receiptId = String(req.params.receiptId || "").trim();

    if (!receiptId) {
      return res.status(400).json({
        error: "Receipt ID is required.",
      });
    }

    const receipt = await Receipt.findOne({
      receiptId,
      deviceId: { $in: deviceIds },
    })
      .select(
        "receiptId deviceId vehicleNumber vehicleModel createdAt " +
        "totalAmount taxableAmount gstAmount energyConsumed ownerPayout -_id"
      )
      .lean();

    if (!receipt) {
      return res.status(404).json({
        error: "Receipt not found in your account.",
      });
    }

    return res.status(200).json({
      receipt: shapeOwnerReceipt(receipt),
    });
  } catch (error) {
    console.error("Owner receipt detail error:", error);

    return res.status(500).json({
      error: "Could not fetch receipt details.",
    });
  }
});


// GET /api/owner/finance/summary
//
// Optional query:
// ?from=2026-10-01&to=2026-10-17
// ?bucket=day  // accepted by the shared date-range helper

router.get("/finance/summary", async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!isValidOwnerId(ownerId)) {
      return res.status(400).json({
        error: "Invalid owner ID in authentication token.",
      });
    }

    const range = getPeriodRange(req.query);

    if (range.error) {
      return res.status(400).json({
        error: range.error,
      });
    }

    const { from, to } = range;
    const ownerObjectId = getOwnerObjectId(req);
    let deviceIds = await getOwnerDeviceIds(ownerObjectId);

    if (
      typeof req.query.deviceId === "string" &&
      req.query.deviceId.trim()
    ) {
      const requestedDeviceId = req.query.deviceId.trim();

      if (!deviceIds.includes(requestedDeviceId)) {
        return res.status(404).json({
          error: "Device not found in your account.",
        });
      }

      deviceIds = [requestedDeviceId];
    }

    let totals = emptyReceiptSummary();

    if (deviceIds.length) {
      const [row] = await Receipt.aggregate([
        {
          $match: {
            deviceId: { $in: deviceIds },
            createdAt: { $gte: from, $lt: to },
          },
        },
        {
          $group: {
            _id: null,

            receiptCount: { $sum: 1 },

            energyConsumed: {
              $sum: { $ifNull: ["$energyConsumed", 0] },
            },

            taxableAmount: {
              $sum: { $ifNull: ["$taxableAmount", 0] },
            },

            gstAmount: {
              $sum: { $ifNull: ["$gstAmount", 0] },
            },

            totalAmount: {
              $sum: { $ifNull: ["$totalAmount", 0] },
            },

            ownerPayout: {
              $sum: { $ifNull: ["$ownerPayout", 0] },
            },
          },
        },
      ]);

      if (row) {
        totals = {
          receiptCount: Number(row.receiptCount || 0),
          energyConsumed: round3(row.energyConsumed),
          taxableAmount: round2(row.taxableAmount),
          gstAmount: round2(row.gstAmount),
          totalAmount: round2(row.totalAmount),
          ownerPayout: round2(row.ownerPayout),
        };
      }
    }

    return res.status(200).json({
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        timezone: "Asia/Kolkata",
      },

      totals,

      metadata: {
        generatedAt: new Date().toISOString(),
        source: "Receipt records only",
      },
    });
  } catch (error) {
    console.error("Owner finance summary error:", error);

    return res.status(500).json({
      error: "Could not fetch owner finance summary.",
    });
  }
});


// GET /api/owner/finance/monthly?month=YYYY-MM
//
// Returns:
// - Available monthly filters, starting from the owner's first receipt
// - Receipt-only financial summary for the selected month
// - VJRA-borne electricity bill reconciliation, only when applicable
// - Receipt payout settlement status from OwnerSettlement
//
// "to" month boundary is exclusive. All month boundaries use Asia/Kolkata.

router.get("/finance/monthly", async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!isValidOwnerId(ownerId)) {
      return res.status(400).json({
        error: "Invalid owner ID in authentication token.",
      });
    }

    const ownerObjectId = getOwnerObjectId(req);

    // Find only devices owned by the authenticated owner.
    const ownedDevices = await Device.find({
      ownerId: ownerObjectId,
    })
      .select(
        "device_id project commercial.electricityBearer"
      )
      .lean();

    const deviceIds = ownedDevices
      .map((device) => device.device_id)
      .filter(Boolean);

    // Date helpers use the existing Asia/Kolkata offset in this file.
    const getIstMonthKey = (date) => {
      const shifted = new Date(
        new Date(date).getTime() + IST_OFFSET_MS
      );

      const year = shifted.getUTCFullYear();
      const month = String(
        shifted.getUTCMonth() + 1
      ).padStart(2, "0");

      return `${year}-${month}`;
    };

    const getIstNextMonthStart = (date) => {
      const shifted = new Date(
        date.getTime() + IST_OFFSET_MS
      );

      return new Date(
        Date.UTC(
          shifted.getUTCFullYear(),
          shifted.getUTCMonth() + 1,
          1
        ) - IST_OFFSET_MS
      );
    };

    const monthKeyToRange = (monthKey) => {
      const match = monthKey.match(
        /^(\d{4})-(0[1-9]|1[0-2])$/
      );

      if (!match) return null;

      const year = Number(match[1]);
      const monthNumber = Number(match[2]);

      return {
        from: new Date(
          Date.UTC(year, monthNumber - 1, 1) - IST_OFFSET_MS
        ),
        to: new Date(
          Date.UTC(year, monthNumber, 1) - IST_OFFSET_MS
        ),
      };
    };

    const currentMonthStart = getIstMonthStart(new Date());
    const currentMonthKey = getIstMonthKey(currentMonthStart);

    // Determine the first available filter month from Receipts.
    const firstReceipt = deviceIds.length
      ? await Receipt.findOne({
          deviceId: { $in: deviceIds },
        })
          .select("createdAt")
          .sort({ createdAt: 1 })
          .lean()
      : null;

    let earliestMonthStart = firstReceipt?.createdAt
      ? getIstMonthStart(new Date(firstReceipt.createdAt))
      : currentMonthStart;

    // Safety: never offer a month after the current month.
    if (earliestMonthStart > currentMonthStart) {
      earliestMonthStart = currentMonthStart;
    }

    const earliestAvailableMonth =
      getIstMonthKey(earliestMonthStart);

    const availableMonths = [];

    let cursor = new Date(earliestMonthStart);

    while (cursor <= currentMonthStart) {
      availableMonths.push(getIstMonthKey(cursor));
      cursor = getIstNextMonthStart(cursor);
    }

    // Newest month first, down to the earliest receipt month.
    availableMonths.reverse();

    const month =
      typeof req.query.month === "string" &&
      req.query.month.trim()
        ? req.query.month.trim()
        : currentMonthKey;

    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({
        error: "Invalid month. Use YYYY-MM.",
      });
    }

    if (month > currentMonthKey) {
      return res.status(400).json({
        error: "Future months cannot be selected.",
      });
    }

    if (month < earliestAvailableMonth) {
      return res.status(400).json({
        error:
          "The selected month is before the first available receipt month.",
        earliestAvailableMonth,
      });
    }

    const period = monthKeyToRange(month);

    if (!period) {
      return res.status(400).json({
        error: "Could not determine the selected month.",
      });
    }

    const { from, to } = period;

    // --------------------------------------------------------
    // 1. RECEIPT-ONLY FINANCIAL SUMMARY
    // --------------------------------------------------------

    let receiptTotals = {
      receiptCount: 0,
      energyConsumed: 0,
      taxableAmount: 0,
      gstAmount: 0,
      totalAmount: 0,
      vjraMarginAmount: 0,
      ownerPayout: 0,

      // Internal reconciliation field. Not a customer or transaction detail.
      payoutEligibleReceiptCount: 0,
    };

    if (deviceIds.length) {
      const [row] = await Receipt.aggregate([
        {
          $match: {
            deviceId: { $in: deviceIds },
            createdAt: { $gte: from, $lt: to },
          },
        },
        {
          $group: {
            _id: null,

            receiptCount: {
              $sum: 1,
            },

            energyConsumed: {
              $sum: {
                $ifNull: ["$energyConsumed", 0],
              },
            },

            taxableAmount: {
              $sum: {
                $ifNull: ["$taxableAmount", 0],
              },
            },

            gstAmount: {
              $sum: {
                $ifNull: ["$gstAmount", 0],
              },
            },

            totalAmount: {
              $sum: {
                $ifNull: ["$totalAmount", 0],
              },
            },

            vjraMarginAmount: {
              $sum: {
                $ifNull: ["$vjraMarginAmount", 0],
              },
            },

            ownerPayout: {
              $sum: {
                $ifNull: ["$ownerPayout", 0],
              },
            },

            payoutEligibleReceiptCount: {
              $sum: {
                $cond: [
                  {
                    $gt: [
                      { $ifNull: ["$ownerPayout", 0] },
                      0,
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]);

      if (row) {
        receiptTotals = {
          receiptCount: Number(row.receiptCount || 0),
          energyConsumed: round3(row.energyConsumed),
          taxableAmount: round2(row.taxableAmount),
          gstAmount: round2(row.gstAmount),
          totalAmount: round2(row.totalAmount),
          vjraMarginAmount: round2(row.vjraMarginAmount),
          ownerPayout: round2(row.ownerPayout),
          payoutEligibleReceiptCount: Number(
            row.payoutEligibleReceiptCount || 0
          ),
        };
      }
    }

    // --------------------------------------------------------
    // 2. ELECTRICITY BILL RECONCILIATION
    // Show this section only when at least one owned device
    // has commercial.electricityBearer === "VJRA".
    // --------------------------------------------------------

    const vjraDevices = ownedDevices.filter(
      (device) =>
        String(
          device.commercial?.electricityBearer || ""
        ).toUpperCase() === "VJRA"
    );

    const electricityApplicable = vjraDevices.length > 0;

    // Group VJRA-borne devices by project. ElectricityBill is
    // recorded per project and month.
    const projectMap = new Map();

    for (const device of vjraDevices) {
      const projectName = String(device.project || "").trim();

      const projectKey = projectName || "__UNASSIGNED__";

      if (!projectMap.has(projectKey)) {
        projectMap.set(projectKey, {
          project: projectName || "Project not assigned",
          projectKey: projectName || null,
          deviceCount: 0,
        });
      }

      projectMap.get(projectKey).deviceCount += 1;
    }

    const vjraProjectRows = [...projectMap.values()];

    const validProjectNames = vjraProjectRows
      .map((row) => row.projectKey)
      .filter(Boolean);

    const billDocuments =
      validProjectNames.length > 0
        ? await ElectricityBill.find({
            project: { $in: validProjectNames },
            month,
            isVoided: false,
          })
            .select(
              "project month status totalOwnerPayable totalEBAmount " +
              "ownerPayment.submittedAt ownerPayment.verifiedAt"
            )
            .lean()
        : [];

    const billByProject = new Map(
      billDocuments.map((bill) => [
        bill.project,
        bill,
      ])
    );

    const electricityProjects = vjraProjectRows.map(
      (projectRow) => {
        const bill = projectRow.projectKey
          ? billByProject.get(projectRow.projectKey)
          : null;

        if (!bill) {
          return {
            project: projectRow.project,
            deviceCount: projectRow.deviceCount,

            billGenerated: false,
            status: "not_generated",

            totalMsebBill: null,
            ownerPayable: null,
            vjraPayable: null,

            ownerPaymentVerified: false,
            canPay: false,
          };
        }

        const totalMsebBill = round2(bill.totalEBAmount);
        const ownerPayable = round2(bill.totalOwnerPayable);

        // Per the requested formula:
        // VJRA payable = full MSEB bill - owner's payable share.
        const vjraPayable = round2(
          totalMsebBill - ownerPayable
        );

        return {
          project: projectRow.project,
          deviceCount: projectRow.deviceCount,

          billGenerated: true,
          status: bill.status,

          totalMsebBill,
          ownerPayable,
          vjraPayable,

          ownerPaymentVerified: [
            "payment_verified",
            "eb_paid_to_mseb",
          ].includes(bill.status),

          // The existing record-payment API only accepts "uploaded".
          canPay: bill.status === "uploaded",

          paymentSubmittedAt:
            bill.ownerPayment?.submittedAt || null,

          paymentVerifiedAt:
            bill.ownerPayment?.verifiedAt || null,
        };
      }
    );

    const allVjraBillsGenerated =
      electricityApplicable &&
      electricityProjects.length > 0 &&
      electricityProjects.every(
        (project) => project.billGenerated
      );

    const totalMsebBill = round2(
      electricityProjects.reduce(
        (sum, project) =>
          sum + Number(project.totalMsebBill || 0),
        0
      )
    );

    const totalOwnerPayable = round2(
      electricityProjects.reduce(
        (sum, project) =>
          sum + Number(project.ownerPayable || 0),
        0
      )
    );

    const totalVjraPayable = round2(
      electricityProjects.reduce(
        (sum, project) =>
          sum + Number(project.vjraPayable || 0),
        0
      )
    );

    // When no VJRA-bearing devices exist, there is no EB offset.
    // If bills are missing, this value is provisional because
    // their owner-payable amounts are not yet known.
    const netOwnerPayout = electricityApplicable
      ? round2(receiptTotals.ownerPayout - totalOwnerPayable)
      : round2(receiptTotals.ownerPayout);

    const netOwnerPayoutComplete =
      !electricityApplicable || allVjraBillsGenerated;

    // --------------------------------------------------------
    // 3. OWNER PAYOUT SETTLEMENT STATUS
    //
    // This status is derived from OwnerSettlement line items
    // whose receipt dates fall inside the selected month.
    //
    // Existing settlements record Receipt.ownerPayout before
    // electricity-bill offsets. Keep that distinction explicit.
    // --------------------------------------------------------

    const settlementGroups = await OwnerSettlement.aggregate([
      {
        $match: {
          ownerId: ownerObjectId,
          "lineItems.receiptCreatedAt": {
            $gte: from,
            $lt: to,
          },
        },
      },
      {
        $unwind: "$lineItems",
      },
      {
        $match: {
          "lineItems.receiptCreatedAt": {
            $gte: from,
            $lt: to,
          },
          "lineItems.payoutAmount": { $gt: 0 },
        },
      },
      {
        $group: {
          _id: "$status",

          receiptCount: {
            $sum: 1,
          },

          payoutAmount: {
            $sum: {
              $ifNull: ["$lineItems.payoutAmount", 0],
            },
          },
        },
      },
    ]);

    const settlementSummary = settlementGroups.reduce(
      (summary, row) => {
        const count = Number(row.receiptCount || 0);
        const amount = Number(row.payoutAmount || 0);

        summary.settledReceiptCount += count;
        summary.recordedPayoutAmount += amount;

        if (row._id === "paid") {
          summary.paidReceiptCount += count;
          summary.paidPayoutAmount += amount;
        }

        return summary;
      },
      {
        settledReceiptCount: 0,
        recordedPayoutAmount: 0,
        paidReceiptCount: 0,
        paidPayoutAmount: 0,
      }
    );

    const eligibleReceipts =
      receiptTotals.payoutEligibleReceiptCount;

    let payoutSettlementStatus = "not_applicable";

    if (eligibleReceipts > 0) {
      if (
        settlementSummary.paidReceiptCount >= eligibleReceipts
      ) {
        payoutSettlementStatus = "paid";
      } else if (settlementSummary.paidReceiptCount > 0) {
        payoutSettlementStatus = "partially_paid";
      } else if (settlementSummary.settledReceiptCount > 0) {
        payoutSettlementStatus = "pending";
      } else {
        payoutSettlementStatus = "not_settled";
      }
    }

    return res.status(200).json({
      month,
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        timezone: "Asia/Kolkata",
        endIsExclusive: true,
      },

      availableMonths,
      earliestAvailableMonth,

      // These totals are all derived from Receipt records.
      totals: {
        receiptCount: receiptTotals.receiptCount,
        totalAmount: receiptTotals.totalAmount,
        taxableAmount: receiptTotals.taxableAmount,
        gstAmount: receiptTotals.gstAmount,
        vjraMarginAmount: receiptTotals.vjraMarginAmount,
        energyConsumed: receiptTotals.energyConsumed,
        ownerPayout: receiptTotals.ownerPayout,

        netOwnerPayout,
        netOwnerPayoutComplete,
      },

      // Omit this entire section from the UI when applicable=false.
      electricity: {
        applicable: electricityApplicable,
        allBillsGenerated: allVjraBillsGenerated,
        missingBillCount: electricityProjects.filter(
          (project) => !project.billGenerated
        ).length,

        projects: electricityProjects,

        totals: electricityApplicable
          ? {
              totalMsebBill,
              totalOwnerPayable,
              totalVjraPayable,
              netOwnerPayout,
              netOwnerPayoutComplete,
            }
          : null,
      },

      payoutSettlement: {
        status: payoutSettlementStatus,

        eligibleReceiptCount: eligibleReceipts,
        settledReceiptCount:
          settlementSummary.settledReceiptCount,
        paidReceiptCount:
          settlementSummary.paidReceiptCount,

        recordedPayoutAmount: round2(
          settlementSummary.recordedPayoutAmount
        ),

        paidPayoutAmount: round2(
          settlementSummary.paidPayoutAmount
        ),

        // OwnerSettlement currently tracks gross receipt payout,
        // before any electricity-bill offsets.
        basis: "receipt_owner_payout_before_electricity_offset",
      },

      metadata: {
        generatedAt: new Date().toISOString(),
        financialSource: "Receipt records only",
        electricitySource: "ElectricityBill records for VJRA-borne projects",
        settlementSource: "OwnerSettlement receipt line items",
      },
    });
  } catch (error) {
    console.error("Owner monthly finance error:", error);

    return res.status(500).json({
      error: "Could not fetch monthly finance and settlement summary.",
    });
  }
});


// GET /api/owner/reports/sessions.csv
//
// Optional query:
// ?from=2026-10-01&to=2026-10-17
// &deviceId=VIZ1A02&status=completed

router.get("/reports/sessions.csv", async (req, res) => {
  try {
    return await sendOwnerReceiptCsv(
      req,
      res,
      "viz-owner-receipts.csv"
    );
  } catch (error) {
    console.error("Owner receipt CSV error:", error);

    return res.status(500).json({
      error: "Could not export owner receipt report.",
    });
  }
});

// GET /api/owner/reports/finance.csv
//
// Optional query:
// ?from=2026-10-01&to=2026-10-17
// ?deviceId=VIZ1A02
//
// If dates are omitted, uses the current IST month-to-date period.

router.get("/reports/finance.csv", async (req, res) => {
  try {
    return await sendOwnerReceiptCsv(
      req,
      res,
      "viz-owner-finance.csv"
    );
  } catch (error) {
    console.error("Owner finance CSV error:", error);

    return res.status(500).json({
      error: "Could not export owner finance report.",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// OWNER SETTLEMENT READ APIs
// All queries are scoped to the authenticated owner.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/owner/finance/settlements
// Optional: ?page=1&limit=25&status=pending&from=2026-10-01&to=2026-10-17

router.get("/finance/settlements", async (req, res) => {
  try {
    const ownerId = req.user.userId;

    if (!isValidOwnerId(ownerId)) {
      return res.status(400).json({
        error: "Invalid owner ID in authentication token.",
      });
    }

    const ownerObjectId = getOwnerObjectId(req);

    const page = Math.max(
      1,
      parseInt(req.query.page, 10) || 1
    );

    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 25)
    );

    const filter = {
      ownerId: ownerObjectId,
    };

    const allowedStatuses = [
      "pending",
      "processing",
      "paid",
      "failed",
      "on_hold",
    ];

    if (
      typeof req.query.status === "string" &&
      req.query.status.trim()
    ) {
      const status = req.query.status.trim().toLowerCase();

      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          error: "Invalid settlement status.",
          allowedStatuses,
        });
      }

      filter.status = status;
    }

    const dateFilter = buildOptionalDateFilter(
      req.query,
      "createdAt"
    );

    if (dateFilter.error) {
      return res.status(400).json({
        error: dateFilter.error,
      });
    }

    Object.assign(filter, dateFilter.filter);

    // Summary totals cover all the owner's settlements, independently
    // of the pagination/status/date filters on the register.
    const [
      documents,
      total,
      summaryRows,
    ] = await Promise.all([
      OwnerSettlement.find(filter)
        .select("-lineItems -statusHistory")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      OwnerSettlement.countDocuments(filter),

      OwnerSettlement.aggregate([
        {
          $match: {
            ownerId: ownerObjectId,
          },
        },
        {
          $group: {
            _id: null,

            totalSettlements: {
              $sum: 1,
            },

            paidSettlements: {
              $sum: {
                $cond: [{ $eq: ["$status", "paid"] }, 1, 0],
              },
            },

            paidAmount: {
              $sum: {
                $cond: [
                  { $eq: ["$status", "paid"] },
                  { $ifNull: ["$amountPaid", 0] },
                  0,
                ],
              },
            },

            outstandingAmount: {
              $sum: {
                $cond: [
                  { $in: ["$status", [
                    "pending",
                    "processing",
                    "failed",
                    "on_hold",
                  ]] },
                  { $ifNull: ["$payoutAmount", 0] },
                  0,
                ],
              },
            },

            failedSettlements: {
              $sum: {
                $cond: [{ $eq: ["$status", "failed"] }, 1, 0],
              },
            },

            onHoldSettlements: {
              $sum: {
                $cond: [{ $eq: ["$status", "on_hold"] }, 1, 0],
              },
            },
          },
        },
      ]),
    ]);

    const summary = summaryRows[0] || {};

    return res.status(200).json({
      items: documents.map((item) => ({
        settlementId: item.settlementId,
        periodStart: item.periodStart,
        periodEnd: item.periodEnd,
        periodEndIsExclusive: true,

        status: item.status,

        receiptCount: Number(item.receiptCount || 0),
        totalEnergyKwh: round3(item.totalEnergyKwh),
        customerBillingsInclGst: round2(
          item.customerBillingsInclGst
        ),

        payoutAmount: round2(item.payoutAmount),
        amountPaid: round2(item.amountPaid),

        payoutMethod: item.payoutMethod || null,
        paymentReference: item.paymentReference || "",
        paidAt: item.paidAt || null,

        failureReason: item.failureReason || "",
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),

      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },

      summary: {
        totalSettlements: Number(summary.totalSettlements || 0),
        paidSettlements: Number(summary.paidSettlements || 0),
        paidAmount: round2(summary.paidAmount),
        outstandingAmount: round2(summary.outstandingAmount),
        failedSettlements: Number(summary.failedSettlements || 0),
        onHoldSettlements: Number(summary.onHoldSettlements || 0),
      },

      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Owner settlement list error:", error);

    return res.status(500).json({
      error: "Could not fetch your settlements.",
    });
  }
});

// GET /api/owner/finance/settlements/:settlementId
// Optional line pagination: ?page=1&limit=50

router.get(
  "/finance/settlements/:settlementId",
  async (req, res) => {
    try {
      const ownerId = req.user.userId;

      if (!isValidOwnerId(ownerId)) {
        return res.status(400).json({
          error: "Invalid owner ID in authentication token.",
        });
      }

      const settlementId = String(
        req.params.settlementId || ""
      ).trim();

      const ownerObjectId = getOwnerObjectId(req);

      const page = Math.max(
        1,
        parseInt(req.query.page, 10) || 1
      );

      const limit = Math.min(
        100,
        Math.max(1, parseInt(req.query.limit, 10) || 50)
      );

      const settlement = await OwnerSettlement.findOne({
        settlementId,
        ownerId: ownerObjectId,
      }).lean();

      // The owner scope is applied directly to the lookup.
      // This does not reveal another owner's settlement.
      if (!settlement) {
        return res.status(404).json({
          error: "Settlement not found in your account.",
        });
      }

      const allItems = settlement.lineItems || [];
      const startIndex = (page - 1) * limit;

      const items = allItems
        .slice(startIndex, startIndex + limit)
        .map((item) => ({
          receiptId: item.receiptId,
          sessionId: item.sessionId,
          deviceId: item.deviceId,
          receiptCreatedAt: item.receiptCreatedAt,

          energyKwh: round3(item.energyKwh),
          customerBillingsInclGst: round2(
            item.customerBillingsInclGst
          ),
          refundAmountSnapshot: round2(
            item.refundAmountSnapshot
          ),
          payoutAmount: round2(item.payoutAmount),
        }));

      return res.status(200).json({
        settlement: {
          settlementId: settlement.settlementId,

          periodStart: settlement.periodStart,
          periodEnd: settlement.periodEnd,
          periodEndIsExclusive: true,

          status: settlement.status,

          receiptCount: Number(settlement.receiptCount || 0),
          totalEnergyKwh: round3(settlement.totalEnergyKwh),
          customerBillingsInclGst: round2(
            settlement.customerBillingsInclGst
          ),
          refundAmountSnapshot: round2(
            settlement.refundAmountSnapshot
          ),

          payoutAmount: round2(settlement.payoutAmount),
          amountPaid: round2(settlement.amountPaid),

          payoutMethod: settlement.payoutMethod || null,
          paymentReference: settlement.paymentReference || "",
          paidAt: settlement.paidAt || null,
          failureReason: settlement.failureReason || "",

          notes: settlement.notes || "",
          createdAt: settlement.createdAt,
          updatedAt: settlement.updatedAt,

          statusHistory: (settlement.statusHistory || []).map(
            (entry) => ({
              fromStatus: entry.fromStatus,
              toStatus: entry.toStatus,
              changedByRole: entry.changedByRole,
              reason: entry.reason || "",
              paymentReference: entry.paymentReference || "",
              changedAt: entry.changedAt,
            })
          ),
        },

        items,

        pagination: {
          page,
          limit,
          total: allItems.length,
          totalPages: Math.ceil(allItems.length / limit),
        },
      });
    } catch (error) {
      console.error("Owner settlement detail error:", error);

      return res.status(500).json({
        error: "Could not fetch settlement details.",
      });
    }
  }
);

module.exports = router;