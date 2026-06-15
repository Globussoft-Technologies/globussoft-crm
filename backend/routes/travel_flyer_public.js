/**
 * /api/v1/flyers — public flyer share + render surface
 * (PRD_TRAVEL_MARKETING_FLYER #908 slice S18 — `docs/TRAVEL_BIG_SCOPE_BACKLOG.md`).
 *
 * Per PRD FR-3.5.3 + FR-3.5.4 — the public-facing half of the marketing
 * flyer studio. Mirrors slice C9 (Quote Accept Landing) in shape:
 *
 *   POST /api/v1/flyers/:id/share              (operator, ADMIN+MANAGER)
 *       → returns { shareUrl, embedCode, expiresAt } for a flyer they own.
 *
 *   GET  /api/v1/flyers/public/:slug?t=<jwt>   (PUBLIC, no auth)
 *       → renders the flyer via services/flyerRenderEngine.renderFlyer
 *         and streams the binary buffer with appropriate Content-Type.
 *         Accepts `?format=pdf-a4|pdf-a5|png-square|png-portrait-ig|png-landscape-fb`.
 *
 *   GET  /api/v1/flyers/public/:slug/meta?t=<jwt>   (PUBLIC, no auth)
 *       → returns { templateName, destSlug, themeTag, brandName, expiresAt, embed }
 *         so the public landing page (frontend/src/pages/public/FlyerView.jsx)
 *         can render an operator-facing card BEFORE pulling the heavy
 *         binary asset.
 *
 * --- Why a separate file (vs extending travel_flyer_templates.js) ---
 *
 * The C9 separation (travel_quotes_public.js vs the operator quotes router)
 * is the canonical pattern: operator routes are auth-gated globally via
 * the openPaths regex in server.js, public routes are opt-in via a path
 * prefix listed in openPaths. Keeping them in distinct files makes the
 * security boundary impossible to mis-mount — there's no "ADMIN happens to
 * still be allowed because the share router accidentally inherited the
 * verifyToken middleware" failure mode.
 *
 * --- Auth model ---
 *
 *   POST /:id/share:
 *     - verifyToken (req.user.userId required)
 *     - verifyRole(['ADMIN', 'MANAGER'])
 *     - requireTravelTenant — only travel-vertical tenants can mint
 *     - sub-brand check via getSubBrandAccessSet + canAccessSubBrand
 *
 *   GET /public/:slug:
 *     - NO auth middleware (server.js openPaths regex covers `/api/v1/flyers/public`)
 *     - JWT in `?t=` is the SOLE authorizer
 *     - The slug in the path MUST match the JWT's flyerId (after slug-resolve)
 *       so a leaked token can't be replayed against a different flyer
 *
 *   GET /public/:slug/meta:
 *     - Same gate as /public/:slug. Carries no binary — just the metadata
 *       chrome the landing page needs to draw the operator-facing card.
 *
 * --- Slug semantics ---
 *
 * `slug` = lowercased + dasherized template.name (max 80 chars). If two
 * templates collide on slug (rare — same tenant + identical name), we
 * fall back to slug = `flyer-<id>` so the share link still resolves
 * uniquely. The slug appearing in the URL is decorative — the JWT's
 * embedded flyerId is the authoritative lookup key. We do verify the
 * slug matches the resolved template's slug to prevent a clean-looking
 * link surfacing the WRONG flyer when an operator reorganises template
 * names.
 *
 * --- Audit log ---
 *
 * Every successful public render writes a TRAVEL_FLYER_PUBLIC_RENDER
 * audit row scoped to the template's tenantId, with userId=null +
 * actorType='public' (mirror writeAudit's customer-action override).
 * Operator-side `/usage-stats` + per-template analytics can join on this
 * action verb to expose "shared X times → rendered Y times" funnels.
 * Audit failure does NOT block the render — the public surface MUST
 * return the bytes; audit-chain integrity is a secondary concern.
 *
 * --- Server.js mount ---
 *
 * Mounting in server.js is a SEPARATE follow-up slice (concurrent-agent
 * shared-file hazard — slice S19 + S10 are also live on Wave 14). The
 * route file is self-contained and ready to mount at:
 *
 *     app.use('/api/v1/flyers', require('./routes/travel_flyer_public'));
 *
 * with the matching openPaths entry:
 *
 *     '/v1/flyers/public'
 *
 * appended to the openPaths array in server.js. Until then the file is
 * test-only — backend vitest + the e2e gate spec exercise it via in-test
 * router mounting; the wire-in slice flips the live surface on.
 */

