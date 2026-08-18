const crypto = require("crypto");
const prisma = require("./prisma");
const { decryptCredential } = require("./credentialMasking");

const CONFIGURED_METHODS = new Set(["POST", "PUT", "PATCH"]);
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);

function validateWebhookUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch (_error) { throw new Error("Webhook callback URL is invalid"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Webhook callback URL must use HTTP or HTTPS");
  const hostname = parsed.hostname.toLowerCase();
  const isLocalHost = hostname === "localhost" || hostname.endsWith(".local") || hostname === "0.0.0.0" || hostname === "::1";
  const allowLocal = process.env.WEBHOOK_ALLOW_LOCAL === "1" && process.env.NODE_ENV !== "production";
  if (isLocalHost && !allowLocal) {
    throw new Error("Webhook callback URL cannot target a local address");
  }
  if (/^10\.|^127\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(hostname) && !allowLocal) {
    throw new Error("Webhook callback URL cannot target a private network address");
  }
  return parsed.toString();
}

function resolveConfiguredWebhookUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Webhook callback URL is invalid");
  if (/^https?:\/\//i.test(raw)) return validateWebhookUrl(raw);
  if (!raw.startsWith("/")) throw new Error("Webhook callback URL must be absolute or start with /");
  const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.PUBLIC_APP_URL;
  if (!baseUrl) throw new Error("Relative webhook callback URL requires WEBHOOK_BASE_URL or PUBLIC_APP_URL");
  return validateWebhookUrl(new URL(raw, baseUrl).toString());
}

function renderWebhookValue(value, payload) {
  if (Array.isArray(value)) return value.map((item) => renderWebhookValue(item, payload));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderWebhookValue(item, payload)]));
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (exact) {
    const resolved = exact[1].split(".").reduce((current, key) => current?.[key], payload);
    return resolved ?? value;
  }
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, path) => {
    const resolved = path.split(".").reduce((current, key) => current?.[key], payload);
    return resolved == null ? match : String(resolved);
  });
}

function xmlEscape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function objectToXml(value, root = "webhook") {
  const render = (item, key) => {
    if (Array.isArray(item)) return item.map((entry) => render(entry, key)).join("");
    if (item && typeof item === "object") return `<${key}>${Object.entries(item).map(([childKey, child]) => render(child, childKey)).join("")}</${key}>`;
    return `<${key}>${xmlEscape(item)}</${key}>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>${render(value, root)}`;
}

function buildConfiguredBody(config, event, payload, tenantId) {
  if (config.bodyMode === "advanced" && config.bodyTemplate) {
    let template = config.bodyTemplate;
    if (typeof template === "string") {
      try { template = JSON.parse(template); } catch (_error) { throw new Error("Advanced webhook body must be valid JSON"); }
    }
    return renderWebhookValue(template, { ...payload, event, tenantId });
  }
  const selected = Array.isArray(config.selectedFields) ? config.selectedFields : [];
  if (selected.length) {
    return Object.fromEntries(selected.filter((field) => Object.prototype.hasOwnProperty.call(payload, field)).map((field) => [field, payload[field]]));
  }
  return { event, timestamp: new Date().toISOString(), data: payload };
}

function configuredHeaders(config) {
  const headers = {};
  const entries = Array.isArray(config.headers)
    ? config.headers
    : Object.entries(config.headers || {}).map(([key, value]) => ({ key, value }));
  if (entries.length > 20) throw new Error("A webhook can have at most 20 custom headers");
  for (const entry of entries) {
    const key = String(entry?.key || "").trim();
    if (!key) continue;
    if (!/^[A-Za-z0-9-]+$/.test(key)) throw new Error(`Invalid webhook header name: ${key}`);
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) throw new Error(`Webhook header ${key} is managed by the CRM`);
    const rawValue = entry.secret ? decryptCredential(entry.value) : entry.value;
    const value = String(rawValue ?? "");
    if (/\r|\n/.test(value)) throw new Error(`Webhook header ${key} contains invalid characters`);
    headers[key] = value;
  }
  return headers;
}

