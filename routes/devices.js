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
  createCalibration,
} = require("../services/calibrationService");

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

// ============================================
// NEW: Admin Devices Dashboard Routes
// MUST BE BEFORE other /admin routes
// ============================================

/**
 * GET /api/devices/admin/devices/summary
 * Get aggregated summary stats for devices dashboard
 */
router.get('/admin/devices/summary', 
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { project, city, state } = req.query;
      
      // Build filter object
      const filter = {};
      if (project) filter.project = project;
      if (city) filter.city = city;
      if (state) filter.state = state;

      // Aggregation pipeline for summary stats
      const summary = await Device.aggregate([
        { $match: filter },
        {
          $facet: {
            total: [{ $count: 'count' }],
            available: [{ $match: { status: 'Available' } }, { $count: 'count' }],
            occupied: [{ $match: { status: 'Occupied' } }, { $count: 'count' }],
            offline: [{ $match: { status: 'Offline' } }, { $count: 'count' }],
            faulty: [{ $match: { status: 'Faulty' } }, { $count: 'count' }],
            withSession: [{ $match: { current_session_id: { $ne: null } } }, { $count: 'count' }],
            relayOn: [{ $match: { relayOn: true } }, { $count: 'count' }]
          }
        }
      ]);

      const result = {
        total: summary[0].total[0]?.count || 0,
        available: summary[0].available[0]?.count || 0,
        occupied: summary[0].occupied[0]?.count || 0,
        offline: summary[0].offline[0]?.count || 0,
        faulty: summary[0].faulty[0]?.count || 0,
        withActiveSession: summary[0].withSession[0]?.count || 0,
        relayOn: summary[0].relayOn[0]?.count || 0,
        lastUpdated: new Date().toISOString()
      };

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      console.error('Error fetching device summary:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch device summary',
        error: error.message
      });
    }
  }
);

/**
 * GET /api/devices/admin/devices/table
 * Get paginated device list with filters for table display
 */
router.get('/admin/devices/table',
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        project,
        status,
        state,
        city,
        ownerId,
        search,
        sortBy = 'updatedAt',
        sortOrder = 'desc'
      } = req.query;

      // Build filter object
      const filter = {};
      
      if (project) filter.project = project;
      if (status) filter.status = status;
      if (state) filter.state = state;
      if (city) filter.city = city;
      if (ownerId) filter.ownerId = { $in: [ownerId] };
      
      // Search across multiple fields
      if (search) {
        filter.$or = [
          { device_id: { $regex: search, $options: 'i' } },
          { serialNumber: { $regex: search, $options: 'i' } },
          { project: { $regex: search, $options: 'i' } },
          { location: { $regex: search, $options: 'i' } }
        ];
      }

      // Calculate pagination
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const sortField = sortBy || 'updatedAt';
      const sortDirection = sortOrder === 'asc' ? 1 : -1;

      // Get total count
      const total = await Device.countDocuments(filter);

      // Get paginated data with only required fields
      const devices = await Device.find(filter)
        .select(`
          device_id serialNumber project status relayOn 
          lastKnownVoltage lastKnownCurrent 
          updatedAt city state ownerId current_session_id
        `)
        .sort({ [sortField]: sortDirection })
        .skip(skip)
        .limit(parseInt(limit))
        .lean();

      // Transform data for frontend
      const tableData = devices.map(device => ({
        deviceId: device.device_id,
        serialNumber: device.serialNumber,
        status: device.status || 'Offline',
        project: device.project || 'N/A',
        relayOn: device.relayOn || false,
        voltage: device.lastKnownVoltage || 0,
        current: device.lastKnownCurrent || 0,
        updatedAt: device.updatedAt,
        city: device.city || 'N/A',
        state: device.state || 'N/A',
        hasActiveSession: !!device.current_session_id
      }));

      res.json({
        success: true,
        data: tableData,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
          hasMore: skip + parseInt(limit) < total
        },
        lastUpdated: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error fetching device table data:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch device table data',
        error: error.message
      });
    }
  }
);

/**
 * GET /api/devices/admin/devices/:id
 * Get complete device details
 */
router.get('/admin/devices/:id',
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      
      // Try multiple fields, avoid casting non-ObjectId strings to _id
      const device = await Device.findOne({
        $or: [
          { device_id: id },
          { serialNumber: id }
        ]
      }).lean();

      if (!device) {
        return res.status(404).json({
          success: false,
          message: 'Device not found'
        });
      }

      res.json({
        success: true,
        data: device
      });
    } catch (error) {
      console.error('Error fetching device details:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch device details',
        error: error.message
      });
    }
  }
);


// ============================================
// EXISTING ROUTES BELOW
// ============================================

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

