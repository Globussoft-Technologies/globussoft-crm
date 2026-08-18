// Generic-vertical WhatsApp → auto-lead capture.
//
// Counterpart to lib/travelWhatsappLeadCapture.js, for plain-CRM (generic)
// tenants on the Meta Cloud API transport. Same shape and same guarantees —
// analyze after a few inbound messages, classify with the LLM and fall back to
// a deterministic keyword heuristic, auto-create the lead, never throw — but:
//
//   • gated on vertical === 'generic' (travel and wellness are untouched; the
//     travel module keeps its own vertical === 'travel' gate),
//   • generic business-enquiry keywords instead of the travel domain list,
//   • no sub-brand concept (that is travel-only), so no subBrand is stamped.
//
// WHY A SEPARATE MODULE: travelWhatsappLeadCapture's classifier prompt, keyword
// list and sub-brand routing are travel-specific end to end. Generalising it in
// place would have meant reshaping the live travel path for no travel benefit;
// a sibling module keeps that behaviour byte-identical.
//
// WIRED FROM: routes/whatsapp_webhook.js (Meta Cloud inbound). The travel module
// is wired from services/whatsappWebClient.js (WhatsApp Web QR) instead — the
// Meta webhook previously invoked NO lead capture at all, which is the gap this
// closes.
//
// DEDUP / EXISTING CONTACTS (product call): qualification decides, not whether
// the number is already known — an existing customer who sends a fresh enquiry
// is still an enquiry. But "lead" and "contact" are the SAME Contact row in this
// schema (a lead is `status: "Lead"`), so for a phone that already has a contact
// we must not (a) insert a duplicate row, nor (b) overwrite a customer's status,
// which would silently demote a paying customer to a lead and corrupt reporting.
// Instead a known contact gets the enquiry recorded as a Touchpoint and the
// thread linked, so it surfaces in the inbox and on the contact timeline without
// mutating their record. Set GENERIC_WA_LEAD_RESTATUS_KNOWN=1 to additionally
// flip a known contact to status "Lead" when it qualifies (off by default —
// it is destructive to customer records).

const MIN_INBOUND = Number(process.env.GENERIC_WA_LEAD_MIN_MSGS || 3);
const STEP = 3;   // re-analyze every N further inbound messages while no lead
const CAP = 15;   // stop re-analyzing past this many inbound messages
const CONFIDENCE_THRESHOLD = 0.55;
const CONTEXT_MESSAGES = 12;

// Enabled by default; opt out with GENERIC_WHATSAPP_AUTOLEADS=0.
function isFeatureEnabled() {
  return process.env.GENERIC_WHATSAPP_AUTOLEADS !== "0";
}

// Mirror the travel module's in-memory throttle. Once a lead exists for the
// phone the persistent check short-circuits, so this only bounds the
// classify-spend for chats that never qualify.
const verticalCache = new Map(); // tenantId -> bool (is generic)
const lastAnalyzedCount = new Map(); // `${tenantId}:${phone}` -> inbound count at last analysis

async function isGenericTenant(prisma, tenantId) {
  if (verticalCache.has(tenantId)) return verticalCache.get(tenantId);
  let isGeneric = false;
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
    // A null/absent vertical is the historical generic default.
    const v = t && t.vertical;
    isGeneric = !v || v === "generic";
  } catch { /* default false — never guess a tenant into scope */ }
  verticalCache.set(tenantId, isGeneric);
  return isGeneric;
}

// ── Deterministic keyword heuristic — the stub/no-key classifier ──────────────
//
// Generic B2B/B2C enquiry signal: someone asking about what you sell, what it
// costs, or wanting a callback/demo. Deliberately domain-neutral.
const ENQUIRY_KEYWORDS = [
  "price", "pricing", "cost", "quote", "quotation", "how much", "rate", "rates",
  "budget", "discount", "offer", "package", "plan", "plans", "subscription",
  "available", "availability", "stock", "in stock", "lead time", "delivery",
  "demo", "trial", "callback", "call back", "call me", "contact me",
  "interested", "enquiry", "inquiry", "requirement", "requirements",
  "proposal", "estimate", "invoice", "order", "buy", "purchase", "book",
  "service", "services", "support", "consultation", "appointment",
];
// Strong-intent phrases — someone explicitly asking to transact.
const STRONG_INTENT = [
  "how much", "send me a quote", "quotation", "want to buy", "interested in",
  "call me", "call back", "need a demo", "requirement",
];
// Signals this is NOT a business enquiry (personal chat / spam / automation).
const NEGATIVE_KEYWORDS = [
  "unsubscribe", "stop", "wrong number", "who is this", "happy birthday",
  "good morning", "good night", "forwarded as received", "lottery", "prize",
  "click here to win",
];

