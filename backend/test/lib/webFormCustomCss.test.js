import { describe, expect, test } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const { MAX_CUSTOM_CSS_LENGTH, sanitizeCustomCss } = requireCJS("../../lib/webFormCustomCss");

describe("web form custom CSS", () => {
  test("preserves normal presentation CSS", () => {
    const css = sanitizeCustomCss(`
      .panel { padding: 40px; background: linear-gradient(135deg, #fff, #eef1ff); }
      .primary { border-radius: 999px; }
    `);

    expect(css).toContain("padding: 40px");
    expect(css).toContain("linear-gradient(135deg, #fff, #eef1ff)");
    expect(css).toContain("border-radius: 999px");
  });

  test("removes embedded style tags and external/script-like CSS constructs", () => {
    const css = sanitizeCustomCss(`
      <style>.panel { color: red; }</style>
      @import url("https://example.com/theme.css");
      .panel { background-image: url(https://example.com/pixel); behavior: url(#default#time); }
      .field { color: expression(alert(1)); }
    `);

    expect(css).not.toMatch(/<\/?style|@import|url\s*\(|behavior\s*:|expression\s*\(|javascript\s*:/i);
    expect(css).toContain(".panel");
    expect(css).toContain(".field");
  });

  test("caps the persisted CSS length", () => {
    expect(sanitizeCustomCss("a".repeat(MAX_CUSTOM_CSS_LENGTH + 500))).toHaveLength(MAX_CUSTOM_CSS_LENGTH);
  });
});
