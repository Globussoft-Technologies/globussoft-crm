//
// Meta WhatsApp Cloud API webhook ingress middleware (P1).
//
// Mounted in server.js BEFORE the global express.json() so we have access
// to the raw request body — required because Meta signs the exact bytes
// of the payload with HMAC-SHA-256, and any JSON re-serialization would
// produce a different byte stream and break signature verification.
//
// Pipeline (per incoming POST /api/whatsapp/webhook):
//
//   1. captureRawBody    — express.raw({ type: 'application/json' })
//   2. verifySignature   — HMAC-SHA-256 against META_APP_SECRET;
//                          dev fallback: skip-with-warning if secret unset
//   3. parseBody         — JSON.parse the captured Buffer; 400 on bad JSON
//   4. routeToTenant     — for each entry[].changes[] look up
//                          WhatsAppConfig by phone_number_id; attach
//                          per-entry { tenantId, configId } to req.waContext
//   5. ensureIdempotency — INSERT WebhookEvent (source, metaEventId UNIQUE);
//                          on P2002 short-circuit with 200 + DUPLICATE marker
//   6. respondImmediately — 200 to Meta; the downstream handler does work
//                          asynchronously so we stay well inside Meta's
//                          5-second response deadline.
//
// SECURITY CONTRACT
//   - In production (NODE_ENV=production), an unset META_APP_SECRET is FATAL.
//     We refuse to accept any webhook delivery without a configured secret.
//   - In dev/test, an unset secret logs a single startup warning and skips
//     signature verification so local ngrok-based development works without
//     wiring up real Meta credentials.
//   - The phone-number-id lookup is the load-bearing tenant routing. If NO
//     WhatsAppConfig matches the inbound phone_number_id we log an IGNORED
//     WebhookEvent and return 200 — silently dropping the event. We do NOT
//     fall back to tenantId=1; that was the pre-P1 multi-tenant data leak.
//
// MULTI-EVENT BODIES
//   A single webhook POST can contain multiple `entry[].changes[]` items
//   spanning different phone_number_ids (Meta batches). We resolve tenant
//   PER ENTRY so a batched payload that mixes two tenants' events routes
//   correctly to each.

const crypto = require("crypto");
const express = require("express");
const prisma = require("../lib/prisma");

// Env vars are read PER REQUEST (not at module load) so tests can vary them
// per-case without `vi.resetModules()` plumbing, and so an operator can
// rotate META_APP_SECRET without restarting the backend if they really
// need to. The startup log below runs once for an obvious deploy signal.
const RAW_BODY_LIMIT = process.env.WEBHOOK_RAW_BODY_LIMIT || "2mb";

function envSecret()  { return process.env.META_APP_SECRET || ""; }
function envVerify()  { return process.env.META_VERIFY_TOKEN || ""; }
function envIsProd()  { return process.env.NODE_ENV === "production"; }

// One-time startup signal so the operator sees the dev/prod posture clearly
// in pm2 logs. Skipped under NODE_ENV=test to keep the vitest output clean.
if (process.env.NODE_ENV !== "test") {
  if (!envSecret()) {
    if (envIsProd()) {
      console.error(
        "[metaWebhook] FATAL CONFIGURATION: META_APP_SECRET is unset in production. " +
        "Webhook signature verification will refuse every request. " +
        "Set META_APP_SECRET in your environment and restart.",
      );
    } else {
      console.warn(
        "[metaWebhook] META_APP_SECRET unset — running in DEV mode without " +
        "signature verification. This is acceptable for local/ngrok development " +
        "but MUST be set before deploying to production.",
      );
    }
  }
}

// ─── Step 1: raw-body capture ────────────────────────────────────────────
// express.raw mounts BEFORE express.json. The downstream middleware reads
// the Buffer from req.body and JSON-parses it manually after signature
// verification.
const captureRawBody = express.raw({
  type: "application/json",
  limit: RAW_BODY_LIMIT,
});

