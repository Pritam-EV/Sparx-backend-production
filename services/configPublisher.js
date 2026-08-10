const mqttClient = require('../mqttClient');
const DeviceProvision = require('../models/DeviceProvision');
const Device = require('../models/device');

const {
  CONFIG_ACTION,
  CONFIG_SCHEMA_VERSION,
  CONFIG_ACK_STATUS,
  PROVISION_STATUS,
  buildConfigTopic,
  normalizeDeviceId,
} = require('../config/deviceProtocol');

function publishAsync(topic, payload) {
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

function buildFirmwareConfig({
  serialNumber,
  deviceId,
  cf,
  vf,
  currentRF,
  wifiSSID,
  wifiPassword,
  nvsVersion,
}) {
  return {
    action: CONFIG_ACTION,
    schemaVersion: CONFIG_SCHEMA_VERSION,

    serialNumber,
    deviceId: normalizeDeviceId(deviceId),

    cf,
    vf,
    currentRF,

    // Firmware contract names
    ssid: wifiSSID || '',
    password: wifiPassword || '',

    nvsVersion,
  };
}

async function publishProvisionConfig(provisionId) {
  const provision = await DeviceProvision.findById(provisionId);

  if (!provision) {
    throw new Error('DeviceProvision not found');
  }

  if (!provision.serialNumber || !provision.deviceId) {
    throw new Error(
      'Provision must contain serialNumber and deviceId'
    );
  }

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
  });

  await publishAsync(
    buildConfigTopic(provision.serialNumber),
    payload
  );

  provision.nvsVersion = nextNvsVersion;
  provision.provisionStatus = PROVISION_STATUS.SENT;
  provision.lastProvisionSentAt = new Date();
  provision.configAck = {
    status: CONFIG_ACK_STATUS.PENDING,
    ackedAt: null,
    message: null,
    fwVersion: null,
    nvsVersion: nextNvsVersion,
  };

  await provision.save();

  return {
    topic: buildConfigTopic(provision.serialNumber),
    payload,
    nvsVersion: nextNvsVersion,
  };
}

async function publishDeviceConfig(deviceId) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);

  const device = await Device.findOne({
    device_id: normalizedDeviceId,
  });

  if (!device) {
    throw new Error(`Device ${normalizedDeviceId} not found`);
  }

  if (!device.serialNumber) {
    throw new Error(
      `Device ${normalizedDeviceId} has no serialNumber`
    );
  }

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
  });

  await publishAsync(
    buildConfigTopic(device.serialNumber),
    payload
  );

  device.nvsVersion = nextNvsVersion;
  device.configAck = {
    status: CONFIG_ACK_STATUS.PENDING,
    ackedAt: null,
    message: null,
    fwVersion: null,
    nvsVersion: nextNvsVersion,
  };

  await device.save();

  return {
    topic: buildConfigTopic(device.serialNumber),
    payload,
    nvsVersion: nextNvsVersion,
  };
}

module.exports = {
  buildFirmwareConfig,
  publishProvisionConfig,
  publishDeviceConfig,
};