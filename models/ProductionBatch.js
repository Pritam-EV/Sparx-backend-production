
/**
 * ProductionBatch.js
 *
 * VIZ Production 3.0 — Manufacturing Batch Model
 *
 * Responsibilities:
 * - Create and identify manufacturing batches.
 * - Store batch-level manufacturing information.
 * - Track planned and actual production quantities.
 * - Track batch lifecycle.
 * - Link devices through ProductionDevice.batchId.
 *
 * This model does not modify legacy production models.
 */

const mongoose = require("mongoose");

const BATCH_STATUS = Object.freeze({
  DRAFT: "draft",
  CREATED: "created",
  IN_PRODUCTION: "in_production",
  PRODUCTION_COMPLETED: "production_completed",
  CLOSED: "closed",
  CANCELLED: "cancelled",
});

const productionBatchSchema = new mongoose.Schema(
  {
    // Human-readable unique batch identifier.
    // Example: VIZ-BATCH-2026-001
    batchNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
    },

    batchName: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: "",
      trim: true,
    },

    // Project/customer information.
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

    // Manufacturing details.
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
      default: null,
      trim: true,
    },

    meteringHardware: {
      type: String,
      default: null,
      trim: true,
    },

    // Production quantity planning.
    plannedQuantity: {
      type: Number,
      required: true,
      min: 1,
    },

    actualQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Serial number generation metadata.
    serialNumberPrefix: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },

    serialNumberStart: {
      type: Number,
      required: true,
      min: 1,
    },

    serialNumberEnd: {
      type: Number,
      default: null,
      min: 1,
    },

    serialNumberPadding: {
      type: Number,
      default: 4,
      min: 1,
      max: 12,
    },

    // Profile references.
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

    // Manufacturing schedule.
    plannedStartDate: {
      type: Date,
      default: null,
    },

    plannedCompletionDate: {
      type: Date,
      default: null,
    },

    actualStartDate: {
      type: Date,
      default: null,
    },

    actualCompletionDate: {
      type: Date,
      default: null,
    },

    // Production location.
    manufacturingLocation: {
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

    // Batch lifecycle.
    status: {
      type: String,
      enum: Object.values(BATCH_STATUS),
      default: BATCH_STATUS.DRAFT,
      index: true,
    },

    // Quantity summary. These are counters maintained by
    // production services, not manually edited by clients.
    deviceCounts: {
      groupA: {
        type: Number,
        default: 0,
        min: 0,
      },

      discovered: {
        type: Number,
        default: 0,
        min: 0,
      },

      groupB: {
        type: Number,
        default: 0,
        min: 0,
      },

      calibrationRequired: {
        type: Number,
        default: 0,
        min: 0,
      },

      calibrating: {
        type: Number,
        default: 0,
        min: 0,
      },

      calibrationFailed: {
        type: Number,
        default: 0,
        min: 0,
      },

      productionReady: {
        type: Number,
        default: 0,
        min: 0,
      },

      dispatched: {
        type: Number,
        default: 0,
        min: 0,
      },
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

    closedAt: {
      type: Date,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancellationReason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    strict: "throw",
    minimize: false,
  }
);

// Indexes.
productionBatchSchema.index(
  { batchNumber: 1 },
  { unique: true, name: "uniq_production_batch_number" }
);

productionBatchSchema.index(
  { status: 1, createdAt: -1 },
  { name: "production_batch_status_created" }
);

productionBatchSchema.index(
  { project: 1, createdAt: -1 },
  { name: "production_batch_project" }
);

productionBatchSchema.index(
  { plannedStartDate: 1, status: 1 },
  { name: "production_batch_schedule" }
);

// Validate serial range and quantity.
productionBatchSchema.pre("validate", function (next) {
  if (
    this.serialNumberStart != null &&
    this.serialNumberEnd != null &&
    this.serialNumberEnd < this.serialNumberStart
  ) {
    return next(
      new Error("serialNumberEnd cannot be less than serialNumberStart")
    );
  }

  if (
    this.serialNumberStart != null &&
    this.serialNumberEnd != null
  ) {
    const rangeQuantity =
      this.serialNumberEnd - this.serialNumberStart + 1;

    if (rangeQuantity !== this.plannedQuantity) {
      return next(
        new Error(
          "Serial number range quantity must match plannedQuantity"
        )
      );
    }
  }

  if (this.actualQuantity > this.plannedQuantity) {
    return next(
      new Error("actualQuantity cannot exceed plannedQuantity")
    );
  }

  next();
});

productionBatchSchema.statics.STATUS = BATCH_STATUS;

module.exports =
  mongoose.models.ProductionBatch ||
  mongoose.model("ProductionBatch", productionBatchSchema);
