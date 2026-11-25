const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const batchController = require("../controllers/productionV3/batch.controller");
const deviceController = require("../controllers/productionV3/device.controller");
const operationsController = require("../controllers/productionV3/operations.controller");
const profileController = require("../controllers/productionV3/profile.controller");

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

router.patch(
  "/batches/:batchId",
  batchController.updateBatch
);


// ==================================================
// PROFILE MANAGEMENT
// ==================================================

router.get(
  "/profiles/:profileType",
  profileController.getProfiles
);

router.get(
  "/profiles/:profileType/:profileId",
  profileController.getProfileById
);

router.post(
  "/profiles/:profileType",
  profileController.createProfile
);

router.patch(
  "/profiles/:profileType/:profileId",
  profileController.updateProfile
);


// ==================================================
// DEVICE INVENTORY
// ==================================================

router.get(
  "/devices",
  deviceController.getDevices
);

router.get(
  "/devices/:serialNumber/telemetry",
  operationsController.getFastTelemetry
);

router.get(
  "/devices/:serialNumber/commands",
  operationsController.getDeviceCommands
);

router.get(
  "/devices/:serialNumber",
  deviceController.getDeviceBySerial
);

router.patch(
  "/devices/:serialNumber",
  deviceController.updateDeviceDetails
);


// ==================================================
// GROUP B PROVISIONING AND IDENTITY
// ==================================================

router.post(
  "/devices/:serialNumber/promote",
  operationsController.promoteDevice
);

router.post(
  "/devices/:serialNumber/provision/retry",
  operationsController.retryProvisioning
);

router.post(
  "/devices/:serialNumber/identity-change",
  operationsController.changeDeviceIdentity
);


// ==================================================
// ADMIN COMMANDS
// ==================================================

router.post(
  "/devices/:serialNumber/admin-command",
  operationsController.sendAdminCommand
);


// ==================================================
// CALIBRATION
// ==================================================

router.post(
  "/devices/:serialNumber/calibration/apply",
  operationsController.applyCalibration
);

router.post(
  "/devices/:serialNumber/calibration/verify",
  operationsController.verifyCalibration
);

module.exports = router;