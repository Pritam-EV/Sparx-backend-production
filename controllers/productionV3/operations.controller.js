const mongoose = require("mongoose");

const ProductionDevice = require("../../models/ProductionDevice");
const ProductionProfile = require("../../models/ProductionProfile");
const FirmwareProfile = require("../../models/FirmwareProfile");
const CalibrationProfile = require("../../models/CalibrationProfile");
const ProductionCommand = require("../../models/ProductionCommand");
const ProductionTelemetry = require("../../models/ProductionTelemetry");

const {
  encryptSecret,
  decryptSecret,
} = require("../../services/productionV3Secrets");

const {
  createRequestId,
  publishAdminCommand,
  publishConfigCommand,
} = require("../../services/productionV3Mqtt.service");

const ACTIVE_COMMAND_STATUSES = ["queued", "published"];

function normalizeSerial(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeDeviceId(value) {
  return String(value || "").trim().toUpperCase();
}

function finiteNumber(value, field, minimum = 0) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < minimum) {
    const error = new Error(
      `${field} must be a finite number greater than or equal to ${minimum}.`
    );
    error.statusCode = 400;
    throw error;
  }

  return number;
}

function sendError(res, error) {
  const status = error.statusCode || 500;

  return res.status(status).json({
    success: false,
    message:
      status === 500
        ? "Production 3.0 operation failed."
        : error.message,
    error:
      process.env.NODE_ENV === "development"
        ? error.message
        : undefined,
  });
}

async function findDevice(serialNumber, options = {}) {
  const query = ProductionDevice.findOne({
    serialNumber: normalizeSerial(serialNumber),
  });

  if (options.secrets) {
    query.select("+wifiCredentials +identityHistory");
  }

  if (options.profiles) {
    query
      .populate("batchId")
      .populate("productionProfileId")
      .populate("firmwareProfileId")
      .populate("calibrationProfileId");
  }

  return query;
}

function validateWifiCredentials(ssid, password) {
  if (
    typeof ssid !== "string" ||
    !ssid.trim() ||
    ssid.trim().length > 32
  ) {
    const error = new Error(
      "wifiSSID is required and must be 1–32 characters."
    );
    error.statusCode = 400;
    throw error;
  }

  if (
    typeof password !== "string" ||
    (password.length > 0 && (password.length < 8 || password.length > 63))
  ) {
    const error = new Error(
      "wifiPassword must be empty for an open network or 8–63 characters."
    );
    error.statusCode = 400;
    throw error;
  }
}

async function validateFirmwareCompatibility(device, firmwareProfile) {
  if (!firmwareProfile || firmwareProfile.status !== "active") {
    const error = new Error(
      "An active Firmware Profile is required."
    );
    error.statusCode = 400;
    throw error;
  }

  const hardwareRevision =
    device.batchId?.hardwareRevision ||
    device.productionProfileId?.hardwareRevision ||
    "";

  const meteringHardware =
    device.productionProfileId?.meteringHardware || "";

  if (
    firmwareProfile.supportedHardwareRevisions?.length &&
    !firmwareProfile.supportedHardwareRevisions.includes(hardwareRevision)
  ) {
    const error = new Error(
      `Firmware Profile does not support hardware revision ${hardwareRevision}.`
    );
    error.statusCode = 409;
    throw error;
  }

  if (
    firmwareProfile.supportedMeteringHardware?.length &&
    !firmwareProfile.supportedMeteringHardware.includes(meteringHardware)
  ) {
    const error = new Error(
      `Firmware Profile does not support metering hardware ${meteringHardware}.`
    );
    error.statusCode = 409;
    throw error;
  }
}

function buildSetConfigPayload({
  serialNumber,
  deviceId,
  ssid,
  password,
  nvsVersion,
  currentRF,
  requestId,
}) {
  const payload = {
    action: "setConfig",
    schemaVersion: 1,
    serialNumber,
    deviceId,
    ssid,
    password,
    nvsVersion,
    requestId,
  };

  // Firmware accepts currentRF optionally.
  // Do not invent or send new calibration values through legacy CF/VF.
  if (Number.isFinite(Number(currentRF))) {
    payload.currentRF = Number(currentRF);
  }

  return payload;
}


