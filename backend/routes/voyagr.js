/**
 * Voyagr (OJR) CMS lead-capture endpoint — /api/v1/voyagr
 *
 * Consumed by the 4 voyagr-hosted sub-brand websites (TMC / RFU /
 * Travel Stall / Visa Sure). Lead capturing happens on the public
 * sites; the CRM is the system of record for captured leads. See
 * docs/MANUAL_CODING_BACKLOG.md cluster F1 for context.
 *
 * Auth-model design decision LOCKED 2026-05-23 (commit 5de05a7):
 *   API-key (mirror backend/routes/external.js + middleware/externalAuth.js).
 *   Per-site key issued by CRM admin → stored in voyagr server env vars →
 *   sent as X-API-Key header from voyagr's Next.js API route. The voyagr
 *   browser never sees the key.
 *
 * F1 ships one endpoint:
 *
 *   POST /api/v1/voyagr/leads
 *     Body shape (snake_case + camelCase both accepted for payload):
 *       {
 *         subBrand:  "tmc" | "rfu" | "travelstall" | "visasure",
 *         name:      "Sahil Mehta",
 *         email:     "sahil@example.com",
 *         phone?:    "+919811000001",
 *         source: {
 *           siteSlug: "tmc.in",
 *           pageUrl?: "https://tmc.in/contact",
 *           utm?: {
 *             utm_source?:   "google",
 *             utm_medium?:   "cpc",
 *             utm_campaign?: "winter-2026-school-trips",
 *             utm_term?:     "school+trip",
 *             utm_content?:  "hero-cta",
 *           },
 *         },
 *         payload?: { ...form-specific fields },
 *         _hp?: "",      // honeypot field — must be empty
 *         website?: "",  // honeypot alternate name — must be empty
 *       }
 *
 *     Response on success: 201 { contactId, dealId, isNew }
 *     Response on honeypot trip: 200 (empty body) — silent fake-OK
 *
 * Dedup contract:
 *   Contact dedup is via the @@unique([email, tenantId]) compound key
 *   on Contact. Same email + same tenant → reuse existing contact
 *   (isNew:false), but ALWAYS create a fresh Deal + Touchpoint so the
 *   per-visit attribution is preserved. Name + phone are NEVER
 *   overwritten on an existing contact (preserve the human-vetted data).
 *
 * Rate limit:
 *   2 layers — express-rate-limit @ 60/min per IP (mirrors the
 *   marketplace-leads webhook pattern at server.js:148) + an in-memory
 *   per-API-key bucket @ 1000/hr per key (resets on backend restart;
 *   acceptable for F1 since voyagr's traffic is well under that ceiling
 *   and a true Redis-backed bucket is F1+ scope).
 *
 * Audit log:
 *   Every capture writes an AuditLog row via lib/audit.writeAudit with
 *   action="voyagr.lead.captured" and details = {
 *     leadEmail, subBrand, siteSlug, apiKeyName,
 *   } so forensic review can trace which key authored which lead.
 *
 * Spam guards:
 *   - Honeypot field `_hp` or `website` — common bot trap. If non-empty
 *     in the body, return 200 (silent fake-OK) and create NOTHING. Bots
 *     can't differentiate from a real success so they don't probe for
 *     a working shape.
 *   - subBrand whitelist (VALID_SUB_BRANDS below) — only the 4 known
 *     voyagr sub-brand slugs accepted. Anything else → 400.
 *   - Email format validation — strict regex.
 *   - Per-IP rate limit + per-key burst limit (above).
 *
 * Cross-references:
 *   - docs/MANUAL_CODING_BACKLOG.md cluster F1 (acceptance criteria)
 *   - backend/middleware/voyagrAuth.js (auth middleware)
 *   - backend/routes/external.js (canonical partner-API pattern this mirrors)
 *   - backend/routes/marketplace_leads.js (canonical public-webhook pattern)
 *   - CLAUDE.md "Standing rules for new code" (open paths + stripDangerous
 *     middleware behaviour we rely on for security hardening)
 */
