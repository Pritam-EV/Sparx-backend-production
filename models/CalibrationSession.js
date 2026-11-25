const mongoose = require("mongoose");

const calibrationSessionSchema = new mongoose.Schema(
  {
    sessionNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    device: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductionDevice",
      required: true,
      index: true,
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
    },

    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductionBatch",
      default: null,
      index: true,
    },

    calibrationProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CalibrationProfile",
      required: true,
    },
    verificationCaptures: {
    type: [mongoose.Schema.Types.Mixed],
    default: [],
    },
    // Store the exact profile version used for this session.
    profileSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },

    status: {
      type: String,
      enum: [
        "in_progress",
        "applying",
        "awaiting_verification",
        "passed",
        "failed",
        "cancelled",
      ],
      default: "in_progress",
      index: true,
    },

    stationName: {
      type: String,
      default: "",
      trim: true,
    },

    operatorId: {
      type: String,
      default: null,
      trim: true,
    },

    operatorName: {
      type: String,
      default: "",
      trim: true,
    },

    // Every capture is retained, including repeated attempts
    // for the same reference point.
    captures: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },

    appliedConstants: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    applyRequestId: {
      type: String,
      default: null,
      index: true,
    },

    applyCommandId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductionCommand",
      default: null,
    },

    appliedAt: {
      type: Date,
      default: null,
    },

    verification: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    lastError: {
      type: String,
      default: null,
    },

    notes: {
      type: String,
      default: "",
    },

    createdBy: {
      type: String,
      default: null,
    },

    updatedBy: {
      type: String,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    strict: "throw",
    minimize: false,
  }
);

calibrationSessionSchema.index({
  serialNumber: 1,
  createdAt: -1,
});

calibrationSessionSchema.index({
  batchId: 1,
  status: 1,
  createdAt: -1,
});

calibrationSessionSchema.index({
  serialNumber: 1,
  status: 1,
});

module.exports =
  mongoose.models.CalibrationSession ||
  mongoose.model("CalibrationSession", calibrationSessionSchema);