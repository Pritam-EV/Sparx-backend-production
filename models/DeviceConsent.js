// models/DeviceConsent.js
const mongoose = require("mongoose");

const DeviceConsentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },

  // keep GSTModel for backward compatibility; default locked to 'fullGST' recommended.
  GSTModel: {
    type: String,
    enum: ["fullGST", "nonGST", "pureagent"],
    required: true,
    default: "fullGST"
  },

  deviceId: {
    type: String,
    required: true
  },

  termsVersion: {
    type: String,
    required: true
  },

  termsHash: {
    type: String,
    required: true
  },

  accepted: {
    type: Boolean,
    required: true
  },

  acceptedAt: {
    type: Date,
    required: true
  },

  clientIp: {
    type: String,
    required: true
  },

  userAgent: { type: String },
  browser: String,
  os: String,
  platform: String,

  // deviceFingerprint kept but non-identifying (base64 hash of UA+platform)
  deviceFingerprint: String,

  // --- removed/avoided storing highly sensitive PII permanently ---
  // note: original file contained aadhaarOrUdyam, panNumber, nameAsPerKyc, bank details.
  // To reduce risk we keep only minimal KYC references and DO NOT store Aadhaar in plain fields.
  // If you must collect PAN/UDYAM, store them in a secure vault or tokenize them.
  panNumber: { type: String }, // optional, consider tokenization
  nameAsPerKyc: { type: String },
gstNumber: String,

  // minimal bank info for payout verification — keep to what you already had but prefer encryption at rest
  bankAccountNumber: { type: String },
  ifscCode: { type: String },
  accountHolderName: { type: String },
  branchName: { type: String },

  // NEW: financial acceptance snapshot (explicit)
  financialAcceptance: {
    acceptedModel: { type: String, enum: ["fullGST"], default: "fullGST" },
    electricityPayer: { type: String, enum: ["OWNER", "VJRA"], default: "OWNER" }, // snapshot at onboarding
    acceptedAt: { type: Date, default: Date.now }
  }

}, {
  immutable: true, // consent snapshots should be immutable
  timestamps: true
});

module.exports = mongoose.models.DeviceConsent || mongoose.model("DeviceConsent", DeviceConsentSchema);