// ─── Step 2: signature verification ──────────────────────────────────────
// Meta sends `X-Hub-Signature-256: sha256=<hex>` where <hex> is the HMAC of
// the raw request body keyed with the App Secret. Timing-safe compare —
// never use ==/=== on hex digests as that leaks length and prefix bits.
function verifySignature(req, res, next) {
  const secret = envSecret();
  const isProd = envIsProd();

  // Production with no secret = no webhooks accepted.
  if (isProd && !secret) {
    return res.status(503).json({
      error: "Webhook signature verification not configured",
      code: "META_APP_SECRET_MISSING",
    });
  }

  // Dev fallback: log per-request and accept.
  if (!secret) {
    req.waSignatureVerified = false;
    req.waSignatureReason = "dev_no_secret";
    return next();
  }

  const header = req.headers["x-hub-signature-256"];
  if (typeof header !== "string" || !header.startsWith("sha256=")) {
    return res.status(403).json({
      error: "Missing or malformed X-Hub-Signature-256",
      code: "BAD_SIGNATURE_HEADER",
    });
  }
  const provided = header.slice("sha256=".length);

  // req.body is a Buffer here because express.raw ran above. If something
  // mangled it (e.g. another middleware accidentally JSON-parsed) we cannot
  // verify.
  if (!Buffer.isBuffer(req.body)) {
    return res.status(500).json({
      error: "Raw body unavailable — middleware mount order is wrong",
      code: "RAW_BODY_MISSING",
    });
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.body)
    .digest("hex");

  let ok = false;
  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    ok = false;
  }

  if (!ok) {
    return res.status(403).json({
      error: "X-Hub-Signature-256 mismatch",
      code: "SIGNATURE_INVALID",
    });
  }
  req.waSignatureVerified = true;
  next();
}

// ─── Step 3: parse body ──────────────────────────────────────────────────
// JSON.parse the captured Buffer. Returns 400 on malformed JSON (signature
// would have rejected an attacker, so a bad-JSON body here is almost
// certainly Meta-side or a development testing tool — log + reject).
function parseBody(req, res, next) {
  if (!Buffer.isBuffer(req.body)) {
    // Either dev-mode bypassed signature verification AND something already
    // parsed the body — should not happen, but degrade gracefully.
    if (req.body && typeof req.body === "object") {
      req.waParsedBody = req.body;
      return next();
    }
    return res.status(400).json({ error: "Empty or non-Buffer body", code: "EMPTY_BODY" });
  }
  try {
    req.waParsedBody = JSON.parse(req.body.toString("utf8"));
  } catch (err) {
    return res.status(400).json({ error: "Malformed JSON", code: "MALFORMED_JSON", detail: err.message });
  }
  next();
}

// ─── Step 4: tenant routing ──────────────────────────────────────────────
// For each entry[].changes[], extract value.metadata.phone_number_id and
// look up the owning WhatsAppConfig. Build req.waContext as a parallel
// array: req.waContext.entries[i] = { tenantId, configId } or { unknown:true }.
async function routeToTenant(req, res, next) {
  const body = req.waParsedBody || {};
  const entries = Array.isArray(body.entry) ? body.entry : [];
  const ctxEntries = [];

  // Collect every phone_number_id appearing in this payload so we can do a
  // single DB query instead of one-per-entry.
  const phoneNumberIds = new Set();
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const pnId = change?.value?.metadata?.phone_number_id;
      if (pnId) phoneNumberIds.add(String(pnId));
    }
  }

  let configsByPhone = new Map();
  if (phoneNumberIds.size > 0) {
    const configs = await prisma.whatsAppConfig.findMany({
      where: { phoneNumberId: { in: [...phoneNumberIds] } },
      select: { id: true, tenantId: true, phoneNumberId: true, disconnectedAt: true, businessRestricted: true },
    });
    for (const c of configs) {
      if (c.phoneNumberId) configsByPhone.set(c.phoneNumberId, c);
    }
  }

  // Build per-entry tenant context. An entry can contain multiple changes
  // sharing the same phone_number_id (a value with both messages[] and
  // statuses[]); we resolve once per entry using the first change.
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    const firstPnId = changes[0]?.value?.metadata?.phone_number_id;
    if (!firstPnId) {
      ctxEntries.push({ unknown: true, reason: "no_phone_number_id" });
      continue;
    }
    const cfg = configsByPhone.get(String(firstPnId));
    if (!cfg) {
      ctxEntries.push({ unknown: true, reason: "no_matching_config", phoneNumberId: firstPnId });
      continue;
    }
    ctxEntries.push({
      tenantId: cfg.tenantId,
      configId: cfg.id,
      phoneNumberId: cfg.phoneNumberId,
      disconnected: !!cfg.disconnectedAt,
      restricted: !!cfg.businessRestricted,
    });
  }

  req.waContext = { entries: ctxEntries };
  next();
}

