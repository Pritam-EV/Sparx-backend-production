const express = require('express');
const router = express.Router();
const Device = require('../models/device');
const User = require('../models/User');
const authMiddleware = require('../middleware/authMiddleware');
const DeviceOnboardingConsent = require('../models/DeviceOnboardingConsent');
const Terms = require("../models/TermsAndConditions");
const DeviceConsent = require("../models/DeviceConsent");


router.get('/terms/active', async (req, res) => {
  const terms = await Terms.findOne({ isActive: true })
    .sort({ effectiveFrom: -1 })
    .lean();

  if (!terms) {
    return res.status(404).json({ error: 'No active terms found' });
  }

  res.json({
    version: terms.version,
    title: terms.title,
    content: terms.content,
    contentHash: terms.contentHash,
  });
});

// POST /api/partner/onboard-device
// Partner device onboarding endpoint

router.post('/onboard-device', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
const {
      consent,
      termsVersion,
      termsHash,
      aadhaarOrUdyam,
      panNumber,
      nameAsPerKyc,
      bankAccountNumber,
      ifscCode,
      accountHolderName,
      branchName,
      fingerprint,

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

// Fetch active T&C
const activeTerms = await Terms.findOne({ isActive: true });

if (!activeTerms) {
  return res.status(500).json({ error: "No active Terms & Conditions found" });
}

const meta = extractClientMeta(req);

// await DeviceConsent.create({
//   userId,
//   deviceId: device.device_id,

//   termsVersion: activeTerms.version,
//   termsHash: activeTerms.contentHash,

//   accepted: true,


//   acceptedAt: new Date(),

//   clientIp: meta.clientIp,
//   userAgent: meta.userAgent,
//   browser: meta.browser,
//   os: meta.os,
//   platform: meta.platform,

//   deviceFingerprint: Buffer
//     .from(`${meta.userAgent}-${meta.platform}`)
//     .toString("base64"),

//   aadhaarOrUdyam,
//   panNumber,
//   nameAsPerKyc,

//   bankAccountNumber,
//   ifscCode,
//   accountHolderName,
//   branchName
// });


// 3️⃣ Add userId to ownerId array (avoid duplicates)
if (!device.ownerId.map(id => id.toString()).includes(userId)) {
  device.ownerId.push(userId);
}

if (!req.body.acceptedTerms) {
  return res.status(400).json({ error: "Terms must be accepted" });
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



if (!consent || !termsVersion || !termsHash) {
  return res.status(400).json({ error: 'Terms acceptance required' });
}

await DeviceConsent.create({
  userId,
  deviceId,
  termsVersion,
  termsHash,
  accepted: true,
  acceptedAt: new Date(),

  clientIp:
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.socket.remoteAddress,

  userAgent: req.headers['user-agent'],
  deviceFingerprint: fingerprint,

  aadhaarOrUdyam,
  panNumber,
  nameAsPerKyc,
  bankAccountNumber,
  ifscCode,
  accountHolderName,
  branchName,
});


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

function extractClientMeta(req) {
  const userAgent = req.headers["user-agent"] || "";

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress;

  return {
    clientIp: ip,
    userAgent,
    browser: userAgent.includes("Chrome") ? "Chrome" :
             userAgent.includes("Firefox") ? "Firefox" :
             userAgent.includes("Safari") ? "Safari" : "Unknown",
    os: userAgent.includes("Android") ? "Android" :
        userAgent.includes("Windows") ? "Windows" :
        userAgent.includes("iPhone") ? "iOS" : "Unknown",
    platform: req.headers["sec-ch-ua-platform"] || "Unknown"
  };
}


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
