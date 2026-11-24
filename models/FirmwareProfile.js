
/**
 * FirmwareProfile.js
 *
 * VIZ Production 3.0
 *
 * Stores versioned firmware configuration profiles.
 *
 * Responsibilities:
 * - Identify firmware family and protocol version.
 * - Define target firmware version.
 * - Store default device configuration.
 * - Define telemetry settings.
 * - Define supported firmware capabilities.
 * - Define hardware compatibility.
 *
 * Wi-Fi credentials and calibration constants are not stored here.
 */

const mongoose = require("mongoose");

const FIRMWARE_PROFILE_STATUS = Object.freeze({
  DRAFT: "draft",
  ACTIVE: "active",
  DEPRECATED: "deprecated",
  ARCHIVED: "archived",
});

const firmwareDefaultsSchema = new mongoose.Schema(
  {
    // Operational defaults.
    currentRF: {
      type: Number,
      default: null,
      min: 0,
    },

    // Device operating limits.
    maxCurrent: {
      type: Number,
      default: null,
      min: 0,
    },

    maxPower: {
      type: Number,
      default: null,
      min: 0,
    },

    // Session safety configuration.
    sessionTimeoutSeconds: {
      type: Number,
      default: null,
      min: 1,
    },

    commandExpirySeconds: {
      type: Number,
      default: null,
      min: 1,
    },

    // Additional firmware-specific configuration.
    // Keep values validated by the provisioning service.
    additionalConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { _id: false }
);

const telemetrySettingsSchema = new mongoose.Schema(
  {
    enabled: {
      type: Boolean,
      default: true,
    },

    normalIntervalSeconds: {
      type: Number,
      default: 30,
      min: 1,
    },

    calibrationIntervalSeconds: {
      type: Number,
      default: 1,
      min: 1,
    },

    calibrationMaxDurationSeconds: {
      type: Number,
      default: 60,
      min: 1,
    },

    includePowerFactor: {
      type: Boolean,
      default: true,
    },

    includeRelayState: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

const firmwareProfileSchema = new mongoose.Schema(
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

    // Increment when a new profile revision is created.
    profileVersion: {
      type: Number,
      required: true,
      min: 1,
    },

    description: {
      type: String,
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: Object.values(FIRMWARE_PROFILE_STATUS),
      default: FIRMWARE_PROFILE_STATUS.DRAFT,
      index: true,
    },

    // Firmware identification.
    firmwareFamily: {
      type: String,
      required: true,
      trim: true,
    },

    targetFirmwareVersion: {
      type: String,
      required: true,
      trim: true,
    },

    protocolVersion: {
      type: String,
      required: true,
      trim: true,
    },

    // Hardware compatibility.
    supportedHardwareRevisions: {
      type: [String],
      default: [],
    },

    supportedMeteringHardware: {
      type: [String],
      default: [],
    },

    // Firmware capabilities.
    capabilities: {
      type: [String],
      default: [],
    },

    // Firmware configuration defaults.
    defaults: {
      type: firmwareDefaultsSchema,
      default: () => ({}),
    },

    // Telemetry behavior.
    telemetry: {
      type: telemetrySettingsSchema,
      default: () => ({}),
    },

    // Firmware distribution metadata.
    firmwareBinary: {
      version: {
        type: String,
        default: null,
        trim: true,
      },

      downloadUrl: {
        type: String,
        default: null,
        trim: true,
      },

      checksumAlgorithm: {
        type: String,
        default: null,
        trim: true,
      },

      checksum: {
        type: String,
        default: null,
        trim: true,
      },
    },

    releaseNotes: {
      type: String,
      default: "",
    },

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

// A profile code and version combination must be unique.
firmwareProfileSchema.index(
  { profileCode: 1, profileVersion: 1 },
  {
    unique: true,
    name: "uniq_firmware_profile_version",
  }
);

// Find active profiles by firmware family.
firmwareProfileSchema.index(
  { firmwareFamily: 1, status: 1 },
  {
    name: "firmware_family_status",
  }
);

// Find profiles by protocol version.
firmwareProfileSchema.index(
  { protocolVersion: 1, status: 1 },
  {
    name: "firmware_protocol_status",
  }
);

// Basic validation.
firmwareProfileSchema.pre("validate", function (next) {
  if (
    this.telemetry &&
    this.telemetry.calibrationIntervalSeconds >
      this.telemetry.normalIntervalSeconds
  ) {
    return next(
      new Error(
        "Calibration telemetry interval cannot exceed normal telemetry interval"
      )
    );
  }

  if (
    this.firmwareBinary &&
    this.firmwareBinary.checksum &&
    !this.firmwareBinary.checksumAlgorithm
  ) {
    return next(
      new Error(
        "Checksum algorithm is required when a firmware checksum is provided"
      )
    );
  }

  next();
});

firmwareProfileSchema.statics.STATUS =
  FIRMWARE_PROFILE_STATUS;

module.exports =
  mongoose.models.FirmwareProfile ||
  mongoose.model("FirmwareProfile", firmwareProfileSchema);
