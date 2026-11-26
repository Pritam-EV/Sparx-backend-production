// models/ProductionDevice.js
// One document per physical charger from Group A through Calibration.
// The document is moved to the legacy DeviceProvision collection only after
// the Dispatch workflow is completed.

const mongoose = require("mongoose");

const PRODUCTION_STAGE = Object.freeze({
  GROUP_A: "group_a",
  GROUP_B: "group_b",
  CALIBRATION: "calibration",
  DISPATCH: "dispatch",
});

const PROVISION_STATUS = Object.freeze({
  NOT_SENT: "not_sent",
  SENT: "sent",
  ACKNOWLEDGED: "acknowledged",
  FAILED: "failed",
});

const CALIBRATION_STATUS = Object.freeze({
  NOT_STARTED: "not_started",
  CAPTURING: "capturing",
  CALCULATED: "calculated",
  SUBMITTED: "submitted",
  APPLIED: "applied",
  FAILED: "failed",
});

const TEST_STATUS = Object.freeze({
  NOT_TESTED: "not_tested",
  PASSED: "passed",
  FAILED: "failed",
});

const connectionStatusSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["unknown", "online", "offline"],
      default: "unknown",
    },
    lastSeen: { type: Date, default: null },
  },
  { _id: false }
);

const configAckSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["ok", "error", "pending"],
      default: null,
    },
    action: { type: String, default: null },
    requestId: { type: String, default: null },
    message: { type: String, default: null },
    fwVersion: { type: String, default: null },
    nvsVersion: { type: Number, default: null },
    receivedAt: { type: Date, default: null },
  },
  { _id: false }
);

// A single capture is stored for each condition. Live telemetry itself is
// kept in memory by the MQTT service and is never written as a time series.
const captureSchema = new mongoose.Schema(
  {
    capturedAt: { type: Date, default: null },
    telemetryReceivedAt: { type: Date, default: null },
    raw: {
      rawVoltageRatio: { type: Number, default: null },
      rawCurrentRatio: { type: Number, default: null },
      rawPowerRatio: { type: Number, default: null },
      voltage: { type: Number, default: null },
      current: { type: Number, default: null },
      power: { type: Number, default: null },
      relayOn: { type: Boolean, default: null },
    },
    reference: {
      voltage: { type: Number, default: null },
      current: { type: Number, default: null },
      power: { type: Number, default: null },
    },
  },
  { _id: false }
);

const calibrationCoefficientsSchema = new mongoose.Schema(
  {
    vf: { type: Number, default: null },
    currentZero: { type: Number, default: null },
    currentGain: { type: Number, default: null },
    powerZero: { type: Number, default: null },
    powerGain: { type: Number, default: null },
  },
  { _id: false }
);

const calibrationSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: Object.values(CALIBRATION_STATUS),
      default: CALIBRATION_STATUS.NOT_STARTED,
    },
    noLoad: { type: captureSchema, default: null },
    load: { type: captureSchema, default: null },
    coefficients: {
      type: calibrationCoefficientsSchema,
      default: () => ({}),
    },
    calculatedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    appliedAt: { type: Date, default: null },
    requestId: { type: String, default: null },
    acknowledgement: { type: configAckSchema, default: () => ({}) },
    lastError: { type: String, default: null },
    testStatus: {
      type: String,
      enum: Object.values(TEST_STATUS),
      default: TEST_STATUS.NOT_TESTED,
    },
    testedAt: { type: Date, default: null },
    testedBy: { type: String, default: null },
    testNotes: { type: String, default: "" },
  },
  { _id: false }
);

const productionDeviceSchema = new mongoose.Schema(
  {
    // Immutable hardware identity.
    serialNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },

    // The only primary manufacturing stages.
    stage: {
      type: String,
      enum: Object.values(PRODUCTION_STAGE),
      default: PRODUCTION_STAGE.GROUP_A,
      required: true,
      index: true,
    },

    // Group A information is copied into every device document. There is no
    // separate batch collection/document in this workflow.
    groupA: {
      serialPrefix: { type: String, required: true, trim: true },
      startingNumber: { type: String, required: true, trim: true },
      sequenceNumber: { type: Number, required: true, min: 0 },
      entryQuantity: { type: Number, required: true, min: 1 },
      // Retained separately because the production form has a distinct
      // "Number" input in addition to the serial quantity/start number.
      number: { type: String, default: null, trim: true },
      par: { type: String, default: null, trim: true },
      pcbBatch: { type: String, required: true, trim: true },
      meteringHardware: { type: String, required: true, trim: true },
      batchName: { type: String, required: true, trim: true },
      createdBy: { type: String, default: null },
      createdAt: { type: Date, default: Date.now },
    },

    // Group B provisioning. Credentials are encrypted by the controller/
    // service before save; they are excluded from normal query projections.
    groupB: {
      deviceId: {
        type: String,
        default: null,
        trim: true,
        uppercase: true,
      },
      wifiSSIDEncrypted: {
        type: String,
        default: null,
        select: false,
      },
      wifiPasswordEncrypted: {
        type: String,
        default: null,
        select: false,
      },
      provisionStatus: {
        type: String,
        enum: Object.values(PROVISION_STATUS),
        default: PROVISION_STATUS.NOT_SENT,
      },
      provisionSentAt: { type: Date, default: null },
      provisionedBy: { type: String, default: null },
      configAck: { type: configAckSchema, default: () => ({}) },
      connection: {
        type: connectionStatusSchema,
        default: () => ({}),
      },
      lastError: { type: String, default: null },
    },

    // Two-point calibration only: one no-load capture and one load capture.
    // No CalibrationSession or CalibrationProfile documents are used.
    calibration: {
      type: calibrationSchema,
      default: () => ({}),
    },

    // Dispatch workflow will be implemented after the first three stages.
    dispatch: {
      status: {
        type: String,
        enum: ["not_ready", "ready", "completed"],
        default: "not_ready",
      },
      dispatchedAt: { type: Date, default: null },
      dispatchedBy: { type: String, default: null },
      notes: { type: String, default: "" },
    },

    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
    stageUpdatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    collection: "productiondevices",
    minimize: false,
  }
);

// One serial number and one assigned Device ID must identify exactly one
// pre-dispatch production record.
productionDeviceSchema.index(
  { "groupB.deviceId": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "groupB.deviceId": { $type: "string" },
    },
  }
);

productionDeviceSchema.index({ stage: 1, updatedAt: -1 });
productionDeviceSchema.index({ "groupB.connection.lastSeen": -1 });
productionDeviceSchema.index({ "groupA.batchName": 1 });
productionDeviceSchema.index({ "groupA.pcbBatch": 1 });

productionDeviceSchema.statics.STAGE = PRODUCTION_STAGE;
productionDeviceSchema.statics.PROVISION_STATUS = PROVISION_STATUS;
productionDeviceSchema.statics.CALIBRATION_STATUS = CALIBRATION_STATUS;
productionDeviceSchema.statics.TEST_STATUS = TEST_STATUS;

module.exports =
  mongoose.models.ProductionDevice ||
  mongoose.model("ProductionDevice", productionDeviceSchema);
