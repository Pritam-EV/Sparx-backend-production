
// models/ProductionDevice.js
//
// One document per physical charger throughout Production 3.0.
// Group A -> Group B -> Calibration -> Dispatch-ready.
//
// Live telemetry remains in memory.
// No production batch, calibration profile, command or session
// collections are created by this model.

const mongoose = require("mongoose");

// --------------------------------------------------
// ENUMS
// --------------------------------------------------

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
   MANUALLY_COMPLETED: "manually_completed",
  FAILED: "failed",
});

const TEST_STATUS = Object.freeze({
  NOT_TESTED: "not_tested",
  PASSED: "passed",
  FAILED: "failed",
});

const COMMAND_STATUS = Object.freeze({
  IDLE: "idle",
  PENDING: "pending",
  ACKNOWLEDGED: "acknowledged",
  FAILED: "failed",
});

// --------------------------------------------------
// CONNECTION STATUS
// --------------------------------------------------

const connectionStatusSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["unknown", "online", "offline"],
      default: "unknown",
    },

    lastSeen: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

// --------------------------------------------------
// COMMON CONFIG ACKNOWLEDGEMENT
// --------------------------------------------------

const configAckSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["ok", "error", "pending"],
      default: null,
    },

    action: {
      type: String,
      default: null,
    },

    requestId: {
      type: String,
      default: null,
    },

    message: {
      type: String,
      default: null,
    },

    fwVersion: {
      type: String,
      default: null,
    },

    nvsVersion: {
      type: Number,
      default: null,
    },

    receivedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

// --------------------------------------------------
// LATEST ADMIN COMMAND RESULT
//
// Only the latest command is retained.
// No separate command collection is needed.
// --------------------------------------------------

const commandStateSchema = new mongoose.Schema(
  {
    requestId: {
      type: String,
      default: null,
    },

    deviceId: {
      type: String,
      default: null,
    },

    action: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      enum: Object.values(COMMAND_STATUS),
      default: COMMAND_STATUS.IDLE,
    },

    sentAt: {
      type: Date,
      default: null,
    },

    acknowledgedAt: {
      type: Date,
      default: null,
    },

    message: {
      type: String,
      default: null,
    },
  },
  { _id: false }
);

// --------------------------------------------------
// CALIBRATION CAPTURE
//
// One no-load and one load capture are stored.
// --------------------------------------------------

const captureSchema = new mongoose.Schema(
  {
    capturedAt: {
      type: Date,
      default: null,
    },

    telemetryReceivedAt: {
      type: Date,
      default: null,
    },

    raw: {
      rawVoltageRatio: {
        type: Number,
        default: null,
      },

      rawCurrentRatio: {
        type: Number,
        default: null,
      },

      rawPowerRatio: {
        type: Number,
        default: null,
      },

      voltage: {
        type: Number,
        default: null,
      },

      current: {
        type: Number,
        default: null,
      },

      power: {
        type: Number,
        default: null,
      },

      relayOn: {
        type: Boolean,
        default: null,
      },
    },

    reference: {
      voltage: {
        type: Number,
        default: null,
      },

      current: {
        type: Number,
        default: null,
      },

      power: {
        type: Number,
        default: null,
      },
    },
  },
  { _id: false }
);

// --------------------------------------------------
// CALIBRATION COEFFICIENTS
// --------------------------------------------------

const calibrationCoefficientsSchema = new mongoose.Schema(
  {
    vf: {
      type: Number,
      default: null,
    },

    currentZero: {
      type: Number,
      default: null,
    },

    currentGain: {
      type: Number,
      default: null,
    },

    powerZero: {
      type: Number,
      default: null,
    },

    powerGain: {
      type: Number,
      default: null,
    },
  },
  { _id: false }
);

// --------------------------------------------------
// POST-CALIBRATION VERIFICATION CAPTURE
//
// Measurements come from MQTT.
// Reference values come from ER300P.
// --------------------------------------------------

