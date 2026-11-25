/**
 * controllers/productionV3/device.controller.js
 *
 * VIZ Production 3.0 — Device Inventory
 *
 * Endpoints:
 *   GET   /devices
 *   GET   /devices/:serialNumber
 *   PATCH /devices/:serialNumber
 *
 * Uses Production 3.0 models only.
 * Does not access legacy Device or DeviceProvision models.
 *
 * Group A edit rules:
 * - Device details can be edited only while manufacturingStatus is group_a.
 * - Factory serialNumber is immutable.
 * - deviceId and manufacturingStatus cannot be changed through this endpoint.
 * - Profile documents are referenced, never modified by this controller.
 */

const mongoose = require("mongoose");

const ProductionDevice = require("../../models/ProductionDevice");
const ProductionProfile = require("../../models/ProductionProfile");
const FirmwareProfile = require("../../models/FirmwareProfile");
const CalibrationProfile = require("../../models/CalibrationProfile");

const DEVICE_STATUSES = [
  "group_a",
  "discovered",
  "group_b",
  "calibration_required",
  "calibrating",
  "calibration_failed",
  "production_ready",
  "dispatched",
  "retired",
];

// Fields accepted by PATCH /devices/:serialNumber.
// Keep this allowlist explicit. Do not replace it with unrestricted
// req.body assignment or Object.assign().
const DEVICE_EDITABLE_FIELDS = [
  "productionProfileId",
  "firmwareProfileId",
  "calibrationProfileId",
  "notes",
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSerialNumber(value) {
  return normalizeString(value).toUpperCase();
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

/**
 * Validates a profile reference supplied in the request.
 *
 * null or "" means clear the reference.
 * A non-empty value must be a valid ObjectId and point to an
 * existing document.
 */
async function validateProfileReference({
  value,
  fieldName,
  Model,
}) {
  if (value === null || value === "") {
    return {
      valid: true,
      value: null,
    };
  }

  if (!mongoose.Types.ObjectId.isValid(value)) {
    return {
      valid: false,
      statusCode: 400,
      message: `${fieldName} must be a valid MongoDB ObjectId or null.`,
    };
  }

  const exists = await Model.exists({
    _id: value,
  });

  if (!exists) {
    return {
      valid: false,
      statusCode: 404,
      message: `${fieldName} references a profile that does not exist.`,
    };
  }

  return {
    valid: true,
    value: new mongoose.Types.ObjectId(value),
  };
}

/**
 * GET /api/production/v3/devices
 *
 * Query parameters:
 *   page=1
 *   limit=50
 *   search=VIZ001
 *   status=group_a
 *   batchId=<MongoDB ObjectId>
 *   online=true|false
 *
 * Returns paginated device inventory.
 */
exports.getDevices = async (req, res) => {
  try {
    const page = Math.max(
      1,
      Number.parseInt(req.query.page, 10) || 1
    );

    const limit = Math.min(
      100,
      Math.max(
        1,
        Number.parseInt(req.query.limit, 10) || 50
      )
    );

    const filter = {};

    // Lifecycle status filter.
    const status = normalizeString(req.query.status);

    if (status) {
      if (!DEVICE_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid manufacturing status.",
          allowedStatuses: DEVICE_STATUSES,
        });
      }

      filter.manufacturingStatus = status;
    }

    // Batch filter.
    const batchId = normalizeString(req.query.batchId);

    if (batchId) {
      if (!mongoose.Types.ObjectId.isValid(batchId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid batchId.",
        });
      }

      filter.batchId = new mongoose.Types.ObjectId(batchId);
    }

    // Online/offline filter.
    if (req.query.online !== undefined) {
      if (!["true", "false"].includes(req.query.online)) {
        return res.status(400).json({
          success: false,
          message: "online must be true or false.",
        });
      }

      filter["discovery.isOnline"] =
        req.query.online === "true";
    }

    // Serial number / Device ID search.
    const search = normalizeString(req.query.search);

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");

      filter.$or = [
        { serialNumber: regex },
        { deviceId: regex },
      ];
    }

    const skip = (page - 1) * limit;

    const [devices, total] = await Promise.all([
      ProductionDevice.find(filter)
        .select("-wifiCredentials -identityHistory")
        .populate({
          path: "batchId",
          select: "batchNumber batchName project hardwareRevision pcbBatch status",
        })
        .populate({
          path: "productionProfileId",
          select: "profileName profileCode hardwareRevision chargerType meteringHardware",
        })
        .populate({
          path: "firmwareProfileId",
          select: "profileName profileCode profileVersion firmwareFamily targetFirmwareVersion protocolVersion",
        })
        .populate({
          path: "calibrationProfileId",
          select: "profileName profileCode profileVersion meteringHardware algorithm",
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      ProductionDevice.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: devices,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error(
      "[Production V3] getDevices error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch production devices.",
    });
  }
};


/**
 * GET /api/production/v3/devices/:serialNumber
 *
 * Returns one device using its immutable factory serial number.
 * The manufacturing details are returned through the associated
 * batch and production profile.
 */
exports.getDeviceBySerial = async (req, res) => {
  try {
    const serialNumber = normalizeSerialNumber(
      req.params.serialNumber
    );

    if (!serialNumber) {
      return res.status(400).json({
        success: false,
        message: "Serial number is required.",
      });
    }

    const device = await ProductionDevice.findOne({
      serialNumber,
    })
      .select("-wifiCredentials -identityHistory")
      .populate({
        path: "batchId",
        select: [
          "batchNumber",
          "batchName",
          "description",
          "project",
          "customerName",
          "hardwareRevision",
          "pcbBatch",
          "chargerType",
          "meteringHardware",
          "plannedQuantity",
          "actualQuantity",
          "manufacturingLocation",
          "area",
          "city",
          "state",
          "country",
          "status",
          "notes",
        ].join(" "),
      })
      .populate({
        path: "productionProfileId",
        select: [
          "profileName",
          "profileCode",
          "description",
          "project",
          "customerName",
          "hardwareRevision",
          "pcbBatch",
          "chargerType",
          "meteringHardware",
          "meteringHardwareRevision",
          "electricityBearer",
          "ratePerKwh",
          "vjraMargin",
          "serviceCharge",
          "gstPercentage",
          "location",
          "area",
          "city",
          "state",
          "country",
          "latitude",
          "longitude",
          "installationNotes",
          "notes",
          "isActive",
        ].join(" "),
      })
      .populate({
        path: "firmwareProfileId",
        select: "profileName profileCode profileVersion firmwareFamily targetFirmwareVersion protocolVersion supportedHardwareRevisions supportedMeteringHardware capabilities status",
      })
      .populate({
        path: "calibrationProfileId",
        select: "profileName profileCode profileVersion meteringHardware meteringHardwareRevision algorithm calibrationValues status",
      })
      .lean();

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
        serialNumber,
      });
    }

    return res.status(200).json({
      success: true,
      data: device,
    });
  } catch (error) {
    console.error(
      "[Production V3] getDeviceBySerial error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch production device.",
    });
  }
};


