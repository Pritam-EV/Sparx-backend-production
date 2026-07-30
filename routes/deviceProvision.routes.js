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
} = require('../controllers/deviceProvision.controller');

// All routes require admin
router.use(authMiddleware, authorizeRoles('admin'),);

router.post('/group-a',          createGroupA);
router.get('/group-a',           getAllGroupA);
router.get('/group-a/:serial',   getGroupA);
router.patch('/group-a/:serial', updateGroupA);
router.delete('/group-a/:serial',deleteGroupA);

// Promote a Group A entry to Group B (triggers calibration + dispatch config)
router.post('/group-a/:serial/promote', promoteToGroupB);

module.exports = router;