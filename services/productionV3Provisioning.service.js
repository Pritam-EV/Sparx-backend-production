
// services/productionV3Provisioning.service.js

const crypto = require("crypto");

const mqttClient = require("../mqttClient");
const ProductionDevice = require("../models/ProductionDevice");

const {
  CONFIG_ACTION,
  CONFIG_SCHEMA_VERSION,
  CONFIG_ACK_STATUS,
  buildConfigTopic,
  normalizeSerialNumber,
  normalizeDeviceId,
} = require("../config/deviceProtocol");

// --------------------------------------------------
// COMMON HELPERS
// --------------------------------------------------

function cleanMessage(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength) || null;
}

function matchedCount(result) {
  return result?.matchedCount ?? result?.n ?? 0;
}

function modifiedCount(result) {
  return result?.modifiedCount ?? result?.nModified ?? 0;
}

// --------------------------------------------------
// MQTT PUBLISH
// Uses the application's existing shared MQTT client.
// --------------------------------------------------

function publishAsync(topic, payload) {
  if (!mqttClient.connected) {
    return Promise.reject(
      new Error("MQTT broker is not connected.")
    );
  }

  return new Promise((resolve, reject) => {
    mqttClient.publish(
      topic,
      JSON.stringify(payload),
      {
        qos: 1,
        retain: false,
      },
      (error) => {
        if (error) {
          return reject(error);
        }

        resolve();
      }
    );
  });
}

// --------------------------------------------------
// GROUP B: PROVISION WIFI + DEVICE ID
//
// Topic: viz/<SERIAL>/config
// --------------------------------------------------

async function publishGroupBProvisionConfig({
  serialNumber,
  deviceId,
  wifiSSID,
  wifiPassword,
  requestId,
  nvsVersion,
}) {
  const serial = normalizeSerialNumber(serialNumber).toUpperCase();
  const normalizedDeviceId = normalizeDeviceId(deviceId);

  if (!serial || !normalizedDeviceId || !requestId) {
    throw new Error(
      "Serial number, Device ID and request ID are required."
    );
  }

  if (!wifiSSID || !wifiPassword) {
    throw new Error("Wi-Fi SSID and password are required.");
  }

  const version = Number(nvsVersion);

  if (!Number.isInteger(version) || version < 0) {
    throw new Error("Invalid NVS version.");
  }

  const topic = buildConfigTopic(serial);

  const payload = {
    action: CONFIG_ACTION,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    requestId,
    serialNumber: serial,
    deviceId: normalizedDeviceId,
    ssid: wifiSSID,
    password: wifiPassword,
    nvsVersion: version,
  };

  await publishAsync(topic, payload);

  // Never log or return Wi-Fi credentials.
  return {
    topic,
    requestId,
    nvsVersion: version,
  };
}

// --------------------------------------------------
// CALIBRATION: SEND FIVE COEFFICIENTS
//
// Topic: viz/<SERIAL>/config
// --------------------------------------------------

async function publishCalibration({
  serialNumber,
  requestId,
  coefficients,
}) {
  const serial = normalizeSerialNumber(serialNumber).toUpperCase();

  if (!serial || !requestId) {
    throw new Error(
      "Serial number and request ID are required."
    );
  }

  const keys = [
    "vf",
    "currentZero",
    "currentGain",
    "powerZero",
    "powerGain",
  ];

  const payload = {
    action: "setCalibration",
    serialNumber: serial,
    requestId,
  };

  for (const key of keys) {
    const value = Number(coefficients?.[key]);

    if (!Number.isFinite(value)) {
      throw new Error(
        `Invalid calibration coefficient: ${key}`
      );
    }

    payload[key] = value;
  }

  const topic = buildConfigTopic(serial);

  await publishAsync(topic, payload);

  return {
    topic,
    requestId,
  };
}

// --------------------------------------------------
// DEVICE CONTROLS
//
// Topic: viz/<DEVICE_ID>/admincmd
// --------------------------------------------------


