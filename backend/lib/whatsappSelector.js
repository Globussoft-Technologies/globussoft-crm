/**
 * WhatsApp transport selector — routes to in-process whatsappWebClient or
 * HTTP shim whatsappGatewayClient based on the WA_GATEWAY_ENABLED flag (evaluated
 * per-tenant at call-time so Phase 3 cutover is trivial: just flip the flag).
 *
 * Callers: routes/whatsapp.js + travel crons + anywhere else that needs the
 * watiClient-compatible surface (send, isConnected, isEnabled, etc.).
 *
 * SELECTOR CONTRACT — the returned client is the SAME interface as whatsappWebClient:
 * - getConfig()
 * - isEnabled(tenantId)
 * - isConnected(tenantId)
 * - normalizePhone(phone)
 * - toChatId(phone)
 * - fromChatId(chatId)
 * - send* methods
 * - import methods
 * - read methods (stubs)
 *
 * STATUS: Phase 2 — wired in.
 */

const cfg = require("../config/waGateway");

function getClient(tenantId) {
  const useGateway = cfg.useGatewayForTenant(Number(tenantId));
  if (useGateway) {
    return require("../services/whatsappGatewayClient");
  }
  return require("../services/whatsappWebClient");
}

// Export the selector so callers don't care which client they get
module.exports = {
  getClient,
  // Convenience shortcuts for common queries
  isEnabled: (tenantId) => getClient(tenantId).isEnabled(tenantId),
  isConnected: (tenantId) => getClient(tenantId).isConnected(tenantId),
  getState: (tenantId) => getClient(tenantId).getState(tenantId),
  getConfig: (tenantId) => getClient(tenantId).getConfig(),
};
