const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const s3Service = require("../services/s3Service");

const LETTER_MIME_TYPE = "application/pdf";
const uploadDir = path.join(__dirname, "..", "uploads", "visa-letters");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeSegment(value, fallback = "item") {
  const out = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return out || fallback;
}

async function storeLetterPdf(buffer, opts = {}) {
  const applicationId = Number.isFinite(Number(opts.applicationId)) ? Number(opts.applicationId) : "unknown";
  const participantId = Number.isFinite(Number(opts.participantId)) ? Number(opts.participantId) : "unknown";
  const kind = safeSegment(opts.kind || "generated");
  const fileName = safeSegment(opts.fileName || "visa-letter.pdf", "visa-letter.pdf");
  const prefix = `applications-${applicationId}/participants-${participantId}/${kind}`;

  if (s3Service.BUCKET_NAME) {
    const url = await s3Service.uploadFile(
      buffer,
      fileName,
      LETTER_MIME_TYPE,
      `visa-letters/${prefix}`,
      { contentDisposition: `inline; filename="${fileName}"` },
    );
    const key = s3Service.extractKeyFromUrl(url) || String(url || "").replace(/^undefined\//, "");
    return { storage: s3Service.isOciUrl(url) ? "ocs" : "s3", url, key };
  }

  const dir = path.join(uploadDir, prefix);
  ensureDir(dir);
  const storedName = `${crypto.randomUUID()}-${fileName}`;
  const fullPath = path.join(dir, storedName);
  fs.writeFileSync(fullPath, buffer);
  return {
    storage: "disk",
    url: `/api/uploads/visa-letters/${prefix}/${storedName}`,
    key: `${prefix}/${storedName}`,
  };
}

async function readLetterBuffer(descriptor) {
  if (!descriptor || !descriptor.key) return null;
  try {
    if (descriptor.storage === "s3" || descriptor.storage === "ocs") {
      const { stream } = await s3Service.getObjectStream(descriptor.key, { provider: descriptor.storage === "s3" ? "aws" : "oci" });
      if (!stream) return null;
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return Buffer.concat(chunks);
    }
    const parts = String(descriptor.key).split(/[\\/]+/).map((p) => path.basename(p)).filter(Boolean);
    const filePath = path.join(uploadDir, ...parts);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  } catch (_e) {
    return null;
  }
}

async function removeLetter(descriptor) {
  if (!descriptor || !descriptor.key) return;
  try {
    if (descriptor.storage === "s3" || descriptor.storage === "ocs") {
      await s3Service.deleteFile(descriptor.key, { provider: descriptor.storage === "s3" ? "aws" : "oci" });
      return;
    }
    const parts = String(descriptor.key).split(/[\\/]+/).map((p) => path.basename(p)).filter(Boolean);
    fs.unlink(path.join(uploadDir, ...parts), () => {});
  } catch (_e) {
    /* best effort */
  }
}

module.exports = {
  LETTER_MIME_TYPE,
  storeLetterPdf,
  readLetterBuffer,
  removeLetter,
  uploadDir,
};
