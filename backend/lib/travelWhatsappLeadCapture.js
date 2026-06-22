// Travel WhatsApp → auto-lead capture (2026-06-19).
//
// Flow: a travel tenant links their WhatsApp via the QR session
// (services/whatsappWebClient.js). On each inbound 1:1 chat, once the
// conversation has a FEW messages of context, we analyze it with the LLM
// ("whatsapp-lead-qualify" task; deterministic keyword heuristic when no Q11
// key) and, if it reads as a travel/business enquiry, AUTO-CREATE a Travel
// lead — a Contact row tagged source="inbound:whatsapp" + the extracted
// sub-brand, exactly like routes/travel_inbound_leads.js so it lands in the
// same Travel Leads list. The WhatsApp thread is linked to the new contact.
//
// Design (per product call 2026-06-19):
//   - Analyze AFTER a few inbound messages (MIN_INBOUND) — more context = a
//     better classification than judging a bare "hi".
//   - Auto-create (no review queue).
//   - Dedup by phone: an existing contact/lead/customer is never duplicated.
//   - Travel-vertical ONLY. No-op for generic/wellness tenants.
//   - Best-effort: ingestInbound wraps the call so a capture failure NEVER
//     breaks message persistence.
//
// State (re-analysis throttle) is in-memory — consistent with the rest of
// whatsappWebClient's in-memory session model; single-backend demo box. Once a
// lead exists for the phone, the persistent dedup short-circuits it forever.

const MIN_INBOUND = Number(process.env.TRAVEL_WA_LEAD_MIN_MSGS || 3); // analyze once a chat has ≥ this many inbound msgs
const STEP = 3;   // re-analyze every N further messages if still no lead
const CAP = 15;   // stop re-analyzing after this many inbound msgs (give up)
const CONFIDENCE_THRESHOLD = 0.55;
const CONTEXT_MESSAGES = 12; // how many recent inbound bodies to feed the classifier

// Enabled by default for travel tenants; opt out with TRAVEL_WHATSAPP_AUTOLEADS=0.
function isFeatureEnabled() {
  return process.env.TRAVEL_WHATSAPP_AUTOLEADS !== "0";
}

const verticalCache = new Map(); // tenantId -> bool (is travel)
const lastAnalyzedCount = new Map(); // `${tenantId}:${phone}` -> inbound count at last analysis

async function isTravelTenant(prisma, tenantId) {
  if (verticalCache.has(tenantId)) return verticalCache.get(tenantId);
  let isTravel = false;
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
    isTravel = (t && t.vertical) === "travel";
  } catch { /* default false */ }
  verticalCache.set(tenantId, isTravel);
  return isTravel;
}

