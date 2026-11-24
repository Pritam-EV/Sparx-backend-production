
/**
 * ProductionProfile.js
 *
 * VIZ Production 3.0
 *
 * Stores reusable manufacturing and business configuration.
 *
 * This profile is intended for:
 * - Project and customer details
 * - Charger specifications
 * - Metering hardware selection
 * - Commercial configuration
 * - Electricity bearer
 * - Intended deployment location
 *
 * Firmware-specific settings belong in FirmwareProfile.
 * Calibration settings belong in CalibrationProfile.
 */

const mongoose = require("mongoose");

const ELECTRICITY_BEARER = Object.freeze({
  OWNER: "OWNER",
  VJRA: "VJRA",
});

const CHARGER_TYPES = Object.freeze([
  "single_point",
  "three_point",
  "other",
]);

const productionProfileSchema = new mongoose.Schema(
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

    description: {
      type: String,
      default: "",
      trim: true,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    // Project and customer information.
    project: {
      type: String,
      default: null,
      trim: true,
    },

    customerName: {
      type: String,
      default: null,
      trim: true,
    },

    // Manufacturing configuration.
    hardwareRevision: {
      type: String,
      required: true,
      trim: true,
    },

    pcbBatch: {
      type: String,
      default: null,
      trim: true,
    },

    chargerType: {
      type: String,
      enum: CHARGER_TYPES,
      required: true,
    },

    meteringHardware: {
      type: String,
      required: true,
      trim: true,
    },

    // Examples:
    // ATM90E26, ATM90E36A, HLW8032
    meteringHardwareRevision: {
      type: String,
      default: null,
      trim: true,
    },

    // Commercial configuration.
    electricityBearer: {
      type: String,
      enum: Object.values(ELECTRICITY_BEARER),
      default: ELECTRICITY_BEARER.OWNER,
    },

    ratePerKwh: {
      type: Number,
      default: 0,
      min: 0,
    },

    vjraMargin: {
      type: Number,
      default: 0,
      min: 0,
    },

    serviceCharge: {
      type: Number,
      default: 0,
      min: 0,
    },

    gstPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    // Intended deployment location.
    location: {
      type: String,
      default: null,
      trim: true,
    },

    area: {
      type: String,
      default: null,
      trim: true,
    },

    city: {
      type: String,
      default: null,
      trim: true,
    },

    state: {
      type: String,
      default: null,
      trim: true,
    },

    country: {
      type: String,
      default: "India",
      trim: true,
    },

    latitude: {
      type: Number,
      default: null,
      min: -90,
      max: 90,
    },

    longitude: {
      type: Number,
      default: null,
      min: -180,
      max: 180,
    },

    // Optional operational metadata.
    installationNotes: {
      type: String,
      default: "",
    },

    notes: {
      type: String,
      default: "",
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

// A profile code must be unique.
productionProfileSchema.index(
  { profileCode: 1 },
  {
    unique: true,
    name: "uniq_production_profile_code",
  }
);

// Quickly find active profiles.
productionProfileSchema.index(
  { isActive: 1, profileName: 1 },
  {
    name: "production_profile_active_name",
  }
);

// Validate geographic coordinates.
productionProfileSchema.pre("validate", function (next) {
  if (
    (this.latitude === null) !==
    (this.longitude === null)
  ) {
    return next(
      new Error(
        "Latitude and longitude must either both be provided or both be empty"
      )
    );
  }

  next();
});

productionProfileSchema.statics.ELECTRICITY_BEARER =
  ELECTRICITY_BEARER;

productionProfileSchema.statics.CHARGER_TYPES =
  CHARGER_TYPES;

module.exports =
  mongoose.models.ProductionProfile ||
  mongoose.model("ProductionProfile", productionProfileSchema);
