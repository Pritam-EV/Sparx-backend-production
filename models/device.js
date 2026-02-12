// models/device.js
const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  // legacy fields (keep unchanged for compatibility)
  device_id: { type: String, required: true },
  serialNumber: { type: String, required: false, trim: true },

  // owners (legacy array kept)
  ownerId: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],



  // meter details (existing names preserved)
  meterType: { 
    type: String, 
    enum: ['Green Meter', 'Commercial', 'Residential'], 
    required: false 
  },
  meterConsumerNumber: { type: String, required: false, trim: true },

  // location + basic device telemetry (unchanged)
  location: { type: String, required: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },

  status: { type: String, required: true },
  charger_type: { type: String, required: true },

  current_session_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },

  // legacy pricing field (keep using this in controllers)
  rate: { type: Number, required: true, default: 20 },

  area: { type: String, required: true },
  city: { type: String, required: true },
  state: { type: String, required: true },

  totalenergy: { type: Number, required: false, default: 0 },

  relayOn: { type: Boolean, default: false },

  lastSeen: { type: Date, default: Date.now },


  // onboarding metadata (kept)
  onboardingStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  onboardedAt: { type: Date },
  onboardedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // ---------------------------------------------------------
  // NEW: commercial object (non-breaking addition)
  // ---------------------------------------------------------
  // This groups the commercial / admin-controlled config.
  // We DO NOT remove or change existing fields — controllers continue to use 'rate', 'commissionPerKwh', 'PGPercent'.
  commercial: {
    // Who bears electricity cost for this device (affects analytics/payouts)
    electricityBearer: {
      type: String,
      enum: ["OWNER", "VJRA"],
      default: "OWNER"
    },

    // Optional overrides / snapshots (if you prefer per-device override of legacy fields)
    // If set, server logic should prefer commercial.userRatePerKwh else fallback to device.rate
    userRatePerKwh: { type: Number },

    // Optional explicit shares — if missing, backend can compute from existing fields:
    // vjraMarginPerKwh ~ commissionPerKwh (legacy) or explicit here
    vjraMarginPerKwh: { type: Number },

    // amount to be paid to owner per kWh (optional)
    ownerSharePerKwh: { type: Number },

    // allow device-specific pgPercent override (optional)
    pgPercent: { type: Number }
  }

}, { timestamps: true });

// Export (preserve model name)
module.exports = mongoose.models.Device || mongoose.model('Device', deviceSchema);
