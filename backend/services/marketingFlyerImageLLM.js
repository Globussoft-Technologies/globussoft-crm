/**
 * Travel marketing-flyer-image LLM client — STUB MODE.
 *
 * STUB: real AI image-gen call pending Q-MF-2 — operator chooses between
 * DALL-E 3 (`OPENAI_API_KEY` env var) and Stability AI XL
 * (`STABILITY_API_KEY` env var). PRD §FR-3.6.3 leaves the provider choice
 * open and PRD §Q-MF-2 explicitly enumerates both as acceptable (plus
 * Midjourney enterprise — out of scope for the v1 wire-in because the
 * Midjourney API surface is still inconsistent across enterprise tiers).
 *
 * Real-mode provider choice (DALL-E vs Stability):
 *   - **Primary: DALL-E 3** (`OPENAI_API_KEY`). Rationale:
 *       (1) OpenAI is already the team's expected vendor surface — the
 *           same `OPENAI_API_KEY` env var lights up `gpt-4` for the
 *           `reasoning` task class in lib/llmRouter.js, so adding DALL-E
 *           re-uses a cred that's plausibly already provisioned.
 *       (2) DALL-E 3 API is stable + JSON-native + has built-in moderation,
 *           reducing the per-tenant moderation-pipeline burden vs. running
 *           our own NSFW filter on Stable Diffusion output.
 *       (3) 1024×1024 / 1024×1792 / 1792×1024 aspect-ratio support maps
 *           cleanly to the canvas-editor's 1:1 / 9:16 / 16:9 flyer presets.
 *   - **Fallback: Stability AI XL** (`STABILITY_API_KEY`). Rationale:
 *       (1) Lower per-image cost ($0.04 vs DALL-E 3 $0.04-$0.12 at HD).
 *       (2) Tenants with brand-style requirements that DALL-E refuses to
 *           generate (e.g. specific religious imagery for RFU Umrah trips)
 *           may need Stability's looser prompt acceptance.
 *       (3) Self-hostable via Replicate API — gives ops a degraded path
 *           if OpenAI quota gets hit.
 *
 * Both providers are checked in order; the first that has a key wins.
 * Per-tenant override via SupplierCredential (category `image-key`) is
 * sketched but deferred to S45-style follow-up (`Q-MF-2 follow-up` row).
 *
 * Source of truth: docs/PRD_TRAVEL_MARKETING_FLYER.md FR-3.6.3:
 *   - (a) Trigger: "Generate AI image" button on FlyerCanvasEditor.jsx
 *         (S20 — DD-5.1 blocked) and future template-default population.
 *   - (b) Prompt inputs: destination (string), sub-brand (TMC / RFU /
 *         TravelStall / VisaSure), themeJson (free-text trip type / season
 *         / vibe), aspectRatio (one of '1:1' | '9:16' | '16:9' — matches
 *         the canvas-editor's flyer presets).
 *   - (c) Routed via lib/llmRouter.js new task class `marketing-flyer-image`.
 *         Primary model: `dall-e-3`; fallback: `stability-xl`.
 *   - (d) Returned shape: `{ imageUrl, source, model, stub }` — image URL
 *         is what the canvas-editor inserts into the flyer's image block.
 *   - (e) Operator-mediated UX — operator picks one of N variants
 *         (variant pagination not implemented in v1; single image per call).
 *
 * Canonical return envelope (STUB + REAL — same shape):
 *   {
 *     imageUrl: "...",                      // [STUB-FLYER-IMAGE] path in stub mode
 *     source:   "stub" | "dalle" | "stability",
 *     model:    "dall-e-3" | "stability-xl",
 *     stub:     <bool>,
 *   }
 *
 * The deterministic stub URL shape `/static/placeholders/flyer/<destSlug>/
 * <themeTag>-<aspectRatio>.jpg` is consumable by S17 (PDF/PNG render
 * pipeline) and S20 (canvas editor) as a stable contract that doesn't
 * change when real-mode lands.
 *
 * Budget cap: SEPARATE envelope via `tenantSettings.getBudgetCap(tenantId,
 * 'image-llm')` (S73 split). DALL-E 3 HD is $0.12/image vs Gemini Flash
 * $0.0001/1K tokens, so a runaway image-gen burst would otherwise silently
 * exhaust the text-LLM budget. The split lets ops set finer per-tenant
 * caps on each side. Default `IMAGE_LLM_MONTHLY_CAP_USD_CENTS` matches
 * the text-LLM default ($100 = 10000c) as a sensible starting point;
 * ops can tune per-tenant. Pre-S73 this client shared INTEGRATION='llm'
 * with marketingFlyerCopyLLM — the split is a back-compat-safe re-key
 * because no TenantSetting rows exist yet for either integration on
 * any tenant (no real-mode call has fired in production).
 *
 * CJS self-mocking seam: every internal call goes through
 * `module.exports.fn(...)` indirection so vitest can
 * `vi.spyOn(client, 'checkBudgetCap')` / `vi.spyOn(client, 'realModeEnabled')`
 * / `vi.spyOn(client, 'callImageProvider')` cleanly. Mirrors S15's
 * `marketingFlyerCopyLLM` exactly (see commit `866a147c`).
 *
 * Cred chase: docs/CREDS_TRACKER.md Q-MF-2 row (image-gen key).
 * Mirror clients:
 *   - backend/services/marketingFlyerCopyLLM.js (commit 866a147c, S15) — text counterpart
 *   - backend/services/adsGptClient.js          (commit 9f35040)
 *   - backend/services/ratehawkClient.js        (commit 2852b82)
 *   - backend/services/callifiedClient.js       (commit 9ec52df)
 */

