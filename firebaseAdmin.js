// firebaseAdmin.js
const admin = require("firebase-admin");

// Prefer Application Default Credentials on Render; or use a JSON string env
// e.g., GOOGLE_APPLICATION_CREDENTIALS or service account JSON env
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

module.exports = admin;
