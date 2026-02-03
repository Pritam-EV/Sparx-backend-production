const express = require('express');
const router = express.Router();
const Device = require('../models/device');

// POST /api/partner/onboard-device
// Partner device onboarding endpoint
router.post('/onboard-device', async (req, res) => {
  try {
    const {
      userId,
      gstNumber,
      hasGST,
      meterType,
      meterConsumerNumber,
      deviceId,
      serialNumber,
      location,
      lat,
      lng,
      rate,
      area,
      city,
      state
    } = req.body;

    // Validation
    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    if (!meterType) {
      return res.status(400).json({ error: 'Meter Type is required' });
    }

    if (!meterConsumerNumber) {
      return res.status(400).json({ error: 'Meter Consumer Number is required' });
    }

    if (!location || !lat || !lng || !area || !city || !state) {
      return res.status(400).json({ error: 'Location details are required' });
    }

    // Check if device already exists
    const existingDevice = await Device.findOne({ device_id: deviceId });
    if (existingDevice) {
      return res.status(400).json({ error: 'Device with this ID already exists' });
    }

    // Check if serial number already exists (if provided)
    if (serialNumber) {
      const existingSerial = await Device.findOne({ serialNumber });
      if (existingSerial) {
        return res.status(400).json({ error: 'Device with this serial number already exists' });
      }
    }

    // Create new device
    const newDevice = new Device({
      device_id: deviceId,
      serialNumber: serialNumber || undefined,
      ownerId: userId ? [userId] : [],
      gstNumber: hasGST ? gstNumber : undefined,
      hasGST: hasGST || false,
      meterType,
      meterConsumerNumber,
      location,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      status: 'Offline',
      charger_type: 'Universal 3.3kV Socket', // Default, can be made configurable
      rate: rate || 20,
      area,
      city,
      state,
      onboardingStatus: 'pending',
      onboardedAt: new Date(),
      onboardedBy: userId || undefined
    });

    await newDevice.save();

    res.status(201).json({
      success: true,
      message: 'Device onboarded successfully',
      device: newDevice
    });

  } catch (error) {
    console.error('Error onboarding device:', error);
    res.status(500).json({ 
      error: 'Failed to onboard device', 
      details: error.message 
    });
  }
});

// GET /api/partner/devices/:userId
// Get all devices for a partner
router.get('/devices/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const devices = await Device.find({ 
      ownerId: userId 
    }).sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: devices.length,
      devices
    });

  } catch (error) {
    console.error('Error fetching partner devices:', error);
    res.status(500).json({ 
      error: 'Failed to fetch devices', 
      details: error.message 
    });
  }
});

module.exports = router;
