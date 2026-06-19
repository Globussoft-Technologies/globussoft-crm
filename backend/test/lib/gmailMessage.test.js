// Unit tests for backend/lib/gmailMessage.js — the pure encode/parse helpers
// behind routes/gmail.js. No Prisma, no googleapis: we exercise the RFC-822
// build (send path) and the payload flatten (read path) directly.

import { describe, it, expect } from "vitest";
import {
  encodeHeaderValue,
  buildRawMessage,
  headerValue,
  parseGmailMessage,
  extractEmailAddress,
} from "../../lib/gmailMessage.js";

// Decode a base64url raw message back to its RFC-822 string + split the
// (base64-encoded) body so tests can assert on both halves.
function decodeRaw(raw) {
  const rfc822 = Buffer.from(raw, "base64url").toString("utf8");
  const [head, ...rest] = rfc822.split("\r\n\r\n");
  const bodyB64 = rest.join("\r\n\r\n");
  const body = Buffer.from(bodyB64, "base64").toString("utf8");
  return { rfc822, head, body };
}

describe("encodeHeaderValue", () => {
  it("passes ASCII through unchanged", () => {
    expect(encodeHeaderValue("Your trip is confirmed")).toBe("Your trip is confirmed");
  });

  it("RFC-2047 encoded-words non-ASCII (emoji / accents)", () => {
    const out = encodeHeaderValue("Booking ✈ confirmé");
    expect(out.startsWith("=?UTF-8?B?")).toBe(true);
    expect(out.endsWith("?=")).toBe(true);
    // round-trips back to the original
    const b64 = out.slice("=?UTF-8?B?".length, -2);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("Booking ✈ confirmé");
  });

  it("coerces null/undefined to empty string", () => {
    expect(encodeHeaderValue(null)).toBe("");
    expect(encodeHeaderValue(undefined)).toBe("");
  });
});

