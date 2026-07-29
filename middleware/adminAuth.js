// middleware/adminAuth.js
const admin = require('../firebaseAdmin');

module.exports = async function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);

    // Check custom claim: only users with admin:true can access
    if (!decoded.admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.adminUid = decoded.uid;
    req.adminEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};