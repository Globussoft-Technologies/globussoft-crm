/**
 * Travel CRM knowledge base sync engine.
 *
 * Watches a Google Drive folder tree (one root folder with sub-brand folders
 * underneath) and indexes every PDF into the Qdrant vector store so the RAG
 * query engine can recommend trips/places/learnings from live brochure data.
 *
 * Auth: user OAuth consent via `lib/googleDriveOAuth.js`. The refresh token is
 * stored per tenant in TenantSetting. If Drive is not connected, sync fails
 * gracefully with a clear error code.
 *
 * Folder convention:
 *   root/
 *     tmc/              -> subBrand = "tmc"
 *       DOMESTIC/
 *         DelhiAgra.pdf
 *       INTERNATIONAL/
 *         Europe.pdf
 *     rfu/              -> subBrand = "rfu"
 *     travelstall/      -> subBrand = "travelstall"
 *     visasure/         -> subBrand = "visasure"
 *
 * The immediate child folder name is normalised to the sub-brand token (lower-
 * cased, spaces + dashes stripped). A small alias map covers common display
 * names the client might use.
 *
 * Operations are tracked in Prisma sidecar tables:
 *   - TravelKnowledgeBaseSyncJob (one per sync run)
 *   - TravelKnowledgeBaseFile (one per indexed PDF, keyed by driveFileId)
 *   - Qdrant points (one per chunk, keyed by deterministic UUID)
 */

const { google } = require("googleapis");
const crypto = require("crypto");
const prisma = require("./prisma");
const qdrant = require("./qdrantClient");
const embedClient = require("./embedClient");
const pdfExtractor = require("./pdfTextExtractor");
const { sanitizeText } = require("./sanitizeJson");

const oauth = require("./googleDriveOAuth");

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const EMBED_BATCH_SIZE = 16; // OpenAI embedding batch limit is generous; keep modest for memory
const SUB_BRAND_ALIASES = {
  tmc: ["tmc", "tmc school trips", "school trips"],
  rfu: ["rfu", "rfu umrah", "umrah"],
  travelstall: ["travelstall", "travel stall", "travel stall family holidays", "family holidays"],
  visasure: ["visasure", "visa sure"],
};

function normaliseSubBrand(name) {
  const raw = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [token, aliases] of Object.entries(SUB_BRAND_ALIASES)) {
    for (const alias of aliases) {
      if (alias.toLowerCase().replace(/[^a-z0-9]/g, "") === raw) return token;
    }
  }
  return raw;
}

// In-memory abort registry for long-running sync jobs. A stop request calls
// controller.abort(); the sync loop checks signal.aborted at folder and file
// boundaries and exits cleanly, marking the job status as "stopped".
const activeSyncs = new Map();

function stopSyncJob(jobId) {
  const entry = activeSyncs.get(jobId);
  if (!entry) return false;
  try {
    entry.controller.abort();
  } catch (e) {
    console.warn("[travelKnowledgeBaseSync] abort failed:", e.message);
  }
  return true;
}

function throwIfAborted(signal, label = "sync") {
  if (signal && signal.aborted) {
    const err = new Error(`${label} stopped by user`);
    err.code = "STOPPED";
    throw err;
  }
}

async function getDriveClient(tenantId) {
  if (!oauth.isConfigured()) {
    const err = new Error("Google OAuth is not configured (missing GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI)");
    err.code = "DRIVE_AUTH_NOT_CONFIGURED";
    throw err;
  }
  return oauth.getDriveClient(tenantId);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function deterministicPointId(tenantId, subBrand, driveFileId, chunkIndex) {
  return crypto
    .createHash("sha256")
    .update(`${tenantId}:${subBrand}:${driveFileId}:${chunkIndex}`)
    .digest("hex")
    .slice(0, 32);
}

function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + chunkSize, clean.length);
    chunks.push(clean.slice(start, end));
    if (end === clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function fallbackDriveLink(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
}

async function ensurePublicViewLink(drive, fileId) {
  try {
    const permRes = await drive.permissions.list({
      fileId,
      fields: "permissions(id, type, role)",
    });
    const permissions = permRes.data.permissions || [];
    const isPublic = permissions.some(
      (p) => p.type === "anyone" && (p.role === "reader" || p.role === "commenter"),
    );
    if (!isPublic) {
      await drive.permissions.create({
        fileId,
        requestBody: { type: "anyone", role: "reader" },
        fields: "id",
      });
    }
    const fileRes = await drive.files.get({
      fileId,
      fields: "webViewLink",
    });
    return fileRes.data.webViewLink || fallbackDriveLink(fileId);
  } catch (e) {
    console.warn(`[travelKnowledgeBaseSync] could not make ${fileId} public: ${e.message}`);
    return fallbackDriveLink(fileId);
  }
}

async function listFolderChildren(drive, folderId) {
  const items = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size, md5Checksum, modifiedTime)",
      pageSize: 1000,
      pageToken: pageToken || undefined,
    });
    for (const f of res.data.files || []) items.push(f);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

