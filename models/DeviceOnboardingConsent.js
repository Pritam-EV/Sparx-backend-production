const mongoose = require('mongoose');

const consentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deviceId: { type: String, required: true },

  acceptedTerms: { type: Boolean, required: true },

  aadhaarOrUdyam: String,
  panNumber: String,
  nameAsPerId: String,

  bankAccountNumber: String,
  ifscCode: String,
  accountHolderName: String,
  branch: String,

  deviceIp: String,
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('DeviceOnboardingConsent', consentSchema);
