// Server-side destination photo for the itinerary PDF hero banner.
//
// Resolves a destination → the Wikipedia article's lead image (keyless action
// API, follows redirects like Banaras → Varanasi), downloads the bytes, and
// banner-crops them with jimp to a wide 1200×360 strip so the PDF can place a
// clean full-width banner. Everything is best-effort: ANY failure (offline /
// outbound-restricted server, no image, bad bytes) returns null and the PDF
// simply renders without the banner.
//
// Mirror of the frontend's keyless Wikipedia approach (utils/destinationPhotos)
// but standalone for the backend (axios + jimp, with an in-memory cache).

const axios = require("axios");

// Curated Wikipedia titles for sub-brand destinations whose article title
// differs from the obvious string (others fall back to the cleaned text).
const TITLE_ALIASES = [
  { title: "Mecca", match: ["makkah", "mecca", "makka", "umrah", "hajj"] },
  { title: "Medina", match: ["madinah", "medina", "madina"] },
  { title: "Varanasi", match: ["varanasi", "banaras", "banarash", "benares", "kashi"] },
  { title: "New York City", match: ["new york", "nyc", "manhattan"] },
  { title: "Tokyo", match: ["tokyo", "japan"] },
];

const FETCH_TIMEOUT_MS = Number(process.env.DESTINATION_IMAGE_TIMEOUT_MS || 4000);
const MAX_BYTES = 5 * 1024 * 1024;
// Wikimedia BLOCKS requests without a descriptive User-Agent (HTTP 403). The
// browser sends one automatically (so the web pages work); our server-side
// axios must set it explicitly per the Wikimedia User-Agent policy. The
// contact URL is taken from the environment (PUBLIC_BASE_URL) — localhost in
// dev, the live domain in prod — so nothing is hardcoded per environment.
const APP_URL = process.env.PUBLIC_BASE_URL || "http://localhost:5173";
const WIKI_UA = `GlobussoftCRM-TravelItineraryPDF/1.0 (${APP_URL})`;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const CACHE = new Map(); // title → { buf, expiresAt }

function wikiTitleFor(destination) {
  const norm = String(destination || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return null;
  for (const a of TITLE_ALIASES) {
    if (a.match.some((m) => norm.includes(m))) return a.title;
  }
  // Unknown: first segment of the ORIGINAL string (keep proper casing).
  const firstSegment = String(destination).split(/[,(–—-]/)[0].trim();
  return firstSegment || null;
}

async function resolveThumbUrl(title, ax) {
  // No origin=* here — that's a browser CORS param; server-side it isn't needed
  // and the UA header is what Wikimedia actually requires.
  const params = new URLSearchParams({
    action: "query", format: "json", prop: "pageimages", piprop: "thumbnail",
    pithumbsize: "1280", redirects: "1", titles: title,
  });
  const resp = await ax.get(`https://en.wikipedia.org/w/api.php?${params.toString()}`, {
    timeout: FETCH_TIMEOUT_MS,
    headers: { "User-Agent": WIKI_UA, "Accept": "application/json" },
    validateStatus: (s) => s >= 200 && s < 300,
  });
  const pages = resp?.data?.query?.pages;
  if (!pages) return null;
  for (const id of Object.keys(pages)) {
    const src = pages[id]?.thumbnail?.source;
    if (src) return src;
  }
  return null;
}

// Cover-crop to a wide banner so the PDF gets a clean full-width strip. Falls
// back to the raw buffer if jimp isn't usable on these bytes.
async function bannerCrop(buf) {
  try {
    const { Jimp } = await import("jimp");
    const img = await Jimp.read(buf);
    const target = 1200 / 360;
    const w = img.bitmap.width;
    const h = img.bitmap.height;
    const ratio = w / h;
    let cw; let ch; let cx; let cy;
    if (ratio > target) { ch = h; cw = Math.round(h * target); cx = Math.round((w - cw) / 2); cy = 0; }
    else { cw = w; ch = Math.round(w / target); cx = 0; cy = Math.round((h - ch) / 2); }
    img.crop({ x: cx, y: cy, w: cw, h: ch });
    img.resize({ w: 1200, h: 360 });
    return await img.getBuffer("image/jpeg");
  } catch (_e) {
    return buf; // raw bytes still render (just not banner-cropped)
  }
}

/**
 * Resolve a destination to a banner-cropped photo Buffer for the PDF hero, or
 * null. Never throws. opts.axios injects a stub for tests.
 */
async function fetchDestinationImageBuffer(destination, opts = {}) {
  const ax = opts.axios || axios;
  const title = wikiTitleFor(destination);
  if (!title) return null;

  const now = Date.now();
  const hit = CACHE.get(title);
  if (hit && hit.expiresAt > now) return hit.buf;

  try {
    const url = await resolveThumbUrl(title, ax);
    if (!url) return null;
    const resp = await ax.get(url, {
      responseType: "arraybuffer",
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: MAX_BYTES,
      headers: { "User-Agent": WIKI_UA },
      validateStatus: (s) => s >= 200 && s < 300,
    });
    if (!resp || !resp.data) return null;
    let buf = Buffer.isBuffer(resp.data) ? resp.data : Buffer.from(resp.data);
    if (!buf.length || buf.length > MAX_BYTES) return null;
    buf = await bannerCrop(buf);
    CACHE.set(title, { buf, expiresAt: now + CACHE_TTL_MS });
    return buf;
  } catch (_e) {
    return null;
  }
}

function _resetCache() { CACHE.clear(); }

module.exports = { fetchDestinationImageBuffer, wikiTitleFor, _resetCache };
