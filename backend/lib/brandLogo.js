// Shared brand-logo resolver for PDF headers.
//
// Resolution order (S3 is the source of truth; the rest are fallbacks):
//   1. Remote S3 / HTTP(S) URL (tenant.logoUrl / BrandKit.logoUrl uploaded via
//      s3Service) — fetched to a buffer.
//   2. Local /uploads (or /api/uploads) path — read off disk for non-S3 setups.
//   3. Bundled backend/assets/brand-logo.png — interim placeholder.
//   null when nothing safe is available, so the renderer draws its own emblem.
//
// Size-guarded: oversized images can OOM PDFKit, so anything above the cap is
// skipped and we fall through to the next source.
const fs = require("fs");
const path = require("path");

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB

async function fetchRemote(url) {
  try {
    // Node 18+ global fetch. Best-effort — any failure falls through to null.
    const res = await fetch(url);
    if (!res || !res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

function readLocalUpload(logoUrl) {
  try {
    const rel = String(logoUrl)
      .replace(/^\/api\/uploads\//, "")
      .replace(/^\/uploads\//, "");
    if (rel === String(logoUrl)) return null; // not an uploads-style path
    const p = path.join(__dirname, "..", "uploads", rel);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  } catch {
    return null;
  }
}

let _bundled;
function bundledLogo() {
  if (_bundled !== undefined) return _bundled;
  try {
    const p = path.join(__dirname, "..", "assets", "brand-logo.png");
    _bundled = fs.existsSync(p) ? fs.readFileSync(p) : null;
  } catch {
    _bundled = null;
  }
  return _bundled;
}

async function resolveBrandLogoBuffer(logoUrl) {
  let buf = null;
  if (typeof logoUrl === "string" && /^https?:\/\//i.test(logoUrl)) {
    buf = await fetchRemote(logoUrl); // S3 / remote
  } else if (logoUrl) {
    buf = readLocalUpload(logoUrl); // local /uploads
  }
  if (buf && buf.length <= MAX_LOGO_BYTES) return buf;

  const bundled = bundledLogo(); // directory fallback
  if (bundled && bundled.length <= MAX_LOGO_BYTES) return bundled;

  return null;
}

module.exports = { resolveBrandLogoBuffer, MAX_LOGO_BYTES };
