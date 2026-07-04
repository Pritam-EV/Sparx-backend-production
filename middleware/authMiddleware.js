const jwt = require("jsonwebtoken");

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    // console.log("🔑 Received Authorization Header:", authHeader);
    // console.log('Incoming Authorization header:', req.headers.authorization);
    // console.log("AUTH HEADER:", req.headers.authorization);

    if (!authHeader) {
        console.error("⚠️ No Authorization header found");
        return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    const token = authHeader.split(" ")[1]; // Ensure correct extraction
    // console.log("📌 Extracted Token:", token);

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
        if (err.name === "TokenExpiredError") {
            // 401 so axios interceptor treats as auth error
            return res
            .status(401)
            .json({ error: "TokenExpired", expired: true });
        }
        return res.status(401).json({ error: "Invalid token" });
        }

        if (!decoded.userId) {
            console.error("❌ Token missing userId field:", decoded);
            return res.status(403).json({ error: "Invalid token: userId not found" });
        }

        // console.log("✅ Token Verified! Decoded Data:", decoded);
        req.user = { userId: decoded.userId, role: decoded.role }; // ✅ Explicitly set `userId`
        
        next();
    });



};

module.exports = authMiddleware;
