const OperatorRequest = require("../models/OperatorRequest");

/**
 * @route   POST /api/operator/request
 * @access  Private (Logged-in users)
 */
const createOperatorRequest = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, mobile, email, location, budget } = req.body;

    // 1️⃣ Validate
    if (!name || !mobile || !email || budget === undefined) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    // 2️⃣ Prevent duplicate pending request
    const existing = await OperatorRequest.findOne({
      userId,
      status: "PENDING",
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "You already have a pending request",
      });
    }

    // 3️⃣ Budget mapping
    const budgetMap = {
      0: "<5000",
      1: "5000-15000",
      2: "15000-50000",
      3: ">50000",
    };

    const budgetValue = budgetMap[budget];
    if (!budgetValue) {
      return res.status(400).json({
        success: false,
        message: "Invalid budget selection",
      });
    }

    // 4️⃣ Save
    const request = await OperatorRequest.create({
      userId,
      name,
      mobile,
      email,
      location,
      budget: budgetValue,
    });

    return res.status(201).json({
      success: true,
      message: "Operator request submitted successfully",
      request,
    });
  } catch (err) {
    console.error("Operator request error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

module.exports = {
  createOperatorRequest,
};
