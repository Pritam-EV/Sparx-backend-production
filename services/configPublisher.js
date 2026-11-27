
const mqttClient = require("../mqttClient");

const DeviceProvision = require("../models/DeviceProvision");
const Device = require("../models/device");
const crypto = require("crypto");
const {
  CONFIG_ACTION,
  CONFIG_SCHEMA_VERSION,
  CONFIG_ACK_STATUS,
  PROVISION_STATUS,
  buildConfigTopic,
  normalizeDeviceId,
} = require("../config/deviceProtocol");

function publishAsync(topic, payload) {
  return new Promise((resolve, reject) => {
    if (!mqttClient.connected) {
      return reject(new Error("MQTT broker is not connected"));
    }

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

function buildFirmwareConfig({
  serialNumber,
  deviceId,
  cf,
  vf,
  currentRF,
  wifiSSID,
  wifiPassword,
  nvsVersion,
  requestId,
}) {
  return {
    action: CONFIG_ACTION,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    requestId: requestId || null,

    serialNumber,
    deviceId: normalizeDeviceId(deviceId),

    cf,
    vf,
    currentRF,

    ssid: wifiSSID || "",
    password: wifiPassword || "",

    nvsVersion,
  };
}

async function publishProvisionConfig(provisionId, options = {}) {
  const provision = await DeviceProvision.findById(provisionId);

  if (!provision) {
    throw new Error("DeviceProvision not found");
  }

  if (!provision.serialNumber || !provision.deviceId) {
    throw new Error("Provision requires serialNumber and deviceId");
  }

const requestId = options.requestId || crypto.randomUUID();
  const nextNvsVersion = Number(provision.nvsVersion || 0) + 1;

  const payload = buildFirmwareConfig({
    serialNumber: provision.serialNumber,
    deviceId: provision.deviceId,
    cf: provision.cf,
    vf: provision.vf,
    currentRF: provision.currentRF,
    wifiSSID: provision.wifiSSID,
    wifiPassword: provision.wifiPassword,
    nvsVersion: nextNvsVersion,
    requestId,
  });

  const topic = buildConfigTopic(provision.serialNumber);

  // Persist pending request before publishing, so a fast ACK can be matched.
  provision.nvsVersion = nextNvsVersion;
  provision.provisionStatus = PROVISION_STATUS.SENT;
  provision.lastProvisionSentAt = new Date();
  provision.configAck = {
    status: CONFIG_ACK_STATUS.PENDING,
    action: CONFIG_ACTION,
    requestId,
    ackedAt: null,
    message: null,
    fwVersion: null,
    nvsVersion: nextNvsVersion,
  };

await provision.save();

try {
  await publishAsync(topic, payload);
} catch (error) {
  provision.provisionStatus = PROVISION_STATUS.FAILED;

  provision.configAck.status = CONFIG_ACK_STATUS.ERROR;
  provision.configAck.message = String(
    error.message || "MQTT publish failed"
  ).slice(0, 500);


  await provision.save();

  throw error;
}

return {
  topic,
  payload,
  requestId,
  nvsVersion: nextNvsVersion,
};
}

async function publishDeviceConfig(deviceId, options = {}) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);

  const device = await Device.findOne({
    device_id: normalizedDeviceId,
  });

  if (!device) {
    throw new Error(`Device ${normalizedDeviceId} not found`);
  }

  if (!device.serialNumber) {
    throw new Error(`Device ${normalizedDeviceId} has no serialNumber`);
  }

  const requestId = options.requestId || crypto.randomUUID();
  const nextNvsVersion = Number(device.nvsVersion || 0) + 1;

  const payload = buildFirmwareConfig({
    serialNumber: device.serialNumber,
    deviceId: device.device_id,
    cf: device.cf,
    vf: device.vf,
    currentRF: device.currentRF,
    wifiSSID: device.wifiSSID,
    wifiPassword: device.wifiPassword,
    nvsVersion: nextNvsVersion,
    requestId,
  });

  const topic = buildConfigTopic(device.serialNumber);

  // Persist pending request before publishing, so a fast ACK can be matched.
  device.nvsVersion = nextNvsVersion;
  device.configAck = {
    status: CONFIG_ACK_STATUS.PENDING,
    action: CONFIG_ACTION,
    requestId,
    ackedAt: null,
    message: null,
    fwVersion: null,
    nvsVersion: nextNvsVersion,
  };

await device.save();

try {
  await publishAsync(topic, payload);
} catch (error) {
  device.configAck.status = CONFIG_ACK_STATUS.ERROR;

  device.configAck.message = String(
    error.message || "MQTT publish failed"
  ).slice(0, 500);


  await device.save();

  throw error;
}

return {
  topic,
  payload,
  requestId,
  nvsVersion: nextNvsVersion,
};
}

module.exports = {
  buildFirmwareConfig,
  publishProvisionConfig,
  publishDeviceConfig,
};
