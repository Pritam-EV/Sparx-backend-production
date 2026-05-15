const express        = require('express');
const router         = express.Router();
const UserActivity   = require('../models/UserActivity');
const authMiddleware = require('../middleware/authMiddleware');

// POST /api/activity/track
router.post('/track', authMiddleware, async (req, res) => {
  try {
    const { page, timestamp } = req.body;
    if (!page) return res.status(400).json({ error: 'page is required' });
    await UserActivity.create({
      userId:    req.user.userId,
      page:      page.slice(0, 200),
      visitedAt: timestamp ? new Date(timestamp) : new Date(),
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Activity track error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/activity/summary
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const summary = await UserActivity.aggregate([
      { $group: { _id: '$page', visits: { $sum: 1 }, lastSeen: { $max: '$visitedAt' } } },
      { $sort: { visits: -1 } },
      { $limit: 50 }
    ]);
    return res.json(summary);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/activity/dropoffs — last page per user, grouped
router.get('/dropoffs', authMiddleware, async (req, res) => {
  try {
    const dropoffs = await UserActivity.aggregate([
      { $sort: { userId: 1, visitedAt: -1 } },
      { $group: { _id: '$userId', lastPage: { $first: '$page' }, lastSeen: { $first: '$visitedAt' } } },
      { $group: { _id: '$lastPage', count: { $sum: 1 }, lastSeen: { $max: '$lastSeen' } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]);
    return res.json(dropoffs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/activity/user/:userId
router.get('/user/:userId', authMiddleware, async (req, res) => {
  try {
    const logs = await UserActivity.find({ userId: req.params.userId })
      .sort({ visitedAt: -1 }).limit(100).lean();
    return res.json(logs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;