// Travel CRM — Religious-guidance content library admin CRUD.
//
// PRD §4.8 + §4.10 RFU sub-brand. Admin-curated content packets fired
// at fixed pre-departure offsets by backend/cron/religiousGuidanceEngine.js.
//
// Library is editable here; the cron consumes the library at fire time
// so an admin PATCH to a packet's contentHtml takes effect on the next
// daily cron tick without redeployment. Phase 1 seeds 3 placeholder
// packets at dayOffset 14/7/1; Yasin's Q1 canonical Hajj/Umrah copy
// replaces the placeholder via admin PATCH.
//
// Endpoints:
//   GET    /api/travel/religious-packets                — list (filter by ?subBrand= + ?isActive=)
//   POST   /api/travel/religious-packets                — ADMIN; create
//   GET    /api/travel/religious-packets/:id            — fetch one
//   PATCH  /api/travel/religious-packets/:id            — ADMIN; amend
//   DELETE /api/travel/religious-packets/:id            — ADMIN; remove
//
// All endpoints: verifyToken + requireTravelTenant + sub-brand access
// check (when subBrand provided / on the row).

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  VALID_SUB_BRANDS,
} = require("../middleware/travelGuards");

// Channels: comma-separated subset of wa|email|sms. Anchored with ^$ so
// stray whitespace / empty tokens fail validation rather than silently
// passing into the cron's split() loop where they would be skipped.
const CHANNELS_RE = /^(wa|email|sms)(,(wa|email|sms))*$/;
// Reasonable bound — a single religious-guidance packet should fit
// well within this for HTML rendering. Anything larger likely means
// the operator pasted in an attachment or a corrupt blob.
const MAX_CONTENT_HTML_BYTES = 20_000;
const MAX_TITLE_LEN = 200;
// dayOffset bounds — positive Phase 1 (pre-trip). The schema allows
// negative (reserved for post-trip "thank-you" packets in a later
// phase) but routes reject < 0 to keep Phase 1 surface small. Upper
// bound 365 prevents accidental year-out junk entries.
const MIN_DAY_OFFSET = 0;
const MAX_DAY_OFFSET = 365;

/**
 * Sub-brand access guard. Permits the request when the caller has
 * access to the row's subBrand (or full access). Used as a per-route
 * guard on writes; on reads we filter the list result-set instead.
 */
async function assertSubBrandAccess(req, subBrand) {
  const allowed = await getSubBrandAccessSet(req.user.userId);
  if (!canAccessSubBrand(allowed, subBrand)) {
    const err = new Error(`${subBrand} sub-brand access required`);
    err.status = 403;
    err.code = "SUB_BRAND_DENIED";
    throw err;
  }
}

// ─── List + create ────────────────────────────────────────────────────

router.get(
  "/religious-packets",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };
      if (req.query.subBrand) {
        const s = String(req.query.subBrand);
        if (!VALID_SUB_BRANDS.includes(s)) {
          return res
            .status(400)
            .json({ error: "invalid subBrand", code: "INVALID_SUB_BRAND" });
        }
        where.subBrand = s;
      }
      if (req.query.isActive !== undefined) {
        // Accept "true"/"false" + "1"/"0" so the frontend Filter dropdown
        // can serialise booleans without surprise.
        const v = String(req.query.isActive).toLowerCase();
        if (!["true", "false", "1", "0"].includes(v)) {
          return res.status(400).json({
            error: "isActive must be true/false",
            code: "INVALID_IS_ACTIVE",
          });
        }
        where.isActive = v === "true" || v === "1";
      }
      // Narrow by sub-brand access — non-admin advisors only see packets
      // for sub-brands they're entitled to. Mirrors the pattern in
      // travel_itineraries.js / travel_trips.js.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed !== null) {
        if (where.subBrand !== undefined) {
          if (!canAccessSubBrand(allowed, where.subBrand)) {
            where.subBrand = "__none__"; // forces zero rows
          }
        } else {
          where.subBrand = { in: [...allowed] };
        }
      }
      const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const skip = parseInt(req.query.offset, 10) || 0;
      const [packets, total] = await Promise.all([
        prisma.religiousGuidancePacket.findMany({
          where,
          orderBy: [{ subBrand: "asc" }, { dayOffset: "desc" }, { id: "desc" }],
          take,
          skip,
        }),
        prisma.religiousGuidancePacket.count({ where }),
      ]);
      res.json({ packets, total, limit: take, offset: skip });
    } catch (e) {
      console.error("[travel-religious] list error:", e.message);
      res.status(500).json({ error: "Failed to list packets" });
    }
  },
);

