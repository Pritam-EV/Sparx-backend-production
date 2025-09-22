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
  discountApplied:{ 
    type: Number, 
    default: function() {
      const sel = this.amountSelected || 0;
      const paid = this.amountPaid || 0;
      return Math.max(sel - paid, 0);
    } 
  },
  amountUtilized:{ type: Number, required: true },
  refund:        { type: Number, default: 0 },
  rating:        { type: Number, min: 1, max: 5 },     // ← new
  suggestion:    { type: String },                    // ← new
  createdAt:     { type: Date, default: Date.now }
});

// Ensure recomputation on saves/updates that change selected/paid
receiptSchema.pre('save', function(next) {
  const sel = this.amountSelected || 0;
  const paid = this.amountPaid || 0;
  this.discountApplied = Math.max(sel - paid, 0);
  next();
});

// For findOneAndUpdate/updateOne/updateMany, prefer update pipeline on MongoDB 4.2+
receiptSchema.pre(['findOneAndUpdate','updateOne','updateMany'], function(next) {
  // If using classic updates, you can skip, or convert to pipeline here if desired
  next();
});

module.exports = mongoose.models.Receipt || mongoose.model('Receipt', receiptSchema);
