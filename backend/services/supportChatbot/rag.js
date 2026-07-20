/**
 * supportChatbot/rag — MVP retrieval for the Wellness Admin Support
 * Chatbot.
 *
 * Deliberately simple: keyword search over (1) the tenant's published
 * KbArticle rows (title + content) and (2) the wellness product docs
 * shipped in the repo (docs/wellness-client/*.md). Both sources are
 * ranked in-process and top-3 snippets are returned. No embeddings, no
 * vector store — the wellness KB is small (dozens of articles) and the
 * docs are a bounded set, so Prisma `contains` / in-memory ranking is
 * good enough for "how do I reschedule an appointment"-class queries.
 *
 * The interface returns ranked { id, title, slug, snippet, source }
 * rows so a future embedding implementation can slot in behind the same
 * function signature.
 */

const fs = require("fs");
const path = require("path");
const prisma = require("../../lib/prisma");

const WELLNESS_DOCS_DIR = path.resolve(__dirname, "../../../docs/wellness-client");
// Canonical, staff-facing sources only. STATUS.md is a frozen/superseded
// snapshot and IMPLEMENTATION_PLAN/EXTERNAL_API/DEMO_14_4 are engineering or
// partner docs — keeping them out of the pool stops stale/API-level content
// from leaking into answers meant for clinic staff.
const WELLNESS_DOC_FILES = [
  "SUPPORT_CHATBOT_KNOWLEDGE_BASE.md",
  "PRD.md",
];

let wellnessDocsCache = null;

const SNIPPET_LENGTH = 280;
// Fetch a bounded candidate pool for in-process ranking. The `contains`
// pre-filter keeps this small in practice; the ceiling protects the
// request path if a KB grows large.
const CANDIDATE_POOL = 50;

/**
 * Extract the most query-relevant window of an article body as a snippet.
 * Centres the window on the first occurrence of the strongest matching
 * term; falls back to the article opening.
 */
function makeSnippet(content, terms) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (text.length <= SNIPPET_LENGTH) return text;
  const lower = text.toLowerCase();
  let pivot = -1;
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx !== -1 && (pivot === -1 || idx < pivot)) pivot = idx;
  }
  if (pivot === -1) return `${text.slice(0, SNIPPET_LENGTH)}…`;
  const start = Math.max(0, pivot - 60);
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/**
 * loadWellnessDocs() → [{ title, source, content }]
 *
 * Reads the wellness PRD / implementation / API docs once and caches
 * them in memory. Failures are logged but non-fatal — a missing doc just
 * reduces the RAG pool.
 */
/**
 * splitDocSections(content, source) → [{ title, sectionContent }]
 *
 * Splits a markdown file by H2 headings so each how-to section becomes its
 * own searchable document. This gives section titles (e.g. "How to add a
 * new patient") the title-match boost instead of burying them inside one
 * giant file document.
 */
function splitDocSections(content, source) {
  const lines = String(content || "").split(/\r?\n/);
  const sections = [];
  let currentTitle = `[Wellness Docs] ${source.replace(/\.md$/i, "").replace(/_/g, " ")}`;
  let currentBody = [];

  const flush = () => {
    const body = currentBody.join("\n").trim();
    if (body || sections.length === 0) {
      sections.push({ title: currentTitle, content: body || currentTitle });
    }
  };

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flush();
      currentTitle = heading[1].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  flush();
  return sections;
}

function loadWellnessDocs() {
  if (wellnessDocsCache) return wellnessDocsCache;
  const docs = [];
  for (const file of WELLNESS_DOC_FILES) {
    const filePath = path.join(WELLNESS_DOCS_DIR, file);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const sections = splitDocSections(content, file);
      for (const [index, section] of sections.entries()) {
        docs.push({
          title: section.title,
          source: file,
          sectionIndex: index,
          content: section.content,
        });
      }
    } catch (err) {
      console.warn(`[support-chatbot] wellness doc unreadable (${file}): ${err.message}`);
    }
  }
  wellnessDocsCache = docs;
  return docs;
}

/**
 * searchWellnessDocs(query, { limit }) →
 *   [{ id, title, slug: null, snippet, score, source: 'wellness-doc' }]
 *
 * In-memory keyword search over the repo's wellness markdown docs. The
 * scoring mirrors searchHelpDocs so the two pools can be merged fairly.
 */
function searchWellnessDocs(query, { limit = 3 } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];

  const terms = q
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3)
    .slice(0, 6);
  if (terms.length === 0) return [];

  const docs = loadWellnessDocs();
  const ranked = docs
    .map((d) => {
      const title = d.title.toLowerCase();
      const body = (d.content || "").toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += 8; // section heading match is a strong signal
        const occurrences = body.split(t).length - 1;
        score += Math.min(occurrences, 4); // cap body-frequency contribution
      }
      return {
        id: `wellness-doc:${d.source}:${d.sectionIndex}`,
        title: `[Wellness Docs] ${d.title}`,
        slug: null,
        snippet: makeSnippet(`${d.title}\n\n${d.content}`, terms),
        score,
        source: "wellness-doc",
      };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked;
}

/**
 * searchHelpDocs(tenantId, query, { limit }) →
 *   [{ id, title, slug, snippet, score, source }]
 *
 * Tenant-scoped KB search (tenantId + isPublished=true) merged with the
 * wellness repo docs. Results are ranked in one pool and sliced to
 * `limit`. Each row carries a `source` discriminator ('kb' or
 * 'wellness-doc'). Empty/blank queries return [] rather than erroring so
 * the tool loop can continue with a "no docs found" answer.
 */
async function searchHelpDocs(tenantId, query, { limit = 3 } = {}) {
  const q = String(query || "").trim();
  if (!tenantId || !q) return { results: [], kbLinks: [] };

  // Multi-term queries: match articles containing ANY term (OR). Ranking
  // below rewards articles matching MORE terms, so OR-recall + in-process
  // precision beats an AND query that returns nothing on phrasing drift.
  const terms = q
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3) // skip stop-word-length noise ("how", "do", "i")
    .slice(0, 6);
  if (terms.length === 0) return { results: [], kbLinks: [] };

  const orClauses = terms.flatMap((t) => [
    { title: { contains: t } },
    { content: { contains: t } },
  ]);

  const candidates = await prisma.kbArticle.findMany({
    where: {
      tenantId: Number(tenantId),
      isPublished: true,
      OR: orClauses,
    },
    select: { id: true, title: true, slug: true, content: true },
    take: CANDIDATE_POOL,
  });

  const ranked = candidates
    .map((a) => {
      const title = (a.title || "").toLowerCase();
      const body = (a.content || "").toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += 5; // title match is the strongest signal
        const occurrences = body.split(t).length - 1;
        score += Math.min(occurrences, 5); // cap term-frequency contribution
      }
      return {
        id: a.id,
        title: a.title,
        slug: a.slug,
        snippet: makeSnippet(a.content, terms),
        score,
        source: "kb",
      };
    })
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const docs = searchWellnessDocs(q, { limit });

  // Merge KB articles and wellness docs by score, keeping the top `limit`
  // overall so the LLM prompt stays compact. Each row carries a `source`
  // discriminator ('kb' or 'wellness-doc').
  const results = [...ranked, ...docs]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Return all matching KB articles separately so deep links can surface
  // even when wellness docs dominate the merged context window.
  return { results, kbLinks: ranked };
}

module.exports = { searchHelpDocs, searchWellnessDocs, loadWellnessDocs, makeSnippet };
