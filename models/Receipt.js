// backend/models/Receipt.js
const mongoose = require('mongoose');

const receiptSchema = new mongoose.Schema({
  // ============== IDENTIFICATION ==============
  receiptId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deviceId: { type: String, required: true },
  sessionId: { type: String, required: true },
  transactionId: { type: String, required: true },

  // OWNER SNAPSHOT
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  ownerName: String,
  ownerEmail: String,
  ownerMobile: String,

  // USER SNAPSHOT
  userName: String,
  userEmail: String,
  userMobile: String,

  // DEVICE SNAPSHOT
  deviceCity: String,
  deviceState: String,
  deviceArea: String,
  deviceLocation: String,

    
  // ============== ENERGY METRICS ==============
  energyConsumed: { type: Number, required: true },      // Actual kWh used
  energySelected: { type: Number, required: true },      // Target kWh
  
  // ============== USER PAYMENT ==============
  amountSelected: { type: Number, required: true },      // Original amount
  amountPaid: { type: Number, required: true },          // After discount
  discountApplied: { type: Number, default: 0 },         // Coupon discount
  
  // ============== RATE SNAPSHOTS ==============
  userRatePerKwh: { type: Number, required: true },      // Net rate (ex-GST)
  userRateInclGST: { type: Number, required: true },     // Display rate (incl GST)
  
  // ============== TAX BREAKDOWN ==============
  taxableAmount: { type: Number, required: true },       // Base amount (pre-GST)
  gstAmount: { type: Number, required: true },           // 18% GST
  totalAmount: { type: Number, required: true },         // Final bill (taxable + GST)
  
  // ============== USAGE & REFUND ==============
  amountUtilized: { type: Number, required: true },      // Actual amount for energy consumed
  refundAmount: { type: Number, default: 0 },            // Refund to user
  
  // ============== PLATFORM REVENUE ==============
  commissionPerKwh: { type: Number, default: 0 },        // VJRA margin per kWh
  vjraMarginAmount: { type: Number, default: 0 },        // Total platform revenue
  
  // ============== PAYMENT GATEWAY ==============
  PGPercent: { type: Number, default: 0 },               // PG fee %
  paymentCharges: { type: Number, default: 0 },          // Actual PG charges
  
  // ============== ELECTRICITY COST ==============
  electricityCostPerKwh: { type: Number, default: 0 },   // Owner's meter rate
  electricityCost: { type: Number, default: 0 },         // Total electricity cost
  
  // ============== OWNER SETTLEMENT ==============
  ownerPayout: { type: Number, default: 0 },             // Amount owner receives
  
  // ============== REFUND LIFECYCLE ==============
  refund: {
    status: {
      type: String,
      enum: ["not_applicable", "initiated", "processed", "failed"],
      default: "not_applicable"
    },
    refundId: String,
    initiatedAt: Date,
    processedAt: Date,
    failureReason: String
  },
  
  // ============== USER FEEDBACK ==============
  rating: { type: Number, min: 1, max: 5 },
  suggestion: { type: String },
  
  // ============== METADATA ==============
  createdAt: { type: Date, default: Date.now }
});

// Pre-save defensive calculations
receiptSchema.pre('save', function(next) {
  // Auto-compute discountApplied
  const sel = this.amountSelected || 0;
  const paid = this.amountPaid || 0;
  this.discountApplied = Math.max(sel - paid, 0);
  
  // Auto-compute tax breakdown if missing
  if ((!this.taxableAmount || !this.gstAmount) && this.energyConsumed && this.userRatePerKwh) {
    this.taxableAmount = Number((this.energyConsumed * this.userRatePerKwh).toFixed(2));
    this.gstAmount = Number((this.taxableAmount * 0.18).toFixed(2));
    this.totalAmount = Number((this.taxableAmount + this.gstAmount).toFixed(2));
  }
  
  // Auto-compute userRateInclGST if missing
  if (!this.userRateInclGST && this.userRatePerKwh) {
    this.userRateInclGST = Number((this.userRatePerKwh * 1.18).toFixed(2));
  }
  
  next();
});

module.exports = mongoose.models.Receipt || mongoose.model('Receipt', receiptSchema);
