
// routes/productionV3.routes.js

const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const controller = require("../controllers/productionV3.controller");

router.use(authMiddleware, authorizeRoles("admin"));

// GROUP A
router.post("/group-a", controller.createGroupAEntries);

// DEVICE LIST AND DETAILS
router.get("/devices", controller.listProductionDevices);
router.get("/devices/:id/live", controller.getProductionLiveTelemetry);
router.get("/devices/:id", controller.getProductionDevice);

// GROUP B
router.post("/devices/:id/group-b", controller.promoteToGroupB);

// CALIBRATION
router.post(
  "/devices/:id/calibration/captures/:point",
  controller.captureCalibrationPoint
);

router.post(
  "/devices/:id/calibration/calculate",
  controller.calculateCalibration
);

router.post(
  "/devices/:id/calibration/submit",
  controller.submitCalibration
);

router.post(
  "/devices/:id/calibration/test",
  controller.markCalibrationTest
);

// CALIBRATION WORKBENCH CONTROLS
router.post(
  "/devices/:id/commands",
  controller.sendProductionCommand
);

module.exports = router;
