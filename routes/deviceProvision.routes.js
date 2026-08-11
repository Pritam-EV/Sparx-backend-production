const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/roleMiddleware');

const {
  createGroupA,
  getGroupA,
  getAllGroupA,
  updateGroupA,
  deleteGroupA,
  promoteToGroupB,
  getAllProvisionDevices,
} = require('../controllers/deviceProvision.controller');

// ─────────────────────────────────────────────────────────────────────────────
// ALL PROVISION ROUTES REQUIRE ADMIN
// ─────────────────────────────────────────────────────────────────────────────
router.use(
  authMiddleware,
  authorizeRoles('admin')
);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN DASHBOARD — ALL MANUFACTURING / PROVISION DEVICES
//
// Returns:
//   Group A
//   Group B
//   Dispatched
//   Live
//
// Optional:
//   ?status=group_b
//   ?status=dispatched
//   ?search=VIZ1A01
//   ?page=1&limit=100
//
// IMPORTANT:
// Keep this route BEFORE /group-a/:serial
// so "admin" is never interpreted as a serial number.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/admin',
  getAllProvisionDevices
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/group-a',
  createGroupA
);

router.get(
  '/group-a',
  getAllGroupA
);

router.get(
  '/group-a/:serial',
  getGroupA
);

router.patch(
  '/group-a/:serial',
  updateGroupA
);

router.delete(
  '/group-a/:serial',
  deleteGroupA
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A → GROUP B
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/group-a/:serial/promote',
  promoteToGroupB
);

module.exports = router;