
const crypto = require("crypto");
const Device = require("../models/device");
const ProductionDevice = require("../models/ProductionDevice");
const DeviceProvision = require("../models/DeviceProvision");
const DeviceMaintenanceLog = require("../models/DeviceMaintenanceLog");
const mqttClient = require("../mqttClient");

const {
  normalizeDeviceId,
  buildConfigTopic,
} = require("../config/deviceProtocol");

const {
  publishCalibration,
  publishProductionCommand,
} = require("./productionV3Provisioning.service");

const {
  publishDeviceConfig,
} = require("./configPublisher");

const {
  publishStartSession,
  publishStopSession,
} = require("./sessionCommandService");

function requestId() {
  return crypto.randomUUID();
}

function actorId(req) {
  return String(req.user?.userId || req.user?.uid || req.user?._id || "admin");
}

function publish(topic, payload) {
  return new Promise((resolve, reject) => {
    if (!mqttClient.connected) {
      return reject(new Error("MQTT broker is disconnected"));
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

async function findDevice(id) {
  const value = String(id || "").trim();

  const device = await Device.findOne({
    $or: [
      { device_id: normalizeDeviceId(value) },
      { serialNumber: value },
      ...(Device.db.base.Types.ObjectId.isValid(value)
        ? [{ _id: value }]
        : []),
    ],
  });

  if (!device) {
    const error = new Error("Device not found");
    error.statusCode = 404;
    throw error;
  }

  const production = await ProductionDevice.findOne({
    serialNumber: device.serialNumber,
    "dispatch.liveDeviceId": device._id,
    "dispatch.status": "completed",
  });

  return {
    device,
    production,
    profile: production ? "v3" : "legacy",
  };
}

function publicDevice(device, profile) {
  const data = device.toObject();

  delete data.wifiPassword;

  return {
    ...data,
    firmwareProfile: profile,
    wifiPasswordConfigured: Boolean(device.wifiPassword),
  };
}

async function log(data) {
  return DeviceMaintenanceLog.create(data);
}

async function listDevices({ search, page = 1, limit = 25 }) {
  const filter = {};

  if (search) {
    const escaped = String(search).trim().replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

    const regex = new RegExp(escaped, "i");

    filter.$or = [
      { device_id: regex },
      { serialNumber: regex },
      { city: regex },
      { project: regex },
    ];
  }

  const currentPage = Math.max(1, Number(page) || 1);
  const pageLimit = Math.min(100, Math.max(1, Number(limit) || 25));

  const [devices, total] = await Promise.all([
    Device.find(filter)
      .sort({ updatedAt: -1 })
      .skip((currentPage - 1) * pageLimit)
      .limit(pageLimit)
      .lean(),

    Device.countDocuments(filter),
  ]);

  const serials = devices.map(d => d.serialNumber);

  const productionRecords = await ProductionDevice.find({
    serialNumber: { $in: serials },
    "dispatch.status": "completed",
  })
    .select("serialNumber dispatch.liveDeviceId")
    .lean();

  const productionBySerial = new Map(
    productionRecords.map(p => [
      p.serialNumber,
      String(p.dispatch?.liveDeviceId),
    ])
  );

  return {
    data: devices.map(device => ({
      ...device,
      firmwareProfile:
        productionBySerial.get(device.serialNumber) ===
        String(device._id)
          ? "v3"
          : "legacy",
      wifiPasswordConfigured: Boolean(device.wifiPassword),
      wifiPassword: undefined,
    })),
    pagination: {
      page: currentPage,
      limit: pageLimit,
      total,
      pages: Math.ceil(total / pageLimit),
    },
  };
}

async function getDetails(id) {
  const result = await findDevice(id);

  return {
    device: publicDevice(result.device, result.profile),
    firmwareProfile: result.profile,
    production: result.production
      ? {
          stage: result.production.stage,
          calibration: result.production.calibration,
          lastCommand: result.production.groupB?.lastCommand,
          connection: result.production.groupB?.connection,
        }
      : null,
  };
}

module.exports = {
  findDevice,
  listDevices,
  getDetails,
  publicDevice,
  log,
  actorId,
  requestId,
  publish,
  buildConfigTopic,
  publishDeviceConfig,
  publishCalibration,
  publishProductionCommand,
  publishStartSession,
  publishStopSession,
  Device,
  ProductionDevice,
  DeviceProvision,
  DeviceMaintenanceLog,
};
