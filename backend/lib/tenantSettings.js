// Per-tenant settings helper — generic key/value reader over the
// TenantSetting table.
//
// Two layers of API on this module:
//
// 1) PRD §4.7 travel advance-ratio (original, prisma-as-arg):
//
//    `getTenantSetting(prisma, tenantId, key, fallback?)` returns the
//    row's `value` string (caller parses) or the supplied fallback.
//
//    `getTravelAdvanceRatio(prisma, tenantId, subBrand)` is the first
//    consumer. Lookup chain:
//      1. sub-brand-scoped key  travel.advanceRatio.<subBrand>
//      2. tenant default key    travel.advanceRatio.default
//      3. hard-coded 0.5 fallback (Phase 2 baseline)
//    Values outside (0, 1] (negative, > 1, NaN, non-numeric) are rejected
//    and skipped — falling through to the next layer rather than
//    poisoning the booking flow with a bad ratio. An admin who fat-
//    fingers "1.5" sees Travel Stall keep working on the 0.5 default
//    instead of demanding 150% upfront on every trip.
//
// 2) 2026-05-24 per-tenant budget cap pattern (singleton-prisma API):
//
//    Resolved in the 2026-05-24 product-call (DECISIONS_TRACKER.md commit
//    `a8f24ca`) for AdsGPT DC-2 ($50/mo), AI_CALLING DC-1 ($100/mo +
//    90s per-call ceiling), RateHawk DC-1 (per-call cents cap). Each
//    capped integration reads `TenantSetting.budgetCap_<integration>`
//    from the DB and falls back to env-var default. Admin UI override
//    per-tenant. Hard-stop at cap + Slack/notification alert at 80%.
//
//    `KEYS`         — canonical setting keys; extend as new caps land.
//    `DEFAULTS`     — env-var-backed defaults per key.
//    `getSetting`   — read a setting (uses imported prisma singleton);
//                     returns the value coerced via `opts.coerce`
//                     (default Number) or `opts.fallback` (default
//                     from DEFAULTS map, or null).
//    `setSetting`   — upsert a setting row for (tenantId, key).
//    `getBudgetCap` — convenience: read the monthly-USD-cents cap for
//                     a named integration (validates against KEYS).
//    `evaluateCap`  — pure helper: given spent vs cap, returns
//                     { spentCents, capCents, percent, withinCap,
//                     alertThreshold (80%) }. Callers compute spent
//                     themselves (e.g. SUM of LlmCallLog rows scoped
//                     to tenantId + provider + month-window).

const prisma = require("./prisma");

// ─── PRD §4.7 originals (prisma-as-arg) ───────────────────────────────

async function getTenantSetting(prismaArg, tenantId, key, fallback = null) {
  if (!tenantId || !key) return fallback;
  const row = await prismaArg.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key } },
    select: { value: true },
  });
  return row ? row.value : fallback;
}

function parseRatio(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return null;
  return n;
}

async function getTravelAdvanceRatio(prismaArg, tenantId, subBrand) {
  if (subBrand) {
    const subVal = await getTenantSetting(
      prismaArg,
      tenantId,
      `travel.advanceRatio.${subBrand}`,
      null,
    );
    const parsed = parseRatio(subVal);
    if (parsed != null) return parsed;
  }
  const defaultVal = await getTenantSetting(
    prismaArg,
    tenantId,
    "travel.advanceRatio.default",
    null,
  );
  const parsedDefault = parseRatio(defaultVal);
  if (parsedDefault != null) return parsedDefault;
  return 0.5;
}

// ─── 2026-05-24 budget cap helpers (singleton-prisma API) ─────────────