/**
 * PATCH /api/production/v3/devices/:serialNumber
 *
 * Updates an individual Group A device's profile assignments
 * and notes.
 *
 * Request body example:
 *
 * {
 *   "productionProfileId": "67...",
 *   "firmwareProfileId": "67...",
 *   "calibrationProfileId": "67...",
 *   "notes": "PCB inspected; enclosure pending"
 * }
 *
 * To clear a profile reference, send null:
 *
 * {
 *   "calibrationProfileId": null
 * }
 *
 * This endpoint intentionally does not accept:
 * - serialNumber
 * - deviceId
 * - batchId
 * - manufacturingStatus
 * - discovery
 * - provisioning
 * - calibration
 * - wifiCredentials
 *
 * Those fields belong to identity, lifecycle, discovery,
 * provisioning, calibration or security workflows.
 */
exports.updateDeviceDetails = async (req, res) => {
  try {
    const serialNumber = normalizeSerialNumber(
      req.params.serialNumber
    );

    if (!serialNumber) {
      return res.status(400).json({
        success: false,
        message: "Serial number is required.",
      });
    }

    if (!isPlainObject(req.body)) {
      return res.status(400).json({
        success: false,
        message: "Request body must be a JSON object.",
      });
    }

    const requestFields = Object.keys(req.body);

    if (requestFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one editable field must be provided.",
      });
    }

    // Explicitly call out immutable factory identity.
    if (Object.prototype.hasOwnProperty.call(
      req.body,
      "serialNumber"
    )) {
      return res.status(400).json({
        success: false,
        message: "Factory serialNumber is immutable and cannot be changed.",
      });
    }

    // Reject every field outside the allowlist.
    const unsupportedFields = requestFields.filter(
      (field) => !DEVICE_EDITABLE_FIELDS.includes(field)
    );

    if (unsupportedFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: "One or more fields cannot be updated through this endpoint.",
        unsupportedFields,
        editableFields: DEVICE_EDITABLE_FIELDS,
      });
    }

    // Check whether the device exists and is still in Group A.
    const existingDevice = await ProductionDevice.findOne({
      serialNumber,
    })
      .select("serialNumber manufacturingStatus")
      .lean();

    if (!existingDevice) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
        serialNumber,
      });
    }

    if (
  !["group_a", "discovered"].includes(
    existingDevice.manufacturingStatus
  )
) {
      return res.status(409).json({
        success: false,
        message: "Device details can only be edited while the device is in Group A.",
        currentStatus: existingDevice.manufacturingStatus,
      });
    }

    const updates = {};

    // Validate profile references independently.
    const profileFields = [
      {
        fieldName: "productionProfileId",
        Model: ProductionProfile,
      },
      {
        fieldName: "firmwareProfileId",
        Model: FirmwareProfile,
      },
      {
        fieldName: "calibrationProfileId",
        Model: CalibrationProfile,
      },
    ];

    for (const profileField of profileFields) {
      const { fieldName, Model } = profileField;

      if (
        !Object.prototype.hasOwnProperty.call(
          req.body,
          fieldName
        )
      ) {
        continue;
      }

      const validation = await validateProfileReference({
        value: req.body[fieldName],
        fieldName,
        Model,
      });

      if (!validation.valid) {
        return res.status(validation.statusCode).json({
          success: false,
          message: validation.message,
        });
      }

      updates[fieldName] = validation.value;
    }

    // Validate notes.
    if (
      Object.prototype.hasOwnProperty.call(
        req.body,
        "notes"
      )
    ) {
      if (typeof req.body.notes !== "string") {
        return res.status(400).json({
          success: false,
          message: "notes must be a string.",
        });
      }

      const notes = req.body.notes.trim();

      if (notes.length > 2000) {
        return res.status(400).json({
          success: false,
          message: "notes cannot exceed 2000 characters.",
        });
      }

      updates.notes = notes;
    }

    updates.updatedBy = req.user?.userId || null;

    // The status condition is part of the update filter.
    // If the device is promoted concurrently, this update will not
    // succeed after it leaves Group A.
    const updatedDevice = await ProductionDevice.findOneAndUpdate(
      {
        serialNumber,
        manufacturingStatus: {
  $in: ["group_a", "discovered"],
},
      },
      {
        $set: updates,
      },
      {
        new: true,
        runValidators: true,
        context: "query",
      }
    )
      .select("-wifiCredentials -identityHistory")
      .lean();

    if (!updatedDevice) {
      const latestDevice = await ProductionDevice.findOne({
        serialNumber,
      })
        .select("manufacturingStatus")
        .lean();

      if (!latestDevice) {
        return res.status(404).json({
          success: false,
          message: "Production device not found.",
          serialNumber,
        });
      }

      return res.status(409).json({
        success: false,
        message: "Device is no longer in Group A. Its details cannot be edited.",
        currentStatus: latestDevice.manufacturingStatus,
      });
    }

    // Populate the returned detail record in the same format as GET.
    const populatedDevice = await ProductionDevice.findById(
      updatedDevice._id
    )
      .select("-wifiCredentials -identityHistory")
      .populate({
        path: "batchId",
        select: "batchNumber batchName project hardwareRevision pcbBatch chargerType meteringHardware status",
      })
      .populate({
        path: "productionProfileId",
        select: "profileName profileCode hardwareRevision chargerType meteringHardware electricityBearer ratePerKwh vjraMargin serviceCharge gstPercentage location area city state country latitude longitude",
      })
      .populate({
        path: "firmwareProfileId",
        select: "profileName profileCode profileVersion firmwareFamily targetFirmwareVersion protocolVersion",
      })
      .populate({
        path: "calibrationProfileId",
        select: "profileName profileCode profileVersion meteringHardware algorithm",
      })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Group A device details updated successfully.",
      data: populatedDevice,
    });
  } catch (error) {
    console.error(
      "[Production V3] updateDeviceDetails error:",
      error
    );

    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Device update validation failed.",
        errors: Object.values(error.errors).map(
          (item) => item.message
        ),
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "The update conflicts with an existing unique value.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to update production device.",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
};