const mongoose = require("mongoose");
const crypto = require("crypto");

const ProductionDevice = require("../../models/ProductionDevice");
const ProductionTelemetry = require("../../models/ProductionTelemetry");
const CalibrationSession = require("../../models/CalibrationSession");
const CalibrationProfile = require("../../models/CalibrationProfile");

const {
  calculateHlw8032Calibration,
} = require("../../services/productionV3CalibrationCalculator");

const {
  createRequestId,
  publishConfigCommand,
} = require("../../services/productionV3Mqtt.service");

const {
  refreshBatchCountsForDevice,
} = require("../../services/productionV3Lifecycle.service");

const ACTIVE_SESSION_STATUSES = [
  "in_progress",
  "applying",
  "awaiting_verification",
];

const CALIBRATION_KEYS = [
  "vf",
  "currentZero",
  "currentGain",
  "powerZero",
  "powerGain",
];

const CHANNELS = [
  "voltage",
  "current",
  "power",
];

function normalizeSerial(value) {
  return String(value || "").trim().toUpperCase();
}

function finiteValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sendError(res, error) {
  const status = error.statusCode || 500;

  return res.status(status).json({
    success: false,
    message:
      status === 500
        ? "Calibration operation failed."
        : error.message,
    error:
      process.env.NODE_ENV === "development"
        ? error.message
        : undefined,
  });
}

function isNoLoadCondition(condition) {
  const value = String(condition || "")
    .toLowerCase()
    .replace(/[\s-]/g, "_");

  return /no_?load/.test(value);
}

function calculateStatistics(samples, channels) {
  const result = {};

  for (const channel of channels) {
    const values = samples
      .map((sample) => finiteValue(sample[channel]))
      .filter((value) => value !== null);

    if (!values.length) {
      result[channel] = {
        mean: null,
        min: null,
        max: null,
        standardDeviation: null,
      };
      continue;
    }

    const mean =
      values.reduce((sum, value) => sum + value, 0) /
      values.length;

    const variance =
      values.reduce(
        (sum, value) => sum + Math.pow(value - mean, 2),
        0
      ) / values.length;

    result[channel] = {
      mean,
      min: Math.min(...values),
      max: Math.max(...values),
      standardDeviation: Math.sqrt(variance),
    };
  }

  return result;
}

function getRequiredPointCodes(profileSnapshot) {
  return (profileSnapshot.referencePoints || [])
    .filter((point) => point.required !== false)
    .map((point) => String(point.code));
}

function getCapturedPointCodes(session) {
  return new Set(
    (session.captures || []).map((capture) => capture.pointCode)
  );
}

async function getSession(sessionId) {
  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    const error = new Error("Invalid calibration session ID.");
    error.statusCode = 400;
    throw error;
  }

  const session = await CalibrationSession.findById(sessionId);

  if (!session) {
    const error = new Error("Calibration session not found.");
    error.statusCode = 404;
    throw error;
  }

  return session;
}


// ==================================================
// CREATE CALIBRATION SESSION
// POST /devices/:serialNumber/calibration/sessions
// ==================================================


