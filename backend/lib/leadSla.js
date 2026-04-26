/**
 * Lead-side SLA helper (PRD §6.4).
 *
 * The PRD calls for "first response in <5 min for high-ticket services" —
 * a LEAD-side SLA, distinct from the existing Ticket-side SlaPolicy/breach
 * machinery in backend/cron/slaBreachEngine.js + backend/routes/sla.js.
 *
 * Design choices for v1 (deliberately small):
 *   - No new SlaPolicy row. Tier → minutes is hardcoded here as a constant,
 *     matching the PRD intent. A tenant-level override can be lifted in later
 *     once we know there's a real ask for it.
 *   - The matched service is detected from lead text (name/source/note) using
 *     the same keyword bag as leadAutoRouter.js — but mapped to the service's
 *     ticketTier rather than the staff role.
 *   - If no service matches, default to 30 minutes (medium tier).
 *
 * The Contact model gained four columns in this PRD pass:
 *   - firstResponseDueAt   — stamped at create time
 *   - firstResponseAt      — stamped when an Activity is logged against the lead
 *   - slaBreached          — flipped by leadSlaEngine cron when due passes with no response
 *   - slaBreachedAt        — when the cron flipped it
 */

const prisma = require("./prisma");

// Tier → SLA minutes map. Values picked to match PRD §6.4:
//   "first response in <5 min for high-ticket services"
// medium / low chosen as a reasonable default since the PRD doesn't prescribe.
const TIER_SLA_MINUTES = {
  high: 5,
  medium: 30,
  low: 240,
};

const DEFAULT_SLA_MINUTES = TIER_SLA_MINUTES.medium;

// Same keyword bag as leadAutoRouter.js — kept in sync intentionally so a
// "hair transplant" lead gets routed to a doctor AND priced at the high tier
// from a single text classification pass.
const KEYWORDS = {
  hair: /hair\s*transplant|fue|dhi|prp|baldness|scalp|bald|greying|dandruff/i,
  aesthetics: /botox|filler|wrinkle|anti.?ag(e|ing)|thread\s*lift|hifu|lip\s+aug|cheek/i,
  laser: /laser|hair\s+removal|tattoo|birthmark|mole/i,
  skin: /acne|pimple|melasma|pigmentation|psoriasis|eczema|dermat|chemical\s*peel|hydrafacial/i,
  body: /liposuction|cool.?sculpt|cryolipolysis|cellulite|gynecomastia|weight\s*loss|ozempic/i,
  ayurveda: /ayurveda|shirodhara|panchakarma/i,
  salon: /haircut|hair\s*color|salon|stylist/i,
};

function detectCategory(text) {
  if (!text) return null;
  for (const [cat, re] of Object.entries(KEYWORDS)) if (re.test(text)) return cat;
  return null;
}

/**
 * Look up the matched service for a lead's text. Returns the first active
 * service in the tenant whose category matches the keyword hit, or null. This
 * is intentionally a single quick lookup — we'd rather fail open (default
 * tier) than block the inbound lead create on a slow query.
 */
async function findMatchedService({ tenantId, text }) {
  const category = detectCategory(text);
  if (!category) return null;
  try {
    return await prisma.service.findFirst({
      where: { tenantId, isActive: true, category },
      select: { id: true, name: true, category: true, ticketTier: true },
      orderBy: { id: "asc" },
    });
  } catch {
    return null;
  }
}

/**
 * Compute firstResponseDueAt for a brand-new lead. Returns { dueAt, tier,
 * minutes, serviceId } so the caller can persist + log the rationale.
 *
 *   - Pass `serviceId` when the caller already knows the matched service
 *     (auto-router output, web booking form). Skips the keyword pass.
 *   - Otherwise the function classifies the lead text and looks the service up.
 *   - Falls back to the medium-tier default (30 min) on no match / on errors.
 */
async function computeFirstResponseDueAt({ tenantId, serviceId, text, now } = {}) {
  const baseAt = now ? new Date(now) : new Date();
  let tier = null;
  let resolvedServiceId = null;

  if (serviceId) {
    try {
      const svc = await prisma.service.findFirst({
        where: { id: Number(serviceId), tenantId },
        select: { id: true, ticketTier: true },
      });
      if (svc) {
        tier = svc.ticketTier;
        resolvedServiceId = svc.id;
      }
    } catch {
      // fall through — leave tier null; default applies below
    }
  }

  if (!tier) {
    const svc = await findMatchedService({ tenantId, text });
    if (svc) {
      tier = svc.ticketTier;
      resolvedServiceId = svc.id;
    }
  }

  const minutes = (tier && TIER_SLA_MINUTES[tier]) || DEFAULT_SLA_MINUTES;
  const dueAt = new Date(baseAt.getTime() + minutes * 60_000);
  return { dueAt, tier: tier || null, minutes, serviceId: resolvedServiceId };
}

/**
 * Stamp firstResponseAt on a contact if it's still null. Called inline
 * whenever an Activity is created against the contact (call, SMS, email,
 * note). Intentionally no-throw: SLA bookkeeping must never break the
 * underlying activity write.
 */
async function markFirstResponseIfNeeded({ contactId, when } = {}) {
  if (!contactId) return false;
  try {
    const contact = await prisma.contact.findUnique({
      where: { id: Number(contactId) },
      select: { id: true, firstResponseAt: true, status: true },
    });
    if (!contact) return false;
    if (contact.firstResponseAt) return false;
    // Only Leads carry the lead-side SLA. Once a Contact has been promoted to
    // Prospect / Customer the SLA timer is irrelevant.
    if (contact.status !== "Lead") return false;
    await prisma.contact.update({
      where: { id: contact.id },
      data: { firstResponseAt: when ? new Date(when) : new Date() },
    });
    return true;
  } catch (err) {
    console.error("[leadSla] markFirstResponseIfNeeded:", err.message);
    return false;
  }
}

module.exports = {
  TIER_SLA_MINUTES,
  DEFAULT_SLA_MINUTES,
  detectCategory,
  findMatchedService,
  computeFirstResponseDueAt,
  markFirstResponseIfNeeded,
};
