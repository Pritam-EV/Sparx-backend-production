const mongoose = require("mongoose");

const ProductionDevice = require("../../models/ProductionDevice");
const ProductionBatch = require("../../models/ProductionBatch");

const {
  refreshBatchCounts,
  refreshBatchCountsForDevice,
} = require("../../services/productionV3Lifecycle.service");

function normalizeSerial(value) {
  return String(value || "").trim().toUpperCase();
}

function sendError(res, error) {
  const status = error.statusCode || 500;

  return res.status(status).json({
    success: false,
    message:
      status === 500
        ? "Production lifecycle operation failed."
        : error.message,
    error:
      process.env.NODE_ENV === "development"
        ? error.message
        : undefined,
  });
}


// ==================================================
// DISPATCH DEVICE
// POST /devices/:serialNumber/dispatch
// ==================================================

exports.dispatchDevice = async (req, res) => {
  try {
    const serialNumber = normalizeSerial(req.params.serialNumber);

    const device = await ProductionDevice.findOne({
      serialNumber,
    });

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Production device not found.",
      });
    }

    if (device.manufacturingStatus !== "production_ready") {
      return res.status(409).json({
        success: false,
        message: "Only Production Ready devices can be dispatched.",
        currentStatus: device.manufacturingStatus,
      });
    }

    const dispatchReference =
      String(req.body.dispatchReference || "").trim();

    const recipient =
      String(req.body.recipient || "").trim();

    const destination =
      String(req.body.destination || "").trim();

    const notes =
      String(req.body.notes || "").trim();

    const dispatchedAt = req.body.dispatchedAt
      ? new Date(req.body.dispatchedAt)
      : new Date();

    if (Number.isNaN(dispatchedAt.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid dispatchedAt date.",
      });
    }

    device.dispatch = {
      dispatchReference: dispatchReference || null,
      recipient: recipient || null,
      destination: destination || null,
      notes,
      dispatchedAt,
      dispatchedBy: req.user?.userId || null,
    };

    device.manufacturingStatus = "dispatched";
    device.updatedBy = req.user?.userId || null;

    await device.save();
    await refreshBatchCountsForDevice(serialNumber);

    return res.json({
      success: true,
      message: "Device dispatched successfully.",
      data: {
        serialNumber,
        manufacturingStatus: device.manufacturingStatus,
        dispatch: device.dispatch,
      },
    });
  } catch (error) {
    console.error("[Production V3] dispatchDevice:", error);
    return sendError(res, error);
  }
};


// ==================================================
// COMPLETE PRODUCTION BATCH
// POST /batches/:batchId/complete
// ==================================================

exports.completeBatch = async (req, res) => {
  try {
    const { batchId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(batchId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid batch ID.",
      });
    }

    const batch = await ProductionBatch.findById(batchId);

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: "Production batch not found.",
      });
    }

    if (["closed", "cancelled"].includes(batch.status)) {
      return res.status(409).json({
        success: false,
        message: "Closed or cancelled batches cannot be completed.",
      });
    }

    const totalDevices = await ProductionDevice.countDocuments({
      batchId: batch._id,
    });

    if (totalDevices === 0) {
      return res.status(409).json({
        success: false,
        message: "The batch has no devices.",
      });
    }

    const incompleteDevices = await ProductionDevice.find({
      batchId: batch._id,
      manufacturingStatus: {
        $nin: [
          "production_ready",
          "dispatched",
          "retired",
        ],
      },
    })
      .select("serialNumber manufacturingStatus")
      .limit(20)
      .lean();

    if (incompleteDevices.length) {
      return res.status(409).json({
        success: false,
        message:
          "All devices must reach Production Ready, Dispatched or Retired before completing the batch.",
        incompleteDevices,
      });
    }

    await refreshBatchCounts(batch._id);

    batch.status = "production_completed";
    batch.actualCompletionDate = new Date();
    batch.updatedBy = req.user?.userId || null;

    await batch.save();

    return res.json({
      success: true,
      message: "Production batch marked as completed.",
      data: batch,
    });
  } catch (error) {
    console.error("[Production V3] completeBatch:", error);
    return sendError(res, error);
  }
};


// ==================================================
// CLOSE PRODUCTION BATCH
// POST /batches/:batchId/close
// ==================================================

exports.closeBatch = async (req, res) => {
  try {
    const { batchId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(batchId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid batch ID.",
      });
    }

    const batch = await ProductionBatch.findById(batchId);

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: "Production batch not found.",
      });
    }

    if (batch.status !== "production_completed") {
      return res.status(409).json({
        success: false,
        message:
          "Only production-completed batches can be closed.",
        currentStatus: batch.status,
      });
    }

    batch.status = "closed";
    batch.closedAt = new Date();
    batch.updatedBy = req.user?.userId || null;

    await batch.save();

    return res.json({
      success: true,
      message: "Production batch closed successfully.",
      data: batch,
    });
  } catch (error) {
    console.error("[Production V3] closeBatch:", error);
    return sendError(res, error);
  }
};