// ── Deterministic keyword heuristic — the stub/no-key classifier ──────────────
const TRAVEL_KEYWORDS = [
  "trip", "tour", "package", "holiday", "vacation", "honeymoon", "itinerary",
  "travel", "destination", "hotel", "resort", "flight", "ticket", "booking",
  "visa", "umrah", "hajj", "pilgrimage", "ziyarat", "makkah", "madinah",
  "passport", "tourist", "sightseeing", "excursion", "cruise", "getaway",
];
const INTENT_KEYWORDS = ["price", "cost", "quote", "quotation", "how much", "rate", "budget", "available", "availability", "book", "plan", "enquiry", "inquiry", "interested"];
const SUBBRAND_HINTS = [
  { sub: "rfu", words: ["umrah", "hajj", "pilgrimage", "ziyarat", "makkah", "madinah"] },
  { sub: "visasure", words: ["visa", "passport", "embassy", "stamping"] },
  { sub: "tmc", words: ["school", "student", "students", "educational", "college", "class"] },
  // travelstall = the family-holiday default (no specific hint needed)
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function heuristicClassify(text) {
  const lc = (text || "").toLowerCase();
  if (!lc.trim()) return { isEnquiry: false, confidence: 0, source: "heuristic" };

  const travelHits = TRAVEL_KEYWORDS.filter((k) => lc.includes(k));
  const intentHits = INTENT_KEYWORDS.filter((k) => lc.includes(k));
  // Confidence: travel-domain signal is the main driver; intent words add weight.
  let confidence = 0;
  if (travelHits.length) confidence += 0.45 + Math.min(travelHits.length - 1, 3) * 0.1;
  if (intentHits.length) confidence += 0.2;
  confidence = Math.min(confidence, 0.95);
  const isEnquiry = travelHits.length > 0 && confidence >= CONFIDENCE_THRESHOLD;

  // Sub-brand hint (first match wins; else travelstall default).
  let suggestedSubBrand = "travelstall";
  for (const h of SUBBRAND_HINTS) {
    if (h.words.some((w) => lc.includes(w))) { suggestedSubBrand = h.sub; break; }
  }
  // Destination: word(s) following "to"/"for"/"visit".
  let destination = null;
  const destMatch = lc.match(/\b(?:to|for|visit|visiting)\s+([a-z][a-z .'-]{2,30})/);
  if (destMatch) destination = destMatch[1].trim().replace(/\b\w/g, (c) => c.toUpperCase());
  // Pax: "<n> people/persons/pax/adults/travellers".
  let pax = null;
  const paxMatch = lc.match(/(\d{1,3})\s*(?:people|persons|pax|adults?|travell?ers?|members?)/);
  if (paxMatch) pax = Number(paxMatch[1]);
  // Dates: any month name present.
  const dates = MONTHS.some((m) => lc.includes(m)) ? "mentioned" : null;

  return {
    isEnquiry,
    confidence: Number(confidence.toFixed(2)),
    destination,
    pax,
    dates,
    intent: travelHits.slice(0, 4).join(", ") || null,
    suggestedSubBrand,
    source: "heuristic",
  };
}

// Try the LLM; fall back to the heuristic on stub-mode / parse failure / error.
async function classifyConversation(tenantId, messages) {
  const text = (messages || []).filter(Boolean).join("\n");
  try {
    const llmRouter = require("./llmRouter");
    const result = await llmRouter.routeRequest({
      task: "whatsapp-lead-qualify",
      tenantId,
      payload: {
        instruction:
          "You classify an inbound WhatsApp conversation for a travel agency. Reply ONLY with JSON: " +
          '{"isEnquiry":bool,"confidence":0..1,"destination":string|null,"dates":string|null,' +
          '"pax":number|null,"intent":string|null,"suggestedSubBrand":"tmc"|"rfu"|"travelstall"|"visasure"}. ' +
          "isEnquiry=true only for a genuine travel/business enquiry (trip/visa/umrah/hotel/flight/package), " +
          "false for personal chat or spam.",
        messages: (messages || []).slice(-CONTEXT_MESSAGES),
      },
    });
    if (result && !result.stub && result.text) {
      const parsed = tryParseJson(result.text);
      if (parsed && typeof parsed.isEnquiry === "boolean") {
        return {
          isEnquiry: parsed.isEnquiry,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : (parsed.isEnquiry ? 0.7 : 0.2),
          destination: parsed.destination || null,
          dates: parsed.dates || null,
          pax: typeof parsed.pax === "number" ? parsed.pax : null,
          intent: parsed.intent || null,
          suggestedSubBrand: ["tmc", "rfu", "travelstall", "visasure"].includes(parsed.suggestedSubBrand) ? parsed.suggestedSubBrand : "travelstall",
          source: "llm",
        };
      }
    }
  } catch (e) {
    console.warn(`[travelWaLead] LLM classify failed (using heuristic): ${e.message}`);
  }
  return heuristicClassify(text);
}

function tryParseJson(text) {
  try {
    const m = String(text).match(/\{[\s\S]*\}/); // tolerate prose around the JSON
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

// Create the Travel lead — mirrors routes/travel_inbound_leads.js's Contact
// shape so it shows up in the same Travel Leads list. Returns the contact, or
// null if a lead already exists for the phone (dedup).
async function createLead(prisma, { tenantId, phone, name, analysis }) {
  // Persistent dedup — never duplicate an existing contact/lead/customer.
  const existing = await prisma.contact.findFirst({
    where: { tenantId, phone, deletedAt: null },
    select: { id: true },
  });
  if (existing) return null;

  // Conversation-based lead score from the AI confidence (0..1 → 1..100). We
  // stamp aiScoreLastComputedAt=now so leadScoringEngine (which only re-scores
  // contacts older than its recompute window) leaves this initial score alone
  // rather than immediately zeroing it from the not-yet-engaged CRM signals.
  const aiScore = Math.max(1, Math.min(100, Math.round((Number(analysis.confidence) || 0) * 100)));

  const contact = await prisma.contact.create({
    data: {
      tenantId,
      name: (name && name.trim()) || `WhatsApp ${phone}`,
      // Email is left BLANK for WhatsApp leads (asked for in the chat + filled
      // in later). Contact.email is nullable; @@unique([email,tenantId]) allows
      // multiple NULLs.
      email: null,
      phone,
      // Source shows simply as "whatsapp" in the leads list (not "inbound:…").
      source: "whatsapp",
      subBrand: analysis.suggestedSubBrand || null,
      status: "Lead",
      aiScore,
      aiScoreLastComputedAt: new Date(),
    },
  });

  // Link the WhatsApp thread to the new contact so the inbox shows it's a lead.
  await prisma.whatsAppThread
    .update({ where: { tenantId_contactPhone: { tenantId, contactPhone: phone } }, data: { contactId: contact.id } })
    .catch(() => {});

  // Best-effort attribution Touchpoint (parity with the intake route).
  await prisma.touchpoint
    .create({ data: { tenantId, contactId: contact.id, channel: "whatsapp", source: "inbound:whatsapp", occurredAt: new Date() } })
    .catch(() => {});

  return contact;
}

// Main entry — called (best-effort) from whatsappWebClient.ingestInbound after
// an inbound message is persisted. `isGroup` chats are skipped.
async function maybeCaptureLead({ tenantId, phone, name, threadId, isGroup } = {}) {
  if (!isFeatureEnabled()) return { skipped: "disabled" };
  if (!tenantId || !phone || isGroup) return { skipped: "ineligible" };
  const prisma = require("./prisma");

  if (!(await isTravelTenant(prisma, tenantId))) return { skipped: "not-travel" };

  // Already a contact/lead for this phone? Nothing to do.
  const existing = await prisma.contact.findFirst({ where: { tenantId, phone, deletedAt: null }, select: { id: true } });
  if (existing) return { skipped: "exists" };

  // Wait for a few messages of context, then re-analyze every STEP up to CAP.
  const inboundCount = await prisma.whatsAppMessage.count({ where: { tenantId, threadId, direction: "INBOUND" } });
  if (inboundCount < MIN_INBOUND || inboundCount > CAP) return { skipped: "below-threshold" };
  const key = `${tenantId}:${phone}`;
  const last = lastAnalyzedCount.get(key) || 0;
  if (last && inboundCount - last < STEP) return { skipped: "throttled" };
  lastAnalyzedCount.set(key, inboundCount);

  // Pull recent inbound bodies for context (oldest→newest).
  const rows = await prisma.whatsAppMessage.findMany({
    where: { tenantId, threadId, direction: "INBOUND", body: { not: null } },
    orderBy: { createdAt: "desc" },
    take: CONTEXT_MESSAGES,
    select: { body: true },
  });
  const messages = rows.map((r) => r.body).reverse();
  if (!messages.length) return { skipped: "no-text" };

  const analysis = await classifyConversation(tenantId, messages);
  if (!analysis.isEnquiry || analysis.confidence < CONFIDENCE_THRESHOLD) {
    return { skipped: "not-enquiry", analysis };
  }

  const contact = await createLead(prisma, { tenantId, phone, name, analysis });
  if (!contact) return { skipped: "exists" };
  console.log(`[travelWaLead] tenant ${tenantId} → lead created from WhatsApp ${phone} (sub=${analysis.suggestedSubBrand}, conf=${analysis.confidence}, via=${analysis.source})`);
  return { created: true, contactId: contact.id, analysis };
}

// Best-effort wrapper — NEVER throws, so it can't break message ingestion.
async function safeMaybeCaptureLead(args) {
  try {
    return await maybeCaptureLead(args);
  } catch (e) {
    console.error(`[travelWaLead] capture failed (non-fatal): ${e.message}`);
    return { skipped: "error" };
  }
}

module.exports = {
  safeMaybeCaptureLead,
  maybeCaptureLead,
  classifyConversation,
  heuristicClassify,
  createLead,
  // test seams
  _verticalCache: verticalCache,
  _lastAnalyzedCount: lastAnalyzedCount,
  MIN_INBOUND,
  CONFIDENCE_THRESHOLD,
};