// ==================================================
// GROUP A -> GROUP B PROMOTION
// POST /devices/:serialNumber/promote
// ==================================================

exports.promoteDevice = async (req, res) => {
  try {
    const serialNumber = normalizeSerial(req.params.serialNumber);

    const device = await findDevice(serialNumber, {
      secrets: true,
      profiles: true,
    });

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    if (!["group_a", "discovered"].includes(device.manufacturingStatus)) {
      return res.status(409).json({
        success: false,
        message: "Only Group A or discovered devices can be promoted.",
        currentStatus: device.manufacturingStatus,
      });
    }

    // Device must have been seen on the serial-based discovery topic.
    const lastSeen = device.discovery?.lastSeenAt
      ? new Date(device.discovery.lastSeenAt).getTime()
      : 0;

    if (!lastSeen || Date.now() - lastSeen > 120000) {
      return res.status(409).json({
        success: false,
        message: "Device has not sent a recent discovery message.",
      });
    }

    const wifiSSID = req.body.wifiSSID;
    const wifiPassword = req.body.wifiPassword;

    validateWifiCredentials(wifiSSID, wifiPassword);

    let firmwareProfile = device.firmwareProfileId;

    if (req.body.firmwareProfileId) {
      if (!mongoose.Types.ObjectId.isValid(req.body.firmwareProfileId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid firmwareProfileId.",
        });
      }

      firmwareProfile = await FirmwareProfile.findById(
        req.body.firmwareProfileId
      );

      if (!firmwareProfile) {
        return res.status(404).json({
          success: false,
          message: "Firmware Profile not found.",
        });
      }

      device.firmwareProfileId = firmwareProfile._id;
    }

    await validateFirmwareCompatibility(device, firmwareProfile);

    if (
      device.productionProfileId &&
      device.productionProfileId.isActive === false
    ) {
      return res.status(409).json({
        success: false,
        message: "Assigned Production Profile is inactive.",
      });
    }

    const deviceId = normalizeDeviceId(
      req.body.deviceId || serialNumber
    );

    if (!deviceId || deviceId.length > 64) {
      return res.status(400).json({
        success: false,
        message: "Invalid deviceId.",
      });
    }

    const existingIdentity = await ProductionDevice.findOne({
      deviceId,
      _id: { $ne: device._id },
    }).select("_id serialNumber");

    if (existingIdentity) {
      return res.status(409).json({
        success: false,
        message: "deviceId is already assigned to another Production 3.0 device.",
        assignedSerialNumber: existingIdentity.serialNumber,
      });
    }

    const nvsVersion =
      Math.max(
        Number(device.provisioning.desiredConfigVersion || 0),
        Number(device.provisioning.appliedConfigVersion || 0)
      ) + 1;

    const requestId = createRequestId("promote");

    const payload = buildSetConfigPayload({
      serialNumber,
      deviceId,
      ssid: wifiSSID.trim(),
      password: wifiPassword,
      nvsVersion,
      currentRF: firmwareProfile.defaults?.currentRF,
      requestId,
    });

    // Encrypt credentials before storing them.
    device.wifiCredentials = {
      encryptedSsid: encryptSecret(wifiSSID.trim()),
      encryptedPassword: encryptSecret(wifiPassword),
      secretReference: null,
      updatedAt: new Date(),
    };

    device.deviceId = deviceId;
    device.manufacturingStatus = "group_b";

    device.firmwareFamily = firmwareProfile.firmwareFamily;
    device.protocolVersion = firmwareProfile.protocolVersion;

    device.provisioning.status = "pending";
    device.provisioning.desiredConfigVersion = nvsVersion;
    device.provisioning.lastRequestId = requestId;
    device.provisioning.lastSentAt = null;
    device.provisioning.lastError = null;
    device.provisioning.targetFirmwareVersion =
      firmwareProfile.targetFirmwareVersion;

    device.updatedBy = req.user?.userId || null;

    await device.save();

    try {
      const command = await publishConfigCommand({
        device,
        payload,
        action: "setConfig",
        kind: "provisioning",
        metadata: {
          operation: "promotion",
          nvsVersion,
        },
        createdBy: req.user?.userId,
      });

      device.provisioning.status = "sent";
      device.provisioning.lastSentAt = new Date();
      await device.save();

      return res.status(202).json({
        success: true,
        message: "Device promoted to Group B. Awaiting firmware acknowledgement.",
        data: {
          serialNumber,
          deviceId,
          manufacturingStatus: device.manufacturingStatus,
          provisioningStatus: device.provisioning.status,
          requestId,
          nvsVersion,
          commandStatus: command.status,
        },
      });
    } catch (publishError) {
      device.provisioning.status = "failed";
      device.provisioning.lastError = publishError.message;
      await device.save();
      throw publishError;
    }
  } catch (error) {
    console.error("[Production V3] promoteDevice:", error);
    return sendError(res, error);
  }
};


