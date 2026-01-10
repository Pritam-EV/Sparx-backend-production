const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({

  device_id: { type: String, required: true },

  // If ownerId is actually an array in DB, keep it as [ObjectId]
  ownerId: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }], // array of 4 ids [file:1]

  location: { type: String, required: true }, // e.g. "DMart, Karve Nagar, Pune" [file:1]

  lat: { type: Number, required: true },      // 18.4846539 [file:1]
  lng: { type: Number, required: true },      // 73.8109222 [file:1]

  status: { type: String, required: true },   // "Offline" [file:1]

  charger_type: { type: String, required: true }, // "Universal 3.3kV Socket" [file:1]

  current_session_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Session', 
    default: null 
  }, // null in sample [file:1]

  rate: { type: Number, required: true, default: 20 }, // you can change 9 via data, default kept [file:1]

  area: { type: String, required: true },     // "Warje" [file:1]
  city: { type: String, required: true },     // "Pune" [file:1]
  state: { type: String, required: true },    // "Maharashtra" [file:1]

  totalenergy: { type: Number, required: false, default: 0 }, // 0 in sample [file:1]

  relayOn: { type: Boolean, default: false }, // false in sample [file:1]

  lastSeen: { type: Date, default: Date.now }, // 2026-01-09T22:00:21... [file:1]

  // NEW FIELDS
  commissionPerKwh: { type: Number, default: 2 }, // from sample and your requirement
  PGPercent: { type: Number, default: 2 }         // PG% mapped to a valid field name
});

const Device = mongoose.models.Device || mongoose.model('Device', deviceSchema);

module.exports = Device;
