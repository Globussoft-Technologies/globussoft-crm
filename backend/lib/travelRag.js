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

const RAG_TOP_K = 15; // Qdrant retrieval depth — how many brochure chunks to fetch
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
  for (const [, { meta, chunks: cs }] of byFile) {
    const sorted = cs.sort((a, b) => b.score - a.score);
    const top = sorted[0];
    result.push({
      fileName: meta.fileName,
      folderPath: meta.folderPath,
      driveLink: meta.driveViewLink,
      text: top.payload?.text || "",
      score: top.score,
    });
  }
  return result.sort((a, b) => b.score - a.score);
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
async function runRagForDiagnostic({ tenantId, diagnosticId, subBrand, answers, bank }) {
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
    limit: RAG_TOP_K,
  });
  if (!chunks.length) {
    console.log("[travelRag] no matching chunks found");
    return null;
  }

  const context = consolidateChunks(chunks);
  const llmPayload = {
    subBrand,
    queryText,
    brochures: context.map((c) => ({
      fileName: c.fileName,
      folderPath: c.folderPath,
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

  // Ensure at least `topK` recommendations (admin-configurable, defaults to
  // 10 — see diagnosticRecommendationSettings.js) by padding with the
  // next-best retrieved brochure entries when the LLM returns fewer. Never
  // exceed the retrieved set.
  if (Array.isArray(parsed.recommendedTrips) && parsed.recommendedTrips.length < topK) {
    const seen = new Set(parsed.recommendedTrips.map((t) => String(t.name || "").trim().toLowerCase()));
    for (const c of context) {
      if (parsed.recommendedTrips.length >= topK) break;
      const tripName = String(c.fileName || "").replace(/\.pdf$/i, "").trim();
      if (!tripName) continue;
      const key = tripName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      parsed.recommendedTrips.push({
        name: tripName,
        driveLink: c.driveLink || "",
        summary: "",
        learnings: [],
      });
    }
  }

  const recommendationsJson = sanitizeJsonForStringColumn(JSON.stringify(parsed));
  const topChunkIdsJson = sanitizeJsonForStringColumn(
    JSON.stringify(chunks.map((c) => c.id)),
  );

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
  try {
    const parsed = JSON.parse(jsonCandidate.slice(start, end + 1));
    return validateAndNormalise(parsed, topK);
  } catch (e) {
    console.warn("[travelRag] parseRagResponse: JSON.parse failed:", e.message, "candidate:", jsonCandidate.slice(start, end + 1).slice(0, 500));
    return null;
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

      return { name, driveLink, summary, learnings: learnings.filter((l) => !isPolicyOrAdminText(l)).slice(0, 4) };
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
  RAG_SUB_BRAND,
  RAG_TASK,
  RAG_TOP_K,
  MAX_RAG_RECOMMENDATIONS,
};
