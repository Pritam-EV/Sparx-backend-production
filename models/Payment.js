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

    paymentMethod: {
      type: String, // upi / card / netbanking / free
    },

    gateway: {
      type: String, // cashfree / free
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
