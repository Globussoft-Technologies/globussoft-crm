const https = require("https");

const GRAPH_API_VERSION = "v18.0";

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

module.exports = { sendTemplate, sendText, verifyWebhook };
