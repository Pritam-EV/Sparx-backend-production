
// services/productionV3Provisioning.service.js

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
      { qos: 1, retain: false },
      (error) => {
        if (error) return reject(error);
        resolve();
      }
    );
  });
}

// --------------------------------------------------
// GROUP B: Provision Wi-Fi + Device ID
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

  const topic = buildConfigTopic(serial);

  const payload = {
    action: CONFIG_ACTION,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    requestId,
    serialNumber: serial,
    deviceId: normalizedDeviceId,
    ssid: wifiSSID,
    password: wifiPassword,
    nvsVersion: Number(nvsVersion),
  };

  await publishAsync(topic, payload);

  // Never log or return the Wi-Fi credentials.
  return {
    topic,
    requestId,
    nvsVersion: Number(nvsVersion),
  };
}

// --------------------------------------------------
// CALIBRATION: Send five calculated coefficients
// Topic: viz/<SERIAL>/config
// --------------------------------------------------

async function publishCalibration({
  serialNumber,
  requestId,
  coefficients,
}) {
  const serial = normalizeSerialNumber(serialNumber).toUpperCase();

  if (!serial || !requestId) {
    throw new Error("Serial number and request ID are required.");
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
      throw new Error(`Invalid calibration coefficient: ${key}`);
    }

    payload[key] = value;
  }

  const topic = buildConfigTopic(serial);

  await publishAsync(topic, payload);

  return { topic, requestId };
}

// --------------------------------------------------
// DEVICE CONTROLS
// Topic: viz/<DEVICE_ID>/admincmd
// --------------------------------------------------

async function publishProductionCommand({
  deviceId,
  action,
}) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);

  const allowedActions = [
    "relayStart",
    "relayStop",
    "startFastTelemetry",
    "stopFastTelemetry",
  ];

  if (!allowedActions.includes(action)) {
    throw new Error("Unsupported production device command.");
  }

  if (!normalizedDeviceId) {
    throw new Error("Valid Device ID is required.");
  }

  const requestId = require("crypto").randomUUID();

  const topic = `viz/${normalizedDeviceId}/admincmd`;

  await publishAsync(topic, {
    action,
    requestId,
  });

  return {
    topic,
    requestId,
    action,
  };
}

// --------------------------------------------------
// INCOMING PRODUCTION CONFIG ACK
// Called by mqttSubscriber.js
// --------------------------------------------------

async function handleProductionConfigAck({
  serialNumber,
  ack,
}) {
  const serial = normalizeSerialNumber(serialNumber).toUpperCase();

  if (!serial) {
    return { matched: false, reason: "missing_serial" };
  }

  const device = await ProductionDevice.findOne({
    serialNumber: serial,
  });

  if (!device) {
    return { matched: false, reason: "device_not_found" };
  }

  const requestId = String(ack?.requestId || "").trim();

  const status = String(
    ack?.status || ""
  ).toLowerCase();

  // The production record matched. Never send its ACK through
  // the legacy Device/DeviceProvision ACK update path.
  if (!requestId) {
    return { matched: true, reason: "missing_request_id" };
  }

  if (
    ![
      CONFIG_ACK_STATUS.OK,
      CONFIG_ACK_STATUS.ERROR,
    ].includes(status)
  ) {
    return { matched: true, reason: "invalid_status" };
  }

  const now = new Date();

  const wasIgnored = /older or duplicate configuration ignored/i.test(
    String(ack.message || "")
  );

  const successful =
    status === CONFIG_ACK_STATUS.OK && !wasIgnored;

  // GROUP B ACK
  const expectedProvisionAck = device.groupB?.configAck || {};

  if (
    requestId &&
    requestId === expectedProvisionAck.requestId
  ) {
    const expectedNvsVersion = Number(expectedProvisionAck.nvsVersion);

    if (
      ack.nvsVersion !== undefined &&
      ack.nvsVersion !== null &&
      Number(ack.nvsVersion) !== expectedNvsVersion
    ) {
      return { matched: true, reason: "stale_nvs_version" };
    }

    // Ignore duplicate successful provisioning ACKs.
// Do not move a device backwards from Calibration/Dispatch.
if (
  expectedProvisionAck.status === CONFIG_ACK_STATUS.OK &&
  device.groupB.provisionStatus ===
    ProductionDevice.PROVISION_STATUS.ACKNOWLEDGED
) {
  return {
    matched: true,
    reason: "duplicate_provision_ack",
  };
}

    device.groupB.provisionStatus = successful
      ? ProductionDevice.PROVISION_STATUS.ACKNOWLEDGED
      : ProductionDevice.PROVISION_STATUS.FAILED;

    device.groupB.configAck = {
      status,
      action: CONFIG_ACTION,
      requestId,
      message: ack.message || null,
      fwVersion: ack.fwVersion || null,
      nvsVersion: expectedNvsVersion,
      receivedAt: now,
    };

    device.groupB.lastError = successful
      ? null
      : String(
          ack.message ||
          (wasIgnored
            ? "Device ignored an older or duplicate configuration."
            : "Device rejected provisioning configuration.")
        );

    if (ack.fwVersion) {
      device.groupB.lastKnownFirmwareVersion = String(ack.fwVersion);
    }

    if (successful) {
      device.stage = ProductionDevice.STAGE.CALIBRATION;
      device.stageUpdatedAt = now;
    }

    device.updatedBy = "mqtt";
    await device.save();

    return {
      matched: true,
      operation: "setConfig",
      successful,
      serialNumber: serial,
    };
  }

  // CALIBRATION ACK
  if (requestId === device.calibration?.requestId) {
    device.calibration.acknowledgement = {
      status,
      action: "setCalibration",
      requestId,
      message: ack.message || null,
      fwVersion: ack.fwVersion || null,
      nvsVersion:
        ack.nvsVersion !== undefined && ack.nvsVersion !== null
          ? Number(ack.nvsVersion)
          : null,
      receivedAt: now,
    };

    if (successful) {
      device.calibration.status =
        ProductionDevice.CALIBRATION_STATUS.APPLIED;

      device.calibration.appliedAt = now;
      device.calibration.lastError = null;
    } else {
      device.calibration.status =
        ProductionDevice.CALIBRATION_STATUS.FAILED;

      device.calibration.lastError =
        ack.message || "Firmware rejected calibration.";
    }

    if (ack.fwVersion) {
      device.groupB.lastKnownFirmwareVersion = String(ack.fwVersion);
    }

    device.updatedBy = "mqtt";
    await device.save();

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

module.exports = {
  publishGroupBProvisionConfig,
  publishCalibration,
  publishProductionCommand,
  handleProductionConfigAck,
};