router.post(
  "/religious-packets",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { subBrand, dayOffset, title, contentHtml, channels, isActive } =
        req.body || {};

      // Required fields
      if (!subBrand || !title || !contentHtml || dayOffset === undefined || dayOffset === null) {
        return res.status(400).json({
          error: "subBrand, dayOffset, title, contentHtml are required",
          code: "MISSING_FIELDS",
        });
      }
      if (!VALID_SUB_BRANDS.includes(subBrand)) {
        return res.status(400).json({
          error: `subBrand must be one of: ${VALID_SUB_BRANDS.join(", ")}`,
          code: "INVALID_SUB_BRAND",
        });
      }
      const doff = parseInt(dayOffset, 10);
      if (!Number.isInteger(doff) || doff < MIN_DAY_OFFSET || doff > MAX_DAY_OFFSET) {
        return res.status(400).json({
          error: `dayOffset must be an integer in [${MIN_DAY_OFFSET}, ${MAX_DAY_OFFSET}]`,
          code: "INVALID_DAY_OFFSET",
        });
      }
      if (typeof title !== "string" || title.length === 0 || title.length > MAX_TITLE_LEN) {
        return res.status(400).json({
          error: `title must be 1..${MAX_TITLE_LEN} characters`,
          code: "INVALID_TITLE",
        });
      }
      if (typeof contentHtml !== "string" || contentHtml.length === 0) {
        return res.status(400).json({ error: "contentHtml must be a non-empty string", code: "INVALID_CONTENT" });
      }
      if (Buffer.byteLength(contentHtml, "utf8") > MAX_CONTENT_HTML_BYTES) {
        return res.status(400).json({
          error: `contentHtml exceeds ${MAX_CONTENT_HTML_BYTES} bytes`,
          code: "CONTENT_TOO_LARGE",
        });
      }
      const channelsStr = channels === undefined || channels === null ? "wa,email" : String(channels);
      if (!CHANNELS_RE.test(channelsStr)) {
        return res.status(400).json({
          error: "channels must be a comma-separated subset of wa|email|sms (no spaces, no duplicates)",
          code: "INVALID_CHANNELS",
        });
      }

      await assertSubBrandAccess(req, subBrand);

      const created = await prisma.religiousGuidancePacket.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand,
          dayOffset: doff,
          title,
          contentHtml,
          channels: channelsStr,
          isActive: isActive === undefined ? true : Boolean(isActive),
        },
      });
      res.status(201).json(created);
    } catch (e) {
      if (e.code === "SUB_BRAND_DENIED") {
        return res.status(403).json({ error: e.message, code: e.code });
      }
      console.error("[travel-religious] create error:", e.message);
      res.status(500).json({ error: "Failed to create packet" });
    }
  },
);

// ============================================================================
// GET /api/travel/religious-packets/stats — tenant-wide content-library rollup
//
// Mirrors the broader stats family (#903 slice 23 /suppliers/stats, #905 slice
// 18 /commission-profiles/stats, #908 slice 19 /flyer-templates/global-stats).
// USER-readable anodyne aggregate that powers the Religious Guidance Packets
// library page's header summary strip ("12 packets · 9 active · 3 archived ·
// 7 rfu · 5 tmc · 1 day-0 / 4 day-1 / 3 day-3 / 4 day-7 · last edited 2h ago").
// Without it the frontend has to fire {list, count by subBrand×4, count by
// isActive, count by dayOffset bucket, count by channel} — N+1 round-trips for
// a single visual surface.
//
// Behaviour:
//   - Sub-brand-scoped: non-admin advisors with subBrandAccess narrow the
//     visible set BEFORE counting. Mirrors the /religious-packets list
//     endpoint's pattern (lines 97-106) so the two surfaces stay consistent.
//   - Bucketing (all from prisma.religiousGuidancePacket.findMany):
//       total                            — count of all visible rows
//       active, archived                 — count by isActive flag
//       bySubBrand: { <sb>: { count } }  — per-sub-brand counts
//       byDayOffset: { "0":n, "1":n... } — per-dayOffset counts (string keys
//                                          so JSON serialises cleanly + the
//                                          UI can render in numeric order)
//       byChannel: { wa, email, sms }    — count of packets ENABLING each
//                                          channel (a packet with channels=
//                                          "wa,email" contributes +1 to wa
//                                          AND +1 to email, NOT +1 to a
//                                          composite "wa,email" key)
//       lastUpdatedAt                    — max(updatedAt) across visible rows
//   - ?from / ?to (ISO date bounds) filter packet.createdAt before aggregation.
//
// USER-readable: anodyne aggregate (counts + timestamps); safe. No audit row:
// read-only meta surface, mirrors /commission-profiles/stats and /suppliers/stats.
//
// Express route ordering: literal-path /stats MUST be declared BEFORE the
// /religious-packets/:id family or `:id="stats"` would fail INVALID_ID before
// reaching this handler.
// ============================================================================

