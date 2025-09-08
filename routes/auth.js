const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const User = require("../models/User"); // Adjust based on your project structure
const { OAuth2Client } = require("google-auth-library");
const authMiddleware = require("../middleware/authMiddleware");
const { sendPhoneCode, verifyPhoneCode, signup } = require("../controllers/authController");


const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// routes/auth.js
router.post("/phone/send-code", sendPhoneCode);
router.post("/phone/verify-code", verifyPhoneCode);
router.post("/signup", signup);


router.post("/google", async (req, res) => {
  try {
    const { token } = req.body;

    // Verify Google token
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const { email, name, sub } = ticket.getPayload();

    // Check if user exists
    let user = await User.findOne({ email });

    if (!user) {
      // New user - return `isNewUser: true`
      return res.json({
        isNewUser: true,
        email,
        googleId: sub, // Google user ID
      });
    }
    
    if (!user.role) {
      // Assign default role if missing
      user.role = 'customer';
      await user.save();
    }

    // Existing user - generate token
      const jwtToken = jwt.sign(
        {
          userId: user._id,
          role: user.role,   // ✅ Add this
        },
        process.env.JWT_SECRET,
        { expiresIn: "30d" }
      );


    res.json({
      token: jwtToken,
      user,
      isNewUser: false, // Existing user
    });
  } catch (error) {
    console.error("Google Login Error:", error);
    res.status(500).json({ message: "Google login failed" });
  }
});

router.post("/signup", async (req, res) => {
  try {
    console.log("Incoming Signup Request:", req.body);

    const { name, mobile, vehicleType, email, googleId } = req.body;

    // Validate required fields
    if (!name || !mobile || !vehicleType || !email || !googleId) {
      console.log("❌ Missing Fields:", req.body);
      return res.status(400).json({ message: "All fields are required" });
    }

    // Check for existing email or mobile
    let existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email already exists" });
    }
    existingUser = await User.findOne({ mobile });
    if (existingUser) {
      return res.status(400).json({ message: "Mobile number already exists" });
    }

    // Create user with default role customer
    let user = new User({
      name,
      email,
      mobile,
      vehicleType,
      googleId,
      role: 'customer',  // default role
    });

    await user.save();
    console.log("✅ User Created:", user);

    // Generate JWT token including role
    const jwtToken = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({ token: jwtToken, user });
  } catch (error) {
    console.error("❌ Signup Error:", error);
    res.status(500).json({ message: "Signup failed" });
  }
});

router.delete("/delete", authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.user.id);
    res.json({ message: "Account deleted successfully" });
  } catch (error) {
    console.error("Delete Account Error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/test-auth", authMiddleware, (req, res) => {
  res.json({ message: "Auth Middleware Works!", userId: req.user.id });
});


// Update profile
// Update profile
router.put("/updateProfile", authMiddleware, async (req, res) => {
  const { name, mobile, vehicleType } = req.body;
  const userId = req.user.userId; // ✅ Match this with how you set it in authMiddleware

  try {
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { name, mobile, vehicleType },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ user: updatedUser });
  } catch (err) {
    console.error("Profile update error:", err);
    res.status(500).json({ message: "Server error" });
  }
});




module.exports = router;
