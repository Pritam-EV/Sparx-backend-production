// services/productionV3Provisioning.service.js
// Group B provisioning publisher and ACK handler.
// Uses the existing shared MQTT connection.

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
    return Promise.reject(new Error("MQTT broker is not connected"));
  }

  return new Promise((resolve, reject) => {
    mqttClient.publish(
      topic,
      JSON.stringify(payload),
      { qos: 1, retain: false },
      (error) => {
        if (error) return reject(error);
        return resolve();
      }
    );
  });
}

async function publishGroupBProvisionConfig({
  serialNumber,
  deviceId,
  wifiSSID,
  wifiPassword,
  requestId,
  nvsVersion,
}) {
  const serial = normalizeSerialNumber(serialNumber);
  const normalizedDeviceId = normalizeDeviceId(deviceId);

  if (!serial || !normalizedDeviceId || !requestId) {
    throw new Error(
      "serialNumber, deviceId and requestId are required for provisioning"
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

  // Do not log or return payload: it contains Wi-Fi credentials.
  return {
    topic,
    requestId,
    nvsVersion: Number(nvsVersion),
  };
}

/**
 * Called by mqttSubscriber.js when viz/<serialNumber>/configAck arrives.
 * requestId and nvsVersion are used to reject stale ACKs when supplied.
 */
async function handleGroupBConfigAck({ serialNumber, ack }) {
  const serial = normalizeSerialNumber(serialNumber).toUpperCase();
  const status = String(ack?.status || "").toLowerCase();

  if (
    !serial ||
    ![CONFIG_ACK_STATUS.OK, CONFIG_ACK_STATUS.ERROR].includes(status)
  ) {
    return { matched: false, reason: "invalid_ack" };
  }

  const device = await ProductionDevice.findOne({
    serialNumber: serial,
    stage: ProductionDevice.STAGE.GROUP_B,
  });

  if (!device) {
    return { matched: false, reason: "device_not_found" };
  }

  const expected = device.groupB?.configAck || {};

  if (
    ack.requestId &&
    expected.requestId &&
    String(ack.requestId) !== String(expected.requestId)
  ) {
    return { matched: false, reason: "stale_request_id" };
  }

  if (
    ack.nvsVersion !== undefined &&
    ack.nvsVersion !== null &&
    expected.nvsVersion !== undefined &&
    expected.nvsVersion !== null &&
    Number(ack.nvsVersion) !== Number(expected.nvsVersion)
  ) {
    return { matched: false, reason: "stale_nvs_version" };
  }

  const successful = status === CONFIG_ACK_STATUS.OK;

  device.groupB.provisionStatus = successful
    ? ProductionDevice.PROVISION_STATUS.ACKNOWLEDGED
    : ProductionDevice.PROVISION_STATUS.FAILED;

  device.groupB.configAck = {
    status,
    action: ack.action || CONFIG_ACTION,
    requestId: ack.requestId || expected.requestId || null,
    message: ack.message || null,
    fwVersion: ack.fwVersion || null,
    nvsVersion:
      ack.nvsVersion !== undefined && ack.nvsVersion !== null
        ? Number(ack.nvsVersion)
        : expected.nvsVersion ?? null,
    receivedAt: new Date(),
  };

  device.groupB.lastError = successful
    ? null
    : String(ack.message || "Device rejected provisioning configuration");

  if (ack.fwVersion) {
    device.groupB.lastKnownFirmwareVersion = String(ack.fwVersion);
  }

  device.updatedBy = "mqtt";
  await device.save();

  return {
    matched: true,
    successful,
    serialNumber: serial,
    deviceId: device.groupB.deviceId,
  };
}

module.exports = {
  publishGroupBProvisionConfig,
  handleGroupBConfigAck,
};
