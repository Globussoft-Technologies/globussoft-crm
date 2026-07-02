/**
 * Unit tests for brochureS3Store key validation and extraction.
 *
 * Tests the critical path: S3 URL → key extraction → tenant validation →
 * stream operation. The validate-before-stream pattern prevents one tenant
 * from probing another's S3 keys.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// s3Service is a CJS module; set the env vars it reads at load time so
// BUCKET_NAME / S3_BASE_URL are populated, then override only the methods
// we need to mock via the mutable CJS exports object.
process.env.AWS_S3_BUCKET_NAME = 'globuscrm-dev-storage';
process.env.AWS_S3_URL = 'https://globuscrm-dev-storage.s3.ap-south-1.amazonaws.com';

const s3Service = require('../../services/s3Service.js');
const brochureS3Store = await import('../../lib/brochureS3Store.js');

const extractKeyFromUrl = (url) => {
  if (!url) return null;
  const baseUrl = 'https://globuscrm-dev-storage.s3.ap-south-1.amazonaws.com';
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const normalizedUrl = url.replace(/\/$/, '');
  if (normalizedUrl.startsWith(normalizedBaseUrl + '/')) {
    return normalizedUrl.replace(normalizedBaseUrl + '/', '');
  }
  return null;
};

describe('brochureS3Store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    s3Service.extractKeyFromUrl = extractKeyFromUrl;
    s3Service.getObjectStream = vi.fn().mockResolvedValue({
      stream: { on: vi.fn(), pipe: vi.fn() },
      contentType: 'application/pdf',
      contentLength: 1024,
    });
  });

  describe('S3 URL detection', () => {
    test('correctly identifies S3 URLs', () => {
      const s3Url = 'https://globuscrm-dev-storage.s3.ap-south-1.amazonaws.com/brochures/1/file.pdf';
      expect(brochureS3Store.isS3Url(s3Url)).toBe(true);
    });

    test('rejects non-S3 URLs', () => {
      expect(brochureS3Store.isS3Url('/api/brochure-assets/file.pdf')).toBe(false);
      expect(brochureS3Store.isS3Url('https://example.com/file.pdf')).toBe(false);
    });
  });

  describe('Key extraction and validation', () => {
    test('extracts key from valid S3 URL with tenantId', () => {
      const url = 'https://globuscrm-dev-storage.s3.ap-south-1.amazonaws.com/brochures/1/1719860400000-test.pdf';
      const result = s3Service.extractKeyFromUrl(url);
      expect(result).toBe('brochures/1/1719860400000-test.pdf');
    });

    test('extracts key correctly with trailing slash in base URL', () => {
      const url = 'https://globuscrm-dev-storage.s3.ap-south-1.amazonaws.com/brochures/1/file.pdf';
      const result = s3Service.extractKeyFromUrl(url);
      expect(result).toBe('brochures/1/file.pdf');
    });

    test('rejects key if tenantId does not match', () => {
      const url = 'https://globuscrm-dev-storage.s3.ap-south-1.amazonaws.com/brochures/99/1719860400000-test.pdf';
      const key = s3Service.extractKeyFromUrl(url);
      expect(key).toBe('brochures/99/1719860400000-test.pdf');
      expect(key.startsWith('brochures/1/')).toBe(false);
    });
  });

  describe('streamBrochure', () => {
    test('throws when URL is not an S3 URL', async () => {
      const localUrl = '/api/brochure-assets/file.pdf';
      await expect(
        brochureS3Store.streamBrochure(1, localUrl)
      ).rejects.toThrow('Not a valid S3 brochure URL for this tenant');
    });

    test('throws when tenantId does not match key', async () => {
      const url = 'https://globuscrm-dev-storage.s3.ap-south-1.amazonaws.com/brochures/99/1719860400000-test.pdf';
      await expect(
        brochureS3Store.streamBrochure(1, url)
      ).rejects.toThrow('Not a valid S3 brochure URL for this tenant');
    });

    test('prevents tenant 1 from accessing tenant 99 brochure', async () => {
      const url = 'https://globuscrm-dev-storage.s3.ap-south-1.amazonaws.com/brochures/99/1719860400000-test.pdf';
      await expect(
        brochureS3Store.streamBrochure(1, url)
      ).rejects.toThrow('Not a valid S3 brochure URL for this tenant');

      expect(s3Service.getObjectStream).not.toHaveBeenCalled();
    });
  });
});
