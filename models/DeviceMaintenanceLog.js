
const mongoose = require("mongoose");

const maintenanceLogSchema = new mongoose.Schema(
  {
    requestId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    serialNumber: {
      type: String,
      required: true,
      index: true,
    },

    deviceId: {
      type: String,
      required: true,
      index: true,
    },
category: {
  type: String,
  required: true,
  enum: [
    "database",
    "firmware",
    "command",
    "migration",
    "deviceIdMigration",
  ],
},

    operation: {
      type: String,
      required: true,
    },

    firmwareProfile: {
      type: String,
      enum: ["legacy", "v3", null],
      default: null,
    },

    changes: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    status: {
      type: String,
      enum: [
        "pending",
        "published",
        "acknowledged",
        "completed",
        "failed",
        "rejected",
        "timed_out",
      ],
      default: "pending",
      index: true,
    },

    mqttTopic: {
      type: String,
      default: null,
    },

    acknowledgement: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    errorMessage: {
      type: String,
      default: null,
    },

    performedBy: {
      type: String,
      required: true,
    },

    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

maintenanceLogSchema.index({
  serialNumber: 1,
  createdAt: -1,
});

module.exports =
  mongoose.models.DeviceMaintenanceLog ||
  mongoose.model(
    "DeviceMaintenanceLog",
    maintenanceLogSchema
  );
