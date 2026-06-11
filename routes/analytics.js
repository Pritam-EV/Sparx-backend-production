const express = require('express');
const router = express.Router();
const Session = require('../models/session');
const Device = require('../models/device');
const Receipt = require('../models/Receipt');
const WalletTransaction = require('../models/WalletTransaction');
const Wallet = require('../models/Wallet');
const Refund = require('../models/Refund');

// PG rate: 1.6% + 18% GST on 1.6% = 1.888%
const PG_RATE = 0.01888;

// ─── Period parser ────────────────────────────────────────────────────────────
function parsePeriod(period, customStart, customEnd) {
  const now = new Date();
  let start, end;
  switch (period) {
    case 'today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      end   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      break;
    case 'thisMonth':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end   = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      break;
    case 'lastMonth':
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end   = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'thisQuarter': {
      const q = Math.floor(now.getMonth() / 3);
      start = new Date(now.getFullYear(), q * 3, 1);
      end   = new Date(now.getFullYear(), q * 3 + 3, 1);
      break;
    }
    case 'thisYear':
      start = new Date(now.getFullYear(), 0, 1);
      end   = new Date(now.getFullYear() + 1, 0, 1);
      break;
    case 'custom':
      start = customStart ? new Date(customStart) : new Date(0);
      end   = customEnd   ? new Date(customEnd)   : new Date(8640000000000000);
      break;
    case 'all':
    default:
      start = new Date(0);
      end   = new Date(8640000000000000);
      break;
  }
  return { start, end };
}

