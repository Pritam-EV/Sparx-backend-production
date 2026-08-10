const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

const Device = require('../models/device');
const DeviceProvision = require('../models/DeviceProvision');
const DeviceTelemetry = require('../models/deviceTelemetry');
const {
  normalizeDeviceId,
} = require('../config/deviceProtocol');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/roleMiddleware');

const {
  publishDeviceConfig,
} = require('../services/configPublisher');

const {
  normalizeDeviceId,
} = require('../config/deviceProtocol');


function getNormalizedDeviceId(value) {
  return normalizeDeviceId(value);
}

function getActorId(req) {
  return (
    req.user?.uid ||
    req.user?.userId ||
    req.user?._id ||
    null
  );
}

function isOwnerOfDevice(device, actorId) {
  return (
    Array.isArray(device.ownerId) &&
    device.ownerId.some(
      (ownerId) =>
        ownerId.toString() ===
        actorId?.toString()
    )
  );
}

function sanitizeDevice(device) {
  const output =
    typeof device.toObject === 'function'
      ? device.toObject()
      : { ...device };

  delete output.wifiPassword;

  return output;
}

function assertFiniteNumber(value, fieldName) {
  if (value === undefined || value === null) {
    return;
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    const error = new Error(
      `${fieldName} must be a valid number`
    );

    error.statusCode = 400;
    throw error;
  }
}

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






// Create new device
router.post(
  '/',
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
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
// Legacy PUT endpoint.
// Keep the endpoint for compatibility, but prevent unsafe
// arbitrary document updates.
router.put(
  '/:id',
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    return res.status(410).json({
      error:
        'Generic device updates are disabled. Use the dedicated configuration or identity endpoints.',
      endpoints: {
        config:
          'PATCH /api/devices/admin/config/:deviceId',
        identity:
          'PATCH /api/devices/admin/:deviceId/identity',
        ownerWifi:
          'PATCH /api/devices/owner/wifi/:deviceId',
      },
    });
  }
);

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
//
// Admin-only configuration update.
//
// Allowed:
// - WiFi credentials
// - Calibration values
// - Rate
// - Location
// - Meter details
// - Commercial configuration
// - Target firmware version
//
// Not allowed here:
// - device_id
// - serialNumber
// - ownerId
// - onboardingStatus
//
// Device ID changes must use the dedicated identity route below.
router.patch(
  '/admin/config/:deviceId',
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const deviceId = normalizeDeviceId(
        req.params.deviceId
      );

      if (
        req.body.device_id !== undefined ||
        req.body.deviceId !== undefined ||
        req.body.serialNumber !== undefined
      ) {
        return res.status(400).json({
          error:
            'Use the dedicated identity endpoint for device ID changes',
        });
      }

      const device = await Device.findOne({
        device_id: deviceId,
      });

      if (!device) {
        return res.status(404).json({
          error: 'Device not found',
        });
      }

      const {
        cf,
        vf,
        currentRF,
        wifiSSID,
        wifiPassword,
        rate,
        location,
        lat,
        lng,
        area,
        city,
        state,
        meterType,
        meterConsumerNumber,
        commercial,
        targetFirmwareVersion,
      } = req.body;

      for (const [field, value] of Object.entries({
        cf,
        vf,
        currentRF,
        rate,
        lat,
        lng,
      })) {
        if (
          value !== undefined &&
          !Number.isFinite(Number(value))
        ) {
          return res.status(400).json({
            error: `${field} must be numeric`,
          });
        }
      }

      if (cf !== undefined) {
        device.cf = Number(cf);
      }

      if (vf !== undefined) {
        device.vf = Number(vf);
      }

      if (currentRF !== undefined) {
        device.currentRF = Number(currentRF);
      }

      if (wifiSSID !== undefined) {
        device.wifiSSID = String(wifiSSID).trim();
      }

      if (wifiPassword !== undefined) {
        device.wifiPassword = String(wifiPassword);
      }

      if (rate !== undefined) {
        device.setRate(
          Number(rate),
          getActorId(req) || 'admin',
          'admin'
        );
      }

      if (location !== undefined) {
        device.location = location;
      }

      if (lat !== undefined) {
        device.lat = Number(lat);
      }

      if (lng !== undefined) {
        device.lng = Number(lng);
      }

      if (area !== undefined) {
        device.area = area;
      }

      if (city !== undefined) {
        device.city = city;
      }

      if (state !== undefined) {
        device.state = state;
      }

      if (meterType !== undefined) {
        device.meterType = meterType;
      }

      if (meterConsumerNumber !== undefined) {
        device.meterConsumerNumber =
          meterConsumerNumber;
      }

      if (commercial !== undefined) {
        device.commercial = {
          ...(device.commercial?.toObject
            ? device.commercial.toObject()
            : device.commercial || {}),
          ...commercial,
        };
      }

      if (targetFirmwareVersion !== undefined) {
        device.targetFirmwareVersion =
          targetFirmwareVersion;
      }

      await device.save();

      const publishResult =
        await publishDeviceConfig(
          device.device_id
        );

      return res.json({
        success: true,
        message:
          'Device configuration updated and published',
        device: sanitizeDevice(device),
        config: {
          topic: publishResult.topic,
          nvsVersion: publishResult.nvsVersion,
        },
      });
    } catch (error) {
      console.error('[ADMIN CONFIG]', error);

      return res.status(502).json({
        success: false,
        error:
          'Database update succeeded or partially succeeded, but configuration publish failed',
        details: error.message,
      });
    }
  }
);

