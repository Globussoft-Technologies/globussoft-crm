/**
 * Lead auto-router — shared between two verticals.
 *
 * ── Legacy wellness path (unchanged) ──────────────────────────────────
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
 *
 * Exports: pickAssignee, detectCategory (legacy — wellness only).
 *
 * ── Travel multichannel path (G007 + G008) ────────────────────────────
 *
 * PRD_TRAVEL_MULTICHANNEL_LEADS §3.3. Travel-vertical tenants run a
 * SECOND, rule-driven router on top of LeadRoutingRule rows whose new
 * `channel` + `subBrand` columns are the first-class match dimensions
 * (FR-3.3.1). Selection is most-specific-rule-wins (FR-3.3.2):
 *
 *   specificity = (channel ? 2 : 0) + (subBrand ? 1 : 0)
 *
 * Higher specificity beats lower; the rule's `priority` (lower is more
 * important) breaks ties; `id` is the final tie-break (deterministic).
 *
 * Round-robin (FR-3.3.4): each matched rule picks its next assignee from
 * an eligible team via `rrCursor % team.length`, then atomically
 * increments `rrCursor` so two concurrent intakes don't double-assign.
 *
 * Unavailability fallback (FR-3.3.5): a candidate User with
 * `isAvailable=false` is skipped — the cursor advances and the next
 * candidate is tried. If every team member is unavailable, the rule's
 * `fallbackUserId` wins (when set); if that User is also unavailable or
 * absent, the result is null with `reason="all_assignees_unavailable"`.
 *
 * Exports: resolveRoutingRule, pickRoutingAssignee (travel — new).
 *
 * Wellness's `pickAssignee` does NOT consult LeadRoutingRule and stays
 * keyword-match-only; travel's `pickRoutingAssignee` does NOT touch
 * wellnessRole-keyword detection. The two flows are disjoint and the
 * caller picks which one to invoke based on tenant.vertical.
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
async function pickAssignee({ tenantId, name, phone: _phone, email: _email, source, note }) {
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

// ─── Travel multichannel router (G007 + G008) ────────────────────────

/**
 * Score a rule's specificity against an incoming intake.
 *
 * Channel match is worth 2 points; sub-brand match 1 point. A rule with
 * BOTH channel + sub-brand specified beats a rule with only one; a rule
 * with neither (the catch-all) ranks lowest.
 *
 * A rule is ELIGIBLE only if every non-null match field on the rule
 * matches the intake (channel=null wildcard always matches; channel="x"
 * only matches intake.channel="x" case-insensitively). Mismatched
 * fields disqualify the rule entirely — they don't drop the score, they
 * REJECT the rule.
 *
 * Returns: { eligible: boolean, specificity: number }
 */
function scoreRule(rule, { channel, subBrand }) {
  let specificity = 0;
  const lc = (v) => (v == null ? null : String(v).toLowerCase());

  // channel: NULL on rule = wildcard. Non-null must equal intake.channel.
  if (rule.channel != null) {
    if (lc(rule.channel) !== lc(channel)) return { eligible: false, specificity: 0 };
    specificity += 2;
  }
  // subBrand: same semantics. NULL on rule = wildcard; non-null must equal intake.subBrand.
  if (rule.subBrand != null) {
    if (lc(rule.subBrand) !== lc(subBrand)) return { eligible: false, specificity: 0 };
    specificity += 1;
  }
  return { eligible: true, specificity };
}

/**
 * Resolve the most-specific routing rule for an inbound lead.
 *
 * Inputs: tenantId + channel + subBrand (either may be null).
 *
 * Selection (FR-3.3.2):
 *   1. Filter rules to ACTIVE + tenant-scoped + eligible per scoreRule.
 *   2. Highest specificity wins.
 *   3. Tie-break: lower `priority` wins (existing convention — 10 beats 100).
 *   4. Final tie-break: lower `id` wins (deterministic, oldest rule).
 *
 * Returns the chosen rule object (raw Prisma row), or null when no rule
 * is eligible. Caller decides whether unassigned-with-reason is the
 * right action when null comes back.
 */
async function resolveRoutingRule({ tenantId, channel, subBrand }) {
  const rules = await prisma.leadRoutingRule.findMany({
    where: { tenantId, isActive: true },
  });
  let best = null;
  for (const rule of rules) {
    const { eligible, specificity } = scoreRule(rule, { channel, subBrand });
    if (!eligible) continue;
    if (
      !best ||
      specificity > best.specificity ||
      (specificity === best.specificity && rule.priority < best.rule.priority) ||
      (specificity === best.specificity && rule.priority === best.rule.priority && rule.id < best.rule.id)
    ) {
      best = { rule, specificity };
    }
  }
  return best ? best.rule : null;
}

/**
 * Atomically advance the per-rule round-robin cursor and return the
 * NEW value. Two concurrent intakes hitting the same rule will see
 * monotonically-increasing cursor values, so no two get the same
 * assignee for the same wrap-around window.
 *
 * Returns the post-increment cursor (Int), or `null` if the bump call
 * itself failed (e.g. the rule was deleted mid-flight).
 */
async function bumpRrCursor(ruleId) {
  try {
    const updated = await prisma.leadRoutingRule.update({
      where: { id: ruleId },
      data: { rrCursor: { increment: 1 } },
      select: { rrCursor: true },
    });
    return updated.rrCursor;
  } catch (_err) {
    return null;
  }
}

