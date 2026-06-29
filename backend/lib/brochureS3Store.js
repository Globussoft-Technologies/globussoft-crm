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
  return typeof url === 'string' && s3Service.S3_BASE_URL && url.startsWith(s3Service.S3_BASE_URL);
}

function tenantPrefix(tenantId, category) {
  const safeTenant = Number.isInteger(tenantId) ? tenantId : 0;
  return `${category}/${safeTenant}`;
}

function isTenantKey(tenantId, fileKey, category) {
  const prefix = tenantPrefix(tenantId, category) + '/';
  return typeof fileKey === 'string' && fileKey.startsWith(prefix);
}

async function uploadBrochurePdf(tenantId, runId, pdfBuffer) {
  if (!isEnabled()) throw new Error('S3 not configured');
  const fileName = `${String(runId).replace(/[^a-zA-Z0-9_-]/g, '')}.pdf`;
  return s3Service.uploadFile(pdfBuffer, fileName, 'application/pdf', tenantPrefix(tenantId, 'brochures'));
}

async function uploadBrochureHtml(tenantId, runId, htmlBuffer) {
  if (!isEnabled()) throw new Error('S3 not configured');
  const fileName = `${String(runId).replace(/[^a-zA-Z0-9_-]/g, '')}.html`;
  return s3Service.uploadFile(htmlBuffer, fileName, 'text/html', tenantPrefix(tenantId, 'brochures'));
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

module.exports = {
  isEnabled,
  isS3Url,
  uploadBrochurePdf,
  uploadBrochureHtml,
  uploadBrandImage,
  deleteBrandImage,
};
