const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const { createOperatorRequest } = require("../controllers/operatorController");

router.post(
  "/request",
  authMiddleware,
  createOperatorRequest
);

module.exports = router;