async function publishProductionCommand({
  deviceId,
  action,
  requestId,
  testMode,
  durationSeconds,
  intervalMs,
}) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);

  const allowedActions = [
    "relayStart",
    "relayStop",
    "startFastTelemetry",
    "stopFastTelemetry",
  ];

  if (!normalizedDeviceId) {
    throw new Error("Valid Device ID is required.");
  }

  if (!allowedActions.includes(action)) {
    throw new Error("Unsupported production device command.");
  }

  const correlationId = String(
    requestId || crypto.randomUUID()
  ).trim();

  const topic = `viz/${normalizedDeviceId}/admincmd`;

  const payload = {
    action,
    requestId: correlationId,
  };

  if (action === "relayStart") {
    const duration = Number(durationSeconds);

    if (testMode !== true) {
      throw new Error("Relay start requires testMode=true.");
    }

    if (
      !Number.isInteger(duration) ||
      duration < 1 ||
      duration > 120
    ) {
      throw new Error(
        "Relay test duration must be between 1 and 120 seconds."
      );
    }

    payload.testMode = true;
    payload.durationSeconds = duration;
  }

  if (action === "startFastTelemetry") {
    const duration = Number(durationSeconds);
    const interval =
      intervalMs === undefined || intervalMs === null
        ? 500
        : Number(intervalMs);

    if (
      !Number.isInteger(duration) ||
      duration < 1 ||
      duration > 300
    ) {
      throw new Error(
        "Fast telemetry duration must be between 1 and 300 seconds."
      );
    }

    if (
      !Number.isInteger(interval) ||
      interval < 250 ||
      interval > 5000
    ) {
      throw new Error(
        "Fast telemetry interval must be between 250 and 5000 ms."
      );
    }

    payload.intervalMs = interval;
    payload.durationSeconds = duration;
  }

  await publishAsync(topic, payload);

  return {
    topic,
    requestId: correlationId,
    deviceId: normalizedDeviceId,
    action,
    payload,
  };
}


// --------------------------------------------------
// GROUP B CONFIG ACK
//
// Topic: viz/<SERIAL>/configAck
// --------------------------------------------------

