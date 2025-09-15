const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const crypto = require("crypto");
const admin = require("../firebaseAdmin"); // new
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

    // Validate input presence
    if (!mobile || !code) {
      return res.status(400).json({ message: "Mobile and code are required" });
    }

    console.log("verifyPhoneCode request body:", req.body); // Debug log

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

    // If no name/email, treat as new user
    return res.json({ isNewUser: true, mobile });

  } catch (error) {
    console.error("verifyPhoneCode Error:", error);
    return res.status(500).json({ message: "Code verification failed" });
  }
};




exports.signup = async (req, res) => {
  try {
    const { name, email, mobile, vehicleType, role } = req.body;
    if (!name || !email || !vehicleType) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // 1) Verify Firebase ID token from Authorization
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
    if (!idToken) return res.status(401).json({ message: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    // 2) Ensure phone sign-in and extract canonical phone in E.164
    const phone = decoded.phone_number;
    if (!phone) {
      return res.status(400).json({ message: "Mobile number not verified" }); // not a phone-auth token
    }

    // 3) Use token’s phone as the source of truth; optionally compare to payload
    if (mobile && mobile !== phone) {
      // Optional: reject mismatch or just ignore client mobile and use phone
      // return res.status(400).json({ message: "Mobile mismatch" });
    }

    // 4) Upsert user by mobile (E.164)
    let user = await User.findOne({ mobile: phone });
    // Avoid duplicate email conflict with someone else’s account
    const existingEmailUser = await User.findOne({ email });
    if (existingEmailUser && (!user || existingEmailUser._id.toString() !== user?._id.toString())) {
      return res.status(400).json({ message: "Email already exists" });
    }

    if (!user) {
      user = new User({
        name,
        email,
        mobile: phone,
        vehicleType,
        role: role?.trim() || "customer",
        phoneVerified: true, // trust Firebase phone
      });
    } else {
      user.name = name;
      user.email = email;
      user.vehicleType = vehicleType;
      user.role = role?.trim() || user.role || "customer";
      user.phoneVerified = true; // ensure true for existing
    }
    await user.save();

    // 5) Issue your app JWT (if you use it for session auth)
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.status(201).json({ token, user });
  } catch (error) {
    console.error("Signup Error:", error);
    return res.status(500).json({ message: "Signup failed" });
  }
};


