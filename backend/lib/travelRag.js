/**
 * Travel CRM RAG query engine for TMC diagnostics.
 *
 * After a TMC (school-trips) diagnostic is submitted, this module:
 *   1. Builds a query sentence from the user's answers.
 *   2. Embeds the query via the tenant's configured embedding provider
 *      (OpenAI text-embedding-3-small or Gemini gemini-embedding-001).
 *   3. Searches the provider-specific Qdrant collection for the closest brochure
 *      chunks (tenant + subBrand = tmc).
 *   4. Asks the LLM router to generate a structured report using the tenant's
 *      selected chat model.
 *   5. Persists the result in TravelDiagnosticRagResult.
 *
 * The module is entirely additive: a failure at any step logs and returns null,
 * so the existing diagnostic submit flow is never blocked.
 */

const prisma = require("./prisma");
const qdrant = require("./qdrantClient");
const embedClient = require("./embedClient");
const llmRouter = require("./llmRouter");
const { sanitizeJsonForStringColumn } = require("./sanitizeJson");
const { READINESS_LEVELS, readinessLevelFromScore } = require("./travelDiagnosticScoring");
const { getRecommendationTopK, DEFAULT_TOP_K } = require("./diagnosticRecommendationSettings");

// Brochures commonly produce multiple chunks, so retrieve more chunks than
// the number of recommendations requested. Keep the query bounded: this path
// runs during public-form submission and a fixed 500-point search needlessly
// amplified latency and Qdrant load.
const RAG_MIN_RETRIEVAL = 30;
const RAG_RETRIEVAL_PER_RECOMMENDATION = 8;
const RAG_MAX_RETRIEVAL = 120;
// Historical default (bumped 5 -> 10 on 2026-08-24), now the fallback used
// when no admin-configured value exists — see diagnosticRecommendationSettings.js.
const MAX_RAG_RECOMMENDATIONS = DEFAULT_TOP_K; // how many trips are actually shown/rendered
const RAG_SUB_BRAND = "tmc";
const RAG_TASK = "travel-knowledge-rag";

function buildQueryText(answers, subBrand, _bank) {
  const parts = [];
  for (const [key, value] of Object.entries(answers || {})) {
    const v = Array.isArray(value) ? value.join(", ") : String(value);
    if (v && v.trim()) parts.push(`${key}: ${v}`);
  }
  const subBrandLabel = String(subBrand || "travel").trim();
  const prefix = subBrandLabel ? `${subBrandLabel} diagnostic profile` : "Travel diagnostic profile";
  return parts.length ? `${prefix}. ${parts.join(". ")}.` : `${prefix}.`;
}

function consolidateChunks(chunks) {
  // Group chunks back by file so the LLM sees whole-brochure context rather than
  // random snippet fragments. Keep only the closest chunk per file plus a
  // one-line summary of the others.
  const byFile = new Map();
  for (const c of chunks) {
    const fileId = c.payload?.driveFileId;
    if (!fileId) continue;
    if (!byFile.has(fileId)) byFile.set(fileId, { meta: c.payload, chunks: [] });
    byFile.get(fileId).chunks.push(c);
  }
  const result = [];
  for (const [fileId, { meta, chunks: cs }] of byFile) {
    const sorted = cs.sort((a, b) => b.score - a.score);
    const top = sorted[0];
    result.push({
      driveFileId: fileId,
      fileName: meta.fileName,
      folderPath: meta.folderPath,
      category: categoryFromFolderPath(meta.folderPath),
      driveLink: meta.driveViewLink,
      text: top.payload?.text || "",
      score: top.score,
    });
  }
  return result.sort((a, b) => b.score - a.score);
}

function categoryFromFolderPath(folderPath) {
  const parts = String(folderPath || '').split('/').map((part) => part.trim()).filter(Boolean);
  const ignored = new Set(['tmc', 'brochure', 'brochures']);
  const category = parts.find((part) => !ignored.has(part.toLowerCase()) && !/\.pdf$/i.test(part));
  return category || 'Other';
}

