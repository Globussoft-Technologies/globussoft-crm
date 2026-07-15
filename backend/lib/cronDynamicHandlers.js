/**
 * cronDynamicHandlers.js — Super Admin Portal / Cron Maintenance.
 *
 * Fixed, safe handler types for admin-created dynamic crons (CronConfig
 * rows with isSystem:false). There is NO arbitrary-code-execution path —
 * an admin picks a handlerKey from this fixed list and supplies JSON
 * metadata; the handler interprets that data, it never evals/requires it.
 *
 * Adding a new handler type = add one entry here + one UI option. This is
 * the intentional ceiling on "what a dynamic cron can do" — anything
 * requiring real business logic should become a proper cron/*.js engine
 * registered via cronRegistry.register() instead (see docs at the top of
 * lib/cronRegistry.js), not a dynamic handler.
 */

'use strict';

const HANDLERS = {
  // Pings an arbitrary URL on schedule. Useful for keep-alive pings,
  // triggering an external system's own cron via webhook, etc.
  // metadata: { url: string, method?: 'GET'|'POST', bodyJson?: string, headersJson?: string }
  http_webhook_ping: {
    label: "HTTP Webhook Ping",
    description: "Pings an arbitrary URL on schedule. Useful for keep-alive pings or triggering external webhooks.",
    metadataSchema: { url: "string (required)", method: "'GET'|'POST' (default POST)", bodyJson: "string", headersJson: "string" },
    fn: async function httpWebhookPing(metadata) {
      const { url, method = 'POST', bodyJson, headersJson } = metadata || {};
    if (!url || typeof url !== 'string') {
      throw new Error('http_webhook_ping requires metadata.url');
    }
    // Guard against pinging internal/private infra from a public-facing
    // "Create Cron" form — same class of concern as an SSRF guard.
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`http_webhook_ping: metadata.url is not a valid URL: ${url}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`http_webhook_ping: unsupported protocol ${parsed.protocol}`);
    }
    // URL.hostname KEEPS the brackets for an IPv6 literal (e.g. "[::1]"),
    // unlike most other hostname APIs — both forms are listed so a bracketed
    // or unbracketed literal is caught either way.
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];
    if (blockedHosts.includes(parsed.hostname)) {
      throw new Error(`http_webhook_ping: refusing to ping internal host ${parsed.hostname}`);
    }

    let headers = { 'content-type': 'application/json' };
    if (headersJson) {
      try {
        headers = { ...headers, ...JSON.parse(headersJson) };
      } catch {
        throw new Error('http_webhook_ping: metadata.headersJson is not valid JSON');
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: method === 'GET' ? undefined : (bodyJson || '{}'),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        throw new Error(`http_webhook_ping: ${url} responded ${resp.status}`);
      }
      return { ok: true, status: resp.status };
    } finally {
      clearTimeout(timer);
    }
    },
  },

  // No-op handler that just logs — useful for verifying the scheduler
  // itself works (create one, watch it fire, check the Cron Logs screen)
  // without needing any external dependency.
  // metadata: { message?: string }
  log_note: {
    label: "Log Note (test/no-op)",
    description: "Logs a message to the console on every tick. Useful for verifying the scheduler without external dependencies.",
    metadataSchema: { message: "string (optional)" },
    fn: async function logNote(metadata) {
      const message = (metadata && metadata.message) || '(no message)';
      console.log(`[cronDynamicHandlers:log_note] ${message}`);
      return { ok: true, message };
    },
  },
};

const VALID_HANDLER_KEYS = Object.keys(HANDLERS);

function isValidHandlerKey(key) {
  return VALID_HANDLER_KEYS.includes(key);
}

function getHandler(key) {
  return HANDLERS[key] || null;
}

function getHandlerCatalog() {
  return VALID_HANDLER_KEYS.map((key) => {
    const h = HANDLERS[key];
    return {
      key,
      label: h.label || key,
      description: h.description || "",
      metadataSchema: h.metadataSchema || {},
    };
  });
}

/**
 * Build a tickFn for a dynamic CronConfig row — parses metadataJson once
 * (at build time, not per-tick) so a malformed JSON fails fast at
 * registration instead of silently no-op-ing on every tick.
 */
function buildDynamicTickFn(handlerKey, metadataJson) {
  const handlerEntry = HANDLERS[handlerKey];
  if (!handlerEntry) {
    throw new Error(`Unknown handlerKey: ${handlerKey}`);
  }
  const handler = handlerEntry.fn;
  if (typeof handler !== 'function') {
    throw new Error(`Handler ${handlerKey} does not expose a callable fn`);
  }
  let metadata = {};
  if (metadataJson) {
    try {
      metadata = JSON.parse(metadataJson);
    } catch {
      throw new Error('metadataJson is not valid JSON');
    }
  }
  return () => handler(metadata);
}

module.exports = {
  HANDLERS,
  VALID_HANDLER_KEYS,
  isValidHandlerKey,
  getHandler,
  getHandlerCatalog,
  buildDynamicTickFn,
};
