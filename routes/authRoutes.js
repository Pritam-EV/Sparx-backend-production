const express = require("express");
const { googleLogin, signup } = require("../controllers/authController");

const router = express.Router();

router.post("/google", googleLogin); // Google login
router.post("/signup", signup); // Signup

module.exports = router;
