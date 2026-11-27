
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
    const { device, production, profile } = await service.findDevice(req.params.id);
    const changes = req.body?.changes || {};
    if (Object.keys(changes).length !== 2 ||
        !Object.prototype.hasOwnProperty.call(changes, "wifiSSID") ||
        !Object.prototype.hasOwnProperty.call(changes, "wifiPassword")) {
      throw Object.assign(new Error("Provide wifiSSID and wifiPassword together"), { statusCode: 400 });
    }
    if (typeof changes.wifiSSID !== "string" || !changes.wifiSSID.trim() ||
        typeof changes.wifiPassword !== "string" || !changes.wifiPassword) {
      throw Object.assign(new Error("Valid Wi-Fi SSID and password are required"), { statusCode: 400 });
    }

    const request = service.requestId();
    const ssid = changes.wifiSSID.trim();

    if (profile === "legacy") {
      const previous = { wifiSSID: device.wifiSSID, wifiPassword: device.wifiPassword };
      device.wifiSSID = ssid;
      device.wifiPassword = changes.wifiPassword;
      await device.save();
      try {
        const published = await service.publishDeviceConfig(device.device_id, { requestId: request });
        await service.log({
          requestId: request, serialNumber: device.serialNumber, deviceId: device.device_id,
          category: "firmware", operation: "wifi_update", firmwareProfile: profile,
          changes: { wifiSSID: ssid, wifiPassword: "[REDACTED]" },
          status: "published", mqttTopic: published.topic, performedBy: service.actorId(req),
        });
        return res.status(202).json({
          success: true, requestId: request, status: "published",
          topic: published.topic, nvsVersion: published.nvsVersion,
        });
      } catch (error) {
        device.wifiSSID = previous.wifiSSID;
        device.wifiPassword = previous.wifiPassword;
        await device.save();
        throw error;
      }
    }

    const nextNvsVersion = Number(production.groupB.nvsVersion || 0) + 1;
    const topic = service.buildConfigTopic(device.serialNumber);
    const payload = {
      action: "setConfig", schemaVersion: 1, requestId,
      serialNumber: device.serialNumber, deviceId: device.device_id,
      ssid, password: changes.wifiPassword, nvsVersion: nextNvsVersion,
    };
    const previousDevice = { wifiSSID: device.wifiSSID, wifiPassword: device.wifiPassword };
    const previousGroupB = {
      nvsVersion: production.groupB.nvsVersion,
      configAck: production.groupB.configAck?.toObject
        ? production.groupB.configAck.toObject()
        : production.groupB.configAck,
    };

    device.wifiSSID = ssid;
    device.wifiPassword = changes.wifiPassword;
    production.groupB.nvsVersion = nextNvsVersion;
    production.groupB.configAck = {
      status: "pending", action: "setConfig", requestId, nvsVersion: nextNvsVersion,
    };
    await device.save();
    await production.save();

    try {
      await service.publish(topic, payload);
      await service.log({
        requestId, serialNumber: device.serialNumber, deviceId: device.device_id,
        category: "firmware", operation: "wifi_update", firmwareProfile: profile,
        changes: { wifiSSID: ssid, wifiPassword: "[REDACTED]" },
        status: "published", mqttTopic: topic, performedBy: service.actorId(req),
      });
    } catch (error) {
      device.wifiSSID = previousDevice.wifiSSID;
      device.wifiPassword = previousDevice.wifiPassword;
      production.groupB.nvsVersion = previousGroupB.nvsVersion;
      production.groupB.configAck = previousGroupB.configAck;
      await device.save();
      await production.save();
      throw error;
    }

    return res.status(202).json({
      success: true, requestId, status: "published", topic, nvsVersion: nextNvsVersion,
    });
  } catch (error) {
    return responseError(res, error);
  }
};

