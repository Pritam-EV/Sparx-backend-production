const admin = require("firebase-admin");
const fs = require("fs");

let serviceAccountJson = null;
try {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const content = fs.readFileSync(path, "utf8");
  serviceAccountJson = JSON.parse(content); // safer parse
} catch (err) {
  console.error('Failed to load service account JSON:', err);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountJson),
    projectId: serviceAccountJson.project_id,
  });
}

module.exports = admin;
