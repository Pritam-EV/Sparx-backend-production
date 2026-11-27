
const mongoose = require("mongoose");

const service = require("../services/deviceMaintenance.service");

const EDITABLE = [
  "project",
  "charger_type",
  "location",
  "area",
  "city",
  "state",
  "lat",
  "lng",
  "rate",
  "meterType",
  "meterConsumerNumber",
  "ownerId",
  "commercial.electricityBearer",
  "commercial.userRatePerKwh",
  "commercial.vjraMarginPerKwh",
  "commercial.ownerSharePerKwh",
  "commercial.pgPercent",
  "commercial.gstPercent",
];

function responseError(res, error) {
  console.error("[DEVICE MAINTENANCE]", error);

  return res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || "Maintenance operation failed",
  });
}

function validateField(field, value) {
  if (!EDITABLE.includes(field)) {
    throw Object.assign(
      new Error(`Field cannot be updated: ${field}`),
      { statusCode: 400 }
    );
  }

  if (["lat", "lng"].includes(field)) {
    const number = Number(value);

    if (
      value === null ||
      value === ""
    ) return null;

    if (!Number.isFinite(number)) {
      throw Object.assign(
        new Error(`${field} must be numeric`),
        { statusCode: 400 }
      );
    }

    if (
      field === "lat" && (number < -90 || number > 90)
    ) {
      throw Object.assign(new Error("Invalid latitude"), {
        statusCode: 400,
      });
    }

    if (
      field === "lng" && (number < -180 || number > 180)
    ) {
      throw Object.assign(new Error("Invalid longitude"), {
        statusCode: 400,
      });
    }

    return number;
  }

  if (field === "rate" ||
      field.startsWith("commercial.")) {
    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) {
      throw Object.assign(
        new Error(`${field} must be a valid non-negative number`),
        { statusCode: 400 }
      );
    }

    if (field === "commercial.pgPercent" ||
        field === "commercial.gstPercent") {
      if (number > 100) {
        throw Object.assign(
          new Error(`${field} cannot exceed 100`),
          { statusCode: 400 }
        );
      }
    }

    if (field === "rate" && number === 0) {
      throw Object.assign(
        new Error("Rate must be greater than zero"),
        { statusCode: 400 }
      );
    }

    return number;
  }

  if (field === "meterType") {
    const allowed = [
      "Green Meter",
      "Commercial",
      "Residential",
    ];

    if (value !== null && !allowed.includes(value)) {
      throw Object.assign(
        new Error("Invalid meter type"),
        { statusCode: 400 }
      );
    }

    return value;
  }

  if (field === "commercial.electricityBearer") {
    if (!["OWNER", "VJRA"].includes(value)) {
      throw Object.assign(
        new Error("Electricity bearer must be OWNER or VJRA"),
        { statusCode: 400 }
      );
    }

    return value;
  }

  if (field === "ownerId") {
    if (!Array.isArray(value)) {
      throw Object.assign(
        new Error("ownerId must be an array"),
        { statusCode: 400 }
      );
    }

    if (!value.every(id => mongoose.Types.ObjectId.isValid(id))) {
      throw Object.assign(
        new Error("Invalid owner ID"),
        { statusCode: 400 }
      );
    }

    return [...new Set(value.map(String))];
  }

  if (value !== null && typeof value !== "string") {
    throw Object.assign(
      new Error(`${field} must be a string`),
      { statusCode: 400 }
    );
  }

  return value === null ? null : value.trim();
}

function setNested(target, path, value) {
  const parts = path.split(".");
  let current = target;

  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]]) current[parts[i]] = {};
    current = current[parts[i]];
  }

  current[parts[parts.length - 1]] = value;
}

exports.listDevices = async (req, res) => {
  try {
    const result = await service.listDevices(req.query);

    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return responseError(res, error);
  }
};

exports.getDevice = async (req, res) => {
  try {
    const data = await service.getDetails(req.params.id);

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return responseError(res, error);
  }
};

