/**
 * brochureS3Store.js — isolated S3 storage helpers for the brochure engine.
 *
 * Wraps the shared backend/services/s3Service.js so the brochure routes/bridge
 * don't need to know S3 key layout or tenant-prefix rules. If S3 is not
 * configured (AWS_S3_BUCKET_NAME missing), every helper reports disabled and
 * the caller falls back to local-disk / base64 behavior.
 */
'use strict';

const s3Service = require('../services/s3Service');

function isEnabled() {
  return !!s3Service.BUCKET_NAME && !!s3Service.S3_BASE_URL;
}

function isS3Url(url) {
  if (!url || typeof url !== 'string' || !s3Service.S3_BASE_URL) return false;
  // Normalize URLs to handle trailing slashes consistently
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
  if (!isEnabled()) throw new Error('S3 not configured');
  const fileName = runFileName(runId, ext);
  return s3Service.uploadFile(buffer, fileName, contentType, tenantPrefix(tenantId, 'brochures'));
}

async function uploadBrochurePdf(tenantId, runId, pdfBuffer) {
  return uploadBrochureArtifact(tenantId, runId, pdfBuffer, 'pdf', 'application/pdf');
}

async function uploadBrochureHtml(tenantId, runId, htmlBuffer) {
  return uploadBrochureArtifact(tenantId, runId, htmlBuffer, 'html', 'text/html');
}

async function uploadBrandImage(tenantId, file) {
  if (!isEnabled()) throw new Error('S3 not configured');
  return s3Service.uploadImage(
    file.buffer,
    file.originalname || 'brand-image',
    file.mimetype,
    tenantPrefix(tenantId, 'brand-kits'),
  );
}

async function deleteBrandImage(tenantId, url) {
  if (!isEnabled()) return { deleted: false, reason: 's3-disabled' };
  const key = s3Service.extractKeyFromUrl(url);
  if (!key || !isTenantKey(tenantId, key, 'brand-kits')) {
    return { deleted: false, reason: 'not-owned-or-unparseable' };
  }
  try {
    await s3Service.deleteFile(key);
    return { deleted: true };
  } catch (err) {
    // Ignore not-found errors; everything else is logged but not thrown so preset
    // CRUD doesn't fail because of a stale/missing S3 object.
    if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.code === 'NoSuchKey') {
      return { deleted: true, reason: 'already-gone' };
    }
    console.error('[brochureS3Store] deleteBrandImage failed:', err.message);
    return { deleted: false, reason: err.message };
  }
}

function extractBrochureKey(tenantId, url) {
  if (!isS3Url(url)) {
    console.log('[brochureS3Store] extractBrochureKey: not an S3 URL -', url);
    return null;
  }
  const key = s3Service.extractKeyFromUrl(url);
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
 * Stream a brochure artifact back from S3. Validates that the URL belongs to
 * the requesting tenant before streaming so one tenant can't probe another's
 * S3 keys.
 * @param {number} tenantId
 * @param {string} url - Full S3 URL stored on the brochure row
 * @returns {Promise<{ stream: import('stream').Readable, contentType?: string, contentLength?: number, contentDisposition?: string }>}
 */
async function streamBrochure(tenantId, url) {
  if (!isEnabled()) throw new Error('S3 not configured');
  const key = extractBrochureKey(tenantId, url);
  if (!key) {
    // Log for debugging: the URL doesn't match the expected tenant brochure pattern
    console.warn(
      '[brochureS3Store] streamBrochure: invalid or mismatched URL for tenant',
      tenantId,
      '— url:',
      url
    );
    throw new Error('Not a valid S3 brochure URL for this tenant');
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
  deleteBrandImage,
  streamBrochure,
  extractBrochureKey,
};
