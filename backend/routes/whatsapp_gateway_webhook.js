/**
 * WhatsApp Gateway Event Webhook — internal endpoint for receiving normalized
 * transport events from the standalone wa-gateway service (Phase 1-2 extraction).
 *
 * The gateway runs whatsapp-web.js + Puppeteer in isolation, owns NO database,
 * and forwards all transport events (QR, state, inbound, ack, imported) here as
 * DTOs. This handler applies them to the backend's CRM state: persisting messages,
 * updating thread status, emitting Socket.IO events, capturing leads, etc.
 *
 * Auth: X-Internal-Key shared secret (both directions). Unauthenticated from the
 * normal JWT middleware — the key itself is the auth.
 *
 * Event types:
 *   - "state" — session state change (DISCONNECTED, QR, CONNECTED, AUTH_FAILURE)
 *   - "qr" — QR code image data (base64)
 *   - "inbound" — inbound message DTO (phone, body, hasMedia, etc.)
 *   - "ack" — outbound message ack (providerMsgId, ack status)
 *   - "imported" — chat import progress (list of chat dtos after import/backfill)
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const whatsappWebClient = require("../services/whatsappWebClient");

// Shared-secret auth middleware — validates X-Internal-Key header
function requireGatewayKey(req, res, next) {
  const INTERNAL_KEY = process.env.WA_GATEWAY_INTERNAL_KEY;
  if (!INTERNAL_KEY) {
    return res.status(500).json({ error: "WA_GATEWAY_INTERNAL_KEY not configured" });
  }
  if (req.get("X-Internal-Key") !== INTERNAL_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

/**
 * POST /internal/whatsapp/events
 * Receive a normalized event from the gateway and apply it to backend state.
 * Never throws — all errors are logged and suppressed so the gateway never
 * crashes on a backend hiccup.
 */
router.post("/internal/whatsapp/events", requireGatewayKey, async (req, res) => {
  const { type, tenantId, ...payload } = req.body || {};

  if (!type || !tenantId) {
    return res.status(400).json({ error: "type and tenantId required" });
  }

  try {
    tenantId = Number(tenantId);

    switch (type) {
      case "state":
        // Gateway session state change (QR, CONNECTED, AUTH_FAILURE, etc.)
        // Update internal cache so selector.getState() queries return accurate state.
        if (whatsappWebClient.applyGatewayState) {
          await whatsappWebClient.applyGatewayState(tenantId, payload);
        }
        break;

      case "qr":
        // QR code image (base64 data:image/png;...).
        // Emit to Socket.IO so the frontend's QR scanner can display it.
        // In the future, this would store it for multi-user access (e.g. a
        // /api/whatsapp/status endpoint that returns the current QR).
        const io = require("../lib/socketIO");
        if (io) {
          io.to(`tenant:${tenantId}`).emit("whatsapp:qr", {
            tenantId,
            qr: payload.qr,
          });
        }
        break;

      case "inbound":
        // Inbound message DTO from the gateway. Apply it via the DTO consumer.
        if (whatsappWebClient.ingestInboundDTO) {
          await whatsappWebClient.ingestInboundDTO(tenantId, payload, { downloadMedia: false });
        }
        break;

      case "ack":
        // Outbound message ack (status update). Apply via the DTO consumer.
        if (whatsappWebClient.applyAckDTO) {
          await whatsappWebClient.applyAckDTO(tenantId, payload);
        }
        break;

      case "imported":
        // Chat import/backfill progress. Chats array contains basic chat metadata.
        // In the future, this would trigger a backfill of thread histories.
        console.log(`[whatsapp_gateway_webhook] imported ${(payload.chats || []).length} chats for tenant ${tenantId}`);
        break;

      default:
        console.warn(`[whatsapp_gateway_webhook] unknown event type: ${type}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(`[whatsapp_gateway_webhook] event handler error (type=${type}, tenant=${tenantId}):`, err.message);
    // Never fail the response — the gateway must never crash on backend errors
    res.status(500).json({ error: err.message || "event processing failed" });
  }
});

module.exports = router;