exports.updateDatabase = async (req, res) => {
  try {
    const { device } = await service.findDevice(req.params.id);
    const changes = req.body?.changes;

    if (
      !changes ||
      typeof changes !== "object" ||
      Array.isArray(changes) ||
      Object.keys(changes).length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one field to update",
      });
    }

    const oldValues = {};
    const newValues = {};

    for (const [field, rawValue] of Object.entries(changes)) {
      const value = validateField(field, rawValue);

      oldValues[field] = field.split(".").reduce(
        (obj, key) => obj?.[key],
        device
      );

      newValues[field] = value;

      if (field === "rate") {
        device.setRate(
          value,
          service.actorId(req),
          "admin"
        );
      } else {
        setNested(device, field, value);
      }
    }

    await device.save();

    await service.log({
      requestId: service.requestId(),
      serialNumber: device.serialNumber,
      deviceId: device.device_id,
      category: "database",
      operation: "selective_update",
      changes: {
        oldValues,
        newValues,
      },
      status: "completed",
      performedBy: service.actorId(req),
      completedAt: new Date(),
    });

    return res.json({
      success: true,
      message: "Device database updated successfully",
      data: service.publicDevice(device, "unknown"),
    });
  } catch (error) {
    return responseError(res, error);
  }
};

exports.updateFirmwareConfig = async (req, res) => {
  try {
    const result = await service.findDevice(req.params.id);
    const { device, production, profile } = result;

    const changes = req.body?.changes || {};
    const allowed = ["wifiSSID", "wifiPassword"];

    for (const key of Object.keys(changes)) {
      if (!allowed.includes(key)) {
        throw Object.assign(
          new Error(`Unsupported firmware configuration field: ${key}`),
          { statusCode: 400 }
        );
      }
    }

    const hasSSID = changes.wifiSSID !== undefined;
    const hasPassword = changes.wifiPassword !== undefined;

    if (hasSSID !== hasPassword) {
      throw Object.assign(
        new Error("SSID and password must be updated together"),
        { statusCode: 400 }
      );
    }

    if (
      typeof changes.wifiSSID !== "string" ||
      !changes.wifiSSID.trim() ||
      typeof changes.wifiPassword !== "string" ||
      !changes.wifiPassword
    ) {
      throw Object.assign(
        new Error("Valid Wi-Fi SSID and password are required"),
        { statusCode: 400 }
      );
    }

    const request = service.requestId();

    if (profile === "legacy") {
      device.wifiSSID = changes.wifiSSID.trim();
      device.wifiPassword = changes.wifiPassword;

      await device.save();

const published = await service.publishDeviceConfig(
  device.device_id,
  { requestId: request }
);
      await service.log({
        requestId: request,
        serialNumber: device.serialNumber,
        deviceId: device.device_id,
        category: "firmware",
        operation: "wifi_update",
        firmwareProfile: profile,
        changes: {
          wifiSSID: changes.wifiSSID.trim(),
          wifiPassword: "[REDACTED]",
        },
        status: "published",
        mqttTopic: published.topic,
        performedBy: service.actorId(req),
      });

      return res.status(202).json({
        success: true,
        message: "Wi-Fi configuration published",
        requestId: request,
        status: "published",
        topic: published.topic,
        nvsVersion: published.nvsVersion,
      });
    }

    const nextNvsVersion =
      Number(production.groupB.nvsVersion || 0) + 1;

      device.wifiSSID = changes.wifiSSID.trim();
device.wifiPassword = changes.wifiPassword;

await device.save();

    const topic = service.buildConfigTopic(device.serialNumber);

    const payload = {
      action: "setConfig",
      schemaVersion: 1,
      requestId: request,
      serialNumber: device.serialNumber,
      deviceId: device.device_id,
      ssid: changes.wifiSSID.trim(),
      password: changes.wifiPassword,
      nvsVersion: nextNvsVersion,
    };

    await service.publish(topic, payload);

    production.groupB.nvsVersion = nextNvsVersion;
    production.groupB.configAck = {
      status: "pending",
      action: "setConfig",
      requestId: request,
      nvsVersion: nextNvsVersion,
    };

    await production.save();

    await service.log({
      requestId: request,
      serialNumber: device.serialNumber,
      deviceId: device.device_id,
      category: "firmware",
      operation: "wifi_update",
      firmwareProfile: profile,
      changes: {
        wifiSSID: changes.wifiSSID.trim(),
        wifiPassword: "[REDACTED]",
      },
      status: "published",
      mqttTopic: topic,
      performedBy: service.actorId(req),
    });

    return res.status(202).json({
      success: true,
      requestId: request,
      status: "published",
      topic,
      nvsVersion: nextNvsVersion,
    });
  } catch (error) {
    return responseError(res, error);
  }
};