async function listPdfsRecursive(drive, folderId, folderPath = "") {
  const items = await listFolderChildren(drive, folderId);
  const results = [];
  for (const item of items) {
    const itemPath = folderPath ? `${folderPath}/${item.name}` : item.name;
    if (item.mimeType === "application/vnd.google-apps.folder") {
      const childResults = await listPdfsRecursive(drive, item.id, itemPath);
      results.push(...childResults);
    } else if (item.mimeType === "application/pdf" || item.name.toLowerCase().endsWith(".pdf")) {
      results.push({ ...item, folderPath: itemPath });
    }
  }
  return results;
}

async function downloadPdf(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

async function embedChunks(chunks, embedConfig) {
  const embeddings = new Map();
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const { embeddings: batchMap, errors } = await embedConfig.client.embedTexts(batch, embedConfig);
    for (let j = 0; j < batch.length; j += 1) {
      const globalIndex = i + j;
      if (batchMap.has(j)) {
        embeddings.set(globalIndex, batchMap.get(j));
      } else {
        const err = errors.get(j) || new Error("embedding missing");
        embeddings.set(globalIndex, err);
      }
    }
  }
  return embeddings;
}

async function buildPoints(tenantId, subBrand, fileMeta, chunks, embedConfig) {
  const embeddings = await embedChunks(chunks, embedConfig);
  const points = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const vec = embeddings.get(i);
    if (vec instanceof Error || !Array.isArray(vec)) continue;
    points.push({
      id: deterministicPointId(tenantId, subBrand, fileMeta.id, i),
      vector: vec,
      payload: {
        tenantId: Number(tenantId),
        subBrand,
        driveFileId: fileMeta.id,
        driveViewLink: fileMeta.publicViewLink || fallbackDriveLink(fileMeta.id),
        fileName: sanitizeText(fileMeta.name),
        folderPath: sanitizeText(fileMeta.folderPath),
        chunkIndex: i,
        totalChunks: chunks.length,
        text: sanitizeText(chunks[i]),
        indexedAt: new Date().toISOString(),
      },
    });
  }
  return points;
}