const verificationCaptureSchema = new mongoose.Schema(
  {
    capturedAt: {
      type: Date,
      default: null,
    },

    telemetryReceivedAt: {
      type: Date,
      default: null,
    },

    measured: {
      voltage: {
        type: Number,
        default: null,
      },

      current: {
        type: Number,
        default: null,
      },

      power: {
        type: Number,
        default: null,
      },
    },

    reference: {
      voltage: {
        type: Number,
        default: null,
      },

      current: {
        type: Number,
        default: null,
      },

      power: {
        type: Number,
        default: null,
      },
    },

    errorPercent: {
      voltage: {
        type: Number,
        default: null,
      },

      current: {
        type: Number,
        default: null,
      },

      power: {
        type: Number,
        default: null,
      },
    },

    checks: {
      voltage: {
        type: Boolean,
        default: null,
      },

      current: {
        type: Boolean,
        default: null,
      },

      power: {
        type: Boolean,
        default: null,
      },
    },

    tolerancePercent: {
      type: Number,
      default: null,
    },

    noLoadMaxCurrentA: {
      type: Number,
      default: null,
    },

    noLoadMaxPowerW: {
      type: Number,
      default: null,
    },

    passed: {
      type: Boolean,
      default: null,
    },
  },
  { _id: false }
);

// --------------------------------------------------
// COMBINED VERIFICATION
// --------------------------------------------------

const calibrationVerificationSchema = new mongoose.Schema(
  {
    noLoad: {
      type: verificationCaptureSchema,
      default: null,
    },

    load: {
      type: verificationCaptureSchema,
      default: null,
    },

    passed: {
      type: Boolean,
      default: null,
    },

    verifiedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

// --------------------------------------------------
// CALIBRATION
// --------------------------------------------------

const calibrationSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: Object.values(CALIBRATION_STATUS),
      default: CALIBRATION_STATUS.NOT_STARTED,
    },

    // Initial calibration reference captures.
    noLoad: {
      type: captureSchema,
      default: null,
    },

    load: {
      type: captureSchema,
      default: null,
    },

    coefficients: {
      type: calibrationCoefficientsSchema,
      default: () => ({}),
    },

    calculatedAt: {
      type: Date,
      default: null,
    },

    calculationDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    submittedAt: {
      type: Date,
      default: null,
    },

    appliedAt: {
      type: Date,
      default: null,
    },

    requestId: {
      type: String,
      default: null,
    },

    acknowledgement: {
      type: configAckSchema,
      default: () => ({}),
    },

    lastError: {
      type: String,
      default: null,
    },

    // Independent ER300P verification after firmware ACK.
    verification: {
      type: calibrationVerificationSchema,
      default: () => ({}),
    },

    testStatus: {
      type: String,
      enum: Object.values(TEST_STATUS),
      default: TEST_STATUS.NOT_TESTED,
    },

    testedAt: {
      type: Date,
      default: null,
    },

    testedBy: {
      type: String,
      default: null,
    },

    testNotes: {
      type: String,
      default: "",
    },
        manualCompletion: {
      completedAt: {
        type: Date,
        default: null,
      },

      completedBy: {
        type: String,
        default: null,
      },

      reason: {
        type: String,
        default: "",
        maxlength: 1000,
      },
    },
  },
  { _id: false }
);

// --------------------------------------------------
// MAIN PRODUCTION DEVICE
// --------------------------------------------------

