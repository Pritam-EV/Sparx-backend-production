const crypto = require("crypto");
const Device = require("../models/device");
const DeviceTelemetry = require("../models/deviceTelemetry");
const DeviceCalibration = require("../models/DeviceCalibration");
const {
  normalizeDeviceId,
} = require("../config/deviceProtocol");
const {
  publishDeviceConfig,
} = require("./configPublisher");

const TELEMETRY_MAX_AGE_MS = 5 * 600 * 1000;
const LIVE_VALUE_TOLERANCE = 5;

function finitePositive(value, fieldName) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    const error = new Error(
      `${fieldName} must be a positive number`
    );

    error.statusCode = 400;
    throw error;
  }

  return number;
}

function createRequestId() {
  return `cal-${Date.now()}-${crypto
    .randomBytes(6)
    .toString("hex")}`;
}

function calculateCalibration({
  oldCf,
  oldVf,
  liveVoltage,
  liveCurrent,
  referenceVoltage,
  referenceCurrent,
}) {
  const newVf =
    oldVf * (referenceVoltage / liveVoltage);

  const newCf =
    oldCf * (referenceCurrent / liveCurrent);

  if (
    !Number.isFinite(newVf) ||
    !Number.isFinite(newCf) ||
    newVf <= 0 ||
    newCf <= 0
  ) {
    const error = new Error(
      "Calculated calibration values are invalid"
    );

    error.statusCode = 400;
    throw error;
  }

  return {
    newCf,
    newVf,
  };
}

async function createCalibration({
  deviceId: rawDeviceId,
  referenceVoltage: rawReferenceVoltage,
  referenceCurrent: rawReferenceCurrent,
  liveVoltage: rawLiveVoltage,
  liveCurrent: rawLiveCurrent,
  expectedNvsVersion,
  createdBy,
}) {
  const deviceId = normalizeDeviceId(rawDeviceId);

  if (!deviceId) {
    const error = new Error("Device ID is required");
    error.statusCode = 400;
    throw error;
  }

  const referenceVoltage = finitePositive(
    rawReferenceVoltage,
    "referenceVoltage"
  );

  const referenceCurrent = finitePositive(
    rawReferenceCurrent,
    "referenceCurrent"
  );

  const submittedLiveVoltage = finitePositive(
    rawLiveVoltage,
    "liveVoltage"
  );

  const submittedLiveCurrent = finitePositive(
    rawLiveCurrent,
    "liveCurrent"
  );

  const device = await Device.findOne({
    device_id: deviceId,
  });

  if (!device) {
    const error = new Error("Device not found");
    error.statusCode = 404;
    throw error;
  }

  const oldCf = finitePositive(device.cf, "device.cf");
  const oldVf = finitePositive(device.vf, "device.vf");

  const currentNvsVersion = Number(
    device.nvsVersion || 0
  );

  if (
    expectedNvsVersion !== undefined &&
    Number(expectedNvsVersion) !== currentNvsVersion
  ) {
    const error = new Error(
      "Device configuration changed. Reload the device before calibrating."
    );

    error.statusCode = 409;
    throw error;
  }

  const latestTelemetry =
    await DeviceTelemetry.findOne(
      { deviceId },
      {
        _id: 0,
        voltage: 1,
        current: 1,
        timestamp: 1,
      }
    )
      .sort({ timestamp: -1 })
      .lean();

  if (!latestTelemetry) {
    const error = new Error(
      "No telemetry found for this device"
    );

    error.statusCode = 409;
    throw error;
  }

  const telemetryTimestamp = new Date(
    latestTelemetry.timestamp
  ).getTime();

if (
  !Number.isFinite(telemetryTimestamp) ||
  Date.now() - telemetryTimestamp >
    TELEMETRY_MAX_AGE_MS
) {
  const error = new Error(
    "Device telemetry is older than 5 minutes. Refresh before calibrating."
  );

  error.statusCode = 409;
  throw error;
}

  const latestVoltage = finitePositive(
    latestTelemetry.voltage,
    "latest telemetry voltage"
  );

  const latestCurrent = finitePositive(
    latestTelemetry.current,
    "latest telemetry current"
  );

  const voltageDifference =
    Math.abs(
      latestVoltage - submittedLiveVoltage
    ) / latestVoltage;

  const currentDifference =
    Math.abs(
      latestCurrent - submittedLiveCurrent
    ) / latestCurrent;

if (
  voltageDifference >
  LIVE_VALUE_TOLERANCE
) {
  const error = new Error(
    "Submitted live voltage differs more than 500% from latest device telemetry"
  );

  error.statusCode = 409;
  throw error;
}

if (
  currentDifference >
  LIVE_VALUE_TOLERANCE
) {
  const error = new Error(
    "Submitted live current differs more than 500% from latest device telemetry"
  );

  error.statusCode = 409;
  throw error;
}

  const { newCf, newVf } =
    calculateCalibration({
      oldCf,
      oldVf,
      liveVoltage: latestVoltage,
      liveCurrent: latestCurrent,
      referenceVoltage,
      referenceCurrent,
    });

  const requestId = createRequestId();
  const nextNvsVersion = currentNvsVersion + 1;

  const calibration =
    await DeviceCalibration.create({
      requestId,
      deviceId,
      serialNumber: device.serialNumber,
      oldCf,
      oldVf,
      liveVoltage: latestVoltage,
      liveCurrent: latestCurrent,
      referenceVoltage,
      referenceCurrent,
      newCf,
      newVf,
      expectedNvsVersion: nextNvsVersion,
      status: "pending",
      createdBy: createdBy || null,
    });

  const updatedDevice =
    await Device.findOneAndUpdate(
      {
        _id: device._id,
        nvsVersion: currentNvsVersion,
      },
      {
        $set: {
          cf: newCf,
          vf: newVf,
          nvsVersion: nextNvsVersion,
        },
      },
      {
        new: true,
      }
    );

  if (!updatedDevice) {
    await DeviceCalibration.updateOne(
      { _id: calibration._id },
      {
        $set: {
          status: "rejected",
        },
      }
    );

    const error = new Error(
      "Device configuration changed during calibration. Retry after reloading."
    );

    error.statusCode = 409;
    throw error;
  }

  try {
    const publishResult =
      await publishDeviceConfig(deviceId);

    await DeviceCalibration.updateOne(
      { _id: calibration._id },
      {
        $set: {
          status: "published",
          publishedAt: new Date(),
        },
      }
    );

    return {
      requestId,
      deviceId,
      serialNumber: device.serialNumber,
      oldCf,
      oldVf,
      newCf,
      newVf,
      nvsVersion: nextNvsVersion,
      topic: publishResult.topic,
      status: "published",
    };
  } catch (error) {
    await DeviceCalibration.updateOne(
      { _id: calibration._id },
      {
        $set: {
          status: "publish_failed",
        },
      }
    );

    error.statusCode = 502;
    throw error;
  }
}

module.exports = {
  createCalibration,
  calculateCalibration,
};