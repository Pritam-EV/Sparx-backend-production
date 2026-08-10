// config/deviceProtocol.js

const MANUFACTURING_STATUS = Object.freeze({
  GROUP_A: 'group_a',
  GROUP_B: 'group_b',
  DISPATCHED: 'dispatched',
  LIVE: 'live',
});

const PROVISION_STATUS = Object.freeze({
  PENDING: 'pending',
  SENT: 'sent',
  ACKNOWLEDGED: 'acknowledged',
  FAILED: 'failed',
});

const CONFIG_ACK_STATUS = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
  PENDING: 'pending',
});

const CONFIG_ACTION = 'setConfig';
const CONFIG_ACK_ACTION = 'configAck';
const CONFIG_SCHEMA_VERSION = 1;

function normalizeDeviceId(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeSerialNumber(value) {
  return String(value || '').trim();
}

function buildConfigTopic(serialNumber) {
  return `viz/${normalizeSerialNumber(serialNumber)}/config`;
}

function buildConfigAckTopic(serialNumber) {
  return `viz/${normalizeSerialNumber(serialNumber)}/configAck`;
}

function buildTelemetryTopic(deviceId) {
  return `viz/${normalizeDeviceId(deviceId)}/Telemetry`;
}

module.exports = {
  MANUFACTURING_STATUS,
  PROVISION_STATUS,
  CONFIG_ACK_STATUS,
  CONFIG_ACTION,
  CONFIG_ACK_ACTION,
  CONFIG_SCHEMA_VERSION,
  normalizeDeviceId,
  normalizeSerialNumber,
  buildConfigTopic,
  buildConfigAckTopic,
  buildTelemetryTopic,
};