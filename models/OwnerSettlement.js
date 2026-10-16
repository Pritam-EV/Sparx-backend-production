// models/OwnerSettlement.js
const mongoose = require("mongoose");

const settlementStatuses = [
  "pending",
  "processing",
  "paid",
  "failed",
  "on_hold",
];

const lineItemSchema = new mongoose.Schema(
  {
    // Actual Receipt document ID, not its human-readable receipt number.
    receiptRecordId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Receipt",
      required: true,
    },

    receiptId: {
      type: String,
      required: true,
    },

    sessionId: {
      type: String,
      required: true,
    },

    deviceId: {
      type: String,
      required: true,
    },

    receiptCreatedAt: {
      type: Date,
      required: true,
    },

    energyKwh: {
      type: Number,
      default: 0,
    },

    customerBillingsInclGst: {
      type: Number,
      default: 0,
    },

    refundAmountSnapshot: {
      type: Number,
      default: 0,
    },

    payoutAmount: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const statusHistorySchema = new mongoose.Schema(
  {
    fromStatus: {
      type: String,
      default: null,
    },

    toStatus: {
      type: String,
      enum: settlementStatuses,
      required: true,
    },

    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    changedByRole: {
      type: String,
      enum: ["admin", "accountant"],
      required: true,
    },

    reason: {
      type: String,
      default: "",
      maxlength: 500,
    },

    paymentReference: {
      type: String,
      default: "",
      maxlength: 120,
    },

    changedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const ownerSettlementSchema = new mongoose.Schema(
  {
    settlementId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    ownerName: {
      type: String,
      default: "",
    },

    ownerEmail: {
      type: String,
      default: "",
    },

    ownerMobile: {
      type: String,
      default: "",
    },

    periodStart: {
      type: Date,
      required: true,
    },

    // Exclusive end boundary.
    periodEnd: {
      type: Date,
      required: true,
    },

    status: {
      type: String,
      enum: settlementStatuses,
      default: "pending",
      index: true,
    },

    lineItems: {
      type: [lineItemSchema],
      required: true,
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0,
        message: "A settlement must contain at least one receipt.",
      },
    },

    receiptCount: {
      type: Number,
      required: true,
      min: 1,
    },

    totalEnergyKwh: {
      type: Number,
      default: 0,
    },

    customerBillingsInclGst: {
      type: Number,
      default: 0,
    },

    refundAmountSnapshot: {
      type: Number,
      default: 0,
    },

    // Sum of Receipt.ownerPayout snapshots.
    // This records the payable amount calculated from existing receipt data.
    payoutAmount: {
      type: Number,
      required: true,
      min: 0.01,
    },

    amountPaid: {
      type: Number,
      default: 0,
      min: 0,
    },

    payoutMethod: {
      type: String,
      enum: ["NEFT", "IMPS", "RTGS", "UPI", "OTHER", null],
      default: null,
    },

    paymentReference: {
      type: String,
      default: "",
      maxlength: 120,
    },

    paidAt: {
      type: Date,
      default: null,
    },

    failureReason: {
      type: String,
      default: "",
      maxlength: 500,
    },

    notes: {
      type: String,
      default: "",
      maxlength: 1000,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    statusHistory: {
      type: [statusHistorySchema],
      default: [],
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  }
);

// A receipt must not be assigned to more than one settlement document.
// Ensure this index exists in MongoDB before creating production batches.
ownerSettlementSchema.index(
  { "lineItems.receiptRecordId": 1 },
  { unique: true }
);

ownerSettlementSchema.index({
  ownerId: 1,
  createdAt: -1,
});

ownerSettlementSchema.index({
  status: 1,
  createdAt: -1,
});

ownerSettlementSchema.index({
  ownerId: 1,
  status: 1,
  paidAt: -1,
});

module.exports =
  mongoose.models.OwnerSettlement ||
  mongoose.model("OwnerSettlement", ownerSettlementSchema);