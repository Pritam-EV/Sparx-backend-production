const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const { createOperatorRequest } = require("../controllers/operatorController");

router.post(
  "/request",
  authMiddleware,
  createOperatorRequest
);
// Add at bottom of routes/operator.js, before module.exports
const auth = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");
const OperatorRequest = require("../models/OperatorRequest");

// GET /api/operator/requests — admin only
router.get(
  "/requests",
  auth,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const requests = await OperatorRequest.find()
        .sort({ createdAt: -1 })
        .lean();
      return res.json({ success: true, requests });
    } catch (err) {
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// PATCH /api/operator/requests/:id/status — mark contacted/closed
router.patch(
  "/requests/:id/status",
  auth,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { status } = req.body; // "CONTACTED" | "CLOSED"
      const updated = await OperatorRequest.findByIdAndUpdate(
        req.params.id,
        { status },
        { new: true }
      );
      return res.json({ success: true, request: updated });
    } catch (err) {
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);
module.exports = router;
