// routes/owner.js

const express = require("express");
const mongoose = require("mongoose");

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const Device = require("../models/device");
const Session = require("../models/session");
const Receipt = require("../models/Receipt");
const DeviceTelemetry = require("../models/deviceTelemetry");

const Payment = require("../models/Payment");
const Refund = require("../models/Refund");
const DeviceRateAudit = require("../models/DeviceRateAudit");

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

    // A requested device can only narrow this owner's device list.
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

    const validStatuses = ["active", "completed", "faulty"];

    if (
      typeof req.query.status === "string" &&
      req.query.status.trim()
    ) {
      const status = req.query.status.trim().toLowerCase();

      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: "Invalid status. Use active, completed or faulty.",
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
      const searchRegex = new RegExp(search, "i");

      filter.$or = [
        { sessionId: searchRegex },
        { transactionId: searchRegex },
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
          "sessionId transactionId deviceId userId status " +
          "startTime endTime endTrigger paymentGateway " +
          "energySelected energyConsumed ratePerKwh " +
          "amountSelected amountPaid amountUsed discountApplied " +
          "latestVoltage latestCurrent latestPower lastUpdate"
        )
        .populate("userId", "name email mobile")
        .sort({ startTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Session.countDocuments(filter),
    ]);

    return res.status(200).json({
      items: sessions.map((session) => ({
        sessionId: session.sessionId,
        transactionId: session.transactionId,
        deviceId: session.deviceId,
        status: session.status,

        startTime: session.startTime || null,
        endTime: session.endTime || null,
        endTrigger: session.endTrigger || null,
        paymentGateway: session.paymentGateway || null,

        energySelected: round3(session.energySelected),
        energyConsumed: round3(session.energyConsumed),
        ratePerKwh: round2(session.ratePerKwh),

        amountSelected: round2(session.amountSelected),
        amountPaid: round2(session.amountPaid),
        amountUsed: round2(session.amountUsed),
        discountApplied: round2(session.discountApplied),

        latestVoltage: session.latestVoltage ?? null,
        latestCurrent: session.latestCurrent ?? null,
        latestPower: session.latestPower ?? null,
        lastUpdate: session.lastUpdate || null,

        customer: session.userId
          ? {
              id: session.userId._id,
              name: session.userId.name || "",
              email: session.userId.email || "",
              mobile: session.userId.mobile || "",
            }
          : null,
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
    console.error("Owner sessions fetch error:", error);

    return res.status(500).json({
      error: "Could not fetch owner sessions.",
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
    })
      .select(
        "sessionId transactionId deviceId userId status " +
        "startTime endTime endTrigger paymentGateway " +
        "energySelected energyConsumed ratePerKwh " +
        "amountSelected amountPaid amountUsed discountApplied " +
        "latestVoltage latestCurrent latestPower lastUpdate " +
        "estimatedEndTime createdAt updatedAt"
      )
      .populate("userId", "name email mobile")
      .lean();

    if (!session) {
      return res.status(404).json({
        error: "Session not found in your account.",
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
        transactionId: session.transactionId,
        deviceId: session.deviceId,
        status: session.status,

        startTime: session.startTime || null,
        endTime: session.endTime || null,
        endTrigger: session.endTrigger || null,
        estimatedEndTime: session.estimatedEndTime || null,
        paymentGateway: session.paymentGateway || null,

        energySelected: round3(session.energySelected),
        energyConsumed: round3(session.energyConsumed),
        ratePerKwh: round2(session.ratePerKwh),

        amountSelected: round2(session.amountSelected),
        amountPaid: round2(session.amountPaid),
        amountUsed: round2(session.amountUsed),
        discountApplied: round2(session.discountApplied),

        latestVoltage: session.latestVoltage ?? null,
        latestCurrent: session.latestCurrent ?? null,
        latestPower: session.latestPower ?? null,
        lastUpdate: session.lastUpdate || null,

        createdAt: session.createdAt || null,
        updatedAt: session.updatedAt || null,

        customer: session.userId
          ? {
              id: session.userId._id,
              name: session.userId.name || "",
              email: session.userId.email || "",
              mobile: session.userId.mobile || "",
            }
          : null,
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
    console.error("Owner session detail error:", error);

    return res.status(500).json({
      error: "Could not fetch session details.",
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
    const deviceIds = await getOwnerDeviceIds(ownerObjectId);

    const emptyResponse = {
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        timezone: "Asia/Kolkata",
      },

      usage: {
        receiptCount: 0,
        energyKwh: 0,
        customerBillingsInclGst: 0,
        gstAmount: 0,
        receiptRefunds: 0,
        estimatedOwnerPayout: 0,
      },

      collections: {
        successfulChargingPaymentCount: 0,
        successfulChargingPaymentAmount: 0,
        cashfreeGrossAmount: 0,
        walletFundedChargingAmount: 0,
        freeChargingAmount: 0,
        successfulBankRefundAmount: 0,
        successfulWalletRefundAmount: 0,
        netCashfreeCollections: 0,
      },

      metadata: {
        generatedAt: new Date().toISOString(),
        collectionsSource: "Payment and Refund records",
        usageSource: "Receipt snapshots",
        ownerPayoutIsEstimate: true,
      },
    };

    if (!deviceIds.length) {
      return res.status(200).json(emptyResponse);
    }

    const paymentDateMatch = {
      $or: [
        {
          paidAt: {
            $gte: from,
            $lt: to,
          },
        },
        {
          paidAt: null,
          createdAt: {
            $gte: from,
            $lt: to,
          },
        },
      ],
    };

    const refundDateMatch = {
      $or: [
        {
          processedAt: {
            $gte: from,
            $lt: to,
          },
        },
        {
          processedAt: null,
          updatedAt: {
            $gte: from,
            $lt: to,
          },
        },
      ],
    };

    const [
      receiptRows,
      paymentRows,
      refundRows,
    ] = await Promise.all([
      // Usage, billing, tax and estimated payout snapshots.
      Receipt.aggregate([
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

            energyKwh: {
              $sum: { $ifNull: ["$energyConsumed", 0] },
            },

            customerBillingsInclGst: {
              $sum: { $ifNull: ["$totalAmount", 0] },
            },

            gstAmount: {
              $sum: { $ifNull: ["$gstAmount", 0] },
            },

            receiptRefunds: {
              $sum: { $ifNull: ["$refundAmount", 0] },
            },

            estimatedOwnerPayout: {
              $sum: { $ifNull: ["$ownerPayout", 0] },
            },
          },
        },
      ]),

      // Successful charging-payment records only.
      Payment.aggregate([
        {
          $match: {
            type: "charging",
            status: "SUCCESS",
            ...paymentDateMatch,
          },
        },
        {
          $lookup: {
            from: Session.collection.name,
            localField: "sessionId",
            foreignField: "sessionId",
            as: "linkedSession",
          },
        },
        {
          $unwind: {
            path: "$linkedSession",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $match: {
            $or: [
              {
                "linkedSession.deviceId": {
                  $in: deviceIds,
                },
              },
              {
                deviceId: { $in: deviceIds },
                sessionId: { $in: [null, ""] },
              },
            ],
          },
        },
        {
          $group: {
            _id: { $ifNull: ["$gateway", "unknown"] },

            count: { $sum: 1 },

            amount: {
              $sum: { $ifNull: ["$amountPaid", 0] },
            },
          },
        },
      ]),

      // Successful refunds linked to sessions on owned devices.
      Refund.aggregate([
        {
          $match: {
            status: "SUCCESS",
            ...refundDateMatch,
          },
        },
        {
          $lookup: {
            from: Session.collection.name,
            localField: "sessionId",
            foreignField: "sessionId",
            as: "linkedSession",
          },
        },
        {
          $unwind: "$linkedSession",
        },
        {
          $match: {
            "linkedSession.deviceId": {
              $in: deviceIds,
            },
          },
        },
        {
          $group: {
            _id: { $ifNull: ["$destination", "unknown"] },

            count: { $sum: 1 },

            amount: {
              $sum: { $ifNull: ["$refundAmount", 0] },
            },
          },
        },
      ]),
    ]);

    const usage = receiptRows[0] || {
      receiptCount: 0,
      energyKwh: 0,
      customerBillingsInclGst: 0,
      gstAmount: 0,
      receiptRefunds: 0,
      estimatedOwnerPayout: 0,
    };

    const paymentsByGateway = {};

    for (const row of paymentRows) {
      const gateway = String(row._id || "unknown").toLowerCase();

      paymentsByGateway[gateway] = {
        count: Number(row.count || 0),
        amount: round2(row.amount),
      };
    }

    const refundsByDestination = {};

    for (const row of refundRows) {
      const destination = String(
        row._id || "unknown"
      ).toLowerCase();

      refundsByDestination[destination] = {
        count: Number(row.count || 0),
        amount: round2(row.amount),
      };
    }

    const cashfreeGrossAmount =
      paymentsByGateway.cashfree?.amount || 0;

    const walletFundedChargingAmount =
      paymentsByGateway.wallet?.amount || 0;

    const freeChargingAmount =
      paymentsByGateway.free?.amount || 0;

    const successfulBankRefundAmount =
      refundsByDestination.bank?.amount || 0;

    const successfulWalletRefundAmount =
      refundsByDestination.wallet?.amount || 0;

    const successfulChargingPaymentCount =
      Object.values(paymentsByGateway).reduce(
        (sum, item) => sum + item.count,
        0
      );

    const successfulChargingPaymentAmount =
      Object.values(paymentsByGateway).reduce(
        (sum, item) => sum + item.amount,
        0
      );

    return res.status(200).json({
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        timezone: "Asia/Kolkata",
      },

      usage: {
        receiptCount: Number(usage.receiptCount || 0),
        energyKwh: round3(usage.energyKwh),
        customerBillingsInclGst: round2(
          usage.customerBillingsInclGst
        ),
        gstAmount: round2(usage.gstAmount),
        receiptRefunds: round2(usage.receiptRefunds),
        estimatedOwnerPayout: round2(
          usage.estimatedOwnerPayout
        ),
      },

      collections: {
        successfulChargingPaymentCount,
        successfulChargingPaymentAmount: round2(
          successfulChargingPaymentAmount
        ),

        cashfreeGrossAmount: round2(cashfreeGrossAmount),
        walletFundedChargingAmount: round2(
          walletFundedChargingAmount
        ),
        freeChargingAmount: round2(freeChargingAmount),

        successfulBankRefundAmount: round2(
          successfulBankRefundAmount
        ),
        successfulWalletRefundAmount: round2(
          successfulWalletRefundAmount
        ),

        // This is a net recorded Cashfree figure, not a bank-statement
        // reconciliation or proof that an owner payout was settled.
        netCashfreeCollections: round2(
          cashfreeGrossAmount - successfulBankRefundAmount
        ),
      },

      metadata: {
        generatedAt: new Date().toISOString(),
        collectionsSource: "Payment and Refund records",
        usageSource: "Receipt snapshots",
        ownerPayoutIsEstimate: true,
        walletTopupsAllocatedToOwner: false,
      },
    });
  } catch (error) {
    console.error("Owner finance summary error:", error);

    return res.status(500).json({
      error: "Could not fetch owner finance summary.",
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

    const validStatuses = ["active", "completed", "faulty"];

    if (
      typeof req.query.status === "string" &&
      req.query.status.trim()
    ) {
      const status = req.query.status.trim().toLowerCase();

      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: "Invalid status. Use active, completed or faulty.",
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

    const sessions = await Session.find(filter)
      .select(
        "sessionId transactionId deviceId userId status " +
        "startTime endTime endTrigger paymentGateway " +
        "energySelected energyConsumed ratePerKwh " +
        "amountSelected amountPaid amountUsed discountApplied"
      )
      .populate("userId", "name email")
      .sort({ startTime: -1 })
      .limit(OWNER_EXPORT_LIMIT + 1)
      .lean();

    if (sessions.length > OWNER_EXPORT_LIMIT) {
      return res.status(413).json({
        error:
          "The report exceeds 10,000 rows. Narrow the date range or select a device.",
      });
    }

    const headers = [
      "Session ID",
      "Transaction ID",
      "Device ID",
      "Status",
      "Start Time",
      "End Time",
      "End Trigger",
      "Payment Gateway",
      "Energy Selected (kWh)",
      "Energy Consumed (kWh)",
      "Rate per kWh",
      "Amount Selected",
      "Amount Paid",
      "Amount Used",
      "Discount Applied",
      "Customer Name",
      "Customer Email",
    ];

    const rows = sessions.map((session) => [
      session.sessionId,
      session.transactionId,
      session.deviceId,
      session.status,
      session.startTime || "",
      session.endTime || "",
      session.endTrigger || "",
      session.paymentGateway || "",

      round3(session.energySelected),
      round3(session.energyConsumed),
      round2(session.ratePerKwh),

      round2(session.amountSelected),
      round2(session.amountPaid),
      round2(session.amountUsed),
      round2(session.discountApplied),

      session.userId?.name || "",
      session.userId?.email || "",
    ]);

    return sendOwnerCsv(
      res,
      "viz-owner-sessions.csv",
      headers,
      rows
    );
  } catch (error) {
    console.error("Owner sessions CSV error:", error);

    return res.status(500).json({
      error: "Could not export owner sessions.",
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

    const headers = [
      "Timestamp",
      "Record Type",
      "Status",
      "Device ID",
      "Session ID",
      "Reference ID",
      "Channel",
      "Energy (kWh)",
      "Gross Amount",
      "GST Amount",
      "Refund Amount",
      "Owner Payout Snapshot",
      "Notes",
    ];

    if (!deviceIds.length) {
      return sendOwnerCsv(
        res,
        "viz-owner-finance.csv",
        headers,
        []
      );
    }

    const paymentDateMatch = {
      $or: [
        {
          paidAt: {
            $gte: from,
            $lt: to,
          },
        },
        {
          paidAt: null,
          createdAt: {
            $gte: from,
            $lt: to,
          },
        },
      ],
    };

    const refundDateMatch = {
      $or: [
        {
          processedAt: {
            $gte: from,
            $lt: to,
          },
        },
        {
          processedAt: null,
          updatedAt: {
            $gte: from,
            $lt: to,
          },
        },
      ],
    };

    const [
      receiptDocs,
      paymentDocs,
      refundDocs,
    ] = await Promise.all([
      Receipt.find({
        deviceId: { $in: deviceIds },
        createdAt: { $gte: from, $lt: to },
      })
        .select(
          "receiptId deviceId sessionId paymentGateway createdAt " +
          "energyConsumed totalAmount gstAmount refundAmount ownerPayout"
        )
        .sort({ createdAt: -1 })
        .limit(OWNER_EXPORT_LIMIT + 1)
        .lean(),

      Payment.aggregate([
        {
          $match: {
            type: "charging",
            ...paymentDateMatch,
          },
        },
        {
          $lookup: {
            from: Session.collection.name,
            localField: "sessionId",
            foreignField: "sessionId",
            as: "linkedSession",
          },
        },
        {
          $unwind: {
            path: "$linkedSession",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $match: {
            $or: [
              {
                "linkedSession.deviceId": {
                  $in: deviceIds,
                },
              },
              {
                deviceId: { $in: deviceIds },
                sessionId: { $in: [null, ""] },
              },
            ],
          },
        },
        {
          $project: {
            _id: 0,
            timestamp: { $ifNull: ["$paidAt", "$createdAt"] },
            recordType: { $literal: "payment" },
            status: 1,
            deviceId: {
              $ifNull: ["$linkedSession.deviceId", "$deviceId"],
            },
            sessionId: { $ifNull: ["$sessionId", ""] },
            referenceId: "$orderId",
            channel: { $ifNull: ["$gateway", "unknown"] },
            energyKwh: { $literal: "" },
            grossAmount: { $ifNull: ["$amountPaid", 0] },
            gstAmount: { $literal: "" },
            refundAmount: { $literal: 0 },
            ownerPayout: { $literal: "" },
            notes: { $ifNull: ["$paymentMethod", "Charging payment record"] },
          },
        },
        { $sort: { timestamp: -1 } },
        { $limit: OWNER_EXPORT_LIMIT + 1 },
      ]),

      Refund.aggregate([
        {
          $match: refundDateMatch,
        },
        {
          $lookup: {
            from: Session.collection.name,
            localField: "sessionId",
            foreignField: "sessionId",
            as: "linkedSession",
          },
        },
        {
          $unwind: "$linkedSession",
        },
        {
          $match: {
            "linkedSession.deviceId": {
              $in: deviceIds,
            },
          },
        },
        {
          $project: {
            _id: 0,
            timestamp: {
              $ifNull: ["$processedAt", "$updatedAt"],
            },
            recordType: { $literal: "refund" },
            status: 1,
            deviceId: "$linkedSession.deviceId",
            sessionId: { $ifNull: ["$sessionId", ""] },
            referenceId: "$refundId",
            channel: { $ifNull: ["$destination", "unknown"] },
            energyKwh: { $literal: "" },
            grossAmount: { $literal: 0 },
            gstAmount: { $literal: "" },
            refundAmount: { $ifNull: ["$refundAmount", 0] },
            ownerPayout: { $literal: "" },
            notes: { $ifNull: ["$refundNote", "Refund record"] },
          },
        },
        { $sort: { timestamp: -1 } },
        { $limit: OWNER_EXPORT_LIMIT + 1 },
      ]),
    ]);

    const totalRows =
      receiptDocs.length + paymentDocs.length + refundDocs.length;

    if (
      receiptDocs.length > OWNER_EXPORT_LIMIT ||
      paymentDocs.length > OWNER_EXPORT_LIMIT ||
      refundDocs.length > OWNER_EXPORT_LIMIT ||
      totalRows > OWNER_EXPORT_LIMIT
    ) {
      return res.status(413).json({
        error:
          "The finance report exceeds 10,000 rows. Narrow the date range or select a device.",
      });
    }

    const rows = [];

    // Receipt rows represent usage/billing snapshots, not proof of collection.
    for (const receipt of receiptDocs) {
      rows.push([
        receipt.createdAt || "",
        "usage_receipt",
        "receipt_snapshot",
        receipt.deviceId || "",
        receipt.sessionId || "",
        receipt.receiptId || "",
        receipt.paymentGateway || "",
        round3(receipt.energyConsumed),
        round2(receipt.totalAmount),
        round2(receipt.gstAmount),
        round2(receipt.refundAmount),
        round2(receipt.ownerPayout),
        "Usage/billing snapshot; not payment settlement proof.",
      ]);
    }

    for (const payment of paymentDocs) {
      rows.push([
        payment.timestamp || "",
        payment.recordType || "payment",
        payment.status || "",
        payment.deviceId || "",
        payment.sessionId || "",
        payment.referenceId || "",
        payment.channel || "",
        payment.energyKwh ?? "",
        round2(payment.grossAmount),
        payment.gstAmount ?? "",
        round2(payment.refundAmount),
        payment.ownerPayout ?? "",
        payment.notes || "Charging payment record",
      ]);
    }

    for (const refund of refundDocs) {
      rows.push([
        refund.timestamp || "",
        refund.recordType || "refund",
        refund.status || "",
        refund.deviceId || "",
        refund.sessionId || "",
        refund.referenceId || "",
        refund.channel || "",
        refund.energyKwh ?? "",
        round2(refund.grossAmount),
        refund.gstAmount ?? "",
        round2(refund.refundAmount),
        refund.ownerPayout ?? "",
        refund.notes || "Refund record",
      ]);
    }

    rows.sort((a, b) => {
      const dateA = new Date(a[0]).getTime() || 0;
      const dateB = new Date(b[0]).getTime() || 0;
      return dateB - dateA;
    });

    return sendOwnerCsv(
      res,
      "viz-owner-finance.csv",
      headers,
      rows
    );
  } catch (error) {
    console.error("Owner finance CSV error:", error);

    return res.status(500).json({
      error: "Could not export owner finance report.",
    });
  }
});


module.exports = router;