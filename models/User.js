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
    enum: ["customer","owner","admin"],
    default: "customer",
  },
  ownerProfile: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "OwnerProfile"
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
