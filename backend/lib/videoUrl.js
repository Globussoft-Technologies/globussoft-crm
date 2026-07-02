// Video URL normalisation for the LandingPage builder's video blocks.
//
// Why this exists: operators paste any YouTube/Vimeo URL they have on
// hand — watch URLs, share URLs, Shorts URLs, mobile URLs. Almost none
// of those load inside an iframe because the providers send
// X-Frame-Options: SAMEORIGIN on the non-/embed paths. The result is
// the "refused to connect" black box rendered in the public page.
//
// The fix is to normalise to the provider's /embed path at render time.
// Pure helper — no I/O, no side effects, no dependencies.
//
// Patterns handled:
//   - youtube.com/watch?v=ID                → youtube.com/embed/ID
//   - youtube.com/shorts/ID                  → youtube.com/embed/ID
//   - youtu.be/ID                            → youtube.com/embed/ID
//   - m.youtube.com/watch?v=ID               → youtube.com/embed/ID
//   - youtube.com/embed/ID  (pass-through)
//   - vimeo.com/12345                        → player.vimeo.com/video/12345
//   - vimeo.com/12345/abcde (private hash)   → player.vimeo.com/video/12345?h=abcde
//   - player.vimeo.com/video/...  (pass-through)
//   - fast.wistia.net/embed/iframe/...  (pass-through)
//   - Local /uploads/... URL (pass-through; renderer outputs <video>, not <iframe>)
//   - Anything else: pass through unchanged so we don't break exotic providers.

// Canonical prefix for new uploads (must be under /api/* — Nginx on the
// deployed demo only proxies /api/* to the backend; a bare /uploads/...
// URL falls through to the SPA catch-all and serves index.html instead of
// the file). The legacy bare-/uploads/ prefix is also recognised so pages
// saved before this fix keep rendering a <video> tag instead of an <iframe>.
const LOCAL_UPLOAD_PREFIX = '/api/uploads/landing-page-videos/';
const LEGACY_LOCAL_UPLOAD_PREFIX = '/uploads/landing-page-videos/';

// Recognise URLs that point directly at a video file (Pexels CDN, Cloudflare
// Stream MP4 endpoints, S3-served clips, etc.). The renderer must emit a
// <video> tag for these — iframing a raw .mp4 byte stream triggers the
// X-Frame-Options "This content is blocked" error in the browser because the
// CDN's response isn't an HTML document.
const DIRECT_VIDEO_FILE_RE = /\.(mp4|webm|mov|ogv|ogg|m4v)(\?|#|$)/i;

function isLocalUpload(url) {
  if (!url || typeof url !== 'string') return false;
  const t = url.trim();
  return t.startsWith(LOCAL_UPLOAD_PREFIX) || t.startsWith(LEGACY_LOCAL_UPLOAD_PREFIX);
}

function isDirectVideoFile(url) {
  if (!url || typeof url !== 'string') return false;
  const t = url.trim();
  if (!t) return false;
  if (isLocalUpload(t)) return true;
  return DIRECT_VIDEO_FILE_RE.test(t);
}

function extractYoutubeId(url) {
  // youtu.be/<id> short URL.
  let m = url.match(/^https?:\/\/(?:www\.)?youtu\.be\/([A-Za-z0-9_-]{6,})/i);
  if (m) return m[1];
  // youtube.com/shorts/<id>
  m = url.match(/^https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/i);
  if (m) return m[1];
  // youtube.com/watch?v=<id> (anywhere in querystring).
  m = url.match(/^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?.*?\bv=([A-Za-z0-9_-]{6,})/i);
  if (m) return m[1];
  // youtube.com/embed/<id>  — already normalised but extract for canonicalisation.
  m = url.match(/^https?:\/\/(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/i);
  if (m) return m[1];
  return null;
}

function extractVimeoIds(url) {
  // vimeo.com/<id>(/<hash>)?  or player.vimeo.com/video/<id>(?h=<hash>)?
  let m = url.match(/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)(?:\/([A-Za-z0-9]+))?/i);
  if (m) return { id: m[1], hash: m[2] || null };
  m = url.match(/^https?:\/\/player\.vimeo\.com\/video\/(\d+)/i);
  if (m) return { id: m[1], hash: null };
  return null;
}

/**
 * Convert any common YouTube/Vimeo URL into the provider's embed URL.
 * Already-embed URLs and local /uploads URLs pass through unchanged.
 * Unknown providers pass through unchanged.
 *
 * @param {string} url
 * @returns {string} The normalised URL (or the input if no rule matched).
 */
function normalizeVideoEmbedUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (isLocalUpload(trimmed)) return trimmed;

  const youtubeId = extractYoutubeId(trimmed);
  if (youtubeId) return `https://www.youtube.com/embed/${youtubeId}`;

  const vimeo = extractVimeoIds(trimmed);
  if (vimeo) {
    return vimeo.hash
      ? `https://player.vimeo.com/video/${vimeo.id}?h=${vimeo.hash}`
      : `https://player.vimeo.com/video/${vimeo.id}`;
  }

  // Wistia / unknown providers: pass through. Operators occasionally
  // paste a privately-hosted embed URL we can't enumerate.
  return trimmed;
}

module.exports = {
  LOCAL_UPLOAD_PREFIX,
  isLocalUpload,
  isDirectVideoFile,
  normalizeVideoEmbedUrl,
};