const productionDeviceSchema = new mongoose.Schema(
  {
    // ----------------------------------------------
    // HARDWARE IDENTITY
    // ----------------------------------------------

    serialNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },

    // ----------------------------------------------
    // PRODUCTION STAGE
    // ----------------------------------------------

    stage: {
      type: String,
      enum: Object.values(PRODUCTION_STAGE),
      default: PRODUCTION_STAGE.GROUP_A,
      required: true,
      index: true,
    },

    // ----------------------------------------------
    // GROUP A
    // ----------------------------------------------

    groupA: {
      serialPrefix: {
        type: String,
        required: true,
        trim: true,
      },

      startingNumber: {
        type: String,
        required: true,
        trim: true,
      },

      sequenceNumber: {
        type: Number,
        required: true,
        min: 0,
      },

      entryQuantity: {
        type: Number,
        required: true,
        min: 1,
      },

      number: {
        type: String,
        default: null,
        trim: true,
      },

      par: {
        type: String,
        default: null,
        trim: true,
      },

      pcbBatch: {
        type: String,
        required: true,
        trim: true,
      },

      meteringHardware: {
        type: String,
        required: true,
        trim: true,
      },

      batchName: {
        type: String,
        required: true,
        trim: true,
      },
      connection: {
        type: connectionStatusSchema,
        default: () => ({}),
        },

        lastKnownFirmwareVersion: {
        type: String,
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
    },

    // ----------------------------------------------
    // GROUP B
    // ----------------------------------------------

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

      provisionSentAt: {
        type: Date,
        default: null,
      },

      nvsVersion: {
        type: Number,
        default: 0,
        min: 0,
      },

      lastKnownFirmwareVersion: {
        type: String,
        default: null,
      },

      provisionedBy: {
        type: String,
        default: null,
      },

      configAck: {
        type: configAckSchema,
        default: () => ({}),
      },

      connection: {
        type: connectionStatusSchema,
        default: () => ({}),
      },

      // Latest relay/telemetry command and its ACK result.
      lastCommand: {
        type: commandStateSchema,
        default: () => ({}),
      },

      lastError: {
        type: String,
        default: null,
      },
    },

    // ----------------------------------------------
    // CALIBRATION
    // ----------------------------------------------

    calibration: {
      type: calibrationSchema,
      default: () => ({}),
    },

    // ----------------------------------------------
    // DISPATCH
    // ----------------------------------------------

    dispatch: {
      status: {
        type: String,
        enum: ["not_ready", "ready", "completed"],
        default: "not_ready",
      },

      dispatchedAt: {
        type: Date,
        default: null,
      },

      dispatchedBy: {
        type: String,
        default: null,
      },

      notes: {
        type: String,
        default: "",
      },
    },

    // ----------------------------------------------
    // AUDIT
    // ----------------------------------------------

    createdBy: {
      type: String,
      default: null,
    },

    updatedBy: {
      type: String,
      default: null,
    },

    stageUpdatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    collection: "productiondevices",
    minimize: false,
  }
);

// --------------------------------------------------
// INDEXES
// --------------------------------------------------

// One serial number and one assigned Device ID per production record.
productionDeviceSchema.index(
  { "groupB.deviceId": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "groupB.deviceId": { $type: "string" },
    },
  }
);

productionDeviceSchema.index({
  stage: 1,
  updatedAt: -1,
});

productionDeviceSchema.index({
  "groupB.connection.lastSeen": -1,
});

productionDeviceSchema.index({
  "groupA.batchName": 1,
});

productionDeviceSchema.index({
  "groupA.pcbBatch": 1,
});

// --------------------------------------------------
// STATIC ENUMS
// --------------------------------------------------

productionDeviceSchema.statics.STAGE = PRODUCTION_STAGE;

productionDeviceSchema.statics.PROVISION_STATUS =
  PROVISION_STATUS;

productionDeviceSchema.statics.CALIBRATION_STATUS =
  CALIBRATION_STATUS;

productionDeviceSchema.statics.TEST_STATUS =
  TEST_STATUS;

productionDeviceSchema.statics.COMMAND_STATUS =
  COMMAND_STATUS;

// --------------------------------------------------
// EXPORT
// --------------------------------------------------

module.exports =
  mongoose.models.ProductionDevice ||
  mongoose.model(
    "ProductionDevice",
    productionDeviceSchema
  );
