// backend/models/deviceTelemetry.js

const mongoose = require("mongoose");

const deviceTelemetrySchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    index: true,
  },

  voltage: Number,
  current: Number,
  power: Number,

  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

// 🔥 TTL Index: auto delete after 24 hours
deviceTelemetrySchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 60 * 60 * 24 } // 24 hours
);

module.exports = mongoose.model("DeviceTelemetry", deviceTelemetrySchema);