router.get(
  "/religious-packets/stats",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;
      const where = { tenantId };

      // Optional ISO date bounds on packet.createdAt — same shape as the
      // sibling /suppliers/stats endpoint.
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw) {
        const d = new Date(fromRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "from must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        where.createdAt = Object.assign(where.createdAt || {}, { gte: d });
      }
      if (toRaw) {
        const d = new Date(toRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        where.createdAt = Object.assign(where.createdAt || {}, { lte: d });
      }

      // Sub-brand narrowing — mirrors the list endpoint pattern. Non-admin
      // advisors only contribute to the rollup over sub-brands they're
      // entitled to. Empty allowed-set = deny everything (force zero rows).
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed !== null) {
        if (allowed.size === 0) {
          where.subBrand = "__none__"; // forces zero rows
        } else {
          where.subBrand = { in: [...allowed] };
        }
      }

      const packets = await prisma.religiousGuidancePacket.findMany({
        where,
        select: {
          id: true,
          subBrand: true,
          dayOffset: true,
          isActive: true,
          channels: true,
          updatedAt: true,
        },
        orderBy: [{ id: "asc" }],
      });

      // Empty short-circuit — return zeroed shape with stable bucket maps.
      if (packets.length === 0) {
        return res.json({
          total: 0,
          active: 0,
          archived: 0,
          bySubBrand: {},
          byDayOffset: {},
          byChannel: { wa: 0, email: 0, sms: 0 },
          lastUpdatedAt: null,
        });
      }

      let active = 0;
      let archived = 0;
      let lastUpdatedAt = null;
      const bySubBrand = {};
      const byDayOffset = {};
      const byChannel = { wa: 0, email: 0, sms: 0 };

      for (const p of packets) {
        if (p.isActive) active += 1;
        else archived += 1;

        const ts = p.updatedAt instanceof Date ? p.updatedAt : new Date(p.updatedAt);
        if (!Number.isNaN(ts.getTime())) {
          if (!lastUpdatedAt || ts > lastUpdatedAt) lastUpdatedAt = ts;
        }

        // Schema has subBrand non-nullable but defensively coalesce falsy
        // → '_tenant' for forward-compat (matches sibling /suppliers/stats).
        const sbKey = p.subBrand ? String(p.subBrand) : "_tenant";
        if (!bySubBrand[sbKey]) bySubBrand[sbKey] = { count: 0 };
        bySubBrand[sbKey].count += 1;

        // dayOffset bucket — string key so JSON serialises cleanly.
        const doKey = String(p.dayOffset);
        if (!byDayOffset[doKey]) byDayOffset[doKey] = { count: 0 };
        byDayOffset[doKey].count += 1;

        // channels is a CSV like "wa,email" — split + bump each channel.
        // Defensive: handle null/empty/unknown tokens gracefully.
        if (typeof p.channels === "string" && p.channels.length > 0) {
          const tokens = p.channels.split(",").map((s) => s.trim());
          for (const tok of tokens) {
            if (tok === "wa" || tok === "email" || tok === "sms") {
              byChannel[tok] += 1;
            }
          }
        }
      }

      res.json({
        total: packets.length,
        active,
        archived,
        bySubBrand,
        byDayOffset,
        byChannel,
        lastUpdatedAt: lastUpdatedAt ? lastUpdatedAt.toISOString() : null,
      });
    } catch (e) {
      console.error("[travel-religious] stats error:", e.message);
      res.status(500).json({ error: "Failed to summarise religious packets" });
    }
  },
);

// ─── Get + patch + delete ────────────────────────────────────────────

