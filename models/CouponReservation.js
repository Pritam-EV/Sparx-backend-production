const mongoose = require('mongoose');

const reservationSchema = new mongoose.Schema({
  couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deviceId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true },  // ✅ REMOVED: index: true
}, { timestamps: true });

// ✅ KEEP: Single TTL index definition
reservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.CouponReservation || mongoose.model('CouponReservation', reservationSchema);
