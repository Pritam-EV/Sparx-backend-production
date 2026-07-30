// models/device.js
// ─────────────────────────────────────────────────────────────────────────────
// GROUP C — Live runtime document. Created automatically when a provisioned
// device first comes online and is claimed by an owner.
// ALL existing field names are preserved so no controller breaks.
// ─────────────────────────────────────────────────────────────────────────────
const mongoose = require('mongoose');

// ── Rate history sub-schema (admin or owner change tracked, last 1 entry) ────
const rateHistorySchema = new mongoose.Schema({
  rate:    { type: Number, required: true },
  setBy:   { type: String, required: true },   // Firebase UID or 'admin'
  setByRole: { type: String, enum: ['admin', 'owner'], required: true },
  setAt:   { type: Date, default: Date.now }
}, { _id: false });

// ── NVS config push tracking sub-schema ──────────────────────────────────────
const configAckSchema = new mongoose.Schema({
  status:    { type: String, enum: ['ok', 'error', 'pending'], default: null },
  ackedAt:   { type: Date, default: null },
  message:   { type: String, default: null },
  fwVersion: { type: String, default: null },
  nvsVersion:{ type: Number, default: null }   // monotonic counter for NVS
}, { _id: false });

// ── Main device schema ────────────────────────────────────────────────────────
const deviceSchema = new mongoose.Schema({

  // ── IDENTITY (set by admin at dispatch, never changed after) ───────────────
  device_id: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
    // e.g. "VIZ1A02" — same value flashed to NVS via DeviceProvision
  },
  serialNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
    // Links back to DeviceProvision.serialNumber
  },
  hardwareRevision: { type: String, trim: true, default: '' },  // e.g. "PCB_V1.2"
  project:          { type: String, trim: true, default: '' },  // e.g. "GLIDE", "VIZ"
  charger_type:     { type: String, required: true, default: '' },           // e.g. "AC_3.3KW"

  // ── OWNER(S) ────────────────────────────────────────────────────────────────
  // Owner self-registers via claim code; admin can add extra owners any time.
  // Only 1 owner can self-claim; admin can push more via backend.
  ownerId: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  }],

  // ── LOCATION (admin sets at dispatch; owner/admin can update after install) ─
  location:  { type: String, required: true },   // human-readable address
  lat:       { type: Number, required: true },
  lng:       { type: Number, required: true },
  area:      { type: String, required: true },
  city:      { type: String, required: true },
  state:     { type: String, required: true },

  // ── METER DETAILS (admin-set, owner can view) ────────────────────────────
  meterType: {
    type: String,
    enum: ['Green Meter', 'Commercial', 'Residential'],
    default: null
  },
  meterConsumerNumber: { type: String, trim: true, default: null },

  // ── RUNTIME STATE (updated by telemetry / session logic) ─────────────────
  status:              { type: String, required: true, default: 'offline' },
  relayOn:             { type: Boolean, default: false },
  lastSeen:            { type: Date, default: Date.now },
  totalenergy:         { type: Number, default: 0 },
  current_session_id:  {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Session',
    default: null
  },

  // ── CALIBRATION (admin-only, can be updated post-dispatch via admin portal) ─
  cf:        { type: Number, default: 0.231 },   // Current factor
  vf:        { type: Number, default: 1.880 },   // Voltage factor
  currentRF: { type: Number, default: 0.001 },   // Shunt resistor factor

  // ── WIFI CREDENTIALS (admin sets at dispatch; admin/owner can overwrite) ──
  // Stored here so admin portal and owner portal can push new creds via MQTT config topic.
  // Last-modified tracked via configAck.
  wifiSSID:     { type: String, trim: true, default: null },
  wifiPassword: { type: String, default: null },
  // ⚠️  Encrypt at rest in production (use mongoose-encryption or field-level encrypt)

  // ── FIRMWARE ────────────────────────────────────────────────────────────────
  lastKnownFirmwareVersion: { type: String, default: null },
  targetFirmwareVersion:    { type: String, default: null },
  nvsVersion:               { type: Number, default: 0 },
  // monotonic counter — increment on every config push; firmware echoes it back in ACK

  // ── CONFIG ACK (tracks last push from backend → device) ──────────────────
  configAck: { type: configAckSchema, default: () => ({}) },

  // ── PRICING ──────────────────────────────────────────────────────────────
  // 'rate' kept as primary field — all existing controllers continue to use it.
  // rateHistory keeps last 1 change only (as agreed).
  rate: { type: Number, required: true, default: 20 },
  rateHistory: {
    type: [rateHistorySchema],
    default: [],
    validate: {
      validator: function(arr) { return arr.length <= 1; },
      message: 'rateHistory must hold at most 1 entry (last change only)'
    }
  },

  // ── COMMERCIAL CONFIG (admin-only; affects analytics and payouts) ─────────
  commercial: {
    electricityBearer:  { type: String, enum: ['OWNER', 'VJRA'], default: 'OWNER' },
    userRatePerKwh:     { type: Number, default: null },
    vjraMarginPerKwh:   { type: Number, default: null },
    ownerSharePerKwh:   { type: Number, default: null },
    pgPercent:          { type: Number, default: null }
  },

  // ── ONBOARDING ────────────────────────────────────────────────────────────
  // 'pending'   → device dispatched, not yet claimed by any owner
  // 'approved'  → owner claimed + admin approved → device is live
  // 'rejected'  → flagged by admin
  onboardingStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  onboardedAt: { type: Date, default: null },
  onboardedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // ── PROVISION LINK ────────────────────────────────────────────────────────
  // Points back to the DeviceProvision doc for this serial; set at claim time.
  provisionRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DeviceProvision',
    default: null
  }

}, { timestamps: true });

// ── Indexes ───────────────────────────────────────────────────────────────────
deviceSchema.index({ device_id: 1 });
deviceSchema.index({ serialNumber: 1 });
deviceSchema.index({ ownerId: 1 });
deviceSchema.index({ status: 1 });
deviceSchema.index({ city: 1, state: 1 });

// ── Helper: update rate with history (call from controller) ──────────────────
// Usage: await device.setRate(newRate, byUID, byRole);
deviceSchema.methods.setRate = function(newRate, byUID, byRole) {
  this.rateHistory = [{ rate: newRate, setBy: byUID, setByRole: byRole, setAt: new Date() }];
  this.rate = newRate;
};

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = mongoose.models.Device || mongoose.model('Device', deviceSchema);