// ==================================================
// RETRY PROVISIONING
// POST /devices/:serialNumber/provision/retry
// ==================================================

exports.retryProvisioning = async (req, res) => {
  try {
    const serialNumber = normalizeSerial(req.params.serialNumber);

    const device = await findDevice(serialNumber, {
      secrets: true,
      profiles: true,
    });

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    if (
      !["group_b", "calibration_required"].includes(
        device.manufacturingStatus
      )
    ) {
      return res.status(409).json({
        success: false,
        message: "Provisioning retry is not allowed in the current lifecycle state.",
        currentStatus: device.manufacturingStatus,
      });
    }

    if (!device.deviceId) {
      return res.status(409).json({
        success: false,
        message: "Device ID has not been assigned.",
      });
    }

    const ssid = decryptSecret(
      device.wifiCredentials?.encryptedSsid
    );

    const password = decryptSecret(
      device.wifiCredentials?.encryptedPassword
    );

    validateWifiCredentials(ssid, password);

    const firmwareProfile = device.firmwareProfileId;

    await validateFirmwareCompatibility(device, firmwareProfile);

    const nvsVersion =
      Math.max(
        Number(device.provisioning.desiredConfigVersion || 0),
        Number(device.provisioning.appliedConfigVersion || 0)
      ) + 1;

    const requestId = createRequestId("retry");

    const payload = buildSetConfigPayload({
      serialNumber,
      deviceId: device.deviceId,
      ssid,
      password,
      nvsVersion,
      currentRF: firmwareProfile.defaults?.currentRF,
      requestId,
    });

    device.provisioning.status = "pending";
    device.provisioning.desiredConfigVersion = nvsVersion;
    device.provisioning.lastRequestId = requestId;
    device.provisioning.lastError = null;
    device.updatedBy = req.user?.userId || null;

    await device.save();

    const command = await publishConfigCommand({
      device,
      payload,
      action: "setConfig",
      kind: "provisioning",
      metadata: {
        operation: "retry",
        nvsVersion,
      },
      createdBy: req.user?.userId,
    });

    device.provisioning.status = "sent";
    device.provisioning.lastSentAt = new Date();
    await device.save();

    return res.status(202).json({
      success: true,
      message: "Provisioning retry published.",
      data: {
        serialNumber,
        deviceId: device.deviceId,
        requestId,
        nvsVersion,
        commandStatus: command.status,
      },
    });
  } catch (error) {
    console.error("[Production V3] retryProvisioning:", error);
    return sendError(res, error);
  }
};


// ==================================================
// DEVICE IDENTITY CHANGE
// POST /devices/:serialNumber/identity-change
// ==================================================

