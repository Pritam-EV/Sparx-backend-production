/**
 * scripts/backfillReceiptUserName.js
 *
 * ONE-TIME backfill: populates userName + device location fields
 * on all existing Receipt documents where userName is empty/missing.
 *
 * Run from project root:
 *   node scripts/backfillReceiptUserName.js
 *
 * Safe to re-run — only touches receipts with blank userName.
 */

"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

const Receipt = require("./models/Receipt");
const User    = require("./models/User");
const Device  = require("./models/device");

async function run() {
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!MONGO_URI) {
    console.error("❌  MONGO_URI not found in .env — aborting.");
    process.exit(1);
  }

  console.log("🔌  Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI);
  console.log("✅  Connected.\n");

  // Find all receipts with missing/empty userName
  const receipts = await Receipt.find({
    $or: [
      { userName: { $exists: false } },
      { userName: "" },
      { userName: null },
    ],
  })
    .select("_id receiptId userId deviceId userName deviceCity deviceState placeOfSupply")
    .lean();

  console.log(`📋  Found ${receipts.length} receipt(s) needing backfill.\n`);

  if (receipts.length === 0) {
    console.log("🎉  Nothing to do — all receipts already have userName.");
    await mongoose.disconnect();
    return;
  }

  // Cache users and devices to avoid N+1 queries
  const userIds   = [...new Set(receipts.map(r => r.userId?.toString()).filter(Boolean))];
  const deviceIds = [...new Set(receipts.map(r => r.deviceId).filter(Boolean))];

  const [users, devices] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select("_id name").lean(),
    Device.find({ device_id: { $in: deviceIds } }).select("device_id city state area location").lean(),
  ]);

  const userMap   = Object.fromEntries(users.map(u  => [u._id.toString(), u]));
  const deviceMap = Object.fromEntries(devices.map(d => [d.device_id,     d]));

  let updated = 0;
  let skipped = 0;
  let errors  = 0;

  for (const r of receipts) {
    const user   = userMap[r.userId?.toString()];
    const device = deviceMap[r.deviceId];

    if (!user) {
      console.warn(`  ⚠️  Receipt ${r.receiptId} — userId ${r.userId} not found — skipping.`);
      skipped++;
      continue;
    }

    const setFields = {
      userName: user.name || "",
    };

    // Also backfill device location snapshot if missing
    if (device) {
      if (!r.deviceCity)    setFields.deviceCity    = device.city     || "";
      if (!r.deviceState)   setFields.deviceState   = device.state    || "";
      if (!r.placeOfSupply) setFields.placeOfSupply = device.state    || "";
      setFields.deviceArea     = device.area     || "";
      setFields.deviceLocation = device.location || "";
    }

    try {
      await Receipt.updateOne({ _id: r._id }, { $set: setFields });
      console.log(`  ✅  ${r.receiptId}  →  userName: "${user.name}"`);
      updated++;
    } catch (err) {
      console.error(`  ❌  ${r.receiptId}  update failed:`, err.message);
      errors++;
    }
  }

  console.log(`
────────────────────────────────────
  ✅  Updated : ${updated}
  ⚠️   Skipped : ${skipped}  (no matching user)
  ❌  Errors  : ${errors}
────────────────────────────────────`);

  await mongoose.disconnect();
  console.log("🔌  Disconnected. Done.");
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});