/**
 * Short-URL service for flyer attachments on the SMS channel (S87).
 *
 * Background — slice S87 closes the carry-over flagged by S19:
 *   The sequence-engine SMS branch resolves + audits flyer attachments
 *   but historically did NOT mutate the SMS body. SMS doesn't natively
 *   carry binary blobs, so the canonical pattern is to upload the
 *   rendered buffer somewhere durable and append a short URL to the
 *   message body. This module is the swap surface for that uploader.
 *
 * STUB MODE (default):
 *   Deterministic content-addressed URL —
 *     `https://stub-flyer.demo/<sha256-prefix>?t=<ttlSeconds>`
 *   The hash makes identical buffers collapse to the same URL (useful
 *   for caching + dedupe + idempotent test assertions). No network I/O.
 *
 * REAL MODE (later — gated on product call):
 *   `SHORT_URL_PROVIDER` env-var picks the provider implementation.
 *   Candidates (in priority order from the product brief):
 *     - 'bitly'      — third-party shortener, custom domain support
 *     - 'cloudflare' — CF Workers KV-backed link service
 *     - 'internal'   — backend-hosted /s/:slug endpoint with a TTL purge
 *
 * Until the decision lands, ANY non-stub value throws — the throw is the
 * operator signal that real-mode wiring is incomplete. The caller
 * (sequenceEngine SMS branch) catches the throw and fail-soft falls
 * through to plain SMS (no link appended) so an unimplemented provider
 * never blocks a sequence step from sending.
 *
 * Canonical return envelope (STUB + future REAL — same shape):
 *   {
 *     shortUrl: string,                       // the link to append to SMS body
 *     source: 'stub' | '<providerName>',      // which path produced it
 *     filename: string,                       // echoed input (descriptor aid)
 *     mimeType: string,                       // echoed input (descriptor aid)
 *   }
 *
 * Mirror clients (CJS self-mocking seam, cron-learning 2026-05-24 ~01:43 UTC):
 *   - backend/services/marketingFlyerCopyLLM.js (S15) — stub-mode pattern
 *   - backend/services/marketingFlyerImageLLM.js (S16) — stub-mode pattern
 *   - backend/services/tmcDiagnosticPrompts.js  (S99) — provider-swap surface
 *
 * Cred / decision chase:
 *   - docs/CREDS_TRACKER.md (Q-marker pending — short-URL provider pick)
 *   - paired follow-ups: S88 (WhatsApp channel parity) +
 *     TTL-honouring deletion cron (real-mode only)
 */

'use strict';

const crypto = require('crypto');

const STUB_BASE_URL = 'https://stub-flyer.demo';
const DEFAULT_TTL_SECONDS = 86400; // 24h — matches most short-URL services' default

/**
 * Resolve the currently-configured provider name. Lower-cased + trimmed
 * so `SHORT_URL_PROVIDER=Bitly`, `=bitly `, `=BITLY` all dispatch the
 * same way. Unset / blank / whitespace-only falls back to 'stub' so
 * dev + demo + CI just work without configuration.
 *
 * @returns {string} provider name ('stub' | 'bitly' | 'cloudflare' | 'internal' | …)
 */
function provider() {
  const raw = process.env.SHORT_URL_PROVIDER;
  if (typeof raw !== 'string') return 'stub';
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length === 0 ? 'stub' : trimmed;
}

/**
 * Build the deterministic stub URL. Pure function — same buffer always
 * renders the same URL. Used as the default no-creds path.
 *
 * The 12-char hash prefix keeps the URL readable while preserving
 * collision-resistance for the magnitudes a single tenant produces (a
 * single tenant ships < 10^6 flyers/year per PRD §10; 16^12 = 2.8 * 10^14
 * possible prefixes — collision probability is negligible).
 *
 * @param {Buffer} buffer       — the rendered flyer content
 * @param {number} ttlSeconds   — TTL hint (echoed in URL for visibility)
 * @returns {string}            — `https://stub-flyer.demo/<hash>?t=<ttl>`
 */
function buildStubUrl(buffer, ttlSeconds) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  return `${STUB_BASE_URL}/${hash}?t=${ttlSeconds}`;
}

/**
 * Primary surface: produce a short URL for the given attachment buffer.
 *
 * Stub mode returns synchronously-resolvable deterministic output; real
 * mode (once wired) will hit an external API and resolve asynchronously.
 * Async signature today so the call site doesn't have to change when
 * real-mode lands.
 *
 * @param {Object} args
 * @param {Buffer} args.buffer       — REQUIRED; the rendered flyer content
 * @param {string} [args.filename]   — descriptive (echoed in return envelope)
 * @param {string} [args.mimeType]   — descriptive (echoed in return envelope)
 * @param {number} [args.ttlSeconds] — TTL hint; defaults to 86400 (24h)
 *
 * @returns {Promise<{
 *   shortUrl: string,
 *   source: 'stub' | string,
 *   filename: string,
 *   mimeType: string,
 * }>}
 */
async function shortenUrl({ buffer, filename, mimeType, ttlSeconds } = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('shortenUrl: buffer (Buffer) is required');
  }
  const ttl =
    typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? Math.floor(ttlSeconds)
      : DEFAULT_TTL_SECONDS;
  const echoedFilename = typeof filename === 'string' && filename.length > 0 ? filename : 'attachment';
  const echoedMimeType = typeof mimeType === 'string' && mimeType.length > 0 ? mimeType : 'application/octet-stream';

  // Resolve via module.exports indirection — CJS self-mocking seam so
  // vitest can `engine.provider = vi.fn(...)` to flip provider per test
  // without touching process.env.
  const providerName = module.exports.provider();

  if (providerName === 'stub') {
    return {
      shortUrl: buildStubUrl(buffer, ttl),
      source: 'stub',
      filename: echoedFilename,
      mimeType: echoedMimeType,
    };
  }

  // Real-mode providers land here. For now, throw so an operator who
  // sets SHORT_URL_PROVIDER without a backing implementation gets a
  // clear, fail-loud signal. The SMS branch in sequenceEngine catches
  // this and fail-soft falls through to no-link SMS — see test
  // `shortenUrl throws → SMS still sends, audit logs the failure`.
  throw new Error(`shortenUrl: provider '${providerName}' not implemented`);
}

module.exports = {
  shortenUrl,
  provider,
  buildStubUrl,
  STUB_BASE_URL,
  DEFAULT_TTL_SECONDS,
};
