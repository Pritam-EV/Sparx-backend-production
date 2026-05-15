const express        = require('express');
const router         = express.Router();
const UserActivity   = require('../models/UserActivity');
const User           = require('../models/User');
const authMiddleware = require('../middleware/authMiddleware');

// ─── POST /api/activity/track ─────────────────────────────────────────────────
// FE calls this on every page change. Uses upsert — one doc per user per day.
router.post('/track', authMiddleware, async (req, res) => {
  try {
    const { page, timeSpentSec = 0, location } = req.body;
    if (!page) return res.status(400).json({ error: 'page required' });

    const today = new Date().toISOString().slice(0, 10); // "2026-05-16"

    await UserActivity.findOneAndUpdate(
      { userId: req.user.userId, date: today },
      {
        $push: {
  pages: {
    page: page.slice(0, 200),
    visitedAt: new Date(),
    timeSpentSec,
    ...(location?.lat ? { location } : {}),  // only add if FE sent coords
  }
},
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
// ─── GET /api/activity/users ──────────────────────────────────────────────────
router.get('/users', authMiddleware, async (req, res) => {
  try {
    const Device = require('../models/device');

    // Step 1 — aggregate user activity as before, but also grab last location
    const stats = await UserActivity.aggregate([
      { $sort: { date: -1 } },
      { $group: {
          _id:          '$userId',
          lastSeen:     { $max: '$lastSeen' },
          totalPages:   { $sum: '$totalPages' },
          activeDays:   { $sum: 1 },
          totalTimeSec: { $sum: { $sum: '$pages.timeSpentSec' } },
          lastPage:     { $last: { $arrayElemAt: ['$pages', -1] } },
          // Get last page entry that has a location
          allPages:     { $push: '$pages' },
      }},
      { $lookup: {
          from: 'users', localField: '_id',
          foreignField: '_id', as: 'user'
      }},
      { $unwind: '$user' },
      { $project: {
          _id: 1, lastSeen: 1, totalPages: 1, activeDays: 1,
          totalTimeSec: 1, lastPage: 1, allPages: 1,
          name:   '$user.name',
          mobile: '$user.mobile',
          email:  '$user.email',
          role:   '$user.role',
      }},
      { $sort: { lastSeen: -1 } },
      { $limit: 200 }
    ]);

    // Step 2 — extract last known location per user from their pages
    const R = 6371000;
    const toRad = (d) => d * Math.PI / 180;
    const distanceM = (lat1, lng1, lat2, lng2) => {
      const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat/2)**2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    };

    // Step 3 — load all chargers once
    const chargers = await Device.find(
      { lat: { $exists: true }, lng: { $exists: true } },
      { device_id:1, location:1, lat:1, lng:1, area:1, city:1, status:1 }
    ).lean();

    // Step 4 — for each user find last location + nearest charger
    const result = stats.map(u => {
      // flatten all pages arrays, find last one with a valid location
      const allPagesFlat = (u.allPages || []).flat();
      const pagesWithLoc = allPagesFlat.filter(p => p?.location?.lat);
      const lastLoc = pagesWithLoc.length
        ? pagesWithLoc[pagesWithLoc.length - 1].location
        : null;

      let nearestCharger = null;
      if (lastLoc && chargers.length) {
        let minDist = Infinity;
        chargers.forEach(c => {
          const d = distanceM(lastLoc.lat, lastLoc.lng, c.lat, c.lng);
          if (d < minDist) {
            minDist = d;
            nearestCharger = {
              deviceId:  c.device_id,
              location:  c.location,
              area:      c.area,
              city:      c.city,
              status:    c.status,
              distanceM: Math.round(d),
            };
          }
        });
      }

      const { allPages, ...rest } = u; // strip raw pages from response
      return { ...rest, lastLocation: lastLoc, nearestCharger };
    });

    return res.json(result);
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

// GET /api/activity/location-heatmap
// Returns aggregated user location pings near each charger
router.get('/location-heatmap', authMiddleware, async (req, res) => {
  try {
    // Step 1 — get all location pings from last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const pings = await UserActivity.aggregate([
      { $match: { lastSeen: { $gte: thirtyDaysAgo } } },
      { $unwind: '$pages' },
      { $match: {
          'pages.location.lat': { $exists: true },
          'pages.location.accuracy': { $lt: 100 }  // only accurate pings (< 100m)
      }},
      { $group: {
          _id: '$userId',
          lat:        { $last: '$pages.location.lat' },
          lng:        { $last: '$pages.location.lng' },
          totalPings: { $sum: 1 },
          lastSeen:   { $max: '$pages.visitedAt' },
      }},
      { $limit: 2000 }
    ]);

    // Step 2 — get all chargers with location
    const Device = require('../models/device');
    const chargers = await Device.find(
      { lat: { $exists: true }, lng: { $exists: true } },
      { device_id:1, location:1, lat:1, lng:1, area:1, city:1, status:1 }
    ).lean();

    // Step 3 — for each charger, count how many users were within 500m
    const R = 6371000; // Earth radius in metres
    const toRad = (d) => d * Math.PI / 180;
    const distanceM = (lat1, lng1, lat2, lng2) => {
      const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat/2)**2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    };

    const chargerStats = chargers.map((c) => {
      const nearby = pings.filter(p =>
        distanceM(p.lat, p.lng, c.lat, c.lng) <= 500  // within 500m
      );
      return {
        chargerId:    c._id,
        deviceId:     c.device_id,
        location:     c.location,
        area:         c.area,
        city:         c.city,
        lat:          c.lat,
        lng:          c.lng,
        status:       c.status,
        nearbyUsers:  nearby.length,    // users who opened app within 500m
        lastUserSeen: nearby.reduce((m, p) =>
          p.lastSeen > m ? p.lastSeen : m, new Date(0))
      };
    });

    return res.json({
      pings:         pings.map(p => ({ lat: p.lat, lng: p.lng })), // for heatmap render
      chargerStats:  chargerStats.sort((a, b) => b.nearbyUsers - a.nearbyUsers),
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

module.exports = router;