'use strict';

// Defensive .env load — mirrors itinerarySuggestLLM (see comment there).
// Skipped under NODE_ENV=test so tests can drive env shape per case.
if (process.env.NODE_ENV !== 'test') {
  const _path = require('path');
  require('dotenv').config({ path: _path.resolve(__dirname, '..', '.env'), override: false });
}

const { getBudgetCap, evaluateCap, KEYS } = require('../lib/tenantSettings');

const INTEGRATION = 'image-llm'; // S73: separate envelope from text-LLM (DALL-E HD $0.12/image)
const TASK_NAME = 'marketing-flyer-image'; // PRD FR-3.6.3
const MODEL_PRIMARY = 'dall-e-3'; // OpenAI DALL-E 3 — spec / PRD primary
// Auto-fallback when OpenAI says "model does not exist" (project keys no
// longer have dall-e-3 access — gpt-image-1 is the live successor).
// Env-overridable: `LLM_MODEL_OPENAI_IMAGE=...` in backend/.env wins.
const MODEL_PRIMARY_FALLBACK = 'gpt-image-1';
const MODEL_FALLBACK = 'stability-xl'; // Stability AI XL
const OPENAI_KEY_ENV = 'OPENAI_API_KEY'; // DALL-E provider
const STABILITY_KEY_ENV = 'STABILITY_API_KEY'; // Stability fallback provider

// Allowed aspect ratios — matches the canvas-editor's flyer presets.
// Real-mode will validate against this list before dispatching (DALL-E 3
// rejects arbitrary ratios; Stability accepts but quality degrades).
const ALLOWED_ASPECT_RATIOS = ['1:1', '9:16', '16:9'];
const DEFAULT_ASPECT_RATIO = '1:1';

// Touch KEYS so the imported binding isn't flagged unused — also makes
// the canonical-keys dependency explicit for future readers grep-tracing
// the cap pattern across consumers.
void KEYS;

/**
 * Slugify a string for URL-safe filesystem-style paths in the stub URL.
 * Pure — used by buildStubImageUrl. Replaces non-alphanumeric runs with
 * a single dash, lowercases, trims dashes from the edges.
 */
function slugify(s) {
  if (!s || typeof s !== 'string') return 'unknown';
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown';
}