function heuristicClassify(text) {
  const lc = (text || "").toLowerCase();
  if (!lc.trim()) return { isEnquiry: false, confidence: 0, source: "heuristic" };

  const negHits = NEGATIVE_KEYWORDS.filter((k) => lc.includes(k));
  const hits = ENQUIRY_KEYWORDS.filter((k) => lc.includes(k));
  const strongHits = STRONG_INTENT.filter((k) => lc.includes(k));

  let confidence = 0;
  if (hits.length) confidence += 0.4 + Math.min(hits.length - 1, 3) * 0.1;
  if (strongHits.length) confidence += 0.2;
  // A pure greeting/spam message with no enquiry signal stays well under the bar.
  if (negHits.length && !strongHits.length) confidence -= 0.3;
  confidence = Math.max(0, Math.min(confidence, 0.95));

  const isEnquiry = hits.length > 0 && confidence >= CONFIDENCE_THRESHOLD;

  // What they appear to be asking about — the matched terms, for the CRM note.
  const intent = hits.slice(0, 4).join(", ") || null;

  return {
    isEnquiry,
    confidence: Number(confidence.toFixed(2)),
    intent,
    summary: null,
    source: "heuristic",
  };
}

// Try the LLM; fall back to the heuristic on stub-mode / parse failure / error.
// Uses the SAME "whatsapp-lead-qualify" task as travel so spend + LlmCallLog
// attribution stay on one task label, and so a blocked/unfunded tenant simply
// degrades to the heuristic instead of erroring (routeRequest throws a friendly
// error for tenants with no BYOK and no credits — caught below).
async function classifyConversation(tenantId, messages) {
  const text = (messages || []).filter(Boolean).join("\n");
  try {
    const llmRouter = require("./llmRouter");
    const result = await llmRouter.routeRequest({
      task: "whatsapp-lead-qualify",
      tenantId,
      payload: {
        instruction:
          "You classify an inbound WhatsApp conversation for a business CRM. Reply ONLY with JSON: " +
          '{"isEnquiry":bool,"confidence":0..1,"intent":string|null,"summary":string|null}. ' +
          "isEnquiry=true only for a genuine business enquiry — asking about products, services, " +
          "pricing, availability, a quote, a demo, or requesting a callback. " +
          "false for personal chat, greetings only, spam, or an existing-order support message.",
        messages: (messages || []).slice(-CONTEXT_MESSAGES),
      },
    });
    if (result && !result.stub && result.text) {
      const parsed = tryParseJson(result.text);
      if (parsed && typeof parsed.isEnquiry === "boolean") {
        return {
          isEnquiry: parsed.isEnquiry,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : (parsed.isEnquiry ? 0.7 : 0.2),
          intent: parsed.intent || null,
          summary: parsed.summary || null,
          source: "llm",
        };
      }
    }
  } catch (e) {
    console.warn(`[genericWaLead] LLM classify failed (using heuristic): ${e.message}`);
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

/**
 * Create the lead for an unknown phone. Mirrors the travel module's Contact
 * shape (minus subBrand) so it lands in the same Leads list.
 * Returns the contact, or null if one appeared concurrently.
 */
async function createLead(prisma, { tenantId, phone, name, analysis }) {
  const existing = await prisma.contact.findFirst({
    where: { tenantId, phone, deletedAt: null },
    select: { id: true },
  });
  if (existing) return null;

  // Conversation-based initial score from the classifier confidence (0..1 →
  // 1..100). aiScoreLastComputedAt=now keeps leadScoringEngine from immediately
  // re-zeroing it off not-yet-existent CRM engagement signals.
  const aiScore = Math.max(1, Math.min(100, Math.round((Number(analysis.confidence) || 0) * 100)));

  const contact = await prisma.contact.create({
    data: {
      tenantId,
      name: (name && name.trim()) || `WhatsApp ${phone}`,
      // Email intentionally blank — asked for in the chat, filled in later.
      // Contact.email is nullable and @@unique([email,tenantId]) permits NULLs.
      email: null,
      phone,
      source: "whatsapp",
      status: "Lead",
      aiScore,
      aiScoreLastComputedAt: new Date(),
    },
  });

  await linkThreadAndAttribute(prisma, { tenantId, phone, contactId: contact.id });
  return contact;
}

// Link the WhatsApp thread to the contact + record the inbound attribution.
// Both best-effort: neither is worth failing an ingest over.
async function linkThreadAndAttribute(prisma, { tenantId, phone, contactId }) {
  await prisma.whatsAppThread
    .update({
      where: { tenantId_contactPhone: { tenantId, contactPhone: phone } },
      data: { contactId },
    })
    .catch(() => {});
  await prisma.touchpoint
    .create({
      data: {
        tenantId,
        contactId,
        channel: "whatsapp",
        source: "inbound:whatsapp",
        occurredAt: new Date(),
      },
    })
    .catch(() => {});
}

/**
 * Main entry — called best-effort from the Meta webhook after an inbound
 * message is persisted.
 *
 * @param {{tenantId:number, phone:string, name?:string|null, threadId:number, isGroup?:boolean}} args
 */
async function maybeCaptureLead({ tenantId, phone, name, threadId, isGroup } = {}) {
  if (!isFeatureEnabled()) return { skipped: "disabled" };
  if (!tenantId || !phone || !threadId || isGroup) return { skipped: "ineligible" };
  const prisma = require("./prisma");

  if (!(await isGenericTenant(prisma, tenantId))) return { skipped: "not-generic" };

  const existing = await prisma.contact.findFirst({
    where: { tenantId, phone, deletedAt: null },
    select: { id: true, status: true },
  });

  // Wait for a few messages of context, then re-analyze every STEP up to CAP.
  const inboundCount = await prisma.whatsAppMessage.count({
    where: { tenantId, threadId, direction: "INBOUND" },
  });
  if (inboundCount < MIN_INBOUND || inboundCount > CAP) return { skipped: "below-threshold" };
  const key = `${tenantId}:${phone}`;
  const last = lastAnalyzedCount.get(key) || 0;
  if (last && inboundCount - last < STEP) return { skipped: "throttled" };
  lastAnalyzedCount.set(key, inboundCount);

  // Recent inbound bodies for context (oldest→newest).
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

  // Known phone → record the enquiry against the existing record rather than
  // duplicating it (see the DEDUP note in the header).
  if (existing) {
    await linkThreadAndAttribute(prisma, { tenantId, phone, contactId: existing.id });
    if (process.env.GENERIC_WA_LEAD_RESTATUS_KNOWN === "1" && existing.status !== "Lead") {
      await prisma.contact
        .update({ where: { id: existing.id }, data: { status: "Lead" } })
        .catch(() => {});
      console.log(`[genericWaLead] tenant ${tenantId} → existing contact ${existing.id} re-statused to Lead from WhatsApp enquiry`);
      return { restatused: true, contactId: existing.id, analysis };
    }
    console.log(`[genericWaLead] tenant ${tenantId} → enquiry from KNOWN contact ${existing.id} recorded (no duplicate created)`);
    return { attributed: true, contactId: existing.id, analysis };
  }

  const contact = await createLead(prisma, { tenantId, phone, name, analysis });
  if (!contact) return { skipped: "exists" };
  console.log(`[genericWaLead] tenant ${tenantId} → lead created from WhatsApp ${phone} (conf=${analysis.confidence}, via=${analysis.source})`);
  return { created: true, contactId: contact.id, analysis };
}

// Best-effort wrapper — NEVER throws, so it can't break message ingestion.
async function safeMaybeCaptureLead(args) {
  try {
    return await maybeCaptureLead(args);
  } catch (e) {
    console.error(`[genericWaLead] capture failed (non-fatal): ${e.message}`);
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
