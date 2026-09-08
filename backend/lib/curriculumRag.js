/**
 * AI curriculum-to-itinerary matching engine.
 *
 * Two responsibilities:
 *   1. indexCurriculumDocument() — given an uploaded curriculum PDF's
 *      extracted text + admin-entered info-plate metadata (board, grade
 *      band, subjects), extract discrete learning objectives via the LLM
 *      router and embed+upsert them into the shared curriculum_objectives
 *      Qdrant collection (see qdrantClient.js — one collection for every
 *      curriculum, disambiguated by payload metadata, not one collection
 *      per curriculum).
 *   2. matchCurriculumForDiagnostic() — at diagnostic-submit time, embed the
 *      school's stated profile ONCE, search BOTH the curriculum_objectives
 *      collection and the existing itinerary knowledge-base collection with
 *      that same vector, then ask the LLM to produce a final ranked
 *      destination shortlist with per-destination reasoning — in the same
 *      { curriculum, grade, subject, recommendations: [...] } shape
 *      travelDiagnosticCurriculumFit.js already produces, so the PDF
 *      renderer and public report page need no changes to display it.
 *
 * Entirely additive and fail-soft: every public function returns null (or
 * throws only where the caller is a deliberate admin action) rather than
 * ever corrupting the existing exact-match TravelCurriculumMapping flow.
 */

const crypto = require("crypto");
const qdrant = require("./qdrantClient");
const embedClient = require("./embedClient");
const llmRouter = require("./llmRouter");
const { getRecommendationTopK } = require("./diagnosticRecommendationSettings");

const ITINERARY_TOP_K = 15;
const OBJECTIVE_SEARCH_LIMIT = 24;
const MAX_OBJECTIVES_PER_DOCUMENT = 200;

function normalizeTag(value) {
  return String(value || "").trim().toUpperCase();
}

function deterministicPointId(tenantId, subBrand, documentId, index) {
  return crypto
    .createHash("sha256")
    .update(`curriculum:${tenantId}:${subBrand}:${documentId}:${index}`)
    .digest("hex")
    .slice(0, 32);
}

