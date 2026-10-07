const DeviceProvision = require('../models/DeviceProvision');
const Device = require('../models/device');

const {
  MANUFACTURING_STATUS,
  normalizeDeviceId,
  normalizeSerialNumber,
} = require('../config/deviceProtocol');
const { publishProvisionConfig } = require('../services/configPublisher');

// ─── CREATE GROUP A ──────────────────────────────────────────────────────────
const createGroupA = async (req, res) => {
  try {
    const {
      serialNumber,
      hardwareRevision,
      project,
      pcbBatch,
      manufacturedAt,
      notes,
    } = req.body;

    if (!serialNumber || !hardwareRevision) {
      return res.status(400).json({
        success: false,
        message:
          'serialNumber and hardwareRevision are required',
      });
    }

    const normalizedSerial =
      normalizeSerialNumber(serialNumber);

    const existing = await DeviceProvision.findOne({
      serialNumber: normalizedSerial,
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message:
          `Serial number ${normalizedSerial} already exists`,
      });
    }

    const provision = await DeviceProvision.create({
      serialNumber: normalizedSerial,
      hardwareRevision: hardwareRevision.trim(),
      project: project || '',
      pcbBatch: pcbBatch || null,
      manufacturedAt: manufacturedAt || new Date(),
      notes: notes || '',
      manufacturingStatus:
        MANUFACTURING_STATUS.GROUP_A,
      provisionStatus: 'pending',
      provisionedBy:
        req.user?.uid ||
        req.user?.userId ||
        req.user?._id ||
        null,
    });

    return res.status(201).json({
      success: true,
      data: provision,
    });
  } catch (error) {
    console.error('[GROUP A CREATE]', error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─── GET SINGLE GROUP A BY SERIAL ────────────────────────────────────────────
const getGroupA = async (req, res) => {
  try {
    const provision = await DeviceProvision.findOne({
      serialNumber: normalizeSerialNumber(
        req.params.serial
      ),
      manufacturingStatus:
        MANUFACTURING_STATUS.GROUP_A,
    });
    if (!provision) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, data: provision });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET ALL GROUP A ──────────────────────────────────────────────────────────
const getAllGroupA = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);

    const filter = {
      manufacturingStatus: MANUFACTURING_STATUS.GROUP_A,
    };

    if (req.query.pcbBatch) {
      filter.pcbBatch = req.query.pcbBatch;
    }

    if (req.query.hardwareRevision) {
      filter.hardwareRevision = req.query.hardwareRevision;
    }

    const [data, total] = await Promise.all([
      DeviceProvision.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      DeviceProvision.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      total,
      page,
      limit,
      data,
    });
  } catch (error) {
    console.error('[GROUP A LIST]', error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─── UPDATE GROUP A ───────────────────────────────────────────────────────────
const updateGroupA = async (req, res) => {
  try {
    const allowedFields = [
      'hardwareRevision',
      'project',
      'pcbBatch',
      'manufacturedAt',
      'notes',
    ];

    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid Group A fields supplied',
      });
    }

    const serialNumber = normalizeSerialNumber(req.params.serial);

    const provision = await DeviceProvision.findOneAndUpdate(
      {
        serialNumber,
        manufacturingStatus: MANUFACTURING_STATUS.GROUP_A,
      },
      {
        $set: updates,
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!provision) {
      return res.status(404).json({
        success: false,
        message: 'Group A record not found',
      });
    }

    return res.json({
      success: true,
      data: provision,
    });
  } catch (error) {
    console.error('[GROUP A UPDATE]', error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─── DELETE GROUP A ───────────────────────────────────────────────────────────
const deleteGroupA = async (req, res) => {
  try {
    const serialNumber = normalizeSerialNumber(req.params.serial);

    const provision = await DeviceProvision.findOne({
      serialNumber,
      manufacturingStatus: MANUFACTURING_STATUS.GROUP_A,
    });

    if (!provision) {
      return res.status(404).json({
        success: false,
        message: 'Group A record not found or already promoted',
      });
    }

    await provision.deleteOne();

    return res.json({
      success: true,
      message: 'Group A record deleted',
    });
  } catch (error) {
    console.error('[GROUP A DELETE]', error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─── PROMOTE GROUP A → GROUP B ────────────────────────────────────────────────
const promoteToGroupB = async (req, res) => {
  try {
    const serialNumber =
      normalizeSerialNumber(req.params.serial);

    const provision = await DeviceProvision.findOne({
      serialNumber,
      manufacturingStatus:
        MANUFACTURING_STATUS.GROUP_A,
    });

    if (!provision) {
      return res.status(404).json({
        success: false,
        message:
          'Group A record not found or already promoted',
      });
    }

    const {
      deviceId,
      wifiSSID,
      wifiPassword,
      cf,
      vf,
      currentRF,
      rate,
      location,
      lat,
      lng,
      area,
      city,
      state,
      charger_type,
      meterType,
      meterConsumerNumber,
      commercial,
      targetFirmwareVersion,
      notes,
    } = req.body;

    const normalizedDeviceId =
      normalizeDeviceId(deviceId);

    const required = {
      deviceId: normalizedDeviceId,
      wifiSSID,
      wifiPassword,
      rate,
      location,
      lat,
      lng,
      area,
      city,
      state,
      charger_type,
    };

    const missing = Object.entries(required)
      .filter(
        ([, value]) =>
          value === undefined ||
          value === null ||
          value === ''
      )
      .map(([field]) => field);

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message:
          `Missing Group B fields: ${missing.join(', ')}`,
      });
    }

    const duplicate = await DeviceProvision.findOne({
      deviceId: normalizedDeviceId,
      _id: { $ne: provision._id },
    });

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message:
          `Device ID ${normalizedDeviceId} is already assigned`,
      });
    }

    provision.deviceId = normalizedDeviceId;
    provision.wifiSSID = wifiSSID;
    provision.wifiPassword = wifiPassword;

    provision.cf = cf ?? provision.cf;
    provision.vf = vf ?? provision.vf;
    provision.currentRF =
      currentRF ?? provision.currentRF;

    provision.rate = Number(rate);

    provision.location = location;
    provision.lat = Number(lat);
    provision.lng = Number(lng);
    provision.area = area;
    provision.city = city;
    provision.state = state;
    provision.charger_type = charger_type;

    provision.meterType = meterType ?? null;
    provision.meterConsumerNumber =
      meterConsumerNumber ?? null;

    provision.commercial =
      commercial ?? provision.commercial;

    provision.targetFirmwareVersion =
      targetFirmwareVersion ?? null;

    provision.notes = notes ?? provision.notes;

    provision.rateHistory = [
      {
        rate: Number(rate),
        setBy:
          req.user?.uid ||
          req.user?.userId ||
          req.user?._id ||
          'admin',
        setByRole: 'admin',
        setAt: new Date(),
      },
    ];

    provision.manufacturingStatus =
      MANUFACTURING_STATUS.GROUP_B;

    provision.provisionStatus = 'pending';
    provision.provisionedAt = new Date();
    provision.provisionedBy =
      req.user?.uid ||
      req.user?.userId ||
      req.user?._id ||
      null;

    await provision.save();

    // Publish the initial Group B configuration.
    const publishResult =
      await publishProvisionConfig(provision._id);

    return res.status(200).json({
      success: true,
      message:
        `Serial ${serialNumber} promoted to Group B`,
      data: provision,
      config: {
        topic: publishResult.topic,
        nvsVersion: publishResult.nvsVersion,
      },
    });
  } catch (error) {
    console.error('[GROUP B PROMOTION]', error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─── GET ALL PROVISION / MANUFACTURING DEVICES ───────────────────────────────
// Admin dashboard:
// Returns Group A, Group B, Dispatched and Live provision records.
//
// Optional query params:
//   ?status=group_b
//   ?status=dispatched
//   ?search=VIZ1A01
//   ?page=1&limit=100
//
// This endpoint is intentionally read-only.
const getAllProvisionDevices = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(
      Math.max(Number(req.query.limit) || 100, 1),
      500
    );

    const filter = {};

    // Filter by manufacturing lifecycle if requested
    if (req.query.status) {
      filter.manufacturingStatus = req.query.status;
    }

    // Search serial number / device ID
    if (req.query.search) {
      const searchRegex = new RegExp(req.query.search, 'i');

      filter.$or = [
        { serialNumber: searchRegex },
        { deviceId: searchRegex },
      ];
    }

    const [data, total] = await Promise.all([
      DeviceProvision.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('-wifiPassword')
        .lean(),

      DeviceProvision.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      total,
      page,
      limit,
      data,
    });

  } catch (error) {
    console.error('[ALL PROVISION DEVICES]', error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ============================================
// NEW: Admin Dashboard Device Controllers
// ============================================

/**
 * Get device summary statistics
 */
const getDeviceSummary = async (req, res) => {
  try {
    const { project, city, state } = req.query;
    
    const filter = {};
    if (project) filter.project = project;
    if (city) filter.city = city;
    if (state) filter.state = state;

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

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('Get device summary error:', error);
    return res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

/**
 * Get paginated device table data
 */
const getDeviceTableData = async (req, res) => {
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

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Device.countDocuments(filter);

    const devices = await Device.find(filter)
      .select('device_id serialNumber project status relayOn lastKnownVoltage lastKnownCurrent updatedAt city state ownerId current_session_id')
      .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

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

    return res.json({
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
    console.error('Get device table data error:', error);
    return res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

/**
 * Get complete device details
 */
const getDeviceDetails = async (req, res) => {
  try {
    const { id } = req.params;
    
    const device = await Device.findOne({
      $or: [
        { device_id: id },
        { serialNumber: id },
        { _id: id }
      ]
    }).lean();

    if (!device) {
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }

    return res.json({ success: true, data: device });
  } catch (error) {
    console.error('Get device details error:', error);
    return res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

/**
 * Get filter dropdown options
 */
const getFilterOptions = async (req, res) => {
  try {
    const [projects, cities, states, statuses] = await Promise.all([
      Device.distinct('project', { project: { $ne: null, $ne: '' } }),
      Device.distinct('city', { city: { $ne: null, $ne: '' } }),
      Device.distinct('state', { state: { $ne: null, $ne: '' } }),
      Device.distinct('status')
    ]);

    return res.json({
      success: true,
      data: {
        projects: projects.sort(),
        cities: cities.sort(),
        states: states.sort(),
        statuses: statuses.sort()
      }
    });
  } catch (error) {
    console.error('Get filter options error:', error);
    return res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// Export all functions
module.exports = {
  createGroupA,
  getGroupA,
  getAllGroupA,
  updateGroupA,
  deleteGroupA,
  promoteToGroupB,
  getAllProvisionDevices,
  getDeviceSummary,
  getDeviceTableData,
  getDeviceDetails,
  getFilterOptions
};