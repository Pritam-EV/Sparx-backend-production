// app.js

const express   = require("express");
const mongoose  = require("mongoose");
const cors      = require("cors");
const dotenv    = require("dotenv");
const Razorpay = require("razorpay");
const crypto = require('crypto');
const couponsRouter = require('./routes/coupons');
const Device = require('./models/device');
// Load env vars
require("dotenv").config(); // at top of app.js
const ALLOWED_ORIGINS = [
  "https://ev-charging-a5c53.web.app",
  "http://localhost:3000",
];

// Route handlers
const authRoutes    = require("./routes/auth");
const deviceRoutes  = require("./routes/devices");
const sessionRoutes = require("./routes/sessions");
const userRoutes    = require('./routes/users'); // Adjust path as needed
const analyticsRoutes = require('./routes/analytics');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});


// MQTT Subscriber (if you still need it)
const startMqttSubscriber = require("./mqttSubscriber");

const app = express();

const OFFLINE_THRESHOLD_MS = 30 * 1000; // 2 minutes

const allowedOrigins = [process.env.CLIENT_URL, 'https://ev-charging-a5c53.web.app'];
// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
// ─── DATABASE ────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI, { 
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err.message));

// ─── ROUTES ────────────────────────────────────────────────────────────────────
// Authentication
app.use("/api/auth", authRoutes);

// Devices (location, charger type, rate)
app.use("/api/devices", deviceRoutes);

// Sessions (start, stop, by-transaction, by-sessionId, etc.)
app.use("/api/sessions", sessionRoutes);

app.use('/api/users', userRoutes);

app.use('/api/analytics', analyticsRoutes);

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

app.post("/api/payment/orders", async (req, res) => {
  const { amount } = req.body;

  try {
    const order = await razorpay.orders.create({
      amount: amount * 100, // amount in paise
      currency: "INR",
      receipt: `receipt_order_${Math.floor(Math.random() * 10000)}`,
    });

    res.status(200).json({ success: true, order });
  } catch (error) {
    console.error("Razorpay order creation failed", error);
    res.status(500).json({ success: false, error: "Unable to create order" });
  }
});

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