async function deliverConfiguredWebhook(config, event, payload, tenantId, secret) {
  const url = resolveConfiguredWebhookUrl(config?.url);
  const method = String(config?.method || "POST").toUpperCase();
  if (!CONFIGURED_METHODS.has(method)) throw new Error("Webhook method must be POST, PUT, or PATCH");
  const encoding = String(config?.encoding || "json").toLowerCase();
  if (!["json", "form", "xml"].includes(encoding)) throw new Error("Webhook encoding must be JSON, form, or XML");
  const bodyObject = buildConfiguredBody(config || {}, event, payload, tenantId);
  let body;
  let contentType;
  if (encoding === "form") {
    body = new URLSearchParams(Object.entries(bodyObject).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value ?? "")])).toString();
    contentType = "application/x-www-form-urlencoded";
  } else if (encoding === "xml") {
    body = objectToXml(bodyObject);
    contentType = "application/xml";
  } else {
    body = JSON.stringify(bodyObject);
    contentType = "application/json";
  }
  if (Buffer.byteLength(body) > 256 * 1024) throw new Error("Webhook request body exceeds 256 KB");

  const headers = { "Content-Type": contentType, "X-CRM-Event": event, "X-CRM-Tenant": String(tenantId), ...configuredHeaders(config || {}) };
  const hmacSecret = (secret != null ? secret : process.env.WEBHOOK_HMAC_SECRET) || "";
  if (hmacSecret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac("sha256", hmacSecret).update(`${timestamp}.${body}`).digest("hex");
    headers["X-Globussoft-Signature"] = `t=${timestamp},v1=${signature}`;
  }

  const maxAttempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(10000) });
      const responseText = (await response.text()).slice(0, 2000);
      const result = { ok: response.ok, status: response.status, statusText: response.statusText, response: responseText, attempts: attempt };
      if (response.ok) return result;
      const error = new Error(`Webhook returned HTTP ${response.status}${responseText ? `: ${responseText}` : ""}`);
      error.webhookResult = result;
      lastError = error;
      if (response.status < 500 || attempt === maxAttempts) throw error;
    } catch (error) {
      lastError = error;
      const status = error.webhookResult?.status;
      const retryable = !status || status >= 500;
      if (!retryable || attempt === maxAttempts) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
  }
  throw lastError || new Error("Webhook delivery failed");
}

/**
 * Deliver outbound HTTP POST to all registered Webhooks matching an event.
 *
 * Supports exact match ("deal.won") and wildcard match ("deal.*").
 *
 * Canonical event catalogue (lifecycle webhooks supported by this CRM).
 * Subscribers use exact-match OR glob-match (e.g. `invoice.*`) on these.
 *
 * Sales pipeline:
 *   deal.created / deal.updated / deal.won / deal.lost
 *   contact.created / contact.updated
 *
 * Invoicing + payments (billing.js wave-6a):
 *   invoice.created
 *   invoice.completed
 *   invoice.voided
 *   invoice.refunded
 *   payment.collected
 *
 * Wellness POS / wallet (wave-6a):
 *   wallet.topup
 *   wallet.spent
 *   giftcard.issued
 *   giftcard.redeemed
 *   cashback.credited
 *   membership.plan_created
 *   membership.enrolled
 *   membership.renewed
 *   membership.benefit_applied
 *   membership.expired
 *   membership.cancelled
 *
 * Attendance (wave-6a):
 *   attendance.checked_in
 *   attendance.checked_out
 *
 * Travel-vertical lifecycle (#929 close-out, 2026-05-23 ticks #36-#38):
 *   visa.status_changed      — VisaApplication PATCH on status transition
 *   quote.sent               — Estimate POST /:id/email on Draft → Sent
 *   itinerary.accepted       — Itinerary POST /:id/accept on customer accept
 *
 * Most emissions are routed through `lib/eventBus.js`'s `emitEvent()`
 * (which fans out to BOTH AutomationRules + Webhooks). Direct
 * `deliverWebhooks()` calls bypass workflow rules — used for events
 * that are intentionally webhook-only (no automation downstream).
 */
