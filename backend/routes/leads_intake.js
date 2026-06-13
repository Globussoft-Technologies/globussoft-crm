/**
 * /api/leads/intake — canonical multi-channel lead intake alias
 * (PRD_TRAVEL_MULTICHANNEL_LEADS G015 + FR-3.1.1).
 *
 * Body-channel mode: the channel is read from `req.body.channel` instead
 * of the URL path. Forwards to the existing /api/travel/inbound/leads/:channel
 * handler so both surfaces share one envelope, one idempotency contract,
 * one Touchpoint write, one cooldown gate.
 *
 * Why two surfaces? The legacy /api/travel/inbound/leads/:channel handler
 * stays live for back-compat with producers (voyagr microsites, Wati
 * WhatsApp, voice/IVR bridge, Meta lead-ads webhook) that already point
 * at it. New producers + the canonical SDK should target /api/leads/intake.
 *
 * Implementation: rather than duplicate the route logic, we re-mount the
 * existing handler under a thin shim that copies body.channel onto
 * params.channel. This keeps the two surfaces structurally identical and
 * makes future drift between them impossible.
 */

'use strict';

const express = require('express');
const router = express.Router();

// Lazy-require so the legacy route's prisma + verifyByChannel imports
// don't double-fire. The legacy router exposes an Express Router instance;
// we mount it under our shim below.
const legacyRouter = require('./travel_inbound_leads');

/**
 * POST /api/leads/intake — body must carry { channel: "<canonical>", ... }
 * plus the standard intake payload (tenantSlug, email/phone, etc.).
 *
 * The shim:
 *   1. Reads body.channel and pins it on params.channel.
 *   2. Rewrites req.url to the legacy '/inbound/leads/<channel>' path so
 *      the legacy router's POST /inbound/leads/:channel handler matches.
 *   3. Hands off to the legacy router. Response envelope is identical to
 *      the legacy surface (action + touchpointId + matchedRoutingRuleId).
 *
 * Errors:
 *   400 MISSING_CHANNEL — body.channel is required for the canonical alias.
 */
router.post('/intake', (req, res, next) => {
  const channel = req.body && req.body.channel;
  if (!channel || typeof channel !== 'string' || !channel.trim()) {
    return res.status(400).json({
      error: 'channel is required in body for the canonical /api/leads/intake alias',
      code: 'MISSING_CHANNEL',
    });
  }
  // Mutate the express request so the legacy router's path matcher fires.
  // The legacy router expects mount path '/api/travel' + relative
  // '/inbound/leads/:channel'. We override req.url here BEFORE handing
  // control over.
  req.url = `/inbound/leads/${encodeURIComponent(channel.trim())}`;
  return legacyRouter(req, res, next);
});

module.exports = router;
