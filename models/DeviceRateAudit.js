// models/DeviceRateAudit.js
const mongoose = require("mongoose");

const deviceRateAuditSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    changedByRole: {
      type: String,
      enum: ["owner", "admin"],
      required: true,
    },

    deviceId: {
      type: String,
      required: true,
      index: true,
    },

    previousRateInclGst: {
      type: Number,
      required: true,
    },

    newRateInclGst: {
      type: Number,
      required: true,
    },

    previousUserRatePerKwh: {
      type: Number,
      default: null,
    },

    newUserRatePerKwh: {
      type: Number,
      required: true,
    },

    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },

    changedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

deviceRateAuditSchema.index({
  ownerId: 1,
  deviceId: 1,
  changedAt: -1,
});

module.exports =
  mongoose.models.DeviceRateAudit ||
  mongoose.model("DeviceRateAudit", deviceRateAuditSchema);