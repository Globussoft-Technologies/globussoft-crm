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

module.exports = {
  storeDoc,
  removeDoc,
  VISA_DOC_MIME_EXT,
  uploadDir,
};
