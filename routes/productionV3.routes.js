const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const batchController = require("../controllers/productionV3/batch.controller");
const deviceController = require("../controllers/productionV3/device.controller");
const operationsController = require("../controllers/productionV3/operations.controller");
const profileController = require("../controllers/productionV3/profile.controller");
const calibrationController = require("../controllers/productionV3/calibration.controller");
const lifecycleController = require("../controllers/productionV3/lifecycle.controller");

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

router.post(
  "/batches/:batchId/complete",
  lifecycleController.completeBatch
);

router.post(
  "/batches/:batchId/close",
  lifecycleController.closeBatch
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
// CALIBRATION SESSION MANAGEMENT
// ==================================================

router.get(
  "/calibration/sessions",
  calibrationController.getSessions
);

router.get(
  "/calibration/sessions/:sessionId",
  calibrationController.getSessionById
);

router.post(
  "/devices/:serialNumber/calibration/sessions",
  calibrationController.createSession
);

router.post(
  "/calibration/sessions/:sessionId/captures",
  calibrationController.capturePoint
);

router.post(
  "/calibration/sessions/:sessionId/apply",
  calibrationController.applyCalibration
);

router.post(
  "/calibration/sessions/:sessionId/verify",
  calibrationController.verifyCalibration
);

router.post(
  "/calibration/sessions/:sessionId/cancel",
  calibrationController.cancelSession
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
// DEVICE DISPATCH
// ==================================================

router.post(
  "/devices/:serialNumber/dispatch",
  lifecycleController.dispatchDevice
);

module.exports = router;