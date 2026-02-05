const mongoose = require("mongoose");

const DeviceConsentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },

GSTModel: {
  type: String,
  enum: ["fullGST", "nonGST", "pureagent"],
  required: true
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

  userAgent: {
    type: String
  },

  browser: String,
  os: String,
  platform: String,

  // MAC ID (⚠️ explained below)
  deviceFingerprint: String,

  aadhaarOrUdyam: String,
  panNumber: String,
  nameAsPerKyc: String,

  bankAccountNumber: String,
  ifscCode: String,
  accountHolderName: String,
  branchName: String

}, {
  immutable: true,
  timestamps: false
});

module.exports = mongoose.model("DeviceConsent", DeviceConsentSchema);
