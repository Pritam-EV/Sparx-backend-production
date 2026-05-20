// backfill-cashfree-refunds.js — run once: node backfill-cashfree-refunds.js
require('dotenv').config();
const mongoose = require('mongoose');
const Receipt  = require('./models/Receipt');
const Refund   = require('./models/Refund');
const Session  = require('./models/session');

function rand(len = 8) {
  const crypto = require('crypto');
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len).toUpperCase();
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  // Find all receipts where:
  // 1. refund.status = "initiated"  ← Cashfree session-end refunds
  // 2. refundAmount > 0             ← actual money to refund
  // 3. NOT wallet_refunded          ← exclude wallet refunds (already backfilled)
  const receipts = await Receipt.find({
    'refund.status': 'initiated',
    refundAmount:    { $gt: 0 },
  }).lean();

  console.log(`Found ${receipts.length} Cashfree session-end refunds to backfill\n`);

  let created = 0, skipped = 0, failed = 0;

  for (const receipt of receipts) {
    const idempotencyKey = `refund_${receipt.sessionId}`;

    // Skip if Refund doc already exists
    const exists = await Refund.findOne({ idempotencyKey });
    if (exists) {
      console.log(`  ⏭  Skipping — already exists: ${receipt.sessionId}`);
      skipped++;
      continue;
    }

    // Try to enrich with session data (for amountUtilized)
    const session = receipt.sessionId
      ? await Session.findOne({ sessionId: receipt.sessionId })
          .select('amountPaid amountUsed ratePerKwh energyConsumed userId')
          .lean()
      : null;

    const amountUtilized = receipt.amountUtilized
      || session?.amountUsed
      || (session ? Number((session.energyConsumed * session.ratePerKwh).toFixed(2)) : 0);

    try {
      await Refund.create({
        userId:         receipt.userId,
        orderId:        receipt.transactionId,
        sessionId:      receipt.sessionId,
        refundId:       receipt.refund?.refundId || `REF_CF_${rand(8)}`,
        cfRefundId:     receipt.refund?.cfRefundId || null,   // may be null if never sent to Cashfree
        refundAmount:   receipt.refundAmount,
        refundType:     'PARTIAL',
        destination:    'bank',
        status:         'INITIATED',    // hasn't been sent to Cashfree yet
        refundNote:     `Backfilled — auto-refund for unused energy, session ${receipt.sessionId}`,
        initiatedBy:    'system',
        initiatedAt:    receipt.createdAt,
        processedAt:    null,           // not processed yet
        idempotencyKey,
        amountPaid:     receipt.amountPaid     || 0,
        amountUtilized: amountUtilized          || 0,
        gateway:        'cashfree',
      });

      console.log(`  ✅ Created — session: ${receipt.sessionId} | refund: ₹${receipt.refundAmount}`);
      created++;
    } catch (e) {
      console.error(`  ❌ Failed — session: ${receipt.sessionId} | error: ${e.message}`);
      failed++;
    }
  }

  // ── Final summary ────────────────────────────────────────────────────────────
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Backfill complete
  ✅ Created : ${created}
  ⏭  Skipped : ${skipped}
  ❌ Failed  : ${failed}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);

  // ── Sanity check: show total INITIATED refunds now in Refund collection ──────
  const totalInitiated = await Refund.countDocuments({
    destination: 'bank',
    status:      'INITIATED',
  });
  console.log(`📋 Total INITIATED bank refunds now in Refund collection: ${totalInitiated}`);
  console.log(`   → These need admin action to send to Cashfree.\n`);

  await mongoose.disconnect();
}

run().catch(console.error);