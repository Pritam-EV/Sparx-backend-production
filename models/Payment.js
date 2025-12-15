const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  paymentId: String,
  status: {
    type: String,
    enum: ["PENDING", "PAID", "FAILED"],
    default: "PENDING",
  },
  gateway: String,
  paidAt: Date,
}, { timestamps: true });

module.exports = mongoose.model("Payment", paymentSchema);
