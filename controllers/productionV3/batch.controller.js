
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
const ProductionProfile = require("../../models/ProductionProfile");
const FirmwareProfile = require("../../models/FirmwareProfile");
const CalibrationProfile = require("../../models/CalibrationProfile");

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

/**
 * PATCH /api/production/v3/batches/:batchId
 *
 * Updates batch manufacturing metadata.
 *
 * Restrictions:
 * - Batch serial range and generated serial numbers are immutable.
 * - Quantity and lifecycle counters are not editable here.
 * - Metadata can only be edited while every device in the batch
 *   is still in Group A.
 * - Profile assignments are propagated to the Group A devices.
 */

const BATCH_EDITABLE_FIELDS = [
  "batchName",
  "description",
  "project",
  "customerName",
  "hardwareRevision",
  "pcbBatch",
  "chargerType",
  "meteringHardware",
  "productionProfileId",
  "firmwareProfileId",
  "calibrationProfileId",
  "plannedStartDate",
  "plannedCompletionDate",
  "manufacturingLocation",
  "area",
  "city",
  "state",
  "country",
  "notes",
];

const BATCH_REQUIRED_STRING_FIELDS = [
  "batchName",
  "hardwareRevision",
];

const BATCH_NULLABLE_FIELDS = [
  "description",
  "project",
  "customerName",
  "pcbBatch",
  "chargerType",
  "meteringHardware",
  "plannedStartDate",
  "plannedCompletionDate",
  "manufacturingLocation",
  "area",
  "city",
  "state",
  "country",
  "notes",
];

exports.updateBatch = async (req, res) => {
  const mongoSession = await mongoose.startSession();

  try {
    const { batchId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(batchId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid batch ID.",
      });
    }

    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body)
    ) {
      return res.status(400).json({
        success: false,
        message: "Request body must be a JSON object.",
      });
    }

    const requestFields = Object.keys(req.body);

    if (requestFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one field must be provided.",
      });
    }

    const unsupportedFields = requestFields.filter(
      (field) => !BATCH_EDITABLE_FIELDS.includes(field)
    );

    if (unsupportedFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Unsupported batch update fields.",
        unsupportedFields,
        editableFields: BATCH_EDITABLE_FIELDS,
      });
    }

    const updates = {};

    // Validate string and nullable fields.
    for (const field of requestFields) {
      const value = req.body[field];

      if (field.endsWith("ProfileId")) {
        continue;
      }

      if (
        BATCH_REQUIRED_STRING_FIELDS.includes(field) &&
        (
          typeof value !== "string" ||
          !value.trim()
        )
      ) {
        return res.status(400).json({
          success: false,
          message: `${field} is required and must be a non-empty string.`,
        });
      }

      if (
        value === null &&
        BATCH_NULLABLE_FIELDS.includes(field)
      ) {
        updates[field] = null;
        continue;
      }

      if (field === "plannedStartDate" ||
          field === "plannedCompletionDate") {
        if (value === null) {
          updates[field] = null;
          continue;
        }

        const date = new Date(value);

        if (!Number.isFinite(date.getTime())) {
          return res.status(400).json({
            success: false,
            message: `${field} must be a valid date.`,
          });
        }

        updates[field] = date;
        continue;
      }

      if (typeof value !== "string") {
        return res.status(400).json({
          success: false,
          message: `${field} must be a string.`,
        });
      }

      updates[field] = value.trim();
    }

    // Validate profile references.
    const profileChecks = [
      {
        field: "productionProfileId",
        Model: ProductionProfile,
        query: { isActive: true },
      },
      {
        field: "firmwareProfileId",
        Model: FirmwareProfile,
        query: { status: "active" },
      },
      {
        field: "calibrationProfileId",
        Model: CalibrationProfile,
        query: { status: "active" },
      },
    ];

    for (const profile of profileChecks) {
      if (
        !Object.prototype.hasOwnProperty.call(
          req.body,
          profile.field
        )
      ) {
        continue;
      }

      const value = req.body[profile.field];

      if (value === null || value === "") {
        updates[profile.field] = null;
        continue;
      }

      if (!mongoose.Types.ObjectId.isValid(value)) {
        return res.status(400).json({
          success: false,
          message: `${profile.field} is invalid.`,
        });
      }

      const existingProfile = await profile.Model.exists({
        _id: value,
        ...profile.query,
      });

      if (!existingProfile) {
        return res.status(404).json({
          success: false,
          message: `${profile.field} does not reference an active profile.`,
        });
      }

      updates[profile.field] =
        new mongoose.Types.ObjectId(value);
    }

    updates.updatedBy = req.user?.userId || null;

    await mongoSession.withTransaction(async () => {
      const batch = await ProductionBatch.findById(batchId)
        .session(mongoSession);

      if (!batch) {
        const error = new Error("Production batch not found.");
        error.statusCode = 404;
        throw error;
      }

      if (["closed", "cancelled"].includes(batch.status)) {
        const error = new Error(
          "Closed or cancelled batches cannot be edited."
        );
        error.statusCode = 409;
        throw error;
      }

      // Do not change the shared manufacturing configuration
      // after any device has left Group A.
      const devicesOutsideGroupA =
        await ProductionDevice.countDocuments({
          batchId: batch._id,
          manufacturingStatus: { $ne: "group_a" },
        }).session(mongoSession);

      if (devicesOutsideGroupA > 0) {
        const error = new Error(
          "Batch metadata cannot be edited after devices leave Group A."
        );
        error.statusCode = 409;
        throw error;
      }

      const resultingStart =
        updates.plannedStartDate !== undefined
          ? updates.plannedStartDate
          : batch.plannedStartDate;

      const resultingCompletion =
        updates.plannedCompletionDate !== undefined
          ? updates.plannedCompletionDate
          : batch.plannedCompletionDate;

      if (
        resultingStart &&
        resultingCompletion &&
        resultingCompletion < resultingStart
      ) {
        const error = new Error(
          "plannedCompletionDate cannot be earlier than plannedStartDate."
        );
        error.statusCode = 400;
        throw error;
      }

      await ProductionBatch.updateOne(
        { _id: batch._id },
        { $set: updates },
        {
          session: mongoSession,
          runValidators: true,
        }
      );

      // Keep individual device profile references aligned
      // with the updated batch profile assignments.
      const deviceProfileUpdates = {};

      for (const field of [
        "productionProfileId",
        "firmwareProfileId",
        "calibrationProfileId",
      ]) {
        if (
          Object.prototype.hasOwnProperty.call(
            updates,
            field
          )
        ) {
          deviceProfileUpdates[field] = updates[field];
        }
      }

      if (Object.keys(deviceProfileUpdates).length > 0) {
        deviceProfileUpdates.updatedBy =
          req.user?.userId || null;

        await ProductionDevice.updateMany(
          {
            batchId: batch._id,
            manufacturingStatus: "group_a",
          },
          {
            $set: deviceProfileUpdates,
          },
          {
            session: mongoSession,
            runValidators: true,
          }
        );
      }
    });

    const updatedBatch = await ProductionBatch.findById(
      batchId
    ).lean();

    return res.status(200).json({
      success: true,
      message: "Production batch updated successfully.",
      data: updatedBatch,
    });
  } catch (error) {
    console.error(
      "[Production V3] updateBatch error:",
      error
    );

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Batch validation failed.",
        errors: Object.values(error.errors).map(
          (item) => item.message
        ),
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to update production batch.",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  } finally {
    await mongoSession.endSession();
  }
};