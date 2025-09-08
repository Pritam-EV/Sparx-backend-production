const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const crypto = require("crypto");

require("dotenv").config(); // Load environment variables

// ✅ Use environment variable for JWT secret
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const twilio = require("twilio")(TWILIO_SID, TWILIO_TOKEN);
const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;


// ✅ Google Auth Client
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

exports.sendPhoneCode = async (req, res) => {
  try {
    const { mobile } = req.body;
    if (!mobile) return res.status(400).json({ message: "Mobile is required" });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    let user = await User.findOne({ mobile });
    if (!user) {
      user = new User({ mobile, phoneVerified: false });
    }

    user.phoneVerificationCode = code;
    user.phoneVerificationExpires = expires;
    await user.save();

    await twilio.messages.create({
      body: `Your verification code is ${code}`,
      from: process.env.TWILIO_NUMBER, // replace YOUR_TWILIO_NUMBER with env var
      to: mobile,
    });

    return res.json({ message: "Code sent" });
  } catch (error) {
    console.error("sendPhoneCode Error:", error);
    return res.status(500).json({ message: "Failed to send code" });
  }
};

exports.verifyPhoneCode = async (req, res) => {
  try {
    const { mobile, code } = req.body;
    const user = await User.findOne({ mobile });

    if (
      !user ||
      user.phoneVerificationCode !== code ||
      !user.phoneVerificationExpires ||
      user.phoneVerificationExpires < Date.now()
    ) {
      return res.status(400).json({ message: "Invalid or expired code" });
    }

    user.phoneVerified = true;
    user.phoneVerificationCode = undefined;
    user.phoneVerificationExpires = undefined;
    await user.save();

    if (user.name && user.email) {
      const token = jwt.sign(
        { userId: user._id, role: user.role },
        JWT_SECRET,
        { expiresIn: "7d" }
      );

      return res.json({ token, user, isNewUser: false });
    }

    return res.json({ isNewUser: true, mobile });
  } catch (error) {
    console.error("verifyPhoneCode Error:", error);
    return res.status(500).json({ message: "Code verification failed" });
  }
};

exports.signup = async (req, res) => {
  try {
    const { name, email, mobile, vehicleType, role } = req.body;

    if (!name || !email || !mobile || !vehicleType) {
      return res.status(400).json({ message: "All fields are required" });
    }

    let user = await User.findOne({ mobile });

    if (!user || !user.phoneVerified) {
      return res.status(400).json({ message: "Phone number not verified" });
    }

    // Avoid duplicate email conflict
    const existingEmailUser = await User.findOne({ email });
    if (existingEmailUser && existingEmailUser._id.toString() !== user._id.toString()) {
      return res.status(400).json({ message: "Email already exists" });
    }

    user.name = name;
    user.email = email;
    user.vehicleType = vehicleType;
    user.role = role?.trim() || "customer";

    await user.save();

    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(201).json({ token, user });
  } catch (error) {
    console.error("Signup Error:", error);
    return res.status(500).json({ message: "Signup failed" });
  }
};


