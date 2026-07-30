// app.js
const express   = require("express");
const mongoose  = require("mongoose");
const cors      = require("cors");
const crypto    = require("crypto");
const couponsRouter = require("./routes/coupons");
const Device    = require("./models/device");

require("dotenv").config();

const ALLOWED_ORIGINS = [
  "https://viz.vjratechnologies.com",
  "http://localhost:3000",
];

// Route handlers
const authRoutes              = require("./routes/auth");
const deviceRoutes            = require("./routes/devices");
const sessionRoutes           = require("./routes/sessions");
const userRoutes              = require("./routes/users");
const analyticsRoutes         = require("./routes/analytics");
const receiptsRoutes          = require("./routes/receipts");
const operatorRoutes          = require("./routes/operator");
const partnerRoutes           = require("./routes/partner");
const electricityBillRoutes   = require("./routes/electricityBill");
const walletRoutes            = require("./routes/wallet");
const activityRoutes          = require("./routes/activityRoutes");
const adminTransactionsRoutes = require("./routes/adminTransactions");
const adminProvisionRoutes = require("./routes/adminProvision");
const cashfreeRouter          = require("./routes/cashfree");
const accountantRoutes        = require("./routes/accountant");

// MQTT Subscriber
const startMqttSubscriber = require("./mqttSubscriber");

const app = express();

const OFFLINE_THRESHOLD_MS = 30 * 1000;

if (!process.env.JWT_SECRET) {
  console.error(
    "FATAL: JWT_SECRET is not defined. Set JWT_SECRET in environment variables and restart."
  );
}

// ─── STEP 1: Raw body ONLY for Cashfree webhook (must be BEFORE express.json) ─
// This captures the raw Buffer and attaches it as req.rawBody ONCE.
// express.json() below is skipped for this path because body is already parsed here.
app.use(
  "/api/cashfree/webhook",
  express.raw({ type: "*/*" }),           // accept any content-type Cashfree sends
  (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body.toString("utf8");
    } else if (typeof req.body === "string") {
      req.rawBody = req.body;
    } else {
      req.rawBody = "";
    }
    next();
  }
);

// ─── STEP 2: JSON middleware for all other routes ────────────────────────────
// The verify function also captures rawBody for any OTHER routes that need it.
// Note: for /api/cashfree/webhook the body is ALREADY consumed above,
// so express.json() will just skip it (body already parsed).
app.use(
  express.json({
    verify: (req, res, buf) => {
      // Only set rawBody if not already set by the webhook middleware above
      if (!req.rawBody) {
        req.rawBody = buf.toString("utf8");
      }
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// ─── CORS ─────────────────────────────────────────────────────────────────────
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
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
}));

app.use(express.static("public"));

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/ping", (req, res) => res.send("pong"));

app.use("/api/coupons",            couponsRouter);
app.use("/api/partner",            partnerRoutes);

// Cashfree MUST be mounted BEFORE any auth-protected route groups
// and after the raw-body middleware above
app.use("/api/cashfree",           cashfreeRouter);

// ─── DATABASE ─────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err.message));

app.use("/api/auth",               authRoutes);
app.use("/auth",                   authRoutes);
app.use("/api/devices",            deviceRoutes);
app.use("/api/sessions",           sessionRoutes);
app.use("/api/users",              userRoutes);
app.use("/api/analytics",          analyticsRoutes);
app.use("/api/admin/transactions", adminTransactionsRoutes);
app.use("/api/admin/provision", adminProvisionRoutes);
app.use("/api/receipts",           receiptsRoutes);
app.use("/api/eb",                 electricityBillRoutes);
app.use("/api/wallet",             walletRoutes);
app.use("/api/payment",            require("./routes/payment"));
app.use("/api/operator",           operatorRoutes);
app.use("/api/activity",           activityRoutes);
app.use('/api/provision', require('./routes/deviceProvision.routes'));
app.use("/api/accountant",         accountantRoutes);

app.get("/api/getDevice", async (req, res) => {
  try {
    const { transactionId } = req.query;
    if (!transactionId)
      return res.status(400).json({ error: "Transaction ID is required" });
    const session = await require("./models/session").findOne({ transactionId });
    if (!session)
      return res.status(404).json({ error: "Transaction ID not found" });
    res.json(session);
  } catch (err) {
    console.error("Error fetching session:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── OFFLINE SWEEP ────────────────────────────────────────────────────────────
setInterval(async () => {
  const cutoff = new Date(Date.now() - OFFLINE_THRESHOLD_MS);
  await Device.updateMany(
    { lastSeen: { $lt: cutoff }, status: { $ne: "Offline" } },
    { status: "Offline" }
  );
}, 10 * 1000);

// Start MQTT subscriber
startMqttSubscriber();

// ─── START SERVER ─────────────────────────────────────────────────────────────
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});