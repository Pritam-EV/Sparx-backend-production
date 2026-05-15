const express        = require('express');
const router         = express.Router();
const UserActivity   = require('../models/UserActivity');
const User           = require('../models/User');
const authMiddleware = require('../middleware/authMiddleware');

// ─── POST /api/activity/track ─────────────────────────────────────────────────
// FE calls this on every page change. Uses upsert — one doc per user per day.
router.post('/track', authMiddleware, async (req, res) => {
  try {
    const { page, timeSpentSec = 0 } = req.body;
    if (!page) return res.status(400).json({ error: 'page required' });

    const today = new Date().toISOString().slice(0, 10); // "2026-05-16"

    await UserActivity.findOneAndUpdate(
      { userId: req.user.userId, date: today },
      {
        $push:  { pages: { page: page.slice(0, 200), visitedAt: new Date(), timeSpentSec } },
        $set:   { lastSeen: new Date() },
        $inc:   { totalPages: 1 },
      },
      { upsert: true, new: true }
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Activity track error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/activity/summary ────────────────────────────────────────────────
// Most visited pages across all users
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const summary = await UserActivity.aggregate([
      { $unwind: '$pages' },
      { $group: {
          _id:          '$pages.page',
          visits:       { $sum: 1 },
          lastSeen:     { $max: '$pages.visitedAt' },
          avgTimeSec:   { $avg: '$pages.timeSpentSec' },
          uniqueUsers:  { $addToSet: '$userId' }
      }},
      { $project: {
          page: '$_id', visits: 1, lastSeen: 1,
          avgTimeSec: { $round: ['$avgTimeSec', 0] },
          uniqueUsers: { $size: '$uniqueUsers' }
      }},
      { $sort: { visits: -1 } },
      { $limit: 50 }
    ]);
    return res.json(summary);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── GET /api/activity/dropoffs ───────────────────────────────────────────────
// Last page each user visited — grouped to show where users exit
router.get('/dropoffs', authMiddleware, async (req, res) => {
  try {
    const dropoffs = await UserActivity.aggregate([
      { $sort: { lastSeen: -1 } },
      { $group: {
          _id:      '$userId',
          lastPage: { $first: { $arrayElemAt: ['$pages', -1] } },
          lastSeen: { $first: '$lastSeen' }
      }},
      { $group: {
          _id:     '$lastPage.page',
          count:   { $sum: 1 },
          lastSeen:{ $max: '$lastSeen' }
      }},
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]);
    return res.json(dropoffs);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── GET /api/activity/users ──────────────────────────────────────────────────
// Per-user summary with name, mobile, last seen, total pages, total time
router.get('/users', authMiddleware, async (req, res) => {
  try {
    const stats = await UserActivity.aggregate([
      { $group: {
          _id:         '$userId',
          lastSeen:    { $max: '$lastSeen' },
          totalPages:  { $sum: '$totalPages' },
          activeDays:  { $sum: 1 },
          totalTimeSec:{ $sum: { $sum: '$pages.timeSpentSec' } },
          lastPage:    { $last: { $arrayElemAt: ['$pages', -1] } }
      }},
      { $lookup: {
          from: 'users', localField: '_id',
          foreignField: '_id', as: 'user'
      }},
      { $unwind: '$user' },
      { $project: {
          _id: 1, lastSeen: 1, totalPages: 1, activeDays: 1,
          totalTimeSec: 1, lastPage: 1,
          name:   '$user.name',
          mobile: '$user.mobile',
          email:  '$user.email',
          role:   '$user.role',
      }},
      { $sort: { lastSeen: -1 } },
      { $limit: 200 }
    ]);
    return res.json(stats);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── GET /api/activity/user/:userId ──────────────────────────────────────────
// Full page-by-page journey for one user
router.get('/user/:userId', authMiddleware, async (req, res) => {
  try {
    const docs = await UserActivity.find({ userId: req.params.userId })
      .sort({ date: -1 }).limit(30).lean();
    return res.json(docs);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

module.exports = router;