// ─── GET /api/analytics/filters ──────────────────────────────────────────────
router.get('/filters', async (req, res) => {
  try {
    const [devices, projects, cities] = await Promise.all([
      Device.find({}, { _id: 1, device_id: 1, project: 1 }).lean(),
      Device.distinct('project'),
      Device.distinct('city'),
    ]);
    res.json({
      devices,
      projects: projects.filter(Boolean).sort(),
      cities:   cities.filter(Boolean).sort(),
    });
  } catch (err) {
    console.error('Analytics filters error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/analytics/summary ──────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const { period = 'all', project, city, customStart, customEnd } = req.query;
    const { start, end } = parsePeriod(period, customStart, customEnd);

    // 1. Resolve matching devices (apply project/city filter)
    const deviceFilter = {};
    if (project && project !== 'all') deviceFilter.project = project;
    if (city    && city    !== 'all') deviceFilter.city    = city;

    // Fetch with status field for device counts
    const allDevices = await Device.find(deviceFilter, { device_id: 1, status: 1 }).lean();
    const deviceIdStrings = allDevices.map(d => d.device_id);

    // ── Device status counts ─────────────────────────────────────────────────
    const devicesOccupied  = allDevices.filter(d => d.status === 'occupied').length;
    const devicesAvailable = allDevices.filter(d => d.status === 'available').length;
    const devicesOffline   = allDevices.filter(d => d.status === 'offline').length;
    const devicesTotal     = allDevices.length;

    if (deviceIdStrings.length === 0) {
      return res.json(emptyResponse(devicesTotal, devicesOccupied, devicesAvailable, devicesOffline));
    }

    // 2. All parallel DB queries
    const [
      allSessions,
      activeSessions,
      receipts,
      walletTopups,
      walletDebits,
      walletRefunds,
      refunds,
    ] = await Promise.all([

      // All sessions in period (counts + live energy + live amount used)
      Session.find({
        deviceId:  { $in: deviceIdStrings },
        startTime: { $gte: start, $lt: end },
      }, {
        status: 1, energyConsumed: 1, amountPaid: 1,
        amountUsed: 1, paymentGateway: 1, _id: 0,
      }).lean(),

      // Active wallet sessions — live snapshot for on-hold (NOT period scoped)
      Session.find({
        deviceId:       { $in: deviceIdStrings },
        status:         'active',
        paymentGateway: 'wallet',
      }, { amountPaid: 1, amountUsed: 1 }).lean(),

      // Completed receipts in period
      Receipt.find({
        deviceId:  { $in: deviceIdStrings },
        createdAt: { $gte: start, $lt: end },
      }, {
        paymentGateway: 1,
        amountPaid: 1,
        amountUtilized: 1,
        refundAmount: 1,
        energyConsumed: 1,
        vjraMarginAmount: 1,
        paymentCharges: 1,
        'refund.status': 1,
      }).lean(),

      // Wallet top-ups (Cashfree → wallet loads)
      WalletTransaction.find({
        type:      'topup',
        createdAt: { $gte: start, $lt: end },
      }, { amount: 1 }).lean(),

      // Wallet debits (sessions paid using wallet balance)
      WalletTransaction.find({
        type:      'debit',
        createdAt: { $gte: start, $lt: end },
      }, { amount: 1 }).lean(),

      // Wallet refunds (leftover credited back to wallet after session)
      WalletTransaction.find({
        type:      'refund',
        sessionId: { $exists: true },
        createdAt: { $gte: start, $lt: end },
      }, { amount: 1 }).lean(),

      // Bank refunds via Cashfree (destination: bank, status: SUCCESS)
      Refund.find({
        destination: 'bank',
        status:      'SUCCESS',
        createdAt:   { $gte: start, $lt: end },
      }, { refundAmount: 1 }).lean(),
    ]);

    // ── Live wallet balance (all users — live snapshot, NOT period scoped) ────
    const walletAgg = await Wallet.aggregate([
      { $group: { _id: null, total: { $sum: '$balance' } } },
    ]);
    const totalWalletLiveBalance = walletAgg[0]?.total || 0;

    // ── Session counts ───────────────────────────────────────────────────────
    const liveSessions  = allSessions.filter(s => s.status === 'active').length;
    const pastSessions  = allSessions.filter(s => s.status === 'completed' || s.status === 'faulty').length;
    const totalSessions = allSessions.length;

    // ── Live energy (from active sessions) ───────────────────────────────────
    const liveEnergyKwh = allSessions
      .filter(s => s.status === 'active')
      .reduce((sum, s) => sum + (s.energyConsumed || 0), 0);

    // ── Total energy (from completed receipts) ───────────────────────────────
    const totalEnergyKwh = receipts.reduce((sum, r) => sum + (r.energyConsumed || 0), 0);

    // ── Live amount being consumed right now ─────────────────────────────────
    const liveSessionAmountUsed = allSessions
      .filter(s => s.status === 'active')
      .reduce((sum, s) => sum + (s.amountUsed || 0), 0);

    // ── Finance: separate wallet vs cashfree receipts ────────────────────────
    const walletReceipts   = receipts.filter(r => r.paymentGateway === 'wallet');
    const cashfreeReceipts = receipts.filter(r => r.paymentGateway === 'cashfree');

    // Wallet session payments (via wallet balance)
    const walletSessionPaid  = walletReceipts.reduce((s, r)  => s + (r.amountPaid || 0), 0);

    // Direct Cashfree session payments
    const directCashfreePaid = cashfreeReceipts.reduce((s, r) => s + (r.amountPaid || 0), 0);

    // ── Wallet section ───────────────────────────────────────────────────────
    const walletTopupTotal  = walletTopups.reduce((s, t) => s + (t.amount || 0), 0);
    const walletDebitTotal  = walletDebits.reduce((s, t) => s + (t.amount || 0), 0);
    const walletRefundTotal = walletRefunds.reduce((s, r) => s + (r.amount || 0), 0);

    // On hold = reserved (amountPaid) minus already consumed (amountUsed) per active wallet session
    const walletOnHold = activeSessions.reduce((sum, s) => {
      return sum + Math.max(0, (s.amountPaid || 0) - (s.amountUsed || 0));
    }, 0);

    // ── Cashfree section ─────────────────────────────────────────────────────
    const cashfreeGrossTotal       = walletTopupTotal + directCashfreePaid;
    const directSessionRefundTotal = refunds.reduce((s, r) => s + (r.refundAmount || 0), 0);
    const pgCharges                = parseFloat((cashfreeGrossTotal * PG_RATE).toFixed(2));
    const cashfreeNetSettlement    = parseFloat(
      (cashfreeGrossTotal - directSessionRefundTotal - pgCharges).toFixed(2)
    );
    const platformMargin           = receipts.reduce((s, r) => s + (r.vjraMarginAmount || 0), 0);

    // ── Session amount utilized (from receipts) ──────────────────────────────
    const sessionPaidAmount = receipts.reduce((s, r) => s + (r.amountUtilized || 0), 0);

    res.json({
      devices: {
        total:     devicesTotal,
        occupied:  devicesOccupied,
        available: devicesAvailable,
        offline:   devicesOffline,
      },
      sessions: {
        live:           liveSessions,
        past:           pastSessions,
        total:          totalSessions,
        amountUtilized: parseFloat(sessionPaidAmount.toFixed(2)),
        liveAmountUsed: parseFloat(liveSessionAmountUsed.toFixed(2)),
      },
      energy: {
        liveKwh:  parseFloat(liveEnergyKwh.toFixed(3)),
        totalKwh: parseFloat(totalEnergyKwh.toFixed(3)),
      },
      wallet: {
        totalLoaded:   parseFloat(walletTopupTotal.toFixed(2)),
        totalDebited:  parseFloat(walletDebitTotal.toFixed(2)),
        totalRefunded: parseFloat(walletRefundTotal.toFixed(2)),
        liveBalance:   parseFloat(totalWalletLiveBalance.toFixed(2)),
        onHold:        parseFloat(walletOnHold.toFixed(2)),
      },
      cashfree: {
        grossTotal:            parseFloat(cashfreeGrossTotal.toFixed(2)),
        walletTopupCollection: parseFloat(walletTopupTotal.toFixed(2)),
        directSessionPayments: parseFloat(directCashfreePaid.toFixed(2)),
        refunds:               parseFloat(directSessionRefundTotal.toFixed(2)),
        pgCharges:             pgCharges,
        pgRatePercent:         parseFloat((PG_RATE * 100).toFixed(3)),
        netSettlement:         cashfreeNetSettlement,
        platformMargin:        parseFloat(platformMargin.toFixed(2)),
        walletSessionPaid:     parseFloat(walletSessionPaid.toFixed(2)),
      },
    });

  } catch (err) {
    console.error('Analytics summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

function emptyResponse(total = 0, occupied = 0, available = 0, offline = 0) {
  return {
    devices:  { total, occupied, available, offline },
    sessions: { live: 0, past: 0, total: 0, amountUtilized: 0, liveAmountUsed: 0 },
    energy:   { liveKwh: 0, totalKwh: 0 },
    wallet:   { totalLoaded: 0, totalDebited: 0, totalRefunded: 0, liveBalance: 0, onHold: 0 },
    cashfree: {
      grossTotal: 0, walletTopupCollection: 0, directSessionPayments: 0,
      refunds: 0, pgCharges: 0, pgRatePercent: 1.888,
      netSettlement: 0, platformMargin: 0, walletSessionPaid: 0,
    },
  };
}

// ─── GET /api/analytics/sessions (unchanged — kept for backward compat) ───────
router.get('/sessions', async (req, res) => {
  try {
    const { period = 'all', deviceIds, area, city, state, chargerType } = req.query;
    const { start, end } = parsePeriod(period);

    let deviceFilter = {};
    if (deviceIds) {
      const ids = deviceIds.split(',').filter(Boolean);
      if (ids.length) deviceFilter._id = { $in: ids };
    }
    if (area        && area        !== 'all') deviceFilter.area         = area;
    if (city        && city        !== 'all') deviceFilter.city         = city;
    if (state       && state       !== 'all') deviceFilter.state        = state;
    if (chargerType && chargerType !== 'all') deviceFilter.charger_type = chargerType;

    const devices = await Device.find(deviceFilter).lean();
    if (!devices.length) return res.json({ table: [], stats: [] });

    const deviceIdStrings = devices.map(d => d.device_id);
    const sessions = await Session.find({
      deviceId:  { $in: deviceIdStrings },
      startTime: { $gte: start, $lt: end },
    }).populate('userId').lean();

    const deviceStats = {};
    sessions.forEach(s => {
      const id = s.deviceId || 'Unknown';
      if (!deviceStats[id]) {
        deviceStats[id] = {
          deviceId: id, amountPaid: 0, amountUtilized: 0,
          energySelected: 0, energyConsumed: 0, sessionCount: 0, duration: 0,
        };
      }
      deviceStats[id].amountPaid     += s.amountPaid       || 0;
      deviceStats[id].amountUtilized += s.amountUsed       || 0;
      deviceStats[id].energySelected += s.energySelected   || 0;
      deviceStats[id].energyConsumed += s.energyConsumed   || 0;
      deviceStats[id].sessionCount   += 1;
      if (s.startTime && s.endTime) {
        const diff = (new Date(s.endTime) - new Date(s.startTime)) / 60000;
        if (diff > 0 && diff < 1440) deviceStats[id].duration += diff;
      }
    });

    res.json({
      table: sessions.map(s => ({
        date:             s.startTime,
        transactionId:    s.transactionId || s._id?.toString(),
        userId:           s.userId?._id?.toString() || '',
        deviceId:         s.deviceId || '',
        status:           s.status || '',
        amountPaid:       s.amountPaid || 0,
        amountUtilized:   s.amountUsed || 0,
        energySelected:   s.energySelected || 0,
        energyConsumed:   s.energyConsumed || 0,
        chargingDuration: (s.startTime && s.endTime)
          ? ((new Date(s.endTime) - new Date(s.startTime)) / 60000).toFixed(1)
          : '',
      })),
      stats: Object.values(deviceStats),
    });
  } catch (err) {
    console.error('Session Analytics Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;