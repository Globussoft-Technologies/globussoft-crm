import { describe, expect, test } from "vitest";

const { decodeGenericRichText } = await import("../../lib/genericRichText.js");

const encode = (value) => Buffer.from(value, "utf8").toString("base64");

describe("generic rich-text transport", () => {
  test("preserves uploaded note images and right alignment", () => {
    const html = '<div style="text-align: right">Hello</div><img src="/api/uploads/images/note.png" alt="note.png">';
    expect(decodeGenericRichText(encode(html))).toMatch(/text-align:\s*right/);
    expect(decodeGenericRichText(encode(html))).toContain('src="/api/uploads/images/note.png"');
  });

  test("removes active content and inline image data", () => {
    const html = '<script>alert(1)</script><img src="data:image/png;base64,AAAA" onerror="alert(2)"><img src="https://tracker.example/pixel.png"><b>Safe</b>';
    const decoded = decodeGenericRichText(encode(html));
    expect(decoded).not.toMatch(/script|onerror|data:image|tracker\.example/i);
    expect(decoded).toContain("<b>Safe</b>");
  });

  test("rejects invalid or missing encoded content", () => {
    expect(decodeGenericRichText("")).toBeNull();
  });
});
