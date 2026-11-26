// controllers/productionV3.controller.js
// Group A creation, production device listing and Group B provisioning.

const crypto = require("crypto");
const mongoose = require("mongoose");

const ProductionDevice = require("../models/ProductionDevice");
const DeviceProvision = require("../models/DeviceProvision");
const Device = require("../models/device");

const {
  generateSerialNumbers,
} = require("../services/productionV3Serial.service");
const {
  encryptSecret,
  decryptSecret,
} = require("../services/productionV3Secrets");
const {
  publishGroupBProvisionConfig,
} = require("../services/productionV3Provisioning.service");
const {
  normalizeDeviceId,
  normalizeSerialNumber,
} = require("../config/deviceProtocol");

function actorId(req) {
  return String(
    req.user?.uid ||
    req.user?.userId ||
    req.user?._id ||
    "admin"
  );
}

function escapeRegex(value) {
  const special = new Set("\\^$.*+?()[]{}|");
  return [...String(value)]
    .map((character) => special.has(character) ? `\\${character}` : character)
    .join("");
}

function publicDevice(device) {
  const output = device?.toObject
    ? device.toObject()
    : { ...device };

  if (output.groupB) {
    delete output.groupB.wifiSSIDEncrypted;
    delete output.groupB.wifiPasswordEncrypted;
  }

  return output;
}

function getDeviceQuery(id) {
  const value = String(id || "").trim();

  if (mongoose.Types.ObjectId.isValid(value)) {
    return { _id: value };
  }

  return { serialNumber: normalizeSerialNumber(value).toUpperCase() };
}

// POST /api/production/v3/group-a
// Body: entryQuantity, serialPrefix, startingNumber, number, par,
//       pcbBatch, meteringHardware, batchName
async function createGroupAEntries(req, res) {
  let dbSession;

  try {
    const {
      entryQuantity,
      quantity,
      serialPrefix,
      startingNumber,
      number,
      par,
      pcbBatch,
      meteringHardware,
      batchName,
    } = req.body || {};

    const count = Number(entryQuantity ?? quantity);
    const cleanPcbBatch = String(pcbBatch || "").trim();
    const cleanMeteringHardware = String(meteringHardware || "").trim();
    const cleanBatchName = String(batchName || "").trim();

    if (!cleanPcbBatch || !cleanMeteringHardware || !cleanBatchName) {
      return res.status(400).json({
        success: false,
        message: "pcbBatch, meteringHardware and batchName are required",
      });
    }

    const generated = generateSerialNumbers({
      serialPrefix,
      startingNumber,
      quantity: count,
    });

    const cleanPrefix = String(serialPrefix).trim().toUpperCase();
    const cleanStartingNumber = String(startingNumber).trim();
    const createdBy = actorId(req);
    const now = new Date();

    const documents = generated.serialNumbers.map((serialNumber, index) => ({
      serialNumber,
      stage: ProductionDevice.STAGE.GROUP_A,
      groupA: {
        serialPrefix: cleanPrefix,
        startingNumber: cleanStartingNumber,
        sequenceNumber: generated.sequenceNumbers[index],
        entryQuantity: count,
        number:
          number === undefined || number === null || number === ""
            ? null
            : String(number).trim(),
        par:
          par === undefined || par === null || par === ""
            ? null
            : String(par).trim(),
        pcbBatch: cleanPcbBatch,
        meteringHardware: cleanMeteringHardware,
        batchName: cleanBatchName,
        createdBy,
        createdAt: now,
      },
      createdBy,
      updatedBy: createdBy,
      stageUpdatedAt: now,
    }));

    // Atlas supports transactions. All serials are inserted atomically.
    dbSession = await mongoose.startSession();

    await dbSession.withTransaction(async () => {
      const existing = await ProductionDevice.find({
        serialNumber: { $in: generated.serialNumbers },
      })
        .select("serialNumber")
        .session(dbSession)
        .lean();

      if (existing.length > 0) {
        const error = new Error(
          `Serial numbers already exist: ${existing
            .slice(0, 10)
            .map((item) => item.serialNumber)
            .join(", ")}`
        );
        error.statusCode = 409;
        throw error;
      }

      await ProductionDevice.insertMany(documents, {
        session: dbSession,
        ordered: true,
      });
    });

    return res.status(201).json({
      success: true,
      message: `${count} Group A device entries created`,
      data: {
        count,
        firstSerialNumber: generated.serialNumbers[0],
        lastSerialNumber:
          generated.serialNumbers[generated.serialNumbers.length - 1],
        serialNumbers: generated.serialNumbers,
        batchName: cleanBatchName,
        pcbBatch: cleanPcbBatch,
      },
    });
  } catch (error) {
    console.error("[PRODUCTION V3 GROUP A]", error);
    const status = error.statusCode || (error.code === 11000 ? 409 : 500);

    return res.status(status).json({
      success: false,
      message:
        status === 409
          ? error.message || "One or more serial numbers already exist"
          : error.message || "Could not create Group A entries",
    });
  } finally {
    if (dbSession) await dbSession.endSession();
  }
}

// GET /api/production/v3/devices
// Optional: ?stage=group_a|group_b|calibration|dispatch&search=&page=&limit=
async function listProductionDevices(req, res) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const { stage, search } = req.query;
    const filter = {};

    if (stage) {
      if (!Object.values(ProductionDevice.STAGE).includes(stage)) {
        return res.status(400).json({
          success: false,
          message: "Invalid production stage",
        });
      }
      filter.stage = stage;
    }

    if (search) {
      const expression = new RegExp(escapeRegex(search), "i");
      filter.$or = [
        { serialNumber: expression },
        { "groupA.batchName": expression },
        { "groupA.pcbBatch": expression },
        { "groupB.deviceId": expression },
      ];
    }

    const [rows, total] = await Promise.all([
      ProductionDevice.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ProductionDevice.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: rows.map(publicDevice),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("[PRODUCTION V3 LIST]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Could not list production devices",
    });
  }
}

