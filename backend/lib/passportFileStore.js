// Passport scan storage - single source of truth for where a passport image
// lives, how to remove it, and how to mint a short-lived view URL.
// Primary backend is S3 (via the shared s3Service); when the bucket is not
// configured we fall back to local disk so dev still works. Both the
// customer-portal route and the staff route use this so a re-upload / clear
// deletes the previous scan from the same backend it was stored in.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const s3Service = require("../services/s3Service");

// Extension is pinned to the validated mimetype (never the client filename).
// The stored object is only ever .jpg / .png / .pdf.
const PASSPORT_MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
};

const uploadDir = path.join(__dirname, "..", "uploads", "passport-ocr");
const DEFAULT_VIEW_TTL_SEC = 300;
const DOC_URL_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

function ensureDir() {
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
}

// Store a scan buffer; returns a descriptor used to build imageUrl + later
// removal. Name is a non-guessable UUID plus the mimetype-pinned extension.
async function storeScan(buffer, mimeType) {
  const ext = PASSPORT_MIME_EXT[(mimeType || "").toLowerCase()] || "";
  const name = `${crypto.randomUUID()}${ext}`;
  if (s3Service.BUCKET_NAME) {
    const url = await s3Service.uploadFile(buffer, name, mimeType, "passport-ocr");
    return { storage: s3Service.isOciUrl(url) ? "ocs" : "s3", url, key: s3Service.extractKeyFromUrl(url), imageFilename: null };
  }
  ensureDir();
  fs.writeFileSync(path.join(uploadDir, name), buffer);
  return { storage: "disk", url: `/api/uploads/passport-ocr/${name}`, key: name, imageFilename: name };
}

// Best-effort removal of a stored scan (re-upload supersede + queue clear).
async function removeScan(descriptor) {
  if (!descriptor || !descriptor.key) return;
  try {
    if (descriptor.storage === "s3" || descriptor.storage === "ocs") {
      await s3Service.deleteFile(descriptor.key, { provider: descriptor.storage === "s3" ? "aws" : "oci" });
    } else {
      // path.basename strips directory components so a poisoned key cannot
      // make us unlink outside uploadDir.
      fs.unlink(path.join(uploadDir, path.basename(descriptor.key)), () => {});
    }
  } catch (_e) {
    /* best effort - never block the request on cleanup */
  }
}

// HMAC over "<name>.<exp>" - shared primitive for signing/verifying a
// disk-backed passport link. base64url keeps the token URL-safe.
function diskSig(name, exp) {
  return crypto.createHmac("sha256", DOC_URL_SECRET).update(`${name}.${exp}`).digest("base64url");
}

// Build a short-lived, signed URL for a disk-backed passport scan. The
// returned path is gated by the /api/uploads/passport-ocr middleware in
// server.js so production demo traffic stays under the canonical /api/*
// reverse-proxy path instead of falling through the SPA's /uploads 404.
function signDiskUrl(name, ttlSec = DEFAULT_VIEW_TTL_SEC) {
  const safe = path.basename(name || "");
  if (!safe) return null;
  const exp = Math.floor(Date.now() / 1000) + Math.max(30, ttlSec);
  return `/api/uploads/passport-ocr/${encodeURIComponent(safe)}?t=${exp}.${diskSig(safe, exp)}`;
}

// Validate a `?t=<exp>.<sig>` token for a disk-backed passport scan.
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

// "s3" | "disk" for a passport row / extraction envelope. Legacy rows may
// not have a stamped storage flag, so infer from the URL shape.
function inferStorage(item) {
  if (item && item.storage) return item.storage;
  const url = (item && (item.imageUrl || item.url)) || "";
  if (s3Service.extractKeyFromUrl(url)) return s3Service.isOciUrl(url) ? "ocs" : "s3";
  return "disk";
}

// Resolve a passport item to a short-lived openable URL - a signed S3 URL for
// S3-backed docs, or a token-signed disk path for the dev fallback. Returns
// null when the item has no stored file. Call ONLY after authorizing the
// requester.
async function resolveViewUrl(item, ttlSec = DEFAULT_VIEW_TTL_SEC) {
  if (!item) return null;
  if (["s3", "ocs"].includes(inferStorage(item))) {
    const key = item.imageKey || s3Service.extractKeyFromUrl(item.imageUrl || item.url || "");
    if (!key) return null;
    return s3Service.getSignedUrl(key, ttlSec, { provider: inferStorage(item) === "s3" ? "aws" : "oci" });
  }
  const name = path.basename(item.imageFilename || item.imageUrl || item.url || "");
  return name ? signDiskUrl(name, ttlSec) : null;
}

// Reconstruct a removal descriptor from a persisted extraction envelope.
// Handles both the S3 shape ({ storage:"s3", imageKey }) and the legacy/disk
// shape ({ imageFilename }).
function descriptorFromEnvelope(env) {
  if (!env) return null;
  if (["s3", "ocs"].includes(env.storage) && env.imageKey) return { storage: env.storage, key: env.imageKey };
  if (env.imageFilename) return { storage: "disk", key: env.imageFilename };
  return null;
}

// Convenience: parse a passportExtractionJson string and remove its scan.
async function removeScanFromEnvelopeJson(json, exceptKey) {
  if (!json) return;
  let env;
  try {
    env = JSON.parse(json);
  } catch (_e) {
    return;
  }
  const desc = descriptorFromEnvelope(env);
  if (desc && desc.key !== exceptKey) await removeScan(desc);
}

module.exports = {
  storeScan,
  removeScan,
  descriptorFromEnvelope,
  removeScanFromEnvelopeJson,
  PASSPORT_MIME_EXT,
  uploadDir,
  signDiskUrl,
  verifyDiskToken,
  resolveViewUrl,
  DEFAULT_VIEW_TTL_SEC,
};
