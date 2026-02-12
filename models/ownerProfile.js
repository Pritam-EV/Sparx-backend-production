// models/ownerProfile.js
const mongoose = require('mongoose');  // ✅ ADD THIS LINE

const OwnerProfileSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId,  // ✅ FIXED
    ref: "User", 
    unique: true,
    required: true
  },
  legalName: String,
  gstin: { type: String },  // optional GST number
  payoutBank: {
    accountNumber: String,
    ifsc: String,
    name: String
  },
  defaultElectricityMode: {
    type: String,
    enum: ["OWNER_PAYS", "VJRA_PAYS"],
    default: "OWNER_PAYS"
  }
}, { 
  timestamps: true  // ✅ ADD createdAt, updatedAt automatically
});

module.exports = mongoose.model('OwnerProfile', OwnerProfileSchema);  // ✅ EXPORT THE MODEL