/**
 * Pre-call cap check. Returns evaluateCap envelope.
 * Throws { code: 'MARKETING_FLYER_IMAGE_BUDGET_EXCEEDED', spentCents, capCents }
 * if over cap.
 *
 * CJS self-mocking seam: calls `module.exports.computeMonthlySpendCents(...)`
 * via the exports indirection. Mirrors marketingFlyerCopyLLM (S15) +
 * callifiedClient / ratehawkClient / adsGptClient.
 */
async function checkBudgetCap(tenantId) {
  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly image-LLM spend cap reached for this tenant.');
    err.code = 'MARKETING_FLYER_IMAGE_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(
      `[marketingFlyerImageLLM] tenant ${tenantId} at ${Math.round(
        evaluation.percent * 100,
      )}% of monthly image-LLM cap ($${(spentCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)})`,
    );
  }
  return evaluation;
}

/**
 * Sum month-to-date LLM spend in cents. STUB: returns 0 (the real spend
 * lives in LlmCallLog and is summed by lib/llmRouter.computeMonthlySpendCents;
 * we could call across but keeping this stub-local mirrors the other cap
 * consumers and avoids a circular dep when real-mode lands).
 *
 * Real-mode TODO: either delegate to llmRouter's computeMonthlySpendCents
 * (single source of truth for LLM spend) OR sum the same LlmCallLog rows
 * here filtered by task='marketing-flyer-image' if image-cap-split lands.
 */
async function computeMonthlySpendCents(_tenantId) {
  // STUB: zero spend. Real-mode swap = call lib/llmRouter's helper.
  return 0;
}

/**
 * Build the deterministic stub image URL. Pure function — same inputs
 * always render the same output. Used both as the no-creds fallback AND
 * as the fail-soft path when the real provider call errors.
 *
 * Shape per slice spec (verbatim):
 *   `[STUB-FLYER-IMAGE] /static/placeholders/flyer/<destSlug>/<themeTag>-<aspectRatio>.jpg`
 *
 * The `[STUB-FLYER-IMAGE]` prefix is visible to operators so they don't
 * mistake a placeholder image for real creative output. Same discipline
 * as marketingFlyerCopyLLM's `[STUB]` markers.
 */
function buildStubImageUrl({ destination, themeJson, aspectRatio }) {
  const destSlug = slugify(destination || 'destination');
  // Theme tag derivation mirrors marketingFlyerCopyLLM — accept object
  // (first key wins) or string.
  let themeTag = 'general';
  if (themeJson && typeof themeJson === 'object' && !Array.isArray(themeJson)) {
    const keys = Object.keys(themeJson);
    if (keys.length > 0) themeTag = slugify(String(keys[0]));
  } else if (typeof themeJson === 'string' && themeJson.trim()) {
    themeTag = slugify(themeJson);
  }
  const ratio = ALLOWED_ASPECT_RATIOS.includes(aspectRatio)
    ? aspectRatio
    : DEFAULT_ASPECT_RATIO;
  // Use a colon-free representation in the path (filesystem-safe across
  // POSIX + Windows; the canvas editor reads as URL fragment).
  const ratioToken = ratio.replace(':', 'x');
  return `[STUB-FLYER-IMAGE] /static/placeholders/flyer/${destSlug}/${themeTag}-${ratioToken}.jpg`;
}

/**
 * Resolve which provider has a key available. Returns one of:
 *   - { provider: 'dalle',     model: 'dall-e-3',     keySource: 'env' | 'tenant' }
 *   - { provider: 'stability', model: 'stability-xl', keySource: 'env' | 'tenant' }
 *   - null   (no key for either provider)
 *
 * Priority: DALL-E 3 first (primary per PRD §9.1 routing extension),
 * Stability second (fallback). Per-tenant SupplierCredential resolution
 * is sketched for the post-S45 follow-up — for v1, ENV only.
 *
 * Async to match S15's contract (lets the future SupplierCredential
 * lookup land without an additional contract flip).
 */
