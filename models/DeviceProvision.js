// models/DeviceProvision.js
// ─────────────────────────────────────────────────────────────────────────────
// GROUP A  →  GROUP B  pre-dispatch lifecycle document.
//
// GROUP A (manufacturingStatus: 'group_a')
//   Created at production entry. Only serialNumber + hardwareRevision needed.
//   All other fields optional — no blocking `required` validators here.
//
// GROUP B (manufacturingStatus: 'group_b')
//   After calibration and dispatch config. Admin sets deviceId, WiFi, cf, vf,
//   rates, location, charger_type. Device is then dispatched to owner.
//   On first device boot + owner claim, a Device (Group C) doc is auto-created
//   from this provision doc and linkedDeviceId is stamped here.
// ─────────────────────────────────────────────────────────────────────────────
const mongoose = require('mongoose');

// ── Rate history (same shape as device.js, last 1 entry) ─────────────────────
const rateHistorySchema = new mongoose.Schema({
  rate:      { type: Number, required: true },
  setBy:     { type: String, required: true },
  setByRole: { type: String, enum: ['admin', 'owner'], required: true },
  setAt:     { type: Date, default: Date.now }
}, { _id: false });

// ── Config ACK tracking (echoed back by firmware after config push) ───────────
const configAckSchema = new mongoose.Schema({
  status:     { type: String, enum: ['ok', 'error', 'pending'], default: null },
  ackedAt:    { type: Date, default: null },
  message:    { type: String, default: null },
  fwVersion:  { type: String, default: null },
  nvsVersion: { type: Number, default: null }
}, { _id: false });

// ── Main provision schema ─────────────────────────────────────────────────────
const deviceProvisionSchema = new mongoose.Schema({

  // ── MANUFACTURING STATUS ──────────────────────────────────────────────────
  // group_a  → entered at production, not yet calibrated
  // group_b  → calibrated, dispatch-configured, ready to ship
  // dispatched → physically sent to owner
  // live       → Device (Group C) doc created and device is online
  manufacturingStatus: {
    type: String,
    enum: ['group_a', 'group_b', 'dispatched', 'live'],
    default: 'group_a',
    index: true
  },

  // ── IDENTITY ─────────────────────────────────────────────────────────────
  // serialNumber: set at Group A entry (factory-assigned, physical sticker)
  serialNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  // deviceId: set by admin at Group B (dispatch config) — e.g. "VIZ1A02"
  // Not required at Group A; admin assigns before dispatch.
  deviceId: {
    type: String,
    unique: true,
    sparse: true,   // sparse so null values don't violate unique constraint at Group A
    trim: true,
    default: null
  },
  hardwareRevision: { type: String, trim: true, default: '' },  // e.g. "PCB_V1.2"
  project:          { type: String, trim: true, default: '' },  // e.g. "GLIDE", "VIZ"
  charger_type:     { type: String, trim: true, default: null },

  // ── CALIBRATION (set at Group B by admin, admin-editable post-dispatch) ───
  cf:        { type: Number, default: 0.231 },
  vf:        { type: Number, default: 1.880 },
  currentRF: { type: Number, default: 0.001 },

  // ── WIFI CREDENTIALS (set at Group B by admin, admin/owner-editable) ──────
  // These are pushed to device NVS on first boot / config update.
  // Admin sets default at dispatch (for owner testing before installation).
  // Owner or admin can overwrite any time via their portals.
  wifiSSID:     { type: String, trim: true, default: null },
  wifiPassword: { type: String, default: null },
  // ⚠️  Encrypt at rest in production

  // ── LOCATION (set at Group B by admin, admin/owner-editable post-install) ─
  location: { type: String, trim: true, default: null },
  lat:      { type: Number, default: null },
  lng:      { type: Number, default: null },
  area:     { type: String, trim: true, default: null },
  city:     { type: String, trim: true, default: null },
  state:    { type: String, trim: true, default: null },

  // ── METER DETAILS (set at Group B by admin) ──────────────────────────────
  meterType: {
    type: String,
    enum: ['Green Meter', 'Commercial', 'Residential'],
    default: null
  },
  meterConsumerNumber: { type: String, trim: true, default: null },

  // ── PRICING (set at Group B by admin; admin-only editable) ───────────────
  rate:        { type: Number, default: 20 },
  rateHistory: {
    type: [rateHistorySchema],
    default: [],
    validate: {
      validator: function(arr) { return arr.length <= 1; },
      message: 'rateHistory must hold at most 1 entry'
    }
  },

  // ── COMMERCIAL (set at Group B by admin) ─────────────────────────────────
  commercial: {
    electricityBearer: { type: String, enum: ['OWNER', 'VJRA'], default: 'OWNER' },
    userRatePerKwh:    { type: Number, default: null },
    vjraMarginPerKwh:  { type: Number, default: null },
    ownerSharePerKwh:  { type: Number, default: null },
    pgPercent:         { type: Number, default: null }
  },

  // ── FIRMWARE ─────────────────────────────────────────────────────────────
  targetFirmwareVersion:    { type: String, default: null },
  lastKnownFirmwareVersion: { type: String, default: null },
  nvsVersion:               { type: Number, default: 0 },

  // ── PROVISIONING STATE ────────────────────────────────────────────────────
  // pending      → Group B config ready, not yet sent to device
  // sent         → backend published config to MQTT provision topic
  // acknowledged → firmware echoed back ACK
  // failed       → firmware reported error
  provisionStatus: {
    type: String,
    enum: ['pending', 'sent', 'acknowledged', 'failed'],
    default: 'pending'
  },
  provisionedAt:       { type: Date, default: null },
  lastProvisionSentAt: { type: Date, default: null },
  provisionedBy:       { type: String, default: null },  // admin Firebase UID

  // ── CONFIG ACK ────────────────────────────────────────────────────────────
  configAck: { type: configAckSchema, default: () => ({}) },

  // ── DISPATCH TRACKING ────────────────────────────────────────────────────
  dispatchedAt:  { type: Date, default: null },
  dispatchedBy:  { type: String, default: null },  // admin Firebase UID
  dispatchNotes: { type: String, default: '' },

  // ── LINK TO LIVE DEVICE DOC (Group C) ────────────────────────────────────
  // Stamped when device first comes online and Device doc is auto-created.
  linkedDeviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    default: null
  },

  // ── MISC ──────────────────────────────────────────────────────────────────
  notes: { type: String, default: '' }

}, { timestamps: true });

// ── Indexes ───────────────────────────────────────────────────────────────────
deviceProvisionSchema.index({ serialNumber: 1 });
deviceProvisionSchema.index({ deviceId: 1 });
deviceProvisionSchema.index({ manufacturingStatus: 1 });

// ── Helper: promote Group A → Group B ─────────────────────────────────────────
// Usage: await provision.promoteToGroupB(adminUID);
deviceProvisionSchema.methods.promoteToGroupB = function(adminUID) {
  const required = ['deviceId', 'wifiSSID', 'wifiPassword', 'location', 'lat', 'lng',
                    'area', 'city', 'state', 'charger_type', 'rate'];
  const missing = required.filter(f => !this[f] && this[f] !== 0);
  if (missing.length) {
    throw new Error(`Cannot promote to Group B. Missing fields: ${missing.join(', ')}`);
  }
  this.manufacturingStatus = 'group_b';
  this.provisionedBy = adminUID;
};

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = mongoose.models.DeviceProvision ||
  mongoose.model('DeviceProvision', deviceProvisionSchema);