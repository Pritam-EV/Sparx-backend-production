const mongoose = require("mongoose");

const operatorRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    mobile: {
      type: String,
      required: true,
    },

    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    location: {
      type: String,
      required: true,
      trim: true,
    },

    budget: {
      type: String, 
      enum: ["<5000", "5000-15000", "15000-50000", ">50000"],
      required: true,
    },

    status: {
      type: String,
      enum: ["PENDING", "CONTACTED", "APPROVED", "REJECTED"],
      default: "PENDING",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("OperatorRequest", operatorRequestSchema);