async function handleProductionConfigAck({
  serialNumber,
  ack,
}) {
  const serial = normalizeSerialNumber(serialNumber).toUpperCase();

  if (!serial) {
    return {
      matched: false,
      reason: "missing_serial",
    };
  }

  const device = await ProductionDevice.findOne({
    serialNumber: serial,
  })
    .select(
      [
        "_id",
  "serialNumber",
  "stage",
  "groupB.deviceId",
  "groupB.nvsVersion",
  "groupB.provisionStatus",
  "groupB.configAck",
  "groupB.lastKnownFirmwareVersion",
  "calibration.status",
  "calibration.requestId",
  "calibration.acknowledgement",
      ].join(" ")
    )
    .lean();

  if (!device) {
    return {
      matched: false,
      reason: "device_not_found",
    };
  }

  const requestId = String(ack?.requestId || "").trim();

  const status = String(
    ack?.status || ""
  ).trim().toLowerCase();

  const action = String(ack?.action || "").trim();

if (!action) {
  return {
    matched: true,
    reason: "missing_action",
  };
}

if (!["setConfig", "setCalibration"].includes(action)) {
  return {
    matched: true,
    reason: "unsupported_action",
  };
}

  // A production serial has matched.
  // Never pass malformed production ACKs into legacy updates.
  if (!requestId) {
    return {
      matched: true,
      reason: "missing_request_id",
    };
  }

  if (
    ![
      CONFIG_ACK_STATUS.OK,
      CONFIG_ACK_STATUS.ERROR,
    ].includes(status)
  ) {
    return {
      matched: true,
      reason: "invalid_status",
    };
  }

  const now = new Date();

  const message = cleanMessage(ack.message);

  const wasIgnored =
    /older or duplicate configuration ignored/i.test(
      String(ack.message || "")
    );

  const successful =
    status === CONFIG_ACK_STATUS.OK &&
    !wasIgnored;

  // ------------------------------------------------
  // GROUP B ACK
  // ------------------------------------------------

  const expectedProvisionAck =
    device.groupB?.configAck || {};

  if (
    requestId === expectedProvisionAck.requestId
  ) {
    const expectedNvsVersion = Number(
      expectedProvisionAck.nvsVersion
    );

   if (action !== "setConfig") {
  return {
    matched: true,
    reason: "group_b_action_mismatch",
  };
}

const receivedNvsVersion = Number(ack.nvsVersion);

if (
  ack.nvsVersion === undefined ||
  ack.nvsVersion === null ||
  !Number.isInteger(receivedNvsVersion)
) {
  return {
    matched: true,
    reason: "missing_or_invalid_nvs_version",
  };
}

if (
  !Number.isInteger(expectedNvsVersion) ||
  receivedNvsVersion !== expectedNvsVersion
) {
  return {
    matched: true,
    reason: "stale_nvs_version",
  };
}

    // Duplicate successful ACK:
    // Do not move the device backwards from Calibration or Dispatch.
    if (
      expectedProvisionAck.status === CONFIG_ACK_STATUS.OK &&
      device.groupB?.provisionStatus ===
        ProductionDevice.PROVISION_STATUS.ACKNOWLEDGED
    ) {
      return {
        matched: true,
        reason: "duplicate_provision_ack",
      };
    }

    const updateFields = {
      "groupB.provisionStatus": successful
        ? ProductionDevice.PROVISION_STATUS.ACKNOWLEDGED
        : ProductionDevice.PROVISION_STATUS.FAILED,

      "groupB.configAck": {
        status,
        action: CONFIG_ACTION,
        requestId,
        message,
        fwVersion: cleanMessage(ack.fwVersion, 100),
        nvsVersion: Number.isFinite(expectedNvsVersion)
          ? expectedNvsVersion
          : null,
        receivedAt: now,
      },

      "groupB.lastError": successful
        ? null
        : (
            message ||
            "Device rejected provisioning configuration."
          ),

      updatedBy: "mqtt",
    };

    if (successful) {
      updateFields.stage = ProductionDevice.STAGE.CALIBRATION;
      updateFields.stageUpdatedAt = now;
    }

    if (ack.fwVersion) {
      updateFields["groupB.lastKnownFirmwareVersion"] =
        String(ack.fwVersion).slice(0, 100);
    }

    // The request ID in the database must still match.
    // An older delayed ACK cannot overwrite a newer provision request.
    const update = await ProductionDevice.updateOne(
{
  _id: device._id,
  "groupB.configAck.requestId": requestId,
  "groupB.configAck.status": CONFIG_ACK_STATUS.PENDING,
  "groupB.nvsVersion": expectedNvsVersion,
},
      {
        $set: updateFields,
      }
    );

    if (matchedCount(update) === 0) {
      return {
        matched: true,
        reason: modifiedCount(update) === 0
          ? "duplicate_or_stale_provision_ack"
          : "provision_ack_not_applied",
      };
    }

    return {
      matched: true,
      operation: "setConfig",
      successful,
      serialNumber: serial,
    };
  }

  // ------------------------------------------------
  // CALIBRATION ACK
  // ------------------------------------------------

if (
  action === "setCalibration" &&
  requestId === device.calibration?.requestId
) {
    // A duplicate successful calibration ACK must not
    // re-apply the transition or overwrite the applied time.
    if (
      device.calibration.acknowledgement?.status ===
        CONFIG_ACK_STATUS.OK &&
      device.calibration.status ===
        ProductionDevice.CALIBRATION_STATUS.APPLIED
    ) {
      return {
        matched: true,
        reason: "duplicate_calibration_ack",
      };
    }

    const receivedNvsVersion =
      ack.nvsVersion !== undefined &&
      ack.nvsVersion !== null
        ? Number(ack.nvsVersion)
        : null;

    const validNvsVersion =
      receivedNvsVersion !== null &&
      Number.isFinite(receivedNvsVersion)
        ? receivedNvsVersion
        : null;

    const updateFields = {
      "calibration.acknowledgement": {
        status,
        action: "setCalibration",
        requestId,
        message,
        fwVersion: cleanMessage(ack.fwVersion, 100),
        nvsVersion: validNvsVersion,
        receivedAt: now,
      },

      "calibration.status": successful
        ? ProductionDevice.CALIBRATION_STATUS.APPLIED
        : ProductionDevice.CALIBRATION_STATUS.FAILED,

      "calibration.appliedAt": successful ? now : null,

      "calibration.lastError": successful
        ? null
        : (
            message ||
            "Firmware rejected calibration."
          ),

      updatedBy: "mqtt",
    };

    if (ack.fwVersion) {
      updateFields["groupB.lastKnownFirmwareVersion"] =
        String(ack.fwVersion).slice(0, 100);
    }

    // This condition prevents an old ACK from overwriting
    // a newer calibration request or an already-applied result.
    const update = await ProductionDevice.updateOne(
{
  _id: device._id,
  "calibration.requestId": requestId,
  "calibration.status": ProductionDevice.CALIBRATION_STATUS.SUBMITTED,
},
      {
        $set: updateFields,
      }
    );

    if (matchedCount(update) === 0) {
      return {
        matched: true,
        reason: modifiedCount(update) === 0
          ? "duplicate_or_stale_calibration_ack"
          : "calibration_ack_not_applied",
      };
    }

    return {
      matched: true,
      operation: "setCalibration",
      successful,
      serialNumber: serial,
    };
  }

  return {
    matched: true,
    reason: "stale_or_unmatched_request",
  };
}

