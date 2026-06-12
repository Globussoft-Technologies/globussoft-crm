// Passport scan storage — single source of truth for WHERE a passport image
// lives and how to remove it. Primary backend is S3 (via the shared
// s3Service); when the bucket isn't configured we fall back to local disk so
// dev still works. Both the customer-portal route and the staff route use
// this so a re-upload / clear deletes the previous scan from the SAME backend
// it was stored in — no orphaned objects in S3 (or files on disk).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const s3Service = require("../services/s3Service");

// Extension is pinned to the validated mimetype (never the client filename) —
// an attacker-controlled "evil.html" name on a public mount would be stored
// XSS. So the stored object is only ever .jpg / .png / .pdf.
const PASSPORT_MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
};

const uploadDir = path.join(__dirname, "..", "uploads", "passport-ocr");

function ensureDir() {
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
}

// Store a scan buffer; returns a descriptor used to build imageUrl + later
// removal. Name is a non-guessable UUID (PII) + mimetype-pinned extension.
async function storeScan(buffer, mimeType) {
  const ext = PASSPORT_MIME_EXT[(mimeType || "").toLowerCase()] || "";
  const name = `${crypto.randomUUID()}${ext}`;
  if (s3Service.BUCKET_NAME) {
    const url = await s3Service.uploadFile(buffer, name, mimeType, "passport-ocr");
    return { storage: "s3", url, key: s3Service.extractKeyFromUrl(url), imageFilename: null };
  }
  ensureDir();
  fs.writeFileSync(path.join(uploadDir, name), buffer);
  return { storage: "disk", url: `/api/uploads/passport-ocr/${name}`, key: name, imageFilename: name };
}

// Best-effort removal of a stored scan (re-upload supersede + queue "Clear").
async function removeScan(descriptor) {
  if (!descriptor || !descriptor.key) return;
  try {
    if (descriptor.storage === "s3") await s3Service.deleteFile(descriptor.key);
    else fs.unlink(path.join(uploadDir, descriptor.key), () => {});
  } catch (_e) { /* best effort — never block the request on cleanup */ }
}

// Reconstruct a removal descriptor from a persisted extraction envelope.
// Handles both the S3 shape ({ storage:"s3", imageKey }) and the legacy/disk
// shape ({ imageFilename }).
function descriptorFromEnvelope(env) {
  if (!env) return null;
  if (env.storage === "s3" && env.imageKey) return { storage: "s3", key: env.imageKey };
  if (env.imageFilename) return { storage: "disk", key: env.imageFilename };
  return null;
}

// Convenience: parse a passportExtractionJson string and remove its scan.
// `exceptKey` skips deletion when the prior scan is the same object we just
// stored (defensive — a re-upload always gets a fresh UUID, so this normally
// differs).
async function removeScanFromEnvelopeJson(json, exceptKey) {
  if (!json) return;
  let env;
  try { env = JSON.parse(json); } catch (_e) { return; }
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
};
