const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/roleMiddleware');
const Receipt = require('../models/Receipt');
const Device = require('../models/device');
const User = require('../models/User'); // 🔥 ADD THIS
const {
  getOwnedDeviceIds,
  escapeRegex,
} = require("../utils/ownerScope");

// GET /api/receipts/all
// Admin and owner receipt listing.
// Owner filters are always intersected with the authenticated owner's devices.
router.get("/all", auth, async (req, res) => {
  try {
    const {
      search = "",
      deviceId,
      userId: requestedUserId,
      deviceIds,
      from,
      to,
      page = 1,
      limit = 100,
    } = req.query;

    if (!["admin", "owner"].includes(req.user?.role)) {
      return res.status(403).json({
        error: "Access denied.",
      });
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.max(
      1,
      Math.min(100, parseInt(limit, 10) || 100)
    );
    const skip = (pageNum - 1) * lim;

    const requestedDeviceIds = [
      ...(Array.isArray(deviceIds)
        ? deviceIds
        : typeof deviceIds === "string"
        ? deviceIds.split(",")
        : []),

      ...(deviceId ? [String(deviceId)] : []),
    ]
      .map((value) => String(value).trim())
      .filter(Boolean);

    const match = {};

    if (req.user.role === "owner") {
      // Never use a client-supplied owner ID for data access.
      const ownedDeviceIds = await getOwnedDeviceIds(
        req.user.userId
      );

      const allowedDeviceIds = requestedDeviceIds.length
        ? ownedDeviceIds.filter((id) =>
            requestedDeviceIds.includes(id)
          )
        : ownedDeviceIds;

      match.deviceId = {
        $in: allowedDeviceIds.length
          ? allowedDeviceIds
          : ["__no_owned_devices__"],
      };
    } else {
      // Admins may filter across the wider network.
      if (deviceId) {
        match.deviceId = String(deviceId);
      } else if (requestedDeviceIds.length) {
        match.deviceId = {
          $in: requestedDeviceIds,
        };
      }
    }

    if (requestedUserId) {
      match.userId = requestedUserId;
    }

    if (from || to) {
      match.createdAt = {};

      if (from) {
        const fromDate = new Date(from);

        if (Number.isNaN(fromDate.getTime())) {
          return res.status(400).json({
            error: "Invalid from date.",
          });
        }

        match.createdAt.$gte = fromDate;
      }

      if (to) {
        const toDate = new Date(to);

        if (Number.isNaN(toDate.getTime())) {
          return res.status(400).json({
            error: "Invalid to date.",
          });
        }

        match.createdAt.$lte = toDate;
      }
    }

    if (search.trim()) {
      const safeSearch = new RegExp(
        escapeRegex(search.trim()),
        "i"
      );

      match.$or = [
        { receiptId: safeSearch },
        { deviceId: safeSearch },
        { sessionId: safeSearch },
        { transactionId: safeSearch },
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
              },
            },
          ],

          totals: [
            {
              $group: {
                _id: null,

                totalReceipts: { $sum: 1 },

                totalAmountPaid: {
                  $sum: { $ifNull: ["$amountPaid", 0] },
                },

                totalAmountUtilized: {
                  $sum: { $ifNull: ["$amountUtilized", 0] },
                },

                totalAmountSelected: {
                  $sum: { $ifNull: ["$amountSelected", 0] },
                },

                totalDiscountApplied: {
                  $sum: { $ifNull: ["$discountApplied", 0] },
                },

                // refundAmount is numeric; refund is a nested object.
                totalRefunds: {
                  $sum: { $ifNull: ["$refundAmount", 0] },
                },

                totalEnergySelected: {
                  $sum: { $ifNull: ["$energySelected", 0] },
                },

                totalEnergyConsumed: {
                  $sum: { $ifNull: ["$energyConsumed", 0] },
                },
              },
            },
          ],

          count: [{ $count: "total" }],
        },
      },
    ];

    const result = await Receipt.aggregate(pipeline);
    const facet = result?.[0] || {};

    const receipts = facet.list || [];
    const total = facet.count?.[0]?.total || 0;

    const totals = facet.totals?.[0] || {
      totalReceipts: 0,
      totalAmountPaid: 0,
      totalAmountUtilized: 0,
      totalAmountSelected: 0,
      totalDiscountApplied: 0,
      totalRefunds: 0,
      totalEnergySelected: 0,
      totalEnergyConsumed: 0,
    };

    return res.status(200).json({
      page: pageNum,
      limit: lim,
      total,

      totals: {
        totalReceipts: totals.totalReceipts,
        totalAmountPaid: totals.totalAmountPaid,
        totalAmountUtilized: totals.totalAmountUtilized,
        totalAmountSelected: totals.totalAmountSelected,
        totalDiscountApplied: totals.totalDiscountApplied,
        totalRefunds: totals.totalRefunds,
        totalEnergySelected: totals.totalEnergySelected,
        totalEnergyConsumed: totals.totalEnergyConsumed,
      },

      receipts,
    });
  } catch (error) {
    console.error("Error fetching receipts:", error);

    return res.status(500).json({
      error: "Could not fetch receipts.",
    });
  }
});

