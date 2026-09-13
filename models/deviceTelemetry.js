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
// TTL cleanup: delete telemetry after 24 hours.
deviceTelemetrySchema.index(
  {
    timestamp: 1,
  },
  {
    expireAfterSeconds: 60 * 60 * 24,
  }
);

// Latest telemetry lookup by device.
deviceTelemetrySchema.index({
  deviceId: 1,
  timestamp: -1,
});
// IMPORTANT: force mongoose to sync indexes
deviceTelemetrySchema.set("autoIndex", true);

module.exports = mongoose.model(
  "DeviceTelemetry",
  deviceTelemetrySchema
);