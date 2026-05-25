//
// WhatsApp integration health-state computation (P4).
//
// Pure function over a WhatsAppConfig row. Returns one of:
//   'NOT_CONNECTED'        no config row OR isActive=false + onboardedAt=null
//   'CONNECTED'            healthy, sending allowed
//   'EXPIRING_SOON'        token expires within 7 days
//   'TOKEN_EXPIRED'        token past expiry OR runtime 190 detected
//   'WEBHOOK_FAILED'       webhookVerified=false after onboarding
//   'BUSINESS_RESTRICTED'  account_update flagged restriction
//   'QUALITY_RED'          phone_number_quality_update returned RED
//   'QUALITY_YELLOW'       phone_number_quality_update returned YELLOW
//   'DISCONNECTED'         admin manually disconnected
//
// Decision precedence (most severe first — first match wins):
//   NOT_CONNECTED > DISCONNECTED > TOKEN_EXPIRED > BUSINESS_RESTRICTED >
//   QUALITY_RED > WEBHOOK_FAILED > EXPIRING_SOON > QUALITY_YELLOW > CONNECTED
//
// Used by:
//   • GET /api/whatsapp/onboard/status route (this turn)
//   • Frontend Channels.jsx integration badge + reconnect CTA visibility
//   • Future: outbound engine could pre-gate on status === 'CONNECTED'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {Object|null} cfg WhatsAppConfig row (or null)
 * @returns {{ status: string, label: string, severity: 'ok'|'info'|'warn'|'error',
 *            reason?: string, tokenExpiresAt?: Date|null, daysUntilExpiry?: number|null }}
 */
function computeStatus(cfg) {
  if (!cfg) {
    return {
      status: "NOT_CONNECTED",
      label: "Not connected",
      severity: "info",
      reason: "No WhatsApp configuration exists for this tenant.",
    };
  }
  if (cfg.disconnectedAt) {
    return {
      status: "DISCONNECTED",
      label: "Disconnected",
      severity: "warn",
      reason: `Disconnected at ${cfg.disconnectedAt.toISOString?.() || cfg.disconnectedAt}. Reconnect to resume.`,
    };
  }
  if (!cfg.isActive) {
    return {
      status: "NOT_CONNECTED",
      label: "Inactive",
      severity: "info",
      reason: "Config exists but is marked inactive.",
    };
  }
  // Token expiry checks. expiresAt = null = never-expires (system-user token).
  const now = Date.now();
  let daysUntilExpiry = null;
  if (cfg.tokenExpiresAt) {
    const t = new Date(cfg.tokenExpiresAt).getTime();
    daysUntilExpiry = Math.floor((t - now) / (24 * 60 * 60 * 1000));
    if (t <= now) {
      return {
        status: "TOKEN_EXPIRED",
        label: "Token expired",
        severity: "error",
        reason: "The Meta access token has expired. Re-onboard to issue a fresh token.",
        tokenExpiresAt: cfg.tokenExpiresAt,
        daysUntilExpiry,
      };
    }
  }
  if (cfg.businessRestricted) {
    return {
      status: "BUSINESS_RESTRICTED",
      label: "Restricted by Meta",
      severity: "error",
      reason: "Meta has placed a restriction on this Business Account. Visit Meta Business Manager to resolve.",
    };
  }
  const qr = String(cfg.qualityRating || "").toUpperCase();
  if (qr === "RED") {
    return {
      status: "QUALITY_RED",
      label: "Quality: red",
      severity: "error",
      reason: "Phone-number quality rating is RED — sends are throttled. Improve template quality and reduce blocks.",
    };
  }
  if (!cfg.webhookVerified && cfg.onboardedAt) {
    return {
      status: "WEBHOOK_FAILED",
      label: "Webhook subscription failed",
      severity: "error",
      reason: "Onboarding completed but the webhook subscription is not verified. Reconnect to re-subscribe.",
    };
  }
  if (cfg.tokenExpiresAt && (new Date(cfg.tokenExpiresAt).getTime() - now) <= SEVEN_DAYS_MS) {
    return {
      status: "EXPIRING_SOON",
      label: "Token expiring soon",
      severity: "warn",
      reason: `Token expires in ${daysUntilExpiry} day(s). Auto-refresh is attempted daily, but a reconnect now removes ambiguity.`,
      tokenExpiresAt: cfg.tokenExpiresAt,
      daysUntilExpiry,
    };
  }
  if (qr === "YELLOW") {
    return {
      status: "QUALITY_YELLOW",
      label: "Quality: yellow",
      severity: "warn",
      reason: "Phone-number quality rating is YELLOW. Watch send patterns; one more downgrade triggers throttling.",
    };
  }
  return {
    status: "CONNECTED",
    label: "Connected",
    severity: "ok",
    tokenExpiresAt: cfg.tokenExpiresAt || null,
    daysUntilExpiry,
  };
}

module.exports = { computeStatus };
