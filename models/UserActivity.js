// models/UserActivity.js
const mongoose = require('mongoose');

const UserActivitySchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  page:      { type: String, required: true },       // e.g. "/charging-options/abc123"
  visitedAt: { type: Date, default: Date.now },
  sessionId: { type: String },                       // optional: group page views in one session
  metadata:  { type: Object }                        // optional: device, screen size, etc.
}, { timestamps: false });

// TTL index — auto-delete logs older than 90 days (saves storage)
UserActivitySchema.index({ visitedAt: 1 }, { expireAfterSeconds: 7776000 });

module.exports = mongoose.model('UserActivity', UserActivitySchema);