exports.changeDeviceIdentity = async (req, res) => {
  try {
    const serialNumber = normalizeSerial(req.params.serialNumber);

    const device = await findDevice(serialNumber, {
      secrets: true,
      profiles: true,
    });

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    if (
      !["group_b", "calibration_required"].includes(
        device.manufacturingStatus
      )
    ) {
      return res.status(409).json({
        success: false,
        message: "Identity change is not allowed in the current lifecycle state.",
      });
    }

    const oldDeviceId = normalizeDeviceId(device.deviceId);
    const newDeviceId = normalizeDeviceId(req.body.newDeviceId);

    if (!newDeviceId || newDeviceId.length > 64) {
      return res.status(400).json({
        success: false,
        message: "newDeviceId is required and must be 64 characters or fewer.",
      });
    }

    if (newDeviceId === oldDeviceId) {
      return res.status(400).json({
        success: false,
        message: "newDeviceId is the same as the current deviceId.",
      });
    }

    const existing = await ProductionDevice.findOne({
      deviceId: newDeviceId,
      _id: { $ne: device._id },
    }).select("_id serialNumber");

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "newDeviceId is already assigned.",
      });
    }

    const pendingIdentity = await ProductionCommand.findOne({
      serialNumber,
      kind: "identity_change",
      status: { $in: ACTIVE_COMMAND_STATUSES },
      "metadata.requestedDeviceId": newDeviceId,
    });

    if (pendingIdentity) {
      return res.status(409).json({
        success: false,
        message: "An identity change for this Device ID is already pending.",
        requestId: pendingIdentity.requestId,
      });
    }

    const ssid = decryptSecret(
      device.wifiCredentials?.encryptedSsid
    );

    const password = decryptSecret(
      device.wifiCredentials?.encryptedPassword
    );

    validateWifiCredentials(ssid, password);

    const firmwareProfile = device.firmwareProfileId;

    await validateFirmwareCompatibility(device, firmwareProfile);

    const nvsVersion =
      Math.max(
        Number(device.provisioning.desiredConfigVersion || 0),
        Number(device.provisioning.appliedConfigVersion || 0)
      ) + 1;

    const requestId = createRequestId("identity");

    const payload = buildSetConfigPayload({
      serialNumber,
      deviceId: newDeviceId,
      ssid,
      password,
      nvsVersion,
      currentRF: firmwareProfile.defaults?.currentRF,
      requestId,
    });

    // Do not change ProductionDevice.deviceId until configAck confirms
    // that the device has applied the new identity.
    device.provisioning.status = "pending";
    device.provisioning.desiredConfigVersion = nvsVersion;
    device.provisioning.lastRequestId = requestId;
    device.provisioning.lastError = null;
    await device.save();

    const command = await publishConfigCommand({
      device,
      payload,
      action: "setConfig",
      kind: "identity_change",
      metadata: {
        operation: "identity_change",
        oldDeviceId,
        requestedDeviceId: newDeviceId,
        nvsVersion,
      },
      createdBy: req.user?.userId,
    });

    return res.status(202).json({
      success: true,
      message: "Identity change command published. Current Device ID remains unchanged until acknowledgement.",
      data: {
        serialNumber,
        oldDeviceId,
        requestedDeviceId: newDeviceId,
        requestId,
        nvsVersion,
        commandStatus: command.status,
      },
    });
  } catch (error) {
    console.error("[Production V3] changeDeviceIdentity:", error);
    return sendError(res, error);
  }
};


// ==================================================
// ADMIN MQTT COMMANDS
// POST /devices/:serialNumber/admin-command
// ==================================================

