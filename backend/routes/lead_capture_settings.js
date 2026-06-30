/**
 * /api/settings/lead-capture — Multi-channel Lead Capture admin surface (G009).
 *
 * PRD: docs/PRD_TRAVEL_MULTICHANNEL_LEADS.md FR-3.7 (Settings).
 * Tracker: docs/TRAVEL_GAP_CLOSURE_TRACKER.md §3.1 G009.
 *
 * What this route ships
 * ─────────────────────
 * Single endpoint cluster for the /settings/lead-capture admin page (frontend
 * sibling slice, same commit). Exposes:
 *
 *   GET    /api/settings/lead-capture
 *     → 200 { channels: { <channel>: boolean }, cooldowns: { <channel>: secs },
 *             formRoutingMappings: [{ id, channel, externalFormId, subBrand,
 *               assignedTeamId, isActive, notes }] }
 *
 *   PUT    /api/settings/lead-capture
 *     body  { channels?: object, cooldowns?: object }
 *     → 200 { ok: true, channels, cooldowns }
 *     Partial: missing keys retain the existing-stored value (deep merge by
 *     top-level channel key). Unknown channels are dropped; out-of-range
 *     cooldowns (negative or >86400) are clamped.
 *
 *   POST   /api/settings/lead-capture/form-routing-mappings
 *     body  { channel, externalFormId, subBrand?, assignedTeamId?, notes? }
 *     → 201 { mapping } | 409 DUPLICATE_MAPPING on unique-constraint hit
 *
 *   PUT    /api/settings/lead-capture/form-routing-mappings/:id
 *     body  partial { channel?, externalFormId?, subBrand?, assignedTeamId?,
 *                     isActive?, notes? }
 *     → 200 { mapping } | 404 NOT_FOUND when cross-tenant or missing
 *
 *   DELETE /api/settings/lead-capture/form-routing-mappings/:id
 *     → 204 No Content | 404 NOT_FOUND
 *
 *   POST   /api/leads/intake (test mode)
 *     This route does NOT mount the canonical intake alias; the operator-
 *     facing "Test intake" button on the admin page calls the existing
 *     /api/travel/inbound/leads/:channel surface with body `_test: true`.
 *     The intake route already swallows test markers (sibling agent G015).
 *     We keep that contract surface-local; no duplicate alias here.
 *
 * RBAC
 * ────
 * All endpoints require ADMIN (verifyRole(['ADMIN'])) per FR-3.7. The global
 * verifyToken guard at server.js fires before route dispatch — handlers see
 * req.user populated.
 *
 * Sanitization
 * ────────────
 * - `notes` text field on mappings runs through sanitizeText (HTML-safe).
 * - `externalFormId` accepts [A-Za-z0-9_-]{1,128} (Meta + Google form-ID shape).
 * - `channels` / `cooldowns` JSON shapes are filtered through the canonical
 *   17-channel allowlist before persistence (silently drops unknown keys
 *   per PRD §3 envelope discipline — gracefully forward-compatible with
 *   future channel additions).
 *
 * Migration safety
 * ────────────────
 * FormRoutingMapping is a brand-new model (zero rows). Its UNIQUE constraint
 * on (tenantId, channel, externalFormId) is vacuously safe but the
 * migration-check gate doesn't differentiate — the commit body carries the
 * `[allow-unique]` bless marker. Tenant.leadCaptureChannelsJson /
 * .leadCaptureCooldownsJson are nullable additive columns (no constraints).
 *
 * Drift / Q-blocks
 * ────────────────
 * Per PRD §FR-3.3.6 the form-ID → sub-brand mapping is cred-blocked on Q1
 * (Meta lead-ads access). The admin UI surfaces this with a header note and
 * allows operators to pre-stage mappings; the intake handler consumes them
 * once Meta webhooks start arriving.
 */

const express = require("express");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { sanitizeText } = require("../lib/sanitizeJson");

const router = express.Router();
const prisma = require("../lib/prisma");

// Canonical 16-channel allowlist per PRD FR-3.1.2 (post-rename: webform→web_form,
// metaads→meta_ad). Voyagr has no live integration, so it is excluded from the
// filter/admin surface. Centralised here so the admin UI and intake handlers
// read from the same source.
const ALLOWED_CHANNELS = [
  "web_form",
  "whatsapp",
  "ads",
  "adsgpt",
  "meta_ad",
  "manual",
  "indiamart",
  "justdial",
  "tradeindia",
  "voice",
  "sms",
  "email",
  "google_ad",
  "linkedin_ad",
  "referral",
  "chat",
];
const CHANNEL_SET = new Set(ALLOWED_CHANNELS);

