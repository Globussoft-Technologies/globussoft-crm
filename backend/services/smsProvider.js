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
 * Send SMS via MSG91 or Twilio
 * @param {Object} opts
 * @param {string} opts.to - Recipient phone number
 * @param {string} opts.body - Message body
 * @param {string} opts.provider - "msg91" or "twilio"
 * @param {string} opts.apiKey - Provider API key (MSG91 authkey or Twilio Account SID)
 * @param {string} opts.senderId - Sender ID (MSG91) or Twilio phone number
 * @param {string} [opts.authToken] - Twilio auth token
 * @returns {Promise<{success: boolean, providerMsgId?: string, error?: string}>}
 */
async function sendSms({ to, body, provider, apiKey, senderId, authToken }) {
  const normalizedTo = normalizePhone(to);

  if (provider === "msg91") {
    return sendViaMSG91({ to: normalizedTo, body, apiKey, senderId });
  } else if (provider === "twilio") {
    return sendViaTwilio({ to: normalizedTo, body, accountSid: apiKey, authToken, from: senderId });
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

module.exports = { normalizePhone, substituteVars, sendSms };
