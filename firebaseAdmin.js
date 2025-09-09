const admin = require("firebase-admin");
const serviceAccount = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // optional but recommended to explicitly set your project
    projectId: serviceAccount.project_id,
  });
}

module.exports = admin;