// Cooldown range guard: 0 (disabled) to 86400 (24h). The 24h cap matches
// the marketplace channels' vendor-re-delivery window (PRD DD-5.2); longer
// would suppress legitimate same-customer-different-intent re-leads.
const COOLDOWN_MIN = 0;
const COOLDOWN_MAX = 86400;

// External form-ID shape: Meta returns 15-19-digit numerics, Google returns
// resource-name strings; allow alphanumerics + underscores + hyphens up to
// 128 chars. Tight enough to be a meaningful validator without overfitting.
const EXTERNAL_FORM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function safeJsonObject(str) {
  if (!str) return {};
  if (typeof str === "object") return str;
  try {
    const parsed = JSON.parse(str);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function normaliseChannelsBlob(blob) {
  if (!blob || typeof blob !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(blob)) {
    if (!CHANNEL_SET.has(k)) continue;
    out[k] = Boolean(v);
  }
  return out;
}

function normaliseCooldownsBlob(blob) {
  if (!blob || typeof blob !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(blob)) {
    if (!CHANNEL_SET.has(k)) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out[k] = Math.max(COOLDOWN_MIN, Math.min(COOLDOWN_MAX, Math.floor(n)));
  }
  return out;
}

function mappingProjection(m) {
  if (!m) return null;
  return {
    id: m.id,
    channel: m.channel,
    externalFormId: m.externalFormId,
    subBrand: m.subBrand || null,
    assignedTeamId: m.assignedTeamId || null,
    isActive: m.isActive,
    notes: m.notes || null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

// ── GET /api/settings/lead-capture ────────────────────────────────────
router.get("/", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { tenantId } = req.user;
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        leadCaptureChannelsJson: true,
        leadCaptureCooldownsJson: true,
      },
    });
    if (!tenant) {
      return res
        .status(404)
        .json({ error: "Tenant not found.", code: "TENANT_NOT_FOUND" });
    }
    const channels = normaliseChannelsBlob(
      safeJsonObject(tenant.leadCaptureChannelsJson),
    );
    const cooldowns = normaliseCooldownsBlob(
      safeJsonObject(tenant.leadCaptureCooldownsJson),
    );
    const mappings = await prisma.formRoutingMapping.findMany({
      where: { tenantId },
      orderBy: [{ channel: "asc" }, { externalFormId: "asc" }],
    });
    return res.json({
      channels,
      cooldowns,
      formRoutingMappings: mappings.map(mappingProjection),
      allowedChannels: ALLOWED_CHANNELS,
      cooldownRange: { min: COOLDOWN_MIN, max: COOLDOWN_MAX },
    });
  } catch (err) {
    console.error("[settings/lead-capture GET]", err);
    return res
      .status(500)
      .json({ error: "Failed to read lead-capture settings." });
  }
});

// ── PUT /api/settings/lead-capture (partial merge) ────────────────────
router.put("/", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { tenantId } = req.user;
    const { channels: chanInput, cooldowns: coolInput } = req.body || {};

    // Reject non-object payloads up-front for explicit operator feedback.
    if (
      (chanInput !== undefined && (chanInput === null || typeof chanInput !== "object" || Array.isArray(chanInput))) ||
      (coolInput !== undefined && (coolInput === null || typeof coolInput !== "object" || Array.isArray(coolInput)))
    ) {
      return res.status(400).json({
        error: "channels/cooldowns must be JSON objects keyed by channel.",
        code: "INVALID_BODY",
      });
    }

    const existing = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        leadCaptureChannelsJson: true,
        leadCaptureCooldownsJson: true,
      },
    });
    if (!existing) {
      return res
        .status(404)
        .json({ error: "Tenant not found.", code: "TENANT_NOT_FOUND" });
    }
    const currentChannels = normaliseChannelsBlob(
      safeJsonObject(existing.leadCaptureChannelsJson),
    );
    const currentCooldowns = normaliseCooldownsBlob(
      safeJsonObject(existing.leadCaptureCooldownsJson),
    );
    const nextChannels = chanInput
      ? { ...currentChannels, ...normaliseChannelsBlob(chanInput) }
      : currentChannels;
    const nextCooldowns = coolInput
      ? { ...currentCooldowns, ...normaliseCooldownsBlob(coolInput) }
      : currentCooldowns;

    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        leadCaptureChannelsJson: JSON.stringify(nextChannels),
        leadCaptureCooldownsJson: JSON.stringify(nextCooldowns),
      },
    });
    return res.json({
      ok: true,
      channels: nextChannels,
      cooldowns: nextCooldowns,
    });
  } catch (err) {
    console.error("[settings/lead-capture PUT]", err);
    return res
      .status(500)
      .json({ error: "Failed to update lead-capture settings." });
  }
});

