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
const authRoutes    = require("./routes/auth");
const deviceRoutes  = require("./routes/devices");
const sessionRoutes = require("./routes/sessions");
const userRoutes    = require('./routes/users'); // Adjust path as needed
const analyticsRoutes = require('./routes/analytics');
const receiptsRoutes = require('./routes/receipts'); // add
const operatorRoutes = require("./routes/operator");
const partnerRoutes = require('./routes/partner');

// MQTT Subscriber (if you still need it)
const startMqttSubscriber = require("./mqttSubscriber");

const app = express();

const OFFLINE_THRESHOLD_MS = 30 * 1000; // 2 minutes

const allowedOrigins = [process.env.CLIENT_URL, 'https://viz.vjratechnologies.com'];


if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not defined. Set JWT_SECRET in environment variables and restart the server.');
  // Optionally exit so you don't run in a broken state:
  // process.exit(1);
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

// CORS: allow your frontend origins

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true); // allow server-to-server or curl
      return cb(null, ALLOWED_ORIGINS.includes(origin));
    },
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false, // set true only if sending cookies; then also send ACA-Credentials
    maxAge: 86400,
  })
);

// Ensure all preflights are handled
app.options("*", cors({
  origin: ALLOWED_ORIGINS,
  methods: ["GET","HEAD","PUT","PATCH","POST","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
  credentials: false,
}));



// Serve static assets (e.g. your SVG/clipart for SessionStart page):
app.use(express.static("public"));
app.use('/api/coupons', couponsRouter);
app.use('/api/partner', partnerRoutes);
// ─── DATABASE ────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)  // ✅ Modern, no options needed (Node 20+)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err.message));


// ─── ROUTES ────────────────────────────────────────────────────────────────────
// Authentication
app.get('/ping', (req, res) => res.send('pong'));

app.use("/api/auth", authRoutes);
app.use('/auth', authRoutes);
// Devices (location, charger type, rate)
app.use("/api/devices", deviceRoutes);

// Sessions (start, stop, by-transaction, by-sessionId, etc.)
app.use("/api/sessions", sessionRoutes);

app.use('/api/users', userRoutes);

app.use('/api/analytics', analyticsRoutes);
app.use('/api/receipts', receiptsRoutes);  
// Legacy GET endpoint (optional; can remove if you use `/api/sessions/by-transaction`)
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
app.use('/api/receipts', require('./routes/receipts'));
app.use("/api/operator", operatorRoutes);



setInterval(async () => {
  console.log("🔍 Running offline sweep…");
  const cutoff = new Date(Date.now() - OFFLINE_THRESHOLD_MS);
  const result = await Device.updateMany(
    { lastSeen: { $lt: cutoff }, status: { $ne: "Offline" } },
    { status: "Offline" }
  );
  console.log(`🛑 Offline sweep modified ${result.modifiedCount} devices`);
}, 10 * 1000);  // every 10 seconds




// Start your MQTT subscriber after HTTP is running
startMqttSubscriber();


// ─── START SERVER ──────────────────────────────────────────────────────────────
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
