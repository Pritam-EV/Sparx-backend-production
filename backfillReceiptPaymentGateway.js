/**
 * scripts/backfillReceiptPaymentGateway.js
 *
 * ONE-TIME migration script.
 * Fills Receipt.paymentGateway from the related Session.paymentGateway
 * for all existing receipts that are missing it (or defaulted to "cashfree").
 *
 * Run ONCE from your backend root:
 *   node scripts/backfillReceiptPaymentGateway.js
 *
 * Safe to re-run — uses updateOne so already-correct records are untouched.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Receipt  = require("./models/Receipt");
const Session  = require("./models/session");

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");

  // Fetch every receipt that doesn't have paymentGateway set yet
  // (or was defaulted to cashfree — we re-check from Session to be safe)
  const receipts = await Receipt.find({}).select("_id sessionId paymentGateway").lean();
  console.log(`📦 Total receipts to process: ${receipts.length}`);

  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  for (const receipt of receipts) {
    if (!receipt.sessionId) {
      skipped++;
      continue;
    }

    const session = await Session.findOne({ sessionId: receipt.sessionId })
      .select("paymentGateway")
      .lean();

    if (!session) {
      notFound++;
      continue;
    }

    // Only update if different (avoid unnecessary writes)
    if (receipt.paymentGateway === session.paymentGateway) {
      skipped++;
      continue;
    }

    await Receipt.updateOne(
      { _id: receipt._id },
      { $set: { paymentGateway: session.paymentGateway || "cashfree" } }
    );
    updated++;

    if (updated % 100 === 0) console.log(`  → Updated ${updated} so far...`);
  }

  console.log("\n─────────────────────────────────────");
  console.log(`✅ Updated  : ${updated}`);
  console.log(`⏭  Skipped  : ${skipped} (already correct or no sessionId)`);
  console.log(`⚠️  Not found: ${notFound} (session missing for these receipts)`);
  console.log("─────────────────────────────────────");
  console.log("🎉 Backfill complete.");

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error("❌ Backfill failed:", err);
  process.exit(1);
});