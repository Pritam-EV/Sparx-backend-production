// models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    trim: true,
    required: true
  },
  vehicleNumber: { type: String, trim: true, index: true, sparse: true },
  email: { type: String, trim: true, lowercase: true, index: true, sparse: true },
  mobile: {
    type: String,
    unique: true,
    required: true,
  },
  vehicleType: String,
  role: {
    type: String,
    enum: ["customer", "owner", "admin", "accountant"],
    default: "customer",
  },
  ownerProfile: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "OwnerProfile"
},

// Wallet fields — RBI PPI compliant
walletBalance: {
  type: Number,
  default: 0,
  min: 0,      // enforce non-negative at DB level
},
walletKycLevel: {
  type: String,
  enum: ["none", "min_kyc", "full_kyc"],
  default: "min_kyc",  // mobile-verified users = min_kyc
},
walletMonthlyLoaded: {
  type: Number,
  default: 0,   // reset monthly via cron
},
walletLastResetMonth: {
  type: String,  // "2026-05" format, for monthly reset logic
  default: null,
},
walletFrozen: {
  type: Boolean,
  default: false,  // admin can freeze on suspicious activity
},

  phoneVerified: {
    type: Boolean,
    default: false,
  },
  phoneVerificationCode: String,     // store temporary OTP
  phoneVerificationExpires: Date,    // expiry time for OTP
  // Remove googleId field if unused
}, { timestamps: true }

);

module.exports = mongoose.model("User", userSchema);
