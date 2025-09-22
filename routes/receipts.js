const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/roleMiddleware');
const Receipt = require('../models/Receipt');
const Device = require('../models/device');

// GET /api/receipts/all?search=&deviceId=&userId=&from=&to=&page=1&limit=100
router.get('/all', auth, async (req, res) => {
  try {
    const { search = "", deviceId, userId, from, to, page = 1, limit = 100 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
    const skip = (pageNum - 1) * lim;

    const match = {};
    if (deviceId) match.deviceId = deviceId;
    if (userId) match.userId = userId;
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = new Date(from);
      if (to) match.createdAt.$lte = new Date(to);
    }
    if (search) {
      match.$or = [
        { receiptId: new RegExp(search, 'i') },
        { deviceId: new RegExp(search, 'i') },
        { sessionId: new RegExp(search, 'i') },
        { transactionId: new RegExp(search, 'i') },
      ];
    }

    const pipeline = [
      { $match: match },
      {
        $facet: {
          list: [
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: lim },
            {
              $project: {
                _id: 1,
                receiptId: 1,
                userId: 1,
                deviceId: 1,
                sessionId: 1,
                transactionId: 1,
                amountPaid: 1,
                amountUtilized: 1,
                amountSelected: 1,
                discountApplied: 1,
                refund: 1,
                energySelected: 1,
                energyConsumed: 1,
                createdAt: 1,
              }
            }
          ],
          totals: [
            {
              $group: {
                _id: null,
                totalReceipts: { $sum: 1 },
                totalAmountPaid: { $sum: { $ifNull: ["$amountPaid", 0] } },
                totalAmountUtilized: { $sum: { $ifNull: ["$amountUtilized", 0] } },
                totalAmountSelected: { $sum: { $ifNull: ["$amountSelected", 0] } },
                totalDiscountApplied: { $sum: { $ifNull: ["$discountApplied", 0] } },
                totalRefunds: { $sum: { $ifNull: ["$refund", 0] } },
                totalEnergySelected: { $sum: { $ifNull: ["$energySelected", 0] } },
                totalEnergyConsumed: { $sum: { $ifNull: ["$energyConsumed", 0] } },
              }
            }
          ],
          count: [{ $count: "total" }]
        }
      }
    ];
    const { deviceIds } = req.query;
    if (deviceIds) {
      const list = Array.isArray(deviceIds) ? deviceIds : String(deviceIds).split(",").map(s => s.trim()).filter(Boolean);
      if (list.length) match.deviceId = { $in: list };
    }
    const result = await Receipt.aggregate(pipeline);
    const facet = result?.[0] || {};
    const list = facet.list || [];
    const count = facet.count?.[0]?.total || 0;
    const t = facet.totals?.[0] || {
      totalReceipts: 0,
      totalAmountPaid: 0,
      totalAmountUtilized: 0,
      totalAmountSelected: { $sum: { $ifNull: ["$amountSelected", 0] } },
      totalDiscountApplied: 0,
      totalRefunds: 0,
      totalEnergySelected: 0,
      totalEnergyConsumed: 0,
    };

    res.json({
      page: pageNum,
      limit: lim,
      total: count,
      totals: {
        totalReceipts: t.totalReceipts,
        totalAmountPaid: t.totalAmountPaid,
        totalAmountUtilized: t.totalAmountUtilized,
        totalAmountSelected: t.totalAmountSelected,
        totalDiscountApplied: t.totalDiscountApplied,
        totalRefunds: t.totalRefunds,
        totalEnergySelected: t.totalEnergySelected,
        totalEnergyConsumed: t.totalEnergyConsumed,
      },
      receipts: list,
    });
  } catch (err) {
    console.error('Error fetching receipts:', err);
    res.status(500).json({ message: 'Server error' });
  }
});


router.get('/:sessionId', auth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const receipt = await Receipt.findOne({ sessionId, userId: req.user.userId });
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    res.json(receipt);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/receipts/:sessionId/rate
router.post("/:sessionId/rate", auth, async (req, res) => {
  const { sessionId } = req.params;
  const { rating } = req.body;
  if (rating < 1 || rating > 5) return res.status(400).json({ error: "Invalid rating" });
  await Receipt.updateOne(
    { sessionId, userId: req.user.userId },
    { rating }
  );
  res.json({ message: "Rating saved" });
});

// POST /api/receipts/:sessionId/suggest
router.post("/:sessionId/suggest", auth, async (req, res) => {
  const { sessionId } = req.params;
  const { suggestion } = req.body;
  if (!suggestion?.trim()) return res.status(400).json({ error: "Empty suggestion" });
  await Receipt.updateOne(
    { sessionId, userId: req.user.userId },
    { suggestion }
  );
  res.json({ message: "Suggestion saved" });
});



module.exports = router;