exports.sendAdminCommand = async (req, res) => {
  try {
    const serialNumber = normalizeSerial(req.params.serialNumber);
    const action = String(req.body.action || "");

    const device = await ProductionDevice.findOne({
      serialNumber,
    });

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

    const allowedStatuses = [
      "group_b",
      "calibration_required",
      "calibrating",
      "calibration_failed",
      "production_ready",
      "dispatched",
    ];

    if (!allowedStatuses.includes(device.manufacturingStatus)) {
      return res.status(409).json({
        success: false,
        message: "Admin commands are not allowed in the current lifecycle state.",
      });
    }

    const isStart =
      action === "relayStart" ||
      action === "startFastTelemetry";

    if (isStart) {
      const lastSeen = device.discovery?.lastSeenAt
        ? new Date(device.discovery.lastSeenAt).getTime()
        : 0;

      const online =
        device.discovery?.isOnline &&
        Date.now() - lastSeen < 90000;

      if (!online) {
        return res.status(409).json({
          success: false,
          message: "Device is offline or has not sent telemetry recently.",
        });
      }
    }

    let params = {};

    if (action === "relayStart") {
      if (req.body.testMode !== true) {
        return res.status(400).json({
          success: false,
          message: "relayStart requires testMode=true.",
        });
      }

      const durationSeconds = Number(
        req.body.durationSeconds ?? 10
      );

      if (
        !Number.isInteger(durationSeconds) ||
        durationSeconds < 1 ||
        durationSeconds > 15
      ) {
        return res.status(400).json({
          success: false,
          message: "durationSeconds must be between 1 and 15.",
        });
      }

      params = {
        testMode: true,
        durationSeconds,
      };
    } else if (action === "startFastTelemetry") {
      const intervalMs = Number(req.body.intervalMs ?? 500);
      const durationSeconds = Number(
        req.body.durationSeconds ?? 120
      );

      if (
        !Number.isInteger(intervalMs) ||
        intervalMs < 250 ||
        intervalMs > 5000
      ) {
        return res.status(400).json({
          success: false,
          message: "intervalMs must be between 250 and 5000.",
        });
      }

      if (
        !Number.isInteger(durationSeconds) ||
        durationSeconds < 1 ||
        durationSeconds > 300
      ) {
        return res.status(400).json({
          success: false,
          message: "durationSeconds must be between 1 and 300.",
        });
      }

      params = {
        intervalMs,
        durationSeconds,
      };
    } else if (
      action !== "relayStop" &&
      action !== "stopFastTelemetry"
    ) {
      return res.status(400).json({
        success: false,
        message: "Unsupported admin command.",
        allowedActions: [
          "relayStart",
          "relayStop",
          "startFastTelemetry",
          "stopFastTelemetry",
        ],
      });
    }

    const command = await publishAdminCommand({
      device,
      action,
      params,
      createdBy: req.user?.userId,
    });

    return res.status(202).json({
      success: true,
      message: "Admin command published. Wait for the device acknowledgement.",
      data: {
        requestId: command.requestId,
        serialNumber,
        deviceId: device.deviceId,
        action,
        topic: command.topic,
        status: command.status,
      },
    });
  } catch (error) {
    console.error("[Production V3] sendAdminCommand:", error);
    return sendError(res, error);
  }
};


// ==================================================
// FAST TELEMETRY HISTORY
// GET /devices/:serialNumber/telemetry
// ==================================================

exports.getFastTelemetry = async (req, res) => {
  try {
    const serialNumber = normalizeSerial(req.params.serialNumber);

    const device = await ProductionDevice.findOne({
      serialNumber,
    }).select("_id serialNumber");

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 50)
    );

    const filter = { serialNumber };

    if (req.query.requestId) {
      filter.telemetryRequestId = String(req.query.requestId);
    }

    const [samples, total] = await Promise.all([
      ProductionTelemetry.find(filter)
        .sort({ capturedAt: -1 })
        .limit(limit)
        .lean(),

      ProductionTelemetry.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: samples,
      pagination: {
        limit,
        total,
      },
    });
  } catch (error) {
    console.error("[Production V3] getFastTelemetry:", error);
    return sendError(res, error);
  }
};


// ==================================================
// COMMAND HISTORY
// GET /devices/:serialNumber/commands
// ==================================================

exports.getDeviceCommands = async (req, res) => {
  try {
    const serialNumber = normalizeSerial(req.params.serialNumber);

    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 30)
    );

    const commands = await ProductionCommand.find({
      serialNumber,
    })
      .select("-payload.password")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      data: commands,
    });
  } catch (error) {
    console.error("[Production V3] getDeviceCommands:", error);
    return sendError(res, error);
  }
};


// ==================================================
// APPLY ADVANCED CALIBRATION
// POST /devices/:serialNumber/calibration/apply
// ==================================================

