// backend/models/Receipt.js

const mongoose = require('mongoose');

const receiptSchema = new mongoose.Schema({
  receiptId:     { type: String, required: true, unique: true },
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deviceId:      { type: String, required: true },
  sessionId:     { type: String, required: true },
  transactionId: { type: String, required: true },
  energyConsumed:{ type: Number, required: true },
  energySelected:{ type: Number, required: true },
  amountSelected:{ type: Number, required: true },
  amountPaid:    { type: Number, required: true },
  discountApplied:{ type: Number, default: 0 },
  amountUtilized:{ type: Number, required: true },
  refund:        { type: Number, default: 0 },
  rating:        { type: Number, min: 1, max: 5 },     // ← new
  suggestion:    { type: String },                    // ← new
  createdAt:     { type: Date, default: Date.now }
});

module.exports = mongoose.models.Receipt || mongoose.model('Receipt', receiptSchema);
