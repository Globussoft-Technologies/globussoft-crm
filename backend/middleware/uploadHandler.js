/**
 * Multer Upload Middleware
 *
 * Configures multer for handling multipart/form-data file uploads.
 * Supports multiple file types with size limits and validation.
 *
 * Usage in routes:
 *   const { uploadSingle, uploadMultiple, validateImage } = require('../middleware/uploadHandler');
 *   router.post('/upload', uploadSingle('photo'), validateImage, controller);
 */

const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Configure storage (temporary, files are deleted after S3 upload)
const memoryStorage = multer.memoryStorage();

// Documents are now written to a temp directory so large files (up to 150 MB)
// don't bloat the Node heap. Routes that use these handlers read from disk
// and are responsible for deleting the temp file after S3 upload.
const documentTempDir = path.join(os.tmpdir(), "globuscrm-uploads-documents");
function ensureDocumentTempDir() {
  try {
    fs.mkdirSync(documentTempDir, { recursive: true });
  } catch {
    /* best-effort */
  }
}
ensureDocumentTempDir();

const diskStorageDocuments = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, documentTempDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
    cb(null, `${unique}${ext}`);
  },
});

// File filter for images
const imageFilter = (req, file, cb) => {
  const allowedMimes = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",
  ];
  const allowedExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];

  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedMimes.includes(file.mimetype) && allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid image format. Allowed: JPG, PNG, GIF, WebP, SVG"));
  }
};

// File filter for documents (PDFs, Word, Excel, etc.)
const documentFilter = (req, file, cb) => {
  const allowedMimes = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
  ];
  const allowedExts = [
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".csv",
  ];

  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedMimes.includes(file.mimetype) && allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Invalid document format. Allowed: PDF, DOC, DOCX, XLS, XLSX, CSV"
      )
    );
  }
};

// 150 MB ceiling for documents. This matches the landing-page brochure
// upload and is large enough for media-heavy agency decks. The value is
// intentionally shared via this export so route tests can pin it.
const DOCUMENT_MAX_FILE_SIZE = 150 * 1024 * 1024;

// Image upload: single file
const uploadImageSingle = multer({
  storage: memoryStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single("image");

// Image upload: multiple files
const uploadImageMultiple = multer({
  storage: memoryStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
}).array("images", 10); // Max 10 files

// Document upload: single file
const uploadDocumentSingle = multer({
  storage: diskStorageDocuments,
  fileFilter: documentFilter,
  limits: { fileSize: DOCUMENT_MAX_FILE_SIZE }, // 150 MB
}).single("document");

// Document upload: multiple files
const uploadDocumentMultiple = multer({
  storage: diskStorageDocuments,
  fileFilter: documentFilter,
  limits: { fileSize: DOCUMENT_MAX_FILE_SIZE }, // 150 MB per file
}).array("documents", 5); // Max 5 files

// Validation middleware for image
const validateImage = (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: "No image file provided" });
  }
  next();
};

// Validation middleware for document
const validateDocument = (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: "No document file provided" });
  }
  next();
};

// Validation middleware for multiple images
const validateImages = (req, res, next) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No image files provided" });
  }
  next();
};

// Validation middleware for multiple documents
const validateDocuments = (req, res, next) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No document files provided" });
  }
  next();
};

module.exports = {
  uploadImageSingle,
  uploadImageMultiple,
  uploadDocumentSingle,
  uploadDocumentMultiple,
  validateImage,
  validateDocument,
  validateImages,
  validateDocuments,
  DOCUMENT_MAX_FILE_SIZE,
};