// --------------------------------------------------
// ADMIN COMMAND ACK
//
// Topic: viz/<DEVICE_ID>/adminAck
//
// Expected status values:
//   ok / success / acknowledged
//   error / failed / rejected
// --------------------------------------------------

async function handleProductionAdminAck({
  deviceId,
  ack,
}) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);

  if (!normalizedDeviceId) {
    return {
      matched: false,
      reason: "missing_device_id",
    };
  }

  const device = await ProductionDevice.findOne({
    "groupB.deviceId": normalizedDeviceId,
  })
    .select(
      "_id serialNumber groupB.deviceId groupB.lastCommand"
    )
    .lean();

  if (!device) {
    return {
      matched: false,
      reason: "device_not_found",
    };
  }

  const requestId = String(
    ack?.requestId || ""
  ).trim();

  if (!requestId) {
    return {
      matched: true,
      reason: "missing_request_id",
    };
  }

  // If the payload also contains Device ID, it must agree with the topic.
  if (
    ack.deviceId &&
    normalizeDeviceId(ack.deviceId) !== normalizedDeviceId
  ) {
    return {
      matched: true,
      reason: "device_id_mismatch",
    };
  }

  const pending = device.groupB?.lastCommand;

  if (!pending || pending.requestId !== requestId) {
    return {
      matched: true,
      reason: "stale_or_unmatched_command_ack",
    };
  }

  const ackAction = String(
    ack.action || ""
  ).trim();

  if (
    ackAction &&
    ackAction !== pending.action
  ) {
    return {
      matched: true,
      reason: "command_action_mismatch",
    };
  }

  const rawStatus = String(
    ack.status || ""
  ).trim().toLowerCase();


let commandStatus = null;

const isTimedCommand = [
  "relayStart",
  "startFastTelemetry",
].includes(pending.action);

const isErrorAck =
  [
    "error",
    "failed",
    "failure",
    "rejected",
  ].includes(rawStatus) ||
  ack.success === false ||
  ack.ok === false;

if (isErrorAck) {
  commandStatus = "failed";

} else if (
  isTimedCommand &&
  [
    "accepted",
    "started",
    "running",
  ].includes(rawStatus)
) {
  // Firmware accepted the command, but the timed operation
  // has not completed yet.
  commandStatus = "pending";

} else if (
  [
    "ok",
    "success",
    "acknowledged",
    "accepted",
    "duplicate",
    "stopped",
    "completed",
    "done",
  ].includes(rawStatus) ||
  ack.success === true ||
  ack.ok === true
) {
  commandStatus = "acknowledged";
}

if (!commandStatus) {
  return {
    matched: true,
    reason: "invalid_command_ack_status",
  };
}


  if (!commandStatus) {
    return {
      matched: true,
      reason: "invalid_command_ack_status",
    };
  }

  if (pending.status !== "pending") {
    return {
      matched: true,
      reason: "duplicate_command_ack",
    };
  }


const now = new Date();

// Update only the latest command with the matching request ID.
// Intermediate ACKs keep the command pending.

const update = await ProductionDevice.updateOne(
  {
    _id: device._id,
    "groupB.lastCommand.requestId": requestId,
    "groupB.lastCommand.status": "pending",
  },
  {
    $set: {
      "groupB.lastCommand.status": commandStatus,

      "groupB.lastCommand.acknowledgedAt":
        commandStatus === "pending" ? null : now,

      "groupB.lastCommand.message":
        cleanMessage(ack.message),

      updatedBy: "mqtt",
    },
  }
);


  if (matchedCount(update) === 0) {
    return {
      matched: true,
      reason: "duplicate_or_stale_command_ack",
    };
  }

  return {
    matched: true,
    operation: pending.action,
    status: commandStatus,
    requestId,
    serialNumber: device.serialNumber,
  };
}

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  publishGroupBProvisionConfig,
  publishCalibration,
  publishProductionCommand,
  handleProductionConfigAck,
  handleProductionAdminAck,
};