// Canonical setting keys — extend as new capped integrations land.
const KEYS = {
  ADSGPT_MONTHLY_CAP_USD_CENTS:          "budgetCap_adsgpt_monthly_usd_cents",
  AI_CALLING_MONTHLY_CAP_USD_CENTS:      "budgetCap_ai_calling_monthly_usd_cents",
  RATEHAWK_MONTHLY_CAP_USD_CENTS:        "budgetCap_ratehawk_monthly_usd_cents",
  LLM_MONTHLY_CAP_USD_CENTS:             "budgetCap_llm_monthly_usd_cents",
  // S73 split: image-gen LLM (DALL-E 3 / Stability XL) gets its own
  // monthly envelope, separate from the text-LLM cap. Rationale:
  // DALL-E 3 HD is $0.12/image vs Gemini Flash $0.0001/1K tokens; a
  // runaway image-gen burst could otherwise silently exhaust the
  // text-LLM budget. Default matches LLM_MONTHLY_CAP ($100 = 10000c)
  // as a sensible starting point; ops can tune per-tenant.
  IMAGE_LLM_MONTHLY_CAP_USD_CENTS:       "budgetCap_image_llm_monthly_usd_cents",
  BOOKING_EXPEDIA_MONTHLY_CAP_USD_CENTS: "budgetCap_booking_expedia_monthly_usd_cents",
  // Cron / operational settings (§4.5 hardcoded-value fixes)
  ORCHESTRATOR_DEFAULT_WORKING_MINUTES:  "orchestrator.defaultWorkingMinutes",
  SMS_DEDUP_PHRASE_24H:                  "sms.dedupPhrase24h",
  SMS_DEDUP_PHRASE_1H:                   "sms.dedupPhrase1h",
  WELLNESS_NPS_DELAY_HOURS:              "wellness.npsDelayHours",
  WELLNESS_JUNK_RETENTION_DAYS:          "wellness.junkRetentionDays",
  WELLNESS_MEMBERSHIP_EXPIRY_WINDOW_DAYS:"wellness.membershipExpiryWindowDays",
  // Wellness Admin Support Chatbot BYOK config. Value is a JSON blob
  // { provider, apiKey(encrypted via lib/fieldEncryption), model, baseUrl }
  // written exclusively by routes/wellness_ai_config.js — never set this
  // key with a plaintext apiKey through /api/tenant-settings.
  WELLNESS_AI_PROVIDER_CONFIG:           "wellness.aiProviderConfig",
  SLA_TERMINAL_STATUSES:                 "sla.terminalStatuses",
  EMAIL_FROM_ADDRESS:                    "email.fromAddress",
  INVENTORY_ALERT_ROLES:                 "inventory.alertRoles",
  REPORT_SMTP_HOST:                      "report.smtpHost",
  REPORT_SMTP_PORT:                      "report.smtpPort",
  REPORT_SMTP_SECURE:                    "report.smtpSecure",
  REPORT_SMTP_USER:                      "report.smtpUser",
  REPORT_SMTP_PASS:                      "report.smtpPass",
};

// Env-var defaults (overridable per-tenant via TenantSetting row).
// $50.00 = 5000 cents; $100.00 = 10000 cents. The product-call resolution
// chose these specific defaults (AdsGPT $50, AI_CALLING $100, RateHawk
// $50, LLM $100, Booking/Expedia $100). Reading via `process.env.<KEY>
// ?? <fallback>` lets ops override the floor without code changes.
const DEFAULTS = {
  [KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS]:
    Number(process.env.ADSGPT_MONTHLY_CAP_USD_CENTS ?? 5000),
  [KEYS.AI_CALLING_MONTHLY_CAP_USD_CENTS]:
    Number(process.env.AI_CALLING_MONTHLY_CAP_USD_CENTS ?? 10000),
  [KEYS.RATEHAWK_MONTHLY_CAP_USD_CENTS]:
    Number(process.env.RATEHAWK_MONTHLY_CAP_USD_CENTS ?? 5000),
  [KEYS.LLM_MONTHLY_CAP_USD_CENTS]:
    Number(process.env.LLM_MONTHLY_CAP_USD_CENTS ?? 10000),
  // S73: matches text-LLM cap value as a starting point — separate
  // envelope so an image-gen burst doesn't eat the text-LLM budget.
  [KEYS.IMAGE_LLM_MONTHLY_CAP_USD_CENTS]:
    Number(process.env.IMAGE_LLM_MONTHLY_CAP_USD_CENTS ?? 10000),
  [KEYS.BOOKING_EXPEDIA_MONTHLY_CAP_USD_CENTS]:
    Number(process.env.BOOKING_EXPEDIA_MONTHLY_CAP_USD_CENTS ?? 10000),
  // Cron / operational defaults (§4.5 hardcoded-value fixes)
  [KEYS.ORCHESTRATOR_DEFAULT_WORKING_MINUTES]: 660,
  [KEYS.SMS_DEDUP_PHRASE_24H]: "tomorrow at",
  [KEYS.SMS_DEDUP_PHRASE_1H]: "in 1 hour",
  [KEYS.WELLNESS_NPS_DELAY_HOURS]: 72,
  [KEYS.WELLNESS_JUNK_RETENTION_DAYS]: 90,
  [KEYS.WELLNESS_MEMBERSHIP_EXPIRY_WINDOW_DAYS]: 7,
  [KEYS.SLA_TERMINAL_STATUSES]: JSON.stringify(["Resolved", "Closed", "Cancelled"]),
  [KEYS.EMAIL_FROM_ADDRESS]:
    process.env.SENDGRID_FROM_EMAIL || process.env.MAILGUN_FROM || "noreply@crm.globusdemos.com",
  [KEYS.INVENTORY_ALERT_ROLES]: JSON.stringify(["MANAGER", "ADMIN"]),
  [KEYS.REPORT_SMTP_HOST]: process.env.SMTP_HOST || "",
  [KEYS.REPORT_SMTP_PORT]: process.env.SMTP_PORT || "587",
  [KEYS.REPORT_SMTP_SECURE]: process.env.SMTP_SECURE || "false",
  [KEYS.REPORT_SMTP_USER]: process.env.SMTP_USER || "",
  [KEYS.REPORT_SMTP_PASS]: process.env.SMTP_PASS || "",
  // Wellness Admin Support Chatbot BYOK default — empty JSON object when no
  // provider config has been saved yet. The actual value is a JSON blob written
  // by routes/wellness_ai_config.js; this default only prevents `getSetting`
  // from returning null for new tenants.
  [KEYS.WELLNESS_AI_PROVIDER_CONFIG]: process.env.WELLNESS_AI_PROVIDER_CONFIG || "{}",
};