// POST /api/devices/admin/calibration/:deviceId
router.post(
  "/admin/calibration/:deviceId",
  authMiddleware,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const result = await createCalibration({
        deviceId: req.params.deviceId,
        referenceVoltage:
          req.body.referenceVoltage,
        referenceCurrent:
          req.body.referenceCurrent,
        liveVoltage:
          req.body.liveVoltage,
        liveCurrent:
          req.body.liveCurrent,
        expectedNvsVersion:
          req.body.expectedNvsVersion,
        createdBy:
          req.user?.uid ||
          req.user?.userId ||
          req.user?._id ||
          null,
      });

      return res.status(202).json({
        success: true,
        calibration: result,
      });
    } catch (error) {
      console.error(
        "[ADMIN CALIBRATION]",
        error
      );

      return res.status(
        error.statusCode || 500
      ).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// Check if a device exists
router.get("/check-device/:device_id", async (req, res) => {
  try {
    const { device_id } = req.params;

    if (!device_id) {
      return res.status(400).json({ error: "Device ID is required" });
    }

    const device = await Device.findOne({ device_id: req.params.device_id });

    if (device) {
      return res.json({ exists: !!device, device });
    } else {
      return res.json({ exists: false });
    }
  } catch (error) {
    console.error("Error checking device:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 3) Owner's devices (auth, scoped) for dashboards
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
      const { area, city, state, status, project } = req.query;
      const query = {};
      if (area) query.area = area;
      if (city) query.city = city;
      if (state) query.state = state;
      if (status) query.status = status;
      if (project) query.project = project;

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

      const now = Date.now();
      const STALE_MS = 3000 * 1000;

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

        const last = d.lastSeen ? new Date(d.lastSeen).getTime() : 0;
        d.isStale = !last || (now - last) > STALE_MS;
        if (d.isStale) summary.stale += 1;

        d.relayOnWithoutSession = !!(d.relayOn && !d.current_session_id);
        if (d.relayOnWithoutSession) summary.relayWithoutSession += 1;

        if (!d.commercial) d.commercial = {};
      }

      return res.json({ devices, summary });
    } catch (err) {
      console.error('admin-dashboard error:', err);
      res.status(500).json({ error: 'Internal server error', details: err.message });
    }
  }
);




// GET /api/devices/admin/live-devices/filter-options
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
        Device.distinct('area', { device_id: { $in: deviceIds }, area: { $ne: null, $ne: '' } }),
        Device.distinct('status', { device_id: { $in: deviceIds }, status: { $ne: null, $ne: '' } }),
      ]);

      res.json({ projects, areas, statuses });
    } catch (err) {
      console.error("Filter options error:", err);
      res.status(500).json({ error: "Failed to fetch filter options" });
    }
  }
);

/**
 * GET /api/devices/admin/devices/filters/options
 * Get unique values for filter dropdowns
 */
router.get('/admin/devices/filters/options',
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      // Get unique projects
      const projects = await Device.distinct('project', { project: { $ne: null, $ne: '' } });
      
      // Get unique cities
      const cities = await Device.distinct('city', { city: { $ne: null, $ne: '' } });
      
      // Get unique states
      const states = await Device.distinct('state', { state: { $ne: null, $ne: '' } });
      
      // Get unique status values
      const statuses = await Device.distinct('status');

      res.json({
        success: true,
        data: {
          projects: projects.sort(),
          cities: cities.sort(),
          states: states.sort(),
          statuses: statuses.sort()
        }
      });
    } catch (error) {
      console.error('Error fetching filter options:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch filter options',
        error: error.message
      });
    }
  }
);

/**
 * GET /api/devices/admin/devices/table-with-telemetry
 * Get paginated device list WITH live voltage/current from telemetry
 */
