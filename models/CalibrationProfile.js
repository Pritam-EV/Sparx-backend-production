
/**
 * CalibrationProfile.js
 *
 * VIZ Production 3.0
 *
 * Defines versioned calibration procedures for supported
 * metering hardware.
 *
 * Firmware calibration fields confirmed from VIZ_v3.0.0:
 *   vf
 *   currentZero
 *   currentGain
 *   powerZero
 *   powerGain
 *
 * IMPORTANT:
 * - Do not confuse these fields with legacy CF/VF calibration.
 * - Calibration equations and units must be confirmed before
 *   activating a profile.
 * - Backend validation must enforce the configured limits.
 * - Never send calibration values directly from an unvalidated
 *   API request to the device.
 */

const mongoose = require("mongoose");

const CALIBRATION_PROFILE_STATUS = Object.freeze({
  DRAFT: "draft",
  ACTIVE: "active",
  DEPRECATED: "deprecated",
  ARCHIVED: "archived",
});

const CALIBRATION_CHANNELS = Object.freeze([
  "voltage",
  "current",
  "power",
]);

const calibrationValueSchema = new mongoose.Schema(
  {
    // Exact key expected by the firmware calibration handler.
    firmwareKey: {
      type: String,
      required: true,
      trim: true,
    },

    displayName: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: "",
    },

    // Keep units explicit. Do not assume units without
    // confirming the firmware's raw measurement representation.
    unit: {
      type: String,
      default: null,
      trim: true,
    },

    defaultValue: {
      type: Number,
      default: null,
    },

    minimumValue: {
      type: Number,
      default: null,
    },

    maximumValue: {
      type: Number,
      default: null,
    },

    decimalPlaces: {
      type: Number,
      default: 6,
      min: 0,
      max: 12,
    },

    required: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

const sampleSettingsSchema = new mongoose.Schema(
  {
    // Number of readings used for each capture.
    sampleCount: {
      type: Number,
      default: 10,
      min: 1,
    },

    // Maximum permitted variation between samples.
    // Units and interpretation must be defined by the
    // calibration algorithm.
    stabilityTolerance: {
      type: Number,
      default: null,
      min: 0,
    },

    stableSampleCount: {
      type: Number,
      default: 5,
      min: 1,
    },

    captureTimeoutSeconds: {
      type: Number,
      default: 30,
      min: 1,
    },
  },
  { _id: false }
);

const referencePointSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: "",
    },

    // Example: no_load, low_load, rated_load.
    condition: {
      type: String,
      required: true,
      trim: true,
    },

    required: {
      type: Boolean,
      default: true,
    },

    // Reference instrument readings.
    requiredChannels: {
      type: [String],
      enum: CALIBRATION_CHANNELS,
      default: [],
    },

    // Expected reference value units are explicit.
    voltageUnit: {
      type: String,
      default: "V",
    },

    currentUnit: {
      type: String,
      default: "A",
    },

    powerUnit: {
      type: String,
      default: "W",
    },
  },
  { _id: false }
);

