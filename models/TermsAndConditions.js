const mongoose = require("mongoose");
const crypto = require("crypto");

const TermsAndConditionsSchema = new mongoose.Schema({
  version: {
    type: String,            // e.g. "v1.0.0"
    required: true,
    unique: true
  },

  title: {
    type: String,
    default: "Device Onboarding Terms & Conditions"
  },

  content: {
    type: String,
    required: true
  },

  contentHash: {
    type: String,
    required: true,
    unique: true
  },

  isActive: {
    type: Boolean,
    default: true
  },

  effectiveFrom: {
    type: Date,
    default: Date.now
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }

}, { timestamps: true });

/**
 * Auto-generate hash before save
 */
TermsAndConditionsSchema.pre("validate", function (next) {
  if (this.content) {
    this.contentHash = crypto
      .createHash("sha256")
      .update(this.content.trim())
      .digest("hex");
  }
  next();
});

module.exports = mongoose.model("TermsAndConditions", TermsAndConditionsSchema);
