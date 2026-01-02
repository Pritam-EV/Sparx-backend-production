// backend/controllers/couponController.js
const Coupon = require('../models/Coupon');
const CouponReservation = require('../models/CouponReservation');
const mongoose = require('mongoose');

const RESERVATION_TTL_MINUTES = 1;

function makeError(res, status=500, message='Server error', debug=null) {
  if (process.env.NODE_ENV !== 'production' && debug) {
    return res.status(status).json({ error: message, debug });
  }
  return res.status(status).json({ error: message });
}

// controllers/couponController.js
async function applyCoupon(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { code, deviceId, amount } = req.body;
    if (!code || !deviceId || amount === undefined)
      return res.status(400).json({ error: "code, deviceId and amount required" });

    const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
    if (!coupon) return res.status(404).json({ error: "Invalid coupon code" });

    const now = new Date();
    if (coupon.expiryDate && new Date(coupon.expiryDate) < now)
      return res.status(400).json({ error: "Coupon expired" });

    if (coupon.allowedUsers?.length > 0 && !coupon.allowedUsers.includes(userId))
      return res.status(403).json({ error: "Coupon not valid for this user" });

    if (coupon.allowedDevices?.length > 0 && !coupon.allowedDevices.includes(deviceId))
      return res.status(403).json({ error: "Coupon not valid for this device" });

    // check usage (no reservations now)
    if (coupon.usageLimit != null && coupon.usageCount >= coupon.usageLimit)
      return res.status(400).json({ error: "Coupon usage limit reached" });

    // compute discount
    let newAmount = amount;
    if (coupon.discountType === "amount") {
      newAmount = Math.max(amount - coupon.discountAmount, 0);
    } else if (coupon.discountType === "percent") {
      newAmount = Math.max(amount * (1 - coupon.discountAmount / 100), 0);
    }

    return res.json({
      success: true,
      newAmount,
      coupon: {
        code: coupon.code,
        discountAmount: coupon.discountAmount,
        discountType: coupon.discountType,
      },
    });
  } catch (err) {
    console.error("applyCoupon error", err);
    res.status(500).json({ error: "Server error", debug: err.message });
  }
}

// controllers/couponController.js
async function consumeCoupon(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { code, deviceId } = req.body;
    const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
    if (!coupon) return res.status(404).json({ error: "Invalid coupon code" });

    if (coupon.usageLimit != null && coupon.usageCount >= coupon.usageLimit)
      return res.status(400).json({ error: "Coupon usage limit reached" });

    // increment usage
await Coupon.updateOne(
  { _id: coupon._id },
  {
    $set: {
      usageCount: Number(coupon.usageCount || 0) + 1
    }
  }
);


    return res.json({ success: true, message: "Coupon consumed" });
  } catch (err) {
    console.error("consumeCoupon error", err);
    res.status(500).json({ error: "Server error", debug: err.message });
  }
}


module.exports = {
  applyCoupon,
  consumeCoupon,
};