const acceptanceCriteriaSchema = new mongoose.Schema(
  {
    voltageTolerancePercent: {
      type: Number,
      default: null,
      min: 0,
    },

    currentTolerancePercent: {
      type: Number,
      default: null,
      min: 0,
    },

    powerTolerancePercent: {
      type: Number,
      default: null,
      min: 0,
    },

    requireVoltageVerification: {
      type: Boolean,
      default: true,
    },

    requireCurrentVerification: {
      type: Boolean,
      default: true,
    },

    requirePowerVerification: {
      type: Boolean,
      default: true,
    },

    // Additional profile-specific verification conditions.
    additionalCriteria: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { _id: false }
);

const calibrationProfileSchema = new mongoose.Schema(
  {
    profileName: {
      type: String,
      required: true,
      trim: true,
    },

    profileCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },

    profileVersion: {
      type: Number,
      required: true,
      min: 1,
    },

    description: {
      type: String,
      default: "",
    },

    status: {
      type: String,
      enum: Object.values(CALIBRATION_PROFILE_STATUS),
      default: CALIBRATION_PROFILE_STATUS.DRAFT,
      index: true,
    },

    // Hardware compatibility.
    meteringHardware: {
      type: String,
      required: true,
      trim: true,
    },

    meteringHardwareRevision: {
      type: String,
      default: null,
      trim: true,
    },

    supportedHardwareRevisions: {
      type: [String],
      default: [],
    },

    firmwareFamily: {
      type: String,
      default: null,
      trim: true,
    },

    minimumFirmwareVersion: {
      type: String,
      default: null,
      trim: true,
    },

    maximumFirmwareVersion: {
      type: String,
      default: null,
      trim: true,
    },

    // Calibration algorithm information.
    algorithm: {
      name: {
        type: String,
        required: true,
        trim: true,
      },

      version: {
        type: String,
        required: true,
        trim: true,
      },

      description: {
        type: String,
        default: "",
      },

      // Equations or calculation metadata.
      // The calibration service must implement and validate
      // the algorithm; storing text does not execute it.
      calculationConfig: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
    },

    // Calibration constants expected by firmware.
    calibrationValues: {
      type: [calibrationValueSchema],
      required: true,
      validate: {
        validator: function (values) {
          const keys = values.map((item) => item.firmwareKey);
          return keys.length === new Set(keys).size;
        },
        message: "Calibration firmwareKey values must be unique",
      },
    },

    // Reference measurement requirements.
    referencePoints: {
      type: [referencePointSchema],
      default: [],
    },

    // No-load capture.
    noLoadSampling: {
      type: sampleSettingsSchema,
      default: () => ({}),
    },

    // Loaded capture.
    loadSampling: {
      type: sampleSettingsSchema,
      default: () => ({}),
    },

    // Final verification requirements.
    acceptanceCriteria: {
      type: acceptanceCriteriaSchema,
      default: () => ({}),
    },

    // Safety and operator instructions.
    safetyInstructions: {
      type: [String],
      default: [],
    },

    operatorInstructions: {
      type: [String],
      default: [],
    },

    // Profile lifecycle metadata.
    releasedAt: {
      type: Date,
      default: null,
    },

    createdBy: {
      type: String,
      default: null,
      trim: true,
    },

    updatedBy: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true,
    strict: "throw",
    minimize: false,
  }
);

// A profile revision must be unique.
calibrationProfileSchema.index(
  { profileCode: 1, profileVersion: 1 },
  {
    unique: true,
    name: "uniq_calibration_profile_version",
  }
);

// Find compatible profiles.
calibrationProfileSchema.index(
  { meteringHardware: 1, status: 1 },
  {
    name: "calibration_hardware_status",
  }
);

calibrationProfileSchema.index(
  { firmwareFamily: 1, status: 1 },
  {
    name: "calibration_firmware_status",
  }
);

// Validate calibration ranges and profile configuration.
calibrationProfileSchema.pre("validate", function (next) {
  for (const item of this.calibrationValues || []) {
    if (
      item.minimumValue !== null &&
      item.maximumValue !== null &&
      item.minimumValue > item.maximumValue
    ) {
      return next(
        new Error(
          `Minimum value cannot exceed maximum value for ${item.firmwareKey}`
        )
      );
    }

    if (
      item.defaultValue !== null &&
      item.minimumValue !== null &&
      item.defaultValue < item.minimumValue
    ) {
      return next(
        new Error(
          `Default value is below minimum for ${item.firmwareKey}`
        )
      );
    }

    if (
      item.defaultValue !== null &&
      item.maximumValue !== null &&
      item.defaultValue > item.maximumValue
    ) {
      return next(
        new Error(
          `Default value exceeds maximum for ${item.firmwareKey}`
        )
      );
    }
  }

  if (
    this.noLoadSampling &&
    this.noLoadSampling.stableSampleCount >
      this.noLoadSampling.sampleCount
  ) {
    return next(
      new Error(
        "No-load stableSampleCount cannot exceed sampleCount"
      )
    );
  }

  if (
    this.loadSampling &&
    this.loadSampling.stableSampleCount >
      this.loadSampling.sampleCount
  ) {
    return next(
      new Error(
        "Load stableSampleCount cannot exceed sampleCount"
      )
    );
  }

  next();
});

calibrationProfileSchema.statics.STATUS =
  CALIBRATION_PROFILE_STATUS;

calibrationProfileSchema.statics.CHANNELS =
  CALIBRATION_CHANNELS;

module.exports =
  mongoose.models.CalibrationProfile ||
  mongoose.model("CalibrationProfile", calibrationProfileSchema);
