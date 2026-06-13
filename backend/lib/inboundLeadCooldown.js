/**
 * inboundLeadCooldown — per-channel cooldown enforcement for multi-channel
 * lead intake (PRD_TRAVEL_MULTICHANNEL_LEADS §3.2.3 + G011 in
 * docs/TRAVEL_GAP_CLOSURE_TRACKER.md).
 *
 * When a contact submits multiple inbound leads via the same channel in
 * quick succession (web-form double-click, voice IVR menu hop, SMS auto-
 * reply), each one would otherwise create a new Contact row + touchpoint
 * + fire the lead-routing engine again. The cooldown layer blocks the
 * spam-shape by enforcing a per-channel time window during which the
 * same phone/email cannot create another lead through that channel.
 *
 * Storage: the cooldown map rides `Tenant.leadCaptureCooldownsJson` (the
 * column added by G009 alongside the lead-capture settings admin surface).
 * Value is a JSON-stringified object:
 *   { "voice": 1800, "web_form": 600, "sms": 120, ... }
 * where each value is the cooldown in SECONDS for that channel. Missing
 * channels = 0 (cooldown disabled). The 0-default ensures legacy tenants
 * (no value on this column) get the existing behavior. Back-compat
 * fallback reads from the older TenantSetting key/value store under key
 * `lead.capture.cooldowns` when the Tenant column is null — gives the
 * G011 runtime a transitional path for tenants whose operator-side UI
 * hasn't migrated yet.
 *
 * Lookup pattern: the route calls `loadCooldownsForTenant(prisma, tenantId)`
 * once per request and the result is cached at the per-request scope (no
 * cross-request memoization — operators editing the cooldown map need
 * sub-second propagation).
 *
 * The "previous lead exists within the cooldown window" check runs against
 * the Contact table (the route stores leads as Contacts with source =
 * "inbound:<channel>"). This is the existing data shape; a future slice
 * may swap to a dedicated TravelInboundLead model + index but the
 * cooldown helper's contract stays stable.
 *
 * Returns shape (cooldownCheck):
 *   {
 *     active: boolean,        // true → block; false → allow through
 *     retryAfter: number,     // seconds until cooldown window expires
 *     lastLeadAt: string|null, // ISO timestamp of the blocking row
 *     cooldownSeconds: number, // the configured cooldown for this channel
 *     reason?: string,        // human-readable diagnostic
 *   }
 */

'use strict';

const COOLDOWN_SETTING_KEY = 'lead.capture.cooldowns';

/**
 * Parse the cooldown JSON value stored on TenantSetting. Tolerates missing
 * row, missing key, malformed JSON (logs + returns empty map), and non-
 * numeric values (silently drops invalid entries). The defensive posture
 * here matters because the operator-side settings page may ship the
 * cooldown JSON as a free-text field — bad input shouldn't 500 the intake
 * endpoint.
 */
function parseCooldownMap(raw) {
  if (!raw || typeof raw !== 'string') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Malformed JSON in the settings row — log + return empty so the
    // intake endpoint stays open (fail-open is correct here; a misconfig
    // shouldn't block leads).
    console.warn(
      '[inboundLeadCooldown] malformed JSON in TenantSetting cooldowns:',
      e.message,
    );
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const clean = Object.create(null);
  for (const [channel, value] of Object.entries(parsed)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      clean[channel] = Math.floor(n);
    }
    // Invalid + zero entries silently drop — same effect as "no cooldown
    // for this channel" from the caller's perspective.
  }
  return clean;
}

/**
 * Load the cooldown map for a tenant. Returns an empty object when the
 * setting row is absent (zero-cooldown default). Caller is expected to
 * invoke this once per intake request and pass the result to
 * `checkCooldown` — the helper does NOT memoize across requests because
 * operators expect sub-second propagation when they edit the cooldown
 * setting.
 */
async function loadCooldownsForTenant(prisma, tenantId) {
  if (!prisma || !tenantId) return {};
  // Primary path: read from Tenant.leadCaptureCooldownsJson (the column
  // shipped by G009 alongside the lead-capture settings admin UI).
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { leadCaptureCooldownsJson: true },
    });
    const primary = parseCooldownMap(tenant && tenant.leadCaptureCooldownsJson);
    if (Object.keys(primary).length > 0) {
      return primary;
    }
  } catch (e) {
    console.warn(
      '[inboundLeadCooldown] failed to load Tenant.leadCaptureCooldownsJson:',
      e.message,
    );
  }
  // Back-compat fallback: read from the older TenantSetting key/value
  // store. Used during the migration period when the admin UI may not
  // yet have populated the Tenant column. Once every tenant has been
  // migrated, this branch becomes dead code and can be dropped.
  try {
    if (!prisma.tenantSetting || !prisma.tenantSetting.findUnique) {
      return {};
    }
    const row = await prisma.tenantSetting.findUnique({
      where: {
        tenantId_key: { tenantId, key: COOLDOWN_SETTING_KEY },
      },
      select: { value: true },
    });
    return parseCooldownMap(row && row.value);
  } catch (e) {
    console.warn(
      '[inboundLeadCooldown] failed to load TenantSetting cooldowns:',
      e.message,
    );
    return {};
  }
}

