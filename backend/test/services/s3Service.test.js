/**
 * Unit tests for backend/services/s3Service.js — the AWS SDK v3 migration
 * (PutObjectCommand / DeleteObjectCommand / GetObjectCommand + presigner).
 *
 * Mocking notes:
 *   vi.mock('@aws-sdk/client-s3') does NOT reliably intercept the SUT's CJS
 *   `require()` under this repo's vitest setup (same blocker as
 *   test/lib/sentry.test.js and friends). We therefore monkey-patch the
 *   real CJS module.exports of @aws-sdk/client-s3 and
 *   @aws-sdk/s3-request-presigner via createRequire BEFORE the SUT loads.
 *
 *   The SUT destructures `S3Client` and `presignerGetSignedUrl` at
 *   module-load time, so the patches must be installed before the SUT is
 *   required. The SUT itself is loaded via requireCjs (not static import)
 *   so we control the load order.
 *
 *   The SUT reads AWS_S3_BUCKET_NAME and AWS_S3_URL at module-load into
 *   module-level const — env vars are set before the require.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

process.env.AWS_S3_BUCKET_NAME = 'test-bucket';
process.env.AWS_S3_URL = 'https://test-bucket.s3.us-east-1.amazonaws.com';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
process.env.AWS_SECRET_ACCESS_KEY = 'secret';

const clientS3 = requireCjs('@aws-sdk/client-s3');
const presigner = requireCjs('@aws-sdk/s3-request-presigner');

const sendMock = vi.fn();
const presignerMock = vi.fn();

clientS3.S3Client = function S3Client() { return { send: sendMock }; };
presigner.getSignedUrl = presignerMock;

const s3 = requireCjs('../../services/s3Service.js');
const { uploadFile, uploadImage, deleteFile, getSignedUrl, extractKeyFromUrl, BUCKET_NAME, S3_BASE_URL } = s3;

beforeEach(() => {
  sendMock.mockReset();
  presignerMock.mockReset();
});

describe('s3Service — module shape', () => {
  test('exports the public surface', () => {
    expect(typeof uploadFile).toBe('function');
    expect(typeof uploadImage).toBe('function');
    expect(typeof deleteFile).toBe('function');
    expect(typeof getSignedUrl).toBe('function');
    expect(typeof extractKeyFromUrl).toBe('function');
  });

  test('reads BUCKET_NAME and S3_BASE_URL from env', () => {
    expect(BUCKET_NAME).toBe('test-bucket');
    expect(S3_BASE_URL).toBe('https://test-bucket.s3.us-east-1.amazonaws.com');
  });
});

describe('s3Service — uploadFile', () => {
  test('returns full S3 URL on successful upload', async () => {
    sendMock.mockResolvedValueOnce({});
    const url = await uploadFile(Buffer.from('hello'), 'photo.jpg', 'image/jpeg', 'avatars');
    expect(url).toMatch(/^https:\/\/test-bucket\.s3\.us-east-1\.amazonaws\.com\/avatars\/\d+-photo\.jpg$/);
  });

  test('sends PutObjectCommand with bucket/key/body/contentType/ACL', async () => {
    sendMock.mockResolvedValueOnce({});
    const buf = Buffer.from('img-bytes');
    await uploadFile(buf, 'avatar.png', 'image/png', 'avatars');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(clientS3.PutObjectCommand);
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toMatch(/^avatars\/\d+-avatar\.png$/);
    expect(cmd.input.Body).toBe(buf);
    expect(cmd.input.ContentType).toBe('image/png');
    expect(cmd.input.ACL).toBe('public-read');
  });

  test('lowercases filename and replaces special chars with _', async () => {
    sendMock.mockResolvedValueOnce({});
    await uploadFile(Buffer.from('x'), 'My Photo (1)!.JPG', 'image/jpeg', 'images');
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd.input.Key).toMatch(/^images\/\d+-my_photo__1__\.jpg$/);
  });

  test('truncates sanitized name to 50 chars', async () => {
    sendMock.mockResolvedValueOnce({});
    const longName = 'a'.repeat(100) + '.jpg';
    await uploadFile(Buffer.from('x'), longName, 'image/jpeg', 'images');
    const cmd = sendMock.mock.calls[0][0];
    const keyPart = cmd.input.Key.split('-').slice(1).join('-');
    expect(keyPart.length).toBeLessThanOrEqual(50);
  });

  test('defaults subfolder to "uploads" when not provided', async () => {
    sendMock.mockResolvedValueOnce({});
    await uploadFile(Buffer.from('x'), 'doc.pdf', 'application/pdf');
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd.input.Key).toMatch(/^uploads\//);
  });

  test('wraps S3 errors in a "Failed to upload" message', async () => {
    sendMock.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(
      uploadFile(Buffer.from('x'), 'p.jpg', 'image/jpeg', 'images')
    ).rejects.toThrow(/Failed to upload file to S3: AccessDenied/);
  });
});

describe('s3Service — uploadImage', () => {
  const validMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];

  test.each(validMimes)('accepts %s', async (mime) => {
    sendMock.mockResolvedValueOnce({});
    const url = await uploadImage(Buffer.from('x'), 'a.png', mime);
    expect(url).toMatch(/^https:\/\/test-bucket\./);
  });

  test('rejects non-image MIME types', async () => {
    await expect(
      uploadImage(Buffer.from('x'), 'doc.pdf', 'application/pdf')
    ).rejects.toThrow(/Invalid image MIME type/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('rejects empty mime type', async () => {
    await expect(
      uploadImage(Buffer.from('x'), 'a.png', '')
    ).rejects.toThrow(/Invalid image MIME type/);
  });

  test('defaults subfolder to "images"', async () => {
    sendMock.mockResolvedValueOnce({});
    await uploadImage(Buffer.from('x'), 'a.jpg', 'image/jpeg');
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd.input.Key).toMatch(/^images\//);
  });

  test('respects custom subfolder when provided', async () => {
    sendMock.mockResolvedValueOnce({});
    await uploadImage(Buffer.from('x'), 'a.jpg', 'image/jpeg', 'patient-photos');
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd.input.Key).toMatch(/^patient-photos\//);
  });
});

describe('s3Service — deleteFile', () => {
  test('sends DeleteObjectCommand with bucket and key', async () => {
    sendMock.mockResolvedValueOnce({});
    await deleteFile('avatars/12345-photo.jpg');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(clientS3.DeleteObjectCommand);
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('avatars/12345-photo.jpg');
  });

  test('resolves with no value on success', async () => {
    sendMock.mockResolvedValueOnce({});
    await expect(deleteFile('k')).resolves.toBeUndefined();
  });

  test('wraps S3 errors in a "Failed to delete" message', async () => {
    sendMock.mockRejectedValueOnce(new Error('NoSuchKey'));
    await expect(deleteFile('k')).rejects.toThrow(/Failed to delete file from S3: NoSuchKey/);
  });
});

describe('s3Service — getSignedUrl', () => {
  test('calls presigner with GetObjectCommand and default 3600s expiresIn', async () => {
    presignerMock.mockResolvedValueOnce('https://signed.example/key?sig=abc');
    const url = await getSignedUrl('private/doc.pdf');
    expect(url).toBe('https://signed.example/key?sig=abc');
    expect(presignerMock).toHaveBeenCalledTimes(1);
    const [client, cmd, opts] = presignerMock.mock.calls[0];
    expect(client).toBeDefined();
    expect(cmd).toBeInstanceOf(clientS3.GetObjectCommand);
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('private/doc.pdf');
    expect(opts).toEqual({ expiresIn: 3600 });
  });

  test('honours custom expiresIn', async () => {
    presignerMock.mockResolvedValueOnce('https://signed.example/k');
    await getSignedUrl('k', 900);
    expect(presignerMock.mock.calls[0][2]).toEqual({ expiresIn: 900 });
  });

  test('wraps presigner errors in a "Failed to generate" message', async () => {
    presignerMock.mockRejectedValueOnce(new Error('CredentialsError'));
    await expect(getSignedUrl('k')).rejects.toThrow(/Failed to generate signed URL: CredentialsError/);
  });
});

describe('s3Service — extractKeyFromUrl', () => {
  test('extracts key from a full S3 URL matching the base', () => {
    const url = 'https://test-bucket.s3.us-east-1.amazonaws.com/avatars/123-photo.jpg';
    expect(extractKeyFromUrl(url)).toBe('avatars/123-photo.jpg');
  });

  test('returns null for null/empty input', () => {
    expect(extractKeyFromUrl(null)).toBeNull();
    expect(extractKeyFromUrl('')).toBeNull();
    expect(extractKeyFromUrl(undefined)).toBeNull();
  });

  test('returns null when URL does not start with configured base', () => {
    expect(extractKeyFromUrl('https://other-bucket.s3.amazonaws.com/x.jpg')).toBeNull();
  });
});
