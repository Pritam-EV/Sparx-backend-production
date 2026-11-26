// routes/productionV3.routes.js
// Admin-only routes for the simplified Production 3.0 workflow.

const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const {
  createGroupAEntries,
  listProductionDevices,
  getProductionDevice,
  promoteToGroupB,
} = require("../controllers/productionV3.controller");

router.use(authMiddleware, authorizeRoles("admin"));

router.post("/group-a", createGroupAEntries);
router.get("/devices", listProductionDevices);
router.get("/devices/:id", getProductionDevice);
router.post("/devices/:id/group-b", promoteToGroupB);

module.exports = router;