async function deliverWebhooks(event, payload, tenantId) {
  try {
    const webhooks = await prisma.webhook.findMany({
      where: {
        tenantId,
        event: { in: [event, event.split(".")[0] + ".*"] },
        isActive: true,
      },
    });

    if (webhooks.length === 0) return;

    // Subscription gate — lead sync only flows for subscribed tenants. When
    // the subscription expires / is cancelled (and no active trial), delivery
    // stops automatically here, without any cron or manual toggle. See
    // lib/webhookEntitlement.js for the live-state policy (paid sub OR trial).
    const { isTenantWebhookEntitled, resolveTenantWebhookSecret } = require("./webhookEntitlement");
    const { entitled, reason } = await isTenantWebhookEntitled(tenantId);
    if (!entitled) {
      console.log(
        `[Webhook] tenant ${tenantId} not entitled (${reason}) — skipping ${webhooks.length} ${event} deliveries`
      );
      return;
    }

    // Resolve the tenant's signing secret ONCE (not per-delivery): the
    // per-tenant WebhookCredential, else the legacy global env secret, else
    // null (→ unsigned). All of this tenant's webhooks share one secret so a
    // partner (GlobusPhone) verifies with a single configured value.
    const { secret } = await resolveTenantWebhookSecret(tenantId);

    for (const wh of webhooks) {
      await deliverSingle(wh.targetUrl, event, payload, tenantId, secret);
    }
  } catch (e) {
    console.error(`[Webhook] Error querying webhooks for ${event}:`, e.message);
  }
}

/**
 * Fire a single outbound webhook HTTP POST.
 *
 * [GP-CRM integration] Task 10 — Stripe-style HMAC signing. When a signing
 * secret is available, the delivery includes:
 *   X-Globussoft-Signature: t=<unix_epoch_sec>,v1=<hmac_sha256_hex>
 * The signed string is "<t>.<bodyStr>" — bodyStr being the exact bytes of the
 * POST body. Partners verify HMAC-SHA256(secret, "<t>.<body>") == v1. When the
 * secret is absent, deliveries are sent unsigned — backwards-compatible with
 * every pre-integration subscriber and with partners that don't yet verify.
 *
 * Secret precedence: the explicit `secret` argument (resolved per-tenant by
 * deliverWebhooks via lib/webhookEntitlement.js) wins; when omitted it falls
 * back to process.env.WEBHOOK_HMAC_SECRET (legacy global path — also what the
 * existing HMAC unit tests exercise by calling the 4-arg form).
 *
 * @param {string}  url       Target URL
 * @param {string}  event     Event name
 * @param {object}  payload   Event data
 * @param {number}  tenantId  Tenant scope
 * @param {string} [secret]   Per-tenant HMAC secret; env fallback when undefined
 */
async function deliverSingle(url, event, payload, tenantId, secret) {
  if (!url) {
    console.warn("[Webhook] No URL provided, skipping delivery");
    return;
  }

  try {
    // Capture one instant and derive both values from it: the epoch-second
    // used in the HMAC signature (t=) and the ISO body timestamp. The body
    // keeps millisecond precision — receivers verify the signature over the
    // raw body bytes + the header's t=, so the body timestamp itself doesn't
    // need to be floored — while t= stays second-granular (Stripe-style).
    const nowMs = Date.now();
    const tSec = Math.floor(nowMs / 1000);
    const bodyStr = JSON.stringify({
      event,
      timestamp: new Date(nowMs).toISOString(),
      data: payload,
    });

    const headers = {
      "Content-Type": "application/json",
      "X-CRM-Event": event,
      "X-CRM-Tenant": String(tenantId),
    };

    // Explicit per-tenant secret wins; fall back to the legacy global env
    // secret when the caller didn't pass one (4-arg legacy invocations).
    const hmacSecret = (secret != null ? secret : process.env.WEBHOOK_HMAC_SECRET) || "";
    if (hmacSecret) {
      const sig = crypto
        .createHmac("sha256", hmacSecret)
        .update(`${tSec}.${bodyStr}`)
        .digest("hex");
      headers["X-Globussoft-Signature"] = `t=${tSec},v1=${sig}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[Webhook] ${event} -> ${url}: ${response.status}`);
  } catch (e) {
    console.error(`[Webhook] ${event} -> ${url}: FAILED - ${e.message}`);
  }
}

module.exports = { deliverWebhooks, deliverSingle, deliverConfiguredWebhook, validateWebhookUrl, resolveConfiguredWebhookUrl, buildConfiguredBody };