async function indexOneFile({ drive, tenantId, subBrand, fileMeta, syncJobId, embedConfig, providerId, signal }) {
  throwIfAborted(signal, "indexOneFile");
  const existing = await prisma.travelKnowledgeBaseFile.findUnique({
    where: {
      tenantId_subBrand_driveFileId: {
        tenantId,
        subBrand,
        driveFileId: fileMeta.id,
      },
    },
  });

  // Ensure each indexed brochure is publicly viewable by anyone with the link.
  // The public webViewLink is stored in Qdrant so the generated diagnostic PDF
  // can embed clickable, access-free Drive links.
  const publicViewLink = await ensurePublicViewLink(drive, fileMeta.id);
  throwIfAborted(signal, "indexOneFile");
  fileMeta.publicViewLink = publicViewLink;

  let buffer;
  try {
    buffer = await downloadPdf(drive, fileMeta.id);
  } catch (e) {
    const reason = `download failed: ${e.message}`;
    await upsertFileRow({ tenantId, subBrand, fileMeta, syncJobId, status: "failed", failureReason: reason });
    return { status: "failed", reason };
  }
  throwIfAborted(signal, "indexOneFile");

  const fileSha256 = sha256(buffer);
  const linkChanged = existing && existing.driveViewLink !== publicViewLink;
  let existingPointCount = 0;
  if (existing && existing.sha256 === fileSha256 && existing.status === "active" && !linkChanged) {
    // Even if the file metadata has not changed, re-index if the active provider's
    // collection has no points for it (e.g. after switching from Gemini to OpenAI).
    existingPointCount = await qdrant.countPointsByDriveFile({
      tenantId,
      subBrand,
      driveFileId: fileMeta.id,
      providerId,
    });
    if (existingPointCount > 0) {
      return { status: "unchanged" };
    }
  }

  const extracted = await pdfExtractor.extractText(buffer);
  throwIfAborted(signal, "indexOneFile");
  if (!extracted.text.trim()) {
    const reason = "no text extracted";
    await upsertFileRow({
      tenantId,
      subBrand,
      fileMeta,
      syncJobId,
      status: "failed",
      failureReason: reason,
      sha256: fileSha256,
      fileSize: buffer.length,
    });
    return { status: "failed", reason };
  }

  const chunks = chunkText(extracted.text);
  throwIfAborted(signal, "indexOneFile");
  if (chunks.length === 0) {
    const reason = "text too short to chunk";
    await upsertFileRow({
      tenantId,
      subBrand,
      fileMeta,
      syncJobId,
      status: "failed",
      failureReason: reason,
      sha256: fileSha256,
      fileSize: buffer.length,
    });
    return { status: "failed", reason };
  }

  // Clean up old points before re-upserting (idempotent).
  await qdrant.deleteByDriveFile({ tenantId, subBrand, driveFileId: fileMeta.id, providerId });
  throwIfAborted(signal, "indexOneFile");

  const points = await buildPoints(tenantId, subBrand, fileMeta, chunks, embedConfig);
  throwIfAborted(signal, "indexOneFile");
  if (points.length === 0) {
    const reason = "embedding failed for all chunks";
    await upsertFileRow({
      tenantId,
      subBrand,
      fileMeta,
      syncJobId,
      status: "failed",
      failureReason: reason,
      sha256: fileSha256,
      fileSize: buffer.length,
    });
    return { status: "failed", reason };
  }

  const upserted = await qdrant.upsertPoints(points, providerId);
  throwIfAborted(signal, "indexOneFile");
  if (!upserted) {
    const reason = "qdrant upsert failed";
    await upsertFileRow({
      tenantId,
      subBrand,
      fileMeta,
      syncJobId,
      status: "failed",
      failureReason: reason,
      sha256: fileSha256,
      fileSize: buffer.length,
    });
    return { status: "failed", reason };
  }

  await upsertFileRow({
    tenantId,
    subBrand,
    fileMeta,
    syncJobId,
    status: "active",
    failureReason: null,
    sha256: fileSha256,
    fileSize: buffer.length,
  });

  return { status: "indexed", chunks: points.length };
}

async function upsertFileRow({
  tenantId,
  subBrand,
  fileMeta,
  syncJobId,
  status,
  failureReason,
  sha256 = null,
  fileSize = null,
}) {
  const data = {
    driveFileId: fileMeta.id,
    tenantId,
    subBrand,
    driveViewLink: fileMeta.publicViewLink || fallbackDriveLink(fileMeta.id),
    fileName: sanitizeText(fileMeta.name),
    folderPath: sanitizeText(fileMeta.folderPath),
    fileSize: fileSize ?? (fileMeta.size ? parseInt(fileMeta.size, 10) : null),
    mimeType: fileMeta.mimeType || "application/pdf",
    sha256: sha256 || null,
    syncJobId,
    status,
    failureReason: failureReason ? sanitizeText(failureReason) : null,
  };
  const existing = await prisma.travelKnowledgeBaseFile.findUnique({
    where: {
      tenantId_subBrand_driveFileId: {
        tenantId,
        subBrand,
        driveFileId: fileMeta.id,
      },
    },
  });
  if (existing) {
    return prisma.travelKnowledgeBaseFile.update({
      where: { id: existing.id },
      data,
    });
  }
  return prisma.travelKnowledgeBaseFile.create({ data });
}

/**
 * Run a full sync from a Drive root folder.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.rootFolderId
 * @returns {Promise<{jobId:number, status:string, discovered:number, indexed:number, failed:number, errorMessage:string|null}>}
 */