// GET /api/production/v3/devices/:id
// :id can be Mongo _id or serialNumber.
async function getProductionDevice(req, res) {
  try {
    const device = await ProductionDevice.findOne(
      getDeviceQuery(req.params.id)
    ).lean();

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found",
      });
    }

    return res.json({ success: true, data: publicDevice(device) });
  } catch (error) {
    console.error("[PRODUCTION V3 GET]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Could not fetch production device",
    });
  }
}

// POST /api/production/v3/devices/:id/group-b
// Body: { deviceId, wifiSSID, wifiPassword }
async function promoteToGroupB(req, res) {
  try {
    const device = await ProductionDevice.findOne(
      getDeviceQuery(req.params.id)
    );

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found",
      });
    }

    if (device.stage !== ProductionDevice.STAGE.GROUP_A) {
      return res.status(409).json({
        success: false,
        message: "Only Group A devices can be promoted to Group B",
      });
    }

    const deviceId = normalizeDeviceId(req.body?.deviceId);
    const wifiSSID = String(req.body?.wifiSSID || "").trim();
    const wifiPassword =
      typeof req.body?.wifiPassword === "string"
        ? req.body.wifiPassword
        : "";

    if (!/^[A-Z0-9_-]{2,32}$/.test(deviceId)) {
      return res.status(400).json({
        success: false,
        message: "deviceId must contain 2-32 letters, numbers, hyphens or underscores",
      });
    }

    if (!wifiSSID || wifiSSID.length > 32) {
      return res.status(400).json({
        success: false,
        message: "wifiSSID is required and must be at most 32 characters",
      });
    }

    const validPassword =
      wifiPassword.length === 0 ||
      (wifiPassword.length >= 8 && wifiPassword.length <= 63) ||
      /^[0-9a-fA-F]{64}$/.test(wifiPassword);

    if (!validPassword) {
      return res.status(400).json({
        success: false,
        message: "wifiPassword must be empty for an open network, 8-63 characters, or 64 hexadecimal characters",
      });
    }

    const [
      productionDuplicate,
      legacyProvisionDuplicate,
      legacyDeviceDuplicate,
    ] = await Promise.all([
      ProductionDevice.findOne({
        "groupB.deviceId": deviceId,
        _id: { $ne: device._id },
      }).select("_id").lean(),
      DeviceProvision.findOne({ deviceId }).select("_id").lean(),
      Device.findOne({ device_id: deviceId }).select("_id").lean(),
    ]);

    if (productionDuplicate || legacyProvisionDuplicate || legacyDeviceDuplicate) {
      return res.status(409).json({
        success: false,
        message: `Device ID ${deviceId} is already assigned`,
      });
    }

    // Fail before changing the document if the encryption key is missing/bad.
    const encryptedSSID = encryptSecret(wifiSSID);
    const encryptedPassword = encryptSecret(wifiPassword);

    const requestId = crypto.randomUUID();
    const nextNvsVersion = Number(device.groupB?.nvsVersion || 0) + 1;
    const provisionedBy = actorId(req);
    const now = new Date();

    device.groupB.deviceId = deviceId;
    device.groupB.wifiSSIDEncrypted = encryptedSSID;
    device.groupB.wifiPasswordEncrypted = encryptedPassword;
    device.groupB.provisionStatus = ProductionDevice.PROVISION_STATUS.SENT;
    device.groupB.provisionSentAt = now;
    device.groupB.provisionedBy = provisionedBy;
    device.groupB.nvsVersion = nextNvsVersion;
    device.groupB.configAck = {
      status: "pending",
      action: "setConfig",
      requestId,
      message: null,
      fwVersion: null,
      nvsVersion: nextNvsVersion,
      receivedAt: null,
    };
    device.groupB.lastError = null;
    device.stage = ProductionDevice.STAGE.GROUP_B;
    device.stageUpdatedAt = now;
    device.updatedBy = provisionedBy;

    // Save correlation data before publishing to avoid losing a fast ACK.
    await device.save();

    let publishResult;

    try {
      publishResult = await publishGroupBProvisionConfig({
        serialNumber: device.serialNumber,
        deviceId,
        wifiSSID: decryptSecret(encryptedSSID),
        wifiPassword: decryptSecret(encryptedPassword),
        requestId,
        nvsVersion: nextNvsVersion,
      });
    } catch (publishError) {
      device.groupB.provisionStatus = ProductionDevice.PROVISION_STATUS.FAILED;
      device.groupB.configAck = {
        status: "error",
        action: "setConfig",
        requestId,
        message: publishError.message,
        fwVersion: null,
        nvsVersion: nextNvsVersion,
        receivedAt: new Date(),
      };
      device.groupB.lastError = publishError.message;
      await device.save();

      return res.status(502).json({
        success: false,
        message: "Device was moved to Group B, but MQTT provisioning could not be published",
        data: publicDevice(device),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Device promoted to Group B and provisioning command published",
      data: publicDevice(device),
      provisioning: {
        status: device.groupB.provisionStatus,
        topic: publishResult.topic,
        requestId: publishResult.requestId,
        nvsVersion: publishResult.nvsVersion,
        acknowledgement: "waiting",
      },
    });
  } catch (error) {
    console.error("[PRODUCTION V3 GROUP B]", error);
    const status = error.code === 11000 ? 409 : 500;

    return res.status(status).json({
      success: false,
      message: error.message || "Could not promote production device to Group B",
    });
  }
}

module.exports = {
  createGroupAEntries,
  listProductionDevices,
  getProductionDevice,
  promoteToGroupB,
};
