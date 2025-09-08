// routes/coupons.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware'); // use your existing auth middleware
const { applyCoupon, consumeCoupon } = require("../controllers/couponController");
const CouponReservation = require('../models/CouponReservation');
router.post('/apply', authMiddleware, applyCoupon);
router.post("/consume", authMiddleware, consumeCoupon);

router.delete('/reservations/:id', authMiddleware, async (req,res) => {
  const id = req.params.id;
  const r = await CouponReservation.findById(id);
  if (!r) return res.status(404).json({ error: 'Reservation not found' });
  if (r.userId.toString() !== req.user.userId) return res.status(403).json({ error: 'Not yours' });
  await CouponReservation.deleteOne({ _id: id });
  res.json({ ok: true });
});

// routes/coupons.js (append)
router.get('/debug/:code', authMiddleware, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const coupon = await Coupon.findOne({ code });
    if (!coupon) return res.status(404).json({ error: 'Not found' });

    const reservationsCount = await CouponReservation.countDocuments({
      couponId: coupon._id,
      expiresAt: { $gt: new Date() }
    });

    const available = coupon.usageLimit == null ? null : (coupon.usageLimit - (coupon.usageCount || 0) - reservationsCount);

    return res.json({
      code: coupon.code,
      usageLimit: coupon.usageLimit,
      usageCount: coupon.usageCount,
      activeReservations: reservationsCount,
      available,
      // for dev: expiry and allowed lists
      expiryDate: coupon.expiryDate,
      allowedUsersCount: (coupon.allowedUsers || []).length,
      allowedDevices: coupon.allowedDevices || []
    });
  } catch (err) {
    console.error('debug error', err);
    res.status(500).json({ error: 'Server error', debug: err.message });
  }
});


module.exports = router;