exports.updateCalibration = async (req, res) => {
  try {
    const { device, production, profile } =
      await service.findDevice(req.params.id);

    const coefficients = req.body?.coefficients || {};

    const keys = profile === "legacy"
      ? ["cf", "vf", "currentRF"]
      : ["vf", "currentZero", "currentGain", "powerZero", "powerGain"];

    const clean = {};

    for (const key of keys) {
      const value = Number(coefficients[key]);

      if (!Number.isFinite(value)) {
        throw Object.assign(
          new Error(`${key} must be numeric`),
          { statusCode: 400 }
        );
      }

      // Legacy calibration factors must be positive.
      if (profile === "legacy" && value <= 0) {
        throw Object.assign(
          new Error(`${key} must be greater than zero`),
          { statusCode: 400 }
        );
      }

      // V3 offset values can be zero or negative.
      // Only scale/gain values must be positive.
      if (
        profile === "v3" &&
        ["vf", "currentGain", "powerGain"].includes(key) &&
        value <= 0
      ) {
        throw Object.assign(
          new Error(`${key} must be greater than zero`),
          { statusCode: 400 }
        );
      }

      clean[key] = value;
    }

    const request = service.requestId();

    if (profile === "legacy") {
      Object.assign(device, clean);
      await device.save();

      const published = await service.publishDeviceConfig(
        device.device_id,
        { requestId: request }
      );

      await service.log({
        requestId: request,
        serialNumber: device.serialNumber,
        deviceId: device.device_id,
        category: "firmware",
        operation: "calibration_update",
        firmwareProfile: profile,
        changes: clean,
        status: "published",
        mqttTopic: published.topic,
        performedBy: service.actorId(req),
      });

      return res.status(202).json({
        success: true,
        requestId: request,
        status: "published",
        topic: published.topic,
        nvsVersion: published.nvsVersion,
      });
    }

    const published = await service.publishCalibration({
      serialNumber: device.serialNumber,
      requestId: request,
      coefficients: clean,
    });

    production.calibration.coefficients = clean;
    production.calibration.requestId = request;
    production.calibration.status =
      service.ProductionDevice.CALIBRATION_STATUS.SUBMITTED;
    production.calibration.submittedAt = new Date();

    await production.save();

    await service.log({
      requestId: request,
      serialNumber: device.serialNumber,
      deviceId: device.device_id,
      category: "firmware",
      operation: "calibration_update",
      firmwareProfile: profile,
      changes: clean,
      status: "published",
      mqttTopic: published.topic,
      performedBy: service.actorId(req),
    });

    return res.status(202).json({
      success: true,
      requestId: request,
      status: "published",
      topic: published.topic,
    });
  } catch (error) {
    return responseError(res, error);
  }
};


exports.sendCommand = async (req, res) => {
  try {
    const { device, production, profile } =
      await service.findDevice(req.params.id);

    const action = String(req.body?.action || "");

    if (["relayStart", "relayStop"].includes(action)) {
      if (profile !== "v3") {
        throw Object.assign(
          new Error("Relay admin commands are supported only for confirmed V3 devices"),
          { statusCode: 400 }
        );
      }

      if (action === "relayStart" && req.body.testMode !== true) {
        throw Object.assign(
          new Error("Relay start requires testMode=true"),
          { statusCode: 400 }
        );
      }

      const request = service.requestId();


      production.groupB.lastCommand = {
        requestId: request,
        deviceId: device.device_id,
        action,
        status: "pending",
        sentAt: new Date(),
        acknowledgedAt: null,
        message: null,
      };

      await production.save();

            const published = await service.publishProductionCommand({
        deviceId: device.device_id,
        action,
        requestId: request,
        testMode: req.body.testMode,
        durationSeconds: req.body.durationSeconds,
      });

      await service.log({
        requestId: request,
        serialNumber: device.serialNumber,
        deviceId: device.device_id,
        category: "command",
        operation: action,
        firmwareProfile: profile,
        changes: {
          durationSeconds: req.body.durationSeconds || null,
        },
        status: "published",
        mqttTopic: published.topic,
        performedBy: service.actorId(req),
      });

      return res.status(202).json({
        success: true,
        requestId: request,
        status: "published",
        topic: published.topic,
      });
    }

    throw Object.assign(
      new Error("Unsupported command. Use existing admin session endpoints for session start/stop."),
      { statusCode: 400 }
    );
  } catch (error) {
    return responseError(res, error);
  }
};