async function resolveProvider(_tenantId) {
  // Real-mode TODO (post-Q-MF-2 + S45-style follow-up): per-tenant
  // SupplierCredential lookup via lib/llmRouter.getLlmKey or a sibling
  // `getImageKey()`. For now: ENV only.
  const openaiKey = process.env[OPENAI_KEY_ENV];
  if (openaiKey) {
    return { provider: 'dalle', model: MODEL_PRIMARY, keySource: 'env' };
  }
  const stabilityKey = process.env[STABILITY_KEY_ENV];
  if (stabilityKey) {
    return { provider: 'stability', model: MODEL_FALLBACK, keySource: 'env' };
  }
  return null;
}

/**
 * Whether the real provider call should fire. Wraps the provider probe
 * so tests can `vi.spyOn(client, 'realModeEnabled').mockResolvedValue(true)`
 * without setting the env directly.
 *
 * Async since inception (matches S15 / S45 contract).
 *
 * @param {number} [tenantId]
 * @returns {Promise<boolean>}
 */
async function realModeEnabled(tenantId) {
  const resolved = await module.exports.resolveProvider(tenantId);
  return Boolean(resolved);
}

/**
 * Attempt a real image-gen call. STUB: real-mode wire-in is gated on
 * Q-MF-2 (image API key) arriving — until then, this function is
 * unreachable in practice (realModeEnabled() resolves false absent a
 * key). The scaffold is present so the swap-in is a single-file edit
 * when keys land.
 *
 * Contract: returns `{ imageUrl, provider, model }` matching the
 * envelope's source/model fields (caller injects `source` and `stub`).
 *
 * Throws on any error — caller falls through to the stub via try/catch.
 */
