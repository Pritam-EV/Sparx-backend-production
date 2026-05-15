const express = require('express');
const router = express.Router();
const UserActivity = require('../models/UserActivity');
const { verifyToken } = require('../middleware/authMiddleware'); // your existing middleware

// POST /activity/track
router.post('/track', verifyToken, async (req, res) => {
  try {
    const { page, timestamp } = req.body;
    await UserActivity.create({
      userId: req.user._id,
      page,
      visitedAt: timestamp || new Date(),
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /activity/summary — for admin analytics
router.get('/summary', verifyToken, async (req, res) => {
  const summary = await UserActivity.aggregate([
    { $group: { _id: '$page', visits: { $sum: 1 }, lastSeen: { $max: '$visitedAt' } } },
    { $sort: { visits: -1 } }
  ]);
  res.json(summary);
});

// GET /activity/user/:userId — per-user history
router.get('/user/:userId', verifyToken, async (req, res) => {
  const logs = await UserActivity.find({ userId: req.params.userId })
    .sort({ visitedAt: -1 }).limit(100);
  res.json(logs);
});

module.exports = router;