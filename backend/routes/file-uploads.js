/**
 * File Upload Routes
 *
 * Handles all image and document uploads to AWS S3.
 * Mount this route in server.js: app.use('/api/uploads', uploadsRouter);
 *
 * Endpoints:
 *   POST /api/uploads/image - Upload single image
 *   POST /api/uploads/images - Upload multiple images
 *   POST /api/uploads/document - Upload single document
 *   POST /api/uploads/documents - Upload multiple documents
 *   DELETE /api/uploads/file/:fileKey - Delete file from S3
 */

const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const {
  uploadImageSingle,
  uploadImageMultiple,
  uploadDocumentSingle,
  uploadDocumentMultiple,
  validateImage,
  validateImages,
  validateDocument,
  validateDocuments,
} = require("../middleware/uploadHandler");
const {
  uploadImage,
  uploadFile,
  deleteFile,
  extractKeyFromUrl,
} = require("../services/s3Service");

// Protect all upload routes with authentication
router.use(verifyToken);

/**
 * POST /api/uploads/image
 * Upload a single image file
 * Required: multipart/form-data with 'image' field
 * Returns: { url: "https://s3-url...", fileName: "..." }
 */
router.post("/image", uploadImageSingle, validateImage, async (req, res) => {
  try {
    const file = req.file;

    // Upload to S3
    const fileUrl = await uploadImage(
      file.buffer,
      file.originalname,
      file.mimetype,
      "images"
    );

    res.json({
      success: true,
      url: fileUrl,
      fileName: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({
      error: error.message || "Failed to upload image",
    });
  }
});

/**
 * POST /api/uploads/images
 * Upload multiple image files
 * Required: multipart/form-data with 'images' field (array)
 * Returns: { urls: [...], count: N }
 */
router.post("/images", uploadImageMultiple, validateImages, async (req, res) => {
  try {
    const files = req.files;

    // Upload all files to S3 in parallel
    const uploadPromises = files.map((file) =>
      uploadImage(file.buffer, file.originalname, file.mimetype, "images")
    );

    const urls = await Promise.all(uploadPromises);

    res.json({
      success: true,
      count: urls.length,
      urls: urls.map((url, index) => ({
        url,
        fileName: files[index].originalname,
        size: files[index].size,
      })),
    });
  } catch (error) {
    console.error("Batch upload error:", error);
    res.status(500).json({
      error: error.message || "Failed to upload images",
    });
  }
});

/**
 * POST /api/uploads/document
 * Upload a single document file
 * Required: multipart/form-data with 'document' field
 * Returns: { url: "https://s3-url...", fileName: "..." }
 */
router.post(
  "/document",
  uploadDocumentSingle,
  validateDocument,
  async (req, res) => {
    try {
      const file = req.file;

      // Upload to S3
      const fileUrl = await uploadFile(
        file.buffer,
        file.originalname,
        file.mimetype,
        "documents"
      );

      res.json({
        success: true,
        url: fileUrl,
        fileName: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
      });
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({
        error: error.message || "Failed to upload document",
      });
    }
  }
);

/**
 * POST /api/uploads/documents
 * Upload multiple document files
 * Required: multipart/form-data with 'documents' field (array)
 * Returns: { urls: [...], count: N }
 */
router.post(
  "/documents",
  uploadDocumentMultiple,
  validateDocuments,
  async (req, res) => {
    try {
      const files = req.files;

      // Upload all files to S3 in parallel
      const uploadPromises = files.map((file) =>
        uploadFile(
          file.buffer,
          file.originalname,
          file.mimetype,
          "documents"
        )
      );

      const urls = await Promise.all(uploadPromises);

      res.json({
        success: true,
        count: urls.length,
        urls: urls.map((url, index) => ({
          url,
          fileName: files[index].originalname,
          size: files[index].size,
        })),
      });
    } catch (error) {
      console.error("Batch upload error:", error);
      res.status(500).json({
        error: error.message || "Failed to upload documents",
      });
    }
  }
);

/**
 * DELETE /api/uploads/file/:fileKey
 * Delete a file from S3
 * Required: fileKey (S3 object key or encoded URL)
 * Returns: { success: true }
 */
router.delete("/file/:fileKey", async (req, res) => {
  try {
    let fileKey = req.params.fileKey;

    // If fileKey is URL-encoded, decode it
    fileKey = decodeURIComponent(fileKey);

    // If full S3 URL provided, extract the key
    if (fileKey.includes("s3")) {
      const extracted = extractKeyFromUrl(fileKey);
      if (extracted) fileKey = extracted;
    }

    await deleteFile(fileKey);

    res.json({
      success: true,
      message: "File deleted successfully",
    });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({
      error: error.message || "Failed to delete file",
    });
  }
});

module.exports = router;
