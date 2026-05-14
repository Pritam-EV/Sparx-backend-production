const mongoose = require("mongoose");

const walletTransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: [
      "topup",       // user loaded money via Cashfree
      "debit",       // charging session paid via wallet
      "refund",      // session underuse refund → wallet
      "refund_bank", // refund sent to original bank (Cashfree refund)
      "admin_credit",// admin manually credits (for support cases)
      "admin_debit", // admin manually debits
    ],
    required: true,
    index: true,
  },
  amount: { type: Number, required: true, min: 0.01 },

  // Balance snapshot — for forensic audit
  balanceBefore: { type: Number, required: true },
  balanceAfter:  { type: Number, required: true },

  // References for traceability
  orderId:    { type: String, index: true },  // Cashfree orderId (topup or refund)
  sessionId:  { type: String, index: true },  // charging session
  paymentId:  { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },

  description: { type: String },
  idempotencyKey: { type: String, unique: true, sparse: true }, // prevent duplicates
  
  initiatedBy: { type: String, default: "user" }, // "user" | "system" | "admin"
  ip:          { type: String },  // log IP for audit
}, {
  timestamps: true,
  // Never allow updates to this collection
});

// Prevent accidental updates on this audit collection
walletTransactionSchema.pre("updateOne", function() {
  throw new Error("WalletTransaction records are immutable.");
});
walletTransactionSchema.pre("findOneAndUpdate", function() {
  throw new Error("WalletTransaction records are immutable.");
});

module.exports = mongoose.model("WalletTransaction", walletTransactionSchema);