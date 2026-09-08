import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const envKeys = [
  'AWS_S3_BUCKET_NAME', 'AWS_S3_URL', 'OCI_ACCESS_KEY_ID', 'OCI_SECRET_ACCESS_KEY',
  'OCI_REGION', 'OCI_BUCKET_NAME', 'OCI_NAMESPACE', 'OCI_ENDPOINT_URL',
];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let s3;

beforeAll(() => {
  for (const key of envKeys) process.env[key] = '';
  const servicePath = requireCjs.resolve('../../services/s3Service.js');
  const ociPath = requireCjs.resolve('../../services/ociObjectStorageService.js');
  delete requireCjs.cache[servicePath];
  delete requireCjs.cache[ociPath];
  s3 = requireCjs(servicePath);
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('s3Service local fallback containment', () => {
  test.each([
    '/api/uploads/../package.json',
    '/api/uploads/../../.env',
    '/api/uploads/..\\package.json',
  ])('rejects traversal URL %s', async (url) => {
    expect(s3.localKeyFromUrl(url)).toBeNull();
    await expect(s3.readLocalFile(url)).resolves.toBeNull();
  });

  test.each(['../package.json', '../../.env', '..\\package.json', '/etc/passwd'])(
    'rejects traversal delete key %s',
    async (key) => {
      await expect(s3.deleteFile(key)).rejects.toThrow('Invalid local file path');
    },
  );

  test('forces a safe extension for spoofed local image names', async () => {
    const url = await s3.uploadFile(Buffer.from('<script>alert(1)</script>'), 'payload.html', 'image/jpeg', 'test-local-safe');
    expect(url).toMatch(/\.jpg$/);
    const key = s3.localKeyFromUrl(url);
    expect(key).toBeTruthy();
    await s3.deleteFile(key);
  });

  test('preserves the canonical extension for a valid local MP4 upload', async () => {
    const url = await s3.uploadFile(Buffer.from('video'), 'reel.mp4', 'video/mp4', 'test-local-safe');
    expect(url).toMatch(/\.mp4$/);
    await s3.deleteFile(url);
  });

  test('reads and deletes a contained local upload', async () => {
    const bytes = Buffer.from('safe-local-file');
    const url = await s3.uploadFile(bytes, 'sample.pdf', 'application/pdf', 'test-local-safe');
    expect(await s3.readLocalFile(url)).toEqual(bytes);
    await expect(s3.deleteFile(url)).resolves.toBeUndefined();
    await expect(s3.readLocalFile(url)).resolves.toBeNull();
  });
});
