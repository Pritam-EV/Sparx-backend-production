
/**
 * controllers/productionV3/batch.controller.js
 *
 * VIZ Production 3.0
 *
 * Manufacturing batch creation and retrieval.
 *
 * Uses only the new Production 3.0 models.
 * Does not modify legacy DeviceProvision or Device models.
 */

const mongoose = require("mongoose");

const ProductionBatch = require("../../models/ProductionBatch");
const ProductionDevice = require("../../models/ProductionDevice");

const VALID_BATCH_STATUSES = [
  "draft",
  "created",
  "in_production",
  "production_completed",
  "closed",
  "cancelled",
];

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function generateSerialNumber(prefix, sequence, padding) {
  return `${prefix}${String(sequence).padStart(padding, "0")}`;
}

/**
 * POST /api/production/v3/batches
 *
 * Creates a manufacturing batch and its Group A devices.
 */
exports.createBatch = async (req, res) => {
  const mongoSession = await mongoose.startSession();

  try {
    const {
      batchNumber,
      batchName,
      description,
      project,
      customerName,
      hardwareRevision,
      pcbBatch,
      chargerType,
      meteringHardware,
      plannedQuantity,
      serialNumberPrefix,
      serialNumberStart,
      serialNumberPadding,
      productionProfileId,
      firmwareProfileId,
      calibrationProfileId,
      plannedStartDate,
      plannedCompletionDate,
      manufacturingLocation,
      area,
      city,
      state,
      country,
      notes,
    } = req.body;

    // --------------------------------------------------
    // 1. Validate required fields
    // --------------------------------------------------

    const normalizedBatchNumber = normalizeString(batchNumber).toUpperCase();
    const normalizedBatchName = normalizeString(batchName);
    const normalizedHardwareRevision = normalizeString(hardwareRevision);
    const normalizedPrefix = normalizeString(serialNumberPrefix).toUpperCase();

    if (!normalizedBatchNumber || !normalizedBatchName) {
      return res.status(400).json({
        success: false,
        message: "batchNumber and batchName are required.",
      });
    }

    if (!normalizedHardwareRevision) {
      return res.status(400).json({
        success: false,
        message: "hardwareRevision is required.",
      });
    }

    if (!normalizedPrefix) {
      return res.status(400).json({
        success: false,
        message: "serialNumberPrefix is required.",
      });
    }

    const quantity = Number(plannedQuantity);
    const startNumber = Number(serialNumberStart);
    const padding =
      serialNumberPadding === undefined
        ? 4
        : Number(serialNumberPadding);

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5000) {
      return res.status(400).json({
        success: false,
        message: "plannedQuantity must be an integer between 1 and 5000.",
      });
    }

    if (!Number.isSafeInteger(startNumber) || startNumber < 1) {
      return res.status(400).json({
        success: false,
        message: "serialNumberStart must be a positive integer.",
      });
    }

    if (!Number.isInteger(padding) || padding < 1 || padding > 12) {
      return res.status(400).json({
        success: false,
        message: "serialNumberPadding must be between 1 and 12.",
      });
    }

    const endNumber = startNumber + quantity - 1;

    if (!Number.isSafeInteger(endNumber)) {
      return res.status(400).json({
        success: false,
        message: "Serial number range is invalid.",
      });
    }

    // Prevent ambiguous serial formats.
    if (!/^[A-Z0-9_-]+$/.test(normalizedPrefix)) {
      return res.status(400).json({
        success: false,
        message: "Serial number prefix may contain only letters, numbers, _ and -.",
      });
    }

    // --------------------------------------------------
    // 2. Validate optional profile IDs
    // --------------------------------------------------

    const profileIds = [
      productionProfileId,
      firmwareProfileId,
      calibrationProfileId,
    ].filter(Boolean);

    for (const id of profileIds) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: `Invalid profile ID: ${id}`,
        });
      }
    }

    // --------------------------------------------------
    // 3. Generate serial numbers
    // --------------------------------------------------

    const serialNumbers = [];

    for (let i = 0; i < quantity; i += 1) {
      serialNumbers.push(
        generateSerialNumber(
          normalizedPrefix,
          startNumber + i,
          padding
        )
      );
    }

    // Ensure the generated serials are unique within this batch.
    if (new Set(serialNumbers).size !== serialNumbers.length) {
      return res.status(400).json({
        success: false,
        message: "Generated serial numbers are not unique.",
      });
    }

    // --------------------------------------------------
    // 4. Create batch and devices atomically
    // --------------------------------------------------

    await mongoSession.withTransaction(async () => {
      // Check batch number before creation.
      const existingBatch = await ProductionBatch.findOne({
        batchNumber: normalizedBatchNumber,
      }).session(mongoSession);

      if (existingBatch) {
        const error = new Error("Batch number already exists.");
        error.statusCode = 409;
        throw error;
      }

      // Check whether any generated serial already exists.
      const existingDevice = await ProductionDevice.findOne({
        serialNumber: { $in: serialNumbers },
      }).session(mongoSession);

      if (existingDevice) {
        const error = new Error(
          `Serial number ${existingDevice.serialNumber} already exists.`
        );
        error.statusCode = 409;
        throw error;
      }

      const batch = new ProductionBatch({
        batchNumber: normalizedBatchNumber,
        batchName: normalizedBatchName,
        description: normalizeString(description),

        project: normalizeString(project) || null,
        customerName: normalizeString(customerName) || null,

        hardwareRevision: normalizedHardwareRevision,
        pcbBatch: normalizeString(pcbBatch) || null,
        chargerType: normalizeString(chargerType) || null,
        meteringHardware: normalizeString(meteringHardware) || null,

        plannedQuantity: quantity,
        actualQuantity: quantity,

        serialNumberPrefix: normalizedPrefix,
        serialNumberStart: startNumber,
        serialNumberEnd: endNumber,
        serialNumberPadding: padding,

        productionProfileId: productionProfileId || null,
        firmwareProfileId: firmwareProfileId || null,
        calibrationProfileId: calibrationProfileId || null,

        plannedStartDate: plannedStartDate
          ? new Date(plannedStartDate)
          : null,

        plannedCompletionDate: plannedCompletionDate
          ? new Date(plannedCompletionDate)
          : null,

        manufacturingLocation: normalizeString(manufacturingLocation) || null,
        area: normalizeString(area) || null,
        city: normalizeString(city) || null,
        state: normalizeString(state) || null,
        country: normalizeString(country) || "India",

        status: "created",

        deviceCounts: {
          groupA: quantity,
          discovered: 0,
          groupB: 0,
          calibrationRequired: 0,
          calibrating: 0,
          calibrationFailed: 0,
          productionReady: 0,
          dispatched: 0,
        },

        notes: normalizeString(notes),
        createdBy: req.user?.userId || null,
        updatedBy: req.user?.userId || null,
      });

      await batch.save({ session: mongoSession });

      const deviceDocuments = serialNumbers.map((serialNumber) => ({
        serialNumber,

        batchId: batch._id,

        productionProfileId: productionProfileId || null,
        firmwareProfileId: firmwareProfileId || null,
        calibrationProfileId: calibrationProfileId || null,

        manufacturingStatus: "group_a",

        firmwareFamily: null,
        protocolVersion: null,
        firmwareVersion: null,

        discovery: {
          isOnline: false,
        },

        provisioning: {
          status: "not_started",
          desiredConfigVersion: 0,
          appliedConfigVersion: 0,
        },

        calibration: {
          status: "calibration_required",
        },

        createdBy: req.user?.userId || null,
        updatedBy: req.user?.userId || null,
      }));

      await ProductionDevice.insertMany(deviceDocuments, {
        session: mongoSession,
        ordered: true,
      });

      req.createdBatchId = batch._id;
    });

    // --------------------------------------------------
    // 5. Return created batch
    // --------------------------------------------------

    const createdBatch = await ProductionBatch.findById(
      req.createdBatchId
    ).lean();

    return res.status(201).json({
      success: true,
      message: "Production batch created successfully.",
      data: {
        batch: createdBatch,
        generatedSerialNumbers: serialNumbers,
        generatedCount: serialNumbers.length,
      },
    });
  } catch (error) {
    console.error("[Production V3] createBatch error:", error);

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Batch number or one of the serial numbers already exists.",
        duplicateKey: error.keyValue || null,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to create production batch.",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  } finally {
    await mongoSession.endSession();
  }
};