/**
 * Check whether a new lead for (tenantId, channel, email|phone) is
 * blocked by the cooldown window. Returns the cooldownCheck shape
 * documented in the module header.
 *
 * Parameters:
 *   - prisma          : shared client
 *   - tenantId        : Tenant.id
 *   - channel         : canonical channel name (e.g. "voice", "web_form")
 *   - identifier      : { email?, phone? } — at least one must be set
 *   - cooldownMap     : the parsed cooldown map (from loadCooldownsForTenant)
 *   - now             : optional Date for testability (defaults to new Date())
 *
 * Behavior:
 *   - cooldownMap[channel] = 0 OR missing → { active: false }
 *   - No prior Contact with the same identifier on this channel → { active: false }
 *   - Prior Contact found within cooldown window → { active: true, retryAfter, lastLeadAt }
 *   - Prior Contact found OUTSIDE cooldown window → { active: false }
 */
async function checkCooldown({
  prisma,
  tenantId,
  channel,
  identifier,
  cooldownMap,
  now,
  sourceChannel,
}) {
  // Cooldown map keys by canonical channel name (operators configure
  // {"voice": 1800, "web_form": 600}). sourceChannel (optional) is the
  // legacy URL alias used to scan Contact.source — keeps the probe
  // back-compat with rows like source="inbound:metaads" written before
  // the canonical rename landed. Falls back to channel when not set.
  const cooldownSeconds = cooldownMap && cooldownMap[channel];
  if (!cooldownSeconds || cooldownSeconds <= 0) {
    return { active: false, retryAfter: 0, lastLeadAt: null, cooldownSeconds: 0 };
  }
  if (!identifier || (!identifier.email && !identifier.phone)) {
    return { active: false, retryAfter: 0, lastLeadAt: null, cooldownSeconds };
  }
  const tsNow = now instanceof Date ? now : new Date();
  const windowFloor = new Date(tsNow.getTime() - cooldownSeconds * 1000);

  // Build the OR predicate: same identifier on same channel within window.
  // We scope by source = "inbound:<sourceChannel>" (legacy URL form)
  // because that's the existing data shape on the demo DB; future slices
  // may switch to a dedicated TravelInboundLead model but the contract
  // stays stable.
  const orClauses = [];
  if (identifier.email && String(identifier.email).trim()) {
    orClauses.push({ email: String(identifier.email).trim() });
  }
  if (identifier.phone && String(identifier.phone).trim()) {
    orClauses.push({ phone: String(identifier.phone).trim() });
  }
  if (orClauses.length === 0) {
    return { active: false, retryAfter: 0, lastLeadAt: null, cooldownSeconds };
  }

  const sourceKey = sourceChannel || channel;
  let prior;
  try {
    prior = await prisma.contact.findFirst({
      where: {
        tenantId,
        deletedAt: null,
        source: `inbound:${sourceKey}`,
        createdAt: { gte: windowFloor },
        OR: orClauses,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });
  } catch (e) {
    // Fail-open on DB errors — better to accept a possibly-duplicate lead
    // than to silently drop legitimate ones because the cooldown probe
    // failed.
    console.warn('[inboundLeadCooldown] cooldown probe failed:', e.message);
    return { active: false, retryAfter: 0, lastLeadAt: null, cooldownSeconds };
  }

  if (!prior) {
    return { active: false, retryAfter: 0, lastLeadAt: null, cooldownSeconds };
  }
  const priorTs = prior.createdAt instanceof Date
    ? prior.createdAt
    : new Date(prior.createdAt);
  const elapsedSec = Math.floor((tsNow.getTime() - priorTs.getTime()) / 1000);
  const retryAfter = Math.max(0, cooldownSeconds - elapsedSec);
  if (retryAfter <= 0) {
    return {
      active: false,
      retryAfter: 0,
      lastLeadAt: priorTs.toISOString(),
      cooldownSeconds,
    };
  }
  return {
    active: true,
    retryAfter,
    lastLeadAt: priorTs.toISOString(),
    cooldownSeconds,
    reason: `cooldown_active`,
  };
}

module.exports = {
  COOLDOWN_SETTING_KEY,
  parseCooldownMap,
  loadCooldownsForTenant,
  checkCooldown,
};