exports.applyCalibration = async (req, res) => {
  try {
    const serialNumber = normalizeSerial(req.params.serialNumber);

    const device = await ProductionDevice.findOne({
      serialNumber,
    }).populate("calibrationProfileId");

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    if (!device.deviceId) {
      return res.status(409).json({
        success: false,
        message: "Device is not provisioned.",
      });
    }

    if (
      !["calibration_required", "calibrating", "calibration_failed"].includes(
        device.manufacturingStatus
      )
    ) {
      return res.status(409).json({
        success: false,
        message: "Device is not in a calibration-eligible state.",
      });
    }

    const profile = device.calibrationProfileId;

    if (!profile || profile.status !== "active") {
      return res.status(409).json({
        success: false,
        message: "An active Calibration Profile must be assigned.",
      });
    }

    const requiredKeys = [
      "vf",
      "currentZero",
      "currentGain",
      "powerZero",
      "powerGain",
    ];

    const supplied = req.body || {};
    const values = {};

    const profileValues = new Map(
      (profile.calibrationValues || []).map((item) => [
        item.firmwareKey,
        item,
      ])
    );

    for (const key of requiredKeys) {
      const definition = profileValues.get(key);

      if (!definition) {
        return res.status(409).json({
          success: false,
          message: `Calibration Profile is missing firmwareKey ${key}.`,
        });
      }

      const value = Number(supplied[key]);

      if (!Number.isFinite(value)) {
        return res.status(400).json({
          success: false,
          message: `${key} must be a finite number.`,
        });
      }

      if (
        definition.minimumValue !== null &&
        definition.minimumValue !== undefined &&
        value < definition.minimumValue
      ) {
        return res.status(400).json({
          success: false,
          message: `${key} is below the allowed profile minimum.`,
        });
      }

      if (
        definition.maximumValue !== null &&
        definition.maximumValue !== undefined &&
        value > definition.maximumValue
      ) {
        return res.status(400).json({
          success: false,
          message: `${key} exceeds the allowed profile maximum.`,
        });
      }

      values[key] = value;
    }

    const pending = await ProductionCommand.findOne({
      serialNumber,
      action: "setCalibration",
      status: { $in: ACTIVE_COMMAND_STATUSES },
    });

    if (pending) {
      return res.status(409).json({
        success: false,
        message: "A calibration apply is already awaiting acknowledgement for this device.",
        requestId: pending.requestId,
      });
    }

    const requestId = createRequestId("calibration");

    const payload = {
      action: "setCalibration",
      serialNumber,
      requestId,
      ...values,
    };

    const command = await publishConfigCommand({
      device,
      payload,
      action: "setCalibration",
      kind: "calibration",
      metadata: {
        operation: "calibration_apply",
        calibrationProfileId: String(profile._id),
        calibrationProfileVersion: profile.profileVersion,
        constants: values,
      },
      createdBy: req.user?.userId,
    });

    device.calibration.status = "calibrating";
    device.updatedBy = req.user?.userId || null;
    await device.save();

    return res.status(202).json({
      success: true,
      message: "Calibration constants sent. Awaiting firmware configAck.",
      data: {
        serialNumber,
        requestId,
        commandStatus: command.status,
        constants: values,
      },
    });
  } catch (error) {
    console.error("[Production V3] applyCalibration:", error);
    return sendError(res, error);
  }
};


// ==================================================
// VERIFY CALIBRATION AGAINST A REFERENCE METER
// POST /devices/:serialNumber/calibration/verify
//
// Body:
// {
//   "reference": {
//     "voltage": 230.1,
//     "current": 5.02,
//     "power": 1155
//   }
// }
// ==================================================

