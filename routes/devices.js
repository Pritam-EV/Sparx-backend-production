const express = require('express');
const router = express.Router();
const Device = require('../models/device'); // Adjust path as needed
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/roleMiddleware');
const DeviceTelemetry = require("../models/deviceTelemetry");
const { publishDeviceConfig } = require('../services/configPublisher');

// Public route: Get all devices (any authenticated user)
router.get('/', async (req, res) => {
  try {
    const devices = await Device.find(
      {},
      'device_id location status charger_type lat lng rate area city state lastSeen relayOn'
    ).lean();
    return res.json(devices);
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ message: 'Error fetching devices', error });
  }
});

// 2) Public single-device view (no auth)
router.get('/public/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const device = await Device.findOne(
      { device_id: deviceId },
      'device_id location status charger_type lat lng rate area city state lastSeen relayOn'
    ).lean();
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json(device);
  } catch (error) {
    console.error('Error fetching device:', error);
    res.status(500).json({ error: 'Internal server error' });
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

// 3) Owner’s devices (auth, scoped) for dashboards
router.get('/mine', authMiddleware, async (req, res) => {
  try {
    const q = {};
    if (req.user?.role === 'owner') q.ownerId = req.user.userId;
    const devices = await Device.find(
      q,
      'device_id location status charger_type lat lng rate current_session_id area city state totalenergy relayOn lastSeen updatedAt'
    ).lean();
    return res.json(devices);
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ message: 'Error fetching devices', error });
  }
});

router.get('/admin-dashboard',
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { area, city, state, status, project  } = req.query;
      const query = {};
      if (area) query.area = area;
      if (city) query.city = city;
      if (state) query.state = state;
      if (status) query.status = status;
      if (project) query.project = project;

      // projection - include commercial + ownerId + onboarding + meta fields
      const projection = {
        _id: 1,
        device_id: 1,
        serialNumber: 1,
        ownerId: 1,
        location: 1,
        status: 1,
        current_session_id: 1,
        charger_type: 1,
        lat: 1,
        lng: 1,
        rate: 1,
        area: 1,
        city: 1,
        state: 1,
        project: 1,
        totalenergy: 1,
        lastSeen: 1,
        relayOn: 1,
        updatedAt: 1,
        onboardingStatus: 1,
        commercial: 1,
      };

      const devices = await Device.find(query)
  .populate({
    path: 'ownerId',
    select: 'name email phone role',
  })
  .sort({ updatedAt: -1 });


      // compute useful flags & summary
      const now = Date.now();
      const STALE_MS = 3000 * 1000; // 3000 seconds threshold for "stale" (tune as needed)

      let summary = {
        total: devices.length,
        online: 0,
        offline: 0,
        chargingNow: 0,
        faulty: 0,
        pendingOnboard: 0,
        stale: 0,
        relayWithoutSession: 0,
      };

      for (const d of devices) {
        const st = (d.status || "").toLowerCase();
        if (st === 'online' || st === 'available') summary.online += 1;
        if (st === 'offline') summary.offline += 1;
        if (st === 'occupied' || st === 'busy') summary.chargingNow += 1;
        if (st === 'faulty' || st === 'error') summary.faulty += 1;
        if (d.onboardingStatus === 'pending') summary.pendingOnboard += 1;

        // stale: lastSeen missing or older than threshold
        const last = d.lastSeen ? new Date(d.lastSeen).getTime() : 0;
        d.isStale = !last || (now - last) > STALE_MS;
        if (d.isStale) summary.stale += 1;

        // relay without session
        d.relayOnWithoutSession = !!(d.relayOn && !d.current_session_id);
        if (d.relayOnWithoutSession) summary.relayWithoutSession += 1;

        // convenience default for commercial if missing (so frontend doesn't crash)
        if (!d.commercial) d.commercial = {};
      }

      return res.json({ devices, summary });
    } catch (err) {
      console.error('admin-dashboard error:', err);
      res.status(500).json({ error: 'Internal server error', details: err.message });
    }
  }
);


// GET live monitoring data
router.get(
  "/admin/live-monitoring/:deviceId",
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { deviceId } = req.params;

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const data = await DeviceTelemetry.find({
        deviceId,
        timestamp: { $gte: since },
      }).sort({ timestamp: 1 });

      const response = {
        timestamps: data.map(d => d.timestamp),
        voltage: data.map(d => d.voltage),
        current: data.map(d => d.current),
      };

      res.json(response);

    } catch (err) {
      console.error("Live monitoring fetch error:", err);
      res.status(500).json({ error: "Failed to fetch telemetry" });
    }
  }
);

