const https = require("https");
const http = require("http");

/**
 * Normalize phone number — strip non-digits, prepend 91 for 10-digit Indian numbers
 */
function normalizePhone(phone) {
  if (!phone) return "";
  let digits = phone.toString().replace(/\D/g, "");
  if (digits.length === 10) {
    digits = "91" + digits;
  }
  return digits;
}

/**
 * Substitute template variables: {{name}}, {{company}}, {{email}}, {{phone}}
 */
function substituteVars(template, contact) {
  if (!template) return "";
  if (!contact) return template;
  return template
    .replace(/\{\{name\}\}/g, contact.name || contact.firstName || "")
    .replace(/\{\{company\}\}/g, contact.company || "")
    .replace(/\{\{email\}\}/g, contact.email || "")
    .replace(/\{\{phone\}\}/g, contact.phone || "");
}

/**
 * Send SMS via MSG91, Twilio, or Fast2SMS
 * @param {Object} opts
 * @param {string} opts.to - Recipient phone number
 * @param {string} opts.body - Message body
 * @param {string} opts.provider - "msg91" | "twilio" | "fast2sms"
 * @param {string} opts.apiKey - Provider API key
 * @param {string} opts.senderId - Sender ID (Twilio: from-number; Fast2SMS: 6-char ID like "FSTSMS")
 * @param {string} [opts.authToken] - Twilio auth token
 * @param {string} [opts.dltTemplateId] - Required for Fast2SMS DLT route (production India SMS)
 * @returns {Promise<{success: boolean, providerMsgId?: string, error?: string}>}
 */
async function sendSms({ to, body, provider, apiKey, senderId, authToken, dltTemplateId }) {
  const normalizedTo = normalizePhone(to);

  if (provider === "msg91") {
    return sendViaMSG91({ to: normalizedTo, body, apiKey, senderId });
  } else if (provider === "twilio") {
    return sendViaTwilio({ to: normalizedTo, body, accountSid: apiKey, authToken, from: senderId });
  } else if (provider === "fast2sms") {
    return sendViaFast2SMS({ to: normalizedTo, body, apiKey, senderId, dltTemplateId });
  } else {
    return { success: false, error: `Unsupported SMS provider: ${provider}` };
  }
}

/**
 * Send SMS via MSG91 Flow API
 */
function sendViaMSG91({ to, body, apiKey, senderId }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      sender: senderId,
      route: "4",
      country: "91",
      sms: [
        {
          message: body,
          to: [to],
        },
      ],
    });

    const options = {
      hostname: "api.msg91.com",
      path: "/api/v5/flow/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authkey: apiKey,
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "success" || parsed.type === "ok" || res.statusCode < 300) {
            resolve({
              success: true,
              providerMsgId: parsed.request_id || parsed.message || null,
            });
          } else {
            resolve({
              success: false,
              error: parsed.message || parsed.msg || JSON.stringify(parsed),
            });
          }
        } catch {
          resolve({
            success: res.statusCode < 300,
            providerMsgId: null,
            error: res.statusCode >= 300 ? data : undefined,
          });
        }
      });
    });

    req.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Send SMS via Twilio REST API
 */
