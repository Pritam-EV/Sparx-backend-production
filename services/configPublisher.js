// services/configPublisher.js
const mqttClient      = require('../mqttClient');
const DeviceProvision = require('../models/DeviceProvision');
const Device          = require('../models/device');

// Builds topic for config push based on serialNumber.
// Firmware expects viz/<SERIAL_NUMBER>/config for provisioning.
function buildConfigTopicFromSerial(serialNumber) {
  return `viz/${serialNumber.toUpperCase()}/config`;
}

// Publish config for a DeviceProvision document (Group B / dispatch config).
async function publishProvisionConfig(provisionId) {
  const provision = await DeviceProvision.findById(provisionId).lean();
  if (!provision) {
    throw new Error(`DeviceProvision ${provisionId} not found`);
  }
  if (!provision.serialNumber || !provision.deviceId) {
    throw new Error(`Provision ${provisionId} missing serialNumber or deviceId`);
  }

  const nextNvsVersion = (provision.nvsVersion || 0) + 1;

  const topic = buildConfigTopicFromSerial(provision.serialNumber);
  const payload = {
    serialNumber:  provision.serialNumber,
    device_id:     provision.deviceId,
    cf:            provision.cf,
    vf:            provision.vf,
    currentRF:     provision.currentRF,
    wifiSSID:      provision.wifiSSID,
    wifiPassword:  provision.wifiPassword,
    location:      provision.location,
    lat:           provision.lat,
    lng:           provision.lng,
    area:          provision.area,
    city:          provision.city,
    state:         provision.state,
    meterType:     provision.meterType,
    meterConsumerNumber: provision.meterConsumerNumber,
    rate:          provision.rate,
    commercial:    provision.commercial,
    targetFirmwareVersion: provision.targetFirmwareVersion,
    nvsVersion:    nextNvsVersion,
  };

  return new Promise((resolve, reject) => {
    mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 }, async (err) => {
      if (err) {
        return reject(err);
      }

      try {
        await DeviceProvision.updateOne(
          { _id: provisionId },
          {
            $set: {
              provisionStatus: 'sent',
              lastProvisionSentAt: new Date(),
              'configAck.status': 'pending',
              'configAck.ackedAt': null,
              'configAck.message': null,
              'configAck.fwVersion': null,
              'configAck.nvsVersion': nextNvsVersion,
              nvsVersion: nextNvsVersion,
            },
          }
        );
      } catch (dbErr) {
        return reject(dbErr);
      }

      resolve();
    });
  });
}

// Publish config for a live Device document (Group C / runtime changes).
async function publishDeviceConfig(deviceId) {
  const device = await Device.findOne({ device_id: deviceId.toUpperCase() }).lean();
  if (!device) {
    throw new Error(`Device ${deviceId} not found`);
  }
  if (!device.serialNumber) {
    throw new Error(`Device ${deviceId} missing serialNumber`);
  }

  const nextNvsVersion = (device.nvsVersion || 0) + 1;

  const topic = buildConfigTopicFromSerial(device.serialNumber);
  const payload = {
    serialNumber:  device.serialNumber,
    device_id:     device.device_id,
    cf:            device.cf,
    vf:            device.vf,
    currentRF:     device.currentRF,
    wifiSSID:      device.wifiSSID,
    wifiPassword:  device.wifiPassword,
    location:      device.location,
    lat:           device.lat,
    lng:           device.lng,
    area:          device.area,
    city:          device.city,
    state:         device.state,
    meterType:     device.meterType,
    meterConsumerNumber: device.meterConsumerNumber,
    rate:          device.rate,
    commercial:    device.commercial,
    targetFirmwareVersion: device.targetFirmwareVersion,
    nvsVersion:    nextNvsVersion,
  };

  return new Promise((resolve, reject) => {
    mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 }, async (err) => {
      if (err) {
        return reject(err);
      }

      try {
        await Device.updateOne(
          { device_id: device.device_id },
          {
            $set: {
              'configAck.status': 'pending',
              'configAck.ackedAt': null,
              'configAck.message': null,
              'configAck.fwVersion': null,
              'configAck.nvsVersion': nextNvsVersion,
              nvsVersion: nextNvsVersion,
            },
          }
        );
      } catch (dbErr) {
        return reject(dbErr);
      }

      resolve();
    });
  });
}

module.exports = {
  publishProvisionConfig,
  publishDeviceConfig,
};