const DeviceProvision = require('../models/DeviceProvision');

const {
  MANUFACTURING_STATUS,
  normalizeDeviceId,
  normalizeSerialNumber,
} = require('../config/deviceProtocol');
const { publishProvisionConfig } = require('../services/configPublisher');

// ─── CREATE GROUP A ──────────────────────────────────────────────────────────
exports.createGroupA = async (req, res) => {
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
exports.getGroupA = async (req, res) => {
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
exports.getAllGroupA = async (req, res) => {
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
exports.updateGroupA = async (req, res) => {
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
exports.deleteGroupA = async (req, res) => {
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
exports.promoteToGroupB = async (req, res) => {
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