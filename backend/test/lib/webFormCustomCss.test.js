import { describe, expect, test } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const requireCJS = createRequire(import.meta.url);
const { MAX_CUSTOM_CSS_LENGTH, sanitizeCustomCss } = requireCJS("../../lib/webFormCustomCss");

describe("web form custom CSS", () => {
  test("preserves normal presentation CSS", () => {
    const css = sanitizeCustomCss(`
      .panel { padding: 40px; background: linear-gradient(135deg, #fff, #eef1ff); }
      .primary { border-radius: 999px; }
    `);

    expect(css).toContain("padding:40px");
    expect(css).toContain("linear-gradient(135deg,#fff,#eef1ff)");
    expect(css).toContain("border-radius:999px");
  });

  test("removes embedded style tags and external/script-like CSS constructs", () => {
    const css = sanitizeCustomCss(`
      @import url("https://example.com/theme.css");
      .panel { background-image: url(https://example.com/pixel); behavior: url(#default#time); }
      .field { color: expression(alert(1)); }
    `);

    expect(css).not.toMatch(/<\/?style|@import|url\s*\(|behavior\s*:|expression\s*\(|javascript\s*:/i);
    expect(css).toContain(".panel");
    expect(css).toContain(".field");
  });

  test("caps the persisted CSS length", () => {
    expect(sanitizeCustomCss("a".repeat(MAX_CUSTOM_CSS_LENGTH + 500)).length).toBeLessThanOrEqual(MAX_CUSTOM_CSS_LENGTH);
  });

  test.each([
    String.raw`.panel { background: u\72l(https://example.com/pixel); }`,
    String.raw`@\69mport "https://example.com/theme.css";`,
    `.panel { background: image-set("https://example.com/pixel" 1x); }`,
    `.panel { background: -webkit-image-set("https://example.com/pixel" 1x); }`,
    `@import "https://example.com/theme.css";`,
    `.panel { --remote: url(https://example.com/pixel); background: var(--remote); }`,
  ])("blocks external resources on the server and in the bundled iframe parser: %s", (css) => {
    expect(sanitizeCustomCss(css)).not.toContain("https://example.com");
    const context = {};
    runInNewContext(readFileSync(new URL("../../../frontend/public/embed/web-form-custom-css.js", import.meta.url), "utf8"), context);
    expect(context.gbsCustomCss.sanitizeCustomCss(css)).toBe(sanitizeCustomCss(css));
  });

  test("preserves nested responsive styles and presentation variables", () => {
    expect(sanitizeCustomCss("@media(max-width:640px){.panel{--space:12px;padding:var(--space);background:linear-gradient(red,blue)}}"))
      .toContain("--space:12px;padding:var(--space)");
  });

  test("preserves valid child combinators and CSS comments", () => {
    const css = sanitizeCustomCss(`
      /* Use a child selector for the form controls > inputs. */
      .panel > input { color: red; }
      .panel .phone-country-picker > input { background-color: #fff; }
    `);

    expect(css).toContain(".panel>input{color:red}");
    expect(css).toContain(".panel .phone-country-picker>input{background-color:#fff}");
  });

  test("fails closed on HTML and malformed input", () => {
    expect(sanitizeCustomCss("<style>.panel{color:red}</style>")).toBe("");
    expect(sanitizeCustomCss(".panel{color:/*")).not.toContain("color:");
  });
});
