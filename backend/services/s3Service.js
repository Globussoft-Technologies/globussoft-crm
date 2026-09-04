/**
 * AWS S3 Service — Image & File Upload Management
 *
 * Storage compatibility service. New uploads use OCI Object Storage when OCI_*
 * credentials are configured; AWS S3 remains supported only for legacy objects
 * and deployments that have not yet supplied OCI credentials. Keeping this
 * module's public API stable avoids changing route contracts throughout CRM.
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
const ociService = require('./ociObjectStorageService');
const fs = require('fs');
const path = require('path');

// Local-disk fallback root — used ONLY when neither OCI nor AWS S3 is
// configured (typical local dev: no cloud creds in .env). Without this,
// uploadFile() unconditionally threw "S3 bucket not configured", which is
// what broke PDF template uploads (and anything else routed through this
// module) for anyone developing locally with zero cloud creds — a real gap,
// since local dev with no keys is meant to just work. Served back via the
// existing `/api/uploads` static route (server.js) that several other
// upload paths already rely on.
const LOCAL_UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const LOCAL_URL_PREFIX = '/api/uploads/';

const SAFE_LOCAL_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  // SVG is active content when served inline from the CRM origin. Keep the
  // bytes downloadable, but never give the local fallback an .svg suffix.
  'image/svg+xml': '.bin',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/ogg': '.ogv',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/csv': '.csv',
};

function resolveLocalPath(key) {
  if (typeof key !== 'string' || !key || key.includes('\0')) return null;
  // Treat backslashes as separators too so this remains safe on Windows and
  // a Windows-shaped key cannot become dangerous after deployment moves.
  const portableKey = key.replace(/\\/g, '/');
  if (path.posix.isAbsolute(portableKey)) return null;
  const resolved = path.resolve(LOCAL_UPLOAD_ROOT, portableKey);
  const relative = path.relative(LOCAL_UPLOAD_ROOT, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function isLocalUrl(url) {
  return typeof url === 'string' && url.startsWith(LOCAL_URL_PREFIX);
}

// The local-disk counterpart of extractKeyFromUrl(), kept separate so the
// cloud-vs-disk distinction stays explicit at every call site.
function localKeyFromUrl(url) {
  if (!isLocalUrl(url)) return null;
  const key = url.slice(LOCAL_URL_PREFIX.length);
  return resolveLocalPath(key) ? key : null;
}

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const AWS_BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;
const AWS_S3_BASE_URL = process.env.AWS_S3_URL;
// These exported names are retained for all current callers.  With OCI
// configured they describe the active object store, not AWS.
const BUCKET_NAME = ociService.isConfigured() ? ociService.BUCKET_NAME : AWS_BUCKET_NAME;
const S3_BASE_URL = ociService.isConfigured()
  ? ociService.buildObjectUrl('').replace(/\/$/, '')
  : AWS_S3_BASE_URL;

if (!BUCKET_NAME) {
  console.warn("⚠️  Object storage (OCI/S3) is not configured — uploads will be written to local disk under backend/uploads/ instead. Fine for local dev; set OCI_* or AWS_S3_* env vars for anything that needs to persist beyond this machine.");
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
  if (ociService.isConfigured()) {
    return ociService.uploadFile(fileBody, fileName, mimeType, subfolder, opts);
  }

  const timestamp = Date.now();
  let sanitizedName = fileName
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "_")
    .substring(0, 50);
  if (!BUCKET_NAME) {
    const safeExt = SAFE_LOCAL_EXTENSIONS[mimeType] || '.bin';
    const stem = path.basename(sanitizedName, path.extname(sanitizedName)).slice(0, 50 - safeExt.length) || 'file';
    sanitizedName = `${stem}${safeExt}`;
  }
  // Ensure subfolder path includes all segments (e.g., "brochures/123" not just "brochures")
  const fileKey = `${subfolder}/${timestamp}-${sanitizedName}`;

  if (!BUCKET_NAME) {
    // No cloud storage configured at all — write to local disk instead of
    // failing the upload outright. Returns a server-relative URL under the
    // same /api/uploads convention other routes already use, so every
    // downstream consumer (fetch-back, delete, trust checks) can keep
    // treating "the URL on the row" as the single source of truth.
    const localPath = resolveLocalPath(fileKey);
    if (!localPath) throw new Error('Invalid local upload path.');
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    await fs.promises.writeFile(localPath, fileBody);
    return `${LOCAL_URL_PREFIX}${fileKey}`;
  }

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
async function deleteFile(fileKey, opts = {}) {
  if (ociService.isConfigured() && opts.provider !== 'aws') return ociService.deleteFile(fileKey);
  if (!BUCKET_NAME) {
    // Local-disk fallback — mirrors uploadFile's fallback. A missing file
    // (already deleted, or never local to begin with) is a no-op, not an
    // error — deleteFile callers already treat "gone" as success.
    try {
      const localKey = isLocalUrl(fileKey) ? localKeyFromUrl(fileKey) : fileKey;
      const localPath = resolveLocalPath(localKey);
      if (!localPath) throw new Error('Invalid local file path.');
      await fs.promises.unlink(localPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return;
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
async function getSignedUrl(fileKey, expiresIn = 3600, opts = {}) {
  if (ociService.isConfigured() && opts.provider !== 'aws') return ociService.getSignedUrl(fileKey, expiresIn);
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
async function getObjectStream(fileKey, opts = {}) {
  if (ociService.isConfigured() && opts.provider !== 'aws') return ociService.getObjectStream(fileKey);
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
  if (!s3Url) return null;
  // Deliberately does NOT claim local-disk URLs. Callers use this as a
  // 'is this object in cloud storage?' test — passportFileStore.inferStorage()
  // and visaDocStore both branch on it — so returning a key for an
  // /api/uploads/ path made every locally-stored file look like S3 and sent
  // those callers down the signed-URL path for a file that is on disk.
  // Use isLocalUrl() explicitly for the local case; localKeyFromUrl() below
  // is the local equivalent of this function.
  const ociKey = ociService.extractKeyFromUrl(s3Url);
  if (ociKey) return ociKey;
  if (!AWS_S3_BASE_URL) return null;

  // Normalize URLs to handle trailing slashes
  const normalizedBaseUrl = AWS_S3_BASE_URL.replace(/\/$/, '');
  const normalizedUrl = s3Url.replace(/\/$/, '');

  if (normalizedUrl.startsWith(normalizedBaseUrl + '/')) {
    return normalizedUrl.replace(normalizedBaseUrl + '/', '');
  }
  return null;
}

/**
 * Read back a file that uploadFile() wrote to local disk (the no-cloud-creds
 * fallback). Returns null for anything that isn't a local-fallback URL, or
 * that can't be read — callers already treat null as "couldn't fetch this
 * one, degrade gracefully" for the equivalent HTTP-fetch path.
 * @param {string} url
 * @returns {Promise<Buffer|null>}
 */
async function readLocalFile(url) {
  const key = localKeyFromUrl(url);
  if (!key) return null;
  const localPath = resolveLocalPath(key);
  if (!localPath) return null;
  try {
    return await fs.promises.readFile(localPath);
  } catch {
    return null;
  }
}

module.exports = {
  uploadFile,
  uploadImage,
  deleteFile,
  getSignedUrl,
  getObjectStream,
  extractKeyFromUrl,
  isLocalUrl,
  localKeyFromUrl,
  resolveLocalPath,
  readLocalFile,
  s3Client,
  BUCKET_NAME,
  S3_BASE_URL,
  AWS_BUCKET_NAME,
  AWS_S3_BASE_URL,
  isConfigured: () => Boolean(BUCKET_NAME),
  isOciUrl: ociService.isOciUrl,
};