function brochureKey(value) {
  return String(value || '')
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

// LLM output is useful for the customer-facing explanation, but the Drive
// folder is source metadata. Recover it from the retrieved brochure instead
// of relying on the model to echo it correctly (or at all).
function attachBrochureMetadata(recommendations, brochures) {
  const byLink = new Map();
  const byName = new Map();
  for (const brochure of brochures || []) {
    if (brochure.driveLink) byLink.set(String(brochure.driveLink).trim(), brochure);
    const key = brochureKey(brochure.fileName);
    if (key) byName.set(key, brochure);
  }
  for (const recommendation of recommendations || []) {
    const match = byLink.get(String(recommendation.driveLink || '').trim())
      || byName.get(brochureKey(recommendation.name));
    if (!match) continue;
    recommendation.driveFileId = recommendation.driveFileId || match.driveFileId || '';
    recommendation.driveLink = recommendation.driveLink || match.driveLink || '';
    recommendation.folderPath = match.folderPath || recommendation.folderPath || '';
    recommendation.category = match.category || recommendation.category || 'Other';
  }
  return recommendations;
}

function brochureRecommendationKey(item) {
  const stableId = String(item?.brochureId || item?.driveFileId || '').trim();
  if (stableId) return `id:${stableId}`;
  const link = String(item?.driveLink || item?.brochurePdfUrl || '').trim();
  if (link) {
    const driveId = link.match(/\/d\/([^/?#]+)/i)?.[1]
      || link.match(/[?&]id=([^&#]+)/i)?.[1];
    return driveId ? `drive:${driveId}` : `link:${link.toLowerCase()}`;
  }
  const title = String(item?.name || item?.fileName || '')
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
  return title ? `title:${title}` : '';
}

function getRagRetrievalLimit(topK) {
  const requested = Math.max(1, Number(topK) || MAX_RAG_RECOMMENDATIONS);
  return Math.min(
    RAG_MAX_RETRIEVAL,
    Math.max(RAG_MIN_RETRIEVAL, requested * RAG_RETRIEVAL_PER_RECOMMENDATION),
  );
}

function fallbackSummary(brochure) {
  const category = String(brochure?.category || '').trim().toLowerCase();
  if (category.includes('campus')) {
    return 'An activity-led programme designed to build confidence, collaboration, and practical skills together.';
  }
  if (category.includes('international')) {
    return 'An immersive international learning experience that combines cultural discovery with hands-on exploration.';
  }
  if (category.includes('day')) {
    return 'A focused day experience that turns classroom learning into an engaging, memorable outing.';
  }
  return 'A well-rounded educational journey selected for its place-based learning and shared discovery opportunities.';
}

// Keep the AI-ranked results first, then complete the configured customer
// target from the next best answer-aware semantic brochure matches.
function fillRecommendationTarget(recommendations, brochures, topK) {
  const out = [];
  const seen = new Set();
  const add = (item) => {
    const key = brochureRecommendationKey(item);
    if (!key || seen.has(key) || out.length >= topK) return;
    seen.add(key);
    out.push(item);
  };
  for (const recommendation of recommendations || []) add(recommendation);
  for (const brochure of brochures || []) {
    add({
      driveFileId: brochure.driveFileId || '',
      name: String(brochure.fileName || '').replace(/\.pdf$/i, '').trim(),
      driveLink: brochure.driveLink || '',
      folderPath: brochure.folderPath || '',
      category: brochure.category || 'Other',
      summary: fallbackSummary(brochure),
      learnings: [],
    });
  }
  return out;
}

/**
 * Run the RAG pipeline for a single diagnostic and persist the result.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {number} opts.diagnosticId
 * @param {string} opts.subBrand
 * @param {object} opts.answers
 * @param {object} [opts.bank]
 * @returns {Promise<{id:number, readinessScore:number, recommendations:object}|null>}
 */
async function runRagForDiagnostic({ tenantId, diagnosticId, subBrand, answers, bank, persist = true }) {
  if (!subBrand) {
    console.log("[travelRag] no subBrand provided; skipping RAG");
    return null;
  }
  if (!qdrant.isEnabled()) {
    console.log("[travelRag] Qdrant not configured; skipping RAG");
    return null;
  }

  const topK = await getRecommendationTopK({ tenantId, subBrand });

  const embedConfig = await embedClient.resolveEmbedConfig(tenantId);
  if (!embedConfig) {
    console.log("[travelRag] No supported embedding provider configured; skipping RAG");
    return null;
  }

  const queryText = buildQueryText(answers, subBrand, bank);
  const queryVector = await embedConfig.client.embedText(queryText, embedConfig);
  if (!queryVector) {
    console.warn("[travelRag] query embedding failed");
    return null;
  }

  const chunks = await qdrant.searchBySubBrand({
    vector: queryVector,
    tenantId,
    subBrand,
    providerId: embedConfig.providerId,
    limit: getRagRetrievalLimit(topK),
  });
  if (!chunks.length) {
    console.log("[travelRag] no matching chunks found");
    return null;
  }

  const context = consolidateChunks(chunks);
  const recommendationCandidates = context.slice(0, Math.max(topK * 3, 30));
  const llmPayload = {
    subBrand,
    queryText,
    recommendationLimit: topK,
    brochures: recommendationCandidates.map((c) => ({
      fileName: c.fileName,
      folderPath: c.folderPath,
      category: c.category,
      driveLink: c.driveLink,
      excerpt: c.text,
    })),
  };

  let llmResult;
  try {
    llmResult = await llmRouter.routeRequest({
      task: RAG_TASK,
      payload: llmPayload,
      tenantId,
    });
  } catch (e) {
    console.error("[travelRag] LLM router call failed:", e.message);
    return null;
  }

  const parsed = parseRagResponse(llmResult?.text || "", topK);
  if (!parsed) {
    console.warn("[travelRag] LLM response did not contain valid RAG JSON");
    return null;
  }

  attachBrochureMetadata(parsed.recommendedTrips, recommendationCandidates);
  parsed.recommendedTrips = fillRecommendationTarget(
    parsed.recommendedTrips,
    recommendationCandidates,
    topK,
  );

  // Ensure at least `topK` recommendations (admin-configurable, defaults to
  // 10 — see diagnosticRecommendationSettings.js) by padding with the
  // next-best retrieved brochure entries when the LLM returns fewer. Never
  // exceed the retrieved set.
  // The shortlist is completed only from the ranked semantic retrieval set;
  // it is never filled from unrelated catalogue entries.

  const recommendationsJson = sanitizeJsonForStringColumn(JSON.stringify(parsed));
  const topChunkIdsJson = sanitizeJsonForStringColumn(
    JSON.stringify(chunks.map((c) => c.id)),
  );

  if (!persist) {
    return {
      id: null,
      readinessScore: parsed.readinessScore,
      recommendations: parsed,
      preview: true,
    };
  }

  const existing = await prisma.travelDiagnosticRagResult.findUnique({
    where: { diagnosticId },
  });
  const saved = existing
    ? await prisma.travelDiagnosticRagResult.update({
        where: { id: existing.id },
        data: {
          readinessScore: Number.isFinite(parsed.readinessScore) ? parsed.readinessScore : null,
          recommendationsJson,
          topChunkIdsJson,
          generatedAt: new Date(),
          model: llmResult.model,
          stub: Boolean(llmResult.stub),
        },
      })
    : await prisma.travelDiagnosticRagResult.create({
        data: {
          tenantId,
          diagnosticId,
          subBrand,
          readinessScore: Number.isFinite(parsed.readinessScore) ? parsed.readinessScore : null,
          recommendationsJson,
          topChunkIdsJson,
          generatedAt: new Date(),
          model: llmResult.model,
          stub: Boolean(llmResult.stub),
        },
      });

  return {
    id: saved.id,
    readinessScore: saved.readinessScore,
    recommendations: parsed,
  };
}

function escapeControlCharactersInJsonStrings(value) {
  let repaired = '';
  let inString = false;
  let escaping = false;

  for (const char of String(value || '')) {
    if (escaping) {
      repaired += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      repaired += char;
      escaping = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      repaired += char;
      continue;
    }
    if (inString && char.charCodeAt(0) < 0x20) {
      if (char === '\n') repaired += '\\n';
      else if (char === '\r') repaired += '\\r';
      else if (char === '\t') repaired += '\\t';
      else repaired += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    repaired += char;
  }
  return repaired;
}

function parseRagResponse(text, topK = DEFAULT_TOP_K) {
  if (!text) return null;
  const raw = text.trim();
  // Try to extract a JSON object from a fenced block or raw text.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonCandidate = fenceMatch ? fenceMatch[1].trim() : raw;
  // Strip any leading/trailing non-JSON text by finding the first { and last }.
  const start = jsonCandidate.indexOf("{");
  const end = jsonCandidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    console.warn("[travelRag] parseRagResponse: no JSON object found in response:", raw.slice(0, 500));
    return null;
  }
  const candidate = jsonCandidate.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    return validateAndNormalise(parsed, topK);
  } catch (e) {
    try {
      const repaired = escapeControlCharactersInJsonStrings(candidate);
      const parsed = JSON.parse(repaired);
      console.warn('[travelRag] recovered LLM JSON containing unescaped control characters');
      return validateAndNormalise(parsed, topK);
    } catch {
      console.warn("[travelRag] parseRagResponse: JSON.parse failed:", e.message, "candidate:", candidate.slice(0, 500));
      return null;
    }
  }
}

function isPolicyOrAdminText(text) {
  const t = String(text || "").toLowerCase();
  return /\b(cancellation|cancel|refund|non-refundable|payment|policy|policies|disclaimer|insurance|booking conditions?)\b/.test(t);
}

function validateAndNormalise(parsed, topK = DEFAULT_TOP_K) {
  if (!parsed || typeof parsed !== "object") return null;
  const out = {
    readinessScore: null,
    readinessLevel: null,
    readinessName: null,
    summary: "",
    recommendedTrips: [],
  };

  // Prefer the new 1-4 level + name; fall back to the legacy 0-10 score.
  const level = Number(parsed.readiness_level);
  if (Number.isFinite(level) && level >= 1 && level <= 4) {
    out.readinessLevel = Math.round(level);
    out.readinessName = READINESS_LEVELS[out.readinessLevel];
  }

  const score = Number(parsed.readinessScore);
  if (Number.isFinite(score)) {
    out.readinessScore = Math.min(10, Math.max(0, Math.round(score)));
  }

  // If the LLM gave a score but no level, derive the customer-facing level.
  if (!out.readinessLevel && out.readinessScore !== null) {
    const derived = readinessLevelFromScore(out.readinessScore);
    if (derived) {
      out.readinessLevel = derived.level;
      out.readinessName = derived.name;
    }
  }

  // If the LLM gave a level but no score, derive a representative score.
  if (out.readinessLevel && out.readinessScore === null) {
    const derivedScores = [null, 8, 6, 4, 2];
    out.readinessScore = derivedScores[out.readinessLevel];
  }

  // Accept an explicit name only if it matches one of the canonical labels.
  if (parsed.readiness_name && typeof parsed.readiness_name === "string") {
    const canonical = READINESS_LEVELS.slice(1).find(
      (n) => n.toLowerCase() === String(parsed.readiness_name).trim().toLowerCase(),
    );
    if (canonical) out.readinessName = canonical;
  }

  out.summary = String(parsed.summary || "").trim();

  const trips = Array.isArray(parsed.recommendedTrips) ? parsed.recommendedTrips : [];
  out.recommendedTrips = trips
    .map((trip) => {
      const name = String(trip.name || trip.tripName || "").trim();
      if (!name) return null;
      const driveLink = String(trip.driveLink || trip.driveViewLink || "").trim();
      let summary = String(trip.summary || "").trim();
      if (isPolicyOrAdminText(summary)) summary = "";

      // Prefer the new flat learnings array; fall back to the older places shape.
      let learnings = [];
      if (Array.isArray(trip.learnings)) {
        learnings = trip.learnings.map((l) => String(l)).filter(Boolean);
      } else if (Array.isArray(trip.places)) {
        for (const place of trip.places) {
          if (place?.learnings && Array.isArray(place.learnings)) {
            learnings.push(...place.learnings.map((l) => String(l)).filter(Boolean));
          }
        }
      }

      return {
        name,
        driveLink,
        folderPath: String(trip.folderPath || '').trim(),
        category: String(trip.category || trip.folderCategory || '').trim() || 'Other',
        summary,
        learnings: learnings.filter((l) => !isPolicyOrAdminText(l)).slice(0, 4),
      };
    })
    .filter(Boolean)
    // Was `.slice(0, RAG_TOP_K)` (15) — that's the Qdrant retrieval depth,
    // not the intended display cap. The LLM can legitimately return more
    // trips than the retrieval count in some responses, which let the PDF
    // render an 11th+ recommendation despite recommendations being capped
    // at `topK` everywhere else (curriculum fit, DiagnosticBuilder, etc.).
    .slice(0, topK);

  return out;
}

async function getRagResultForDiagnostic(diagnosticId) {
  const row = await prisma.travelDiagnosticRagResult.findUnique({
    where: { diagnosticId },
  });
  if (!row) return null;
  try {
    return {
      ...row,
      recommendations: JSON.parse(row.recommendationsJson),
    };
  } catch {
    return row;
  }
}

module.exports = {
  runRagForDiagnostic,
  getRagResultForDiagnostic,
  buildQueryText,
  parseRagResponse,
  attachBrochureMetadata,
  fillRecommendationTarget,
  consolidateChunks,
  getRagRetrievalLimit,
  RAG_SUB_BRAND,
  RAG_TASK,
  RAG_MIN_RETRIEVAL,
  RAG_MAX_RETRIEVAL,
  MAX_RAG_RECOMMENDATIONS,
};
