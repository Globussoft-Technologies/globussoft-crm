/**
 * AWS S3 Service — Image & File Upload Management
 *
 * Handles uploading files to AWS S3 bucket.
 * All image uploads across the CRM (contacts, leads, products, prescriptions, etc.)
 * should use this service.
 *
 * Exported functions:
 *   uploadFile(fileBody, fileName, mimeType, subfolder)
 *   uploadImage(fileBuffer, fileName, mimeType, subfolder)
 *   deleteFile(fileKey)
 *   getSignedUrl(fileKey, expiresIn)
 *
 * Usage:
 *   const { uploadImage } = require('./services/s3Service');
 *   const url = await uploadImage(buffer, 'user-avatar.jpg', 'image/jpeg', 'avatars');
 */

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const {
  getSignedUrl: presignerGetSignedUrl,
} = require("@aws-sdk/s3-request-presigner");

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;
const S3_BASE_URL = process.env.AWS_S3_URL;

if (!BUCKET_NAME) {
  console.warn("⚠️  AWS_S3_BUCKET_NAME not configured. S3 uploads will fail.");
}

/**
 * Upload a file to S3
 * @param {Buffer|import('stream').Readable} fileBody - File content as buffer or readable stream
 * @param {string} fileName - Original filename
 * @param {string} mimeType - MIME type (e.g. 'image/jpeg')
 * @param {string} subfolder - Subfolder in bucket (e.g. 'avatars', 'prescriptions')
 * @param {{ contentDisposition?: string }} [opts] - Optional S3 object options.
 *   contentDisposition: e.g. 'attachment; filename="brochure.pdf"' so the
 *   object DOWNLOADS instead of opening inline in the browser. Omit it for
 *   images/videos that must render/play inline on the page.
 * @returns {Promise<string>} - Full S3 URL of uploaded file
 */
async function uploadFile(
  fileBody,
  fileName,
  mimeType,
  subfolder = "uploads",
  opts = {},
) {
  if (!BUCKET_NAME) {
    throw new Error(
      "S3 bucket not configured. Set AWS_S3_BUCKET_NAME env var.",
    );
  }

  const timestamp = Date.now();
  const sanitizedName = fileName
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "_")
    .substring(0, 50);
  // Ensure subfolder path includes all segments (e.g., "brochures/123" not just "brochures")
  const fileKey = `${subfolder}/${timestamp}-${sanitizedName}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
    Body: fileBody,
    ContentType: mimeType,
    // Only set when provided (e.g. brochures → force download). Left off for
    // images/videos so they stay inline.
    ...(opts.contentDisposition
      ? { ContentDisposition: opts.contentDisposition }
      : {}),
  });

  try {
    await s3Client.send(command);
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
  subfolder = "images",
) {
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

  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });

  try {
    await s3Client.send(command);
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

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });

  try {
    const url = await presignerGetSignedUrl(s3Client, command, { expiresIn });
    return url;
  } catch (error) {
    console.error("❌ S3 signed URL error:", error.message);
    throw new Error(`Failed to generate signed URL: ${error.message}`);
  }
}

/**
 * Stream an object from S3. Useful when the backend wants to proxy a private
 * object to a client without making the bucket world-readable.
 * @param {string} fileKey - S3 file key
 * @returns {Promise<{ stream: import('stream').Readable, contentType?: string, contentLength?: number, contentDisposition?: string, lastModified?: Date }>}
 */
async function getObjectStream(fileKey) {
  if (!BUCKET_NAME) {
    throw new Error("S3 bucket not configured.");
  }

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });

  try {
    const response = await s3Client.send(command);
    return {
      stream: response.Body,
      contentType: response.ContentType,
      contentLength: response.ContentLength,
      contentDisposition: response.ContentDisposition,
      lastModified: response.LastModified,
    };
  } catch (error) {
    console.error("❌ S3 getObject error:", error.message);
    throw new Error(`Failed to fetch file from S3: ${error.message}`);
  }
}

/**
 * Extract S3 key from full S3 URL
 * @param {string} s3Url - Full S3 URL
 * @returns {string} - S3 key
 */
function extractKeyFromUrl(s3Url) {
  if (!s3Url || !S3_BASE_URL) return null;

  // Normalize URLs to handle trailing slashes
  const normalizedBaseUrl = S3_BASE_URL.replace(/\/$/, '');
  const normalizedUrl = s3Url.replace(/\/$/, '');

  if (normalizedUrl.startsWith(normalizedBaseUrl + '/')) {
    return normalizedUrl.replace(normalizedBaseUrl + '/', '');
  }
  return null;
}

module.exports = {
  uploadFile,
  uploadImage,
  deleteFile,
  getSignedUrl,
  getObjectStream,
  extractKeyFromUrl,
  s3Client,
  BUCKET_NAME,
  S3_BASE_URL,
};