// GET /api/devices/admin/live-devices/filter-options
// Returns distinct project/area/status values from devices that have recent telemetry
router.get(
  "/admin/live-devices/filter-options",
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const telemetryDocs = await DeviceTelemetry.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $group: { _id: "$deviceId" } },
      ]);
      const deviceIds = telemetryDocs.map(d => d._id);

      const [projects, areas, statuses] = await Promise.all([
        Device.distinct('project', { device_id: { $in: deviceIds }, project: { $ne: null, $ne: '' } }),
        Device.distinct('area',    { device_id: { $in: deviceIds }, area:    { $ne: null, $ne: '' } }),
        Device.distinct('status',  { device_id: { $in: deviceIds }, status:  { $ne: null, $ne: '' } }),
      ]);

      res.json({ projects, areas, statuses });
    } catch (err) {
      console.error("Filter options error:", err);
      res.status(500).json({ error: "Failed to fetch filter options" });
    }
  }
);

// GET /api/devices/admin/live-devices
// Query params: project, area, status
router.get(
  "/admin/live-devices",
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const { project, area, status } = req.query;

      // Step 1: get all deviceIds that have telemetry in last 24h
      const telemetryDocs = await DeviceTelemetry.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $group: { _id: "$deviceId" } },
      ]);
      const deviceIdsWithTelemetry = telemetryDocs.map(d => d._id);

      // Step 2: build Device query — scope to those IDs + optional filters
      const deviceQuery = { device_id: { $in: deviceIdsWithTelemetry } };
      if (project) deviceQuery.project = project;
      if (area) deviceQuery.area = area;
      if (status) deviceQuery.status = status;

      const devices = await Device.find(
        deviceQuery,
        'device_id status area project city state location lastSeen'
      ).lean();

      // Step 3: return enriched device objects
      res.json(devices);

    } catch (err) {
      console.error("Live devices error:", err);
      res.status(500).json({ error: "Failed to fetch devices" });
    }
  }
);