const express = require("express");
const rateLimit = require("express-rate-limit");
const prisma = require("../lib/prisma");
const voyagrAuth = require("../middleware/voyagrAuth");
const { writeAudit } = require("../lib/audit");

const router = express.Router();

// ── Constants ──────────────────────────────────────────────────────

const VALID_SUB_BRANDS = ["tmc", "rfu", "travelstall", "visasure"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LEN = 200;
const MAX_PAYLOAD_BYTES = 8192; // 8 KiB on the form payload — generous

// ── Per-IP rate limit (60/min) ─────────────────────────────────────
//
// Mirrors the marketplace-leads webhook pattern at server.js:148. In
// NODE_ENV=test we bump the ceiling massively so the API spec's
// happy-path + dedup + 400-validation cases (which all hit the same IP
// from playwright) don't accidentally trip the gate.
const perIpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: process.env.NODE_ENV === "test" ? 100000 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many lead-capture requests from this IP", code: "RATE_LIMIT_IP" },
});

// ── Per-API-key burst limit (1000/hr) ──────────────────────────────
//
// In-memory map keyed by ApiKey.id. Each entry tracks the rolling
// window: { count, windowStart }. Resets on backend restart — fine for
// F1 since voyagr's expected traffic (a few hundred leads/day across
// all 4 sub-brand sites combined) is well under the ceiling. A Redis-
// backed bucket survives restart but is F1+ scope.
//
// Disabled in NODE_ENV=test so the spec can hit the endpoint hundreds
// of times during a single test run.
const KEY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const KEY_MAX = process.env.NODE_ENV === "test" ? 100000 : 1000;
const keyBuckets = new Map();

function perKeyLimiter(req, res, next) {
  const keyId = req.apiKey?.id;
  if (!keyId) return next();
  const now = Date.now();
  let bucket = keyBuckets.get(keyId);
  if (!bucket || now - bucket.windowStart >= KEY_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    keyBuckets.set(keyId, bucket);
  }
  bucket.count += 1;
  if (bucket.count > KEY_MAX) {
    return res.status(429).json({
      error: "Per-API-key hourly burst limit exceeded",
      code: "RATE_LIMIT_KEY",
    });
  }
  next();
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Detect honeypot field. Returns true if any of the known honeypot
 * field names is present AND non-empty. The route returns 200 silent
 * when this is true so bots can't probe for the working shape.
 */
function isHoneypotTripped(body) {
  if (!body || typeof body !== "object") return false;
  return Boolean((body._hp && String(body._hp).trim()) ||
                 (body.website && String(body.website).trim()));
}

/**
 * Validate the POST /leads body. Returns either { ok: true, value }
 * with normalised fields, or { ok: false, status, code, error } with
 * the structured-error response.
 *
 * Required: subBrand (whitelist), name (1..MAX_NAME_LEN chars), email
 * (regex), source.siteSlug (non-empty string).
 * Optional: phone, source.pageUrl, source.utm.*, payload.
 */
function validateLeadBody(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, code: "MISSING_BODY", error: "Request body required" };
  }
  const { subBrand, name, email, phone, source, payload } = body;

  if (!subBrand || typeof subBrand !== "string") {
    return { ok: false, status: 400, code: "MISSING_FIELDS", error: "subBrand required" };
  }
  if (!VALID_SUB_BRANDS.includes(subBrand)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_SUB_BRAND",
      error: `subBrand must be one of: ${VALID_SUB_BRANDS.join(", ")}`,
    };
  }
  if (!name || typeof name !== "string") {
    return { ok: false, status: 400, code: "MISSING_FIELDS", error: "name required" };
  }
  const trimmedName = name.trim();
  if (trimmedName.length < 1 || trimmedName.length > MAX_NAME_LEN) {
    return { ok: false, status: 400, code: "INVALID_NAME", error: `name must be 1-${MAX_NAME_LEN} chars` };
  }
  if (!email || typeof email !== "string") {
    return { ok: false, status: 400, code: "MISSING_FIELDS", error: "email required" };
  }
  if (!EMAIL_RE.test(email.trim())) {
    return { ok: false, status: 400, code: "INVALID_EMAIL", error: "email format invalid" };
  }
  if (!source || typeof source !== "object") {
    return { ok: false, status: 400, code: "MISSING_FIELDS", error: "source required" };
  }
  if (!source.siteSlug || typeof source.siteSlug !== "string") {
    return { ok: false, status: 400, code: "MISSING_FIELDS", error: "source.siteSlug required" };
  }
  if (phone !== undefined && phone !== null && typeof phone !== "string") {
    return { ok: false, status: 400, code: "INVALID_PHONE", error: "phone must be string" };
  }
  if (payload !== undefined && payload !== null) {
    if (typeof payload !== "object") {
      return { ok: false, status: 400, code: "INVALID_PAYLOAD", error: "payload must be object" };
    }
    // Reject obvious abuse — 8 KiB serialized cap.
    try {
      const json = JSON.stringify(payload);
      if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) {
        return {
          ok: false,
          status: 400,
          code: "PAYLOAD_TOO_LARGE",
          error: `payload exceeds ${MAX_PAYLOAD_BYTES} byte cap`,
        };
      }
    } catch (_) {
      return { ok: false, status: 400, code: "INVALID_PAYLOAD", error: "payload not JSON-serializable" };
    }
  }
  return {
    ok: true,
    value: {
      subBrand,
      name: trimmedName,
      email: email.trim().toLowerCase(),
      phone: phone ? String(phone).trim() : null,
      source: {
        siteSlug: source.siteSlug.trim(),
        pageUrl: source.pageUrl ? String(source.pageUrl).trim() : null,
        utm: source.utm && typeof source.utm === "object" ? source.utm : null,
      },
      payload: payload || null,
    },
  };
}

