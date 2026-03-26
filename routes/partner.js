const express = require('express');
const router = express.Router();
const Device = require('../models/device');
const User = require('../models/User');
const authMiddleware = require('../middleware/authMiddleware');
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

// Verify Device ID existence
router.post('/verify-device', authMiddleware, async (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  const device = await Device.findOne({ device_id: deviceId }).lean();

  if (!device) {
    return res.status(404).json({ error: 'Invalid Device ID' });
  }

  return res.json({
    success: true,
    message: 'Device ID verified'
  });
});


// Verify Serial Number against Device ID
router.post('/verify-serial', authMiddleware, async (req, res) => {
  const { deviceId, serialNumber } = req.body;

  if (!deviceId || !serialNumber) {
    return res.status(400).json({ error: 'deviceId and serialNumber are required' });
  }

  const device = await Device.findOne({ device_id: deviceId }).lean();

  if (!device) {
    return res.status(404).json({ error: 'Device ID not found' });
  }

  if (device.serialNumber !== serialNumber) {
    return res.status(400).json({
      error: 'Serial number does not match this Device ID'
    });
  }

  return res.json({
    success: true,
    message: 'Serial number verified'
  });
});


// GET commission for device
router.get('/device/:deviceId/commission', authMiddleware, async (req, res) => {
  try {
    const { deviceId } = req.params;

    const device = await Device.findOne(
      { device_id: deviceId },
      { commercial: 1 }
    ).lean();

    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }

    res.json({
      commissionPerKwh: device.commercial?.vjraMarginPerKwh ?? 0
    });

  } catch (err) {
    console.error("Commission fetch error:", err);
    res.status(500).json({ error: "Failed to fetch commission" });
  }
});


// POST /api/partner/onboard-device
// Partner device onboarding endpoint

router.post('/onboard-device', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
  DEFAULT_PG_PERCENT,
  DEFAULT_VJRA_MARGIN_PER_KWH,
  DEFAULT_ELECTRICITY_BEARER
} = require("../config/commercialDefaults");

const acceptedTerms =
  req.body.acceptedTerms === true ||
  req.body.acceptedTerms === "true";

if (
  !acceptedTerms ||
  !req.body.termsVersion ||
  !req.body.termsHash
) {
  return res.status(400).json({
    error: "Terms acceptance required"
  });
}


const {
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
  state,
  GSTModel,

    electricityBearer,

} = req.body;

if (
  req.body.acceptedTerms !== true ||
  !req.body.termsVersion ||
  !req.body.termsHash
) {
  return res.status(400).json({
    error: "Terms acceptance required"
  });
}


if (!GSTModel || GSTModel !== "fullGST") {
  return res.status(400).json({
    error: "Invalid settlement model"
  });
}

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

// lock GST model
device.GSTModel = "fullGST";

// 2️⃣ Match serial number
if (!serialNumber || device.serialNumber !== serialNumber) {
  return res.status(400).json({ error: 'Invalid serial number for this device' });
}

const activeTerms = await Terms.findOne({ isActive: true });

if (!activeTerms) {
  return res.status(500).json({
    error: "No active Terms & Conditions found"
  });
}

if (
  req.body.termsVersion !== activeTerms.version ||
  req.body.termsHash !== activeTerms.contentHash
) {
  return res.status(400).json({
    error: "Terms version mismatch. Please reload and accept again."
  });
}


const meta = extractClientMeta(req);

// await DeviceConsent.create({onboard
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



// 4️⃣ Update onboarding + location + meter details
device.meterType = meterType;
device.meterConsumerNumber = meterConsumerNumber;

device.location = location;
device.lat = parseFloat(lat);
device.lng = parseFloat(lng);
device.area = area;
device.city = city;
device.state = state;


// Owner entered rate is GST-INCLUSIVE
const userRateInclGst = Number(rate);

if (!userRateInclGst || userRateInclGst <= 0) {
  return res.status(400).json({
    error: "Invalid rate"
  });
}

// derive taxable rate
const GST_PERCENT = 18;
const baseRate = Number((userRateInclGst / (1 + GST_PERCENT / 100)).toFixed(6));

// Save canonical values
device.commercial = {
  electricityBearer: DEFAULT_ELECTRICITY_BEARER,
  userRatePerKwh: baseRate,   // EX GST
  vjraMarginPerKwh: DEFAULT_VJRA_MARGIN_PER_KWH,
  pgPercent: DEFAULT_PG_PERCENT
};

// Save user-facing rate (INCL GST)
device.rate = userRateInclGst;


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



await DeviceConsent.create({
  userId,
  deviceId,
  termsVersion,
  termsHash,
  accepted: true,
  acceptedAt: new Date(),

  GSTModel: GSTModel, 

  clientIp:
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.socket.remoteAddress,

  userAgent: req.headers['user-agent'],
  deviceFingerprint: fingerprint,

    financialAcceptance: {
    acceptedModel: "fullGST",
    electricityPayer: electricityBearer || "OWNER"
  },

  aadhaarOrUdyam: aadhaarOrUdyam || null,
  panNumber: panNumber || null,
  nameAsPerKyc: nameAsPerKyc || null,
  bankAccountNumber: bankAccountNumber || null,
  ifscCode: ifscCode || null,
  accountHolderName: accountHolderName || null,
  branchName: branchName || null
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
// routes/partner.js - Update GET /api/partner/devices/:userId

// routes/partner.js - UPDATED VERSION
router.get('/devices/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // ✅ UPDATED: Add ALL needed fields
    const devices = await Device.find({
      ownerId: userId
    })
    .select('device_id location status charger_type rate relayOn meterType meterConsumerNumber onboardedAt lastSeen updatedAt area city state _id')  // ✅ Added lastSeen, updatedAt, area, city, state, _id
    .sort({ createdAt: -1 })
    .lean();

    // Fetch owner profile for GST info
    const OwnerProfile = require('../models/ownerProfile');
    const ownerProfile = await OwnerProfile.findOne({ userId }).lean();

    res.status(200).json({
      success: true,
      count: devices.length,
      devices,
      ownerProfile: {
        gstin: ownerProfile?.gstin || null
      }
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
