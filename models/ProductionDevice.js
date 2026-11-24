
/**
 * ProductionDevice.js
 *
 * VIZ Production 3.0 — isolated device registry.
 *
 * IMPORTANT:
 * - This is a NEW model. It does not replace or modify DeviceProvision or Device.
 * - Factory serialNumber is the permanent identity.
 * - deviceId is an operational identifier and defaults to the serial number
 *   when the provisioning service assigns it.
 * - Do not store plaintext Wi-Fi passwords in this document.
 */

const mongoose = require("mongoose");

const PRODUCTION_DEVICE_STATUS = Object.freeze({
  GROUP_A: "group_a",
  DISCOVERED: "discovered",
  GROUP_B: "group_b",
  CALIBRATION_REQUIRED: "calibration_required",
  CALIBRATING: "calibrating",
  CALIBRATION_FAILED: "calibration_failed",
  PRODUCTION_READY: "production_ready",
  DISPATCHED: "dispatched",
  RETIRED: "retired",
});

const PROVISIONING_STATUS = Object.freeze({
  NOT_STARTED: "not_started",
  PENDING: "pending",
  SENT: "sent",
  ACKNOWLEDGED: "acknowledged",
  FAILED: "failed",
});

const discoverySchema = new mongoose.Schema(
  {
    firstSeenAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    lastBootAt: { type: Date, default: null },
    isOnline: { type: Boolean, default: false },
    reportedSerialNumber: { type: String, default: null, trim: true },
    reportedDeviceId: { type: String, default: null, trim: true },
    firmwareFamily: { type: String, default: null, trim: true },
    firmwareVersion: { type: String, default: null, trim: true },
    protocolVersion: { type: String, default: null, trim: true },
    hardwareRevision: { type: String, default: null, trim: true },
    capabilities: { type: [String], default: [] },
    lastIpAddress: { type: String, default: null, trim: true },
    lastMessageId: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const provisioningSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: Object.values(PROVISIONING_STATUS),
      default: PROVISIONING_STATUS.NOT_STARTED,
    },
    desiredConfigVersion: { type: Number, default: 0, min: 0 },
    appliedConfigVersion: { type: Number, default: 0, min: 0 },
    lastRequestId: { type: String, default: null, trim: true },
    lastSentAt: { type: Date, default: null },
    acknowledgedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    targetFirmwareVersion: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const calibrationSummarySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: [
        "not_required",
        "calibration_required",
        "calibrating",
        "passed",
        "failed",
      ],
      default: "calibration_required",
    },
    latestSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CalibrationSession",
      default: null,
    },
    lastPassedAt: { type: Date, default: null },
    lastFailedAt: { type: Date, default: null },
    lastFailureReason: { type: String, default: null },
  },
  { _id: false }
);

const identityHistorySchema = new mongoose.Schema(
  {
    oldDeviceId: { type: String, default: null, trim: true },
    newDeviceId: { type: String, required: true, trim: true },
    requestId: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["requested", "acknowledged", "rejected", "failed"],
      default: "requested",
    },
    requestedBy: { type: String, required: true, trim: true },
    requestedAt: { type: Date, default: Date.now },
    acknowledgedAt: { type: Date, default: null },
    deviceMessage: { type: String, default: null },
  },
  { _id: true }
);

const productionDeviceSchema = new mongoose.Schema(
  {
    // Immutable factory identity. This is the discovery/MQTT identity.
    serialNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      immutable: true,
    },

    // Operational ID. Leave undefined until provisioning if not assigned.
    // The provisioning service should initially set this equal to serialNumber.
    deviceId: {
      type: String,
      trim: true,
      uppercase: true,
      default: undefined,
    },

    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductionBatch",
      default: null,
      index: true,
    },

    productionProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductionProfile",
      default: null,
    },

    firmwareProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FirmwareProfile",
      default: null,
    },

    calibrationProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CalibrationProfile",
      default: null,
    },

    manufacturingStatus: {
      type: String,
      enum: Object.values(PRODUCTION_DEVICE_STATUS),
      default: PRODUCTION_DEVICE_STATUS.GROUP_A,
      index: true,
    },

    firmwareFamily: { type: String, default: null, trim: true },
    protocolVersion: { type: String, default: null, trim: true },
    firmwareVersion: { type: String, default: null, trim: true },

    discovery: {
      type: discoverySchema,
      default: () => ({}),
    },

    provisioning: {
      type: provisioningSchema,
      default: () => ({}),
    },

    calibration: {
      type: calibrationSummarySchema,
      default: () => ({}),
    },

    // Store only encrypted credentials or a secure secret reference.
    // Never expose this subdocument in normal API responses.
    wifiCredentials: {
      encryptedSsid: { type: String, default: null, select: false },
      encryptedPassword: { type: String, default: null, select: false },
      secretReference: { type: String, default: null, select: false },
      updatedAt: { type: Date, default: null, select: false },
    },

    identityHistory: {
      type: [identityHistorySchema],
      default: [],
      select: false,
    },

    notes: { type: String, default: "" },
    createdBy: { type: String, default: null, trim: true },
    updatedBy: { type: String, default: null, trim: true },
  },
  {
    timestamps: true,
    strict: "throw",
    minimize: false,
  }
);

// Unique factory identity.
productionDeviceSchema.index(
  { serialNumber: 1 },
  { unique: true, name: "uniq_production_serial" }
);

// Unique operational ID only when assigned.
productionDeviceSchema.index(
  { deviceId: 1 },
  {
    unique: true,
    sparse: true,
    name: "uniq_production_device_id",
  }
);

productionDeviceSchema.index(
  { manufacturingStatus: 1, "discovery.lastSeenAt": -1 },
  { name: "production_status_last_seen" }
);

productionDeviceSchema.index(
  { batchId: 1, manufacturingStatus: 1 },
  { name: "production_batch_status" }
);

productionDeviceSchema.index(
  { "provisioning.status": 1, manufacturingStatus: 1 },
  { name: "production_provisioning_queue" }
);

productionDeviceSchema.index(
  { "calibration.status": 1, manufacturingStatus: 1 },
  { name: "production_calibration_queue" }
);

productionDeviceSchema.statics.STATUS = PRODUCTION_DEVICE_STATUS;
productionDeviceSchema.statics.PROVISIONING_STATUS = PROVISIONING_STATUS;

module.exports =
  mongoose.models.ProductionDevice ||
  mongoose.model("ProductionDevice", productionDeviceSchema);
