// routes/adminProvision.js
const router      = require('express').Router();
const adminAuth   = require('../middleware/adminAuth');
const ctrl        = require('../controllers/provisionController');

// All routes protected by adminAuth
router.use(adminAuth);

router.post('/',                         ctrl.createProvision);  // Register new device
router.get('/',                          ctrl.listProvisions);   // List all (paginated)
router.get('/:serialNumber',             ctrl.getProvision);     // Get one
router.patch('/:serialNumber',           ctrl.updateProvision);  // Update config
router.post('/:serialNumber/send',       ctrl.sendProvision);    // Publish to MQTT
router.post('/cmd/:deviceId/admin',      ctrl.sendAdminCmd);     // Admin cmd (OTA, reset…)

module.exports = router;