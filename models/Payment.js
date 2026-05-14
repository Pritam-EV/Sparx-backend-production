const mongoose = require("mongoose");

const PaymentSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    sessionId: {
      type: String,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    deviceId: {
      type: String,
      index: true,
    },

    amountPaid: {
      type: Number,
      required: true,
    },

    currency: {
      type: String,
      default: "INR",
    },

    status: {
      type: String,
      enum: ["PENDING", "SUCCESS", "FAILED"],
      default: "PENDING",
      index: true,
    },
    type: {
  type: String,
  enum: ["charging", "wallet_topup"],
  default: "charging",
  },
    paymentMethod: {
      type: String, // upi / card / netbanking / free / wallet / wallet_topup
    },

    gateway: {
      type: String,
      enum: ["cashfree", "wallet", "free"],   // ← add "wallet"
      default: "cashfree",
    },

    cfPaymentId: {
      type: String,
    },

    rawResponse: {
      type: mongoose.Schema.Types.Mixed, // full Cashfree payload
    },

    paidAt: {
      type: Date,
    },
    bankReference: { type: String },                   // UTR/bank ref from Cashfree
    paymentGroup: { type: String },                    // upi/credit_card/debit_card etc.
    failureReason: { type: String },                   // payment_message on failure
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", PaymentSchema);
