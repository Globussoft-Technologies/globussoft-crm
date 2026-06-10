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

// Configure storage (temporary, files are deleted after S3 upload)
const storage = multer.memoryStorage();

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

// Image upload: single file
const uploadImageSingle = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single("image");

// Image upload: multiple files
const uploadImageMultiple = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
}).array("images", 10); // Max 10 files

// Document upload: single file
const uploadDocumentSingle = multer({
  storage,
  fileFilter: documentFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
}).single("document");

// Document upload: multiple files
const uploadDocumentMultiple = multer({
  storage,
  fileFilter: documentFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
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
};
