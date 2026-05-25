//
// Meta WhatsApp Cloud API — HTTP client.
//
// Existing exports (kept stable for backwards compatibility with callers in
// routes/whatsapp.js, the workflow engine, sequence engine, etc.):
//   - sendTemplate({ to, templateName, language, parameters, phoneNumberId, accessToken })
//   - sendText({ to, body, phoneNumberId, accessToken })
//   - verifyWebhook(req, verifyToken)
//
// New exports (P1+P3 scaffolding):
//   - downloadMediaUrl({ mediaId, accessToken })       resolves a Graph media URL
//   - downloadMediaBytes({ url, accessToken })         fetches the bytes
//   - sendImage / sendDocument                         (P3 send variants — stubs that
//                                                        return the same shape as sendText)
//
// GRAPH_API_VERSION is read from META_GRAPH_VERSION env at module load with a
// sane default. Bumping the version is a one-line env change + restart; we
// do not read per-request to avoid lookup overhead.

const https = require("https");

const GRAPH_API_VERSION = process.env.META_GRAPH_VERSION || "v22.0";

/**
 * Send a WhatsApp template message via Meta Cloud API
 * @param {Object} opts
 * @param {string} opts.to - Recipient phone number
 * @param {string} opts.templateName - Template name
 * @param {string} opts.language - Language code (e.g. "en_US")
 * @param {Array} [opts.parameters] - Template parameters array
 * @param {string} opts.phoneNumberId - Meta phone number ID
 * @param {string} opts.accessToken - Meta access token
 * @returns {Promise<{success: boolean, providerMsgId?: string, error?: string}>}
 */
function sendTemplate({ to, templateName, language, parameters, phoneNumberId, accessToken }) {
  const components = [];
  if (parameters && parameters.length > 0) {
    components.push({
      type: "body",
      parameters: parameters.map((p) => ({
        type: "text",
        text: String(p),
      })),
    });
  }

  const payload = {
    messaging_product: "whatsapp",
    to: to,
    type: "template",
    template: {
      name: templateName,
      language: { code: language || "en_US" },
    },
  };

  if (components.length > 0) {
    payload.template.components = components;
  }

  return postToMeta({ phoneNumberId, accessToken, payload });
}

/**
 * Send a WhatsApp text message (session message within 24h window)
 * @param {Object} opts
 * @param {string} opts.to - Recipient phone number
 * @param {string} opts.body - Message text
 * @param {string} opts.phoneNumberId - Meta phone number ID
 * @param {string} opts.accessToken - Meta access token
 * @returns {Promise<{success: boolean, providerMsgId?: string, error?: string}>}
 */
function sendText({ to, body, phoneNumberId, accessToken }) {
  const payload = {
    messaging_product: "whatsapp",
    to: to,
    type: "text",
    text: { body: body },
  };

  return postToMeta({ phoneNumberId, accessToken, payload });
}

/**
 * Send a WhatsApp image (P3 scaffold).
 * @param {Object} opts
 * @param {string} opts.to
 * @param {string} opts.linkOrId - public HTTPS URL or Meta media id
 * @param {string} [opts.caption]
 * @param {string} opts.phoneNumberId
 * @param {string} opts.accessToken
 */
function sendImage({ to, linkOrId, caption, phoneNumberId, accessToken }) {
  const image = linkOrId.startsWith("http") ? { link: linkOrId } : { id: linkOrId };
  if (caption) image.caption = caption;
  return postToMeta({
    phoneNumberId,
    accessToken,
    payload: { messaging_product: "whatsapp", to, type: "image", image },
  });
}

/**
 * Send a WhatsApp document (P3 scaffold).
 */
function sendDocument({ to, linkOrId, filename, caption, phoneNumberId, accessToken }) {
  const document = linkOrId.startsWith("http") ? { link: linkOrId } : { id: linkOrId };
  if (filename) document.filename = filename;
  if (caption) document.caption = caption;
  return postToMeta({
    phoneNumberId,
    accessToken,
    payload: { messaging_product: "whatsapp", to, type: "document", document },
  });
}

/**
 * POST to Meta Graph API messages endpoint
 */