/**
 * Build the eligible-assignee list for a rule.
 *
 *  - assignType="specific_user": [rule.assignTo] (single-item list)
 *  - assignType="round_robin"  : every active User in the tenant,
 *                                ordered by id (deterministic).
 *
 * The caller filters by isAvailable AFTER this list returns.
 */
async function loadTeamForRule(rule, tenantId) {
  if (rule.assignType === "specific_user") {
    if (!rule.assignTo) return [];
    const u = await prisma.user.findFirst({
      where: { id: rule.assignTo, tenantId },
      select: { id: true, isAvailable: true, deactivatedAt: true },
    });
    return u ? [u] : [];
  }
  // round_robin default — active staff only (excludes soft-deactivated).
  return prisma.user.findMany({
    where: { tenantId, deactivatedAt: null },
    orderBy: { id: "asc" },
    select: { id: true, isAvailable: true, deactivatedAt: true },
  });
}

/**
 * Pick the assignee userId for an intake on the travel-multichannel
 * path. Glue function: resolveRoutingRule + bumpRrCursor + isAvailable
 * filter + fallbackUserId fallback (FR-3.3.5).
 *
 * Returns an envelope of:
 *   { userId, matchedRuleId, reason }
 *
 * Where `reason` is one of:
 *   - "round_robin assignment via rule <id>"
 *   - "specific_user assignment via rule <id>"
 *   - "fallback user via rule <id> (all assignees unavailable)"
 *   - "unassigned: all_assignees_unavailable"
 *   - "unassigned: no_matching_rule"
 *   - "unassigned: empty_team_on_matched_rule"
 *
 * Pure read-side bumpRrCursor() is the only state mutation — the
 * caller writes Contact.assignedToId / Lead.assignedToId.
 */
async function pickRoutingAssignee({ tenantId, channel, subBrand }) {
  const rule = await resolveRoutingRule({ tenantId, channel, subBrand });
  if (!rule) {
    return { userId: null, matchedRuleId: null, reason: "unassigned: no_matching_rule" };
  }

  const team = await loadTeamForRule(rule, tenantId);
  if (!team.length) {
    return {
      userId: null,
      matchedRuleId: rule.id,
      reason: "unassigned: empty_team_on_matched_rule",
    };
  }

  // specific_user is a single-item team; round-robin walks the full team.
  // In both cases we filter by isAvailable. If specific_user is
  // unavailable and a fallbackUserId exists, fallback. If round_robin
  // candidates are ALL unavailable, fallback.
  if (rule.assignType === "specific_user") {
    const target = team[0];
    if (target.isAvailable !== false) {
      return {
        userId: target.id,
        matchedRuleId: rule.id,
        reason: `specific_user assignment via rule ${rule.id}`,
      };
    }
    // Specific user unavailable — fall back if we have one.
    if (rule.fallbackUserId) {
      const fb = await prisma.user.findFirst({
        where: { id: rule.fallbackUserId, tenantId },
        select: { id: true, isAvailable: true },
      });
      if (fb && fb.isAvailable !== false) {
        return {
          userId: fb.id,
          matchedRuleId: rule.id,
          reason: `fallback user via rule ${rule.id} (specific user unavailable)`,
        };
      }
    }
    return {
      userId: null,
      matchedRuleId: rule.id,
      reason: "unassigned: all_assignees_unavailable",
    };
  }

  // round_robin: bump the cursor (atomic), then walk the team starting
  // at the cursor position. Each walk-step lands on the next eligible
  // user; if every team member is unavailable, fall back.
  const cursor = await bumpRrCursor(rule.id);
  if (cursor == null) {
    // Rule deleted mid-flight — treat as no-match.
    return { userId: null, matchedRuleId: rule.id, reason: "unassigned: no_matching_rule" };
  }

  // Cursor is post-increment, so the pre-bump start index is (cursor-1)
  // for the first eligible candidate. mod team.length keeps it bounded.
  const startIdx = ((cursor - 1) % team.length + team.length) % team.length;
  for (let step = 0; step < team.length; step++) {
    const idx = (startIdx + step) % team.length;
    if (team[idx].isAvailable !== false) {
      return {
        userId: team[idx].id,
        matchedRuleId: rule.id,
        reason: `round_robin assignment via rule ${rule.id}`,
      };
    }
  }

  // Every team member unavailable — try the rule's fallback.
  if (rule.fallbackUserId) {
    const fb = await prisma.user.findFirst({
      where: { id: rule.fallbackUserId, tenantId },
      select: { id: true, isAvailable: true },
    });
    if (fb && fb.isAvailable !== false) {
      return {
        userId: fb.id,
        matchedRuleId: rule.id,
        reason: `fallback user via rule ${rule.id} (all assignees unavailable)`,
      };
    }
  }
  return {
    userId: null,
    matchedRuleId: rule.id,
    reason: "unassigned: all_assignees_unavailable",
  };
}

module.exports = {
  // Legacy wellness path
  pickAssignee,
  detectCategory,
  // Travel multichannel path (G007 + G008)
  scoreRule,
  resolveRoutingRule,
  bumpRrCursor,
  loadTeamForRule,
  pickRoutingAssignee,
};
