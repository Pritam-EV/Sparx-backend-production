
// controllers/productionV3.controller.js

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
  publishCalibration,
  publishProductionCommand,
} = require("../services/productionV3Provisioning.service");

const {
  getLatestProductionTelemetry,
} = require("../services/productionTelemetryCache");

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function actorId(req) {
  return String(
    req.user?.userId ||
    req.user?._id ||
    "admin"
  );
}

function escapeRegex(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function publicDevice(device) {
  const output = device?.toObject
    ? device.toObject()
    : { ...device };

  if (output.groupB) {
    delete output.groupB.wifiSSIDEncrypted;
    delete output.groupB.wifiPasswordEncrypted;
  }
if (output.groupB?.connection) {
  const lastSeen = output.groupB.connection.lastSeen
    ? new Date(output.groupB.connection.lastSeen).getTime()
    : 0;

  output.groupB.connection.status =
    lastSeen && Date.now() - lastSeen <= 90000
      ? "online"
      : "offline";
}
  return output;
}

function getDeviceQuery(id) {
  const value = String(id || "").trim();
  const normalized = value.toUpperCase();

  const alternatives = [
    { serialNumber: normalized },
    { "groupB.deviceId": normalized },
  ];

  if (mongoose.Types.ObjectId.isValid(value)) {
    alternatives.push({ _id: value });
  }

  return { $or: alternatives };
}

async function findProductionDevice(id) {
  return ProductionDevice.findOne(getDeviceQuery(id));
}

function finiteNumber(value, label) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    throw new Error(`${label} is required.`);
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a valid number.`);
  }

  return number;
}

function firmwareFloat(value, label) {
  if (!Number.isFinite(value)) {
    throw new Error(`Calculated ${label} is not finite.`);
  }

  // Match ESP32 IEEE-754 float representation.
  const result = Math.fround(value);

  if (!Number.isFinite(result)) {
    throw new Error(`Calculated ${label} exceeds float range.`);
  }

  return Number(result.toPrecision(8));
}

// --------------------------------------------------
// 1. GROUP A
// POST /group-a
// --------------------------------------------------

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
    const cleanHardware = String(meteringHardware || "")
      .trim()
      .toUpperCase();
    const cleanBatchName = String(batchName || "").trim();

    if (
      !cleanPcbBatch ||
      !cleanHardware ||
      !cleanBatchName
    ) {
      return res.status(400).json({
        success: false,
        message:
          "PCB batch, metering hardware and batch name are required.",
      });
    }

    const generated = generateSerialNumbers({
      serialPrefix,
      startingNumber,
      quantity: count,
    });

    const prefix = String(serialPrefix).trim().toUpperCase();
    const startText = String(startingNumber).trim();
    const createdBy = actorId(req);
    const now = new Date();

    const documents = generated.serialNumbers.map(
      (serialNumber, index) => ({
        serialNumber,

        stage: ProductionDevice.STAGE.GROUP_A,

        groupA: {
          serialPrefix: prefix,
          startingNumber: startText,
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
          meteringHardware: cleanHardware,
          batchName: cleanBatchName,

          createdBy,
          createdAt: now,
        },

        createdBy,
        updatedBy: createdBy,
        stageUpdatedAt: now,
      })
    );

    // Check against production and existing legacy records.
    // No batch document is created.
    dbSession = await mongoose.startSession();

    await dbSession.withTransaction(async () => {
      const [
        existingProduction,
        existingProvision,
        existingDevices,
      ] = await Promise.all([
        ProductionDevice.find({
          serialNumber: { $in: generated.serialNumbers },
        })
          .select("serialNumber")
          .session(dbSession)
          .lean(),

        DeviceProvision.find({
          serialNumber: { $in: generated.serialNumbers },
        })
          .select("serialNumber")
          .session(dbSession)
          .lean(),

        Device.find({
          serialNumber: { $in: generated.serialNumbers },
        })
          .select("serialNumber")
          .session(dbSession)
          .lean(),
      ]);

      const conflicts = [
        ...new Set([
          ...existingProduction.map(x => x.serialNumber),
          ...existingProvision.map(x => x.serialNumber),
          ...existingDevices.map(x => x.serialNumber),
        ]),
      ];

      if (conflicts.length) {
        const error = new Error(
          `Serial numbers already exist: ${conflicts.slice(0, 10).join(", ")}`
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
      message: `${count} Group A entries created.`,
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
    console.error("[PRODUCTION GROUP A]", error);

    return res.status(
      error.statusCode || (error.code === 11000 ? 409 : 500)
    ).json({
      success: false,
      message: error.message || "Could not create Group A entries.",
    });

  } finally {
    if (dbSession) await dbSession.endSession();
  }
}

// --------------------------------------------------
// 2. PRODUCTION DEVICE LIST
// GET /devices
//
// filter=group_a
// filter=group_b
// filter=calibrated
// filter=tested
// filter=dispatched
// --------------------------------------------------

async function listProductionDevices(req, res) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);

    const limit = Math.min(
      Math.max(Number(req.query.limit) || 100, 1),
      500
    );

    const filter = {};

    const filters = {
      group_a: {
        stage: ProductionDevice.STAGE.GROUP_A,
      },

      group_b: {
        stage: ProductionDevice.STAGE.GROUP_B,
      },

      calibrated: {
        "calibration.status":
          ProductionDevice.CALIBRATION_STATUS.APPLIED,
      },

      tested: {
        "calibration.testStatus":
          ProductionDevice.TEST_STATUS.PASSED,
      },

      dispatched: {
        "dispatch.status": "completed",
      },
    };

    const requestedFilter = String(
      req.query.filter || ""
    ).trim().toLowerCase();

    if (requestedFilter && requestedFilter !== "all") {
      if (!filters[requestedFilter]) {
        return res.status(400).json({
          success: false,
          message: "Invalid production filter.",
        });
      }

      Object.assign(filter, filters[requestedFilter]);
    }

    if (req.query.stage) {
      const stage = String(req.query.stage).toLowerCase();

      if (!Object.values(ProductionDevice.STAGE).includes(stage)) {
        return res.status(400).json({
          success: false,
          message: "Invalid production stage.",
        });
      }

      filter.stage = stage;
    }

    if (req.query.search) {
      const expression = new RegExp(
        escapeRegex(req.query.search),
        "i"
      );

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
    console.error("[PRODUCTION LIST]", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
}

// --------------------------------------------------
// 3. GET SINGLE PRODUCTION DEVICE
// GET /devices/:id
// --------------------------------------------------

async function getProductionDevice(req, res) {
  try {
    const device = await ProductionDevice.findOne(
      getDeviceQuery(req.params.id)
    ).lean();

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    return res.json({
      success: true,
      data: publicDevice(device),
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
}

// --------------------------------------------------
// 4. GROUP B PROVISIONING
// POST /devices/:id/group-b
//
// Body:
// {
//   deviceId,
//   wifiSSID,
//   wifiPassword
// }
// --------------------------------------------------

async function promoteToGroupB(req, res) {
  try {
    const device = await findProductionDevice(req.params.id);

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    const isGroupA =
      device.stage === ProductionDevice.STAGE.GROUP_A;

    const isFailedRetry =
      device.stage === ProductionDevice.STAGE.GROUP_B &&
      device.groupB?.provisionStatus ===
        ProductionDevice.PROVISION_STATUS.FAILED;

    if (!isGroupA && !isFailedRetry) {
      return res.status(409).json({
        success: false,
        message:
          "Only Group A devices or failed Group B provisioning can be promoted.",
      });
    }

    const deviceId = String(req.body.deviceId || "")
      .trim()
      .toUpperCase();

    const wifiSSID = String(req.body.wifiSSID || "").trim();

    const wifiPassword =
      typeof req.body.wifiPassword === "string"
        ? req.body.wifiPassword
        : "";

    if (!/^[A-Z0-9_-]{2,32}$/.test(deviceId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Device ID.",
      });
    }

    if (!wifiSSID || wifiSSID.length > 32) {
      return res.status(400).json({
        success: false,
        message: "Wi-Fi SSID is required and must be at most 32 characters.",
      });
    }

    const validPassword =
      wifiPassword.length === 0 ||
      (wifiPassword.length >= 8 && wifiPassword.length <= 63) ||
      /^[0-9a-fA-F]{64}$/.test(wifiPassword);

    if (!validPassword) {
      return res.status(400).json({
        success: false,
        message: "Invalid Wi-Fi password length.",
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

      DeviceProvision.findOne({
        deviceId,
      }).select("_id").lean(),

      Device.findOne({
        device_id: deviceId,
      }).select("_id").lean(),
    ]);

    if (
      productionDuplicate ||
      legacyProvisionDuplicate ||
      legacyDeviceDuplicate
    ) {
      return res.status(409).json({
        success: false,
        message: `Device ID ${deviceId} is already assigned.`,
      });
    }

    // Encrypt before changing the saved document.
    // If encryption fails, no partial provisioning update is saved.
    const encryptedSSID = encryptSecret(wifiSSID);
    const encryptedPassword = encryptSecret(wifiPassword);

    const requestId = crypto.randomUUID();

    const nextNvsVersion =
      Number(device.groupB?.nvsVersion || 0) + 1;

    const provisionedBy = actorId(req);
    const now = new Date();

    device.groupB.deviceId = deviceId;
    device.groupB.wifiSSIDEncrypted = encryptedSSID;
    device.groupB.wifiPasswordEncrypted = encryptedPassword;

    device.groupB.nvsVersion = nextNvsVersion;

    device.groupB.provisionStatus =
      ProductionDevice.PROVISION_STATUS.SENT;

    device.groupB.provisionSentAt = now;
    device.groupB.provisionedBy = provisionedBy;

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

    // Save request ID before publishing to avoid missing a fast ACK.
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
      device.groupB.provisionStatus =
        ProductionDevice.PROVISION_STATUS.FAILED;

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
        message: "MQTT provisioning failed.",
        data: publicDevice(device),
      });
    }

    return res.status(202).json({
      success: true,
      message: "Provisioning command sent. Waiting for device ACK.",
      data: publicDevice(device),
      provisioning: {
        topic: publishResult.topic,
        requestId: publishResult.requestId,
        nvsVersion: publishResult.nvsVersion,
        acknowledgement: "waiting",
      },
    });

  } catch (error) {
    console.error("[PRODUCTION GROUP B]", error);

    return res.status(
      error.code === 11000 ? 409 : 500
    ).json({
      success: false,
      message: error.message,
    });
  }
}

// --------------------------------------------------
// 5. LIVE TELEMETRY
// GET /devices/:id/live
// --------------------------------------------------

async function getProductionLiveTelemetry(req, res) {
  try {
    const device = await ProductionDevice.findOne(
      getDeviceQuery(req.params.id)
    ).select("serialNumber groupB.deviceId").lean();

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    const telemetry = getLatestProductionTelemetry(
      device.serialNumber
    );

    if (!telemetry) {
      return res.json({
        success: true,
        connected: false,
        data: null,
      });
    }

    return res.json({
      success: true,
      connected: telemetry.ageMs <= 90000,
      data: telemetry,
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
}

// --------------------------------------------------
// 6. CAPTURE NO-LOAD OR LOAD SAMPLE
//
// POST /devices/:id/calibration/captures/no-load
// POST /devices/:id/calibration/captures/load
//
// Body:
// {
//   "reference": {
//     "voltage": 230.5,
//     "current": 0,
//     "power": 0
//   }
// }
// --------------------------------------------------

async function captureCalibrationPoint(req, res) {
  try {
    const device = await findProductionDevice(req.params.id);

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    if (device.stage !== ProductionDevice.STAGE.CALIBRATION) {
      return res.status(409).json({
        success: false,
        message: "Device is not in the Calibration stage.",
      });
    }

    const point = String(req.params.point || "").toLowerCase();

    if (!["no-load", "load"].includes(point)) {
      return res.status(400).json({
        success: false,
        message: "Point must be no-load or load.",
      });
    }

    const telemetry = getLatestProductionTelemetry(
      device.serialNumber
    );

    if (!telemetry) {
      return res.status(409).json({
        success: false,
        message: "No telemetry received from this device yet.",
      });
    }

    if (telemetry.ageMs > 5000) {
      return res.status(409).json({
        success: false,
        message: "Telemetry is stale. Wait for a fresh reading.",
      });
    }

    if (
      telemetry.sampleFresh === false ||
      (
        telemetry.sampleAgeMs !== null &&
        telemetry.sampleAgeMs !== undefined &&
        Number(telemetry.sampleAgeMs) > 2000
      )
    ) {
      return res.status(409).json({
        success: false,
        message: "Firmware reported a stale telemetry sample.",
      });
    }

    if (typeof telemetry.relayOn !== "boolean") {
      return res.status(409).json({
        success: false,
        message: "Relay state is missing from device telemetry.",
      });
    }

    const expectedRelayOn = point === "load";

    if (telemetry.relayOn !== expectedRelayOn) {
      return res.status(409).json({
        success: false,
        message: expectedRelayOn
          ? "Turn the relay ON before recording load values."
          : "Turn the relay OFF before recording no-load values.",
      });
    }

    const raw = {
      rawVoltageRatio: finiteNumber(
        telemetry.rawVoltageRatio,
        "Raw voltage ratio"
      ),

      rawCurrentRatio: finiteNumber(
        telemetry.rawCurrentRatio,
        "Raw current ratio"
      ),

      rawPowerRatio: finiteNumber(
        telemetry.rawPowerRatio,
        "Raw power ratio"
      ),

      voltage: telemetry.voltage,
      current: telemetry.current,
      power: telemetry.power,
      relayOn: telemetry.relayOn,
    };

    const referenceInput =
      req.body?.reference || req.body || {};

    const reference = {
      voltage: finiteNumber(
        referenceInput.voltage,
        "Reference voltage"
      ),

      current: finiteNumber(
        referenceInput.current,
        "Reference current"
      ),

      power: finiteNumber(
        referenceInput.power,
        "Reference power"
      ),
    };

    if (reference.voltage <= 0) {
      return res.status(400).json({
        success: false,
        message: "Reference voltage must be greater than zero.",
      });
    }

    if (reference.current < 0 || reference.power < 0) {
      return res.status(400).json({
        success: false,
        message: "Reference current and power cannot be negative.",
      });
    }

    const capture = {
      capturedAt: new Date(),
      telemetryReceivedAt: telemetry.receivedAt,
      raw,
      reference,
    };

    if (point === "no-load") {
      device.calibration.noLoad = capture;
    } else {
      device.calibration.load = capture;
    }

    // Any new capture invalidates a previous calculation/application.
    device.calibration.coefficients = {};
    device.calibration.calculationDetails = null;
    device.calibration.calculatedAt = null;
    device.calibration.submittedAt = null;
    device.calibration.appliedAt = null;
    device.calibration.requestId = null;
    device.calibration.acknowledgement = {};
    // A changed calibration input invalidates old post-calibration verification.
device.calibration.verification = {
  noLoad: null,
  load: null,
  passed: null,
  verifiedAt: null,
};
    device.calibration.lastError = null;
    device.calibration.testStatus =
      ProductionDevice.TEST_STATUS.NOT_TESTED;

    device.calibration.status =
      ProductionDevice.CALIBRATION_STATUS.CAPTURING;

    device.updatedBy = actorId(req);

    await device.save();

    return res.status(201).json({
      success: true,
      message: `${point} sample captured.`,
      data: {
        serialNumber: device.serialNumber,
        point,
        capture,
      },
    });

  } catch (error) {
    return res.status(error.statusCode || 400).json({
      success: false,
      message: error.message,
    });
  }
}

// --------------------------------------------------
// 7. CALCULATE FIVE COEFFICIENTS
// POST /devices/:id/calibration/calculate
// --------------------------------------------------

function fitThroughOrigin(points) {
  const denominator = points.reduce(
    (sum, point) => sum + point.raw * point.raw,
    0
  );

  if (!Number.isFinite(denominator) || denominator <= 1e-18) {
    throw new Error("Raw voltage readings are too small to calculate vf.");
  }

  const numerator = points.reduce(
    (sum, point) => sum + point.raw * point.reference,
    0
  );

  const gain = numerator / denominator;

  if (!Number.isFinite(gain) || gain <= 0) {
    throw new Error("Calculated voltage factor must be positive.");
  }

  return gain;
}

function fitAffine(noLoad, load, label) {
  const rawSpan = load.raw - noLoad.raw;
  const referenceSpan = load.reference - noLoad.reference;

  if (Math.abs(rawSpan) <= 1e-9) {
    throw new Error(
      `Raw ${label} readings did not change enough between no-load and load.`
    );
  }

  const gain = referenceSpan / rawSpan;

  if (!Number.isFinite(gain) || gain <= 0) {
    throw new Error(
      `Calculated ${label} gain must be positive. Check the readings.`
    );
  }

  const zero = noLoad.raw - noLoad.reference / gain;
  const intercept = -zero * gain;

  if (!Number.isFinite(zero)) {
    throw new Error(`Calculated ${label} zero is invalid.`);
  }

  return { zero, gain, intercept };
}

async function calculateCalibration(req, res) {
  try {
    const device = await findProductionDevice(req.params.id);

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    if (device.stage !== ProductionDevice.STAGE.CALIBRATION) {
      return res.status(409).json({
        success: false,
        message: "Device is not in Calibration stage.",
      });
    }

    const hardware = String(
      device.groupA?.meteringHardware || ""
    ).trim().toUpperCase();

    if (hardware !== "HLW8032") {
      return res.status(409).json({
        success: false,
        message:
          `Automatic calibration currently supports HLW8032 only. Device uses ${hardware || "unknown"}.`,
      });
    }

    const noLoad = device.calibration?.noLoad;
    const load = device.calibration?.load;

    if (!noLoad || !load) {
      return res.status(409).json({
        success: false,
        message: "Capture both no-load and load readings first.",
      });
    }

    const voltagePoints = [
      {
        raw: noLoad.raw.rawVoltageRatio,
        reference: noLoad.reference.voltage,
      },
      {
        raw: load.raw.rawVoltageRatio,
        reference: load.reference.voltage,
      },
    ];

    const vf = fitThroughOrigin(voltagePoints);

    const currentFit = fitAffine(
      {
        raw: noLoad.raw.rawCurrentRatio,
        reference: noLoad.reference.current,
      },
      {
        raw: load.raw.rawCurrentRatio,
        reference: load.reference.current,
      },
      "current"
    );

    const powerFit = fitAffine(
      {
        raw: noLoad.raw.rawPowerRatio,
        reference: noLoad.reference.power,
      },
      {
        raw: load.raw.rawPowerRatio,
        reference: load.reference.power,
      },
      "power"
    );

    const coefficients = {
      vf: firmwareFloat(vf, "vf"),
      currentZero: firmwareFloat(currentFit.zero, "currentZero"),
      currentGain: firmwareFloat(currentFit.gain, "currentGain"),
      powerZero: firmwareFloat(powerFit.zero, "powerZero"),
      powerGain: firmwareFloat(powerFit.gain, "powerGain"),
    };

    const calculationDetails = {
      algorithm: "HLW8032_TWO_POINT_LINEAR",
      algorithmVersion: "1.0.0",
      calculatedAt: new Date(),

      firmwareEquations: {
        voltage: "voltage = rawVoltageRatio * vf",
        current:
          "current = (rawCurrentRatio - currentZero) * currentGain",
        power:
          "power = (rawPowerRatio - powerZero) * powerGain",
      },

      points: {
        noLoad: {
          raw: noLoad.raw,
          reference: noLoad.reference,
        },
        load: {
          raw: load.raw,
          reference: load.reference,
        },
      },

      fits: {
        current: currentFit,
        power: powerFit,
      },

      warnings: [
        "Two-point calibration determines the linear coefficients but does not independently verify linearity.",
        "Perform a post-calibration test before marking the device Tested.",
      ],
    };

    device.calibration.coefficients = coefficients;
    device.calibration.calculationDetails = calculationDetails;
    device.calibration.calculatedAt = new Date();

    device.calibration.status =
      ProductionDevice.CALIBRATION_STATUS.CALCULATED;

    device.calibration.lastError = null;
    device.updatedBy = actorId(req);

    await device.save();

    return res.json({
      success: true,
      message: "Calibration coefficients calculated.",
      data: {
        serialNumber: device.serialNumber,
        coefficients,
        calculationDetails,
      },
    });

  } catch (error) {
    console.error("[CALIBRATION CALCULATE]", error);

    return res.status(422).json({
      success: false,
      message: error.message,
    });
  }
}

// --------------------------------------------------
// 8. SUBMIT CALIBRATION TO FIRMWARE
// POST /devices/:id/calibration/submit
// --------------------------------------------------

async function submitCalibration(req, res) {
  try {
    const device = await findProductionDevice(req.params.id);

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    if (device.stage !== ProductionDevice.STAGE.CALIBRATION) {
      return res.status(409).json({
        success: false,
        message: "Device is not in Calibration stage.",
      });
    }


    const retryableStatuses = [
  ProductionDevice.CALIBRATION_STATUS.CALCULATED,
  ProductionDevice.CALIBRATION_STATUS.FAILED,
];

if (
  !retryableStatuses.includes(device.calibration.status) ||
  !device.calibration.calculatedAt
) {
  return res.status(409).json({
    success: false,
    message: "Calculate calibration before submitting.",
  });
}

    const coefficients = device.calibration.coefficients || {};

    const keys = [
      "vf",
      "currentZero",
      "currentGain",
      "powerZero",
      "powerGain",
    ];

    for (const key of keys) {
      if (!Number.isFinite(Number(coefficients[key]))) {
        return res.status(409).json({
          success: false,
          message: `Missing or invalid coefficient: ${key}`,
        });
      }
    }

    const latest = getLatestProductionTelemetry(
      device.serialNumber
    );

    if (!latest || latest.ageMs > 60000) {
      return res.status(409).json({
        success: false,
        message: "Device is not reporting fresh telemetry.",
      });
    }

    const requestId = crypto.randomUUID();
    const now = new Date();

    device.calibration.requestId = requestId;
    device.calibration.status =
      ProductionDevice.CALIBRATION_STATUS.SUBMITTED;

    device.calibration.submittedAt = now;
    device.calibration.acknowledgement = {
      status: "pending",
      action: "setCalibration",
      requestId,
      message: null,
      fwVersion: null,
      nvsVersion: null,
      receivedAt: null,
    };

    device.calibration.lastError = null;
    device.updatedBy = actorId(req);

    // A new calibration request needs a new post-calibration test.
device.calibration.appliedAt = null;

device.calibration.verification = {
  noLoad: null,
  load: null,
  passed: null,
  verifiedAt: null,
};

device.calibration.testStatus =
  ProductionDevice.TEST_STATUS.NOT_TESTED;

device.calibration.testedAt = null;
device.calibration.testedBy = null;
device.calibration.testNotes = "";

    // Save request correlation before MQTT publish.
    await device.save();

    try {
      const result = await publishCalibration({
        serialNumber: device.serialNumber,
        requestId,
        coefficients,
      });

      return res.status(202).json({
        success: true,
        message: "Calibration submitted. Waiting for firmware ACK.",
        data: {
          serialNumber: device.serialNumber,
          requestId,
          topic: result.topic,
          coefficients,
          acknowledgement: "waiting",
        },
      });

    } catch (publishError) {
      device.calibration.status =
        ProductionDevice.CALIBRATION_STATUS.FAILED;

      device.calibration.lastError = publishError.message;

      device.calibration.acknowledgement = {
        status: "error",
        action: "setCalibration",
        requestId,
        message: publishError.message,
        receivedAt: new Date(),
      };

      await device.save();

      return res.status(502).json({
        success: false,
        message: "Could not publish calibration to the device.",
      });
    }

  } catch (error) {
    console.error("[CALIBRATION SUBMIT]", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
}

// --------------------------------------------------
// 9. RELAY AND FAST TELEMETRY CONTROLS
// POST /devices/:id/commands
// --------------------------------------------------


async function sendProductionCommand(req, res) {
  try {
    const device = await findProductionDevice(req.params.id);

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    if (device.stage !== ProductionDevice.STAGE.CALIBRATION) {
      return res.status(409).json({
        success: false,
        message:
          "Device controls are available in Calibration stage.",
      });
    }

    const allowedActions = [
      "relayStart",
      "relayStop",
      "startFastTelemetry",
      "stopFastTelemetry",
    ];

    const action = String(req.body?.action || "").trim();

    if (!allowedActions.includes(action)) {
      return res.status(400).json({
        success: false,
        message: "Unsupported production device command.",
      });
    }

    if (!device.groupB?.deviceId) {
      return res.status(409).json({
        success: false,
        message: "Device has not been provisioned with a Device ID.",
      });
    }

    const latest = getLatestProductionTelemetry(
      device.serialNumber
    );

    if (!latest || latest.ageMs > 60000) {
      return res.status(409).json({
        success: false,
        message: "Device is offline or has stale telemetry.",
      });
    }

    const requestId = crypto.randomUUID();
    const now = new Date();

    // Atomically reserve the command slot.
    // A second command cannot overwrite an unacknowledged command.
    const updatedDevice = await ProductionDevice.findOneAndUpdate(
      {
        _id: device._id,
        "groupB.lastCommand.status": {
          $ne: "pending",
        },
      },
      {
        $set: {
          "groupB.lastCommand": {
            requestId,
            deviceId: device.groupB.deviceId,
            action,
            status: "pending",
            sentAt: now,
            acknowledgedAt: null,
            message: null,
          },
          updatedBy: actorId(req),
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!updatedDevice) {
      return res.status(409).json({
        success: false,
        message:
          "Another device command is still waiting for an ACK.",
      });
    }

    try {
const result = await publishProductionCommand({
  deviceId: device.groupB.deviceId,
  action,
  requestId,

  testMode: req.body?.testMode,
  durationSeconds: req.body?.durationSeconds,
  intervalMs: req.body?.intervalMs,
});

      return res.status(202).json({
        success: true,
        message:
          "Command published. Waiting for device acknowledgement.",
        data: {
          ...result,
          status: "pending",
        },
      });

    } catch (publishError) {
      // Preserve the failed attempt for the production record.
      await ProductionDevice.updateOne(
        {
          _id: device._id,
          "groupB.lastCommand.requestId": requestId,
        },
        {
          $set: {
            "groupB.lastCommand.status": "failed",
            "groupB.lastCommand.acknowledgedAt": new Date(),
            "groupB.lastCommand.message":
              String(publishError.message || "MQTT publish failed")
                .slice(0, 500),
          },
        }
      );

      return res.status(502).json({
        success: false,
        message: "Could not publish command to the device.",
      });
    }

  } catch (error) {
    console.error("[PRODUCTION COMMAND]", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
}


// --------------------------------------------------
// 10. CALIBRATION TEST CONFIRMATION
// POST /devices/:id/calibration/test
//
// Body:
// { result: "passed" | "failed", notes: "..." }
//
// A passed test moves the device to Dispatch-ready.
// It does NOT execute the Dispatch workflow.
// --------------------------------------------------


async function markCalibrationTest(req, res) {
  try {
    const device = await findProductionDevice(req.params.id);

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    if (device.stage !== ProductionDevice.STAGE.CALIBRATION) {
      return res.status(409).json({
        success: false,
        message: "Device is not in Calibration stage.",
      });
    }

    if (
      device.calibration.status !==
      ProductionDevice.CALIBRATION_STATUS.APPLIED
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Firmware must acknowledge calibration before testing.",
      });
    }

    const point = String(
      req.body?.point || ""
    ).trim().toLowerCase();

    // ------------------------------------------------
    // A. CAPTURE POST-CALIBRATION VERIFICATION
    // ------------------------------------------------

    if (point === "no-load" || point === "load") {
      const telemetry = getLatestProductionTelemetry(
        device.serialNumber
      );

      if (!telemetry) {
        return res.status(409).json({
          success: false,
          message: "No telemetry received from this device.",
        });
      }

      if (telemetry.ageMs > 5000) {
        return res.status(409).json({
          success: false,
          message: "Telemetry is stale. Wait for a fresh reading.",
        });
      }

      if (
        telemetry.sampleFresh === false ||
        (
          telemetry.sampleAgeMs !== null &&
          telemetry.sampleAgeMs !== undefined &&
          Number(telemetry.sampleAgeMs) > 2000
        )
      ) {
        return res.status(409).json({
          success: false,
          message: "Firmware reported a stale telemetry sample.",
        });
      }

      if (typeof telemetry.relayOn !== "boolean") {
        return res.status(409).json({
          success: false,
          message: "Relay state is missing from telemetry.",
        });
      }

      const expectedRelayOn = point === "load";

      if (telemetry.relayOn !== expectedRelayOn) {
        return res.status(409).json({
          success: false,
          message: expectedRelayOn
            ? "Turn the relay ON before capturing the load verification."
            : "Turn the relay OFF before capturing the no-load verification.",
        });
      }

      // These are actual device measurements from MQTT.
      const measured = {
        voltage: finiteNumber(
          telemetry.voltage,
          "Measured voltage"
        ),
        current: finiteNumber(
          telemetry.current,
          "Measured current"
        ),
        power: finiteNumber(
          telemetry.power,
          "Measured power"
        ),
      };

      // These are reference values read from the ER300P.
      const referenceInput = req.body?.reference || {};

      const reference = {
        voltage: finiteNumber(
          referenceInput.voltage,
          "ER300P reference voltage"
        ),
        current: finiteNumber(
          referenceInput.current,
          "ER300P reference current"
        ),
        power: finiteNumber(
          referenceInput.power,
          "ER300P reference power"
        ),
      };

      if (reference.voltage <= 0) {
        return res.status(400).json({
          success: false,
          message: "Reference voltage must be greater than zero.",
        });
      }

      if (reference.current < 0 || reference.power < 0) {
        return res.status(400).json({
          success: false,
          message:
            "Reference current and power cannot be negative.",
        });
      }

      if (
        point === "load" &&
        (reference.current <= 0 || reference.power <= 0)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Load verification requires positive reference current and power.",
        });
      }

      // Read controlled acceptance limits from environment.
      // Invalid environment values fall back to the defaults.
      const configuredTolerance = Number(
        process.env.PRODUCTION_CALIBRATION_TOLERANCE_PERCENT
      );

      const tolerancePercent =
        Number.isFinite(configuredTolerance) &&
        configuredTolerance > 0 &&
        configuredTolerance <= 10
          ? configuredTolerance
          : 2;

      const configuredNoLoadCurrent = Number(
        process.env.PRODUCTION_NO_LOAD_MAX_CURRENT_A
      );

      const noLoadMaxCurrentA =
        Number.isFinite(configuredNoLoadCurrent) &&
        configuredNoLoadCurrent >= 0
          ? configuredNoLoadCurrent
          : 0.10;

      const configuredNoLoadPower = Number(
        process.env.PRODUCTION_NO_LOAD_MAX_POWER_W
      );

      const noLoadMaxPowerW =
        Number.isFinite(configuredNoLoadPower) &&
        configuredNoLoadPower >= 0
          ? configuredNoLoadPower
          : 5;

      const percentError = (actual, expected) => {
        if (!Number.isFinite(actual) ||
            !Number.isFinite(expected) ||
            expected <= 0) {
          return null;
        }

        return Number(
          (Math.abs(actual - expected) / expected * 100)
            .toFixed(4)
        );
      };

      const errorPercent = {
        voltage: percentError(
          measured.voltage,
          reference.voltage
        ),
        current: percentError(
          measured.current,
          reference.current
        ),
        power: percentError(
          measured.power,
          reference.power
        ),
      };

      let checks;

      if (point === "no-load") {
        // Voltage is compared against ER300P.
        // Current and power use absolute zero-load limits.
        checks = {
          voltage:
            errorPercent.voltage !== null &&
            errorPercent.voltage <= tolerancePercent,

          current:
            Math.abs(measured.current) <= noLoadMaxCurrentA,

          power:
            Math.abs(measured.power) <= noLoadMaxPowerW,
        };

      } else {
        // Load verification compares all three measurements
        // against the ER300P percentage tolerance.
        checks = {
          voltage:
            errorPercent.voltage !== null &&
            errorPercent.voltage <= tolerancePercent,

          current:
            errorPercent.current !== null &&
            errorPercent.current <= tolerancePercent,

          power:
            errorPercent.power !== null &&
            errorPercent.power <= tolerancePercent,
        };
      }

      const passed = Object.values(checks).every(Boolean);

      const now = new Date();

      const capture = {
        capturedAt: now,
        telemetryReceivedAt: telemetry.receivedAt,

        measured,
        reference,
        errorPercent,
        checks,

        tolerancePercent,
        noLoadMaxCurrentA,
        noLoadMaxPowerW,

        passed,
      };

      if (!device.calibration.verification) {
        device.calibration.verification = {};
      }

      if (point === "no-load") {
        device.calibration.verification.noLoad = capture;
      } else {
        device.calibration.verification.load = capture;
      }

      const verification =
        device.calibration.verification;

      const bothCaptured =
        Boolean(verification.noLoad) &&
        Boolean(verification.load);

      verification.passed = bothCaptured
        ? Boolean(
            verification.noLoad.passed &&
            verification.load.passed
          )
        : null;

      verification.verifiedAt = bothCaptured ? now : null;

      // A new capture requires a new final test decision.
      device.calibration.testStatus =
        ProductionDevice.TEST_STATUS.NOT_TESTED;

      device.calibration.testedAt = null;
      device.calibration.testedBy = null;
      device.calibration.testNotes = "";

      device.updatedBy = actorId(req);

      await device.save();

      return res.status(201).json({
        success: true,
        message: `${point} verification captured.`,
        data: {
          serialNumber: device.serialNumber,
          point,
          capture,
          verification: {
            noLoadPassed:
              verification.noLoad?.passed ?? null,
            loadPassed:
              verification.load?.passed ?? null,
            overallPassed:
              verification.passed,
          },
        },
      });
    }

    // ------------------------------------------------
    // B. FINALIZE CALIBRATION TEST
    // ------------------------------------------------

    const result = String(
      req.body?.result || ""
    ).trim().toLowerCase();

    if (!["passed", "failed"].includes(result)) {
      return res.status(400).json({
        success: false,
        message:
          'Provide point="no-load"/"load" to capture readings, or result="passed"/"failed" to finalize.',
      });
    }

    const verification =
      device.calibration.verification || {};

    if (result === "passed") {
      if (!verification.noLoad || !verification.load) {
        return res.status(409).json({
          success: false,
          message:
            "Capture both no-load and load verification readings before passing the test.",
        });
      }

      if (
        verification.noLoad.passed !== true ||
        verification.load.passed !== true
      ) {
        return res.status(409).json({
          success: false,
          message:
            "Verification failed. Both no-load and load checks must pass before Dispatch.",
          data: {
            noLoad: verification.noLoad,
            load: verification.load,
          },
        });
      }
    }

    const now = new Date();

    device.calibration.testStatus =
      result === "passed"
        ? ProductionDevice.TEST_STATUS.PASSED
        : ProductionDevice.TEST_STATUS.FAILED;

    device.calibration.testedAt = now;
    device.calibration.testedBy = actorId(req);

    device.calibration.testNotes = String(
      req.body?.notes || ""
    ).trim().slice(0, 1000);

    if (result === "passed") {
      device.calibration.verification.passed = true;
      device.calibration.verification.verifiedAt =
        device.calibration.verification.verifiedAt || now;

      device.stage = ProductionDevice.STAGE.DISPATCH;
      device.stageUpdatedAt = now;
      device.dispatch.status = "ready";

    } else {
      device.stage = ProductionDevice.STAGE.CALIBRATION;
      device.dispatch.status = "not_ready";
    }

    device.updatedBy = actorId(req);

    await device.save();

    return res.json({
      success: true,
      message:
        result === "passed"
          ? "Calibration verification passed. Device is ready for Dispatch."
          : "Calibration test failed. Device remains in Calibration.",
      data: publicDevice(device),
    });

  } catch (error) {
    console.error("[CALIBRATION TEST]", error);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
}


// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  createGroupAEntries,
  listProductionDevices,
  getProductionDevice,
  promoteToGroupB,
  getProductionLiveTelemetry,
  captureCalibrationPoint,
  calculateCalibration,
  submitCalibration,
  sendProductionCommand,
  markCalibrationTest,
};