describe("buildRawMessage", () => {
  it("produces base64url with the expected headers and a text body", () => {
    const raw = buildRawMessage({
      from: "agent@travelstall.in",
      to: "client@example.com",
      subject: "Hello",
      text: "See you soon",
    });
    const { head, body } = decodeRaw(raw);
    expect(head).toContain("From: agent@travelstall.in");
    expect(head).toContain("To: client@example.com");
    expect(head).toContain("Subject: Hello");
    expect(head).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(head).toContain("MIME-Version: 1.0");
    expect(body).toBe("See you soon");
  });

  it("builds multipart/alternative when both text and html are supplied", () => {
    const raw = buildRawMessage({
      to: "c@example.com",
      subject: "Hi",
      text: "plain version",
      html: "<b>rich version</b>",
    });
    // For multipart, decode the entire RFC-822 string rather than using decodeRaw
    // (which expects a base64-encoded single-part body).
    const rfc822 = Buffer.from(raw, "base64url").toString("utf8");
    expect(rfc822).toMatch(/Content-Type: multipart\/alternative; boundary="/);
    // Each MIME part body is base64 — check the encoded form of each literal
    expect(rfc822).toContain(Buffer.from("plain version", "utf8").toString("base64"));
    expect(rfc822).toContain(Buffer.from("<b>rich version</b>", "utf8").toString("base64"));
  });

  it("uses single text/html when html is given without text", () => {
    const raw = buildRawMessage({ to: "c@example.com", subject: "Hi", html: "<b>rich</b>" });
    const { head, body } = decodeRaw(raw);
    expect(head).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(body).toBe("<b>rich</b>");
  });

  it("includes Cc when provided and omits From/Cc when absent", () => {
    const withCc = decodeRaw(buildRawMessage({ to: "a@x.com", cc: "b@x.com", text: "x" }));
    expect(withCc.head).toContain("Cc: b@x.com");

    const noFromNoCc = decodeRaw(buildRawMessage({ to: "a@x.com", text: "x" }));
    expect(noFromNoCc.head).not.toContain("From:");
    expect(noFromNoCc.head).not.toContain("Cc:");
  });

  it("carries a UTF-8 body intact via base64 transfer-encoding", () => {
    const { head, body } = decodeRaw(buildRawMessage({ to: "a@x.com", text: "Voilà ✈ 你好" }));
    expect(head).toContain("Content-Transfer-Encoding: base64");
    expect(body).toBe("Voilà ✈ 你好");
  });

  it("encodes a non-ASCII subject as an RFC-2047 word", () => {
    const { head } = decodeRaw(buildRawMessage({ to: "a@x.com", subject: "Confirmé ✈", text: "x" }));
    expect(head).toMatch(/Subject: =\?UTF-8\?B\?.+\?=/);
  });
});

describe("headerValue", () => {
  const headers = [
    { name: "From", value: "a@x.com" },
    { name: "Subject", value: "Hi" },
  ];
  it("is case-insensitive", () => {
    expect(headerValue(headers, "from")).toBe("a@x.com");
    expect(headerValue(headers, "SUBJECT")).toBe("Hi");
  });
  it("returns null for a missing header or non-array input", () => {
    expect(headerValue(headers, "Cc")).toBeNull();
    expect(headerValue(null, "From")).toBeNull();
  });
});

describe("parseGmailMessage", () => {
  const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");

  it("flattens a simple text/plain message", () => {
    const msg = parseGmailMessage({
      id: "m1",
      threadId: "t1",
      snippet: "snippet…",
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Client <client@example.com>" },
          { name: "To", value: "agent@travelstall.in" },
          { name: "Subject", value: "Re: Goa trip" },
          { name: "Date", value: "Mon, 16 Jun 2026 10:00:00 +0530" },
        ],
        body: { data: b64url("Body text here") },
      },
    });
    expect(msg.id).toBe("m1");
    expect(msg.threadId).toBe("t1");
    expect(msg.from).toBe("Client <client@example.com>");
    expect(msg.subject).toBe("Re: Goa trip");
    expect(msg.text).toBe("Body text here");
    expect(msg.body).toBe("Body text here");
    expect(msg.labelIds).toContain("UNREAD");
  });

  it("walks a multipart/alternative tree, preferring text/plain", () => {
    const msg = parseGmailMessage({
      id: "m2",
      payload: {
        mimeType: "multipart/alternative",
        headers: [{ name: "Subject", value: "Multi" }],
        parts: [
          { mimeType: "text/plain", body: { data: b64url("plain part") } },
          { mimeType: "text/html", body: { data: b64url("<p>html part</p>") } },
        ],
      },
    });
    expect(msg.text).toBe("plain part");
    expect(msg.html).toBe("<p>html part</p>");
    expect(msg.body).toBe("plain part"); // text preferred
  });

  it("falls back to html, then snippet, when no text/plain part exists", () => {
    const htmlOnly = parseGmailMessage({
      id: "m3",
      snippet: "snip",
      payload: { mimeType: "text/html", headers: [], body: { data: b64url("<i>only html</i>") } },
    });
    expect(htmlOnly.body).toBe("<i>only html</i>");

    const snippetOnly = parseGmailMessage({ id: "m4", snippet: "just a snippet", payload: { headers: [] } });
    expect(snippetOnly.body).toBe("just a snippet");
  });

  it("returns null on non-object input", () => {
    expect(parseGmailMessage(null)).toBeNull();
    expect(parseGmailMessage("nope")).toBeNull();
  });
});

describe("extractEmailAddress", () => {
  it("pulls the address out of a display-name header (lowercased)", () => {
    expect(extractEmailAddress("Ahmed Khan <Ahmed.Pilgrim@Demo.Test>")).toBe("ahmed.pilgrim@demo.test");
  });
  it("accepts a bare address", () => {
    expect(extractEmailAddress("client@example.com")).toBe("client@example.com");
  });
  it("returns null for junk / missing input", () => {
    expect(extractEmailAddress("not an email")).toBeNull();
    expect(extractEmailAddress("")).toBeNull();
    expect(extractEmailAddress(null)).toBeNull();
  });
});
