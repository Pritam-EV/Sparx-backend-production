
const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const controller = require("../controllers/deviceMaintenance.controller");

router.use(authMiddleware, authorizeRoles("admin"));

router.get("/devices", controller.listDevices);

router.get("/devices/:id", controller.getDevice);

router.patch(
  "/devices/:id/database",
  controller.updateDatabase
);

router.post(
  "/devices/:id/firmware/config",
  controller.updateFirmwareConfig
);

router.post(
  "/devices/:id/firmware/calibration",
  controller.updateCalibration
);

router.post(
  "/devices/:id/commands",
  controller.sendCommand
);

router.get(
  "/devices/:id/history",
  controller.getHistory
);

module.exports = router;
