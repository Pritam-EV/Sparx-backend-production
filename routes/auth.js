const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { OAuth2Client } = require("google-auth-library");
const authMiddleware = require("../middleware/authMiddleware");
const { sendPhoneCode, verifyPhoneCode, signup } = require("../controllers/authController");
// ✅ Fixed: destructure admin from the updated firebaseAdmin export
const { admin } = require("../firebaseAdmin");

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

router.post("/phone/send-code", sendPhoneCode);
router.post("/phone/verify-code", verifyPhoneCode);
router.post("/signup", signup);

router.post("/google", async (req, res) => {
  try {
    const { token } = req.body;
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { email, name, sub } = ticket.getPayload();
    let user = await User.findOne({ email });
    if (!user) {
      return res.json({ isNewUser: true, email, googleId: sub });
    }
    if (!user.role) {
      user.role = 'customer';
      await user.save();
    }
    const jwtToken = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    res.json({ token: jwtToken, user, isNewUser: false });
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

// GET /auth/me
router.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  if (!idToken) return res.status(401).json({ message: 'Missing auth token' });
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const phone = decoded.phone_number;
    if (!phone) return res.status(400).json({ message: 'Token has no phone number' });
    const strippedPlus = phone.replace(/^\+/, '');
    const last10 = strippedPlus.slice(-10);
    let user = await User.findOne({ mobile: phone }).select('-password -__v');
    if (!user) user = await User.findOne({ mobile: strippedPlus }).select('-password -__v');
    if (!user) user = await User.findOne({ mobile: last10 }).select('-password -__v');
    if (!user) return res.status(404).json({ message: 'User not found' });
    const token = jwt.sign(
      { userId: user._id.toString(), role: user.role || 'customer' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    return res.json({ user, token });
  } catch (err) {
    console.error('GET /auth/me error:', err && err.message ? err.message : err);
    return res.status(401).json({ message: 'Invalid/expired auth token', details: err?.message });
  }
});

// Update profile
router.put("/updateProfile", authMiddleware, async (req, res) => {
  const { name, email, vehicleType, vehicleNumber } = req.body;
  const userId = req.user.userId;
  try {
    if (!name && !email && !vehicleType && typeof vehicleNumber === "undefined") {
      return res.status(400).json({ message: "Nothing to update" });
    }
    if (email) {
      const emailNormalized = email.toString().trim().toLowerCase();
      const existing = await User.findOne({ email: emailNormalized });
      if (existing && existing._id.toString() !== userId) {
        return res.status(400).json({ message: "Email already exists" });
      }
    }
    const update = {};
    if (typeof name !== "undefined")          update.name = name;
    if (typeof email !== "undefined")         update.email = email.toString().trim().toLowerCase();
    if (typeof vehicleType !== "undefined")   update.vehicleType = vehicleType;
    if (typeof vehicleNumber !== "undefined") update.vehicleNumber = vehicleNumber;
    const updatedUser = await User.findByIdAndUpdate(userId, update, { new: true }).select("-password -__v");
    if (!updatedUser) return res.status(404).json({ message: "User not found" });
    return res.json({ user: updatedUser });
  } catch (err) {
    console.error("Profile update error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;