// PATCH /api/devices/owner/wifi/:deviceId
//
// Owner can change WiFi credentials only for a device
// already assigned to that owner.
//
// Admin can change WiFi for any device through this route,
// although the admin configuration route is preferred for admin use.
router.patch(
  '/owner/wifi/:deviceId',
  authMiddleware,
  authorizeRoles('owner', 'admin'),
  async (req, res) => {
    try {
      const deviceId = normalizeDeviceId(
        req.params.deviceId
      );

      const {
        wifiSSID,
        wifiPassword,
      } = req.body;

      if (
        typeof wifiSSID !== 'string' ||
        wifiSSID.trim() === ''
      ) {
        return res.status(400).json({
          error:
            'wifiSSID must be a non-empty string',
        });
      }

      if (
        typeof wifiPassword !== 'string' ||
        wifiPassword.length === 0
      ) {
        return res.status(400).json({
          error:
            'wifiPassword must be a non-empty string',
        });
      }

      const device = await Device.findOne({
        device_id: deviceId,
      });

      if (!device) {
        return res.status(404).json({
          error: 'Device not found',
        });
      }

      const actorId = getActorId(req);

      if (req.user?.role === 'owner') {
        if (
          device.onboardingStatus !== 'approved'
        ) {
          return res.status(403).json({
            error:
              'Device must be approved before owner configuration',
          });
        }

        if (!isOwnerOfDevice(device, actorId)) {
          return res.status(403).json({
            error:
              'You do not have access to this device',
          });
        }
      }

      device.wifiSSID = wifiSSID.trim();
      device.wifiPassword = wifiPassword;

      await device.save();

      const publishResult =
        await publishDeviceConfig(
          device.device_id
        );

      return res.json({
        success: true,
        message:
          'WiFi credentials updated and published',
        device: sanitizeDevice(device),
        config: {
          topic: publishResult.topic,
          nvsVersion: publishResult.nvsVersion,
        },
      });
    } catch (error) {
      console.error('[OWNER WIFI]', error);

      return res.status(502).json({
        success: false,
        error:
          'WiFi database update or MQTT publish failed',
        details: error.message,
      });
    }
  }
);


// PATCH /api/devices/admin/:deviceId/identity
//
// Admin-only controlled device ID migration.
//
// This updates:
// 1. Device.device_id
// 2. DeviceProvision.deviceId
// 3. Firmware configuration through publishDeviceConfig()
//
// serialNumber remains unchanged and is the stable identity
// used for the configuration and ACK topics.
router.patch(
  '/admin/:deviceId/identity',
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    const session = await mongoose.startSession();

    try {
      const oldDeviceId = normalizeDeviceId(
        req.params.deviceId
      );

      const newDeviceId = normalizeDeviceId(
        req.body.newDeviceId
      );

      if (!newDeviceId) {
        return res.status(400).json({
          error: 'newDeviceId is required',
        });
      }

      if (oldDeviceId === newDeviceId) {
        return res.status(400).json({
          error:
            'newDeviceId must be different from current device ID',
        });
      }

      let updatedDevice;

      await session.withTransaction(async () => {
        const device = await Device.findOne({
          device_id: oldDeviceId,
        }).session(session);

        if (!device) {
          const error = new Error(
            'Device not found'
          );
          error.statusCode = 404;
          throw error;
        }

        const duplicate =
          await Device.findOne({
            device_id: newDeviceId,
            _id: { $ne: device._id },
          })
            .session(session)
            .lean();

        if (duplicate) {
          const error = new Error(
            'New device ID is already in use'
          );
          error.statusCode = 409;
          throw error;
        }

        const provision =
          await DeviceProvision.findOne({
            serialNumber: device.serialNumber,
          }).session(session);

        device.device_id = newDeviceId;

        await device.save({
          session,
          validateModifiedOnly: true,
        });

        if (provision) {
          provision.deviceId = newDeviceId;
          await provision.save({
            session,
            validateModifiedOnly: true,
          });
        }

        updatedDevice = device;
      });

      const publishResult =
        await publishDeviceConfig(newDeviceId);

      return res.json({
        success: true,
        message:
          'Device ID updated and configuration published',
        previousDeviceId: oldDeviceId,
        deviceId: newDeviceId,
        serialNumber:
          updatedDevice.serialNumber,
        device: sanitizeDevice(updatedDevice),
        config: {
          topic: publishResult.topic,
          nvsVersion: publishResult.nvsVersion,
        },
      });
    } catch (error) {
      console.error(
        '[DEVICE ID MIGRATION]',
        error
      );

      return res.status(
        error.statusCode || 502
      ).json({
        success: false,
        error: error.message,
      });
    } finally {
      await session.endSession();
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

// Admin/owner only: Can view details (example, adjust logic as needed)
router.get('/:deviceId', authMiddleware, authorizeRoles('admin', 'owner', 'customer'), async (req, res) => {
  try {
const deviceId = getNormalizedDeviceId(
  req.params.deviceId
);

const device = await Device.findOne({
  device_id: deviceId,
});

        if (!device) {
      console.warn("❌ Device not found:", req.params.id);
      return res.status(404).json({ error: "Device not found" });
        }
      // console.log("📦 Device Owner ID:", device.ownerId);

if (req.user?.role === 'owner') {
  const actorId = getActorId(req);

  if (!isOwnerOfDevice(device, actorId)) {
    return res.status(403).json({
      error:
        'You do not have access to this device',
    });
  }
}

      res.json(sanitizeDevice(device));
    } catch (error) {
      console.error("Error fetching device:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });


module.exports = router;