exports.updateCalibration = async (req, res) => {
  try {
    const { device, production, profile } = await service.findDevice(req.params.id);
    const coefficients = req.body?.coefficients || {};
    const keys = profile === "legacy"
      ? ["cf", "vf", "currentRF"]
      : ["vf", "currentZero", "currentGain", "powerZero", "powerGain"];
    const clean = {};

    for (const key of keys) {
      const value = Number(coefficients[key]);
      if (!Number.isFinite(value)) {
        throw Object.assign(new Error(`${key} must be numeric`), { statusCode: 400 });
      }
      if (profile === "legacy" && value <= 0) {
        throw Object.assign(new Error(`${key} must be greater than zero`), { statusCode: 400 });
      }
      if (profile === "v3" && ["vf", "currentGain", "powerGain"].includes(key) && value <= 0) {
        throw Object.assign(new Error(`${key} must be greater than zero`), { statusCode: 400 });
      }
      clean[key] = value;
    }

    const request = service.requestId();
    const logEntry = {
      requestId: request,
      serialNumber: device.serialNumber,
      deviceId: device.device_id,
      category: "firmware",
      operation: "calibration_update",
      firmwareProfile: profile,
      changes: clean,
      status: "pending",
      performedBy: service.actorId(req),
    };
    await service.log(logEntry);

    if (profile === "legacy") {
      const previous = { cf: device.cf, vf: device.vf, currentRF: device.currentRF };
      Object.assign(device, clean);
      await device.save();

      try {
        const published = await service.publishDeviceConfig(
          device.device_id,
          { requestId: request }
        );

        await service.DeviceMaintenanceLog.updateOne(
          { requestId: request, status: "pending" },
          { $set: { status: "published", mqttTopic: published.topic } }
        );

        return res.status(202).json({
          success: true,
          requestId: request,
          status: "published",
          topic: published.topic,
          nvsVersion: published.nvsVersion,
        });
      } catch (error) {
        device.cf = previous.cf;
        device.vf = previous.vf;
        device.currentRF = previous.currentRF;
        await device.save();

        await service.DeviceMaintenanceLog.updateOne(
          { requestId: request },
          { $set: { status: "failed", errorMessage: error.message, completedAt: new Date() } }
        );
        throw error;
      }
    }

    const previous = {
      coefficients: production.calibration.coefficients?.toObject
        ? production.calibration.coefficients.toObject()
        : production.calibration.coefficients,
      requestId: production.calibration.requestId,
      status: production.calibration.status,
      submittedAt: production.calibration.submittedAt,
    };

    production.calibration.coefficients = clean;
    production.calibration.requestId = request;
    production.calibration.status =
      service.ProductionDevice.CALIBRATION_STATUS.SUBMITTED;
    production.calibration.submittedAt = new Date();
    await production.save();

    try {
      const published = await service.publishCalibration({
        serialNumber: device.serialNumber,
        requestId: request,
        coefficients: clean,
      });

      await service.DeviceMaintenanceLog.updateOne(
        { requestId: request, status: "pending" },
        { $set: { status: "published", mqttTopic: published.topic } }
      );

      return res.status(202).json({
        success: true,
        requestId: request,
        status: "published",
        topic: published.topic,
      });
    } catch (error) {
      production.calibration.coefficients = previous.coefficients;
      production.calibration.requestId = previous.requestId;
      production.calibration.status = previous.status;
      production.calibration.submittedAt = previous.submittedAt;
      await production.save();

      await service.DeviceMaintenanceLog.updateOne(
        { requestId: request },
        { $set: { status: "failed", errorMessage: error.message, completedAt: new Date() } }
      );
      throw error;
    }
  } catch (error) {
    return responseError(res, error);
  }
};

