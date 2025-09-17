const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const User = require("../models/User"); // Adjust based on your project structure
const { OAuth2Client } = require("google-auth-library");
const authMiddleware = require("../middleware/authMiddleware");
const { sendPhoneCode, verifyPhoneCode, signup } = require("../controllers/authController");
const admin = require("../firebaseAdmin");

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


router.get("/me", async (req, res) => {
  // 1) Extract idToken
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

  if (!idToken) {
    return res.status(401).json({ message: "Missing auth token" });
  }
console.log("Decoded phone from token:", phone);
console.log("Searching DB for:", [phone, strippedPlus, last10]);

  try {
    // 2) Verify Firebase ID token
    const decoded = await admin.auth().verifyIdToken(idToken);
    // decoded.phone_number is typically in E.164 format, e.g. "+919876543210"
    const phone = decoded.phone_number;
    if (!phone) {
      return res.status(400).json({ message: "Mobile number not verified in token" });
    }

    // 3) Normalize / try multiple formats to match DB entries:
    //    - E.164 canonical (phone)
    //    - stripped leading '+'   (e.g. "919876543210")
    //    - last 10 digits only    (e.g. "9876543210")
    const strippedPlus = phone.replace(/^\+/, ""); // "919876543210"
    const last10 = strippedPlus.slice(-10);         // "9876543210"

    // Try to find user in multiple possible saved formats in DB
    let user = await User.findOne({ mobile: phone }).select("-password -__v");
    if (!user) user = await User.findOne({ mobile: strippedPlus }).select("-password -__v");
    if (!user) user = await User.findOne({ mobile: last10 }).select("-password -__v");

    if (!user) {
      // Not found → 404 so frontend knows to go to signup
      return res.status(404).json({ message: "User not found" });
    }

    // Found → return user
    return res.json(user);
  } catch (err) {
    console.error("GET /auth/me token verification error:", err);
    // If token verification failed, return 401 (not 404)
    return res.status(401).json({ message: "Invalid or expired auth token" });
  }
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
