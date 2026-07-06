// Wellness WhatsApp → auto-lead capture.
//
// Flow: a wellness tenant links WhatsApp via the QR session
// (services/whatsappWebClient.js). On each inbound 1:1 chat, once the
// conversation has MIN_INBOUND messages of context, we classify it with the
// LLM (falling back to a keyword heuristic when no key is configured). If it
// reads as a clinic/wellness enquiry we AUTO-CREATE a Contact row tagged
// source="whatsapp", status="Lead" and run it through leadAutoRouter.pickAssignee
// so the right doctor or telecaller is assigned immediately.
//
// Design decisions:
//   - Analyze AFTER MIN_INBOUND messages; re-analyze every STEP further messages
//     up to CAP to catch slow-burn conversations.
//   - Auto-create (no review queue) — mirrors travelWhatsappLeadCapture.js.
//   - Dedup by phone: existing contact is never duplicated.
//   - Wellness-vertical ONLY. No-op for generic/travel tenants.
//   - Best-effort: always wrapped in safeMaybeCaptureLead so a capture failure
//     NEVER breaks message persistence.

const MIN_INBOUND = Number(process.env.WELLNESS_WA_LEAD_MIN_MSGS || 3);
const STEP = 3;
const CAP = 15;
const CONFIDENCE_THRESHOLD = 0.50;
const CONTEXT_MESSAGES = 12;

function isFeatureEnabled() {
  return process.env.WELLNESS_WHATSAPP_AUTOLEADS !== "0";
}

const verticalCache = new Map(); // tenantId -> bool
const lastAnalyzedCount = new Map(); // `${tenantId}:${phone}` -> count at last analysis

async function isWellnessTenant(prisma, tenantId) {
  if (verticalCache.has(tenantId)) return verticalCache.get(tenantId);
  let ok = false;
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
    ok = (t && t.vertical) === "wellness";
  } catch { /* default false */ }
  verticalCache.set(tenantId, ok);
  return ok;
}

// ── Keyword heuristic ────────────────────────────────────────────────────────
const WELLNESS_KEYWORDS = [
  "appointment", "consultation", "doctor", "clinic", "treatment", "procedure",
  "skin", "hair", "laser", "botox", "filler", "acne", "facial", "whitening",
  "transplant", "prp", "anti aging", "anti-aging", "antiaging", "wrinkle",
  "liposuction", "weight loss", "ayurveda", "massage", "salon", "haircut",
  "dermat", "aesthetics", "cosmetic", "surgery", "checkup", "check-up",
  "booking", "slot", "available", "availability", "price", "cost", "fee",
  "charges", "package", "session", "visit", "patient",
];
const INTENT_KEYWORDS = [
  "book", "schedule", "want", "need", "interested", "enquiry", "inquiry",
  "how much", "what is the", "can i", "please", "help", "info", "details",
];

function heuristicClassify(text) {
  const lc = (text || "").toLowerCase();
  if (!lc.trim()) return { isEnquiry: false, confidence: 0, source: "heuristic" };

  const wellnessHits = WELLNESS_KEYWORDS.filter((k) => lc.includes(k));
  const intentHits = INTENT_KEYWORDS.filter((k) => lc.includes(k));

  let confidence = 0;
  if (wellnessHits.length) confidence += 0.45 + Math.min(wellnessHits.length - 1, 3) * 0.1;
  if (intentHits.length) confidence += 0.15;
  confidence = Math.min(confidence, 0.95);

  const isEnquiry = wellnessHits.length > 0 && confidence >= CONFIDENCE_THRESHOLD;

  // Extract a rough service category from the first matched keyword group.
  let serviceHint = null;
  const categoryMap = [
    { cat: "hair", words: ["hair", "transplant", "prp", "scalp", "bald", "haircut", "hair color"] },
    { cat: "skin", words: ["skin", "acne", "pigmentation", "whitening", "facial", "dermat"] },
    { cat: "laser", words: ["laser", "hair removal", "tattoo"] },
    { cat: "aesthetics", words: ["botox", "filler", "wrinkle", "anti aging", "thread lift", "hifu"] },
    { cat: "body", words: ["liposuction", "weight loss", "coolsculpt"] },
    { cat: "ayurveda", words: ["ayurveda", "massage", "shirodhara"] },
  ];
  for (const { cat, words } of categoryMap) {
    if (words.some((w) => lc.includes(w))) { serviceHint = cat; break; }
  }

  return { isEnquiry, confidence: Number(confidence.toFixed(2)), serviceHint, source: "heuristic" };
}

