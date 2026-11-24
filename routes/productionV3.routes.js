
/**
 * routes/productionV3.routes.js
 *
 * VIZ Production 3.0 API Router
 */

const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const batchController = require("../controllers/productionV3/batch.controller");
const deviceController = require("../controllers/productionV3/device.controller");

// All Production 3.0 routes require an authenticated admin.
router.use(
  authMiddleware,
  authorizeRoles("admin")
);

// ==================================================
// BATCH MANAGEMENT
// ==================================================

router.post(
  "/batches",
  batchController.createBatch
);

router.get(
  "/batches",
  batchController.getBatches
);

router.get(
  "/batches/:batchId",
  batchController.getBatchById
);

// ==================================================
// DEVICE INVENTORY
// ==================================================

// Keep /devices before /devices/:serialNumber.
router.get(
  "/devices",
  deviceController.getDevices
);

router.get(
  "/devices/:serialNumber",
  deviceController.getDeviceBySerial
);

module.exports = router;
