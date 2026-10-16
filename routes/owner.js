// routes/owner.js

const express = require("express");
const mongoose = require("mongoose");

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const Device = require("../models/device");
const Session = require("../models/session");
const Receipt = require("../models/Receipt");
const DeviceTelemetry = require("../models/deviceTelemetry");

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
  "device_id project location status charger_type rate " +
  "area city state lat lng relayOn lastSeen onboardingStatus " +
  "onboardedAt updatedAt totalenergy current_session_id";

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
    completedSessions: 0,
    energyKwh: 0,
    customerBillingsInclGst: 0,
    gstAmount: 0,
    refunds: 0,
    estimatedOwnerPayout: 0,
  };
}

/**
 * Use Receipt snapshots for completed-session metrics.
 * This does not load every receipt into Node.js.
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

        completedSessions: { $sum: 1 },

        energyKwh: {
          $sum: { $ifNull: ["$energyConsumed", 0] },
        },

        customerBillingsInclGst: {
          $sum: { $ifNull: ["$totalAmount", 0] },
        },

        gstAmount: {
          $sum: { $ifNull: ["$gstAmount", 0] },
        },

        refunds: {
          $sum: { $ifNull: ["$refundAmount", 0] },
        },

        estimatedOwnerPayout: {
          $sum: { $ifNull: ["$ownerPayout", 0] },
        },
      },
    },
  ]);

  if (!row) {
    return emptyReceiptSummary();
  }

  return {
    completedSessions: Number(row.completedSessions || 0),
    energyKwh: round3(row.energyKwh),
    customerBillingsInclGst: round2(row.customerBillingsInclGst),
    gstAmount: round2(row.gstAmount),
    refunds: round2(row.refunds),
    estimatedOwnerPayout: round2(row.estimatedOwnerPayout),
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
    deviceId: device.device_id,
    project: device.project || "",
    location: device.location || "",
    status: device.status || "Unknown",
    chargerType: device.charger_type || "",
    rateInclGst: Number(device.rate || 0),

    area: device.area || "",
    city: device.city || "",
    state: device.state || "",

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
              "energySelected energyConsumed amountPaid -_id"
            )
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

            sessions: { $sum: 1 },

            energyKwh: {
              $sum: { $ifNull: ["$energyConsumed", 0] },
            },

            customerBillingsInclGst: {
              $sum: { $ifNull: ["$totalAmount", 0] },
            },

            estimatedOwnerPayout: {
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
      completedSessions: currentSummary.completedSessions,
      energyKwh: currentSummary.energyKwh,
      customerBillingsInclGst:
        currentSummary.customerBillingsInclGst,
      gstAmount: currentSummary.gstAmount,
      refunds: currentSummary.refunds,
      estimatedOwnerPayout: currentSummary.estimatedOwnerPayout,

      // Do not infer cash collected from billed receipt totals.
      // Payment/refund reconciliation will be implemented in the Finance API.
      paymentsReceivedNet: null,
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
        sessions: Number(row.sessions || 0),
        energyKwh: round3(row.energyKwh),
        customerBillingsInclGst:
          round2(row.customerBillingsInclGst),
        estimatedOwnerPayout: round2(row.estimatedOwnerPayout),
      })),

      activeSessionsPreview: activeSessionDocs.map((session) => ({
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        status: session.status,
        startTime: session.startTime || null,
        estimatedEndTime: session.estimatedEndTime || null,
        energySelected: round3(session.energySelected),
        energyConsumed: round3(session.energyConsumed),
        amountPaid: round2(session.amountPaid),
      })),

      // Current-state issues only; persistent alert history will be a later phase.
      alerts: alerts.slice(0, 8),

      metadata: {
        generatedAt: new Date().toISOString(),
        onlineThresholdMs: ONLINE_THRESHOLD_MS,
        paymentCollectionMetric: "not_yet_reconciled",
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

    const [latestTelemetry, recentSessions] = await Promise.all([
      DeviceTelemetry.findOne({
        deviceId,
        timestamp: { $gte: telemetryCutoff },
      })
        .select("voltage current power timestamp -_id")
        .sort({ timestamp: -1 })
        .lean(),

      Session.find({ deviceId })
        .select(
          "sessionId deviceId status startTime endTime " +
          "energySelected energyConsumed amountPaid amountUsed -_id"
        )
        .sort({ startTime: -1 })
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

      recentSessions: recentSessions.map((session) => ({
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        status: session.status,
        startTime: session.startTime || null,
        endTime: session.endTime || null,
        energySelected: round3(session.energySelected),
        energyConsumed: round3(session.energyConsumed),
        amountPaid: round2(session.amountPaid),
        amountUsed: round2(session.amountUsed),
      })),

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

module.exports = router;