exports.verifyCalibration = async (req, res) => {
  try {
    const serialNumber = normalizeSerial(req.params.serialNumber);

    const device = await ProductionDevice.findOne({
      serialNumber,
    }).populate("calibrationProfileId");

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    const profile = device.calibrationProfileId;

    if (!profile || profile.status !== "active") {
      return res.status(409).json({
        success: false,
        message: "An active Calibration Profile is required.",
      });
    }

    const reference = req.body.reference || {};

    const referenceValues = {
      voltage: finiteNumber(reference.voltage, "reference.voltage", 0.001),
      current: finiteNumber(reference.current, "reference.current", 0.001),
      power: finiteNumber(reference.power, "reference.power", 0.001),
    };

    const latestApply = await ProductionCommand.findOne({
      serialNumber,
      action: "setCalibration",
      status: "accepted",
    }).sort({ acknowledgedAt: -1 });

    if (!latestApply || !latestApply.acknowledgedAt) {
      return res.status(409).json({
        success: false,
        message: "No successful calibration apply acknowledgement was found.",
      });
    }

    const sample = await ProductionTelemetry.findOne({
      serialNumber,
      telemetryMode: "fast",
      sampleFresh: true,
      capturedAt: { $gt: latestApply.acknowledgedAt },
    })
      .sort({ capturedAt: -1 })
      .lean();

    if (!sample) {
      return res.status(409).json({
        success: false,
        message: "No fresh fast telemetry sample was received after calibration apply.",
      });
    }

    if (
      sample.sampleAgeMs === null ||
      sample.sampleAgeMs > 5000 ||
      Date.now() - new Date(sample.capturedAt).getTime() > 10000
    ) {
      return res.status(409).json({
        success: false,
        message: "The latest measurement is too old for calibration verification.",
      });
    }

    const criteria = profile.acceptanceCriteria || {};

    const channels = [
      {
        name: "voltage",
        measured: sample.voltage,
        reference: referenceValues.voltage,
        required: criteria.requireVoltageVerification,
        tolerance: criteria.voltageTolerancePercent,
      },
      {
        name: "current",
        measured: sample.current,
        reference: referenceValues.current,
        required: criteria.requireCurrentVerification,
        tolerance: criteria.currentTolerancePercent,
      },
      {
        name: "power",
        measured: sample.power,
        reference: referenceValues.power,
        required: criteria.requirePowerVerification,
        tolerance: criteria.powerTolerancePercent,
      },
    ];

    const results = {};

    let passed = true;

    for (const channel of channels) {
      if (channel.required === false) continue;

      if (
        !Number.isFinite(channel.tolerance) ||
        !Number.isFinite(channel.measured)
      ) {
        return res.status(409).json({
          success: false,
          message: `Calibration Profile must define ${channel.name} verification tolerance and telemetry must contain a valid measurement.`,
        });
      }

      const errorPercent =
        Math.abs(channel.measured - channel.reference) /
        channel.reference *
        100;

      const channelPassed =
        errorPercent <= channel.tolerance;

      results[channel.name] = {
        measured: channel.measured,
        reference: channel.reference,
        errorPercent,
        allowedErrorPercent: channel.tolerance,
        passed: channelPassed,
      };

      if (!channelPassed) passed = false;
    }

    device.calibration.status = passed ? "passed" : "failed";

    if (passed) {
      device.calibration.lastPassedAt = new Date();
      device.calibration.lastFailureReason = null;
      device.manufacturingStatus = "production_ready";
    } else {
      device.calibration.lastFailedAt = new Date();
      device.calibration.lastFailureReason =
        "One or more reference verification tolerances were exceeded.";
      device.manufacturingStatus = "calibration_failed";
    }

    device.updatedBy = req.user?.userId || null;
    await device.save();

    await ProductionCommand.updateOne(
      { _id: latestApply._id },
      {
        $set: {
          "metadata.verification": {
            passed,
            results,
            verifiedAt: new Date(),
            verifiedBy: req.user?.userId || null,
          },
        },
      }
    );

    return res.status(200).json({
      success: true,
      message: passed
        ? "Calibration verification passed. Device marked Production Ready."
        : "Calibration verification failed. Device returned to calibration rework.",
      data: {
        serialNumber,
        manufacturingStatus: device.manufacturingStatus,
        calibrationStatus: device.calibration.status,
        results,
      },
    });
  } catch (error) {
    console.error("[Production V3] verifyCalibration:", error);
    return sendError(res, error);
  }
};