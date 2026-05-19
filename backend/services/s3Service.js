/**
 * AWS S3 Service — Image & File Upload Management
 *
 * Handles uploading files to AWS S3 bucket.
 * All image uploads across the CRM (contacts, leads, products, prescriptions, etc.)
 * should use this service.
 *
 * Exported functions:
 *   uploadFile(fileBuffer, fileName, mimeType, subfolder)
 *   uploadImage(fileBuffer, fileName, mimeType, subfolder)
 *   deleteFile(fileKey)
 *   getSignedUrl(fileKey, expiresIn)
 *
 * Usage:
 *   const { uploadImage } = require('./services/s3Service');
 *   const url = await uploadImage(buffer, 'user-avatar.jpg', 'image/jpeg', 'avatars');
 */

const AWS = require("aws-sdk");

const s3Client = new AWS.S3({
  region: process.env.AWS_REGION || "us-east-1",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;
const S3_BASE_URL = process.env.AWS_S3_URL;

if (!BUCKET_NAME) {
  console.warn("⚠️  AWS_S3_BUCKET_NAME not configured. S3 uploads will fail.");
}

/**
 * Upload a file to S3
 * @param {Buffer} fileBuffer - The file content as buffer
 * @param {string} fileName - Original filename
 * @param {string} mimeType - MIME type (e.g. 'image/jpeg')
 * @param {string} subfolder - Subfolder in bucket (e.g. 'avatars', 'prescriptions')
 * @returns {Promise<string>} - Full S3 URL of uploaded file
 */
async function uploadFile(fileBuffer, fileName, mimeType, subfolder = "uploads") {
  if (!BUCKET_NAME) {
    throw new Error("S3 bucket not configured. Set AWS_S3_BUCKET_NAME env var.");
  }

  // Generate unique key with subfolder
  const timestamp = Date.now();
  const sanitizedName = fileName
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "_")
    .substring(0, 50);
  const fileKey = `${subfolder}/${timestamp}-${sanitizedName}`;

  const params = {
    Bucket: BUCKET_NAME,
    Key: fileKey,
    Body: fileBuffer,
    ContentType: mimeType,
    ACL: "public-read", // Makes file publicly readable
  };

  try {
    await s3Client.upload(params).promise();
    const fileUrl = `${S3_BASE_URL}/${fileKey}`;
    return fileUrl;
  } catch (error) {
    console.error("❌ S3 upload error:", error.message);
    throw new Error(`Failed to upload file to S3: ${error.message}`);
  }
}

/**
 * Upload an image file to S3
 * Convenience wrapper for uploadFile with image-specific subfolder
 * @param {Buffer} fileBuffer - Image buffer
 * @param {string} fileName - Original filename
 * @param {string} mimeType - Image MIME type
 * @param {string} subfolder - Subfolder (default: 'images')
 * @returns {Promise<string>} - Full S3 URL
 */
async function uploadImage(
  fileBuffer,
  fileName,
  mimeType,
  subfolder = "images"
) {
  // Validate MIME type
  const validImageMimes = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",
  ];
  if (!validImageMimes.includes(mimeType)) {
    throw new Error(`Invalid image MIME type: ${mimeType}`);
  }

  return uploadFile(fileBuffer, fileName, mimeType, subfolder);
}

/**
 * Delete a file from S3
 * @param {string} fileKey - S3 file key (without bucket URL)
 * @returns {Promise<void>}
 */
async function deleteFile(fileKey) {
  if (!BUCKET_NAME) {
    throw new Error("S3 bucket not configured.");
  }

  const params = {
    Bucket: BUCKET_NAME,
    Key: fileKey,
  };

  try {
    await s3Client.deleteObject(params).promise();
  } catch (error) {
    console.error("❌ S3 delete error:", error.message);
    throw new Error(`Failed to delete file from S3: ${error.message}`);
  }
}

/**
 * Generate a signed URL for temporary access to a private file
 * @param {string} fileKey - S3 file key
 * @param {number} expiresIn - Expiration in seconds (default: 3600 = 1 hour)
 * @returns {Promise<string>} - Signed URL
 */
async function getSignedUrl(fileKey, expiresIn = 3600) {
  if (!BUCKET_NAME) {
    throw new Error("S3 bucket not configured.");
  }

  const params = {
    Bucket: BUCKET_NAME,
    Key: fileKey,
    Expires: expiresIn,
  };

  try {
    const url = await s3Client.getSignedUrlPromise("getObject", params);
    return url;
  } catch (error) {
    console.error("❌ S3 signed URL error:", error.message);
    throw new Error(`Failed to generate signed URL: ${error.message}`);
  }
}

/**
 * Extract S3 key from full S3 URL
 * @param {string} s3Url - Full S3 URL
 * @returns {string} - S3 key
 */
function extractKeyFromUrl(s3Url) {
  if (!s3Url || !S3_BASE_URL) return null;
  if (s3Url.startsWith(S3_BASE_URL)) {
    return s3Url.replace(`${S3_BASE_URL}/`, "");
  }
  return null;
}

module.exports = {
  uploadFile,
  uploadImage,
  deleteFile,
  getSignedUrl,
  extractKeyFromUrl,
  s3Client,
  BUCKET_NAME,
  S3_BASE_URL,
};
