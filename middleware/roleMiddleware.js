// middleware/roleMiddleware.js

/**
 * Middleware to enforce that a route is only accessible to users
 * with one of the specified roles.
 * Usage: authorizeRoles('admin'), authorizeRoles('owner', 'admin')
 */
function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
      // console.log("Role check:", req.user && req.user.role);
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Access denied: insufficient permissions" });
    }
    next();
  };
}

module.exports = authorizeRoles;