'use strict';

const express = require('express');
const router = express.Router();

const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { verifyToken, verifyRole } = require('../middleware/auth');
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
} = require('../middleware/travelGuards');
const { writeAudit } = require('../lib/audit');
const { mintShareToken, verifyShareToken } = require('../lib/flyerShareToken');

// Render engine is lazy-required at call-time inside the GET /public/:slug
// handler so puppeteer-resolution is deferred + the operator-side POST
// /:id/share doesn't pay the import cost.

/**
 * Slug helper. Mirrors `routes/knowledge_base.js`'s slugify — lower-case +
 * dasherize + trim to 80 chars. Falls back to `flyer-<ts>` when the input
 * is empty (defensive — template.name has `required` validation upstream
 * but a row stored before validation landed could still be empty).
 */
function slugify(text) {
  return (
    String(text || '')
      .toLowerCase()
      .trim()
      .replace(/['"]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '')
      .slice(0, 80) || `flyer-${Date.now()}`
  );
}

/**
 * Resolve the public share base URL (protocol + host) from the request
 * itself, so a link minted from localhost points to localhost and one
 * minted from the demo points to the demo — no env config needed. The
 * operator's browser is the source of truth: the Origin header carries the
 * exact frontend base they're on (the Vite dev proxy forwards it as
 * `http://localhost:5173` in dev, `https://crm.globusdemos.com` in prod).
 *
 * Falls back to PUBLIC_BASE_URL / PUBLIC_HOST env, then the canonical demo
 * host, for server-to-server callers (cron, scripts) that send no Origin.
 */
function getPublicShareBase(req) {
  const candidate =
    req && typeof req.get === 'function'
      ? req.get('origin') || req.get('referer')
      : null;
  if (candidate && /^https?:\/\//i.test(candidate)) {
    try {
      const u = new URL(candidate);
      return `${u.protocol}//${u.host}`;
    } catch (_e) {
      // malformed header — fall through to env / default
    }
  }
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  if (process.env.PUBLIC_HOST) return `https://${process.env.PUBLIC_HOST}`;
  return 'https://crm.globusdemos.com';
}

const ALLOWED_FORMATS = Object.freeze([
  'pdf-a4',
  'pdf-a5',
  'png-square',
  'png-portrait-ig',
  'png-landscape-fb',
]);

/**
 * Pick the default format for the customer-facing landing page when the
 * URL didn't carry `?format=`. PNG-square renders most cleanly in an
 * iframe + on social previews.
 */
const DEFAULT_FORMAT = 'png-square';

/**
 * Resolve a slug → flyer row. Tenant is supplied by the JWT (not the
 * request) so we never cross-leak. The route compares the resolved row's
 * slug against the URL slug to fail closed when an operator renames a
 * template and an old share URL still floats around: the JWT still
 * authorizes the FLYER, but the URL claiming a stale slug yields 404.
 */
async function resolveFlyerForToken(tenantId, flyerId, slug) {
  const row = await prisma.travelFlyerTemplate.findFirst({
    where: { id: flyerId, tenantId },
  });
  if (!row) {
    return { error: { status: 404, code: 'FLYER_NOT_FOUND', message: 'Flyer not available' } };
  }
  if (!row.isActive) {
    return { error: { status: 404, code: 'FLYER_NOT_AVAILABLE', message: 'Flyer is no longer available' } };
  }
  // Slug verification — the slug in the URL must match the canonical slug.
  // We accept either slugify(name) OR the fallback `flyer-<id>` form so
  // operator URL handouts both before and after the rename still resolve.
  const canonicalSlug = slugify(row.name);
  const fallbackSlug = `flyer-${row.id}`;
  if (slug !== canonicalSlug && slug !== fallbackSlug) {
    return { error: { status: 404, code: 'FLYER_NOT_FOUND', message: 'Flyer not available' } };
  }
  return { row, canonicalSlug };
}

/**
 * Convert a token-verification error into the route's HTTP envelope.
 * Mirrors travel_quotes_public.js's loadQuoteByShareToken error mapping
 * so the frontend can treat both share surfaces identically.
 *
 * S80 added the REVOKED_TOKEN case — surfaces as 401 INVALID_TOKEN per the
 * route's standing rule (don't reveal whether the token was malformed vs
 * deliberately revoked; operators just need "this link no longer works",
 * end-customers shouldn't know the distinction either).
 */
function tokenErrorEnvelope(e) {
  if (e.name === 'TokenExpiredError') {
    return { status: 410, code: 'LINK_EXPIRED', message: 'Share link has expired' };
  }
  if (e && e.code === 'REVOKED_TOKEN') {
    return { status: 401, code: 'INVALID_TOKEN', message: 'Share link has been revoked' };
  }
  return { status: 401, code: 'INVALID_TOKEN', message: 'Invalid share token' };
}

// ---------------------------------------------------------------------------
// POST /:id/share — operator mints a share link
// ---------------------------------------------------------------------------
router.post(
  '/:id/share',
  verifyToken,
  verifyRole(['ADMIN', 'MANAGER']),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'id must be a number', code: 'INVALID_ID' });
      }

      const template = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!template) {
        return res.status(404).json({
          error: 'Flyer template not found',
          code: 'TEMPLATE_NOT_FOUND',
        });
      }
      if (template.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, template.subBrand)) {
          return res.status(403).json({
            error: 'Sub-brand access denied',
            code: 'SUB_BRAND_DENIED',
          });
        }
      }

      // Optional body knob — operator can override the default 7-day TTL.
      // Clamped to a reasonable range (min 5 min, max 90 days) so an
      // operator can't accidentally mint a "lifetime" link.
      const rawExpires =
        req.body && Number.isFinite(Number(req.body.expiresInSec))
          ? Number(req.body.expiresInSec)
          : null;
      const expiresInSec = rawExpires == null
        ? 7 * 24 * 60 * 60
        : Math.max(300, Math.min(90 * 24 * 60 * 60, Math.floor(rawExpires)));

      const token = mintShareToken({
        flyerId: template.id,
        tenantId: template.tenantId,
        expiresInSec,
      });

      // S80 — decode the just-minted token to extract its jti so we can
      // persist it on the audit row. The revoke endpoint (POST /:id/
      // revoke-share) reads back this row to translate a {slug, mintedAt}
      // pair (what the operator UI knows) into the {jti} required to
      // populate the RevokedToken table.
      // jwt.decode is unauthenticated parse — safe here because we just
      // minted the token ourselves above.
      const decoded = jwt.decode(token) || {};
      const jti = decoded.jti || null;

      const slug = slugify(template.name);
      const base = getPublicShareBase(req);
      const shareUrl = `${base}/p/flyer/${slug}?t=${encodeURIComponent(token)}`;
      // Embed code — iframe pointing at the same surface with embed=1
      // appended so the page can render in a "minimal chrome" mode
      // (no operator-only banners, no "Download PDF" link).
      const embedUrl = `${base}/p/flyer/${slug}?t=${encodeURIComponent(token)}&embed=1`;
      const embedCode = `<iframe src="${embedUrl}" width="1200" height="1200" frameborder="0" allowfullscreen></iframe>`;

      const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

      try {
        await writeAudit(
          'TravelFlyerTemplate',
          'TRAVEL_FLYER_PUBLIC_SHARE_MINTED',
          template.id,
          req.user.userId,
          req.travelTenant.id,
          {
            flyerId: template.id,
            slug,
            expiresAt,
            expiresInSec,
            jti, // S80 — needed by revoke-share lookup
          },
        );
      } catch (e) {
        // Audit failure must not block the share-mint acknowledgement.
        console.error('[travel-flyer-public] audit share-mint failed:', e.message);
      }

      return res.status(200).json({
        shareUrl,
        embedCode,
        expiresAt,
        slug,
        flyerId: template.id,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error('[travel-flyer-public] share-mint error:', e.message);
      return res.status(500).json({ error: 'Failed to mint share link', code: 'INTERNAL_ERROR' });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/revoke-share — operator invalidates a previously-minted share JWT
// ---------------------------------------------------------------------------
//
// S80 — completes the share-link lifecycle. The operator UI (S79's
// FlyerShareAdmin.jsx) renders a Revoke button on each historical mint row;
// clicking it POSTs here with `{slug, mintedAt}` (what the UI knows from the
// audit-log row). The endpoint resolves that pair → the original mint's jti
// (stored in the SHARE_MINTED audit row's metadata since S80) → writes a
// RevokedToken row that the next verifyShareToken() call will see and
// reject with REVOKED_TOKEN.
//
// Body accepts EITHER form:
//   { jti }                    — API consumer who knows the jti directly
//   { slug, mintedAt }         — operator UI working from the audit log
//
// 200 { revoked: true, jti, alreadyRevoked: false } on first revoke
// 200 { revoked: true, jti, alreadyRevoked: true  } on idempotent re-revoke
// 400 INVALID_BODY              — neither {jti} nor {slug, mintedAt} provided
// 404 SHARE_MINT_NOT_FOUND      — {slug, mintedAt} pair doesn't match any
//                                  audit row for this flyer
// 404 TEMPLATE_NOT_FOUND        — flyer doesn't exist or is cross-tenant
// 403 SUB_BRAND_DENIED          — operator lacks sub-brand access
//
// Audit row TRAVEL_FLYER_PUBLIC_SHARE_REVOKED is written either way (first
// revoke OR idempotent re-revoke) so the audit chain reflects the operator
// intent even if the underlying row was already in place.
router.post(
  '/:id/revoke-share',
  verifyToken,
  verifyRole(['ADMIN', 'MANAGER']),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'id must be a number', code: 'INVALID_ID' });
      }

      const template = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!template) {
        return res.status(404).json({
          error: 'Flyer template not found',
          code: 'TEMPLATE_NOT_FOUND',
        });
      }
      if (template.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, template.subBrand)) {
          return res.status(403).json({
            error: 'Sub-brand access denied',
            code: 'SUB_BRAND_DENIED',
          });
        }
      }

      const body = req.body || {};
      let jti = body.jti ? String(body.jti) : null;

      // If the caller gave us {slug, mintedAt} instead of {jti}, resolve via
      // the audit log. mintedAt = the SHARE_MINTED audit row's createdAt
      // (the UI captures it verbatim from the audit-viewer response).
      if (!jti && body.slug && body.mintedAt) {
        try {
          const mintedAt = new Date(body.mintedAt);
          if (Number.isFinite(mintedAt.getTime())) {
            // Window the lookup to ±5s around mintedAt — audit rows record
            // wall-clock from writeAudit's Date.now() at the SAME tick, but
            // serialisation through JSON drops sub-second precision so an
            // exact-equals comparison risks dropping legitimate matches.
            const windowStart = new Date(mintedAt.getTime() - 5000);
            const windowEnd = new Date(mintedAt.getTime() + 5000);
            const auditRows = await prisma.auditLog.findMany({
              where: {
                entity: 'TravelFlyerTemplate',
                entityId: template.id,
                action: 'TRAVEL_FLYER_PUBLIC_SHARE_MINTED',
                tenantId: req.travelTenant.id,
                createdAt: { gte: windowStart, lte: windowEnd },
              },
              orderBy: { createdAt: 'desc' },
              take: 50,
            });
            const matched = auditRows.find((row) => {
              try {
                const meta = typeof row.metadata === 'string'
                  ? JSON.parse(row.metadata)
                  : (row.metadata || {});
                return meta.slug === body.slug && meta.jti;
              } catch (_e) {
                return false;
              }
            });
            if (matched) {
              const meta = typeof matched.metadata === 'string'
                ? JSON.parse(matched.metadata)
                : (matched.metadata || {});
              jti = meta.jti || null;
            }
          }
        } catch (lookupErr) {
          // Fall through to the missing-jti branch below.
          console.error('[travel-flyer-public] revoke-share audit lookup failed:', lookupErr.message);
        }
        if (!jti) {
          return res.status(404).json({
            error: 'No matching share-mint audit row found for slug+mintedAt',
            code: 'SHARE_MINT_NOT_FOUND',
          });
        }
      }

      if (!jti) {
        return res.status(400).json({
          error: 'Must provide either {jti} or {slug, mintedAt} in body',
          code: 'INVALID_BODY',
        });
      }

      // S80 — upsert so the endpoint is idempotent. Repeated revoke calls
      // for the same jti return 200 with alreadyRevoked: true; the
      // RevokedToken row stays put. Mirrors auth.js#L1262's pattern.
      const existing = await prisma.revokedToken.findUnique({
        where: { jti },
        select: { id: true, revokedAt: true },
      });
      let alreadyRevoked = false;
      if (existing) {
        alreadyRevoked = true;
      } else {
        // Expiry window: we don't know the original token's exp, so use the
        // 7-day DEFAULT_EXPIRES_IN_SEC. Auth-side revoked tokens use the
        // same 7-day window for cleanup (auth.js#L1270). The cleanup cron
        // is responsible for pruning rows past expiresAt.
        await prisma.revokedToken.create({
          data: {
            jti,
            userId: req.user.userId,
            tenantId: req.travelTenant.id,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            reason: 'flyer_share_revoked',
          },
        });
      }

      try {
        await writeAudit(
          'TravelFlyerTemplate',
          'TRAVEL_FLYER_PUBLIC_SHARE_REVOKED',
          template.id,
          req.user.userId,
          req.travelTenant.id,
          {
            flyerId: template.id,
            jti,
            slug: body.slug || null,
            mintedAt: body.mintedAt || null,
            alreadyRevoked,
          },
        );
      } catch (e) {
        console.error('[travel-flyer-public] audit share-revoke failed:', e.message);
      }

      return res.status(200).json({
        revoked: true,
        jti,
        alreadyRevoked,
        flyerId: template.id,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error('[travel-flyer-public] revoke-share error:', e.message);
      return res.status(500).json({ error: 'Failed to revoke share link', code: 'INTERNAL_ERROR' });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /public/:slug — render the flyer (PUBLIC, no auth)
// ---------------------------------------------------------------------------
router.get('/public/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const token = (req.query && req.query.t) ? String(req.query.t) : '';
    if (!token) {
      return res.status(401).json({ error: 'Missing share token', code: 'MISSING_TOKEN' });
    }
    let payload;
    try {
      // S80 — verifyShareToken is async (checks RevokedToken table).
      payload = await verifyShareToken(token);
    } catch (e) {
      const env = tokenErrorEnvelope(e);
      return res.status(env.status).json({ error: env.message, code: env.code });
    }
    const { flyerId, tenantId } = payload;

    const resolved = await resolveFlyerForToken(tenantId, flyerId, slug);
    if (resolved.error) {
      return res.status(resolved.error.status).json({
        error: resolved.error.message,
        code: resolved.error.code,
      });
    }
    const { row: template } = resolved;

    // Format gate — same set the operator-side render endpoint accepts.
    const rawFormat = (req.query && req.query.format) ? String(req.query.format) : DEFAULT_FORMAT;
    if (!ALLOWED_FORMATS.includes(rawFormat)) {
      return res.status(400).json({
        error: `format must be one of: ${ALLOWED_FORMATS.join(', ')}`,
        code: 'INVALID_FORMAT',
      });
    }

    // Parse stored JSON columns into the live shape the renderer consumes.
    // Mirror the defensive try/catch from /:id/render — corrupted rows
    // still render the placeholder rather than 500.
    let palette = null;
    let layout = null;
    let assets = null;
    if (template.paletteJson) {
      try { palette = JSON.parse(template.paletteJson); } catch (_e) { palette = null; }
    }
    if (template.layoutJson) {
      try { layout = JSON.parse(template.layoutJson); } catch (_e) { layout = null; }
    }
    if (template.assetsJson) {
      try { assets = JSON.parse(template.assetsJson); } catch (_e) { assets = null; }
    }

    // Lazy require so the operator surface doesn't pay the import cost.
    // eslint-disable-next-line global-require
    const { renderFlyer } = require('../services/flyerRenderEngine');
    const result = await renderFlyer({
      template: { palette, layout, assets },
      format: rawFormat,
    });

    // Audit — fail-soft. Public-surface render MUST always return bytes.
    try {
      await writeAudit(
        'TravelFlyerTemplate',
        'TRAVEL_FLYER_PUBLIC_RENDER',
        template.id,
        null,
        template.tenantId,
        {
          flyerId: template.id,
          slug,
          format: rawFormat,
          bytes: result.buffer.length,
          engine: result.engine,
          embed: req.query && req.query.embed === '1',
        },
        { actorType: 'public' },
      );
    } catch (e) {
      console.error('[travel-flyer-public] audit render failed:', e.message);
    }

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${slug}-${rawFormat}.${result.extension}"`,
    );
    res.setHeader('X-Flyer-Render-Engine', result.engine);
    if (result.widthPx) res.setHeader('X-Flyer-Width-Px', String(result.widthPx));
    if (result.heightPx) res.setHeader('X-Flyer-Height-Px', String(result.heightPx));
    // Cache-Control: short browser cache so embedders don't hammer the
    // backend on iframe-page reloads, but short enough that an operator
    // edit landing inside the TTL is visible within 5 min.
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(result.buffer);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error('[travel-flyer-public] public render error:', e.message);
    return res.status(500).json({ error: 'Failed to render flyer', code: 'INTERNAL_ERROR' });
  }
});

