// models/UserActivity.js
const mongoose = require('mongoose');

const PageVisitSchema = new mongoose.Schema({
  page:         { type: String, required: true },
  visitedAt:    { type: Date, default: Date.now },
  timeSpentSec: { type: Number, default: 0 },
  location: {                              // ← ADD THIS BLOCK
    lat:      Number,
    lng:      Number,
    accuracy: Number,                      // metres — filter out low-accuracy pings
  },
}, { _id: false });

const UserActivitySchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date:        { type: String, required: true },  // "2026-05-16" — one doc per user per day
  pages:       [PageVisitSchema],                 // array of visits that day
  lastSeen:    { type: Date, default: Date.now }, // updated on every track call
  totalPages:  { type: Number, default: 0 },      // quick count without array.length
}, { timestamps: false });

// One document per user per day — compound unique index
UserActivitySchema.index({ userId: 1, date: 1 }, { unique: true });

// TTL — auto-delete after 90 days
UserActivitySchema.index({ lastSeen: 1 }, { expireAfterSeconds: 7776000 });

module.exports = mongoose.model('UserActivity', UserActivitySchema);