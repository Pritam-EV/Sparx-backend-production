const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

const Device = require('../models/device');
const DeviceProvision = require('../models/DeviceProvision');
const DeviceTelemetry = require('../models/deviceTelemetry');

const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/roleMiddleware');

const {
  publishDeviceConfig,
} = require('../services/configPublisher');

const {
  normalizeDeviceId,
} = require('../config/deviceProtocol');

function getActorId(req) {
  return (
    req.user?.uid ||
    req.user?.userId ||
    req.user?._id ||
    null
  );
}

function getNormalizedDeviceId(value) {
  return normalizeDeviceId(value);
}

function isOwnerOfDevice(device, userId) {
  if (!userId || !Array.isArray(device.ownerId)) {
    return false;
  }

  return device.ownerId.some(
    (ownerId) =>
      ownerId.toString() === userId.toString()
  );
}

function sanitizeDevice(device) {
  const output =
    typeof device.toObject === 'function'
      ? device.toObject()
      : { ...device };

  // Never expose WiFi password in API responses.
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
      const deviceId = getNormalizedDeviceId(
        req.params.deviceId
      );

      if (!deviceId) {
        return res.status(400).json({
          error: 'Device ID is required',
        });
      }

      // Prevent identity changes through the normal config route.
      if (
        Object.prototype.hasOwnProperty.call(
          req.body,
          'device_id'
        ) ||
        Object.prototype.hasOwnProperty.call(
          req.body,
          'deviceId'
        ) ||
        Object.prototype.hasOwnProperty.call(
          req.body,
          'serialNumber'
        )
      ) {
        return res.status(400).json({
          error:
            'Identity changes must use the dedicated device identity endpoint',
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

      // Validate numeric fields before modifying the document.
      assertFiniteNumber(cf, 'cf');
      assertFiniteNumber(vf, 'vf');
      assertFiniteNumber(currentRF, 'currentRF');
      assertFiniteNumber(rate, 'rate');
      assertFiniteNumber(lat, 'lat');
      assertFiniteNumber(lng, 'lng');

      // Calibration.
      if (cf !== undefined) {
        device.cf = Number(cf);
      }

      if (vf !== undefined) {
        device.vf = Number(vf);
      }

      if (currentRF !== undefined) {
        device.currentRF = Number(currentRF);
      }

      // WiFi.
      if (wifiSSID !== undefined) {
        if (
          typeof wifiSSID !== 'string' ||
          wifiSSID.trim().length === 0
        ) {
          return res.status(400).json({
            error: 'wifiSSID must be a non-empty string',
          });
        }

        device.wifiSSID = wifiSSID.trim();
      }

      if (wifiPassword !== undefined) {
        if (
          typeof wifiPassword !== 'string' ||
          wifiPassword.length === 0
        ) {
          return res.status(400).json({
            error: 'wifiPassword must be a non-empty string',
          });
        }

        device.wifiPassword = wifiPassword;
      }

      // Location.
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

      // Meter.
      if (meterType !== undefined) {
        device.meterType = meterType;
      }

      if (meterConsumerNumber !== undefined) {
        device.meterConsumerNumber =
          meterConsumerNumber;
      }

      // Commercial configuration.
      if (
        commercial !== undefined &&
        commercial !== null
      ) {
        if (
          typeof commercial !== 'object' ||
          Array.isArray(commercial)
        ) {
          return res.status(400).json({
            error:
              'commercial must be a JSON object',
          });
        }

        device.commercial = {
          ...(device.commercial?.toObject
            ? device.commercial.toObject()
            : device.commercial || {}),
          ...commercial,
        };
      }

      // Firmware target version.
      if (targetFirmwareVersion !== undefined) {
        device.targetFirmwareVersion =
          targetFirmwareVersion;
      }

      // Rate and last-change history.
      if (rate !== undefined) {
        const actorId = getActorId(req);

        device.setRate(
          Number(rate),
          actorId || 'admin',
          'admin'
        );
      }

      await device.save();

      let publishResult;

      try {
        publishResult = await publishDeviceConfig(
          device.device_id
        );
      } catch (mqttError) {
        console.error(
          '[ADMIN CONFIG] MQTT publish failed:',
          mqttError.message
        );

        return res.status(502).json({
          success: false,
          error:
            'Device was updated in database, but MQTT configuration publish failed',
          mqttError: mqttError.message,
          device: sanitizeDevice(device),
        });
      }

      return res.status(200).json({
        success: true,
        message:
          'Device configuration updated and published',
        device: sanitizeDevice(device),
        config: {
          topic: publishResult.topic,
          nvsVersion: publishResult.nvsVersion,
          payload: {
            ...publishResult.payload,
            password: undefined,
          },
        },
      });
    } catch (error) {
      console.error('[ADMIN CONFIG] Error:', error);

      return res.status(
        error.statusCode || 500
      ).json({
        success: false,
        error:
          error.statusCode === 400
            ? error.message
            : 'Failed to update device configuration',
        details:
          error.statusCode ? undefined : error.message,
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
      const deviceId = getNormalizedDeviceId(
        req.params.deviceId
      );

      const {
        wifiSSID,
        wifiPassword,
      } = req.body;

      if (
        typeof wifiSSID !== 'string' ||
        wifiSSID.trim().length === 0
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
              'Device must be approved before owner configuration is allowed',
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

      let publishResult;

      try {
        publishResult = await publishDeviceConfig(
          device.device_id
        );
      } catch (mqttError) {
        console.error(
          '[OWNER WIFI] MQTT publish failed:',
          mqttError.message
        );

        return res.status(502).json({
          success: false,
          error:
            'WiFi was updated in database, but MQTT configuration publish failed',
          mqttError: mqttError.message,
          device: sanitizeDevice(device),
        });
      }

      return res.status(200).json({
        success: true,
        message:
          'WiFi credentials updated and published',
        device: sanitizeDevice(device),
        config: {
          topic: publishResult.topic,
          nvsVersion: publishResult.nvsVersion,
          payload: {
            ...publishResult.payload,
            password: undefined,
          },
        },
      });
    } catch (error) {
      console.error('[OWNER WIFI] Error:', error);

      return res.status(500).json({
        success: false,
        error:
          'Failed to update WiFi credentials',
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
      const oldDeviceId = getNormalizedDeviceId(
        req.params.deviceId
      );

      const newDeviceId = getNormalizedDeviceId(
        req.body.newDeviceId
      );

      if (!oldDeviceId) {
        return res.status(400).json({
          error: 'Current device ID is required',
        });
      }

      if (!newDeviceId) {
        return res.status(400).json({
          error: 'newDeviceId is required',
        });
      }

      if (oldDeviceId === newDeviceId) {
        return res.status(400).json({
          error:
            'newDeviceId must be different from the current device ID',
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

        const duplicateDevice = await Device.findOne({
          device_id: newDeviceId,
          _id: { $ne: device._id },
        })
          .session(session)
          .lean();

        if (duplicateDevice) {
          const error = new Error(
            `Device ID ${newDeviceId} is already in use`
          );
          error.statusCode = 409;
          throw error;
        }

        const duplicateProvision =
          await DeviceProvision.findOne({
            deviceId: newDeviceId,
            serialNumber: {
              $ne: device.serialNumber,
            },
          })
            .session(session)
            .lean();

        if (duplicateProvision) {
          const error = new Error(
            `Device ID ${newDeviceId} is already assigned in provisioning`
          );
          error.statusCode = 409;
          throw error;
        }

        device.device_id = newDeviceId;

        await device.save({
          session,
          validateModifiedOnly: true,
        });

        await DeviceProvision.updateOne(
          {
            serialNumber: device.serialNumber,
          },
          {
            $set: {
              deviceId: newDeviceId,
            },
          },
          {
            session,
            runValidators: true,
          }
        );

        updatedDevice = device;
      });

      // The transaction is committed before MQTT publish.
      // The publisher uses the new device ID and the unchanged serial number.
      let publishResult;

      try {
        publishResult = await publishDeviceConfig(
          newDeviceId
        );
      } catch (mqttError) {
        console.error(
          '[DEVICE ID MIGRATION] MQTT publish failed:',
          mqttError.message
        );

        return res.status(502).json({
          success: false,
          error:
            'Device ID was updated in database, but firmware configuration publish failed',
          mqttError: mqttError.message,
          device: sanitizeDevice(updatedDevice),
        });
      }

      return res.status(200).json({
        success: true,
        message:
          'Device ID updated and configuration published',
        previousDeviceId: oldDeviceId,
        deviceId: newDeviceId,
        serialNumber: updatedDevice.serialNumber,
        device: sanitizeDevice(updatedDevice),
        config: {
          topic: publishResult.topic,
          nvsVersion: publishResult.nvsVersion,
          payload: {
            ...publishResult.payload,
            password: undefined,
          },
        },
      });
    } catch (error) {
      console.error(
        '[DEVICE ID MIGRATION] Error:',
        error
      );

      return res.status(
        error.statusCode || 500
      ).json({
        success: false,
        error:
          error.statusCode
            ? error.message
            : 'Device ID migration failed',
        details:
          error.statusCode
            ? undefined
            : error.message,
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
