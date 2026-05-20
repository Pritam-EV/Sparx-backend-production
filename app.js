// app.js

const express   = require("express");
const mongoose  = require("mongoose");
const cors      = require("cors");
const dotenv    = require("dotenv");
const crypto = require('crypto');
const couponsRouter = require('./routes/coupons');
const Device = require('./models/device');
// Load env vars
require("dotenv").config(); // at top of app.js
const ALLOWED_ORIGINS = [
  "https://viz.vjratechnologies.com",
  "http://localhost:3000",
];

// Route handlers
const authRoutes         = require("./routes/auth");
const deviceRoutes       = require("./routes/devices");
const sessionRoutes      = require("./routes/sessions");
const userRoutes         = require('./routes/users');
const analyticsRoutes    = require('./routes/analytics');
const receiptsRoutes     = require('./routes/receipts');
const operatorRoutes     = require("./routes/operator");
const partnerRoutes      = require('./routes/partner');
const electricityBillRoutes = require('./routes/electricityBill'); // ← NEW
const walletRoutes = require("./routes/wallet");
const activityRoutes = require('./routes/activityRoutes');
const adminTransactionsRoutes = require('./routes/adminTransactions');
// MQTT Subscriber
const startMqttSubscriber = require("./mqttSubscriber");

const app = express();

const OFFLINE_THRESHOLD_MS = 30 * 1000;
const allowedOrigins = [process.env.CLIENT_URL, 'http://localhost:3000'];

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not defined. Set JWT_SECRET in environment variables and restart the server.');
}

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

const client_URLs = process.env.CLIENT_URL;

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      return cb(null, ALLOWED_ORIGINS.includes(origin));
    },
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
    maxAge: 86400,
  })
);

app.options("*", cors({
  origin: ALLOWED_ORIGINS,
  methods: ["GET","HEAD","PUT","PATCH","POST","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
  credentials: false,
}));

app.use(express.static("public"));
app.use('/api/coupons', couponsRouter);
app.use('/api/partner', partnerRoutes);

// ─── DATABASE ─────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err.message));

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.send('pong'));

app.use("/api/auth", authRoutes);
app.use('/auth', authRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/sessions", sessionRoutes);
app.use('/api/users', userRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/admin/transactions', adminTransactionsRoutes);
app.use('/api/receipts', receiptsRoutes);
app.use('/api/eb', electricityBillRoutes);   // ← NEW: EB management
app.use("/api/wallet", walletRoutes);
app.get("/api/getDevice", async (req, res) => {
  try {
    const { transactionId } = req.query;
    if (!transactionId) {
      return res.status(400).json({ error: "Transaction ID is required" });
    }
    const session = await require("./models/session").findOne({ transactionId });
    if (!session) {
      return res.status(404).json({ error: "Transaction ID not found" });
    }
    res.json(session);
  } catch (err) {
    console.error("Error fetching session:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.use("/api/payment", require("./routes/payment"));
app.use("/api/operator", operatorRoutes);
app.use('/api/activity', activityRoutes);
// ─── OFFLINE SWEEP ────────────────────────────────────────────────────────────
setInterval(async () => {
  console.log("🔍 Running offline sweep…");
  const cutoff = new Date(Date.now() - OFFLINE_THRESHOLD_MS);
  const result = await Device.updateMany(
    { lastSeen: { $lt: cutoff }, status: { $ne: "Offline" } },
    { status: "Offline" }
  );
  console.log(`🛑 Offline sweep modified ${result.modifiedCount} devices`);
}, 10 * 1000);

// Start MQTT subscriber
startMqttSubscriber();

// ─── START SERVER ─────────────────────────────────────────────────────────────
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});