// ─── Step 5: idempotency + audit ─────────────────────────────────────────
// Insert one WebhookEvent per (entry, change) pair, keyed by a composite
// metaEventId. P2002 = duplicate; mark as DUPLICATE and skip further
// processing for that change. Returns a list of WebhookEvent ids the
// downstream handler should process (de-duplicated).
async function ensureIdempotency(req, res, next) {
  const body = req.waParsedBody || {};
  const entries = Array.isArray(body.entry) ? body.entry : [];
  const eventsToProcess = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const ctx = req.waContext?.entries?.[i] || { unknown: true };
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      const value = change.value || {};
      const pnId = value?.metadata?.phone_number_id || "unknown";

      // Build a deterministic metaEventId for dedup. Prefer a per-event id:
      //   messages[]:    msg.id
      //   statuses[]:    status.id + ':' + status.status (status events can
      //                  repeat with different status values for the same id)
      //   template:      `tpl:${name}:${language}:${event}`
      //   account/qual:  `acct:${pnId}:${field}:${ts}` (best-effort)
      // If we cannot derive a stable id, fall back to a sha of the raw change
      // payload so retries of byte-identical events still dedup.
      let metaEventId = null;
      if (Array.isArray(value.messages) && value.messages.length > 0) {
        metaEventId = `${pnId}:msg:${value.messages[0].id}`;
      } else if (Array.isArray(value.statuses) && value.statuses.length > 0) {
        const s = value.statuses[0];
        metaEventId = `${pnId}:status:${s.id}:${s.status}`;
      } else if (change.field) {
        const hash = crypto.createHash("sha256").update(JSON.stringify(change)).digest("hex").slice(0, 32);
        metaEventId = `${pnId}:${change.field}:${hash}`;
      } else {
        const hash = crypto.createHash("sha256").update(JSON.stringify(change)).digest("hex").slice(0, 32);
        metaEventId = `unknown:${hash}`;
      }

      const tenantId = ctx.tenantId || null;
      const status = ctx.unknown ? "IGNORED" : "RECEIVED";

      try {
        const created = await prisma.webhookEvent.create({
          data: {
            source: "meta_whatsapp",
            metaEventId,
            tenantId,
            rawPayload: JSON.stringify(change),
            signatureOk: !!req.waSignatureVerified,
            status,
          },
        });
        if (!ctx.unknown) {
          eventsToProcess.push({
            webhookEventId: created.id,
            entryIndex: i,
            change,
            tenantId: ctx.tenantId,
            configId: ctx.configId,
          });
        }
      } catch (err) {
        // P2002 = unique violation — Meta retried; we've seen this event.
        if (err && err.code === "P2002") {
          // Best-effort: mark the prior row as DUPLICATE for visibility.
          // Don't fail the request if the marker update fails.
          await prisma.webhookEvent.updateMany({
            where: { source: "meta_whatsapp", metaEventId },
            data: { status: "DUPLICATE" },
          }).catch(() => {});
        } else {
          // Some other DB error — log and continue. Returning 5xx would make
          // Meta retry indefinitely; we'd rather lose visibility on this one
          // event than fall into a retry loop.
          console.error("[metaWebhook] WebhookEvent insert failed:", err.message);
        }
      }
    }
  }

  req.waEvents = eventsToProcess;
  next();
}

// ─── Step 6: respond immediately + defer processing ──────────────────────
// Meta requires a 2xx within ~5 seconds. We send 200 immediately and let
// the next middleware (the actual route handler) run asynchronously.
function respondImmediately(req, res, next) {
  if (!res.headersSent) {
    res.status(200).json({ received: true });
  }
  // Defer the handler to next tick so the response flushes first.
  setImmediate(next);
}

module.exports = {
  captureRawBody,
  verifySignature,
  parseBody,
  routeToTenant,
  ensureIdempotency,
  respondImmediately,
  // Composed pipeline — what server.js / the webhook router mounts.
  webhookPipeline: [
    captureRawBody,
    verifySignature,
    parseBody,
    routeToTenant,
    ensureIdempotency,
    respondImmediately,
  ],
  // Test hooks — read env at access time so tests that flip env vars see
  // the new state without reloading the module.
  _internals: {
    get META_APP_SECRET_isSet() { return !!envSecret(); },
    get META_VERIFY_TOKEN()     { return envVerify(); },
  },
};
