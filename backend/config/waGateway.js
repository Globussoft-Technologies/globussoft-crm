/**
 * waGateway.js — feature-flag + connection config for the WhatsApp Gateway
 * extraction. Read at CALL TIME (not module load) so tests / a live per-tenant
 * cutover can flip it without a restart.
 *
 * DEFAULT IS OFF. When disabled (the default), the backend uses the in-process
 * whatsapp-web.js transport exactly as today — this is the always-available
 * rollback. See docs/WHATSAPP_GATEWAY_EXTRACTION.md.
 *
 * Env:
 *   WA_GATEWAY_ENABLED        "1"/"true" turns the gateway path on (default off)
 *   WA_GATEWAY_ENABLED_TENANTS  optional CSV of tenantIds for a scoped, per-tenant
 *                               cutover (Phase 3). When set, ONLY these tenants use
 *                               the gateway even if WA_GATEWAY_ENABLED is on; empty
 *                               = all tenants (subject to WA_GATEWAY_ENABLED).
 *   WA_GATEWAY_URL            base URL of the gateway service (backend → gateway)
 *   WA_GATEWAY_INTERNAL_KEY   shared secret sent as X-Internal-Key both directions
 */

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v == null ? "" : v).trim());
}

function globalEnabled() {
  return truthy(process.env.WA_GATEWAY_ENABLED);
}

// Parse the optional per-tenant allowlist into a Set of numeric ids (empty Set
// = no scoping, i.e. all tenants when globally enabled).
function enabledTenantSet() {
  const raw = String(process.env.WA_GATEWAY_ENABLED_TENANTS || "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  );
}

/**
 * Whether a given tenant should route WhatsApp through the gateway.
 * OFF by default. Never throws.
 */
function useGatewayForTenant(tenantId) {
  if (!globalEnabled()) return false;
  const scoped = enabledTenantSet();
  if (scoped.size === 0) return true; // globally on, no per-tenant scoping
  return scoped.has(Number(tenantId));
}

function gatewayUrl() {
  return String(process.env.WA_GATEWAY_URL || "").replace(/\/+$/, "") || null;
}

function internalKey() {
  return process.env.WA_GATEWAY_INTERNAL_KEY || null;
}

// The gateway is only usable if it's enabled AND we actually know where it is.
// Callers treat a misconfigured gateway like "not connected" (stub semantics).
function isGatewayConfigured() {
  return Boolean(globalEnabled() && gatewayUrl());
}

module.exports = {
  truthy,
  globalEnabled,
  enabledTenantSet,
  useGatewayForTenant,
  gatewayUrl,
  internalKey,
  isGatewayConfigured,
};
