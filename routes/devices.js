const express = require('express');
const router = express.Router();
const Device = require('../models/device'); // Adjust path as needed
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/roleMiddleware');


  router.get('/public/:deviceId', authMiddleware, authorizeRoles('customer'), async (req, res) => {
  try {
    const { deviceId } = req.params;
    const device = await Device.findOne({ device_id: deviceId });

    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }

    // Optionally limit fields sent to customer
    const limitedDevice = {
      device_id: device.device_id,
      location: device.location,
      charger_type: device.charger_type,
      rate: device.rate,
      status: device.status,
    };

    res.json(limitedDevice);
  } catch (error) {
    console.error("Error fetching device:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Check if a device exists
router.get("/check-device/:device_id", async (req, res) => {
  try {
    const { device_id } = req.params; // Get device ID from URL

    if (!device_id) { // Fix: Use device_id instead of deviceId
      return res.status(400).json({ error: "Device ID is required" });
    }

    // Check if device exists in MongoDB
    const device = await Device.findOne({ device_id: req.params.device_id });

    if (device) {
      return res.json({  exists: !!device, device });
    } else {
      return res.json({ exists: false });
    }
  } catch (error) {
    console.error("Error checking device:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Admin/owner only: Can view details (example, adjust logic as needed)
router.get('/:deviceId', authMiddleware, authorizeRoles('admin', 'owner', 'customer'), async (req, res) => {
  try {
    const { deviceId } = req.params;
    console.log("🔐 Authenticated User ID:", req.user.userId);
    const device = await Device.findOne({ device_id: deviceId });

        if (!device) {
      console.warn("❌ Device not found:", req.params.id);
      return res.status(404).json({ error: "Device not found" });
        }
      console.log("📦 Device Owner ID:", device.ownerId);

      if (device.ownerId && device.ownerId.toString() !== req.user.userId) {
        console.warn("🚫 Forbidden: User does not own the device");
        return res.status(403).json({ error: "You do not have access to this device" });
      }

      res.json(device);
    } catch (error) {
      console.error("Error fetching device:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

// Public route: Get all devices (any authenticated user)
router.get('/', async (req, res) => {
  try {
    const devices = await Device.find({}, 'device_id location status charger_type lat lng rate current_session_id area city state totalenergy');
    return res.json(devices);
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ message: 'Error fetching devices', error });
  }
});

// Create new device
router.post('/', authMiddleware, async (req, res) => {
  try {
    const deviceData = req.body;
    const newDevice = new Device(deviceData);
    await newDevice.save();
    res.status(201).json(newDevice);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});





// PUT /api/devices/:id
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const device = await Device.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!device) return res.status(404).json({ error: "Device not found" });
    res.json(device);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin only: Add new device (example)
router.post('/add', authMiddleware, authorizeRoles('admin'), async (req, res) => {
  try {
    const { device_id, location, lat, lng, status, charger_type, rate, current_session_id, area, city, state, totalenergy } = req.body;
    const device = new Device({ device_id, location, lat, lng, status, charger_type, rate, current_session_id, area, city, state, totalenergy });
    await device.save();
    res.status(201).json({ message: 'Device created', device });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});





module.exports = router;