// Admin/owner only: Can view details (example, adjust logic as needed)
router.get('/:deviceId', authMiddleware, authorizeRoles('admin', 'owner', 'customer'), async (req, res) => {
  try {
    const { deviceId } = req.params;
    // console.log("🔐 Authenticated User ID:", req.user.userId);
    const device = await Device.findOne({ device_id: deviceId });

        if (!device) {
      console.warn("❌ Device not found:", req.params.id);
      return res.status(404).json({ error: "Device not found" });
        }
      // console.log("📦 Device Owner ID:", device.ownerId);

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

// PATCH /api/devices/admin/config/:deviceId
// Admin-only: update device config (cf/vf/currentRF, wifi, rate, location, meter, commercial)
// and push new config to firmware via MQTT (publishDeviceConfig).
router.patch(
  '/admin/config/:deviceId',
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const deviceId = req.params.deviceId.toUpperCase();

      // Load device
      const device = await Device.findOne({ device_id: deviceId });
      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      // Extract allowed fields from body
      const {
        // calibration
        cf,
        vf,
        currentRF,
        // wifi
        wifiSSID,
        wifiPassword,
        // rate
        rate,
        // location
        location,
        lat,
        lng,
        area,
        city,
        state,
        // meter
        meterType,
        meterConsumerNumber,
        // commercial config
        commercial,
        // target firmware version (optional)
        targetFirmwareVersion,
      } = req.body;

      // Apply calibration (admin-only)
      if (typeof cf === 'number')        device.cf        = cf;
      if (typeof vf === 'number')        device.vf        = vf;
      if (typeof currentRF === 'number') device.currentRF = currentRF;

      // Apply WiFi credentials (admin may overwrite)
      if (typeof wifiSSID === 'string')     device.wifiSSID     = wifiSSID;
      if (typeof wifiPassword === 'string') device.wifiPassword = wifiPassword;

      // Apply location
      if (typeof location === 'string') device.location = location;
      if (typeof lat === 'number')      device.lat      = lat;
      if (typeof lng === 'number')      device.lng      = lng;
      if (typeof area === 'string')     device.area     = area;
      if (typeof city === 'string')     device.city     = city;
      if (typeof state === 'string')    device.state    = state;

      // Apply meter fields
      if (typeof meterType === 'string')          device.meterType          = meterType;
      if (typeof meterConsumerNumber === 'string') device.meterConsumerNumber = meterConsumerNumber;

      // Apply commercial object if provided
      if (commercial && typeof commercial === 'object') {
        device.commercial = {
          ...device.commercial,
          ...commercial,
        };
      }

      // Apply target firmware version, if provided
      if (typeof targetFirmwareVersion === 'string') {
        device.targetFirmwareVersion = targetFirmwareVersion;
      }

      // Apply rate + rateHistory (admin change)
      if (typeof rate === 'number') {
        // track last change only
        device.setRate(rate, req.user.uid || req.user.userId || 'admin', 'admin');
      }

      // Save changes
      await device.save();

      // Push config to firmware (NVS version increment + configAck.status='pending')
      try {
        await publishDeviceConfig(deviceId);
      } catch (mqttErr) {
        console.error('[ADMIN CONFIG] MQTT publish failed:', mqttErr.message);
        // Still return 200 with device; surface MQTT error separately if needed
        return res.status(200).json({
          device,
          warning: 'Device updated in DB, but MQTT config push failed',
          mqttError: mqttErr.message,
        });
      }

      return res.status(200).json({
        device,
        message: 'Device config updated and MQTT config push initiated',
      });
    } catch (err) {
      console.error('[ADMIN CONFIG] Error:', err);
      return res.status(500).json({ error: 'Failed to update device config', details: err.message });
    }
  }
);

// PATCH /api/devices/owner/wifi/:deviceId
// Owner + admin: update WiFi credentials only and push config to device.
// Owner can change WiFi any time; admin can also override via portal.
router.patch(
  '/owner/wifi/:deviceId',
  authMiddleware,
  authorizeRoles('owner', 'admin'),
  async (req, res) => {
    try {
      const deviceId = req.params.deviceId.toUpperCase();
      const { wifiSSID, wifiPassword } = req.body;

      if (!wifiSSID || !wifiPassword) {
        return res.status(400).json({ error: 'wifiSSID and wifiPassword are required' });
      }

      const device = await Device.findOne({ device_id: deviceId });
      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      // Optional: check that owner really owns this device (if role is owner)
      if (req.user.role === 'owner') {
        const ownerIdStr = req.user.userId.toString();
        const ownsDevice = Array.isArray(device.ownerId)
          ? device.ownerId.some(id => id.toString() === ownerIdStr)
          : device.ownerId && device.ownerId.toString() === ownerIdStr;

        if (!ownsDevice) {
          return res.status(403).json({ error: 'You do not own this device' });
        }
      }

      // Update WiFi creds
      device.wifiSSID     = wifiSSID;
      device.wifiPassword = wifiPassword;

      await device.save();

      // Push config to firmware
      try {
        await publishDeviceConfig(deviceId);
      } catch (mqttErr) {
        console.error('[OWNER WIFI] MQTT publish failed:', mqttErr.message);
        return res.status(200).json({
          device,
          warning: 'WiFi updated in DB, but MQTT config push failed',
          mqttError: mqttErr.message,
        });
      }

      return res.status(200).json({
        device,
        message: 'WiFi credentials updated and MQTT config push initiated',
      });
    } catch (err) {
      console.error('[OWNER WIFI] Error:', err);
      return res.status(500).json({ error: 'Failed to update WiFi credentials', details: err.message });
    }
  }
);

// POST /api/devices/:deviceId/claim
// Owner self-claim flow: move onboardingStatus from 'pending' -> 'approved',
// add ownerId[] entry, and stamp onboardedAt / onboardedBy.
router.post(
  '/:deviceId/claim',
  authMiddleware,
  authorizeRoles('owner'),
  async (req, res) => {
    try {
      const deviceId = req.params.deviceId.toUpperCase();
      const userId   = req.user.userId;  // from authMiddleware

      const device = await Device.findOne({ device_id: deviceId });
      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      // Only allow claim when onboardingStatus is 'pending'
      if (device.onboardingStatus !== 'pending') {
        return res.status(400).json({
          error: 'Device is not in a claimable state',
          onboardingStatus: device.onboardingStatus,
        });
      }

      // Prevent duplicate owner entries
      const alreadyOwner = Array.isArray(device.ownerId)
        ? device.ownerId.some(id => id.toString() === userId.toString())
        : device.ownerId && device.ownerId.toString() === userId.toString();

      if (!alreadyOwner) {
        // Append ownerId into array (create array if missing)
        if (!Array.isArray(device.ownerId)) {
          device.ownerId = [];
        }
        device.ownerId.push(userId);
      }

      // Mark onboarding as approved
      device.onboardingStatus = 'approved';
      device.onboardedAt      = new Date();
      device.onboardedBy      = userId;

      await device.save();

      return res.status(200).json({
        device,
        message: 'Device claimed successfully',
      });
    } catch (err) {
      console.error('[OWNER CLAIM] Error:', err);
      return res.status(500).json({ error: 'Failed to claim device', details: err.message });
    }
  }
);

module.exports = router;
