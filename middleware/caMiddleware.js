// middleware/caMiddleware.js
// Allows access ONLY for admin or accountant roles. All other roles get 403.
const jwt = require("jsonwebtoken");

const caMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ error: "TokenExpired", expired: true });
      }
      return res.status(401).json({ error: "Invalid token" });
    }

    if (!decoded.userId) {
      return res.status(403).json({ error: "Invalid token: userId not found" });
    }

    const allowedRoles = ["admin", "accountant"];
    if (!allowedRoles.includes(decoded.role)) {
      return res.status(403).json({ error: "Forbidden: CA or Admin access only" });
    }

    req.user = { userId: decoded.userId, role: decoded.role };
    next();
  });
};

module.exports = caMiddleware;