router.get(
  "/religious-packets/:id",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const row = await prisma.religiousGuidancePacket.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!row) return res.status(404).json({ error: "Packet not found", code: "NOT_FOUND" });
      // Non-admin advisors only see packets for sub-brands they're
      // entitled to.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, row.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access required", code: "SUB_BRAND_DENIED" });
      }
      res.json(row);
    } catch (e) {
      console.error("[travel-religious] get error:", e.message);
      res.status(500).json({ error: "Failed to get packet" });
    }
  },
);

router.patch(
  "/religious-packets/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.religiousGuidancePacket.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Packet not found", code: "NOT_FOUND" });

      // Sub-brand guard against the EXISTING row's subBrand — admin can't
      // sidestep their access list by PATCHing a packet they shouldn't
      // see.
      await assertSubBrandAccess(req, existing.subBrand);

      const data = {};
      const body = req.body || {};

      if (Object.prototype.hasOwnProperty.call(body, "subBrand")) {
        if (!VALID_SUB_BRANDS.includes(body.subBrand)) {
          return res
            .status(400)
            .json({ error: "invalid subBrand", code: "INVALID_SUB_BRAND" });
        }
        // ALSO check access on the NEW subBrand — admin can't migrate a
        // packet INTO a sub-brand they don't have access to.
        await assertSubBrandAccess(req, body.subBrand);
        data.subBrand = body.subBrand;
      }
      if (Object.prototype.hasOwnProperty.call(body, "dayOffset")) {
        const doff = parseInt(body.dayOffset, 10);
        if (!Number.isInteger(doff) || doff < MIN_DAY_OFFSET || doff > MAX_DAY_OFFSET) {
          return res.status(400).json({
            error: `dayOffset must be an integer in [${MIN_DAY_OFFSET}, ${MAX_DAY_OFFSET}]`,
            code: "INVALID_DAY_OFFSET",
          });
        }
        data.dayOffset = doff;
      }
      if (Object.prototype.hasOwnProperty.call(body, "title")) {
        const t = body.title;
        if (typeof t !== "string" || t.length === 0 || t.length > MAX_TITLE_LEN) {
          return res.status(400).json({
            error: `title must be 1..${MAX_TITLE_LEN} characters`,
            code: "INVALID_TITLE",
          });
        }
        data.title = t;
      }
      if (Object.prototype.hasOwnProperty.call(body, "contentHtml")) {
        const c = body.contentHtml;
        if (typeof c !== "string" || c.length === 0) {
          return res.status(400).json({ error: "contentHtml must be a non-empty string", code: "INVALID_CONTENT" });
        }
        if (Buffer.byteLength(c, "utf8") > MAX_CONTENT_HTML_BYTES) {
          return res.status(400).json({
            error: `contentHtml exceeds ${MAX_CONTENT_HTML_BYTES} bytes`,
            code: "CONTENT_TOO_LARGE",
          });
        }
        data.contentHtml = c;
      }
      if (Object.prototype.hasOwnProperty.call(body, "channels")) {
        const ch = String(body.channels);
        if (!CHANNELS_RE.test(ch)) {
          return res.status(400).json({
            error: "channels must be a comma-separated subset of wa|email|sms (no spaces, no duplicates)",
            code: "INVALID_CHANNELS",
          });
        }
        data.channels = ch;
      }
      if (Object.prototype.hasOwnProperty.call(body, "isActive")) {
        data.isActive = Boolean(body.isActive);
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.religiousGuidancePacket.update({
        where: { id },
        data,
      });
      res.json(updated);
    } catch (e) {
      if (e.code === "SUB_BRAND_DENIED") {
        return res.status(403).json({ error: e.message, code: e.code });
      }
      console.error("[travel-religious] patch error:", e.message);
      res.status(500).json({ error: "Failed to update packet" });
    }
  },
);

router.delete(
  "/religious-packets/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.religiousGuidancePacket.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Packet not found", code: "NOT_FOUND" });
      await assertSubBrandAccess(req, existing.subBrand);
      await prisma.religiousGuidancePacket.delete({ where: { id } });
      res.json({ deleted: true, id });
    } catch (e) {
      if (e.code === "SUB_BRAND_DENIED") {
        return res.status(403).json({ error: e.message, code: e.code });
      }
      console.error("[travel-religious] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete packet" });
    }
  },
);

module.exports = router;
