// Visa Sure document storage — single source of truth for WHERE an applicant's
// uploaded checklist document lives and how to remove it. Primary backend is S3
// (via the shared s3Service); when the bucket isn't configured we fall back to
// local disk so dev still works. The customer-portal upload route + any future
// staff replace path use this so a re-upload deletes the previous file from the
// SAME backend it was stored in — no orphaned objects. Mirrors
// backend/lib/passportFileStore.js (kept separate so visa docs land in their
// own folder + retention/ops can target them independently).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const s3Service = require("../services/s3Service");

// Visa docs are private (passport / bank scans). They are NOT meant to be opened
// straight off the public /uploads static mount — access goes through the authed
// view-url endpoints (staff role/sub-brand OR the owning customer), which mint a
// SHORT-LIVED link: a signed S3 URL for S3-backed docs, or a `?t=` HMAC token for
// the disk dev-fallback (validated by the static-path gate in server.js).
const DOC_URL_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";
const DEFAULT_VIEW_TTL_SEC = 300; // 5-minute links

// Extension is pinned to the validated mimetype (never the client filename) —
// an attacker-controlled name on a public mount would otherwise be stored XSS.
// So the stored object is only ever .jpg / .png / .pdf. Visa checklist docs are
// passport scans (image), photos (image), and supporting docs (often PDF).
const VISA_DOC_MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
};

const uploadDir = path.join(__dirname, "..", "uploads", "visa-docs");

function ensureDir() {
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
}

// Store a document buffer; returns a descriptor used to build the served URL +
// later removal. Name is a non-guessable UUID + mimetype-pinned extension.
async function storeDoc(buffer, mimeType) {
  const ext = VISA_DOC_MIME_EXT[(mimeType || "").toLowerCase()] || "";
  const name = `${crypto.randomUUID()}${ext}`;
  if (s3Service.BUCKET_NAME) {
    const url = await s3Service.uploadFile(buffer, name, mimeType, "visa-docs");
    return { storage: "s3", url, key: s3Service.extractKeyFromUrl(url) };
  }
  ensureDir();
  fs.writeFileSync(path.join(uploadDir, name), buffer);
  return { storage: "disk", url: `/api/uploads/visa-docs/${name}`, key: name };
}

// Best-effort removal of a stored doc (re-upload supersede). Never throws.
async function removeDoc(descriptor) {
  if (!descriptor || !descriptor.key) return;
  try {
    if (descriptor.storage === "s3") {
      await s3Service.deleteFile(descriptor.key);
    } else {
      // path.basename strips directory components so a poisoned key
      // (e.g. "../../etc/x") can never make us unlink outside uploadDir.
      fs.unlink(path.join(uploadDir, path.basename(descriptor.key)), () => {});
    }
  } catch (_e) {
    /* best effort — never block the request on cleanup */
  }
}

// HMAC over "<name>.<exp>" — the shared primitive for signing/verifying a
// disk-backed visa-doc link. base64url so it's URL-safe.
function diskSig(name, exp) {
  return crypto.createHmac("sha256", DOC_URL_SECRET).update(`${name}.${exp}`).digest("base64url");
}

// Build a short-lived, signed URL for a disk-backed visa doc. The returned path
// is gated by the static-path middleware in server.js, which calls
// verifyDiskToken before letting express.static serve the bytes.
function signDiskUrl(name, ttlSec = DEFAULT_VIEW_TTL_SEC) {
  const safe = path.basename(name || "");
  if (!safe) return null;
  const exp = Math.floor(Date.now() / 1000) + Math.max(30, ttlSec);
  return `/api/uploads/visa-docs/${encodeURIComponent(safe)}?t=${exp}.${diskSig(safe, exp)}`;
}

// Validate a `?t=<exp>.<sig>` token for a disk-backed visa doc. Returns false on
// a missing/malformed/expired/tampered token (timing-safe signature compare).
function verifyDiskToken(name, token) {
  const safe = path.basename(name || "");
  if (!safe || !token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = parseInt(token.slice(0, dot), 10);
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = diskSig(safe, exp);
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// "s3" | "disk" for a checklist-item row, tolerating legacy rows whose
// attachmentStorage was never stamped (infer from the URL shape).
function inferStorage(item) {
  if (item && item.attachmentStorage) return item.attachmentStorage;
  return /^https?:\/\//i.test((item && item.attachmentUrl) || "") ? "s3" : "disk";
}

// Resolve a checklist item to a short-lived, openable URL — a signed S3 URL for
// S3-backed docs, or a token-signed disk path for the dev fallback. Returns null
// when the item has no stored file. Call ONLY after authorizing the requester.
async function resolveViewUrl(item, ttlSec = DEFAULT_VIEW_TTL_SEC) {
  if (!item || !item.attachmentUrl) return null;
  if (inferStorage(item) === "s3") {
    const key = item.attachmentKey || s3Service.extractKeyFromUrl(item.attachmentUrl);
    if (!key) return null;
    return s3Service.getSignedUrl(key, ttlSec);
  }
  const name = path.basename(item.attachmentKey || item.attachmentUrl || "");
  return name ? signDiskUrl(name, ttlSec) : null;
}

// Read a stored document back as a raw Buffer — used by the post-conversion
// passport OCR trigger so the file doesn't need to be re-uploaded by the operator.
// Returns null on any failure; callers must degrade gracefully (e.g. skip OCR).
async function readDocBuffer(descriptor) {
  if (!descriptor || !descriptor.key) return null;
  try {
    if (descriptor.storage === "s3") {
      const { stream } = await s3Service.getObjectStream(descriptor.key);
      if (!stream) return null;
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return Buffer.concat(chunks);
    }
    const filePath = path.join(uploadDir, path.basename(descriptor.key));
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  } catch (_e) {
    return null;
  }
}

module.exports = {
  storeDoc,
  removeDoc,
  readDocBuffer,
  VISA_DOC_MIME_EXT,
  uploadDir,
  signDiskUrl,
  verifyDiskToken,
  resolveViewUrl,
  DEFAULT_VIEW_TTL_SEC,
};
