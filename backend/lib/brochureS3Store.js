/**
 * brochureS3Store.js — isolated object-storage helpers for the brochure engine.
 *
 * Wraps backend/services/s3Service.js AND backend/services/ociObjectStorageService.js
 * so the brochure routes/bridge don't need to know key layout or tenant-prefix rules.
 *
 * Priority:
 *   1. OCI Object Storage (OCI_* env vars) — used for new uploads when configured.
 *   2. AWS S3 (AWS_* env vars) — used for new uploads when OCI is not configured.
 *   3. Local disk / base64 fallback — when neither object store is configured.
 *
 * Reads (stream/delete) detect the URL type (OCI native URL vs S3 URL) and use the
 * matching service, so historical S3 brochures keep working after a migration.
 */
'use strict';

const s3Service = require('../services/s3Service');
const ociService = require('../services/ociObjectStorageService');

function isS3Configured() {
  return !!s3Service.BUCKET_NAME && !!s3Service.S3_BASE_URL;
}

function isEnabled() {
  return isS3Configured() || ociService.isConfigured();
}

function isS3Url(url) {
  if (!url || typeof url !== 'string') return false;
  // Native OCI URL produced by ociService.
  if (ociService.isOciUrl(url)) return true;
  // Legacy S3 URL.
  if (!s3Service.S3_BASE_URL) return false;
  const normalizedBaseUrl = s3Service.S3_BASE_URL.replace(/\/$/, '');
  const normalizedUrl = url.replace(/\/$/, '');
  return normalizedUrl.startsWith(normalizedBaseUrl + '/') || normalizedUrl === normalizedBaseUrl;
}

function tenantPrefix(tenantId, category) {
  const safeTenant = Number.isInteger(tenantId) ? tenantId : 0;
  return `${category}/${safeTenant}`;
}

function isTenantKey(tenantId, fileKey, category) {
  const prefix = tenantPrefix(tenantId, category) + '/';
  return typeof fileKey === 'string' && fileKey.startsWith(prefix);
}

function runFileName(runId, ext) {
  const safeRunId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '');
  const safeExt = String(ext || 'pdf').replace(/[^a-z0-9]/gi, '');
  return `${safeRunId}.${safeExt}`;
}

async function uploadBrochureArtifact(tenantId, runId, buffer, ext, contentType) {
  if (!isEnabled()) throw new Error('Object storage not configured');
  const fileName = runFileName(runId, ext);
  const prefix = tenantPrefix(tenantId, 'brochures');
  if (ociService.isConfigured()) {
    return ociService.uploadFile(buffer, fileName, contentType, prefix);
  }
  return s3Service.uploadFile(buffer, fileName, contentType, prefix);
}

async function uploadBrochurePdf(tenantId, runId, pdfBuffer) {
  return uploadBrochureArtifact(tenantId, runId, pdfBuffer, 'pdf', 'application/pdf');
}

async function uploadBrochureHtml(tenantId, runId, htmlBuffer) {
  return uploadBrochureArtifact(tenantId, runId, htmlBuffer, 'html', 'text/html');
}

async function uploadBrandImage(tenantId, file) {
  if (!isEnabled()) throw new Error('Object storage not configured');
  const prefix = tenantPrefix(tenantId, 'brand-kits');
  if (ociService.isConfigured()) {
    return ociService.uploadImage(
      file.buffer,
      file.originalname || 'brand-image',
      file.mimetype,
      prefix,
    );
  }
  return s3Service.uploadImage(
    file.buffer,
    file.originalname || 'brand-image',
    file.mimetype,
    prefix,
  );
}

/**
 * Store an operator-supplied REFERENCE document (itinerary/costing/flight/
 * hotel/terms file) for the Brochure Engine's Source Control step. These are
 * never parsed or fed to the composer — they're an audit trail of what the
 * operator worked from, mirroring Block 1's "use only the approved brief"
 * discipline. Any file type is accepted (route-level filter still applies).
 */
async function uploadReferenceFile(tenantId, file) {
  if (!isEnabled()) throw new Error('Object storage not configured');
  const prefix = tenantPrefix(tenantId, 'brochure-reference-files');
  if (ociService.isConfigured()) {
    return ociService.uploadFile(
      file.buffer,
      file.originalname || 'reference-file',
      file.mimetype,
      prefix,
    );
  }
  return s3Service.uploadFile(
    file.buffer,
    file.originalname || 'reference-file',
    file.mimetype,
    prefix,
  );
}

async function deleteBrandImage(tenantId, url) {
  if (!isEnabled()) return { deleted: false, reason: 'object-storage-disabled' };
  let key;
  if (ociService.isOciUrl(url)) {
    key = ociService.extractKeyFromUrl(url);
  } else {
    key = s3Service.extractKeyFromUrl(url);
  }
  if (!key || !isTenantKey(tenantId, key, 'brand-kits')) {
    return { deleted: false, reason: 'not-owned-or-unparseable' };
  }
  try {
    if (ociService.isOciUrl(url)) {
      await ociService.deleteFile(key);
    } else {
      await s3Service.deleteFile(key);
    }
    return { deleted: true };
  } catch (err) {
    // Ignore not-found errors; everything else is logged but not thrown so preset
    // CRUD doesn't fail because of a stale/missing object.
    if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.code === 'NoSuchKey') {
      return { deleted: true, reason: 'already-gone' };
    }
    console.error('[brochureS3Store] deleteBrandImage failed:', err.message);
    return { deleted: false, reason: err.message };
  }
}

function extractBrochureKey(tenantId, url) {
  if (!isS3Url(url)) {
    console.log('[brochureS3Store] extractBrochureKey: not an object-storage URL -', url);
    return null;
  }
  let key;
  if (ociService.isOciUrl(url)) {
    key = ociService.extractKeyFromUrl(url);
  } else {
    key = s3Service.extractKeyFromUrl(url);
  }
  if (!key) {
    console.log('[brochureS3Store] extractBrochureKey: could not extract key from URL -', url);
    return null;
  }
  if (!isTenantKey(tenantId, key, 'brochures')) {
    console.log(
      '[brochureS3Store] extractBrochureKey: key does not belong to tenant',
      tenantId,
      '— key:',
      key,
      'expected prefix: brochures/' + tenantId + '/'
    );
    return null;
  }
  return key;
}

/**
 * Stream a brochure artifact back from object storage. Validates that the URL
 * belongs to the requesting tenant before streaming so one tenant can't probe
 * another's object keys.
 * @param {number} tenantId
 * @param {string} url - Full object-storage URL stored on the brochure row
 * @returns {Promise<{ stream: import('stream').Readable, contentType?: string, contentLength?: number, contentDisposition?: string }>}
 */
async function streamBrochure(tenantId, url) {
  if (!isEnabled()) throw new Error('Object storage not configured');
  const key = extractBrochureKey(tenantId, url);
  if (!key) {
    console.warn(
      '[brochureS3Store] streamBrochure: invalid or mismatched URL for tenant',
      tenantId,
      '— url:',
      url
    );
    throw new Error('Not a valid S3 brochure URL for this tenant');
  }
  if (ociService.isOciUrl(url)) {
    return ociService.getObjectStream(key);
  }
  return s3Service.getObjectStream(key);
}

module.exports = {
  isEnabled,
  isS3Url,
  uploadBrochurePdf,
  uploadBrochureHtml,
  uploadBrochureArtifact,
  uploadBrandImage,
  uploadReferenceFile,
  deleteBrandImage,
  streamBrochure,
  extractBrochureKey,
};
