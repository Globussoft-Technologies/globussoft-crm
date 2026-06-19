// Pure helpers for the Gmail API integration (routes/gmail.js). No IO — no
// Prisma, no googleapis, no fetch — so the encode/parse logic is unit-testable
// in isolation and shared between the send path and the read/sync path.
//
//   buildRawMessage({from,to,cc,subject,text,html}) → base64url RFC-822 string
//       The exact shape gmail.users.messages.send expects in `requestBody.raw`.
//       Body is base64-encoded with `Content-Transfer-Encoding: base64` so it
//       carries UTF-8 safely; a non-ASCII Subject is RFC-2047 encoded-word.
//       html wins over text when both are supplied (single content type — a
//       multipart/alternative variant can be added later if needed).
//
//   parseGmailMessage(apiMsg) → { id, threadId, from, to, cc, subject, date,
//       snippet, labelIds, text, html, body }
//       Flattens a gmail.users.messages.get payload: pulls the standard
//       headers and decodes the text/plain (preferred) or text/html body part,
//       walking multipart trees recursively.
//
//   extractEmailAddress("Name <a@b.com>") → "a@b.com"  (lowercased, or null)
//       Used to match an inbound/outbound address back to a CRM Contact.

"use strict";

/**
 * RFC-2047 encoded-word for header values that contain non-ASCII characters
 * (e.g. a Subject with an emoji or accented text). ASCII passes through
 * unchanged so the common case stays human-readable on the wire.
 */