function tryParseJson(text) {
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function classifyConversation(tenantId, messages) {
  const text = (messages || []).filter(Boolean).join("\n");
  try {
    const llmRouter = require("./llmRouter");
    const result = await llmRouter.routeRequest({
      task: "whatsapp-lead-qualify",
      tenantId,
      payload: {
        instruction:
          "You classify an inbound WhatsApp conversation for a wellness clinic / aesthetic salon. " +
          'Reply ONLY with JSON: {"isEnquiry":bool,"confidence":0..1,"serviceHint":string|null}. ' +
          "isEnquiry=true only for a genuine appointment / treatment enquiry (skin, hair, laser, " +
          "botox, weight-loss, ayurveda, salon, doctor consultation, pricing questions). " +
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
          serviceHint: parsed.serviceHint || null,
          source: "llm",
        };
      }
    }
  } catch (e) {
    console.warn(`[wellnessWaLead] LLM classify failed (using heuristic): ${e.message}`);
  }
  return heuristicClassify(text);
}

// Create the lead Contact and run it through leadAutoRouter for assignment.
async function createLead(prisma, { tenantId, phone, name, analysis }) {
  const existing = await prisma.contact.findFirst({
    where: { tenantId, phone, deletedAt: null },
    select: { id: true },
  });
  if (existing) return null;

  const aiScore = Math.max(1, Math.min(100, Math.round((Number(analysis.confidence) || 0) * 100)));

  const contact = await prisma.contact.create({
    data: {
      tenantId,
      name: (name && name.trim()) || `WhatsApp ${phone}`,
      email: null,
      phone,
      source: "whatsapp",
      status: "Lead",
      notes: analysis.serviceHint ? `Enquiry about: ${analysis.serviceHint}` : null,
      aiScore,
      aiScoreLastComputedAt: new Date(),
    },
  });

  // Assign via leadAutoRouter (wellness keyword path).
  try {
    const { pickAssignee } = require("./leadAutoRouter");
    const assigneeId = await pickAssignee(tenantId, {
      notes: analysis.serviceHint || "",
      source: "whatsapp",
    });
    if (assigneeId) {
      await prisma.contact.update({ where: { id: contact.id }, data: { assignedToId: assigneeId } });
    }
  } catch { /* assignment is non-critical */ }

  // Link the WhatsApp thread to the new contact.
  await prisma.whatsAppThread
    .update({ where: { tenantId_contactPhone: { tenantId, contactPhone: phone } }, data: { contactId: contact.id } })
    .catch(() => {});

  // Attribution touchpoint.
  await prisma.touchpoint
    .create({ data: { tenantId, contactId: contact.id, channel: "whatsapp", source: "inbound:whatsapp", occurredAt: new Date() } })
    .catch(() => {});

  return contact;
}

async function maybeCaptureLead({ tenantId, phone, name, threadId, isGroup } = {}) {
  if (!isFeatureEnabled()) return { skipped: "disabled" };
  if (!tenantId || !phone || isGroup) return { skipped: "ineligible" };
  const prisma = require("./prisma");

  if (!(await isWellnessTenant(prisma, tenantId))) return { skipped: "not-wellness" };

  const existing = await prisma.contact.findFirst({ where: { tenantId, phone, deletedAt: null }, select: { id: true } });
  if (existing) return { skipped: "exists" };

  const inboundCount = await prisma.whatsAppMessage.count({ where: { tenantId, threadId, direction: "INBOUND" } });
  if (inboundCount < MIN_INBOUND || inboundCount > CAP) return { skipped: "below-threshold" };

  const key = `${tenantId}:${phone}`;
  const last = lastAnalyzedCount.get(key) || 0;
  if (last && inboundCount - last < STEP) return { skipped: "throttled" };
  lastAnalyzedCount.set(key, inboundCount);

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

  console.log(`[wellnessWaLead] tenant ${tenantId} → lead created from WhatsApp ${phone} (service=${analysis.serviceHint}, conf=${analysis.confidence}, via=${analysis.source})`);
  return { created: true, contactId: contact.id, analysis };
}

async function safeMaybeCaptureLead(args) {
  try {
    return await maybeCaptureLead(args);
  } catch (e) {
    console.error(`[wellnessWaLead] capture failed (non-fatal): ${e.message}`);
    return { skipped: "error" };
  }
}

module.exports = {
  safeMaybeCaptureLead,
  maybeCaptureLead,
  classifyConversation,
  heuristicClassify,
  createLead,
  _verticalCache: verticalCache,
  _lastAnalyzedCount: lastAnalyzedCount,
  MIN_INBOUND,
  CONFIDENCE_THRESHOLD,
};