async function callImageProvider({ destination, subBrand, themeJson, aspectRatio, provider, model, tenantId }) {
  if (provider !== 'dalle') {
    throw new Error(`marketingFlyerImageLLM: provider '${provider}' not implemented (only 'dalle' wired)`);
  }
  const apiKey = process.env[OPENAI_KEY_ENV];
  if (!apiKey) {
    throw new Error(`marketingFlyerImageLLM: ${OPENAI_KEY_ENV} not set`);
  }
  // Resolve actual model: env override > caller-supplied > module default.
  const firstModel = process.env.LLM_MODEL_OPENAI_IMAGE || model || MODEL_PRIMARY;
  const ratio = ALLOWED_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : DEFAULT_ASPECT_RATIO;
  const themeStr = themeJson && typeof themeJson === 'object'
    ? Object.values(themeJson).filter(Boolean).join(', ')
    : (themeJson || '');
  const prompt = [
    `Travel marketing flyer hero image for ${destination}.`,
    subBrand ? `Sub-brand: ${subBrand}.` : '',
    themeStr ? `Theme: ${themeStr}.` : '',
    'Vibrant, professional, on-brand travel photography style. No text overlays.',
  ].filter(Boolean).join(' ');

  // Single attempt against OpenAI for a given model. Returns the parsed
  // body envelope on success; throws on HTTP failure. The aspect-ratio
  // size map differs per model:
  //   - dall-e-3:    1024x1024 / 1024x1792 / 1792x1024
  //   - gpt-image-1: 1024x1024 / 1024x1536 / 1536x1024
  // NOTE: `response_format` is NOT sent — OpenAI deprecated it on
  // /images/generations when gpt-image-1 launched. DALL-E 3 returns
  // data[0].url by default; gpt-image-1 returns data[0].b64_json. Both
  // shapes are handled by the caller below.
  const tryOpenAI = async (modelName) => {
    const isGptImage1 = /gpt-image/i.test(modelName);
    const sizeMap = isGptImage1
      ? { '1:1': '1024x1024', '9:16': '1024x1536', '16:9': '1536x1024' }
      : { '1:1': '1024x1024', '9:16': '1024x1792', '16:9': '1792x1024' };
    const size = sizeMap[ratio];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let resp;
    let bodyJson;
    try {
      resp = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: modelName, prompt, size, n: 1 }),
        signal: ctrl.signal,
      });
      bodyJson = await resp.json().catch(() => ({}));
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const msg = (bodyJson && bodyJson.error && (bodyJson.error.message || bodyJson.error)) || resp.statusText;
      const err = new Error(`${resp.status} ${msg}`);
      err.openaiStatus = resp.status;
      err.openaiMessage = msg;
      throw err;
    }
    return bodyJson;
  };

  // Auto-fallback: if the primary model returns "model does not exist"
  // (happens on every project key created after OpenAI's image-model
  // migration retired dall-e-3 for new keys), silently retry once with
  // gpt-image-1. Keeps MODEL_PRIMARY pinned to dall-e-3 (spec/tests
  // pin that constant) while still producing real output in production.
  let body;
  try {
    body = await tryOpenAI(firstModel);
  } catch (e) {
    const looksLikeModelMissing =
      e.openaiStatus === 404 ||
      /does not exist/i.test(e.openaiMessage || e.message || '') ||
      /unknown model/i.test(e.openaiMessage || e.message || '');
    if (looksLikeModelMissing && firstModel !== MODEL_PRIMARY_FALLBACK) {
      console.warn(
        `[marketingFlyerImageLLM] model '${firstModel}' rejected by OpenAI — retrying with '${MODEL_PRIMARY_FALLBACK}'`,
      );
      body = await tryOpenAI(MODEL_PRIMARY_FALLBACK);
    } else {
      throw e;
    }
  }

  const datum = body && body.data && body.data[0];
  if (!datum) {
    throw new Error('marketingFlyerImageLLM: OpenAI response missing data[0]');
  }
  let imageUrl;
  if (datum.url) {
    imageUrl = datum.url;
  } else if (datum.b64_json) {
    // gpt-image-1 returns base64. A 1024×1024 PNG ≈ 1.4 MB base64 — far
    // too large to embed in a template's layoutJson (TEXT column caps at
    // 64 KB and triggers a save-template 500). Persist to local uploads
    // (or S3 if configured) and return a normal URL instead. Mirrors the
    // existing /api/travel/flyer-templates/upload storage logic so the
    // operational footprint stays identical.
    imageUrl = await persistBase64Image(datum.b64_json, tenantId);
  } else {
    throw new Error('marketingFlyerImageLLM: OpenAI response missing both url and b64_json');
  }
  // Report back the model that actually answered (after any auto-fallback).
  return { imageUrl, provider: 'dalle', model: body.model || firstModel };
}

/**
 * Decode a base64 PNG payload and persist it to S3 (when
 * AWS_S3_BUCKET_NAME is configured) or to the local uploads dir
 * (dev/demo fallback). Returns the public URL or relative path the
 * frontend's <img src> can render.
 *
 * Tenant scoping: writes under flyer-assets/tenant-<id>/ for
 * traceability and so cleanup scripts can scope to one tenant.
 * Defaults tenantId to 0 if absent (shouldn't happen in practice — the
 * route always supplies it via generateFlyerImage).
 */
async function persistBase64Image(b64, tenantId) {
  const buffer = Buffer.from(b64, 'base64');
  const tid = tenantId || 0;
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const fileName = `ai-flyer-${stamp}-${rand}.png`;
  try {
    const s3 = require('./s3Service');
    if (s3 && s3.BUCKET_NAME) {
      return await s3.uploadImage(buffer, fileName, 'image/png', `flyer-assets/tenant-${tid}`);
    }
  } catch (e) {
    console.warn(`[marketingFlyerImageLLM] S3 upload failed, falling back to local disk: ${e.message}`);
  }
  // Local-disk fallback. Path mirrors the existing flyer-templates/upload
  // route at travel_flyer_templates.js so the static-file server picks it
  // up at /uploads/flyer-assets/tenant-<id>/<name>.
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'uploads', 'flyer-assets', `tenant-${tid}`);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, fileName), buffer);
  return `/uploads/flyer-assets/tenant-${tid}/${fileName}`;
}