function parseJsonObject(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Extract learning objectives from curriculum text and index them into
 * Qdrant under the tenant's currently active embedding provider.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {string} opts.documentId
 * @param {string} opts.text - extracted PDF text
 * @param {string} opts.title
 * @param {string} opts.board
 * @param {string} opts.gradeBand
 * @param {string[]} opts.subjects
 * @returns {Promise<{objectives: object[], objectiveCount: number, qdrantPointIds: string[], embedProviderId: string}>}
 */
async function indexCurriculumDocument({ tenantId, subBrand, documentId, text, title, board, gradeBand, subjects }) {
  const embedConfig = await embedClient.resolveEmbedConfig(tenantId);
  if (!embedConfig) {
    const err = new Error(
      "Embeddings require an OpenAI or Gemini key configured in AI Settings before a curriculum document can be indexed.",
    );
    err.code = "NO_EMBEDDING_PROVIDER";
    throw err;
  }

  const objectives = await extractObjectives({ tenantId, text, board, gradeBand, subjects });
  const { qdrantPointIds } = await embedAndIndexObjectives({
    tenantId,
    subBrand,
    documentId,
    title,
    board,
    gradeBand,
    subjects,
    objectives,
    embedConfig,
  });

  return {
    objectives,
    objectiveCount: objectives.length,
    qdrantPointIds,
    embedProviderId: embedConfig.providerId,
  };
}

/**
 * Re-embed ALREADY-EXTRACTED objectives under the tenant's CURRENT embedding
 * provider, without calling the LLM again. This is the "switched provider,
 * need to index under the new one" path discussed for the admin UI — cheap
 * (no re-extraction cost) and safe to call repeatedly.
 *
 * @param {object} opts - same shape as indexCurriculumDocument minus `text`, plus `objectives`
 * @returns {Promise<{qdrantPointIds: string[], embedProviderId: string}>}
 */
async function reindexCurriculumDocument({ tenantId, subBrand, documentId, title, board, gradeBand, subjects, objectives }) {
  const embedConfig = await embedClient.resolveEmbedConfig(tenantId);
  if (!embedConfig) {
    const err = new Error(
      "Embeddings require an OpenAI or Gemini key configured in AI Settings before a curriculum document can be re-indexed.",
    );
    err.code = "NO_EMBEDDING_PROVIDER";
    throw err;
  }
  return embedAndIndexObjectives({
    tenantId,
    subBrand,
    documentId,
    title,
    board,
    gradeBand,
    subjects,
    objectives: objectives || [],
    embedConfig,
  });
}

async function extractObjectives({ tenantId, text, board, gradeBand, subjects }) {
  const trimmedText = String(text || "").slice(0, 60000); // keep the LLM payload bounded
  if (!trimmedText.trim()) return [];

  let llmResult;
  try {
    llmResult = await llmRouter.routeRequest({
      task: "curriculum-objective-extraction",
      payload: { text: trimmedText, board, gradeBand, subjects },
      tenantId,
    });
  } catch (e) {
    const err = new Error(`Curriculum objective extraction failed: ${e.message}`);
    err.code = "EXTRACTION_FAILED";
    throw err;
  }

  const parsed = parseJsonObject(llmResult?.text || "");
  const raw = Array.isArray(parsed?.objectives) ? parsed.objectives : [];
  return raw
    .map((o) => ({
      text: String(o?.text || "").trim(),
      subject: String(o?.subject || "").trim() || (subjects && subjects[0]) || "General",
      topicCode: o?.topicCode ? String(o.topicCode).trim() : null,
    }))
    .filter((o) => o.text)
    .slice(0, MAX_OBJECTIVES_PER_DOCUMENT);
}

async function embedAndIndexObjectives({ tenantId, subBrand, documentId, title, board, gradeBand, subjects, objectives, embedConfig }) {
  // Always clear previously-indexed points for this document under the
  // CURRENT provider first, so a re-run never leaves stale/duplicate
  // objectives behind (e.g. after a re-upload with fewer objectives).
  await qdrant.deleteCurriculumByDocument({
    tenantId,
    subBrand,
    documentId,
    providerId: embedConfig.providerId,
  });

  if (!objectives.length) return { qdrantPointIds: [] };

  const texts = objectives.map((o) => o.text);
  const { embeddings } = await embedConfig.client.embedTexts(texts, embedConfig);

  const boardNormalized = normalizeTag(board);
  const gradeBandNormalized = normalizeTag(gradeBand);
  const points = [];
  const qdrantPointIds = [];
  objectives.forEach((objective, index) => {
    const vector = embeddings.get(index);
    if (!vector) return;
    const id = deterministicPointId(tenantId, subBrand, documentId, index);
    points.push({
      id,
      vector,
      payload: {
        tenantId: Number(tenantId),
        subBrand: String(subBrand),
        documentId: String(documentId),
        title: title || null,
        board: board || null,
        boardNormalized,
        gradeBand: gradeBand || null,
        gradeBandNormalized,
        subjects: Array.isArray(subjects) ? subjects : [],
        subject: objective.subject,
        objectiveText: objective.text,
        topicCode: objective.topicCode,
      },
    });
    qdrantPointIds.push(id);
  });

  if (points.length) {
    await qdrant.upsertCurriculumPoints(points, embedConfig.providerId);
  }

  return { qdrantPointIds };
}

/**
 * Delete all indexed points for a document under the CURRENT provider
 * (called before a document is deleted/re-uploaded).
 */
async function deindexCurriculumDocument({ tenantId, subBrand, documentId }) {
  const embedConfig = await embedClient.resolveEmbedConfig(tenantId);
  const providerId = embedConfig?.providerId || "openai";
  return qdrant.deleteCurriculumByDocument({ tenantId, subBrand, documentId, providerId });
}

function buildQueryText(profile) {
  const parts = [];
  if (profile.curriculum) parts.push(`Curriculum board: ${profile.curriculum}`);
  if (profile.grade) parts.push(`Grade: ${profile.grade}`);
  if (profile.subject) parts.push(`Subject: ${profile.subject}`);
  if (profile.outcomes) parts.push(`Desired learning outcomes: ${profile.outcomes}`);
  return parts.length ? parts.join(". ") : "General curriculum-aligned school trip.";
}

// Group itinerary chunks by source file, keep the strongest chunk per file —
// mirrors travelRag.js's consolidateChunks() so both matching paths treat
// the itinerary collection identically.
function consolidateItineraryChunks(chunks) {
  const byFile = new Map();
  for (const c of chunks) {
    const fileId = c.payload?.driveFileId;
    if (!fileId) continue;
    if (!byFile.has(fileId)) byFile.set(fileId, { meta: c.payload, chunks: [] });
    byFile.get(fileId).chunks.push(c);
  }
  const result = [];
  for (const [, { meta, chunks: cs }] of byFile) {
    const top = cs.sort((a, b) => b.score - a.score)[0];
    result.push({
      fileName: meta.fileName,
      driveLink: meta.driveViewLink,
      text: top.payload?.text || "",
      score: top.score,
    });
  }
  return result.sort((a, b) => b.score - a.score);
}

/**
 * At diagnostic-submit time: search curriculum objectives + itinerary
 * excerpts with one shared query embedding, and ask the LLM to produce the
 * final ranked shortlist.
 *
 * Returns null (never throws) whenever the AI path genuinely has nothing to
 * offer — no embedding provider configured, or no curriculum documents
 * indexed yet for this tenant/subBrand — so the caller can fall back to the
 * existing exact-match TravelCurriculumMapping path unchanged.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {object} opts.profile - { curriculum, grade, subject, outcomes? }
 * @returns {Promise<{curriculum,grade,subject,recommendations:object[]}|null>}
 */
async function matchCurriculumForDiagnostic({ tenantId, subBrand, profile }) {
  if (!qdrant.isEnabled()) return null;
  if (!profile || (!profile.curriculum && !profile.grade)) return null;

  const topK = await getRecommendationTopK({ tenantId, subBrand });
  const embedConfig = await embedClient.resolveEmbedConfig(tenantId);
  if (!embedConfig) return null;

  const availableObjectives = await qdrant.countCurriculumPoints(tenantId, subBrand, embedConfig.providerId);
  if (!availableObjectives) return null; // no curriculum docs indexed yet — let exact-match handle it

  const queryText = buildQueryText(profile);
  const queryVector = await embedConfig.client.embedText(queryText, embedConfig);
  if (!queryVector) return null;

  const [objectiveHits, itineraryHits] = await Promise.all([
    qdrant.searchCurriculum({
      vector: queryVector,
      tenantId,
      subBrand,
      board: profile.curriculum,
      gradeBand: profile.grade,
      providerId: embedConfig.providerId,
      limit: OBJECTIVE_SEARCH_LIMIT,
    }),
    qdrant.searchBySubBrand({
      vector: queryVector,
      tenantId,
      subBrand,
      providerId: embedConfig.providerId,
      limit: ITINERARY_TOP_K,
    }),
  ]);

  // No board/gradeBand exact hits (casing/naming drift) — retry the
  // curriculum search once without the filter so a near-match still surfaces
  // rather than silently returning nothing.
  let effectiveObjectiveHits = objectiveHits;
  if (!effectiveObjectiveHits.length && (profile.curriculum || profile.grade)) {
    effectiveObjectiveHits = await qdrant.searchCurriculum({
      vector: queryVector,
      tenantId,
      subBrand,
      providerId: embedConfig.providerId,
      limit: OBJECTIVE_SEARCH_LIMIT,
    });
  }
  if (!effectiveObjectiveHits.length || !itineraryHits.length) return null;

  const itineraryContext = consolidateItineraryChunks(itineraryHits);

  const llmPayload = {
    profile: {
      curriculum: profile.curriculum || null,
      grade: profile.grade || null,
      subject: profile.subject || null,
      outcomes: profile.outcomes || null,
    },
    curriculumObjectives: effectiveObjectiveHits.map((h) => ({
      subject: h.payload.subject,
      objective: h.payload.objectiveText,
    })),
    itineraries: itineraryContext.map((c) => ({
      fileName: c.fileName,
      driveLink: c.driveLink,
      excerpt: c.text,
    })),
  };

  let llmResult;
  try {
    llmResult = await llmRouter.routeRequest({
      task: "curriculum-itinerary-match",
      payload: llmPayload,
      tenantId,
    });
  } catch (e) {
    console.error("[curriculumRag] LLM router call failed:", e.message);
    return null;
  }

  const parsed = parseJsonObject(llmResult?.text || "");
  const rawRecs = Array.isArray(parsed?.recommendations) ? parsed.recommendations : [];
  const recommendations = rawRecs
    .map((r) => {
      const destination = String(r?.destination || "").trim();
      if (!destination) return null;
      const fitScore = Number.isFinite(Number(r?.fitScore)) ? Math.max(1, Math.min(100, Math.round(Number(r.fitScore)))) : null;
      const reasons = (Array.isArray(r?.reasons) ? r.reasons : [])
        .map((reason) => ({
          subject: reason?.subject ? String(reason.subject).trim() : null,
          learningOutcome: reason?.learningOutcome ? String(reason.learningOutcome).trim() : null,
          rationale: null,
        }))
        .filter((reason) => reason.learningOutcome)
        .slice(0, 4);
      return {
        destination,
        fitScore,
        reasons,
        brochurePdfUrl: r?.driveLink ? String(r.driveLink).trim() : null,
        mappingIds: [],
        source: "ai",
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
    .slice(0, topK);

  if (!recommendations.length) return null;

  return {
    curriculum: profile.curriculum || null,
    grade: profile.grade || null,
    subject: profile.subject || null,
    recommendations,
  };
}

module.exports = {
  indexCurriculumDocument,
  reindexCurriculumDocument,
  deindexCurriculumDocument,
  matchCurriculumForDiagnostic,
};