exports.getHistory = async (req, res) => {
  try {
    const { device } = await service.findDevice(req.params.id);

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

    const [data, total] = await Promise.all([
      service.DeviceMaintenanceLog.find({
        serialNumber: device.serialNumber,
      })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      service.DeviceMaintenanceLog.countDocuments({
        serialNumber: device.serialNumber,
      }),
    ]);

    return res.json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return responseError(res, error);
  }
};

exports.updateDeviceId = async (req, res) => {
  try {
    const { device, production, profile } =
      await service.findDevice(req.params.id);

    const oldId = device.device_id;
    const newId = String(req.body?.newDeviceId || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z0-9_-]{3,40}$/.test(newId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid new Device ID",
      });
    }

    if (oldId === newId) {
      return res.status(400).json({
        success: false,
        message: "New Device ID is the same as current ID",
      });
    }

    // Do not allow another migration while one is waiting for firmware ACK.
const pendingMigration = await service.DeviceMaintenanceLog.findOne({
  serialNumber: device.serialNumber,
  category: "deviceIdMigration",
  status: {
    $in: ["pending", "published"],
  },
}).lean();

if (pendingMigration) {
  return res.status(409).json({
    success: false,
    message: "A Device ID migration is already pending for this device.",
    requestId: pendingMigration.requestId,
    status: pendingMigration.status,
  });
}

    const duplicate = await service.Device.findOne({
      device_id: newId,
    });

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "Device ID already exists",
      });
    }

    if (profile === "v3") {
      const productionDuplicate =
        await service.ProductionDevice.findOne({
          "groupB.deviceId": newId,
          _id: { $ne: production._id },
        });

      if (productionDuplicate) {
        return res.status(409).json({
          success: false,
          message: "Device ID already exists in Production",
        });
      }
    }

    const request = service.requestId();
const currentNvsVersion = Number(
  profile === "v3"
    ? production.groupB.nvsVersion
    : device.nvsVersion
);

if (
  !Number.isInteger(currentNvsVersion) ||
  currentNvsVersion < 0
) {
  throw Object.assign(
    new Error("Current NVS version is invalid."),
    { statusCode: 409 }
  );
}

const nextNvsVersion = currentNvsVersion + 1;

    const topic = service.buildConfigTopic(device.serialNumber);

const payload = {
  action: "setConfig",
  schemaVersion: 1,

  requestId: request,
  serialNumber: device.serialNumber,
  deviceId: newId,

  ssid: device.wifiSSID || "",
  password: device.wifiPassword || "",

  nvsVersion: nextNvsVersion,

  ...(profile === "legacy"
    ? {
        cf: device.cf,
        vf: device.vf,
        currentRF: device.currentRF,
      }
    : {}),
};

    

    if (profile === "v3") {
      production.groupB.nvsVersion = nextNvsVersion;
      production.groupB.configAck = {
        status: "pending",
        action: "setConfig",
        requestId: request,
        nvsVersion: nextNvsVersion,
      };
      await production.save();

      await service.publish(topic, payload);

    } else {
      device.nvsVersion = nextNvsVersion;
      device.configAck = {
        status: "pending",
        action: "setConfig",
        requestId: request,
        nvsVersion: nextNvsVersion,
      };
      await device.save();
    }

    await service.log({
      requestId: request,
      serialNumber: device.serialNumber,
      deviceId: oldId,
      category: "deviceIdMigration",
      operation: "device_id_update",
      firmwareProfile: profile,
changes: {
  oldDeviceId: oldId,
  newDeviceId: newId,
  nvsVersion: nextNvsVersion,
},
      status: "published",
      mqttTopic: topic,
      performedBy: service.actorId(req),
    });

    return res.status(202).json({
      success: true,
      message: "Device ID change sent. Waiting for device acknowledgement.",
      requestId: request,
      oldDeviceId: oldId,
      newDeviceId: newId,
      status: "published",
    });
  } catch (error) {
    return responseError(res, error);
  }
};
