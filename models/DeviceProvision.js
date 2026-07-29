// models/DeviceProvision.js
const mongoose = require('mongoose');

const deviceProvisionSchema = new mongoose.Schema({
  // Identity
  serialNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true,
    // Format: 10-digit string, e.g. "0312345678"
  },
  deviceId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    // e.g. "VIZ1A11" — the logical ID flashed to NVS
  },

  // Calibration values (match firmware NVS keys)
  cf: { type: Number, required: true, default: 0.231 },   // Current factor
  vf: { type: Number, required: true, default: 1.880 },   // Voltage factor
  currentRF: { type: Number, required: true, default: 0.001 }, // Shunt resistor factor

  // WiFi credentials (for BLE/OTA provisioning)
  wifiSSID: { type: String, required: true, trim: true },
  wifiPassword: { type: String, required: true },
  // Note: store encrypted in production. For now plaintext + env-level access control.

  // Firmware tracking
  targetFirmwareVersion: { type: String, default: null }, // e.g. "2.0.1"
  lastKnownFirmwareVersion: { type: String, default: null },

  // Add inside your Device schema:
configAckStatus:     { type: String, default: null },  // 'ok' | 'error' | null
configAckAt:         { type: Date,   default: null },  // when backend received ACK
configAckMessage:    { type: String, default: null },  // message from firmware
configAckFwVersion:  { type: String, default: null },  // firmware version at ACK time

  // Provisioning state
  provisionStatus: {
    type: String,
    enum: ['pending', 'sent', 'acknowledged', 'failed'],
    default: 'pending',
  },
  provisionedAt: { type: Date, default: null },  // when device ACKed config
  lastProvisionSentAt: { type: Date, default: null }, // when backend last published
  provisionedBy: { type: String, default: null }, // admin UID who triggered it

  // Linked to existing device doc (optional, set after device comes online)
  linkedDeviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    default: null,
  },

  // Notes / metadata
  notes: { type: String, default: '' },
  hardwareRevision: { type: String, default: '' }, // e.g. "PCB_V1.2"

}, { timestamps: true }); // gives createdAt + updatedAt automatically

module.exports = mongoose.models.DeviceProvision ||
  mongoose.model('DeviceProvision', deviceProvisionSchema);