/**
 * Look up the sub-brand pipeline for this tenant. Travel tenant seeds a
 * single default pipeline (see prisma/seed-travel.js:1111-1129); all
 * sub-brand deals share that pipeline today, distinguished by
 * Deal.subBrand. Returns the pipeline id or null when no default exists
 * (which means the route still creates the Deal with pipelineId=null —
 * the Deal.stage='lead' default keeps it queryable).
 */
async function resolveSubBrandPipelineId(tenantId) {
  const pipeline = await prisma.pipeline.findFirst({
    where: { tenantId, isDefault: true },
    select: { id: true },
  });
  return pipeline ? pipeline.id : null;
}

// ── POST /leads — the one endpoint this commit ships ───────────────

router.post("/leads", perIpLimiter, voyagrAuth, perKeyLimiter, async (req, res) => {
  try {
    // 1. Honeypot guard — silent 200 (empty body) on bot probe so they
    //    can't differentiate from a working shape. Do this BEFORE body
    //    validation so a bot's invalid payload still gets the silent
    //    fake-OK response.
    if (isHoneypotTripped(req.body)) {
      // Log silently for forensic visibility; never write any DB rows.
      console.warn(
        "[voyagr] honeypot tripped — silent 200; apiKeyName=%s ip=%s",
        req.voyagrApiKey?.name,
        req.ip
      );
      return res.status(200).end();
    }

    // 2. Body validation.
    const v = validateLeadBody(req.body);
    if (!v.ok) {
      return res.status(v.status).json({ error: v.error, code: v.code });
    }
    const { subBrand, name, email, phone, source, payload } = v.value;

    // 2b. #899 Part A: enforce per-sub-brand key isolation. If the key is
    //     scoped to ONE sub-brand (e.g. ApiKey.subBrand='tmc'), reject any
    //     POST against a different target sub-brand. Tenant-wide keys
    //     (ApiKey.subBrand=null) are accepted against any target so legacy
    //     keys keep working unchanged. requireSubBrandMatchOrSend writes
    //     the 403 response directly and returns false on mismatch.
    if (typeof req.requireSubBrandMatchOrSend === "function") {
      if (!req.requireSubBrandMatchOrSend(subBrand, res)) return;
    }

    // 3. Contact dedup via @@unique([email, tenantId]) compound key.
    //    Existing contact → reuse (preserve name/phone); new email →
    //    create with subBrand tag + 'voyagr' source for attribution.
    let isNew = false;
    let contact = await prisma.contact.findFirst({
      where: { email, tenantId: req.tenantId },
      select: { id: true, name: true, phone: true, subBrand: true },
    });
    if (!contact) {
      isNew = true;
      contact = await prisma.contact.create({
        data: {
          name,
          email,
          phone: phone || null,
          status: "Lead",
          source: "voyagr",
          firstTouchSource: `voyagr:${subBrand}`,
          subBrand,
          tenantId: req.tenantId,
        },
        select: { id: true, name: true, phone: true, subBrand: true },
      });
    }

    // 4. Touchpoint — ALWAYS create, even on dedup, so per-visit
    //    attribution stays granular.
    const utm = source.utm || {};
    await prisma.touchpoint.create({
      data: {
        contactId: contact.id,
        channel: "web",
        source: utm.utm_source || "voyagr",
        medium: utm.utm_medium || subBrand,
        url: source.pageUrl || null,
        tenantId: req.tenantId,
      },
    }).catch((e) => {
      // Touchpoint create failure must NOT 500 the request — the lead
      // is the load-bearing artefact, not the attribution row.
      console.warn("[voyagr] touchpoint create failed: %s", e.message);
    });

    // 5. Deal — ALWAYS create a fresh Deal per capture (every voyagr
    //    submission is a new sales opportunity even when the contact
    //    already exists). pipelineId resolved from the tenant's default
    //    pipeline; nullable when no default exists.
    const pipelineId = await resolveSubBrandPipelineId(req.tenantId);
    const deal = await prisma.deal.create({
      data: {
        title: `voyagr:${subBrand} — ${name}`,
        amount: 0,
        currency: req.tenant?.defaultCurrency || "INR",
        stage: "lead",
        subBrand,
        pipelineId,
        contactId: contact.id,
        tenantId: req.tenantId,
      },
      select: { id: true },
    });

    // 6. Audit log — include the API key's `name` for forensic
    //    attribution (which key issued which lead). writeAudit is
    //    fail-soft so a hash-chain glitch doesn't 500 the request.
    await writeAudit(
      "Contact",
      "voyagr.lead.captured",
      contact.id,
      null, // no human user — synthesised from API key
      req.tenantId,
      {
        leadEmail: email,
        subBrand,
        siteSlug: source.siteSlug,
        pageUrl: source.pageUrl,
        apiKeyName: req.voyagrApiKey?.name || null,
        apiKeyId: req.voyagrApiKey?.id || null,
        dealId: deal.id,
        isNew,
        ...(payload ? { payloadKeys: Object.keys(payload) } : {}),
      }
    );

    return res.status(201).json({
      contactId: contact.id,
      dealId: deal.id,
      isNew,
    });
  } catch (e) {
    console.error("[voyagr] POST /leads:", e.message);
    // Race fallback: if a concurrent capture created the contact
    // between our findFirst and create, Prisma throws P2002 on the
    // unique constraint. Look up the now-existing contact and reuse it.
    if (e.code === "P2002") {
      try {
        const existing = await prisma.contact.findFirst({
          where: { email: req.body?.email, tenantId: req.tenantId },
          select: { id: true },
        });
        if (existing) {
          return res.status(201).json({
            contactId: existing.id,
            dealId: null,
            isNew: false,
            raceFallback: true,
          });
        }
      } catch (_) {}
    }
    return res
      .status(500)
      .json({ error: "Failed to capture lead", code: "INTERNAL_ERROR" });
  }
});

module.exports = router;
