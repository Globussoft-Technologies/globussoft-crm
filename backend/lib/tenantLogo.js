/**
 * tenantLogo.js — pure helper for resolving a tenant's stored logoUrl to an
 * on-disk path for PDF embedding.
 *
 * Background / the bug this guards against: the branding upload saves a disk
 * logo as "/api/uploads/branding/tenant-X/..." where "/api" is an Express
 * ROUTE prefix, NOT a folder — the file actually lives at
 * backend/uploads/branding/.... The clinical-PDF logo resolver previously
 * matched only a "/uploads/" prefix, so every uploaded logo was skipped and
 * the PDF always fell back to the bundled default. This helper normalizes the
 * "/api" route prefix away and rejects remote (S3 https) URLs (those are
 * fetched over HTTP by the caller, not read from disk).
 */
const path = require("path");

/**
 * Map a stored tenant logoUrl to a disk path under `backendDir` when it's a
 * locally-served upload. Returns null for remote (http/https) URLs, blanks,
 * or anything that isn't an uploads path.
 *
 * @param {string} logoUrl    e.g. "/api/uploads/branding/tenant-2/logo-1.png"
 * @param {string} backendDir absolute path to the backend/ directory
 * @returns {string|null} absolute disk path, or null
 */
function localLogoDiskPath(logoUrl, backendDir) {
  if (typeof logoUrl !== "string" || !logoUrl) return null;
  if (/^https?:\/\//i.test(logoUrl)) return null; // remote → fetched, not on disk
  let rel = logoUrl;
  // "/api/uploads/..." → "/uploads/..." (drop the route prefix, keep the dir)
  if (rel.startsWith("/api/uploads/")) rel = rel.slice(4);
  if (!rel.startsWith("/uploads/")) return null;
  return path.join(backendDir, rel);
}

// Max pixels we will embed into a PDF. PDFKit decodes an image to raw RGBA in
// memory (width × height × 4 bytes), so a 21,618 × 6,558 PNG = ~567 MB and
// OOM-kills the Node process mid-request → nginx 502 with no JS error. 5 MP
// (≈20 MB decoded) is generous for a header logo and rejects that monster.
const MAX_LOGO_PIXELS = 5_000_000;

// Read intrinsic (width, height) from a PNG or JPEG buffer WITHOUT decoding
// the pixels — a cheap header parse. Returns null for unrecognized formats.
function imageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  // PNG: 8-byte signature, then IHDR — width @16, height @20 (big-endian).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: FF D8, then walk segments to the first SOF (start-of-frame) marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      // SOF0..SOF15, excluding DHT (C4), JPG (C8), DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      const segLen = buf.readUInt16BE(off + 2);
      if (segLen < 2) break;
      off += 2 + segLen;
    }
  }
  return null;
}

// True when an image is too large to safely embed in a PDF. Unknown formats
// return false (don't over-block — PDFKit handles small odd formats fine; the
// real risk is the known giant PNG).
function isLogoTooLarge(buf) {
  const d = imageDimensions(buf);
  if (!d) return false;
  return d.width * d.height > MAX_LOGO_PIXELS;
}

module.exports = {
  localLogoDiskPath,
  imageDimensions,
  isLogoTooLarge,
  MAX_LOGO_PIXELS,
};