// ✅ NEW: GET /api/receipts/owner/analytics
// routes/receipts.js

router.get(
  "/owner/analytics",
  auth,
  authorizeRoles("owner"),
  async (req, res) => {
    try {
      // Always derive owner identity from the verified JWT.
      // Ignore any userId supplied through req.query.
      const userId = req.user.userId;
      const { duration, deviceIds } = req.query;

      if (!userId) {
        return res.status(401).json({
          error: "Owner authentication is required.",
        });
      }

      const deviceIdArray = deviceIds
        ? String(deviceIds)
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean)
        : [];

      // Keep the existing date-range, aggregation and response logic below.
      // The owned-device lookup below must continue to use this token-derived
      // userId, and deviceIdArray must only narrow the owner's device scope.
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
const matchStage = {
  deviceId: { $in: targetDeviceIds },
  createdAt: { $gte: startDate, $lte: endDate }
};

// 🔥 AGGREGATION
const [summaryResult] = await Receipt.aggregate([
  { $match: matchStage },
  {
    $group: {
      _id: null,
      totalEnergy: { $sum: { $ifNull: ["$energyConsumed", 0] } },
      baseRevenue: { $sum: { $ifNull: ["$taxableAmount", 0] } },
      gstAmount: { $sum: { $ifNull: ["$gstAmount", 0] } },
      grossRevenue: { $sum: { $ifNull: ["$totalAmount", 0] } },
      platformCommission: { $sum: { $ifNull: ["$vjraMarginAmount", 0] } },
      pgCharges: { $sum: { $ifNull: ["$paymentCharges", 0] } },
      electricityCost: { $sum: { $ifNull: ["$electricityCost", 0] } },
      netProfit: { $sum: { $ifNull: ["$ownerPayout", 0] } },
      totalRefund: { $sum: { $ifNull: ["$refundAmount", 0] } },
      sessions: { $addToSet: "$sessionId" }
    }
  }
]);
const receipts = await Receipt.find(matchStage).lean();
const summary = summaryResult || {
  totalEnergy: 0,
  baseRevenue: 0,
  gstAmount: 0,
  grossRevenue: 0,
  platformCommission: 0,
  pgCharges: 0,
  electricityCost: 0,
  netProfit: 0,
  totalRefund: 0,
  sessions: []
};
// 🔥 STEP 2.1: Collect unique userIds

const sessionsCount = summary.sessions?.length || 0;

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
    totalEnergy: Number(summary.totalEnergy.toFixed(2)),
    baseRevenue: Number(summary.baseRevenue.toFixed(2)),
    gstAmount: Number(summary.gstAmount.toFixed(2)),
    grossRevenue: Number(summary.grossRevenue.toFixed(2)),
    platformCommission: Number(summary.platformCommission.toFixed(2)),
    pgCharges: Number(summary.pgCharges.toFixed(2)),
    electricityCost: Number(summary.electricityCost.toFixed(2)),
    netProfit: Number(summary.netProfit.toFixed(2)),
    sessionsCount
  },
  chartData
});
  } catch (error) {
    console.error('Owner analytics error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/receipts/admin/filters
// Returns distinct state/city/area values from Receipt collection
// GET /api/receipts/admin/filters
router.get("/admin/filters", auth, authorizeRoles("admin"), async (req, res) => {
  try {
    // Get all distinct deviceIds from receipts, then look up their projects
    const deviceIds = await Receipt.distinct("deviceId");
    const devices   = await Device.find(
      { device_id: { $in: deviceIds }, project: { $exists: true, $ne: "" } },
      { project: 1 }
    ).lean();

    const projects = [...new Set(devices.map(d => d.project).filter(Boolean))].sort();
    res.json({ projects });
  } catch (err) {
    console.error("Filters fetch error:", err);
    res.status(500).json({ error: "Could not fetch filters" });
  }
});



// GET /api/receipts/admin/financial
// GET /api/receipts/admin/financial
router.get("/admin/financial", auth, authorizeRoles("admin"), async (req, res) => {
  try {
    const {
      period = "today",
      project,          // ← new
      refundStatus,
      ownerId,
      deviceId,
      page  = 1,
      limit = 50
    } = req.query;

    const dayjs  = require("dayjs");
    const now    = dayjs();
    let startDate, endDate;

    switch (period) {
      case "week":       startDate = now.startOf("week");                          endDate = now.endOf("week");        break;
      case "month":      startDate = now.startOf("month");                         endDate = now.endOf("month");       break;
      case "last_month": startDate = now.subtract(1,"month").startOf("month");     endDate = now.subtract(1,"month").endOf("month"); break;
      case "quarter":    startDate = now.startOf("quarter");                       endDate = now.endOf("quarter");     break;
      case "year":       startDate = now.startOf("year");                          endDate = now.endOf("year");        break;
      default:           startDate = now.startOf("day");                           endDate = now.endOf("day");
    }

    const pageNum = parseInt(page)  || 1;
    const lim     = parseInt(limit) || 50;
    const skip    = (pageNum - 1) * lim;

    // ── If project filter, resolve to deviceIds first ──────────────────────
    let projectDeviceIds = null;
    if (project) {
      const projectDevices = await Device.find(
        { project },
        { device_id: 1 }
      ).lean();
      projectDeviceIds = projectDevices.map(d => d.device_id);
      // If no devices belong to this project, return empty immediately
      if (!projectDeviceIds.length) {
        return res.json({
          summary: {}, receipts: [], total: 0, page: pageNum,
          range: {
            start: startDate.toDate(), end: endDate.toDate(),
            label: `${startDate.format("DD MMM YYYY")} - ${endDate.format("DD MMM YYYY")}`
          }
        });
      }
    }

    // ── Build match ────────────────────────────────────────────────────────
    const match = {
      createdAt: { $gte: startDate.toDate(), $lte: endDate.toDate() }
    };
    if (projectDeviceIds) match.deviceId = { $in: projectDeviceIds };
    if (ownerId)          match.ownerId  = ownerId;
    if (deviceId)         match.deviceId = deviceId;
    if (refundStatus)     match["refund.status"] = refundStatus;

    // ── Aggregate ──────────────────────────────────────────────────────────
    const pipeline = [
      { $match: match },
      {
        $facet: {
          summary: [{
            $group: {
              _id: null,
              totalReceipts:    { $sum: 1 },
              totalRevenue:     { $sum: { $ifNull: ["$amountPaid",        0] } },
              totalPGCharges:   { $sum: { $ifNull: ["$paymentCharges",    0] } },
              totalRefund:      { $sum: { $ifNull: ["$refundAmount",      0] } },
              totalDiscount:    { $sum: { $ifNull: ["$discountApplied",   0] } },
              taxableRevenue:   { $sum: { $ifNull: ["$taxableAmount",     0] } },
              gstCollected:     { $sum: { $ifNull: ["$gstAmount",         0] } },
              totalEnergy:      { $sum: { $ifNull: ["$energyConsumed",    0] } },
              totalMargin:      { $sum: { $ifNull: ["$vjraMarginAmount",  0] } },
              totalOwnerPayout: { $sum: { $ifNull: ["$ownerPayout",       0] } },
              totalElectricity: { $sum: { $ifNull: ["$electricityCost",   0] } },
            }
          }],
          receipts: [
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: lim }
          ],
          count: [{ $count: "total" }]
        }
      }
    ];

    const result = await Receipt.aggregate(pipeline);
    const data   = result[0];
    const receiptList = data.receipts || [];

    // ── Enrich with userName ───────────────────────────────────────────────
    const userIds = [...new Set(receiptList.map(r => r.userId).filter(Boolean).map(id => id.toString()))];
    const users   = await User.find({ _id: { $in: userIds } }, { name: 1 }).lean();
    const usersMap = {};
    users.forEach(u => { usersMap[u._id.toString()] = u; });

    // ── Enrich with projectName from device ────────────────────────────────
    const dIds      = [...new Set(receiptList.map(r => r.deviceId).filter(Boolean))];
    const devices   = await Device.find({ device_id: { $in: dIds } }, { device_id: 1, project: 1 }).lean();
    const deviceMap = {};
    devices.forEach(d => { deviceMap[d.device_id] = d; });

    const enrichedReceipts = receiptList.map(r => ({
      ...r,
      userName:    usersMap[r.userId?.toString()]?.name || "-",
      projectName: deviceMap[r.deviceId]?.project       || "-",
    }));

    res.json({
      summary:  data.summary[0] || {},
      receipts: enrichedReceipts,
      total:    data.count[0]?.total || 0,
      page:     pageNum,
      range: {
        start: startDate.toDate(),
        end:   endDate.toDate(),
        label: `${startDate.format("DD MMM YYYY, hh:mm A")} - ${endDate.format("DD MMM YYYY, hh:mm A")}`
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Financial fetch failed" });
  }
});

// PATCH /api/receipts/admin/refund/:receiptId
router.patch("/admin/refund/:receiptId", auth, authorizeRoles("admin"), async (req, res) => {
  try {
    const { receiptId } = req.params;
    const { status, refundId, failureReason } = req.body;

    const update = {
      "refund.status": status,
      "refund.refundId": refundId || null,
      "refund.failureReason": failureReason || null,
      "refund.processedAt": status === "processed" ? new Date() : null
    };

    const receipt = await Receipt.findOneAndUpdate(
      { receiptId },
      { $set: update },
      { new: true }
    );

    if (!receipt) return res.status(404).json({ error: "Receipt not found" });

    res.json({ message: "Refund updated", receipt });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Refund update failed" });
  }
});

// GET /api/receipts/admin/export
router.get("/admin/export", auth, authorizeRoles("admin"), async (req, res) => {
  try {
    const { period = "today", project } = req.query;
    const dayjs = require("dayjs");
    const now   = dayjs();
    let startDate = now.startOf("day"), endDate = now.endOf("day");

    switch (period) {
      case "week":       startDate = now.startOf("week");                      endDate = now.endOf("week");        break;
      case "month":      startDate = now.startOf("month");                     endDate = now.endOf("month");       break;
      case "last_month": startDate = now.subtract(1,"month").startOf("month"); endDate = now.subtract(1,"month").endOf("month"); break;
      case "quarter":    startDate = now.startOf("quarter");                   endDate = now.endOf("quarter");     break;
      case "year":       startDate = now.startOf("year");                      endDate = now.endOf("year");        break;
    }

    const exportMatch = {
      createdAt: { $gte: startDate.toDate(), $lte: endDate.toDate() }
    };

    // ── Project filter ─────────────────────────────────────────────────────
    if (project) {
      const projectDevices = await Device.find({ project }, { device_id: 1 }).lean();
      const ids = projectDevices.map(d => d.device_id);
      if (!ids.length) {
        res.header("Content-Type", "text/csv");
        res.attachment(`receipts_${period}.csv`);
        return res.send("No receipts found for this project");
      }
      exportMatch.deviceId = { $in: ids };
    }

    const receipts = await Receipt.find(exportMatch).lean();

    // ── Enrich projectName ─────────────────────────────────────────────────
    const dIds      = [...new Set(receipts.map(r => r.deviceId).filter(Boolean))];
    const devices   = await Device.find({ device_id: { $in: dIds } }, { device_id: 1, project: 1 }).lean();
    const deviceMap = {};
    devices.forEach(d => { deviceMap[d.device_id] = d; });

    const csvHeader = [
      "Receipt ID", "Date", "User", "Device ID", "Project",
      "Energy (kWh)", "Amount Paid", "GST",
      "Platform Margin", "Owner Payout", "Refund Amount"
    ];

    const rows = receipts.map(r => [
      r.receiptId                                          || "",
      r.createdAt ? new Date(r.createdAt).toISOString()   : "",
      r.userName                                           || "",
      r.deviceId                                           || "",
      deviceMap[r.deviceId]?.project                       || "",
      r.energyConsumed   ?? 0,
      r.amountPaid       ?? 0,
      r.gstAmount        ?? 0,
      r.vjraMarginAmount ?? 0,
      r.ownerPayout      ?? 0,
      r.refundAmount     ?? 0,
    ]);

    const csv = [csvHeader, ...rows].map(row => row.join(",")).join("\n");

    res.header("Content-Type", "text/csv");
    res.attachment(`receipts_${project ? project + "_" : ""}${period}.csv`);
    res.send(csv);

  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});




router.get("/:sessionId", auth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({
        error: "Unauthorized.",
      });
    }

    const receipt = await Receipt.findOne({
      sessionId,
      userId,
    })
      .select(
        "receiptId deviceId amountPaid amountUtilized " +
        "discountApplied refundAmount userName userMobile userGstin " +
        "createdAt energyConsumed userRatePerKwh gstAmount " +
        "taxableAmount totalAmount rating suggestion -_id"
      )
      .lean();

    if (!receipt) {
      return res.status(404).json({
        error: "Receipt not found.",
      });
    }

    // Explicit allowlist of customer-facing receipt data.
    return res.status(200).json({
      receiptId: receipt.receiptId,
      deviceId: receipt.deviceId,

      userName: receipt.userName || "",
      userMobile: receipt.userMobile || "",
      userGstin: receipt.userGstin || "",

      createdAt: receipt.createdAt || null,

      energyConsumed: receipt.energyConsumed ?? 0,
      userRatePerKwh: receipt.userRatePerKwh ?? 0,

      taxableAmount: receipt.taxableAmount ?? 0,
      gstAmount: receipt.gstAmount ?? 0,
      totalAmount: receipt.totalAmount ?? 0,

      amountPaid: receipt.amountPaid ?? 0,
      amountUtilized: receipt.amountUtilized ?? 0,
      discountApplied: receipt.discountApplied ?? 0,
      refundAmount: receipt.refundAmount ?? 0,

      rating: receipt.rating ?? null,
      suggestion: receipt.suggestion || "",
    });
  } catch (err) {
    console.error("Customer receipt fetch error:", err);

    return res.status(500).json({
      error: "Failed to fetch receipt.",
    });
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
