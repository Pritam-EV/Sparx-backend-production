
/**
 * routes/productionV3.routes.js
 *
 * VIZ Production 3.0 API Router
 *
 * Separate from:
 *   /api/provision
 *   /api/admin/provision
 *
 * All endpoints require an authenticated admin.
 */

const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const batchController = require("../controllers/productionV3/batch.controller");

// --------------------------------------------------
// PRODUCTION 3.0 AUTHORIZATION
// --------------------------------------------------

router.use(
  authMiddleware,
  authorizeRoles("admin")
);

// --------------------------------------------------
// BATCH MANAGEMENT
// --------------------------------------------------

/**
 * POST /
 * Create a manufacturing batch and generate Group A devices.
 */
router.post(
  "/batches",
  batchController.createBatch
);

/**
 * GET /
 * List manufacturing batches.
 *
 * Query parameters:
 *   page
 *   limit
 *   status
 *   search
 */
router.get(
  "/batches",
  batchController.getBatches
);

/**
 * GET /batches/:batchId
 * Get batch details and associated devices.
 */
router.get(
  "/batches/:batchId",
  batchController.getBatchById
);

module.exports = router;