/**
 * GET /api/production/v3/batches
 *
 * Paginated batch listing.
 */
exports.getBatches = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number(req.query.limit) || 20)
    );

    const filter = {};

    if (req.query.status) {
      if (!VALID_BATCH_STATUSES.includes(req.query.status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid batch status.",
        });
      }

      filter.status = req.query.status;
    }

    if (req.query.search) {
      const search = normalizeString(req.query.search);

      if (search) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        filter.$or = [
          { batchNumber: { $regex: escaped, $options: "i" } },
          { batchName: { $regex: escaped, $options: "i" } },
          { project: { $regex: escaped, $options: "i" } },
        ];
      }
    }

    const skip = (page - 1) * limit;

    const [batches, total] = await Promise.all([
      ProductionBatch.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      ProductionBatch.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: batches,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("[Production V3] getBatches error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch production batches.",
    });
  }
};


/**
 * GET /api/production/v3/batches/:batchId
 *
 * Returns batch details and its associated devices.
 */
exports.getBatchById = async (req, res) => {
  try {
    const { batchId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(batchId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid batch ID.",
      });
    }

    const batch = await ProductionBatch.findById(batchId).lean();

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: "Production batch not found.",
      });
    }

    const devices = await ProductionDevice.find({
      batchId: batch._id,
    })
      .select(
        "serialNumber deviceId manufacturingStatus firmwareVersion discovery provisioning calibration createdAt"
      )
      .sort({ serialNumber: 1 })
      .lean();

    return res.json({
      success: true,
      data: {
        batch,
        devices,
        deviceCount: devices.length,
      },
    });
  } catch (error) {
    console.error("[Production V3] getBatchById error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch production batch.",
    });
  }
};
