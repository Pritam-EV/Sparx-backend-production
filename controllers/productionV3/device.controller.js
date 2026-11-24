
/**
 * controllers/productionV3/device.controller.js
 *
 * VIZ Production 3.0 — Device Inventory
 *
 * Endpoints:
 *   GET /devices
 *   GET /devices/:serialNumber
 *
 * Uses ProductionDevice only.
 * Does not access legacy Device or DeviceProvision models.
 */

const mongoose = require("mongoose");
const ProductionDevice = require("../../models/ProductionDevice");

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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
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
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 50)
    );

    const filter = {};

    // -----------------------------------------------
    // Lifecycle status filter
    // -----------------------------------------------

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

    // -----------------------------------------------
    // Batch filter
    // -----------------------------------------------

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

    // -----------------------------------------------
    // Online/offline filter
    // -----------------------------------------------

    if (req.query.online !== undefined) {
      if (!["true", "false"].includes(req.query.online)) {
        return res.status(400).json({
          success: false,
          message: "online must be true or false.",
        });
      }

      filter["discovery.isOnline"] = req.query.online === "true";
    }

    // -----------------------------------------------
    // Serial number / Device ID search
    // -----------------------------------------------

    const search = normalizeString(req.query.search);

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");

      filter.$or = [
        { serialNumber: regex },
        { deviceId: regex },
      ];
    }

    // -----------------------------------------------
    // Query database
    // -----------------------------------------------

    const skip = (page - 1) * limit;

    const [devices, total] = await Promise.all([
      ProductionDevice.find(filter)
        .select("-wifiCredentials -identityHistory")
        .populate({
          path: "batchId",
          select: "batchNumber batchName project",
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
    console.error("[Production V3] getDevices error:", error);

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
 */
exports.getDeviceBySerial = async (req, res) => {
  try {
    const serialNumber = normalizeString(
      req.params.serialNumber
    ).toUpperCase();

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
        select: "batchNumber batchName project hardwareRevision pcbBatch status",
      })
      .populate({
        path: "productionProfileId",
        select: "profileName profileCode",
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
    console.error("[Production V3] getDeviceBySerial error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch production device.",
    });
  }
};
