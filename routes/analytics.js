const express = require('express');
const router = express.Router();
const Session = require('../models/session');
const Device = require('../models/device');
const Receipt = require('../models/Receipt');
const WalletTransaction = require('../models/WalletTransaction');
const Refund = require('../models/Refund');

// PG rate: 1.6% + 18% GST on 1.6% = 1.6 * 1.18 = 1.888%
const PG_RATE = 0.01888;

// ─── Period parser ────────────────────────────────────────────────────────────
function parsePeriod(period) {
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
    const { period = 'all', project, city } = req.query;
    const { start, end } = parsePeriod(period);

    // 1. Resolve matching device_id strings
    const deviceFilter = {};
    if (project && project !== 'all') deviceFilter.project = project;
    if (city    && city    !== 'all') deviceFilter.city    = city;

    const devices = await Device.find(deviceFilter, { device_id: 1 }).lean();
    const deviceIdStrings = devices.map(d => d.device_id);

    if (deviceIdStrings.length === 0) {
      return res.json(emptyResponse());
    }

    // 2. Sessions (for sessions counts + live energy)
    const [allSessions, receipts, walletTopups, walletRefunds, refunds] = await Promise.all([
      Session.find({
        deviceId: { $in: deviceIdStrings },
        startTime: { $gte: start, $lt: end },
      }, {
        status: 1, energyConsumed: 1, amountPaid: 1, paymentGateway: 1, _id: 0
      }).lean(),

      // Receipts scoped to these devices in period (completed sessions)
      Receipt.find({
        deviceId: { $in: deviceIdStrings },
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
        type: 'topup',
        createdAt: { $gte: start, $lt: end },
      }, { amount: 1 }).lean(),

      // Wallet refunds (leftover credited back to wallet after session)
      WalletTransaction.find({
        type: 'refund',
        sessionId: { $exists: true },
        createdAt: { $gte: start, $lt: end },
      }, { amount: 1 }).lean(),

      // Bank refunds via Cashfree (destination: bank, status: SUCCESS)
      Refund.find({
        destination: 'bank',
        status: 'SUCCESS',
        createdAt: { $gte: start, $lt: end },
      }, { refundAmount: 1 }).lean(),
    ]);

    // ── Session counts ───────────────────────────────────────────────────────
    const liveSessions  = allSessions.filter(s => s.status === 'active').length;
    const totalSessions = allSessions.length;

    // ── Live energy (from active sessions) ──────────────────────────────────
    const liveEnergyKwh = allSessions
      .filter(s => s.status === 'active')
      .reduce((sum, s) => sum + (s.energyConsumed || 0), 0);

    // ── Total energy (from completed receipts) ───────────────────────────────
    const totalEnergyKwh = receipts.reduce((sum, r) => sum + (r.energyConsumed || 0), 0);

    // ── Finance: separate wallet-paid vs cashfree-paid receipts ─────────────
    const walletReceipts    = receipts.filter(r => r.paymentGateway === 'wallet');
    const cashfreeReceipts  = receipts.filter(r => r.paymentGateway === 'cashfree');

    // Wallet debit total (session amount paid via wallet balance)
    const walletSessionPaid = walletReceipts.reduce((s, r) => s + (r.amountPaid || 0), 0);

    // Direct cashfree session payments
    const directCashfreePaid = cashfreeReceipts.reduce((s, r) => s + (r.amountPaid || 0), 0);

    // Wallet top-ups (total Cashfree collections for wallet loads)
    const walletTopupTotal = walletTopups.reduce((s, t) => s + (t.amount || 0), 0);

    // Total Cashfree gross collection = wallet topups + direct cashfree session payments
    const cashfreeGrossTotal = walletTopupTotal + directCashfreePaid;

    // Wallet refunds (leftover back to wallet — NOT bank, internal)
    const walletRefundTotal = walletRefunds.reduce((s, r) => s + (r.amount || 0), 0);

    // Direct session payment refunds (Cashfree bank refunds on direct session payments)
    const directSessionRefundTotal = refunds.reduce((s, r) => s + (r.refundAmount || 0), 0);

    // PG charges on gross Cashfree collection
    const pgCharges = parseFloat((cashfreeGrossTotal * PG_RATE).toFixed(2));

    // Net Cashfree settlement = gross − wallet refunds − direct refunds − PG charges
    // Note: wallet refunds are internal (stay in platform), NOT deducted from Cashfree settlement
    // Only bank refunds and PG charges reduce Cashfree settlement
    const cashfreeNetSettlement = parseFloat(
      (cashfreeGrossTotal - directSessionRefundTotal - pgCharges).toFixed(2)
    );

    // Platform margin (vjraMarginAmount summed across all receipts)
    const platformMargin = receipts.reduce((s, r) => s + (r.vjraMarginAmount || 0), 0);

    // Session paid amounts (amountUtilized across all sessions via receipts)
    const sessionPaidAmount = receipts.reduce((s, r) => s + (r.amountUtilized || 0), 0);

    // Session paid amount refunds = wallet refunds + bank refunds
    const sessionPaidRefunds = walletRefundTotal + directSessionRefundTotal;

    res.json({
      sessions: {
        live:  liveSessions,
        total: totalSessions,
      },
      energy: {
        liveKwh:  parseFloat(liveEnergyKwh.toFixed(3)),
        totalKwh: parseFloat(totalEnergyKwh.toFixed(3)),
      },
      finance: {
        // Cashfree gross collections
        cashfreeGrossTotal:        parseFloat(cashfreeGrossTotal.toFixed(2)),
        // How it was split
        walletTopupTotal:          parseFloat(walletTopupTotal.toFixed(2)),
        directCashfreePaid:        parseFloat(directCashfreePaid.toFixed(2)),
        // Refunds
        walletRefunds:             parseFloat(walletRefundTotal.toFixed(2)),
        directSessionRefunds:      parseFloat(directSessionRefundTotal.toFixed(2)),
        // PG
        pgCharges:                 pgCharges,
        pgRatePercent:             parseFloat((PG_RATE * 100).toFixed(3)),
        // Settlement
        cashfreeNetSettlement:     cashfreeNetSettlement,
        // Session amounts
        sessionPaidAmount:         parseFloat(sessionPaidAmount.toFixed(2)),
        sessionPaidRefunds:        parseFloat(sessionPaidRefunds.toFixed(2)),
        // Platform
        platformMargin:            parseFloat(platformMargin.toFixed(2)),
        // Wallet session payments (via wallet balance, not new Cashfree collection)
        walletSessionPaid:         parseFloat(walletSessionPaid.toFixed(2)),
      },
    });

  } catch (err) {
    console.error('Analytics summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

function emptyResponse() {
  return {
    sessions: { live: 0, total: 0 },
    energy:   { liveKwh: 0, totalKwh: 0 },
    finance: {
      cashfreeGrossTotal: 0, walletTopupTotal: 0, directCashfreePaid: 0,
      walletRefunds: 0, directSessionRefunds: 0, pgCharges: 0,
      pgRatePercent: 1.888, cashfreeNetSettlement: 0,
      sessionPaidAmount: 0, sessionPaidRefunds: 0,
      platformMargin: 0, walletSessionPaid: 0,
    },
  };
}

// ─── GET /api/analytics/filters (keep existing sessions route intact) ─────────
// GET /api/analytics/sessions (unchanged — kept for backward compat)
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
      deviceId: { $in: deviceIdStrings },
      startTime: { $gte: start, $lt: end },
    }).populate('userId').lean();

    const deviceStats = {};
    sessions.forEach(s => {
      const id = s.deviceId || 'Unknown';
      if (!deviceStats[id]) {
        deviceStats[id] = { deviceId: id, amountPaid: 0, amountUtilized: 0, energySelected: 0, energyConsumed: 0, sessionCount: 0, duration: 0 };
      }
      deviceStats[id].amountPaid      += s.amountPaid  || 0;
      deviceStats[id].amountUtilized  += s.amountUsed  || 0;
      deviceStats[id].energySelected  += s.energySelected || 0;
      deviceStats[id].energyConsumed  += s.energyConsumed || 0;
      deviceStats[id].sessionCount    += 1;
      if (s.startTime && s.endTime) {
        const diff = (new Date(s.endTime) - new Date(s.startTime)) / 60000;
        if (diff > 0 && diff < 1440) deviceStats[id].duration += diff;
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