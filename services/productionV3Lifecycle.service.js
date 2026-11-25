const mongoose = require("mongoose");

const ProductionBatch = require("../models/ProductionBatch");
const ProductionDevice = require("../models/ProductionDevice");

const STATUS_TO_COUNT_FIELD = {
  group_a: "groupA",
  discovered: "discovered",
  group_b: "groupB",
  calibration_required: "calibrationRequired",
  calibrating: "calibrating",
  calibration_failed: "calibrationFailed",
  production_ready: "productionReady",
  dispatched: "dispatched",
};

async function refreshBatchCounts(batchId) {
  if (!batchId || !mongoose.Types.ObjectId.isValid(String(batchId))) {
    return null;
  }

  const batchObjectId =
    new mongoose.Types.ObjectId(String(batchId));

  const rows = await ProductionDevice.aggregate([
    {
      $match: {
        batchId: batchObjectId,
      },
    },
    {
      $group: {
        _id: "$manufacturingStatus",
        count: { $sum: 1 },
      },
    },
  ]);

  const deviceCounts = {
    groupA: 0,
    discovered: 0,
    groupB: 0,
    calibrationRequired: 0,
    calibrating: 0,
    calibrationFailed: 0,
    productionReady: 0,
    dispatched: 0,
  };

  for (const row of rows) {
    const field = STATUS_TO_COUNT_FIELD[row._id];

    if (field) {
      deviceCounts[field] = row.count;
    }
  }

const actualQuantity = rows.reduce(
  (sum, row) => sum + row.count,
  0
);

  const batch = await ProductionBatch.findById(batchObjectId)
    .select("status");

  if (!batch) return null;

  const updates = {
    deviceCounts,
    actualQuantity,
  };

  const devicesHaveStartedProduction =
    deviceCounts.discovered +
    deviceCounts.groupB +
    deviceCounts.calibrationRequired +
    deviceCounts.calibrating +
    deviceCounts.calibrationFailed +
    deviceCounts.productionReady +
    deviceCounts.dispatched;

  if (
    batch.status === "created" &&
    devicesHaveStartedProduction > 0
  ) {
    updates.status = "in_production";
    updates.actualStartDate = new Date();
  }

  await ProductionBatch.updateOne(
    { _id: batchObjectId },
    { $set: updates }
  );

  return {
    deviceCounts,
    actualQuantity,
  };
}

async function refreshBatchCountsForDevice(serialNumber) {
  const device = await ProductionDevice.findOne({
    serialNumber: String(serialNumber || "").trim().toUpperCase(),
  }).select("batchId");

  if (!device?.batchId) return null;

  return refreshBatchCounts(device.batchId);
}

module.exports = {
  refreshBatchCounts,
  refreshBatchCountsForDevice,
};