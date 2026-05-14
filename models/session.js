// models/session.js
const mongoose = require("mongoose");

const commandLogSchema = new mongoose.Schema({
  at:       { type: Date,   default: Date.now },
  type:     { type: String, enum: ["start","pause","resume","stop"], required: true },
  topic:    { type: String },
  payload:  { type: mongoose.Schema.Types.Mixed },
  mqtt: {
    publishedAt: { type: Date },
    error:       { type: String, default: null }
  },
  ack: {
    receivedAt:  { type: Date, default: null },
    payload:     { type: mongoose.Schema.Types.Mixed }
  }
}, { _id: false });



const sessionSchema = new mongoose.Schema({
  sessionId:      { type: String,  required: true, unique: true },
  deviceId: { type: String, required: true },
  transactionId:  { type: String,  required: true, unique: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  startTime:      { type: Date,    required: true },
  startDate:      { type: String,  required: true },
  energySelected: { type: Number,  required: true },    // target kWh
  energyConsumed: { type: Number,  default: 0 },        // current kWh
  amountSelected: { type: Number, required: true },
  discountApplied: { type: Number, default: 0 },
  amountPaid:     { type: Number,  required: true },    // ₹ prepaid
  amountUsed:     { type: Number,  default: 0 },        // ₹ used so far
  ratePerKwh:     { type: Number, required: true },       // ₹/kWh
  status:         { type: String,  enum: ["active","completed","faulty"], default: "active" },
  endTrigger:     { type: String,  default: null },
  endTime:        { type: Date,    default: null },
  paymentGateway: {
  type: String,
  enum: ["cashfree", "wallet", "free"],
  default: "cashfree",
},
  // ─── ETA fields ───────────────────────────────────────────────────────────
// Continuously refined estimated session end time based on actual charge rate
estimatedEndTime:   { type: Date,   default: null },
// The % at which we last recalculated the estimate (avoids recalc on every tick)
lastEstimationPct:  { type: Number, default: 0 },
// ──────────────────────────────────────────────────────────────────────────
  latestVoltage: { type: Number, default: 0 },
  latestCurrent: { type: Number, default: 0 },
  latestPower:   { type: Number, default: 0 },
  lastUpdate:    { type: Date },
}, {
  timestamps: true
});

const Session = mongoose.model("Session", sessionSchema);
module.exports = Session;
