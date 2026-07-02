/**
 * uploadDisplay.js — helpers for showing uploaded assets by filename.
 *
 * Landing-page media is stored on S3 with keys like:
 *   landing-page-images/tenant-<id>/<timestamp>-<filename>.jpg
 *   landing-page-videos/tenant-<id>/<timestamp>-<filename>.mp4
 *   landing-page-documents/tenant-<id>/<timestamp>-<filename>.pdf
 *
 * These helpers detect our own S3 URLs and turn them into a clean filename
 * so the editor never renders a giant bucket URL in the input.
 */

const S3_UPLOAD_PATTERNS = [
  /\/landing-page-images\/tenant-\d+\//,
  /\/landing-page-videos\/tenant-\d+\//,
  /\/landing-page-documents\/tenant-\d+\//,
];

/**
 * Returns true if `url` looks like an S3 URL created by our landing-page
 * upload routes. External URLs (YouTube, Vimeo, Drive, etc.) return false.
 */
export function isUploadedS3Url(url) {
  if (!url || typeof url !== 'string') return false;
  return S3_UPLOAD_PATTERNS.some((re) => re.test(url));
}

/**
 * Extract a human-readable filename from an uploaded-asset URL.
 *
 * - decodes URI components
 * - takes the basename
 * - strips query/hash
 * - strips the leading "<timestamp>-" prefix that S3 keys include
 *   (legacy uploads could be double-timestamped, so we strip twice)
 */
export function formatUploadFilename(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const base = decodeURIComponent(
      String(url).split('/').pop().split('?')[0].split('#')[0],
    );
    return base.replace(/^\d{10,}-/, '').replace(/^\d{10,}-/, '') || base;
  } catch {
    return String(url);
  }
}