function postToMeta({ phoneNumberId, accessToken, payload }) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);

    const options = {
      hostname: "graph.facebook.com",
      path: `/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode < 300 && parsed.messages && parsed.messages.length > 0) {
            resolve({
              success: true,
              providerMsgId: parsed.messages[0].id,
            });
          } else {
            const err =
              parsed.error?.message ||
              parsed.error?.error_user_msg ||
              JSON.stringify(parsed);
            resolve({ success: false, error: err });
          }
        } catch {
          resolve({ success: false, error: body || `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    req.write(data);
    req.end();
  });
}

/**
 * Verify Meta webhook subscription (GET request)
 * @param {Object} req - Express request object
 * @param {string} verifyToken - Expected verify token
 * @returns {{ verified: boolean, challenge?: string }}
 */
function verifyWebhook(req, verifyToken) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    return { verified: true, challenge };
  }
  return { verified: false };
}

/**
 * Resolve a Meta media id to a short-lived download URL.
 * Used by cron/whatsappMediaEngine.js.
 *
 * @param {{ mediaId: string, accessToken: string }} opts
 * @returns {Promise<{ url?: string, mimeType?: string, sizeBytes?: number, error?: string }>}
 */
function downloadMediaUrl({ mediaId, accessToken }) {
  return new Promise((resolve) => {
    const options = {
      hostname: "graph.facebook.com",
      path: `/${GRAPH_API_VERSION}/${mediaId}`,
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode < 300 && parsed.url) {
            resolve({ url: parsed.url, mimeType: parsed.mime_type, sizeBytes: parsed.file_size });
          } else {
            resolve({ error: parsed.error?.message || `HTTP ${res.statusCode}` });
          }
        } catch {
          resolve({ error: body || `HTTP ${res.statusCode}` });
        }
      });
    });
    req.on("error", (err) => resolve({ error: err.message }));
    req.end();
  });
}

/**
 * Download the actual media bytes from the Graph media URL. The URL is
 * already signed but Meta still requires the Bearer token on the request.
 *
 * @param {{ url: string, accessToken: string }} opts
 * @returns {Promise<Buffer>}
 */
