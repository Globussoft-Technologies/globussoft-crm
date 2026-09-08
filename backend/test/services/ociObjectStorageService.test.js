/**
 * Unit tests for ociObjectStorageService URL helpers and config detection.
 *
 * Env vars are set before module load because the service reads them at
 * require-time. Tests that need a different config live in their own files.
 */

import { describe, test, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.OCI_ACCESS_KEY_ID = 'test-access-key';
process.env.OCI_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.OCI_REGION = 'ap-mumbai-1';
process.env.OCI_BUCKET_NAME = 'globuscrm-live-media';
process.env.OCI_NAMESPACE = 'testnamespace';
process.env.OCI_ENDPOINT_URL = '';

const ociService = require('../../services/ociObjectStorageService.js');

describe('ociObjectStorageService', () => {
  describe('config detection', () => {
    test('reports configured when all required env vars are set', () => {
      expect(ociService.isConfigured()).toBe(true);
    });
  });

  describe('endpoint construction', () => {
    test('derives S3-compatible endpoint from namespace and region', () => {
      expect(ociService.getEndpoint()).toBe(
        'https://testnamespace.compat.objectstorage.ap-mumbai-1.oraclecloud.com'
      );
    });
  });

  describe('native OCI URL helpers', () => {
    test('buildObjectUrl returns native OCI URL', () => {
      expect(ociService.buildObjectUrl('brochures/1/br_abc123.pdf')).toBe(
        'https://objectstorage.ap-mumbai-1.oraclecloud.com/n/testnamespace/b/globuscrm-live-media/o/brochures/1/br_abc123.pdf'
      );
    });

    test('isOciUrl recognises a native OCI URL', () => {
      expect(
        ociService.isOciUrl(
          'https://objectstorage.ap-mumbai-1.oraclecloud.com/n/testnamespace/b/globuscrm-live-media/o/brochures/1/file.pdf'
        )
      ).toBe(true);
    });

    test('isOciUrl rejects an S3 URL', () => {
      expect(
        ociService.isOciUrl(
          'https://globuscrm-dev-storage.s3.ap-south-1.amazonaws.com/brochures/1/file.pdf'
        )
      ).toBe(false);
    });

    test('extractKeyFromUrl returns the object key', () => {
      expect(
        ociService.extractKeyFromUrl(
          'https://objectstorage.ap-mumbai-1.oraclecloud.com/n/testnamespace/b/globuscrm-live-media/o/brochures/1/br_abc123.pdf'
        )
      ).toBe('brochures/1/br_abc123.pdf');
    });

    test('extractKeyFromUrl handles a trailing slash', () => {
      expect(
        ociService.extractKeyFromUrl(
          'https://objectstorage.ap-mumbai-1.oraclecloud.com/n/testnamespace/b/globuscrm-live-media/o/brochures/1/br_abc123.pdf/'
        )
      ).toBe('brochures/1/br_abc123.pdf');
    });

    test('extractKeyFromUrl returns null for non-OCI URL', () => {
      expect(
        ociService.extractKeyFromUrl(
          'https://globuscrm-dev-storage.s3.ap-south-1.amazonaws.com/brochures/1/file.pdf'
        )
      ).toBeNull();
    });
  });
});
