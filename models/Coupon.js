// models/Coupon.js
const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  discountAmount: { type: Number, required: true }, // numeric (for percent use 0-100)
  discountType: { type: String, enum: ['amount', 'percent'], required: true },
  expiryDate: { type: Date, required: true },
  usageLimit: { type: Number, default: null },      // null = unlimited
  usageCount: { type: Number, default: 0 },
  allowedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],   // empty = all users
  allowedDevices: [{ type: String }],               // empty = all devices
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.models.Coupon || mongoose.model('Coupon', couponSchema);
