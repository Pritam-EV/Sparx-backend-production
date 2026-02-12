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

    if (req.user?.role === 'owner') {
      const owned = await Device.find({ ownerId: req.user.userId }, 'device_id').lean();
      const ids = owned.map(d => d.device_id);
      match.deviceId = { $in: ids.length ? ids : ['__none__'] };
    }

    const { deviceIds } = req.query;
    if (deviceIds) {
      const list = Array.isArray(deviceIds) ? deviceIds : String(deviceIds).split(",").map(s => s.trim()).filter(Boolean);
      if (list.length) match.deviceId = match.deviceId ? { $in: list.filter(x => match.deviceId.$in?.includes(x)) } : { $in: list };
    }

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

    const result = await Receipt.aggregate(pipeline);
    const facet = result?.[0] || {};
    const list = facet.list || [];
    const count = facet.count?.[0]?.total || 0;
    const t = facet.totals?.[0] || {
      totalReceipts: 0,
      totalAmountPaid: 0,
      totalAmountUtilized: 0,
      totalAmountSelected: 0,
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

// ✅ NEW: GET /api/receipts/owner/analytics
// routes/receipts.js

router.get('/owner/analytics', auth, async (req, res) => {
  try {
    const { userId, duration, deviceIds } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Parse device IDs
    const deviceIdArray = deviceIds ? deviceIds.split(',').map(s => s.trim()).filter(Boolean) : [];

    // Calculate date range based on duration
    const now = new Date();
    const endDate = new Date(now);
    endDate.setHours(23, 59, 59, 999);
    
    const startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);

    switch (duration) {
      case 'today':
        // Already set to today
        break;
      case 'week':
        startDate.setDate(now.getDate() - now.getDay()); // Start of week (Sunday)
        break;
      case 'month':
        startDate.setDate(1); // Start of current month
        break;
      case 'last_month':
        startDate.setMonth(now.getMonth() - 1);
        startDate.setDate(1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        endDate.setTime(lastMonthEnd.getTime());
        endDate.setHours(23, 59, 59, 999);
        break;
      case '3months':
        startDate.setMonth(now.getMonth() - 3);
        break;
      case '6months':
        startDate.setMonth(now.getMonth() - 6);
        break;
      case '12months':
        startDate.setMonth(now.getMonth() - 12);
        break;
      default:
        // Default to today
        break;
    }

    // Get owner's devices
    const Device = require('../models/device');
    const devices = await Device.find({ ownerId: userId }).select('device_id').lean();
    const ownedDeviceIds = devices.map(d => d.device_id);

    if (ownedDeviceIds.length === 0) {
      return res.json({
        summary: {
          totalEnergy: 0,
          baseRevenue: 0,
          gstAmount: 0,
          grossRevenue: 0,
          platformCommission: 0,
          pgCharges: 0,
          electricityCost: 0,
          netProfit: 0,
          sessionsCount: 0
        },
        chartData: []
      });
    }

    // Filter by selected devices if provided
    const targetDeviceIds = deviceIdArray.length > 0 
      ? ownedDeviceIds.filter(id => deviceIdArray.includes(id))
      : ownedDeviceIds;

    if (targetDeviceIds.length === 0) {
      return res.json({
        summary: {
          totalEnergy: 0,
          baseRevenue: 0,
          gstAmount: 0,
          grossRevenue: 0,
          platformCommission: 0,
          pgCharges: 0,
          electricityCost: 0,
          netProfit: 0,
          sessionsCount: 0
        },
        chartData: []
      });
    }

    // Fetch receipts
    const Receipt = require('../models/Receipt');
    const receipts = await Receipt.find({
      deviceId: { $in: targetDeviceIds },
      createdAt: { $gte: startDate, $lte: endDate }
    }).lean();

    // Calculate summary
    let totalEnergy = 0;
    let baseRevenue = 0;
    let gstAmount = 0;
    let grossRevenue = 0;
    let platformCommission = 0;
    let pgCharges = 0;
    let electricityCost = 0;
    let netProfit = 0;

    receipts.forEach(r => {
      totalEnergy += Number(r.energyConsumed || 0);
      baseRevenue += Number(r.taxableAmount || 0);
      gstAmount += Number(r.gstAmount || 0);
      grossRevenue += Number(r.totalAmount || 0);
      platformCommission += Number(r.vjraMarginAmount || 0);
      pgCharges += Number(r.paymentCharges || 0);
      electricityCost += Number(r.electricityCost || 0);
      netProfit += Number(r.ownerPayout || 0);
    });

    // Generate chart data based on duration
    let chartData = [];
    
    if (duration === 'today') {
      // Hourly data
      const hourlyData = {};
      for (let i = 0; i < 24; i++) {
        hourlyData[i] = { energy: 0, profit: 0 };
      }
      
      receipts.forEach(r => {
        const hour = new Date(r.createdAt).getHours();
        hourlyData[hour].energy += Number(r.energyConsumed || 0);
        hourlyData[hour].profit += Number(r.ownerPayout || 0);
      });
      
      chartData = Object.keys(hourlyData).map(hour => ({
        label: `${hour}:00`,
        energy: Number(hourlyData[hour].energy.toFixed(2)),
        profit: Number(hourlyData[hour].profit.toFixed(2))
      })).filter(d => d.energy > 0 || d.profit > 0);
      
    } else if (duration === 'week') {
      // Day-wise data for the week
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dailyData = {};
      
      for (let i = 0; i < 7; i++) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + i);
        const dayName = dayNames[date.getDay()];
        dailyData[dayName] = { energy: 0, profit: 0 };
      }
      
      receipts.forEach(r => {
        const dayName = dayNames[new Date(r.createdAt).getDay()];
        dailyData[dayName].energy += Number(r.energyConsumed || 0);
        dailyData[dayName].profit += Number(r.ownerPayout || 0);
      });
      
      chartData = Object.keys(dailyData).map(day => ({
        label: day,
        energy: Number(dailyData[day].energy.toFixed(2)),
        profit: Number(dailyData[day].profit.toFixed(2))
      }));
      
    } else if (duration === 'month' || duration === 'last_month') {
      // Date-wise data for the month
      const dailyData = {};
      const daysInMonth = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate();
      
      for (let i = 1; i <= daysInMonth; i++) {
        dailyData[i] = { energy: 0, profit: 0 };
      }
      
      receipts.forEach(r => {
        const day = new Date(r.createdAt).getDate();
        dailyData[day].energy += Number(r.energyConsumed || 0);
        dailyData[day].profit += Number(r.ownerPayout || 0);
      });
      
      chartData = Object.keys(dailyData).map(day => ({
        label: `${day}`,
        energy: Number(dailyData[day].energy.toFixed(2)),
        profit: Number(dailyData[day].profit.toFixed(2))
      })).filter(d => d.energy > 0 || d.profit > 0);
      
    } else if (duration === '3months' || duration === '6months' || duration === '12months') {
      // Month-wise data
      const monthlyData = {};
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      
      receipts.forEach(r => {
        const monthIndex = new Date(r.createdAt).getMonth();
        const year = new Date(r.createdAt).getFullYear();
        const monthKey = `${monthNames[monthIndex]} ${year}`;
        
        if (!monthlyData[monthKey]) {
          monthlyData[monthKey] = { energy: 0, profit: 0 };
        }
        
        monthlyData[monthKey].energy += Number(r.energyConsumed || 0);
        monthlyData[monthKey].profit += Number(r.ownerPayout || 0);
      });
      
      chartData = Object.keys(monthlyData).map(month => ({
        label: month,
        energy: Number(monthlyData[month].energy.toFixed(2)),
        profit: Number(monthlyData[month].profit.toFixed(2))
      }));
    }

    return res.json({
      summary: {
        totalEnergy: Number(totalEnergy.toFixed(2)),
        baseRevenue: Number(baseRevenue.toFixed(2)),
        gstAmount: Number(gstAmount.toFixed(2)),
        grossRevenue: Number(grossRevenue.toFixed(2)),
        platformCommission: Number(platformCommission.toFixed(2)),
        pgCharges: Number(pgCharges.toFixed(2)),
        electricityCost: Number(electricityCost.toFixed(2)),
        netProfit: Number(netProfit.toFixed(2)),
        sessionsCount: receipts.length
      },
      chartData
    });
  } catch (error) {
    console.error('Owner analytics error:', error);
    return res.status(500).json({ error: 'Server error' });
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
