const mongoose = require("mongoose");

const productionTelemetrySchema = new mongoose.Schema(
  {
    serialNumber: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },

    deviceId: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },

    telemetryRequestId: {
      type: String,
      required: true,
      trim: true,
    },

    telemetrySequence: {
      type: Number,
      required: true,
      min: 0,
    },

    capturedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },

    telemetryMode: {
      type: String,
      default: "fast",
    },

    voltage: { type: Number, default: null },
    current: { type: Number, default: null },
    power: { type: Number, default: null },
    totalEnergyKwh: { type: Number, default: null },

    relayState: { type: String, default: null },
    relayCommanded: { type: Boolean, default: null },
    deviceState: { type: String, default: null },

    sessionId: { type: String, default: null },
    sessionActive: { type: Boolean, default: false },
    adminRelayTest: { type: Boolean, default: false },

    sampleAgeMs: { type: Number, default: null },
    sampleFresh: { type: Boolean, default: false },

    rawVoltageRatio: { type: Number, default: null },
    rawCurrentRatio: { type: Number, default: null },
    rawPowerRatio: { type: Number, default: null },

    calibrationMode: { type: String, default: null },
    vf: { type: Number, default: null },
    currentZero: { type: Number, default: null },
    currentGain: { type: Number, default: null },
    powerZero: { type: Number, default: null },
    powerGain: { type: Number, default: null },

    // Retain the exact fast message for diagnostics.
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    strict: "throw",
  }
);

productionTelemetrySchema.index(
  {
    serialNumber: 1,
    telemetryRequestId: 1,
    telemetrySequence: 1,
  },
  {
    unique: true,
    name: "uniq_production_fast_telemetry_sequence",
  }
);

productionTelemetrySchema.index({
  serialNumber: 1,
  capturedAt: -1,
});

productionTelemetrySchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 30 * 24 * 60 * 60,
    name: "production_telemetry_30_day_ttl",
  }
);

module.exports =
  mongoose.models.ProductionTelemetry ||
  mongoose.model("ProductionTelemetry", productionTelemetrySchema);