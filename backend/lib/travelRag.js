/**
 * Travel CRM RAG query engine for TMC diagnostics.
 *
 * After a TMC (school-trips) diagnostic is submitted, this module:
 *   1. Builds a query sentence from the user's answers.
 *   2. Embeds the query via OpenAI text-embedding-3-small.
 *   3. Searches Qdrant for the closest brochure chunks (tenant + subBrand = tmc).
 *   4. Asks the LLM router to generate a structured report:
 *        { readinessScore, recommendedTrips:[{name, driveLink, places:[{name, learnings:[]}]}] }
 *   5. Persists the result in TravelDiagnosticRagResult.
 *
 * The module is entirely additive: a failure at any step logs and returns null,
 * so the existing diagnostic submit flow is never blocked.
 */

const prisma = require("./prisma");
const qdrant = require("./qdrantClient");
const embedClient = require("./openAIEmbedClient");
const llmRouter = require("./llmRouter");
const { sanitizeJsonForStringColumn } = require("./sanitizeJson");

const RAG_TOP_K = 15;
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
  if (!embedClient.isEnabled()) {
    console.log("[travelRag] OpenAI embeddings not configured; skipping RAG");
    return null;
  }

  const queryText = buildQueryText(answers, subBrand, bank);
  const queryVector = await embedClient.embedText(queryText);
  if (!queryVector) {
    console.warn("[travelRag] query embedding failed");
    return null;
  }

  const chunks = await qdrant.searchBySubBrand({
    vector: queryVector,
    tenantId,
    subBrand,
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

  const parsed = parseRagResponse(llmResult?.text || "");
  if (!parsed) {
    console.warn("[travelRag] LLM response did not contain valid RAG JSON");
    return null;
  }

  // Ensure at least 5 recommendations by padding with the next-best retrieved
  // brochure entries when the LLM returns fewer. Never exceed the retrieved set.
  if (Array.isArray(parsed.recommendedTrips) && parsed.recommendedTrips.length < 5) {
    const seen = new Set(parsed.recommendedTrips.map((t) => String(t.name || "").trim().toLowerCase()));
    for (const c of context) {
      if (parsed.recommendedTrips.length >= 5) break;
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

function parseRagResponse(text) {
  if (!text) return null;
  const raw = text.trim();
  // Try to extract a JSON object from a fenced block or raw text.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonCandidate = fenceMatch ? fenceMatch[1].trim() : raw;
  // Strip any leading/trailing non-JSON text by finding the first { and last }.
  const start = jsonCandidate.indexOf("{");
  const end = jsonCandidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(jsonCandidate.slice(start, end + 1));
    return validateAndNormalise(parsed);
  } catch {
    return null;
  }
}

function isPolicyOrAdminText(text) {
  const t = String(text || "").toLowerCase();
  return /\b(cancellation|cancel|refund|non-refundable|payment|policy|policies|disclaimer|insurance|booking conditions?)\b/.test(t);
}

function validateAndNormalise(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const out = { readinessScore: null, summary: "", recommendedTrips: [] };

  const score = Number(parsed.readinessScore);
  out.readinessScore = Number.isFinite(score) ? Math.min(10, Math.max(0, Math.round(score))) : null;
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
    .slice(0, RAG_TOP_K); // cap at the retrieved chunk count so the PDF stays bounded

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
};
