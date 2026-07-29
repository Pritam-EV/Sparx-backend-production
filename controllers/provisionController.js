// controllers/provisionController.js
const DeviceProvision = require('../models/DeviceProvision');
const mqttClient = require('../mqttClient');

// Build config topic from serialNumber (matches firmware: viz/<serial>/config)
const configTopic = (serial) => `viz/${serial}/config`;
const adminTopic  = (deviceId) => `viz/${deviceId}/admincmd`;

// ── CREATE / REGISTER a device record ──────────────────────────────────────
exports.createProvision = async (req, res) => {
  try {
    const { serialNumber, deviceId, cf, vf, currentRF,
            wifiSSID, wifiPassword, hardwareRevision, notes } = req.body;

    if (!serialNumber || !deviceId || !wifiSSID || !wifiPassword) {
      return res.status(400).json({ error: 'serialNumber, deviceId, wifiSSID, wifiPassword are required' });
    }

    const existing = await DeviceProvision.findOne({
      $or: [{ serialNumber }, { deviceId }]
    });
    if (existing) {
      return res.status(409).json({
        error: 'Device with this serialNumber or deviceId already exists',
        existing,
      });
    }

    const doc = await DeviceProvision.create({
      serialNumber, deviceId, cf, vf, currentRF,
      wifiSSID, wifiPassword, hardwareRevision, notes,
      provisionedBy: req.adminUid,
    });

    res.status(201).json({ success: true, device: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── SEND PROVISION COMMAND via MQTT ────────────────────────────────────────
exports.sendProvision = async (req, res) => {
  try {
    const { serialNumber } = req.params;
    const doc = await DeviceProvision.findOne({ serialNumber });
    if (!doc) return res.status(404).json({ error: 'Device not found' });

    const payload = {
      action:    'setConfig',
      deviceId:  doc.deviceId,
      cf:        doc.cf,
      vf:        doc.vf,
      currentRF: doc.currentRF,
      ssid:      doc.wifiSSID,
      password:  doc.wifiPassword,
    };

    const topic = configTopic(serialNumber);
    const msg   = JSON.stringify(payload);

    mqttClient.publish(topic, msg, { qos: 1 }, async (err) => {
      if (err) {
        return res.status(500).json({ error: 'MQTT publish failed', detail: err.message });
      }

      doc.provisionStatus     = 'sent';
      doc.lastProvisionSentAt = new Date();
      await doc.save();

      console.log(`[PROVISION] Sent to ${topic}:`, msg);
      res.json({ success: true, topic, payload });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── GET ALL provisions (list for admin panel table) ─────────────────────────
exports.listProvisions = async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.provisionStatus = status;
    if (search) filter.$or = [
      { serialNumber: new RegExp(search, 'i') },
      { deviceId:     new RegExp(search, 'i') },
    ];

    const [docs, total] = await Promise.all([
      DeviceProvision.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select('-wifiPassword'), // never return password in list
      DeviceProvision.countDocuments(filter),
    ]);

    res.json({ success: true, total, page: Number(page), docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── GET single provision (for edit form) ────────────────────────────────────
exports.getProvision = async (req, res) => {
  try {
    const doc = await DeviceProvision
      .findOne({ serialNumber: req.params.serialNumber })
      .select('-wifiPassword'); // omit password from GET
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, device: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── UPDATE provision config ─────────────────────────────────────────────────
exports.updateProvision = async (req, res) => {
  try {
    const allowed = ['cf', 'vf', 'currentRF', 'wifiSSID', 'wifiPassword',
                     'targetFirmwareVersion', 'notes', 'hardwareRevision'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    updates.provisionStatus = 'pending'; // mark as needing re-send

    const doc = await DeviceProvision.findOneAndUpdate(
      { serialNumber: req.params.serialNumber },
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-wifiPassword');

    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, device: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── ADMIN COMMAND (reset, OTA, status, checkVersion) ───────────────────────
exports.sendAdminCmd = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { action, ...rest } = req.body;

    if (!action) return res.status(400).json({ error: 'action is required' });

    const topic   = adminTopic(deviceId);
    const payload = JSON.stringify({ action, ...rest });

    mqttClient.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) return res.status(500).json({ error: 'MQTT publish failed', detail: err.message });
      console.log(`[ADMINCMD] ${topic}:`, payload);
      res.json({ success: true, topic, payload: { action, ...rest } });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── ACK from device (called by mqttSubscriber when device confirms config) ──
exports.markAcknowledged = async (serialNumber) => {
  await DeviceProvision.findOneAndUpdate(
    { serialNumber },
    { provisionStatus: 'acknowledged', provisionedAt: new Date() }
  );
  console.log(`[PROVISION] Device ${serialNumber} acknowledged config`);
};