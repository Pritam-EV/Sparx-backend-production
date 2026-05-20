// backfill-refunds.js — run once: node backfill-refunds.js
require('dotenv').config();
const mongoose = require('mongoose');
const WalletTransaction = require('./models/WalletTransaction');
const Refund = require('./models/Refund');
const Receipt = require('./models/Receipt');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected');

  const walletRefunds = await WalletTransaction.find({ type: 'refund' }).lean();
  console.log(`Found ${walletRefunds.length} wallet refunds to backfill`);

  let created = 0, skipped = 0, failed = 0;

  for (const wt of walletRefunds) {
    const key = wt.idempotencyKey || `refund_${wt.sessionId}`;

    // Skip if already exists
    const exists = await Refund.findOne({ idempotencyKey: key });
    if (exists) { skipped++; continue; }

    // Try to get amountPaid from Receipt
    const receipt = wt.sessionId
      ? await Receipt.findOne({ sessionId: wt.sessionId }).select('amountPaid amountUtilized').lean()
      : null;

    try {
      await Refund.create({
        userId:         wt.userId,
        orderId:        wt.orderId || null,
        sessionId:      wt.sessionId || null,
        refundId:       `REF_BACKFILL_${wt._id.toString().slice(-8).toUpperCase()}`,
        refundAmount:   wt.amount,
        refundType:     'PARTIAL',
        destination:    'wallet',
        status:         'SUCCESS',
        refundNote:     wt.description || 'Backfilled wallet refund',
        initiatedBy:    wt.initiatedBy || 'system',
        initiatedAt:    wt.createdAt,
        processedAt:    wt.createdAt,
        idempotencyKey: key,
        amountPaid:     receipt?.amountPaid     || 0,
        amountUtilized: receipt?.amountUtilized || 0,
        gateway:        'wallet',
        createdAt:      wt.createdAt,
      });
      created++;
    } catch (e) {
      console.error(`Failed for WalletTransaction ${wt._id}:`, e.message);
      failed++;
    }
  }

  console.log(`\n✅ Done — Created: ${created} | Skipped: ${skipped} | Failed: ${failed}`);
  await mongoose.disconnect();
}

run().catch(console.error);