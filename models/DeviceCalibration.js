const mongoose = require("mongoose");

const deviceCalibrationSchema = new mongoose.Schema(
  {
    requestId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    deviceId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    serialNumber: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    oldCf: {
      type: Number,
      required: true,
    },

    oldVf: {
      type: Number,
      required: true,
    },

    liveVoltage: {
      type: Number,
      required: true,
    },

    liveCurrent: {
      type: Number,
      required: true,
    },

    referenceVoltage: {
      type: Number,
      required: true,
    },

    referenceCurrent: {
      type: Number,
      required: true,
    },

    newCf: {
      type: Number,
      required: true,
    },

    newVf: {
      type: Number,
      required: true,
    },

    expectedNvsVersion: {
      type: Number,
      required: true,
    },

    status: {
      type: String,
      enum: [
        "pending",
        "published",
        "acknowledged",
        "rejected",
        "publish_failed",
        "acknowledgement_timeout",
      ],
      default: "pending",
      index: true,
    },

    acknowledgement: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    createdBy: {
      type: String,
      default: null,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },

    publishedAt: {
      type: Date,
      default: null,
    },

    acknowledgedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

deviceCalibrationSchema.index({
  deviceId: 1,
  createdAt: -1,
});

module.exports = mongoose.model(
  "DeviceCalibration",
  deviceCalibrationSchema
);