/**
 * Get setting value for a tenant. Reads TenantSetting row; falls back
 * to the supplied fallback or to DEFAULTS[key] if the key is known.
 * Returns the value coerced via the provided coercer (e.g. Number,
 * JSON.parse, identity). Default coercer is Number (most budget-cap
 * consumers want a number).
 *
 * Uses the imported prisma singleton — call sites don't pass prisma.
 */
async function getSetting(tenantId, key, { coerce = Number, fallback } = {}) {
  if (!tenantId || !key) {
    return fallback !== undefined ? fallback : (DEFAULTS[key] ?? null);
  }
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key } },
    select: { value: true },
  });
  if (!row) {
    return fallback !== undefined ? fallback : (DEFAULTS[key] ?? null);
  }
  return coerce(row.value);
}

/**
 * Set setting value for a tenant. Upserts the row keyed by the unique
 * (tenantId, key) constraint. Stores the value as a string (callers
 * may pass any type; we coerce via String()).
 *
 * `opts.category` lets the caller stamp the optional grouping column
 * ("budget" / "feature-flag" / "branding") for the admin-UI grouper.
 */
async function setSetting(tenantId, key, value, { category = null } = {}) {
  if (!tenantId || !key) {
    throw new Error("setSetting requires non-empty tenantId and key");
  }
  const storedValue = String(value);
  return prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key } },
    create: { tenantId, key, value: storedValue, category },
    update: { value: storedValue, category },
  });
}

/**
 * Convenience: get budget cap in USD cents for an integration name.
 * Integration name is the short token used in KEYS (e.g. "adsgpt",
 * "ai_calling", "ratehawk", "llm", "image-llm"). Throws on unknown
 * integration names so callers don't silently fall through to a null cap.
 *
 * Hyphens in the integration name are normalised to underscores when
 * constructing the TenantSetting key (S73: callers can pass
 * `'image-llm'` per the slice spec; the table key remains the canonical
 * `budgetCap_image_llm_monthly_usd_cents` underscore-form so it lines up
 * with the other capped integrations in KEYS). The accepted-name check
 * is strict — case + form mismatches still throw.
 */
async function getBudgetCap(tenantId, integration) {
  // Normalise hyphens → underscores for the key construction so
  // 'image-llm' (slice-spec verbatim) lines up with the canonical
  // underscore-form KEYS entry.
  const keyToken = String(integration).replace(/-/g, '_');
  const key = `budgetCap_${keyToken}_monthly_usd_cents`;
  if (!Object.values(KEYS).includes(key)) {
    throw new Error(`Unknown integration: ${integration}`);
  }
  return getSetting(tenantId, key, { coerce: Number, fallback: DEFAULTS[key] });
}

/**
 * Pure helper: evaluate spent vs cap. Returns the canonical envelope
 * the budget-cap callers (AdsGPT, AI Calling, RateHawk) all expect:
 *   - spentCents
 *   - capCents
 *   - percent          0..∞ (e.g. 0.5 = 50% spent, 1.2 = 120% over)
 *   - withinCap        spentCents < capCents (strict — at-cap blocks)
 *   - alertThreshold   percent >= 0.80 (the 80% alert pin from the
 *                      product-call resolution)
 * Callers compute `spentCents` themselves (SUM of usage rows scoped
 * to tenantId + provider + month-window).
 *
 * Edge: capCents <= 0 → percent = 1 (treat as fully consumed) and
 * withinCap = false. Defensive: a zero-or-negative cap is treated as
 * "no spending allowed" rather than infinite spend.
 */
function evaluateCap(spentCents, capCents) {
  const spent = Number(spentCents) || 0;
  const cap = Number(capCents) || 0;
  const percent = cap > 0 ? spent / cap : 1;
  return {
    spentCents: spent,
    capCents: cap,
    percent,
    withinCap: cap > 0 ? spent < cap : false,
    alertThreshold: percent >= 0.80,
  };
}

module.exports = {
  // PRD §4.7 originals
  getTenantSetting,
  getTravelAdvanceRatio,
  // 2026-05-24 budget cap pattern
  KEYS,
  DEFAULTS,
  getSetting,
  setSetting,
  getBudgetCap,
  evaluateCap,
};
