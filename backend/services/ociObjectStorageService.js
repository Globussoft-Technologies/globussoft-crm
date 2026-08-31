/**
 * OCI Object Storage Service — S3-compatible API wrapper for Oracle Cloud.
 *
 * Uses the already-installed AWS SDK v3 against OCI's S3-compatible endpoint
 * so we don't add a new dependency. Public URLs are returned in OCI's native
 * format: https://objectstorage.<region>.oraclecloud.com/n/<namespace>/b/<bucket>/o/<key>
 *
 * Required env vars:
 *   OCI_ACCESS_KEY_ID, OCI_SECRET_ACCESS_KEY, OCI_REGION,
 *   OCI_BUCKET_NAME, OCI_NAMESPACE
 * Optional:
 *   OCI_ENDPOINT_URL (defaults to https://<namespace>.compat.objectstorage.<region>.oraclecloud.com)
 */
'use strict';

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');

const ACCESS_KEY_ID = (process.env.OCI_ACCESS_KEY_ID || '').trim();
const SECRET_ACCESS_KEY = (process.env.OCI_SECRET_ACCESS_KEY || '').trim();
const REGION = (process.env.OCI_REGION || '').trim();
const BUCKET_NAME = (process.env.OCI_BUCKET_NAME || '').trim();
const NAMESPACE = (process.env.OCI_NAMESPACE || '').trim();
const ENDPOINT_URL = (process.env.OCI_ENDPOINT_URL || '').trim();

function isConfigured() {
  return !!(ACCESS_KEY_ID && SECRET_ACCESS_KEY && REGION && BUCKET_NAME && NAMESPACE);
}

function getEndpoint() {
  if (ENDPOINT_URL) return ENDPOINT_URL;
  return `https://${NAMESPACE}.compat.objectstorage.${REGION}.oraclecloud.com`;
}

function getClient() {
  if (!isConfigured()) {
    throw new Error('OCI Object Storage is not configured');
  }
  return new S3Client({
    region: REGION,
    endpoint: getEndpoint(),
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
    // OCI S3-compatible API does not support AWS SDK v3's default checksum
    // headers; sending them causes "Unable to parse Authorization header" errors.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function buildObjectUrl(fileKey) {
  if (!isConfigured()) return null;
  return `https://objectstorage.${REGION}.oraclecloud.com/n/${NAMESPACE}/b/${BUCKET_NAME}/o/${fileKey}`;
}

function extractKeyFromUrl(url) {
  if (!isConfigured() || !url) return null;
  const prefix = `https://objectstorage.${REGION}.oraclecloud.com/n/${NAMESPACE}/b/${BUCKET_NAME}/o/`;
  const normalizedUrl = url.replace(/\/$/, '');
  const normalizedPrefix = prefix.replace(/\/$/, '');
  if (!normalizedUrl.startsWith(normalizedPrefix + '/')) return null;
  return normalizedUrl.slice(normalizedPrefix.length + 1);
}

function isOciUrl(url) {
  return !!extractKeyFromUrl(url);
}

async function uploadFile(fileBody, fileName, mimeType, subfolder = 'uploads', opts = {}) {
  if (!isConfigured()) {
    throw new Error('OCI Object Storage is not configured');
  }

  const timestamp = Date.now();
  const sanitizedName = String(fileName || 'file')
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '_')
    .substring(0, 50);
  const fileKey = `${subfolder}/${timestamp}-${sanitizedName}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
    Body: fileBody,
    ContentType: mimeType,
    ...(opts.contentDisposition
      ? { ContentDisposition: opts.contentDisposition }
      : {}),
  });

  try {
    await getClient().send(command);
    return buildObjectUrl(fileKey);
  } catch (error) {
    console.error('❌ OCI upload error:', error.message);
    throw new Error(`Failed to upload file to OCI: ${error.message}`);
  }
}

async function uploadImage(fileBuffer, fileName, mimeType, subfolder = 'images') {
  const validImageMimes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
  ];
  if (!validImageMimes.includes(mimeType)) {
    throw new Error(`Invalid image MIME type: ${mimeType}`);
  }
  return uploadFile(fileBuffer, fileName, mimeType, subfolder);
}

async function deleteFile(fileKey) {
  if (!isConfigured()) {
    throw new Error('OCI Object Storage is not configured');
  }
  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });
  try {
    await getClient().send(command);
  } catch (error) {
    console.error('❌ OCI delete error:', error.message);
    throw new Error(`Failed to delete file from OCI: ${error.message}`);
  }
}

async function getObjectStream(fileKey) {
  if (!isConfigured()) {
    throw new Error('OCI Object Storage is not configured');
  }
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });
  try {
    const response = await getClient().send(command);
    return {
      stream: response.Body,
      contentType: response.ContentType,
      contentLength: response.ContentLength,
      contentDisposition: response.ContentDisposition,
      lastModified: response.LastModified,
    };
  } catch (error) {
    console.error('❌ OCI getObject error:', error.message);
    throw new Error(`Failed to fetch file from OCI: ${error.message}`);
  }
}

module.exports = {
  isConfigured,
  getEndpoint,
  buildObjectUrl,
  extractKeyFromUrl,
  isOciUrl,
  uploadFile,
  uploadImage,
  deleteFile,
  getObjectStream,
  BUCKET_NAME,
  NAMESPACE,
  REGION,
  ENDPOINT_URL,
};
