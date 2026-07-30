const DeviceProvision = require('../models/DeviceProvision');
const Device          = require('../models/device');

// ─── CREATE GROUP A ──────────────────────────────────────────────────────────
exports.createGroupA = async (req, res) => {
  try {
    const {
      serialNumber, hardwareRevision, project,
      charger_type, pcbBatch, manufacturedAt, productionNotes,
    } = req.body;

    if (!serialNumber || !hardwareRevision) {
      return res.status(400).json({
        success: false,
        message: 'serialNumber and hardwareRevision are required.',
      });
    }

    const existing = await DeviceProvision.findOne({ serialNumber });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `Serial number ${serialNumber} already exists in provision records.`,
      });
    }

    const provision = await DeviceProvision.create({
      serialNumber,
      hardwareRevision,
      project:            project          || '',
      charger_type:       charger_type     || null,
      pcbBatch:           pcbBatch         || null,
      manufacturedAt:     manufacturedAt   || new Date(),
      productionNotes:    productionNotes  || '',
      manufacturingStatus: 'group_a',       // ← correct field + value
      provisionedBy:      req.user.uid,     // Firebase UID string
    });

    return res.status(201).json({ success: true, data: provision });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET SINGLE GROUP A BY SERIAL ────────────────────────────────────────────
exports.getGroupA = async (req, res) => {
  try {
    const provision = await DeviceProvision.findOne({
      serialNumber:        req.params.serial,
      manufacturingStatus: 'group_a',        // ← correct field + value
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
    const { page = 1, limit = 50, pcbBatch, hwRevision } = req.query;
    const filter = { manufacturingStatus: 'group_a' };  // ← correct field + value
    if (pcbBatch)    filter.pcbBatch         = pcbBatch;
    if (hwRevision)  filter.hardwareRevision = hwRevision;  // ← correct field

    const [data, total] = await Promise.all([
      DeviceProvision.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      DeviceProvision.countDocuments(filter),
    ]);

    return res.json({ success: true, total, page: Number(page), data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── UPDATE GROUP A ───────────────────────────────────────────────────────────
exports.updateGroupA = async (req, res) => {
  try {
    const allowedFields = [
      'hardwareRevision', 'project', 'charger_type',   // ← hardwareRevision
      'pcbBatch', 'manufacturedAt', 'productionNotes',
    ];

    const updates = {};
    allowedFields.forEach((f) => {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    });

    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, message: 'No valid fields to update.' });
    }

    updates.provisionedBy = req.user.uid;  // track last modifier (string UID)

    const provision = await DeviceProvision.findOneAndUpdate(
      { serialNumber: req.params.serial, manufacturingStatus: 'group_a' },  // ← correct
      { $set: updates },
      { new: true }
    );

    if (!provision) return res.status(404).json({ success: false, message: 'Group A record not found.' });
    return res.json({ success: true, data: provision });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── DELETE GROUP A ───────────────────────────────────────────────────────────
exports.deleteGroupA = async (req, res) => {
  try {
    const provision = await DeviceProvision.findOne({
      serialNumber:        req.params.serial,
      manufacturingStatus: 'group_a',        // ← correct
    });
    if (!provision) return res.status(404).json({ success: false, message: 'Not found or already promoted.' });

    await provision.deleteOne();
    return res.json({ success: true, message: 'Group A record deleted.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── PROMOTE GROUP A → GROUP B ────────────────────────────────────────────────
exports.promoteToGroupB = async (req, res) => {
  try {
    const provision = await DeviceProvision.findOne({
      serialNumber:        req.params.serial,
      manufacturingStatus: 'group_a',         // ← correct
    });
    if (!provision) {
      return res.status(404).json({
        success: false,
        message: 'Group A record not found or already promoted.',
      });
    }

    const {
      deviceId, wifiSSID, wifiPassword,
      rate,                                   // ← 'rate' not 'defaultRate'
      location, lat, lng, area, city, state,
      charger_type, cf, vf, currentRF,
      meterType, meterConsumerNumber,
      commercial,
      targetFirmwareVersion,
      calibrationNotes, dispatchNotes,
    } = req.body;

    // Required for Group B promotion
    if (!deviceId || !wifiSSID || !wifiPassword || !rate || !location ||
        !lat || !lng || !area || !city || !state || !charger_type) {
      return res.status(400).json({
        success: false,
        message: 'deviceId, wifiSSID, wifiPassword, rate, location, lat, lng, area, city, state, charger_type are required for Group B promotion.',
      });
    }

    // Check deviceId uniqueness in BOTH collections
    const [takenInDevice, takenInProvision] = await Promise.all([
      Device.findOne({ device_id: deviceId }),
      DeviceProvision.findOne({ deviceId, serialNumber: { $ne: req.params.serial } }),
    ]);
    if (takenInDevice || takenInProvision) {
      return res.status(409).json({
        success: false,
        message: `deviceId ${deviceId} is already assigned to another device.`,
      });
    }

    const updated = await DeviceProvision.findOneAndUpdate(
      { serialNumber: req.params.serial },
      {
        $set: {
          manufacturingStatus:  'group_b',    // ← correct field + value
          deviceId,
          wifiSSID,
          wifiPassword,
          rate,                               // ← correct field name
          rateHistory: [{                     // seed first rateHistory entry
            rate,
            setBy:     req.user.uid,          // ← String (Firebase UID), not ObjectId
            setByRole: 'admin',               // ← required by schema
            setAt:     new Date(),
          }],
          location,
          lat,
          lng,
          area,
          city,
          state,
          charger_type:              charger_type,
          cf:                        cf              ?? 0.231,
          vf:                        vf              ?? 1.880,
          currentRF:                 currentRF       ?? 0.001,
          meterType:                 meterType       || null,
          meterConsumerNumber:       meterConsumerNumber || null,
          ...(commercial && { commercial }),
          targetFirmwareVersion:     targetFirmwareVersion || null,
          notes:                     calibrationNotes || '',
          dispatchNotes:             dispatchNotes    || '',
          provisionStatus:           'pending',
          provisionedBy:             req.user.uid,   // ← String UID
          promotedToGroupBAt:        new Date(),      // stored in notes field or add to schema if needed
        },
      },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: `Serial ${req.params.serial} promoted to Group B.`,
      data: updated,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};