
// services/productionTelemetryCache.js

const latestTelemetry = new Map();

function normalizeSerial(value) {
  return String(value || "").trim().toUpperCase();
}

function setLatestProductionTelemetry(sample) {
  const serialNumber = normalizeSerial(sample.serialNumber);

  if (!serialNumber) return;

  latestTelemetry.set(serialNumber, {
    ...sample,
    serialNumber,
    receivedAt: new Date(sample.receivedAt || Date.now()),
  });
}

function getLatestProductionTelemetry(serialNumber) {
  const serial = normalizeSerial(serialNumber);
  const sample = latestTelemetry.get(serial);

  if (!sample) return null;

  const ageMs = Math.max(
    0,
    Date.now() - new Date(sample.receivedAt).getTime()
  );

  return {
    ...sample,
    ageMs,
  };
}

module.exports = {
  setLatestProductionTelemetry,
  getLatestProductionTelemetry,
};