function encodeHeaderValue(value) {
  const str = String(value == null ? "" : value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, "utf8").toString("base64")}?=`;
}

/**
 * Build the base64url-encoded RFC-822 message for gmail.users.messages.send.
 *
 * Automatically chooses the right MIME structure:
 *   text only            → Content-Type: text/plain (single part)
 *   html only            → Content-Type: text/html  (single part)
 *   text + html          → multipart/alternative    (plain fallback + html)
 *   any of the above + attachments → multipart/mixed wrapping the body part
 *
 * @param {{
 *   from?:string, to:string, cc?:string, bcc?:string,
 *   subject?:string, text?:string, html?:string,
 *   attachments?:Array<{filename:string, mimeType:string, data:Buffer|string}>
 * }} opts
 * @returns {string} base64url string suitable for `requestBody.raw`
 */
function buildRawMessage(opts = {}) {
  const { from, to, cc, bcc, subject = "", text, html, attachments = [] } = opts;

  const hasText = typeof text === "string" && text.length > 0;
  const hasHtml = typeof html === "string" && html.length > 0;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

  // Standard envelope headers
  const hdrs = [];
  if (from) hdrs.push(`From: ${from}`);
  hdrs.push(`To: ${to || ""}`);
  if (cc) hdrs.push(`Cc: ${cc}`);
  if (bcc) hdrs.push(`Bcc: ${bcc}`);
  hdrs.push(`Subject: ${encodeHeaderValue(subject)}`);
  hdrs.push("MIME-Version: 1.0");

  // Deterministic-enough boundary — backend code, Date.now()/Math.random() are fine.
  const stamp = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;

  // Inner body section: single-part or multipart/alternative
  let bodyContentType, bodyEncoding, bodyContent, bodyIsMultipart;
  if (hasHtml && hasText) {
    const altBound = `alt_${stamp}`;
    const textPart = `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text, "utf8").toString("base64")}`;
    const htmlPart = `Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(html, "utf8").toString("base64")}`;
    bodyContentType = `multipart/alternative; boundary="${altBound}"`;
    bodyContent = `--${altBound}\r\n${textPart}\r\n\r\n--${altBound}\r\n${htmlPart}\r\n\r\n--${altBound}--`;
    bodyIsMultipart = true;
  } else if (hasHtml) {
    bodyContentType = 'text/html; charset="UTF-8"';
    bodyEncoding = "base64";
    bodyContent = Buffer.from(html, "utf8").toString("base64");
    bodyIsMultipart = false;
  } else {
    bodyContentType = 'text/plain; charset="UTF-8"';
    bodyEncoding = "base64";
    bodyContent = Buffer.from(hasText ? text : "", "utf8").toString("base64");
    bodyIsMultipart = false;
  }

  if (!hasAttachments) {
    // Simple: just the body part
    hdrs.push(`Content-Type: ${bodyContentType}`);
    if (!bodyIsMultipart) hdrs.push("Content-Transfer-Encoding: base64");
    const raw = `${hdrs.join("\r\n")}\r\n\r\n${bodyContent}`;
    return Buffer.from(raw, "utf8").toString("base64url");
  }

  // multipart/mixed: body + file attachments
  const mixBound = `mix_${stamp}`;
  hdrs.push(`Content-Type: multipart/mixed; boundary="${mixBound}"`);

  const parts = [];

  // First part is the body (text/plain, text/html, or multipart/alternative)
  if (bodyIsMultipart) {
    parts.push(`Content-Type: ${bodyContentType}\r\n\r\n${bodyContent}`);
  } else {
    parts.push(`Content-Type: ${bodyContentType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${bodyContent}`);
  }

  // Remaining parts are the file attachments
  for (const att of attachments) {
    const attData = Buffer.isBuffer(att.data)
      ? att.data.toString("base64")
      : typeof att.data === "string" ? att.data : "";
    const attMime = att.mimeType || "application/octet-stream";
    const attName = encodeHeaderValue(att.filename || "attachment");
    parts.push(
      `Content-Type: ${attMime}; name="${attName}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${attName}"\r\n\r\n${attData}`
    );
  }

  const mixBody = parts.map((p) => `--${mixBound}\r\n${p}`).join("\r\n\r\n") + `\r\n\r\n--${mixBound}--`;
  const raw = `${hdrs.join("\r\n")}\r\n\r\n${mixBody}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/**
 * Case-insensitive header lookup over a Gmail payload.headers array.
 */
function headerValue(headers, name) {
  if (!Array.isArray(headers)) return null;
  const lower = String(name).toLowerCase();
  const h = headers.find(
    (x) => x && typeof x.name === "string" && x.name.toLowerCase() === lower
  );
  return h && h.value != null ? h.value : null;
}

function decodeBodyData(data) {
  if (!data || typeof data !== "string") return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Walk a (possibly multipart) Gmail payload and pull the first text/plain and
 * first text/html body parts.
 */
function extractBody(payload) {
  let text = "";
  let html = "";
  const walk = (part) => {
    if (!part || typeof part !== "object") return;
    const mime = part.mimeType || "";
    const data = part.body && part.body.data;
    if (mime === "text/plain" && data && !text) text = decodeBodyData(data);
    else if (mime === "text/html" && data && !html) html = decodeBodyData(data);
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  };
  walk(payload);
  return { text, html };
}

/**
 * Flatten a gmail.users.messages.get response into a CRM-friendly shape.
 *
 * @param {object} apiMsg
 * @returns {object|null}
 */
function parseGmailMessage(apiMsg) {
  if (!apiMsg || typeof apiMsg !== "object") return null;
  const payload = apiMsg.payload || {};
  const headers = payload.headers || [];
  const { text, html } = extractBody(payload);
  const snippet = typeof apiMsg.snippet === "string" ? apiMsg.snippet : "";
  return {
    id: apiMsg.id || null,
    threadId: apiMsg.threadId || null,
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    cc: headerValue(headers, "Cc"),
    subject: headerValue(headers, "Subject"),
    date: headerValue(headers, "Date"),
    snippet,
    labelIds: Array.isArray(apiMsg.labelIds) ? apiMsg.labelIds : [],
    text,
    html,
    body: text || html || snippet || "",
  };
}

/**
 * Pull the bare address out of a "Display Name <addr@host>" header (or a raw
 * address). Lowercased. Returns null when no plausible address is present.
 */
function extractEmailAddress(headerVal) {
  if (!headerVal || typeof headerVal !== "string") return null;
  const angle = headerVal.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : headerVal).trim().toLowerCase();
  return /^\S+@\S+\.\S+$/.test(addr) ? addr : null;
}

module.exports = {
  encodeHeaderValue,
  buildRawMessage,
  headerValue,
  parseGmailMessage,
  extractEmailAddress,
};
