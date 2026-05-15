// functions/index.js (safe, lazy-mount, single DB connect)
const functions = require("firebase-functions");             // to read functions config if needed
const { https } = require("firebase-functions/v2");         // v2 function export
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------------------------------
// SINGLE non-blocking mongoose connect (connect once only)
// -----------------------------------------------------
const mongoUri = (() => {
  // Prefer functions config, fallback to env var:
  try {
    const cfg = functions.config && typeof functions.config === "function" ? functions.config() : {};
    return (cfg.spark && cfg.spark.mongo) || process.env.MONGO_URI || "";
  } catch (e) {
    return process.env.MONGO_URI || "";
  }
})();

let isConnected = false;
async function connectOnce() {
  if (!mongoUri) {
    console.warn("No Mongo URI provided (functions.config or MONGO_URI). Skipping connect for now.");
    return;
  }
  if (isConnected) return;
  try {
    // NOTE: do not pass deprecated mongoose options
    await mongoose.connect(mongoUri);
    isConnected = true;
    console.log("✅ MongoDB connected (connectOnce).");
  } catch (err) {
    console.error("❌ Mongo connect failed (connectOnce):", err && err.message ? err.message : err);
    // do NOT rethrow — container should still start; subsequent requests may fail until DB is available
  }
}
// start connection in background (non-blocking)
connectOnce();

// -----------------------------------------------------
// Lazy route mounting: require route modules only on first API request
// This avoids expensive require-time side-effects from route modules during container initialization.
// -----------------------------------------------------
let routesMounted = false;
function mountApiRoutes() {
  if (routesMounted) return;
  routesMounted = true;
  console.log("Mounting API routes now...");

  try {
    app.use("/api/auth", require("./routes/auth"));
    app.use("/api/coupons", require("./routes/coupons"));
    app.use("/api/devices", require("./routes/devices"));
    app.use("/api/sessions", require("./routes/sessions"));
    app.use("/api/users", require("./routes/users"));
    app.use("/api/analytics", require("./routes/analytics"));
    app.use("/api/payment", require("./routes/payment"));
    app.use("/api/receipts", require("./routes/receipts"));
    console.log("API routes mounted.");
  } catch (e) {
    console.error("Failed to mount routes:", e && e.stack ? e.stack : e);
  }
}

// Middleware that ensures routes are mounted on first request.
// This keeps startup fast and defers heavy requires.
app.use((req, res, next) => {
  if (!routesMounted && req.path.startsWith("/api")) {
    mountApiRoutes();
  }
  next();
});

// Quick health / debug endpoints (always available)
app.get("/ping", (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || "unknown" }));
app.get("/", (req, res) => res.send("VIZ API — functions container alive"));

// Example of a safe endpoint that requires DB — it waits for DB connect if needed
app.get("/api/health/db", async (req, res) => {
  if (!isConnected) {
    // attempt a quick reconnect (non-blocking in background)
    connectOnce().catch(() => {});
    return res.status(503).json({ ok: false, message: "MongoDB not connected yet" });
  }
  return res.json({ ok: true, db: "connected" });
});

// Final export (v2)
exports.api = https.onRequest({ region: "asia-south1" }, app);
