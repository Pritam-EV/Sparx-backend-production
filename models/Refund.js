// models/Refund.js
const mongoose = require("mongoose");

const RefundSchema = new mongoose.Schema({
  // ── Who & What ──────────────────────────────────────────────────────────────
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: "User",              required: true, index: true },
  paymentId:    { type: mongoose.Schema.Types.ObjectId, ref: "Payment",           index: true },
  walletTxnId:  { type: mongoose.Schema.Types.ObjectId, ref: "WalletTransaction", index: true },

  // ── Order reference ──────────────────────────────────────────────────────────
  orderId:      { type: String, required: true, index: true }, // original Cashfree orderId
  sessionId:    { type: String, index: true },

  // ── Refund identity ──────────────────────────────────────────────────────────
  refundId:     { type: String, required: true, unique: true, index: true }, // YOUR id e.g. refund_<uuid>
  cfRefundId:   { type: String, index: true },   // Cashfree's cf_refund_id (comes via webhook)

  // ── Amounts ───────────────────────────────────────────────────────────────────
  refundAmount: { type: Number, required: true },
  refundType:   { type: String, enum: ["FULL", "PARTIAL"], default: "FULL" },

  // ── Destination ───────────────────────────────────────────────────────────────
  // "wallet" = credited to Sparx wallet instantly (no Cashfree call)
  // "bank"   = sent back to original payment source via Cashfree
  destination:  { type: String, enum: ["wallet", "bank"], required: true },

  // ── Status ────────────────────────────────────────────────────────────────────
  // wallet refunds are always SUCCESS immediately
  // bank refunds: INITIATED → PENDING → SUCCESS | CANCELLED | ONHOLD
  status: {
    type: String,
    enum: ["INITIATED", "PENDING", "SUCCESS", "CANCELLED", "ONHOLD", "FAILED"],
    default: "INITIATED",
    index: true,
  },

  // ADD these fields to the Refund schema if not already there:

idempotencyKey: {
  type: String,
  unique: true,
  sparse: true,   // sparse = only enforces uniqueness when field exists
  index: true,
},

// Analytics metadata fields (optional but very useful for future reports):
amountPaid: {
  type: Number,
  default: 0,
},
amountUtilized: {
  type: Number,
  default: 0,
},
gateway: {
  type: String,   // "wallet" | "cashfree"
  default: "wallet",
},

  // ── Bank refund details (only populated for destination: "bank") ─────────────
  refundNote:         { type: String },   // reason for refund
  arnNumber:          { type: String },   // bank ARN/UTR — proof money reached bank
  statusDescription:  { type: String },   // human-readable status from Cashfree

  // ── Audit ─────────────────────────────────────────────────────────────────────
  initiatedBy:  { type: String, enum: ["user", "admin", "system"], default: "admin" },
  initiatedAt:  { type: Date, default: Date.now },
  processedAt:  { type: Date },           // set when status → SUCCESS via webhook
  rawResponse:  { type: mongoose.Schema.Types.Mixed }, // full Cashfree API response

}, { timestamps: true });

module.exports = mongoose.model("Refund", RefundSchema);