/**
 * Primary surface: generate a flyer image.
 *
 * @param {Object} args
 * @param {number|string} args.tenantId        — required for the budget cap
 * @param {string} args.destination            — free-text destination (e.g. "Greece", "Bali")
 * @param {string} [args.subBrand]             — 'tmc' | 'rfu' | 'travelstall' | 'visasure'
 * @param {Object|string} [args.themeJson]     — trip type / season / vibe hints
 * @param {string} [args.aspectRatio]          — '1:1' | '9:16' | '16:9' (default '1:1')
 * @param {Object} [_ctx]                      — { prisma } context (currently unused;
 *                                                reserved for future per-tenant key /
 *                                                SupplierCredential lookup post-S45)
 *
 * @returns {Promise<{
 *   imageUrl: string,
 *   source:   'stub' | 'dalle' | 'stability',
 *   model:    string,
 *   stub:     boolean,
 * }>}
 */
async function generateFlyerImage(args = {}, _ctx = {}) {
  const { tenantId, destination, subBrand, themeJson, aspectRatio } = args;

  if (!tenantId) {
    throw new Error('tenantId required');
  }
  if (!destination || typeof destination !== 'string' || !destination.trim()) {
    throw new Error('destination required');
  }

  // Pre-call cap check via the self-mocking seam.
  await module.exports.checkBudgetCap(tenantId);

  // STUB observability log (matches marketingFlyerCopyLLM / adsGptClient
  // format). Token / bytes counts not measured in stub mode.
  console.log(
    `[marketingFlyerImageLLM STUB] generateFlyerImage called: tenantId=${tenantId} destination=${destination || '?'} subBrand=${subBrand || '?'} aspectRatio=${aspectRatio || DEFAULT_ASPECT_RATIO}`,
  );

  // Real-mode dispatch — try the provider call; fall through to stub on
  // any error or when no provider key is present.
  let realModeError = null;
  if (await module.exports.realModeEnabled(tenantId)) {
    try {
      const resolved = await module.exports.resolveProvider(tenantId);
      const realResult = await module.exports.callImageProvider({
        destination,
        subBrand,
        themeJson,
        aspectRatio,
        provider: resolved.provider,
        model: resolved.model,
        tenantId, // needed so persistBase64Image scopes to this tenant
      });
      return {
        imageUrl: realResult.imageUrl,
        source: realResult.provider, // 'dalle' | 'stability'
        model: realResult.model,
        stub: false,
      };
    } catch (e) {
      // Fail-soft: never break the operator UX on a provider hiccup.
      // Capture the message so the route can pass it through to the
      // frontend (which shows it as an error toast instead of silently
      // inserting an unreachable [STUB-FLYER-IMAGE] URL into the canvas).
      realModeError = e.message || String(e);
      console.error(
        `[marketingFlyerImageLLM] real-mode call failed (falling through to stub): ${realModeError}`,
      );
    }
  }

  const imageUrl = buildStubImageUrl({ destination, themeJson, aspectRatio });
  return {
    imageUrl,
    source: 'stub',
    model: MODEL_PRIMARY,
    stub: true,
    realModeError, // null when stub was deliberate (no key), string when real-mode tried + failed
  };
}

module.exports = {
  // Primary surface
  generateFlyerImage,
  // Budget-cap surface (mirrors marketingFlyerCopyLLM /
  // adsGptClient / ratehawkClient / callifiedClient)
  checkBudgetCap,
  computeMonthlySpendCents,
  // Real-mode probe + dispatch (exported for vi.spyOn in tests)
  realModeEnabled,
  resolveProvider,
  callImageProvider,
  // Stub builder exported for test-side determinism pins
  buildStubImageUrl,
  // Utility exported for test pins
  slugify,
  // Constants for cross-module references + test pins
  INTEGRATION,
  TASK_NAME,
  MODEL_PRIMARY,
  MODEL_FALLBACK,
  OPENAI_KEY_ENV,
  STABILITY_KEY_ENV,
  ALLOWED_ASPECT_RATIOS,
  DEFAULT_ASPECT_RATIO,
};
