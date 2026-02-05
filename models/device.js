const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({

  device_id: { type: String, required: true },

  // NEW: Serial Number for device identification
  serialNumber: { type: String, required: false, trim: true },
  GSTModel: {
    type: String,
    enum: ["fullGST", "nonGST", "pureagent"], // future-proof
    required: true,
    default: "fullGST"
  },

  // If ownerId is actually an array in DB, keep it as [ObjectId]
  ownerId: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],

  // NEW: GST Number for partner onboarding
  gstNumber: { type: String, required: false, trim: true },
  hasGST: { type: Boolean, default: false },

  // NEW: Meter details for partner onboarding
  meterType: { 
    type: String, 
    enum: ['Green Meter', 'Commercial', 'Residential'], 
    required: false 
  },
  meterConsumerNumber: { type: String, required: false, trim: true },

  location: { type: String, required: true },

  lat: { type: Number, required: true },
  lng: { type: Number, required: true },

  status: { type: String, required: true },

  charger_type: { type: String, required: true },

  current_session_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Session', 
    default: null 
  },

  rate: { type: Number, required: true, default: 20 },

  area: { type: String, required: true },
  city: { type: String, required: true },
  state: { type: String, required: true },

  totalenergy: { type: Number, required: false, default: 0 },

  relayOn: { type: Boolean, default: false },

  lastSeen: { type: Date, default: Date.now },

  commissionPerKwh: {
  type: Number,
  required: true,
  default: 2.36 // safe fallback
},

  PGPercent: { type: Number, default: 2 },

  // NEW: Partner onboarding status
  onboardingStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  onboardedAt: { type: Date },
  onboardedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

const Device = mongoose.models.Device || mongoose.model('Device', deviceSchema);

module.exports = Device;