// ── POST /form-routing-mappings ───────────────────────────────────────
router.post(
  "/form-routing-mappings",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { tenantId } = req.user;
      const {
        channel,
        externalFormId,
        subBrand,
        assignedTeamId,
        isActive,
        notes,
      } = req.body || {};

      if (!channel || !CHANNEL_SET.has(channel)) {
        return res.status(400).json({
          error: `channel must be one of: ${ALLOWED_CHANNELS.join(", ")}`,
          code: "INVALID_CHANNEL",
        });
      }
      if (!externalFormId || typeof externalFormId !== "string" || !EXTERNAL_FORM_ID_RE.test(externalFormId)) {
        return res.status(400).json({
          error: "externalFormId must be 1-128 alphanumeric/_- characters.",
          code: "INVALID_EXTERNAL_FORM_ID",
        });
      }

      const data = {
        tenantId,
        channel,
        externalFormId,
        subBrand: subBrand && typeof subBrand === "string" ? subBrand : null,
        assignedTeamId:
          assignedTeamId != null && Number.isFinite(Number(assignedTeamId))
            ? Number(assignedTeamId)
            : null,
        isActive: isActive === undefined ? true : Boolean(isActive),
        notes: notes ? sanitizeText(String(notes)).slice(0, 1000) : null,
      };

      let mapping;
      try {
        mapping = await prisma.formRoutingMapping.create({ data });
      } catch (e) {
        if (e && e.code === "P2002") {
          return res.status(409).json({
            error:
              "A mapping already exists for that (channel, externalFormId).",
            code: "DUPLICATE_MAPPING",
          });
        }
        throw e;
      }
      return res.status(201).json({ mapping: mappingProjection(mapping) });
    } catch (err) {
      console.error("[settings/lead-capture form-mapping POST]", err);
      return res
        .status(500)
        .json({ error: "Failed to create form-routing mapping." });
    }
  },
);

// ── PUT /form-routing-mappings/:id ────────────────────────────────────
router.put(
  "/form-routing-mappings/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { tenantId } = req.user;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid id.", code: "INVALID_ID" });
      }
      const existing = await prisma.formRoutingMapping.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        return res
          .status(404)
          .json({ error: "Mapping not found.", code: "NOT_FOUND" });
      }
      const {
        channel,
        externalFormId,
        subBrand,
        assignedTeamId,
        isActive,
        notes,
      } = req.body || {};
      const data = {};
      if (channel !== undefined) {
        if (!CHANNEL_SET.has(channel)) {
          return res.status(400).json({
            error: `channel must be one of: ${ALLOWED_CHANNELS.join(", ")}`,
            code: "INVALID_CHANNEL",
          });
        }
        data.channel = channel;
      }
      if (externalFormId !== undefined) {
        if (typeof externalFormId !== "string" || !EXTERNAL_FORM_ID_RE.test(externalFormId)) {
          return res.status(400).json({
            error: "externalFormId must be 1-128 alphanumeric/_- characters.",
            code: "INVALID_EXTERNAL_FORM_ID",
          });
        }
        data.externalFormId = externalFormId;
      }
      if (subBrand !== undefined) data.subBrand = subBrand || null;
      if (assignedTeamId !== undefined) {
        data.assignedTeamId =
          assignedTeamId != null && Number.isFinite(Number(assignedTeamId))
            ? Number(assignedTeamId)
            : null;
      }
      if (isActive !== undefined) data.isActive = Boolean(isActive);
      if (notes !== undefined) {
        data.notes = notes ? sanitizeText(String(notes)).slice(0, 1000) : null;
      }

      let mapping;
      try {
        mapping = await prisma.formRoutingMapping.update({
          where: { id },
          data,
        });
      } catch (e) {
        if (e && e.code === "P2002") {
          return res.status(409).json({
            error:
              "A mapping already exists for that (channel, externalFormId).",
            code: "DUPLICATE_MAPPING",
          });
        }
        throw e;
      }
      return res.json({ mapping: mappingProjection(mapping) });
    } catch (err) {
      console.error("[settings/lead-capture form-mapping PUT]", err);
      return res
        .status(500)
        .json({ error: "Failed to update form-routing mapping." });
    }
  },
);

// ── DELETE /form-routing-mappings/:id ─────────────────────────────────
router.delete(
  "/form-routing-mappings/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { tenantId } = req.user;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid id.", code: "INVALID_ID" });
      }
      const existing = await prisma.formRoutingMapping.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        return res
          .status(404)
          .json({ error: "Mapping not found.", code: "NOT_FOUND" });
      }
      await prisma.formRoutingMapping.delete({ where: { id } });
      return res.status(204).end();
    } catch (err) {
      console.error("[settings/lead-capture form-mapping DELETE]", err);
      return res
        .status(500)
        .json({ error: "Failed to delete form-routing mapping." });
    }
  },
);

module.exports = router;
module.exports.ALLOWED_CHANNELS = ALLOWED_CHANNELS;
