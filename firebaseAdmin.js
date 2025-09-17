// firebaseAdmin.js
const admin = require("firebase-admin");
const fs = require('fs');
require('dotenv').config();

// If you store the service account JSON path in env:
const serviceAccountPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH; // e.g. './serviceAccountKey.json'

if (!admin.apps.length) {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    // Option A: service account JSON stored in env (string)
    const svc = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(svc)
    });
  } else if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
    const svc = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(svc)
    });
  } else {
    console.warn("firebaseAdmin: no service account found; ensure GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_PATH is set");
    // If running in GCP or similar with ADC, you can initialize without explicit creds:
    try {
      admin.initializeApp();
    } catch (e) { console.error("firebaseAdmin init error", e); }
  }
}

module.exports = admin;