function sendViaTwilio({ to, body, accountSid, authToken, from }) {
  return new Promise((resolve) => {
    const formattedTo = to.startsWith("+") ? to : "+" + to;
    const formattedFrom = from.startsWith("+") ? from : "+" + from;

    const params = new URLSearchParams();
    params.append("To", formattedTo);
    params.append("From", formattedFrom);
    params.append("Body", body);
    const payload = params.toString();

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    const options = {
      hostname: "api.twilio.com",
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${auth}`,
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode < 300 && parsed.sid) {
            resolve({ success: true, providerMsgId: parsed.sid });
          } else {
            resolve({
              success: false,
              error: parsed.message || parsed.error_message || JSON.stringify(parsed),
            });
          }
        } catch {
          resolve({
            success: false,
            error: data || `HTTP ${res.statusCode}`,
          });
        }
      });
    });

    req.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Send SMS via Fast2SMS (fast2sms.com) — Indian SMS gateway.
 *
 * Uses the `q` (Quick SMS) route by default, which doesn't require DLT
 * registration and is suitable for OTPs, appointment reminders on dev
 * accounts, and all non-bulk wellness flows. For true bulk marketing SMS
 * in production, pass `dltTemplateId` and the route flips to `dlt`.
 *
 * Fast2SMS requires 10-digit Indian numbers WITHOUT the "91" country code
 * (the opposite of MSG91). We strip the "91" here before hitting the API.
 *
 * API docs: https://docs.fast2sms.com/
 */
function sendViaFast2SMS({ to, body, apiKey, senderId, dltTemplateId }) {
  return new Promise((resolve) => {
    // Fast2SMS wants 10-digit numbers. normalizePhone() prepends 91 — strip it.
    const digits = (to || "").replace(/\D/g, "");
    const last10 = digits.length > 10 ? digits.slice(-10) : digits;
    if (last10.length !== 10) {
      return resolve({ success: false, error: `Fast2SMS needs 10-digit Indian number, got "${to}"` });
    }

    const useDlt = Boolean(dltTemplateId);
    const payload = {
      route: useDlt ? "dlt" : "q",
      message: body,
      numbers: last10,
      language: "english",
      flash: 0,
      sender_id: senderId || "FSTSMS",
    };
    if (useDlt) payload.template_id = dltTemplateId;
    const bodyStr = JSON.stringify(payload);

    const options = {
      hostname: "www.fast2sms.com",
      path: "/dev/bulkV2",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: apiKey,
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          // Fast2SMS responds with { return: true|false, request_id, message: [...] }
          // Successful send: { return: true, request_id: "abc", message: ["Sent"] }
          // Failure:        { return: false, status_code: N, message: "..." }
          if (parsed.return === true && parsed.request_id) {
            resolve({ success: true, providerMsgId: String(parsed.request_id) });
          } else {
            const errMsg = Array.isArray(parsed.message) ? parsed.message.join("; ") : (parsed.message || `HTTP ${res.statusCode}`);
            resolve({ success: false, error: errMsg });
          }
        } catch {
          resolve({
            success: false,
            error: data || `HTTP ${res.statusCode}: unparseable response`,
          });
        }
      });
    });

    req.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    req.write(bodyStr);
    req.end();
  });
}

/**
 * Resolve an active SMS provider config for a tenant.
 *
 * Resolution order:
 *  1. Active row in `SmsConfig` table for the tenant (preferred — per-tenant)
 *  2. Env-var fallback — MSG91_AUTH_KEY + MSG91_SENDER_ID, then
 *     TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM, then
 *     FAST2SMS_API_KEY (+ optional FAST2SMS_SENDER_ID).
 *
 * Returns `null` when nothing is configured. Callers should treat that as
 * "fail the message immediately" rather than re-queueing — see issue #182.
 *
 * @param {Object} prisma - Prisma client
 * @param {number} tenantId
 * @returns {Promise<{provider:string,apiKey:string,senderId?:string,authToken?:string,source:'db'|'env'}|null>}
 */
async function resolveProviderConfig(prisma, tenantId) {
  try {
    const cfg = await prisma.smsConfig.findFirst({
      where: { isActive: true, tenantId },
    });
    if (cfg && cfg.apiKey) {
      return {
        provider: cfg.provider,
        apiKey: cfg.apiKey,
        senderId: cfg.senderId || "",
        authToken: cfg.authToken || "",
        source: "db",
      };
    }
  } catch (e) {
    // fall through to env-var resolution
  }

  if (process.env.MSG91_AUTH_KEY && process.env.MSG91_SENDER_ID) {
    return {
      provider: "msg91",
      apiKey: process.env.MSG91_AUTH_KEY,
      senderId: process.env.MSG91_SENDER_ID,
      source: "env",
    };
  }
  if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM
  ) {
    return {
      provider: "twilio",
      apiKey: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      senderId: process.env.TWILIO_FROM,
      source: "env",
    };
  }
  if (process.env.FAST2SMS_API_KEY) {
    return {
      provider: "fast2sms",
      apiKey: process.env.FAST2SMS_API_KEY,
      senderId: process.env.FAST2SMS_SENDER_ID || "FSTSMS",
      source: "env",
    };
  }
  return null;
}

module.exports = {
  normalizePhone,
  substituteVars,
  sendSms,
  sendViaFast2SMS,
  resolveProviderConfig,
};
