/**
 * Wellness lead auto-router.
 *
 * When a lead arrives via /external/leads, look at the lead's notes,
 * source, and (if available) UTM data for service-category keywords.
 * Match to the most senior available specialist for that category and
 * set Contact.assignedToId so the right telecaller / doctor is on the
 * hook from minute 1.
 *
 * Fall-back order:
 *   1. Doctor with matching wellnessRole + service-area expertise
 *   2. Telecaller (round-robin among USERs with wellnessRole=telecaller)
 *   3. Anyone with role=MANAGER
 *   4. Leave unassigned (admin sees it in the inbox)
 */
const prisma = require("./prisma");

// Service-category → keyword bag
const KEYWORDS = {
  hair: /hair\s*transplant|fue|dhi|prp|baldness|scalp|bald|greying|dandruff/i,
  aesthetics: /botox|filler|wrinkle|anti.?ag(e|ing)|thread\s*lift|hifu|lip\s+aug|cheek/i,
  laser: /laser|hair\s+removal|tattoo|birthmark|mole/i,
  skin: /acne|pimple|melasma|pigmentation|psoriasis|eczema|dermat|chemical\s*peel|hydrafacial/i,
  body: /liposuction|cool.?sculpt|cryolipolysis|cellulite|gynecomastia|weight\s*loss|ozempic/i,
  ayurveda: /ayurveda|shirodhara|panchakarma/i,
  salon: /haircut|hair\s*color|salon|stylist/i,
};

const wellnessRoleByCategory = {
  hair: "doctor",
  aesthetics: "doctor",
  laser: "professional",
  skin: "doctor",
  body: "doctor",
  ayurveda: "professional",
  salon: "professional",
};

let lastTelecallerIdx = -1;

function detectCategory(text) {
  if (!text) return null;
  for (const [cat, re] of Object.entries(KEYWORDS)) if (re.test(text)) return cat;
  return null;
}

/**
 * Pick the staff to assign. Returns userId or null.
 */
async function pickAssignee({ tenantId, name, phone, email, source, note }) {
  const haystack = [name, source, note].filter(Boolean).join(" ");
  const category = detectCategory(haystack);
  const desiredRole = category ? wellnessRoleByCategory[category] : null;

  // Specialists for the matched category
  if (desiredRole) {
    const specialists = await prisma.user.findMany({
      where: { tenantId, wellnessRole: desiredRole },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    });
    if (specialists.length) {
      // Round-robin among specialists in this category
      const idx = Math.abs(Date.now()) % specialists.length;
      return { userId: specialists[idx].id, reason: `keyword match: ${category} → ${desiredRole}` };
    }
  }

  // Round-robin telecallers
  const telecallers = await prisma.user.findMany({
    where: { tenantId, wellnessRole: "telecaller" },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  });
  if (telecallers.length) {
    lastTelecallerIdx = (lastTelecallerIdx + 1) % telecallers.length;
    return { userId: telecallers[lastTelecallerIdx].id, reason: "round-robin telecaller (no category match)" };
  }

  // Manager fallback
  const manager = await prisma.user.findFirst({ where: { tenantId, role: "MANAGER" }, select: { id: true } });
  if (manager) return { userId: manager.id, reason: "fallback: manager" };

  return { userId: null, reason: "no available staff" };
}

module.exports = { pickAssignee, detectCategory };