exports.sendCommand = async (req, res) => {
  try {
    const { device, production, profile } = await service.findDevice(req.params.id);
    const action = String(req.body?.action || "");
    if (!["relayStart", "relayStop"].includes(action)) {
      throw Object.assign(new Error("Unsupported command. Use existing admin session endpoints for session start/stop."), { statusCode: 400 });
    }
    if (profile !== "v3") {
      throw Object.assign(new Error("Relay admin commands are supported only for confirmed V3 devices"), { statusCode: 400 });
    }
    if (action === "relayStart" && req.body.testMode !== true) {
      throw Object.assign(new Error("Relay start requires testMode=true"), { statusCode: 400 });
    }

    const request = service.requestId();
    const previous = production.groupB.lastCommand?.toObject
      ? production.groupB.lastCommand.toObject()
      : production.groupB.lastCommand;

    production.groupB.lastCommand = {
      requestId: request, deviceId: device.device_id, action,
      status: service.ProductionDevice.COMMAND_STATUS.PENDING,
      sentAt: new Date(), acknowledgedAt: null, message: null,
    };
    await production.save();

    try {
      const published = await service.publishProductionCommand({
        deviceId: device.device_id, action, requestId: request,
        testMode: req.body.testMode, durationSeconds: req.body.durationSeconds,
      });
      await service.log({
        requestId: request, serialNumber: device.serialNumber, deviceId: device.device_id,
        category: "command", operation: action, firmwareProfile: profile,
        changes: { durationSeconds: req.body.durationSeconds || null },
        status: "published", mqttTopic: published.topic, performedBy: service.actorId(req),
      });
      return res.status(202).json({
        success: true, requestId: request, status: "published", topic: published.topic,
      });
    } catch (error) {
      production.groupB.lastCommand = previous || {};
      await production.save();
      throw error;
    }
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
    const { device, production, profile } = await service.findDevice(req.params.id);
    const oldId = device.device_id;
    const newId = String(req.body?.newDeviceId || "").trim().toUpperCase();

    if (!/^[A-Z0-9_-]{3,40}$/.test(newId)) {
      return res.status(400).json({ success: false, message: "Invalid new Device ID" });
    }
    if (oldId === newId) {
      return res.status(400).json({ success: false, message: "New Device ID is the same as current ID" });
    }

    const duplicateDevice = await service.Device.findOne({ device_id: newId });
    if (duplicateDevice) {
      return res.status(409).json({ success: false, message: "Device ID already exists" });
    }
    const duplicateProvision = await service.DeviceProvision.findOne({
      deviceId: newId, serialNumber: { $ne: device.serialNumber },
    });
    if (duplicateProvision) {
      return res.status(409).json({ success: false, message: "Device ID already exists in DeviceProvision" });
    }
    if (profile === "v3") {
      const duplicateProduction = await service.ProductionDevice.findOne({
        "groupB.deviceId": newId, _id: { $ne: production._id },
      });
      if (duplicateProduction) {
        return res.status(409).json({ success: false, message: "Device ID already exists in Production" });
      }
    }

    const request = service.requestId();
    const nextNvsVersion = Number(
      profile === "v3" ? production.groupB.nvsVersion : device.nvsVersion
    ) + 1;
    const topic = service.buildConfigTopic(device.serialNumber);
    const payload = {
      action: "setConfig", schemaVersion: 1, requestId: request,
      serialNumber: device.serialNumber, deviceId: newId,
      ssid: device.wifiSSID || "", password: device.wifiPassword || "",
      nvsVersion: nextNvsVersion,
    };

    await service.log({
      requestId: request, serialNumber: device.serialNumber, deviceId: oldId,
      category: "deviceIdMigration", operation: "device_id_update",
      firmwareProfile: profile,
      changes: { oldDeviceId: oldId, newDeviceId: newId, nvsVersion: nextNvsVersion },
      status: "pending", mqttTopic: topic, performedBy: service.actorId(req),
    });

    const previous = profile === "v3"
      ? { nvsVersion: production.groupB.nvsVersion, configAck: production.groupB.configAck?.toObject
          ? production.groupB.configAck.toObject() : production.groupB.configAck }
      : { nvsVersion: device.nvsVersion, configAck: device.configAck?.toObject
          ? device.configAck.toObject() : device.configAck };

    try {
      if (profile === "v3") {
        production.groupB.nvsVersion = nextNvsVersion;
        production.groupB.configAck = {
          status: "pending", action: "setConfig", requestId, nvsVersion: nextNvsVersion,
        };
        await production.save();
      } else {
        device.nvsVersion = nextNvsVersion;
        device.configAck = {
          status: "pending", action: "setConfig", requestId, nvsVersion: nextNvsVersion,
        };
        await device.save();
      }

      await service.publish(topic, payload);

      // Keep the request in pending state until the device ACK arrives.
      return res.status(202).json({
        success: true,
        message: "Device ID change sent. Waiting for device acknowledgement.",
        requestId, oldDeviceId: oldId, newDeviceId: newId, status: "published",
      });
    } catch (error) {
      if (profile === "v3") {
        production.groupB.nvsVersion = previous.nvsVersion;
        production.groupB.configAck = previous.configAck;
        await production.save();
      } else {
        device.nvsVersion = previous.nvsVersion;
        device.configAck = previous.configAck;
        await device.save();
      }
      await service.DeviceMaintenanceLog.updateOne(
        { requestId },
        { $set: { status: "failed", errorMessage: error.message, completedAt: new Date() } }
      );
      throw error;
    }
  } catch (error) {
    return responseError(res, error);
  }
};