// ---------------------------------------------------------------------------
// GET /public/:slug/meta — metadata-only (PUBLIC, no auth)
// ---------------------------------------------------------------------------
router.get('/public/:slug/meta', async (req, res) => {
  try {
    const { slug } = req.params;
    const token = (req.query && req.query.t) ? String(req.query.t) : '';
    if (!token) {
      return res.status(401).json({ error: 'Missing share token', code: 'MISSING_TOKEN' });
    }
    let payload;
    try {
      // S80 — verifyShareToken is async (checks RevokedToken table).
      payload = await verifyShareToken(token);
    } catch (e) {
      const env = tokenErrorEnvelope(e);
      return res.status(env.status).json({ error: env.message, code: env.code });
    }
    const { flyerId, tenantId, exp } = payload;

    const resolved = await resolveFlyerForToken(tenantId, flyerId, slug);
    if (resolved.error) {
      return res.status(resolved.error.status).json({
        error: resolved.error.message,
        code: resolved.error.code,
      });
    }
    const { row: template } = resolved;

    // Look up the tenant for a brand-name display. Fail-soft — if the
    // tenant row goes away, we fall back to the sub-brand label.
    let brandName = null;
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: template.tenantId },
        select: { name: true },
      });
      brandName = tenant ? tenant.name : null;
    } catch (_e) {
      brandName = null;
    }

    // Theme tag pulled from paletteJson if present — surface for the
    // landing page header. Defensive: corrupted JSON → null.
    let themeTag = null;
    if (template.paletteJson) {
      try {
        const palette = JSON.parse(template.paletteJson);
        themeTag = palette && palette.themeTag ? String(palette.themeTag) : null;
      } catch (_e) {
        themeTag = null;
      }
    }

    return res.status(200).json({
      templateName: template.name,
      destSlug: slug,
      themeTag,
      brandName,
      subBrand: template.subBrand || null,
      expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
      embed: req.query && req.query.embed === '1',
      availableFormats: ALLOWED_FORMATS,
      defaultFormat: DEFAULT_FORMAT,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error('[travel-flyer-public] meta error:', e.message);
    return res.status(500).json({ error: 'Failed to load flyer metadata', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
