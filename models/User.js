// models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: String,
  email: String,
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
  phoneVerified: {
    type: Boolean,
    default: false,
  },
  phoneVerificationCode: String,     // store temporary OTP
  phoneVerificationExpires: Date,    // expiry time for OTP
  // Remove googleId field if unused
});

module.exports = mongoose.model("User", userSchema);