exports.createSession = async (req, res) => {
  try {
    const serialNumber = normalizeSerial(
      req.params.serialNumber
    );

    const device = await ProductionDevice.findOne({
      serialNumber,
    })
      .populate("calibrationProfileId")
      .populate("productionProfileId")
      .populate("batchId");

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    if (!device.deviceId) {
      return res.status(409).json({
        success: false,
        message: "Device has not been provisioned.",
      });
    }

    if (
      ![
        "calibration_required",
        "calibrating",
        "calibration_failed",
      ].includes(device.manufacturingStatus)
    ) {
      return res.status(409).json({
        success: false,
        message: "Device is not eligible for calibration.",
        currentStatus: device.manufacturingStatus,
      });
    }

    // Check whether the operator selected a profile
    // in the New Calibration Session form.
    const requestedProfileId = String(
      req.body.calibrationProfileId || ""
    ).trim();

    let profile = device.calibrationProfileId;

    if (requestedProfileId) {
      if (
        !mongoose.Types.ObjectId.isValid(
          requestedProfileId
        )
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid calibrationProfileId.",
        });
      }

      profile = await CalibrationProfile.findById(
        requestedProfileId
      );

      if (!profile) {
        return res.status(404).json({
          success: false,
          message: "Selected Calibration Profile does not exist.",
        });
      }
    }

    // More useful error when a device has no profile.
    if (!profile) {
      return res.status(409).json({
        success: false,
        message:
          "No Calibration Profile is assigned. Select an active Calibration Profile when creating the session.",
      });
    }

    // A Draft profile cannot be used for calibration.
    if (profile.status !== "active") {
      return res.status(409).json({
        success: false,
        message:
          `Calibration Profile ${profile.profileCode} is not active. Current status: ${profile.status}.`,
      });
    }

    const assignedMeteringHardware = String(
      device.productionProfileId?.meteringHardware ||
      device.batchId?.meteringHardware ||
      ""
    ).trim().toUpperCase();

    const calibrationMeteringHardware = String(
      profile.meteringHardware || ""
    ).trim().toUpperCase();

    if (
      assignedMeteringHardware &&
      assignedMeteringHardware !==
        calibrationMeteringHardware
    ) {
      return res.status(409).json({
        success: false,
        message:
          `Calibration Profile metering hardware (${calibrationMeteringHardware}) does not match device hardware (${assignedMeteringHardware}).`,
      });
    }

    const hardwareRevision = String(
      device.batchId?.hardwareRevision ||
      device.productionProfileId?.hardwareRevision ||
      ""
    ).trim().toLowerCase();

    const supportedRevisions = (
      profile.supportedHardwareRevisions || []
    ).map((value) => String(value).trim().toLowerCase());

    if (
      hardwareRevision &&
      supportedRevisions.length > 0 &&
      !supportedRevisions.includes(hardwareRevision)
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Calibration Profile does not support this hardware revision.",
      });
    }

    const existingSession = await CalibrationSession.findOne({
      serialNumber,
      status: {
        $in: ACTIVE_SESSION_STATUSES,
      },
    });

    if (existingSession) {
      return res.status(409).json({
        success: false,
        message: "An active calibration session already exists.",
        sessionId: existingSession._id,
        sessionNumber: existingSession.sessionNumber,
      });
    }

    // Assign the selected profile to the device.
    // This also repairs devices generated by older batches
    // that were created without a Calibration Profile.
    device.calibrationProfileId = profile._id;

    const sessionNumber =
      `CAL-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    const session = await CalibrationSession.create({
      sessionNumber,
      device: device._id,
      serialNumber,
      deviceId: device.deviceId,
      batchId: device.batchId?._id || device.batchId || null,
      calibrationProfileId: profile._id,

      // Retain the exact profile revision used.
      profileSnapshot: profile.toObject(),

      status: "in_progress",

      stationName: String(
        req.body.stationName || ""
      ).trim(),

      operatorId: req.user?.userId || null,

      operatorName: String(
        req.body.operatorName || ""
      ).trim(),

      notes: String(
        req.body.notes || ""
      ).trim(),

      createdBy: req.user?.userId || null,
      updatedBy: req.user?.userId || null,
    });

    device.manufacturingStatus = "calibrating";
    device.calibration.status = "calibrating";
    device.calibration.latestSessionId = session._id;
    device.updatedBy = req.user?.userId || null;

    await device.save();
    await refreshBatchCountsForDevice(serialNumber);

    return res.status(201).json({
      success: true,
      message:
        "Calibration session created and profile assigned successfully.",
      data: session,
    });

  } catch (error) {
    console.error(
      "[Production V3] createSession:",
      error
    );

    return sendError(res, error);
  }
};



// ==================================================
// LIST CALIBRATION SESSIONS
// GET /calibration/sessions
// ==================================================

exports.getSessions = async (req, res) => {
  try {
    const page = Math.max(
      1,
      Number.parseInt(req.query.page, 10) || 1
    );

    const limit = Math.min(
      100,
      Math.max(
        1,
        Number.parseInt(req.query.limit, 10) || 25
      )
    );

    const filter = {};

    if (req.query.serialNumber) {
      filter.serialNumber = normalizeSerial(req.query.serialNumber);
    }

    if (req.query.status) {
      filter.status = String(req.query.status);
    }

    if (req.query.batchId) {
      if (!mongoose.Types.ObjectId.isValid(req.query.batchId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid batchId.",
        });
      }

      filter.batchId = req.query.batchId;
    }

    const [sessions, total] = await Promise.all([
      CalibrationSession.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      CalibrationSession.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: sessions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("[Production V3] getSessions:", error);
    return sendError(res, error);
  }
};


// ==================================================
// GET ONE CALIBRATION SESSION
// GET /calibration/sessions/:sessionId
// ==================================================

exports.getSessionById = async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);

    return res.json({
      success: true,
      data: session,
    });
  } catch (error) {
    return sendError(res, error);
  }
};


// ==================================================
// CAPTURE CALIBRATION POINT
// POST /calibration/sessions/:sessionId/captures
//
// Body:
// {
//   "pointCode": "NO_LOAD",
//   "telemetryRequestId": "admin-...",
//   "reference": {
//     "voltage": 230.1,
//     "current": 0,
//     "power": 0
//   }
// }
// ==================================================

exports.capturePoint = async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);

    if (session.status !== "in_progress") {
      return res.status(409).json({
        success: false,
        message: "Session is not accepting captures.",
        currentStatus: session.status,
      });
    }

    const pointCode = String(req.body.pointCode || "").trim();
    const telemetryRequestId =
      String(req.body.telemetryRequestId || "").trim();

    if (!pointCode || !telemetryRequestId) {
      return res.status(400).json({
        success: false,
        message: "pointCode and telemetryRequestId are required.",
      });
    }

    const profile = session.profileSnapshot || {};

    const referencePoint = (profile.referencePoints || [])
      .find((point) => String(point.code) === pointCode);

    if (!referencePoint) {
      return res.status(400).json({
        success: false,
        message: "pointCode does not exist in this Calibration Profile.",
      });
    }

    const condition = String(referencePoint.condition || "");
    const noLoad = isNoLoadCondition(condition);

    const samplingSettings = noLoad
      ? profile.noLoadSampling || {}
      : profile.loadSampling || {};

    const sampleCount = Math.min(
      100,
      Math.max(1, Number(samplingSettings.sampleCount) || 10)
    );

    const requiredChannels =
      referencePoint.requiredChannels?.length
        ? referencePoint.requiredChannels
        : CHANNELS;

    const reference = {};

    for (const channel of requiredChannels) {
      const value = finiteValue(req.body.reference?.[channel]);

      if (value === null || value < 0) {
        return res.status(400).json({
          success: false,
          message: `reference.${channel} must be a valid non-negative number.`,
        });
      }

      reference[channel] = value;
    }

    const telemetryFilter = {
      serialNumber: session.serialNumber,
      telemetryRequestId,
      telemetryMode: "fast",
      sampleFresh: true,
      sampleAgeMs: { $gte: 0, $lte: 2000 },
      sessionActive: false,
      capturedAt: {
        $gte: new Date(Date.now() - 120000),
      },
      adminRelayTest: noLoad ? false : true,
    };

    const samples = await ProductionTelemetry.find(telemetryFilter)
      .sort({ capturedAt: -1 })
      .limit(sampleCount)
      .lean();

    if (samples.length < sampleCount) {
      return res.status(409).json({
        success: false,
        message: "Not enough fresh telemetry samples for this capture.",
        data: {
          requiredSamples: sampleCount,
          availableSamples: samples.length,
          telemetryRequestId,
          expectedRelayTest: !noLoad,
        },
      });
    }

    const chronologicalSamples = samples.reverse();

    for (const channel of requiredChannels) {
      const invalid = chronologicalSamples.some(
        (sample) => finiteValue(sample[channel]) === null
      );

      if (invalid) {
        return res.status(409).json({
          success: false,
          message: `Telemetry is missing a valid ${channel} measurement.`,
        });
      }
    }

    const measurement = calculateStatistics(
      chronologicalSamples,
      CHANNELS
    );

    const capture = {
      pointCode,
      condition,
      telemetryRequestId,
      requiredChannels,
      reference,
      measurement,

      sampleCount: chronologicalSamples.length,

      sampleIds: chronologicalSamples.map(
        (sample) => sample._id
      ),

      firstSampleAt: chronologicalSamples[0].capturedAt,
      lastSampleAt:
        chronologicalSamples[chronologicalSamples.length - 1].capturedAt,

      capturedAt: new Date(),
      capturedBy: req.user?.userId || null,

      note: String(req.body.note || "").trim(),
    };

    session.captures.push(capture);

    // A new or replacement reference capture invalidates any previous fit.
    session.calculatedConstants = null;
    session.calculation = null;

    session.updatedBy = req.user?.userId || null;

    await session.save();

    return res.status(201).json({
      success: true,
      message: "Calibration reference point captured.",
      data: {
        sessionId: session._id,
        capture,
        totalCaptures: session.captures.length,
      },
    });
  } catch (error) {
    console.error("[Production V3] capturePoint:", error);
    return sendError(res, error);
  }
};


// ==================================================
// CALCULATE CALIBRATION CONSTANTS
// POST /calibration/sessions/:sessionId/calculate
//
// Fits the V3 firmware equations against the captured raw HLW8032
// ratios and the reference-meter values. This only saves a proposal;
// it does not send a command to the ESP32.
// ==================================================

exports.calculateCalibration = async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);

    if (session.status !== "in_progress") {
      return res.status(409).json({
        success: false,
        message: "Calibration constants can only be calculated while the session is in progress.",
        currentStatus: session.status,
      });
    }

    const device = await ProductionDevice.findOne({
      serialNumber: session.serialNumber,
    })
      .populate("productionProfileId", "meteringHardware")
      .populate("batchId", "meteringHardware");

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found for this calibration session.",
      });
    }

    const meteringHardware = String(
      device.productionProfileId?.meteringHardware ||
      device.batchId?.meteringHardware ||
      session.profileSnapshot?.meteringHardware ||
      ""
    ).trim();

    const result = await calculateHlw8032Calibration({
      session,
      ProductionTelemetry,
      meteringHardware,
    });

    session.calculatedConstants = result.constants;
    session.calculation = result.calculation;
    session.lastError = null;
    session.updatedBy = req.user?.userId || null;

    await session.save();

    return res.json({
      success: true,
      message: "Calibration constants calculated and saved. Review them before applying to the device.",
      data: {
        sessionId: session._id,
        calculatedConstants: result.constants,
        calculation: result.calculation,
      },
    });
  } catch (error) {
    console.error("[Production V3] calculateCalibration:", error);
    return sendError(res, error);
  }
};


// ==================================================
// APPLY CALIBRATION
// POST /calibration/sessions/:sessionId/apply
//
// Coefficients are read from the server-persisted session.calculatedConstants.
// The request body is intentionally ignored; the browser cannot override them.
// ==================================================

exports.applyCalibration = async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);

    if (session.status !== "in_progress") {
      return res.status(409).json({
        success: false,
        message: "Session must be in progress before applying calibration.",
      });
    }

    const requiredPointCodes =
      getRequiredPointCodes(session.profileSnapshot);

    const capturedPointCodes =
      getCapturedPointCodes(session);

    const missingPoints = requiredPointCodes.filter(
      (code) => !capturedPointCodes.has(code)
    );

    if (missingPoints.length) {
      return res.status(409).json({
        success: false,
        message: "Required reference points have not been captured.",
        missingPoints,
      });
    }

    const device = await ProductionDevice.findOne({
      serialNumber: session.serialNumber,
    });

    if (!device || !device.deviceId) {
      return res.status(404).json({
        success: false,
        message: "Provisioned device not found.",
      });
    }

    // Do not apply calibration while the latest known fast sample
    // indicates an active charging session or maintenance relay test.
    const latestSample = await ProductionTelemetry.findOne({
      serialNumber: session.serialNumber,
    })
      .sort({ capturedAt: -1 })
      .lean();

    if (
      latestSample &&
      Date.now() - new Date(latestSample.capturedAt).getTime() < 10000 &&
      (latestSample.sessionActive || latestSample.adminRelayTest)
    ) {
      return res.status(409).json({
        success: false,
        message: "Stop charging and relay testing before applying calibration.",
      });
    }

    if (!session.calculatedConstants || !session.calculation?.calculatedAt) {
      return res.status(409).json({
        success: false,
        message: "Calculate and review calibration constants before applying them.",
      });
    }

    const profileValues = new Map(
      (session.profileSnapshot.calibrationValues || []).map(
        (item) => [item.firmwareKey, item]
      )
    );

    const constants = {};

    // Use the server-persisted calculation result. Do not accept arbitrary
    // calibration coefficients from the browser.
    for (const key of CALIBRATION_KEYS) {
      const definition = profileValues.get(key);

      if (!definition) {
        return res.status(409).json({
          success: false,
          message: `Calibration Profile is missing ${key}.`,
        });
      }

      const value = finiteValue(session.calculatedConstants[key]);

      if (value === null) {
        return res.status(409).json({
          success: false,
          message: `Calculated value for ${key} is missing. Recalculate constants.`,
        });
      }

      if (
        definition.minimumValue !== null &&
        definition.minimumValue !== undefined &&
        value < definition.minimumValue
      ) {
        return res.status(400).json({
          success: false,
          message: `Calculated ${key} is below the allowed profile minimum.`,
        });
      }

      if (
        definition.maximumValue !== null &&
        definition.maximumValue !== undefined &&
        value > definition.maximumValue
      ) {
        return res.status(400).json({
          success: false,
          message: `Calculated ${key} exceeds the allowed profile maximum.`,
        });
      }

      constants[key] = value;
    }

    const requestId = createRequestId("calibration");

    const payload = {
      action: "setCalibration",
      serialNumber: session.serialNumber,
      requestId,
      ...constants,
    };

    session.status = "applying";
    session.applyRequestId = requestId;
    session.appliedConstants = constants;
    session.lastError = null;
    session.updatedBy = req.user?.userId || null;

    // Save the request ID before publishing because the device
    // may acknowledge very quickly.
    await session.save();

    try {
      const command = await publishConfigCommand({
        device,
        payload,
        action: "setCalibration",
        kind: "calibration",
        metadata: {
          operation: "calibration_session_apply",
          calibrationSessionId: String(session._id),
          calibrationProfileId: String(session.calibrationProfileId),
          expectedNvsVersion: Number(
            device.provisioning?.appliedConfigVersion || 0
          ),
          constants,
        },
        createdBy: req.user?.userId,
      });
      await CalibrationSession.updateOne(
        {
          _id: session._id,
          status: "applying",
          applyRequestId: requestId,
        },
        {
          $set: {
            applyCommandId: command._id,
          },
        }
      );

      device.manufacturingStatus = "calibrating";
      device.calibration.status = "calibrating";
      device.calibration.latestSessionId = session._id;
      device.updatedBy = req.user?.userId || null;

      await device.save();
      await refreshBatchCountsForDevice(session.serialNumber);

      return res.status(202).json({
        success: true,
        message: "Calibration constants sent. Waiting for device acknowledgement.",
        data: {
          sessionId: session._id,
          requestId,
          commandStatus: command.status,
          constants,
        },
      });
    } catch (publishError) {
  await CalibrationSession.updateOne(
    {
      _id: session._id,
      status: "applying",
      applyRequestId: requestId,
    },
    {
      $set: {
        status: "in_progress",
        applyRequestId: null,
        applyCommandId: null,
        lastError: publishError.message,
        updatedBy: req.user?.userId || null,
      },
    }
  );

  throw publishError;
}
  } catch (error) {
    console.error("[Production V3] applyCalibration:", error);
    return sendError(res, error);
  }
};

exports.captureVerificationPoint = async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);

    if (session.status !== "awaiting_verification") {
      return res.status(409).json({
        success: false,
        message: "Session is not awaiting verification.",
      });
    }

    if (!session.appliedAt) {
      return res.status(409).json({
        success: false,
        message: "Calibration application timestamp is missing.",
      });
    }

    const pointCode = String(
      req.body.pointCode || ""
    ).trim();

    const telemetryRequestId = String(
      req.body.telemetryRequestId || ""
    ).trim();

    if (!pointCode || !telemetryRequestId) {
      return res.status(400).json({
        success: false,
        message: "Point code and telemetry request ID are required.",
      });
    }

    const profile = session.profileSnapshot || {};

    const point = (profile.referencePoints || []).find(
      (item) => String(item.code) === pointCode
    );

    if (!point) {
      return res.status(400).json({
        success: false,
        message: "Invalid verification point.",
      });
    }

    // Use the original calibrated reference.
    // Never accept a new reference value from the browser.
    const originalCapture = [
      ...(session.captures || []),
    ].reverse().find(
      (capture) => capture.pointCode === pointCode
    );

    if (!originalCapture) {
      return res.status(409).json({
        success: false,
        message: "Original reference capture is missing.",
      });
    }

    const condition = String(
      originalCapture.condition || point.condition || ""
    );

    const noLoad = isNoLoadCondition(condition);

    const samplingSettings = noLoad
      ? profile.noLoadSampling || {}
      : profile.loadSampling || {};

    const sampleCount = Math.min(
      100,
      Math.max(1, Number(samplingSettings.sampleCount) || 10)
    );

    const requiredChannels =
      originalCapture.requiredChannels?.length
        ? originalCapture.requiredChannels
        : CHANNELS;

    const samples = await ProductionTelemetry.find({
      serialNumber: session.serialNumber,
      telemetryRequestId,
      telemetryMode: "fast",
      sampleFresh: true,
      sampleAgeMs: { $gte: 0, $lte: 2000 },
      sessionActive: false,
      adminRelayTest: noLoad ? false : true,
      capturedAt: {
        $gte: new Date(session.appliedAt),
        $lte: new Date(),
      },
    })
      .sort({ capturedAt: -1 })
      .limit(sampleCount)
      .lean();

    if (samples.length < sampleCount) {
      return res.status(409).json({
        success: false,
        message: "Not enough fresh post-calibration samples.",
        data: {
          requiredSamples: sampleCount,
          availableSamples: samples.length,
        },
      });
    }

    const chronologicalSamples = samples.reverse();

    for (const channel of requiredChannels) {
      if (
        chronologicalSamples.some(
          (sample) => finiteValue(sample[channel]) === null
        )
      ) {
        return res.status(409).json({
          success: false,
          message: `Missing valid ${channel} telemetry.`,
        });
      }
    }

    const capture = {
      pointCode,
      condition,
      telemetryRequestId,
      requiredChannels,

      // Reference values are copied from the original capture.
      reference: originalCapture.reference,

      measurement: calculateStatistics(
        chronologicalSamples,
        CHANNELS
      ),

      sampleCount: chronologicalSamples.length,
      sampleIds: chronologicalSamples.map(
        (sample) => sample._id
      ),

      firstSampleAt: chronologicalSamples[0].capturedAt,
      lastSampleAt:
        chronologicalSamples[chronologicalSamples.length - 1].capturedAt,

      capturedAt: new Date(),
      capturedBy: req.user?.userId || null,
    };

    session.verificationCaptures.push(capture);
    session.updatedBy = req.user?.userId || null;

    await session.save();

    return res.status(201).json({
      success: true,
      message: "Post-calibration verification point captured.",
      data: {
        sessionId: session._id,
        capture,
      },
    });

  } catch (error) {
    console.error(
      "[Production V3] captureVerificationPoint:",
      error
    );

    return sendError(res, error);
  }
};

// ==================================================
// VERIFY CALIBRATION
// POST /calibration/sessions/:sessionId/verify
// ==================================================

exports.verifyCalibration = async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);

    if (session.status !== "awaiting_verification") {
      return res.status(409).json({
        success: false,
        message: "Device must acknowledge calibration before verification.",
        currentStatus: session.status,
      });
    }

    const profile = session.profileSnapshot || {};
    const criteria = profile.acceptanceCriteria || {};
    const referencePoints = profile.referencePoints || [];

    const requiredPointCodes = getRequiredPointCodes(profile);
    const capturedPointCodes = getCapturedPointCodes(session);

    const missingPoints = requiredPointCodes.filter(
      (code) => !capturedPointCodes.has(code)
    );

    if (missingPoints.length) {
      return res.status(409).json({
        success: false,
        message: "Some required calibration points are missing.",
        missingPoints,
      });
    }

    const toleranceMap = {
      voltage: criteria.voltageTolerancePercent,
      current: criteria.currentTolerancePercent,
      power: criteria.powerTolerancePercent,
    };

    const enabledMap = {
      voltage: criteria.requireVoltageVerification !== false,
      current: criteria.requireCurrentVerification !== false,
      power: criteria.requirePowerVerification !== false,
    };
const verificationByCode = new Map();

for (const capture of session.verificationCaptures || []) {
  verificationByCode.set(capture.pointCode, capture);
}

const missingVerificationPoints = requiredPointCodes.filter(
  (code) => !verificationByCode.has(code)
);

if (missingVerificationPoints.length) {
  return res.status(409).json({
    success: false,
    message: "Fresh post-calibration verification is incomplete.",
    missingPoints: missingVerificationPoints,
  });
}

const originalCaptures = new Map();

for (const capture of session.captures || []) {
  originalCaptures.set(capture.pointCode, capture);
}

const results = [];
const skippedZeroReference = [];

for (const pointCode of requiredPointCodes) {

  const capture = verificationByCode.get(pointCode);
  const original = originalCaptures.get(pointCode);

  if (!capture || !original) {
    return res.status(409).json({
      success: false,
      message: `Missing original or verification capture: ${pointCode}`,
    });
  }

  for (const channel of capture.requiredChannels || CHANNELS) {

    if (!enabledMap[channel]) continue;

    const reference = finiteValue(
      original.reference?.[channel]
    );

    const measured = finiteValue(
      capture.measurement?.[channel]?.mean
    );

    if (reference === null || measured === null) {
      return res.status(409).json({
        success: false,
        message: `Missing verification measurement for ${pointCode}/${channel}.`,
      });
    }

    if (reference === 0) {
      skippedZeroReference.push({
        pointCode,
        channel,
        reference,
        measured,
      });

      continue;
    }

    const configuredTolerance = toleranceMap[channel];
    const tolerance =
      configuredTolerance === null ||
      configuredTolerance === undefined ||
      configuredTolerance === ""
        ? NaN
        : Number(configuredTolerance);

    if (!Number.isFinite(tolerance) || tolerance < 0) {
      return res.status(409).json({
        success: false,
        message: `Missing or invalid ${channel} verification tolerance. Configure the tolerance in the Calibration Profile before completing verification.`,
      });
    }

    const errorPercent =
      Math.abs(measured - reference) /
      Math.abs(reference) * 100;

    results.push({
      pointCode,
      channel,
      reference,
      measured,
      errorPercent,
      allowedErrorPercent: tolerance,
      passed: errorPercent <= tolerance,
    });
  }
}

if (!results.length) {
  return res.status(409).json({
    success: false,
    message: "No positive reference values available for verification.",
    skippedZeroReference,
  });
}
    const passed = results.every((item) => item.passed);

    const now = new Date();

    session.status = passed ? "passed" : "failed";
    session.completedAt = now;
    session.verification = {
      passed,
      results,
      skippedZeroReference,
      verifiedAt: now,
      verifiedBy: req.user?.userId || null,
    };

    session.updatedBy = req.user?.userId || null;
    await session.save();

    const device = await ProductionDevice.findOne({
      serialNumber: session.serialNumber,
    });

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Device not found while updating calibration result.",
      });
    }

    if (passed) {
      device.manufacturingStatus = "production_ready";
      device.calibration.status = "passed";
      device.calibration.lastPassedAt = now;
      device.calibration.lastFailureReason = null;
    } else {
      device.manufacturingStatus = "calibration_failed";
      device.calibration.status = "failed";
      device.calibration.lastFailedAt = now;
      device.calibration.lastFailureReason =
        "One or more calibration verification tolerances were exceeded.";
    }

    device.updatedBy = req.user?.userId || null;
    await device.save();

    await refreshBatchCountsForDevice(session.serialNumber);

    return res.json({
      success: true,
      message: passed
        ? "Calibration passed. Device marked Production Ready."
        : "Calibration failed. Device requires rework.",
      data: {
        sessionId: session._id,
        sessionStatus: session.status,
        manufacturingStatus: device.manufacturingStatus,
        calibrationStatus: device.calibration.status,
        results,
        skippedZeroReference,
      },
    });
  } catch (error) {
    console.error("[Production V3] verifyCalibration:", error);
    return sendError(res, error);
  }
};


// ==================================================
// CANCEL CALIBRATION SESSION
// POST /calibration/sessions/:sessionId/cancel
// ==================================================

exports.cancelSession = async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);

    if (
      ["passed", "failed", "cancelled"].includes(session.status)
    ) {
      return res.status(409).json({
        success: false,
        message: "This calibration session is already finished.",
      });
    }

    session.status = "cancelled";
    session.cancelledAt = new Date();
    session.lastError = String(req.body.reason || "").trim();
    session.updatedBy = req.user?.userId || null;

    await session.save();

    const device = await ProductionDevice.findOne({
      serialNumber: session.serialNumber,
    });

    if (
      device &&
      device.calibration.latestSessionId?.toString() ===
        session._id.toString()
    ) {
      device.manufacturingStatus = "calibration_required";
      device.calibration.status = "calibration_required";
      device.updatedBy = req.user?.userId || null;

      await device.save();
      await refreshBatchCountsForDevice(session.serialNumber);
    }

    return res.json({
      success: true,
      message: "Calibration session cancelled.",
      data: session,
    });
  } catch (error) {
    console.error("[Production V3] cancelSession:", error);
    return sendError(res, error);
  }
};