async function runSync({ tenantId, rootFolderId, job: existingJob = null }) {
  if (!qdrant.isEnabled()) {
    throw Object.assign(new Error("QDRANT_URL is not set"), { code: "QDRANT_NOT_CONFIGURED" });
  }

  const embedConfig = await embedClient.resolveEmbedConfig(tenantId);
  if (!embedConfig) {
    throw Object.assign(
      new Error("No supported AI provider is configured for embeddings. Configure OpenAI or Gemini in AI Settings."),
      { code: "EMBEDDING_PROVIDER_NOT_CONFIGURED" },
    );
  }
  const providerId = embedConfig.providerId;

  await qdrant.ensureCollection(undefined, providerId);
  const drive = await getDriveClient(tenantId);

  // Allow callers (background async start) to pre-create the job row so they can
  // return the job id immediately while sync continues in the background.
  let job = existingJob;
  if (!job) {
    job = await prisma.travelKnowledgeBaseSyncJob.create({
      data: { tenantId, rootFolderId, status: "running" },
    });
  }

  const controller = new AbortController();
  activeSyncs.set(job.id, { controller, tenantId });

  let discovered = 0;
  let indexed = 0;
  let failed = 0;
  let errorMessage = null;

  try {
    const rootChildren = await listFolderChildren(drive, rootFolderId);
    const subBrandFolders = rootChildren.filter((c) => c.mimeType === "application/vnd.google-apps.folder");

    for (const folder of subBrandFolders) {
      if (controller.signal.aborted) break;
      const subBrand = normaliseSubBrand(folder.name);
      if (!subBrand) continue;
      const pdfs = await listPdfsRecursive(drive, folder.id, folder.name);
      for (const pdf of pdfs) {
        if (controller.signal.aborted) break;
        discovered += 1;
        const result = await indexOneFile({
          drive,
          tenantId,
          subBrand,
          fileMeta: pdf,
          syncJobId: job.id,
          embedConfig,
          providerId,
          signal: controller.signal,
        });
        if (result.status === "indexed") indexed += 1;
        else if (result.status === "failed") failed += 1;
      }
    }

    const stopped = controller.signal.aborted;
    await prisma.travelKnowledgeBaseSyncJob.update({
      where: { id: job.id },
      data: {
        status: stopped ? "stopped" : "completed",
        completedAt: new Date(),
        filesDiscovered: discovered,
        filesIndexed: indexed,
        filesFailed: failed,
        errorMessage: stopped ? sanitizeText("Stopped by user") : null,
      },
    });

    return {
      jobId: job.id,
      status: stopped ? "stopped" : "completed",
      discovered,
      indexed,
      failed,
      providerId,
      errorMessage: stopped ? "Stopped by user" : null,
    };
  } catch (e) {
    const stopped = e?.code === "STOPPED" || controller.signal.aborted;
    errorMessage = stopped ? "Stopped by user" : e.message;
    if (!stopped) console.error("[travelKnowledgeBaseSync] sync failed:", e.message);
    await prisma.travelKnowledgeBaseSyncJob.update({
      where: { id: job.id },
      data: {
        status: stopped ? "stopped" : "failed",
        completedAt: new Date(),
        filesDiscovered: discovered,
        filesIndexed: indexed,
        filesFailed: failed,
        errorMessage: sanitizeText(errorMessage),
      },
    });
    if (stopped) {
      return {
        jobId: job.id,
        status: "stopped",
        discovered,
        indexed,
        failed,
        providerId,
        errorMessage,
      };
    }
    throw e;
  } finally {
    activeSyncs.delete(job.id);
  }
}

/**
 * Delete a Drive file from the index (used if a file is removed from Drive;
 * sync does not currently delete because Drive doesn't expose a reliable
 * tombstone list without change tokens). Public helper for admin cleanup.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {string} opts.driveFileId
 */
async function deleteFileFromIndex({ tenantId, subBrand, driveFileId }) {
  // A file may exist in any provider-specific collection; remove it from all of them.
  for (const providerId of embedClient.getSupportedProviders()) {
    await qdrant.deleteByDriveFile({ tenantId, subBrand, driveFileId, providerId });
  }
  await prisma.travelKnowledgeBaseFile.deleteMany({
    where: { tenantId, subBrand, driveFileId },
  });
}

/**
 * Return indexing statistics per sub-brand for the tenant.
 *
 * @param {number} tenantId
 * @returns {Promise<{subBrand:string, filesActive:number, filesFailed:number, chunksInQdrant:number}[]>}
 */
async function getStats(tenantId, providerId = "openai") {
  const files = await prisma.travelKnowledgeBaseFile.groupBy({
    by: ["subBrand", "status"],
    where: { tenantId },
    _count: { id: true },
  });
  const grouped = {};
  for (const row of files) {
    if (!grouped[row.subBrand]) grouped[row.subBrand] = { active: 0, failed: 0 };
    if (row.status === "active") grouped[row.subBrand].active += row._count.id;
    else grouped[row.subBrand].failed += row._count.id;
  }
  const result = [];
  for (const subBrand of Object.keys(grouped)) {
    const chunks = await qdrant.countPoints(tenantId, subBrand, providerId);
    result.push({
      subBrand,
      filesActive: grouped[subBrand].active,
      filesFailed: grouped[subBrand].failed,
      chunksInQdrant: chunks,
    });
  }
  return result;
}

module.exports = {
  runSync,
  stopSyncJob,
  deleteFileFromIndex,
  getStats,
  normaliseSubBrand,
  chunkText,
  SUB_BRAND_ALIASES,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
};
