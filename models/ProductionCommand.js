const mongoose = require("mongoose");

const productionCommandSchema = new mongoose.Schema(
  {
    requestId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    serialNumber: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    deviceId: {
      type: String,
      default: null,
      uppercase: true,
      trim: true,
      index: true,
    },

    action: {
      type: String,
      required: true,
      enum: [
        "setConfig",
        "setCalibration",
        "relayStart",
        "relayStop",
        "startFastTelemetry",
        "stopFastTelemetry",
      ],
    },

    kind: {
      type: String,
      required: true,
      enum: ["provisioning", "identity_change", "admin", "calibration"],
    },

    topic: {
      type: String,
      required: true,
    },

    // Only store a redacted payload. Never store Wi-Fi passwords.
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    status: {
      type: String,
      enum: [
        "queued",
        "published",
        "accepted",
        "rejected",
        "duplicate",
        "completed",
        "failed",
      ],
      default: "queued",
      index: true,
    },

    acknowledgement: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    publishedAt: {
      type: Date,
      default: null,
    },

    acknowledgedAt: {
      type: Date,
      default: null,
    },

    createdBy: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    strict: "throw",
  }
);

productionCommandSchema.index({
  serialNumber: 1,
  createdAt: -1,
});

productionCommandSchema.index({
  serialNumber: 1,
  action: 1,
  status: 1,
  createdAt: -1,
});

module.exports =
  mongoose.models.ProductionCommand ||
  mongoose.model("ProductionCommand", productionCommandSchema);