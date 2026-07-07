const admin = require('firebase-admin');
require('dotenv').config();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

const getBucket = () => admin.storage().bucket();

const getSignedUrl = async (filePath, expiresInMs = 60 * 60 * 1000) => {
  const bucket = getBucket();
  const file = bucket.file(filePath);
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + expiresInMs,
  });
  return url;
};

const deleteStorageFile = async (filePath) => {
  try {
    const bucket = getBucket();
    await bucket.file(filePath).delete();
  } catch (err) {
    console.warn(`[Firebase Storage] deleteStorageFile: could not delete ${filePath}:`, err.message);
  }
};

module.exports = {
  admin,
  getBucket,
  getSignedUrl,
  deleteStorageFile,
};