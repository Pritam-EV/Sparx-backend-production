const express = require('express');
const router = express.Router();
const Session = require('../models/session');
const Device = require('../models/device');
const User = require('../models/User');

// Helper: Period parser (returns start/end Date)
function parsePeriod(period) {
  const now = new Date();
  let start, end;
  switch (period) {
    case 'today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      break;
    case 'thisWeek': {
      const day = now.getDay() || 7;
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (7 - day) + 1);
      break;
    }
    case 'thisMonth':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      break;
    case '3months':
      start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      break;
    case 'thisYear':
      start = new Date(now.getFullYear(), 0, 1);
      end = new Date(now.getFullYear() + 1, 0, 1);
      break;
    case 'all':
    default:
      start = new Date(0);
      end = new Date();
      break;
  }
  return { start, end };
}

// GET /api/analytics/filters
router.get('/filters', async (req, res) => {
  try {
    // Return devices with _id and device_id for frontend filter
    const devices = await Device.find({}, { _id: 1, device_id: 1 }).lean();

    // Get distinct filter values for device areas, cities, states, charger types
    const areas = await Device.distinct('area');
    const cities = await Device.distinct('city');
    const states = await Device.distinct('state');
    const chargerTypes = await Device.distinct('charger_type');

    res.json({ devices, areas, cities, states, chargerTypes });
  } catch (err) {
    console.error('Error fetching filter options:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/sessions
router.get('/sessions', async (req, res) => {
  try {
    const {
      period = 'all',
      deviceIds,
      area,
      city,
      state,
      chargerType
    } = req.query;
    const { start, end } = parsePeriod(period);

          // Construct device filter based on query params
        // Instead of filtering devices by _id to use in sessions, do:

        let deviceFilter = {};
        if (deviceIds) {
        // deviceIds here are ObjectIds (from frontend as Device._id)
        const ids = deviceIds.split(',').filter(id => id);
        if (ids.length > 0) deviceFilter._id = { $in: ids };
        }
        if (area && area !== "all") deviceFilter.area = area;
        if (city && city !== "all") deviceFilter.city = city;
        if (state && state !== "all") deviceFilter.state = state;
        if (chargerType && chargerType !== "all") deviceFilter.charger_type = chargerType;

        // Find matching devices
        const devices = await Device.find(deviceFilter).lean();

        if (devices.length === 0) {
        return res.json({ table: [], stats: [] });
        }

        // Extract device_id strings
        const deviceIdStrings = devices.map(d => d.device_id);

        // Query sessions by deviceId string and startTime range
        const sessionQuery = {
        deviceId: { $in: deviceIdStrings },
        startTime: { $gte: start, $lt: end }
        };

        const sessions = await Session.find(sessionQuery)
        .populate('userId')  // userId is still ObjectId ref; keep populate
        .lean();

        // Since deviceId is string, you can’t populate device details directly
        // You can manually join device info after fetch if needed

        // For session aggregation, map device_id directly
        const deviceStats = {};
        sessions.forEach(s => {
        const id = s.deviceId || 'Unknown';
        if (!deviceStats[id]) {
            deviceStats[id] = {
            deviceId: id,
            amountPaid: 0,
            amountUtilized: 0,
            energySelected: 0,
            energyConsumed: 0,
            sessionCount: 0,
            duration: 0,
            };
        }
        deviceStats[id].amountPaid += s.amountPaid || 0;
        deviceStats[id].amountUtilized += s.amountUsed || 0;
        deviceStats[id].energySelected += s.energySelected || 0;
        deviceStats[id].energyConsumed += s.energyConsumed || 0;
        deviceStats[id].sessionCount += 1;

        if (s.startTime && s.endTime) {
            const st = new Date(s.startTime);
            const et = new Date(s.endTime);
            if (
            st.getFullYear() === et.getFullYear() &&
            st.getMonth() === et.getMonth() &&
            st.getDate() === et.getDate()
            ) {
            deviceStats[id].duration += (et - st) / 60000;
            }
        }
        });

        res.json({
        table: sessions.map(s => ({
            date: s.startTime,
            transactionId: s.transactionId || s._id?.toString(),
            userId: s.userId?._id?.toString() || '',
            deviceId: s.deviceId || '',
            status: s.status || '',
            amountPaid: s.amountPaid || 0,
            amountUtilized: s.amountUsed || 0,
            energySelected: s.energySelected || 0,
            energyConsumed: s.energyConsumed || 0,
            chargingDuration: (() => {
            if (s.startTime && s.endTime) {
                const st = new Date(s.startTime);
                const et = new Date(s.endTime);
                if (
                st.getFullYear() === et.getFullYear() &&
                st.getMonth() === et.getMonth() &&
                st.getDate() === et.getDate()
                ) {
                return ((et - st) / 60000).toFixed(1);
                }
            }
            return "";
            })(),
        })),
        stats: Object.values(deviceStats),
        });


  } catch (err) {
    console.error('Session Analytics Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
