const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  orderId: { type: String, unique: true },
  paymentId: String,
  status: { type: String, enum: ["PENDING", "PAID", "FAILED"], default: "PENDING" },
  gateway: String,
  paidAt: Date,
});

module.exports = mongoose.model("Payment", paymentSchema);