function downloadMediaBytes({ url, accessToken }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    };
    const req = https.request(options, (res) => {
      // Meta media URLs often 302 to a CDN; follow once.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadMediaBytes({ url: res.headers.location, accessToken })
          .then(resolve)
          .catch(reject);
        return;
      }
      if (res.statusCode >= 400) {
        reject(new Error(`media bytes HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.end();
  });
}

// ────────────────────────────────────────────────────────────────────────
// P2 onboarding HTTP helpers
// ────────────────────────────────────────────────────────────────────────
//
// These are the Graph endpoints the embedded-signup flow hits. Each one
// returns { ok, data?, error? } so the orchestrator can branch cleanly.
// All accept an explicit accessToken so the same helpers work for the
// platform-level System User token AND per-tenant tokens depending on
// which Graph endpoint requires which.

function graphRequest({ method, path, accessToken, payload, query }) {
  return new Promise((resolve) => {
    const qs = query
      ? "?" + Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")
      : "";
    const body = payload ? JSON.stringify(payload) : null;
    const options = {
      hostname: "graph.facebook.com",
      path: `/${GRAPH_API_VERSION}${path}${qs}`,
      method,
      headers: {
        ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
        ...(body && { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
      },
    };
    const req = https.request(options, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { parsed = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, data: parsed, status: res.statusCode });
        } else {
          const msg = parsed?.error?.message || buf || `HTTP ${res.statusCode}`;
          resolve({ ok: false, error: msg, code: parsed?.error?.code, subcode: parsed?.error?.error_subcode, status: res.statusCode });
        }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Exchange a Meta OAuth code (from embedded signup) for an access token.
 * @param {{ code: string, appId: string, appSecret: string, redirectUri?: string }} opts
 */
function exchangeCode({ code, appId, appSecret, redirectUri }) {
  return graphRequest({
    method: "GET",
    path: "/oauth/access_token",
    query: {
      client_id: appId,
      client_secret: appSecret,
      code,
      ...(redirectUri && { redirect_uri: redirectUri }),
    },
  });
}

/**
 * Extend a short-lived access token into a longer-lived one (60d).
 * @param {{ token: string, appId: string, appSecret: string }} opts
 */
function extendToken({ token, appId, appSecret }) {
  return graphRequest({
    method: "GET",
    path: "/oauth/access_token",
    query: {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: token,
    },
  });
}

/**
 * Inspect a token — returns { is_valid, app_id, expires_at, scopes, ... }
 * Uses the app-access-token style auth: `<appId>|<appSecret>`.
 * @param {{ token: string, appId: string, appSecret: string }} opts
 */
function debugToken({ token, appId, appSecret }) {
  return graphRequest({
    method: "GET",
    path: "/debug_token",
    query: {
      input_token: token,
      access_token: `${appId}|${appSecret}`,
    },
  });
}

/**
 * Subscribe THIS app to a WhatsApp Business Account so Meta delivers
 * webhooks for this WABA's events to our configured callback URL.
 * @param {{ wabaId: string, accessToken: string }} opts
 */
function subscribeApp({ wabaId, accessToken }) {
  return graphRequest({
    method: "POST",
    path: `/${wabaId}/subscribed_apps`,
    accessToken,
  });
}

/**
 * Unsubscribe THIS app from a WABA — used by /onboard/disconnect.
 * @param {{ wabaId: string, accessToken: string }} opts
 */
function unsubscribeApp({ wabaId, accessToken }) {
  return graphRequest({
    method: "DELETE",
    path: `/${wabaId}/subscribed_apps`,
    accessToken,
  });
}

/**
 * Register a phone number for Cloud API messaging. Required before the
 * number can send via Graph API. The 6-digit PIN is a Two-Step
 * Verification PIN — Meta requires it but for first-time registrations a
 * fresh PIN is acceptable.
 * @param {{ phoneNumberId: string, accessToken: string, pin: string }} opts
 */
function registerPhone({ phoneNumberId, accessToken, pin }) {
  return graphRequest({
    method: "POST",
    path: `/${phoneNumberId}/register`,
    accessToken,
    payload: { messaging_product: "whatsapp", pin },
  });
}

/**
 * Fetch the list of phone numbers attached to a WABA.
 * @param {{ wabaId: string, accessToken: string }} opts
 */
function listPhoneNumbers({ wabaId, accessToken }) {
  return graphRequest({
    method: "GET",
    path: `/${wabaId}/phone_numbers`,
    accessToken,
    query: { fields: "id,display_phone_number,verified_name,quality_rating,name_status,code_verification_status" },
  });
}

/**
 * Fetch all approved templates for a WABA — used by templateSyncEngine.
 * @param {{ wabaId: string, accessToken: string, limit?: number }} opts
 */
function listTemplates({ wabaId, accessToken, limit }) {
  return graphRequest({
    method: "GET",
    path: `/${wabaId}/message_templates`,
    accessToken,
    query: {
      fields: "name,language,status,category,components,quality_score,rejected_reason,id",
      ...(limit && { limit }),
    },
  });
}

/**
 * Send a WhatsApp interactive message (buttons or list).
 * @param {{ to, type: 'button'|'list', body, header?, footer?, action, phoneNumberId, accessToken }} opts
 */
function sendInteractive({ to, type, body, header, footer, action, phoneNumberId, accessToken }) {
  const interactive = {
    type,
    body: { text: body },
    action,
  };
  if (header) interactive.header = header;
  if (footer) interactive.footer = { text: footer };
  return postToMeta({
    phoneNumberId,
    accessToken,
    payload: { messaging_product: "whatsapp", to, type: "interactive", interactive },
  });
}

module.exports = {
  sendTemplate,
  sendText,
  sendImage,
  sendDocument,
  sendInteractive,
  verifyWebhook,
  downloadMediaUrl,
  downloadMediaBytes,
  exchangeCode,
  extendToken,
  debugToken,
  subscribeApp,
  unsubscribeApp,
  registerPhone,
  listPhoneNumbers,
  listTemplates,
  graphRequest,
  GRAPH_API_VERSION,
};
