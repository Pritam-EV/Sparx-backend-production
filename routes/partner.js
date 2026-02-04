const express = require('express');
const router = express.Router();
const Device = require('../models/device');
const User = require('../models/User');

// POST /api/partner/onboard-device
// Partner device onboarding endpoint
router.post('/onboard-device', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
const {
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


if (!deviceId || !serialNumber) {
  return res.status(400).json({ error: 'deviceId and serialNumber are required' });
}


if (!meterType || !meterConsumerNumber) {
  return res.status(400).json({ error: 'Meter details are required' });
}

if (!location || !lat || !lng || !area || !city || !state) {
  return res.status(400).json({ error: 'Location details are required' });
}

// 1️⃣ Find device by deviceId
const device = await Device.findOne({ device_id: deviceId });

if (!device) {
  return res.status(404).json({ error: 'Device ID does not exist' });
}

// 2️⃣ Match serial number
if (!serialNumber || device.serialNumber !== serialNumber) {
  return res.status(400).json({ error: 'Invalid serial number for this device' });
}

// 3️⃣ Add userId to ownerId array (avoid duplicates)
if (!device.ownerId.map(id => id.toString()).includes(userId)) {
  device.ownerId.push(userId);
}


// 4️⃣ Update onboarding + location + meter details
device.gstNumber = hasGST ? gstNumber : undefined;
device.hasGST = hasGST || false;
device.meterType = meterType;
device.meterConsumerNumber = meterConsumerNumber;

device.location = location;
device.lat = parseFloat(lat);
device.lng = parseFloat(lng);
device.area = area;
device.city = city;
device.state = state;

if (rate) {
  device.rate = rate;
}

device.onboardingStatus = 'approved';
device.onboardedAt = new Date();
device.onboardedBy = userId;

// 5️⃣ Save device
await device.save();

// 6️⃣ Force user role → OWNER
await User.findByIdAndUpdate(
  userId,
  { role: 'owner' },
  { new: true }
);

// 7️⃣ Success response
return res.status(200).json({
  success: true,
  message: 'Device linked successfully. You are now an owner.',
  deviceId: device.device_id
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
