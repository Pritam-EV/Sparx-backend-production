// firebaseAdmin.js
// ─────────────────────────────────────────────────────────────────────────────
// Initialises Firebase Admin SDK (Auth + Firestore + Storage).
// Used by:
//   • authMiddleware.js  – token verification
//   • middleware/uploadEB.js – Firebase Storage uploads
// ─────────────────────────────────────────────────────────────────────────────
const admin = require('firebase-admin');
require('dotenv').config();

if (!admin.apps.length) {
  const serviceAccount = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // FIREBASE_STORAGE_BUCKET must be set in .env
    // Format: "<your-project-id>.appspot.com"
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the default Storage bucket instance.
 * Usage: const bucket = getBucket();
 */
const getBucket = () => admin.storage().bucket();

/**
 * Generates a signed download URL for a given Storage file path.
 * URL is valid for `expiresInMs` milliseconds (default: 1 hour).
 *
 * @param {string} filePath  – e.g. "eb-bills/PROJ_A/2026-05/eb.pdf"
 * @param {number} expiresInMs
 * @returns {Promise<string>} signed HTTPS URL
 */
const getSignedUrl = async (filePath, expiresInMs = 60 * 60 * 1000) => {
  const bucket = getBucket();
  const file   = bucket.file(filePath);

  const [url] = await file.getSignedUrl({
    action:  'read',
    expires: Date.now() + expiresInMs
  });

  return url;
};

/**
 * Deletes a file from Firebase Storage.
 * Safe to call even if the file does not exist (errors are swallowed).
 *
 * @param {string} filePath
 */
const deleteStorageFile = async (filePath) => {
  try {
    const bucket = getBucket();
    await bucket.file(filePath).delete();
  } catch (err) {
    // File may not exist – not a fatal error
    console.warn(`[Firebase Storage] deleteStorageFile: could not delete ${filePath}:`, err.message);
  }
};

module.exports = {
  admin,          // full Admin SDK instance
  getBucket,      // () => Bucket
  getSignedUrl,   // (filePath, expiresInMs?) => Promise<string>
  deleteStorageFile // (filePath) => Promise<void>
};
