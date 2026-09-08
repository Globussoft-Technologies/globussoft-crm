/**
 * Storage layer for AI curriculum-matching document uploads.
 *
 * Deliberately does NOT use a dedicated Prisma table/migration — it reuses
 * the existing generic TenantSetting key-value store (the same mechanism
 * backend/routes/travel_knowledge_base.js already uses for its Drive root
 * folder config), one row per uploaded curriculum PDF. This keeps the
 * feature fully additive with zero schema migrations against the live DB.
 *
 * Row shape: TenantSetting { tenantId, key: `travel.curriculum.doc.<id>`,
 * category: "travel-curriculum-document", value: JSON.stringify(document) }.
 */

const crypto = require("crypto");
const prisma = require("./prisma");

const CATEGORY = "travel-curriculum-document";
const KEY_PREFIX = "travel.curriculum.doc.";

function generateDocumentId() {
  return crypto.randomBytes(8).toString("hex");
}

function keyFor(documentId) {
  return `${KEY_PREFIX}${documentId}`;
}

function parseRow(row) {
  if (!row) return null;
  try {
    const doc = JSON.parse(row.value);
    return { ...doc, id: doc.id || row.key.slice(KEY_PREFIX.length) };
  } catch {
    return null;
  }
}

/**
 * List curriculum documents for a tenant, optionally narrowed by subBrand.
 * Newest first.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} [opts.subBrand]
 * @returns {Promise<object[]>}
 */
async function listCurriculumDocuments({ tenantId, subBrand }) {
  const rows = await prisma.tenantSetting.findMany({
    where: { tenantId, category: CATEGORY },
    orderBy: { updatedAt: "desc" },
  });
  const docs = rows.map(parseRow).filter(Boolean);
  if (subBrand) return docs.filter((d) => d.subBrand === subBrand);
  return docs;
}

/**
 * Fetch one curriculum document by id (tenant-scoped).
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.documentId
 * @returns {Promise<object|null>}
 */
async function getCurriculumDocument({ tenantId, documentId }) {
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: keyFor(documentId) } },
  });
  return parseRow(row);
}

/**
 * Create or overwrite a curriculum document row.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.documentId
 * @param {object} opts.data - full document object (will be stamped with id/tenantId)
 * @returns {Promise<object>}
 */
async function saveCurriculumDocument({ tenantId, documentId, data }) {
  const payload = { ...data, id: documentId, tenantId };
  const value = JSON.stringify(payload);
  await prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key: keyFor(documentId) } },
    create: { tenantId, key: keyFor(documentId), value, category: CATEGORY },
    update: { value, category: CATEGORY },
  });
  return payload;
}

/**
 * Permanently remove a curriculum document row (metadata only — caller is
 * responsible for cleaning up the S3 object and Qdrant points first).
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.documentId
 * @returns {Promise<boolean>}
 */
async function deleteCurriculumDocument({ tenantId, documentId }) {
  try {
    await prisma.tenantSetting.delete({
      where: { tenantId_key: { tenantId, key: keyFor(documentId) } },
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  generateDocumentId,
  listCurriculumDocuments,
  getCurriculumDocument,
  saveCurriculumDocument,
  deleteCurriculumDocument,
  CATEGORY,
};
