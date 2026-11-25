const crypto = require("crypto");

const mqttClient = require("../mqttClient");

const ProductionDevice = require("../models/ProductionDevice");
const ProductionCommand = require("../models/ProductionCommand");
const ProductionTelemetry = require("../models/ProductionTelemetry");
const CalibrationSession = require("../models/CalibrationSession");

const {
  refreshBatchCountsForDevice,
} = require("./productionV3Lifecycle.service");

const ADMIN_ACTIONS = [
  "relayStart",
  "relayStop",
  "startFastTelemetry",
  "stopFastTelemetry",
];

const PENDING_COMMAND_STATUSES = [
  "queued",
  "published",
];

let started = false;
let offlineSweepStarted = false;

function normalizeSerial(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeDeviceId(value) {
  return String(value || "").trim().toUpperCase();
}

function createRequestId(prefix = "v3") {
  return `${prefix}-${Date.now()}-${crypto
    .randomBytes(6)
    .toString("hex")}`;
}

function sanitizePayload(payload) {
  const safe = { ...payload };

  if (Object.prototype.hasOwnProperty.call(safe, "password")) {
    safe.password = safe.password ? "[REDACTED]" : "";
  }

  return safe;
}

function publishAsync(topic, payload, options = {}) {
  return new Promise((resolve, reject) => {
    if (!mqttClient || !mqttClient.connected) {
      return reject(new Error("MQTT client is not connected."));
    }

    mqttClient.publish(
      topic,
      JSON.stringify(payload),
      {
        qos: 1,
        retain: false,
        ...options,
      },
      (error) => {
        if (error) return reject(error);
        resolve();
      }
    );
  });
}

function publishRetainedClear(topic) {
  return new Promise((resolve, reject) => {
    if (!mqttClient || !mqttClient.connected) {
      return reject(new Error("MQTT client is not connected."));
    }

    // Empty retained publication clears the old retained ACK.
    mqttClient.publish(
      topic,
      "",
      { qos: 1, retain: true },
      (error) => {
        if (error) return reject(error);
        resolve();
      }
    );
  });
}

async function publishTrackedCommand({
  requestId = createRequestId(),
  serialNumber,
  deviceId,
  action,
  kind,
  topic,
  payload,
  metadata = {},
  createdBy = null,
}) {
  const serial = normalizeSerial(serialNumber);

  if (!serial || !action || !topic) {
    throw new Error("serialNumber, action and topic are required.");
  }

  const command = await ProductionCommand.create({
    requestId,
    serialNumber: serial,
    deviceId: normalizeDeviceId(deviceId) || null,
    action,
    kind,
    topic,
    payload: sanitizePayload(payload),
    metadata,
    status: "queued",
    createdBy,
  });

  try {
    await publishAsync(topic, payload);

    // Conditional update avoids overwriting a fast ACK that arrived
    // between MQTT publish and this database update.
    await ProductionCommand.updateOne(
      {
        _id: command._id,
        status: "queued",
      },
      {
        $set: {
          status: "published",
          publishedAt: new Date(),
        },
      }
    );

    return await ProductionCommand.findById(command._id).lean();
  } catch (error) {
    await ProductionCommand.updateOne(
      { _id: command._id },
      {
        $set: {
          status: "failed",
          metadata: {
            ...metadata,
            publishError: error.message,
          },
        },
      }
    );

    throw error;
  }
}

async function publishAdminCommand({
  device,
  action,
  params = {},
  createdBy,
}) {
  if (!ADMIN_ACTIONS.includes(action)) {
    throw new Error("Unsupported admin command.");
  }

  if (!device || !device.serialNumber || !device.deviceId) {
    throw new Error("A provisioned Production 3.0 device is required.");
  }

  const requestId = createRequestId("admin");

  const topic =
    `viz/${normalizeDeviceId(device.deviceId)}/admincmd`;

  const payload = {
    action,
    requestId,
    ...params,
  };

  return publishTrackedCommand({
    requestId,
    serialNumber: device.serialNumber,
    deviceId: device.deviceId,
    action,
    kind: "admin",
    topic,
    payload,
    createdBy,
  });
}

async function publishConfigCommand({
  device,
  payload,
  action,
  kind,
  metadata = {},
  createdBy,
}) {
  const serialNumber = normalizeSerial(
    device?.serialNumber
  );

  if (!serialNumber) {
    throw new Error("Valid device serial number is required.");
  }

  const pending = await ProductionCommand.findOne({
    serialNumber,
    action: {
      $in: ["setConfig", "setCalibration"],
    },
    status: {
      $in: PENDING_COMMAND_STATUSES,
    },
  }).sort({ createdAt: -1 });

  if (pending) {
    const error = new Error(
      "Another configuration or calibration command is awaiting acknowledgement."
    );

    error.statusCode = 409;
    error.requestId = pending.requestId;

    throw error;
  }

  const requestId =
    payload.requestId || createRequestId("config");

  const message = {
    ...payload,
    requestId,
  };

  const configTopic =
    `viz/${serialNumber}/config`;

  const acknowledgementTopic =
    `viz/${serialNumber}/configAck`;

  // The firmware publishes retained config acknowledgements.
  // Clear any previous ACK before sending the new command.
  await publishRetainedClear(acknowledgementTopic);

  return publishTrackedCommand({
    requestId,
    serialNumber,
    deviceId: device.deviceId,
    action,
    kind,
    topic: configTopic,
    payload: message,
    metadata,
    createdBy,
  });
}


// ==================================================
// INCOMING: DISCOVERY STATUS
// viz/<SERIAL>/status
// ==================================================

async function handleDiscovery(parts, message) {
  const topicSerial = normalizeSerial(parts[1]);

  const reportedSerial = normalizeSerial(
    message.serial || message.serialNumber
  );

  if (
    !topicSerial ||
    !reportedSerial ||
    topicSerial !== reportedSerial
  ) {
    console.warn(
      "[Production V3 MQTT] Discovery serial mismatch."
    );
    return;
  }

  // Current firmware announces discovery with status READY.
  // Ignore all other statuses for lifecycle promotion.
  if (String(message.status || "").toUpperCase() !== "READY") {
    return;
  }

  const now = new Date();

  const update = {
    "discovery.lastSeenAt": now,
    "discovery.isOnline": true,
    "discovery.reportedSerialNumber": reportedSerial,
    "discovery.firmwareVersion": message.fwVersion || null,
    firmwareVersion: message.fwVersion || null,
  };

  await ProductionDevice.updateOne(
    {
      serialNumber: topicSerial,
      manufacturingStatus: "group_a",
    },
    {
      $set: {
        ...update,
        manufacturingStatus: "discovered",
      },
    }
  );

  await ProductionDevice.updateOne(
    {
      serialNumber: topicSerial,
      manufacturingStatus: { $ne: "group_a" },
    },
    {
      $set: update,
    }
  );

  await ProductionDevice.updateOne(
    {
      serialNumber: topicSerial,
      "discovery.firstSeenAt": null,
    },
    {
      $set: {
        "discovery.firstSeenAt": now,
      },
    }
  );

  await refreshBatchCountsForDevice(topicSerial);
}


// ==================================================
// INCOMING: ADMIN ACK
// viz/<DEVICE_ID>/adminAck
// ==================================================

async function handleAdminAck(parts, message) {
  const requestId = String(message.requestId || "").trim();
  const serialNumber = normalizeSerial(message.serialNumber);

  if (!requestId || !serialNumber) {
    console.warn("[Production V3 MQTT] Admin ACK missing identifiers.");
    return;
  }

  const status = String(message.status || "").toLowerCase();

  const statusMap = {
    accepted: "accepted",
    rejected: "rejected",
    duplicate: "duplicate",
    stopped: "completed",
    completed: "completed",
    failed: "failed",
  };

  const newStatus = statusMap[status];

  if (!newStatus) {
    console.warn("[Production V3 MQTT] Unknown admin ACK status:", status);
    return;
  }

  const command = await ProductionCommand.findOne({
    requestId,
    serialNumber,
  });

  if (!command) {
    console.warn(
      "[Production V3 MQTT] Unmatched admin ACK:",
      requestId
    );
    return;
  }

  await ProductionCommand.updateOne(
    { _id: command._id },
    {
      $set: {
        status: newStatus,
        acknowledgement: message,
        acknowledgedAt: new Date(),
      },
    }
  );

  if (command.action === "relayStop") {
  await ProductionCommand.updateOne(
    {
      serialNumber,
      action: "relayStart",
      status: "accepted",
    },
    {
      $set: {
        status: "completed",
        acknowledgedAt: new Date(),
        metadata: {
          stoppedByRequestId: requestId,
        },
      },
    }
  );
}

  // When a stopFastTelemetry command confirms the stream is off,
  // close the preceding start command as well.
  if (
    command.action === "stopFastTelemetry" &&
    message.fastTelemetryActive === false
  ) {
    await ProductionCommand.updateOne(
      {
        serialNumber,
        action: "startFastTelemetry",
        status: { $in: ["accepted", "published"] },
      },
      {
        $set: {
          status: "completed",
          acknowledgedAt: new Date(),
          metadata: {
            stoppedByRequestId: requestId,
          },
        },
      }
    );
  }
}


// ==================================================
// INCOMING: CONFIG ACK
// viz/<SERIAL>/configAck
// ==================================================
async function handleConfigAck(parts, message) {
  const topicSerial = normalizeSerial(parts[1]);

  const serialNumber = normalizeSerial(
    message.serialNumber || parts[1]
  );

  if (!topicSerial || serialNumber !== topicSerial) {
    console.warn(
      "[Production V3 MQTT] Config ACK serial mismatch."
    );
    return;
  }

  const ackStatus = String(
    message.status || ""
  ).toLowerCase();

  if (!["ok", "error"].includes(ackStatus)) {
    return;
  }

  const nvsVersion = Number(message.nvsVersion);

  if (
    !Number.isSafeInteger(nvsVersion) ||
    nvsVersion < 0
  ) {
    console.warn(
      "[Production V3 MQTT] Invalid config ACK version."
    );
    return;
  }

  // Match setConfig strictly by the requested NVS version.
  const configCommand = await ProductionCommand.findOne({
    serialNumber,
    action: "setConfig",
    "metadata.nvsVersion": nvsVersion,
    status: { $in: PENDING_COMMAND_STATUSES },
  });

  // setCalibration does not increment NVS version.
  // Its expected version is the currently applied configuration.
  const calibrationCommand = await ProductionCommand.findOne({
    serialNumber,
    action: "setCalibration",
    "metadata.expectedNvsVersion": nvsVersion,
    status: { $in: PENDING_COMMAND_STATUSES },
  });

  if (configCommand && calibrationCommand) {
    console.error(
      "[Production V3 MQTT] Ambiguous config ACK:",
      serialNumber,
      nvsVersion
    );
    return;
  }

  const command = configCommand || calibrationCommand;

  if (!command) {
    console.warn(
      "[Production V3 MQTT] No matching config command:",
      serialNumber,
      nvsVersion
    );
    return;
  }

  const ackMessage = String(message.message || "");

  // Firmware reports an "ok" for an older/duplicate setConfig
  // without actually applying the requested configuration.
  const duplicateIgnored =
    command.action === "setConfig" &&
    /older or duplicate configuration ignored/i.test(
      ackMessage
    );

  const success =
    ackStatus === "ok" && !duplicateIgnored;

  await ProductionCommand.updateOne(
    { _id: command._id },
    {
      $set: {
        status: success ? "accepted" : "failed",
        acknowledgement: message,
        acknowledgedAt: new Date(),
      },
    }
  );

  const device = await ProductionDevice.findOne({
    serialNumber,
  }).select("+identityHistory");

  if (!device) return;

  const now = new Date();

  if (command.action === "setConfig") {
    const operation = command.metadata?.operation;

    device.provisioning.status =
      success ? "acknowledged" : "failed";

    device.provisioning.acknowledgedAt = now;

    device.provisioning.lastError =
      success
        ? null
        : ackMessage || "Device rejected configuration.";

    if (success) {
      device.provisioning.appliedConfigVersion =
        nvsVersion;

      const acknowledgedDeviceId =
        normalizeDeviceId(message.deviceId) ||
        normalizeDeviceId(command.payload?.deviceId);

      if (operation === "identity_change") {
        const oldDeviceId =
          command.metadata?.oldDeviceId || null;

        const newDeviceId =
          acknowledgedDeviceId;

        const requestedDeviceId =
          command.metadata?.requestedDeviceId ||
          newDeviceId;

        device.identityHistory.push({
          oldDeviceId,
          newDeviceId: requestedDeviceId,
          requestId: command.requestId,
          status: "acknowledged",
          requestedBy: command.createdBy || "admin",
          acknowledgedAt: now,
          deviceMessage: ackMessage || null,
        });

        if (newDeviceId) {
          device.deviceId = newDeviceId;
        }
      } else {
        if (acknowledgedDeviceId) {
          device.deviceId = acknowledgedDeviceId;
        }

        if (
          operation === "promotion" ||
          operation === "retry"
        ) {
          device.manufacturingStatus =
            "calibration_required";

          device.calibration.status =
            "calibration_required";
        }
      }
    }
  }

if (command.action === "setCalibration") {
  device.calibration.status =
    success ? "calibrating" : "failed";

  if (success) {
    device.manufacturingStatus = "calibrating";
  } else {
    device.manufacturingStatus = "calibration_failed";
    device.calibration.lastFailedAt = now;
    device.calibration.lastFailureReason =
      ackMessage || "Firmware rejected calibration.";
  }
}

device.updatedBy =
  command.createdBy || device.updatedBy;

await device.save();

// Update the linked calibration session when the firmware
// acknowledges setCalibration.
if (command.action === "setCalibration") {
  const calibrationSession = await CalibrationSession.findOne({
    serialNumber,
    applyRequestId: command.requestId,
    status: "applying",
  });

  if (calibrationSession) {
    calibrationSession.status = success
      ? "awaiting_verification"
      : "failed";

    calibrationSession.appliedAt = success ? now : null;

    calibrationSession.lastError = success
      ? null
      : ackMessage || "Firmware rejected calibration.";

    if (!success) {
      calibrationSession.completedAt = now;
    }

    await calibrationSession.save();
  }
}

// Batch summary should reflect the new device lifecycle state.
await refreshBatchCountsForDevice(serialNumber);
}


// ==================================================
// INCOMING: TELEMETRY
// viz/<DEVICE_ID>/Telemetry
// ==================================================

async function handleTelemetry(parts, message) {
  const deviceId = normalizeDeviceId(parts[1]);

  if (!deviceId) return;

  const device = await ProductionDevice.findOne({
    deviceId,
  }).select("_id serialNumber");

  if (!device) {
    // Do not auto-create unknown devices from telemetry.
    return;
  }

  const now = new Date();

  await ProductionDevice.updateOne(
    { _id: device._id },
    {
      $set: {
        "discovery.lastSeenAt": now,
        "discovery.isOnline": true,
        "discovery.firmwareVersion": message.fwVersion || undefined,
        firmwareVersion: message.fwVersion || undefined,
      },
    }
  );

  if (message.telemetryMode !== "fast") return;

  const telemetryRequestId =
    String(message.telemetryRequestId || "").trim();

  const telemetrySequence =
    Number(message.telemetrySequence);

  if (
    !telemetryRequestId ||
    !Number.isSafeInteger(telemetrySequence) ||
    telemetrySequence < 0
  ) {
    return;
  }

  const sample = {
    serialNumber: device.serialNumber,
    deviceId,
    telemetryRequestId,
    telemetrySequence,
    capturedAt: now,
    telemetryMode: "fast",

    voltage: Number.isFinite(Number(message.voltage))
      ? Number(message.voltage) : null,

    current: Number.isFinite(Number(message.current))
      ? Number(message.current) : null,

    power: Number.isFinite(Number(message.power))
      ? Number(message.power) : null,

    totalEnergyKwh: Number.isFinite(Number(message.totalEnergy_kWh))
      ? Number(message.totalEnergy_kWh) : null,

    relayState: message.relay || null,
    relayCommanded:
      typeof message.relayCommanded === "boolean"
        ? message.relayCommanded : null,

    deviceState: message.state || null,
    sessionId: message.sessionId || null,
    sessionActive: Boolean(message.sessionActive),
    adminRelayTest: Boolean(message.adminRelayTest),

    sampleAgeMs: Number.isFinite(Number(message.sampleAgeMs))
      ? Number(message.sampleAgeMs) : null,

    sampleFresh: Boolean(message.sampleFresh),

    rawVoltageRatio: Number.isFinite(Number(message.rawVoltageRatio))
      ? Number(message.rawVoltageRatio) : null,

    rawCurrentRatio: Number.isFinite(Number(message.rawCurrentRatio))
      ? Number(message.rawCurrentRatio) : null,

    rawPowerRatio: Number.isFinite(Number(message.rawPowerRatio))
      ? Number(message.rawPowerRatio) : null,

    calibrationMode: message.calibrationMode || null,

    vf: Number.isFinite(Number(message.vf))
      ? Number(message.vf) : null,

    currentZero: Number.isFinite(Number(message.currentZero))
      ? Number(message.currentZero) : null,

    currentGain: Number.isFinite(Number(message.currentGain))
      ? Number(message.currentGain) : null,

    powerZero: Number.isFinite(Number(message.powerZero))
      ? Number(message.powerZero) : null,

    powerGain: Number.isFinite(Number(message.powerGain))
      ? Number(message.powerGain) : null,

    rawPayload: message,
  };

  try {
    await ProductionTelemetry.updateOne(
      {
        serialNumber: device.serialNumber,
        telemetryRequestId,
        telemetrySequence,
      },
      {
        $setOnInsert: sample,
      },
      {
        upsert: true,
      }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
}


// ==================================================
// MQTT ROUTER
// ==================================================

async function handleIncomingMessage(topic, buffer) {
  const parts = topic.split("/");

  if (
    parts.length !== 3 ||
    parts[0] !== "viz"
  ) {
    return;
  }

  let message;

  try {
    message = JSON.parse(buffer.toString());
  } catch {
    return;
  }

  if (!message || typeof message !== "object") return;

  try {
    if (parts[2] === "status") {
      await handleDiscovery(parts, message);
      return;
    }

    if (parts[2] === "adminAck") {
      await handleAdminAck(parts, message);
      return;
    }

    if (parts[2] === "configAck") {
      await handleConfigAck(parts, message);
      return;
    }

    if (parts[2] === "Telemetry") {
      await handleTelemetry(parts, message);
    }
  } catch (error) {
    console.error(
      "[Production V3 MQTT] Message handling failed:",
      topic,
      error
    );
  }
}

function startProductionV3MqttSubscriber() {
  if (started) return;
  started = true;

  const topics = [
    "viz/+/status",
    "viz/+/adminAck",
    "viz/+/configAck",
    "viz/+/Telemetry",
  ];

  mqttClient.on("connect", () => {
    mqttClient.subscribe(topics, { qos: 1 }, (error) => {
      if (error) {
        console.error(
          "[Production V3 MQTT] Subscribe failed:",
          error.message
        );
      } else {
        console.log(
          "[Production V3 MQTT] Subscribed:",
          topics
        );
      }
    });
  });

  mqttClient.on("message", (topic, buffer) => {
    // Do not block the legacy subscriber's event callback.
    handleIncomingMessage(topic, buffer).catch((error) => {
      console.error("[Production V3 MQTT] Handler error:", error);
    });
  });

  if (!offlineSweepStarted) {
    offlineSweepStarted = true;

    const timer = setInterval(async () => {
      try {
        const cutoff = new Date(Date.now() - 90 * 1000);

        await ProductionDevice.updateMany(
          {
            "discovery.isOnline": true,
            "discovery.lastSeenAt": { $lt: cutoff },
          },
          {
            $set: {
              "discovery.isOnline": false,
            },
          }
        );
      } catch (error) {
        console.error(
          "[Production V3 MQTT] Offline sweep failed:",
          error.message
        );
      }
    }, 30000);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }
}

module.exports = {
  createRequestId,
  publishTrackedCommand,
  publishAdminCommand,
  publishConfigCommand,
  startProductionV3MqttSubscriber,
};