// middleware/uploadEB.js
// ─────────────────────────────────────────────────────────────────────────────
// Multer-based middleware that:
//   1. Accepts a single PDF file field named "ebPdf"
//   2. Validates: PDF only, max 10 MB
//   3. Streams the file buffer to Firebase Storage
//      Path: eb-bills/{project}/{month}/eb.pdf
//   4. Attaches `req.ebUpload` to the request for the route handler:
//      {
//        storagePath: "eb-bills/PROJ_A/2026-05/eb.pdf",
//        publicUrl:   "https://storage.googleapis.com/...",  // always available
//        mimeType:    "application/pdf",
//        sizeBytes:   123456
//      }
// ─────────────────────────────────────────────────────────────────────────────
const multer  = require('multer');
const path    = require('path');
const { getBucket } = require('../firebaseAdmin');

// ─── Multer: memory storage (buffer, no temp files on disk) ──────────────────
const storage = multer.memoryStorage();

const fileFilter = (_req, file, cb) => {
  const ext  = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype;

  if (ext === '.pdf' && mime === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are accepted for EB upload.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB max
});

// ─── Firebase upload helper ───────────────────────────────────────────────────
/**
 * Uploads a file buffer to Firebase Storage.
 *
 * @param {Buffer} buffer
 * @param {string} storagePath  – destination path inside the bucket
 * @param {string} mimeType
 * @returns {Promise<string>}   – public HTTPS URL (unauthenticated read)
 */
const uploadToFirebase = (buffer, storagePath, mimeType) => {
  return new Promise((resolve, reject) => {
    const bucket = getBucket();
    const file   = bucket.file(storagePath);

    const stream = file.createWriteStream({
      metadata: {
        contentType: mimeType,
        cacheControl: 'private, max-age=0'
      },
      resumable: false  // files < 10 MB – no need for resumable upload
    });

    stream.on('error', (err) => reject(err));

    stream.on('finish', async () => {
      try {
        // Make the file publicly readable so we can build a stable URL.
        // Signed URLs expire; a public URL does not.
        // Firebase Storage free tier supports this.
        await file.makePublic();

        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
        resolve(publicUrl);
      } catch (err) {
        reject(err);
      }
    });

    stream.end(buffer);
  });
};

// ─── Exported middleware ──────────────────────────────────────────────────────
/**
 * Drop this into any route that accepts an EB PDF upload.
 *
 * Usage in routes/electricityBill.js:
 *   const { parseAndUploadEB } = require('../middleware/uploadEB');
 *   router.post('/upload', authMiddleware, adminOnly, parseAndUploadEB, handler);
 *
 * The `project` and `month` values are expected in req.body BEFORE this
 * middleware runs (they are part of the same multipart form submission).
 *
 * If no file is attached, the middleware is a no-op and sets req.ebUpload = null.
 */
const parseAndUploadEB = [
  // Step 1: parse multipart form (file is optional — admin may upload charges
  // without the PDF first, and attach the PDF later)
  upload.single('ebPdf'),

  // Step 2: if a file was sent, push it to Firebase Storage
  async (req, res, next) => {
    if (!req.file) {
      req.ebUpload = null;
      return next();
    }

    const { project, month } = req.body;

    if (!project || !month) {
      return res.status(400).json({
        error: 'project and month are required in the request body when uploading a PDF.'
      });
    }

    // Sanitise inputs so they are safe for use as a Storage path
    const safeProject = project.trim().replace(/[^a-zA-Z0-9_\-]/g, '_');
    const safeMonth   = month.trim();  // already validated by model: YYYY-MM

    const storagePath = `eb-bills/${safeProject}/${safeMonth}/eb.pdf`;

    try {
      const publicUrl = await uploadToFirebase(
        req.file.buffer,
        storagePath,
        req.file.mimetype
      );

      req.ebUpload = {
        storagePath,
        publicUrl,
        mimeType:  req.file.mimetype,
        sizeBytes: req.file.size
      };

      console.log(`[uploadEB] ✅ Uploaded to Firebase Storage: ${storagePath}`);
      next();
    } catch (err) {
      console.error('[uploadEB] ❌ Firebase upload failed:', err.message);
      return res.status(500).json({ error: 'EB PDF upload to Firebase failed.', detail: err.message });
    }
  }
];

module.exports = { parseAndUploadEB };