router.get('/admin/devices/table-with-telemetry',
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        project,
        status,
        state,
        city,
        ownerId,
        search,
        sortBy = 'updatedAt',
        sortOrder = 'desc'
      } = req.query;

      // Build filter object
      const filter = {};
      
      if (project) filter.project = project;
      if (status) filter.status = status;
      if (state) filter.state = state;
      if (city) filter.city = city;
      if (ownerId) filter.ownerId = { $in: [ownerId] };
      
      if (search) {
        filter.$or = [
          { device_id: { $regex: search, $options: 'i' } },
          { serialNumber: { $regex: search, $options: 'i' } },
          { project: { $regex: search, $options: 'i' } },
          { location: { $regex: search, $options: 'i' } }
        ];
      }

      // Calculate pagination
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const sortField = sortBy || 'updatedAt';
      const sortDirection = sortOrder === 'asc' ? 1 : -1;

      // Get paginated devices
      const devices = await Device.find(filter)
        .select('device_id serialNumber project status relayOn updatedAt city state ownerId current_session_id totalenergy lastSeen')
        .sort({ [sortField]: sortDirection })
        .skip(skip)
        .limit(parseInt(limit))
        .lean();

      // Get device IDs for telemetry query
      const deviceIds = devices.map(d => d.device_id);

      // Get latest telemetry for all devices in one query
      const latestTelemetry = await DeviceTelemetry.aggregate([
        {
          $match: {
            deviceId: { $in: deviceIds }
          }
        },
        {
          $sort: { timestamp: -1 }
        },
        {
          $group: {
            _id: '$deviceId',
            voltage: { $first: '$voltage' },
            current: { $first: '$current' },
            timestamp: { $first: '$timestamp' }
          }
        }
      ]);

      // Create a map for quick lookup
      const telemetryMap = {};
      latestTelemetry.forEach(t => {
        telemetryMap[t._id] = {
          voltage: t.voltage,
          current: t.current,
          timestamp: t.timestamp
        };
      });

      // Transform data for frontend
      const tableData = devices.map(device => {
        const telemetry = telemetryMap[device.device_id] || { voltage: 0, current: 0 };
        
        return {
          deviceId: device.device_id,
          serialNumber: device.serialNumber,
          status: device.status || 'Offline',
          project: device.project || 'N/A',
          relayOn: device.relayOn || false,
          voltage: telemetry.voltage || 0,
          current: telemetry.current || 0,
          telemetryTimestamp: telemetry.timestamp,
          updatedAt: device.updatedAt,
          city: device.city || 'N/A',
          state: device.state || 'N/A',
          hasActiveSession: !!device.current_session_id,
          totalenergy: device.totalenergy || 0,
          lastSeen: device.lastSeen
        };
      });

      // Get total count
      const total = await Device.countDocuments(filter);

      res.json({
        success: true,
        data: tableData,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
          hasMore: skip + parseInt(limit) < total
        },
        lastUpdated: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error fetching device table with telemetry:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch device table with telemetry',
        error: error.message
      });
    }
  }
);

// GET /api/devices/admin/live-devices
router.get(
  "/admin/live-devices",
  authMiddleware,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const { project, area, status } = req.query;

      const telemetryDocs = await DeviceTelemetry.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $group: { _id: "$deviceId" } },
      ]);
      const deviceIdsWithTelemetry = telemetryDocs.map(d => d._id);

      const deviceQuery = { device_id: { $in: deviceIdsWithTelemetry } };
      if (project) deviceQuery.project = project;
      if (area) deviceQuery.area = area;
      if (status) deviceQuery.status = status;

      const devices = await Device.find(
        deviceQuery,
        'device_id status area project city state location lastSeen'
      ).lean();

      res.json(devices);

    } catch (err) {
      console.error("Live devices error:", err);
      res.status(500).json({ error: "Failed to fetch devices" });
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

// GET latest voltage/current for one selected device
router.get(
  "/admin/telemetry/:deviceId",
  authMiddleware,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const deviceId = getNormalizedDeviceId(
        req.params.deviceId
      );

      if (!deviceId) {
        return res.status(400).json({
          error: "Device ID is required",
        });
      }

      const latestTelemetry =
        await DeviceTelemetry.findOne(
          { deviceId },
          {
            _id: 0,
            deviceId: 1,
            voltage: 1,
            current: 1,
            timestamp: 1,
          }
        ).sort({ timestamp: -1 }).lean();

      if (!latestTelemetry) {
        return res.status(404).json({
          error: "No telemetry found for this device",
          deviceId,
        });
      }

      return res.json({
        deviceId: latestTelemetry.deviceId,
        voltage: latestTelemetry.voltage ?? null,
        current: latestTelemetry.current ?? null,
        timestamp: latestTelemetry.timestamp ?? null,
      });
    } catch (error) {
      console.error(
        "[ADMIN DEVICE TELEMETRY]",
        error
      );

      return res.status(500).json({
        error: "Failed to fetch latest telemetry",
      });
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
  }
);

// PUT /api/devices/:id
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
router.post(
  '/:deviceId/claim',
  authMiddleware,
  authorizeRoles('owner'),
  async (req, res) => {
    try {
      const deviceId = req.params.deviceId.toUpperCase();
      const userId = req.user.userId;

      const device = await Device.findOne({ device_id: deviceId });
      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      if (device.onboardingStatus !== 'pending') {
        return res.status(400).json({
          error: 'Device is not in a claimable state',
          onboardingStatus: device.onboardingStatus,
        });
      }

      const alreadyOwner = Array.isArray(device.ownerId)
        ? device.ownerId.some(id => id.toString() === userId.toString())
        : device.ownerId && device.ownerId.toString() === userId.toString();

      if (!alreadyOwner) {
        if (!Array.isArray(device.ownerId)) {
          device.ownerId = [];
        }

        device.ownerId.push(userId);

        device.onboardingStatus = 'approved';
        device.onboardedAt = new Date();
        device.onboardedBy = userId;

        await device.save();

        return res.status(200).json({
          device,
          message: 'Device claimed successfully',
        });
      }
    } catch (err) {
      console.error('[OWNER CLAIM] Error:', err);
      return res.status(500).json({ error: 'Failed to claim device', details: err.message });
    }
  }
);

// Admin/owner only: Can view details
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