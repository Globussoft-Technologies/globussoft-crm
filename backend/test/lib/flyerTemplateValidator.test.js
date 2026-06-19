// Travel CRM — vitest cases for flyerTemplateValidator (#908 slice 1).
//
// Pins the shape contract that future slices (route + renderer) rely on:
//
//   - isValidHex strictly requires `#` + 6 hex digits; 3-digit shorthand
//     and non-hex strings are rejected.
//   - validatePalette requires primary/secondary/text/bg; accent optional.
//   - validateBlock enforces type taxonomy + non-negative finite numeric
//     dimensions + type-specific required fields (text/price→content,
//     image/logo→src, cta→content [href optional], divider→nothing extra).
//   - validateLayout demands an array and aggregates per-block errors.
//   - validateTemplate aggregates palette + layout + optional-assets
//     errors and rejects null / non-object input.
//
// Pure unit test — no Prisma, no HTTP. Mirrors the style of
// backend/test/lib/inboundLeadVerification.test.js.

import { describe, it, expect } from "vitest";
import {
  HEX_COLOR_RE,
  VALID_BLOCK_TYPES,
  isValidHex,
  validatePalette,
  validateBlock,
  validateLayout,
  validateTemplate,
} from "../../lib/flyerTemplateValidator.js";

describe("flyerTemplateValidator — constants", () => {
  it("exports the canonical 6-digit hex regex", () => {
    expect(HEX_COLOR_RE).toBeInstanceOf(RegExp);
    expect("#ABCDEF").toMatch(HEX_COLOR_RE);
    expect("#abc").not.toMatch(HEX_COLOR_RE);
  });

  it("exports the block-type taxonomy", () => {
    expect(VALID_BLOCK_TYPES).toEqual([
      "text",
      "price",
      "image",
      "cta",
      "divider",
      "logo",
    ]);
  });
});

describe("isValidHex", () => {
  it("accepts uppercase 6-digit hex", () => {
    expect(isValidHex("#ABCDEF")).toBe(true);
  });

  it("accepts lowercase 6-digit hex", () => {
    expect(isValidHex("#abcdef")).toBe(true);
  });

  it("accepts mixed-case 6-digit hex", () => {
    expect(isValidHex("#aBcDeF")).toBe(true);
  });

  it("rejects 3-digit shorthand", () => {
    expect(isValidHex("#ABC")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidHex("#GGGGGG")).toBe(false);
  });

  it("rejects color names", () => {
    expect(isValidHex("red")).toBe(false);
  });

  it("rejects missing leading #", () => {
    expect(isValidHex("ABCDEF")).toBe(false);
  });

  it("rejects null / undefined / non-string input", () => {
    expect(isValidHex(null)).toBe(false);
    expect(isValidHex(undefined)).toBe(false);
    expect(isValidHex(0xabcdef)).toBe(false);
  });
});

describe("validatePalette", () => {
  const minimal = {
    primaryHex: "#112233",
    secondaryHex: "#445566",
    textHex: "#000000",
    bgHex: "#FFFFFF",
  };

  it("ok when minimal required fields are present + valid", () => {
    const result = validatePalette(minimal);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags missing primaryHex", () => {
    const palette = { ...minimal };
    delete palette.primaryHex;
    const result = validatePalette(palette);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("palette.primaryHex is required");
  });

  it("flags invalid hex value on a required key", () => {
    const result = validatePalette({ ...minimal, primaryHex: "red" });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "palette.primaryHex must be 6-digit hex (#RRGGBB)"
    );
  });

  it("accepts a valid optional accentHex", () => {
    const result = validatePalette({ ...minimal, accentHex: "#AABBCC" });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects an invalid optional accentHex", () => {
    const result = validatePalette({ ...minimal, accentHex: "rouge" });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "palette.accentHex must be 6-digit hex (#RRGGBB)"
    );
  });

  it("treats null / non-object palette as a single envelope error", () => {
    expect(validatePalette(null).errors).toEqual(["palette must be an object"]);
    expect(validatePalette("not-an-object").errors).toEqual([
      "palette must be an object",
    ]);
    expect(validatePalette([]).errors).toEqual(["palette must be an object"]);
  });
});

describe("validateBlock", () => {
  const okText = {
    type: "text",
    x: 0,
    y: 10,
    width: 200,
    height: 40,
    content: "Hello, traveller!",
  };
  const okImage = {
    type: "image",
    x: 100,
    y: 0,
    width: 300,
    height: 300,
    src: "https://cdn.example.com/hero.jpg",
  };
  const okCta = {
    type: "cta",
    x: 0,
    y: 400,
    width: 200,
    height: 48,
    content: "Book now",
    href: "https://travelstall.in/book",
  };
  const okPrice = {
    type: "price",
    x: 0,
    y: 300,
    width: 200,
    height: 48,
    content: "₹ 49,999",
  };

  it("accepts a valid text block", () => {
    expect(validateBlock(okText, 0)).toEqual([]);
  });

  it("accepts a valid price block", () => {
    expect(validateBlock(okPrice, 0)).toEqual([]);
  });

  it("flags price block without content", () => {
    const errors = validateBlock({ ...okPrice, content: "" }, 1);
    expect(errors).toContain("layout[1] (price) needs non-empty content");
  });

  it("accepts a valid image block", () => {
    expect(validateBlock(okImage, 1)).toEqual([]);
  });

  it("accepts a valid cta block", () => {
    expect(validateBlock(okCta, 2)).toEqual([]);
  });

  it("accepts a divider block with no extra fields", () => {
    const divider = { type: "divider", x: 0, y: 200, width: 400, height: 2 };
    expect(validateBlock(divider, 3)).toEqual([]);
  });

  it("flags text block without content", () => {
    const errors = validateBlock({ ...okText, content: "" }, 0);
    expect(errors).toContain("layout[0] (text) needs non-empty content");
  });

  it("flags image block without src", () => {
    const errors = validateBlock({ ...okImage, src: "" }, 1);
    expect(errors).toContain("layout[1] (image) needs non-empty src");
  });

  it("flags logo block without src", () => {
    const errors = validateBlock(
      { type: "logo", x: 0, y: 0, width: 100, height: 100 },
      2
    );
    expect(errors).toContain("layout[2] (logo) needs non-empty src");
  });

  it("accepts a cta block without href (href is optional)", () => {
    const { href: _href, ...noHref } = okCta;
    expect(validateBlock(noHref, 0)).toEqual([]);
  });

  it("accepts a cta block with an empty-string href (treated as no link)", () => {
    expect(validateBlock({ ...okCta, href: "" }, 0)).toEqual([]);
  });

  it("flags a cta block whose href is a non-string", () => {
    const errors = validateBlock({ ...okCta, href: 42 }, 0);
    expect(errors).toContain("layout[0] (cta) href must be a string if provided");
  });

  it("flags invalid block type", () => {
    const errors = validateBlock({ ...okText, type: "marquee" }, 0);
    expect(
      errors.some((e) => e.startsWith("layout[0].type must be one of"))
    ).toBe(true);
  });

  it("flags negative width", () => {
    const errors = validateBlock({ ...okText, width: -1 }, 0);
    expect(errors).toContain("layout[0].width must be a non-negative number");
  });

  it("flags non-finite height", () => {
    const errors = validateBlock({ ...okText, height: Infinity }, 0);
    expect(errors).toContain("layout[0].height must be a non-negative number");
  });

  it("flags non-object block", () => {
    expect(validateBlock(null, 5)).toEqual(["layout[5] must be an object"]);
    expect(validateBlock("text", 6)).toEqual(["layout[6] must be an object"]);
  });
});

describe("validateLayout", () => {
  it("ok for an array of valid blocks", () => {
    const layout = [
      { type: "text", x: 0, y: 0, width: 100, height: 20, content: "Hi" },
      { type: "divider", x: 0, y: 30, width: 400, height: 2 },
    ];
    expect(validateLayout(layout)).toEqual({ ok: true, errors: [] });
  });

  it("rejects non-array input", () => {
    expect(validateLayout({}).errors).toEqual(["layout must be an array"]);
    expect(validateLayout(null).errors).toEqual(["layout must be an array"]);
    expect(validateLayout("a,b").errors).toEqual(["layout must be an array"]);
  });

  it("aggregates errors across blocks with their indices", () => {
    const layout = [
      { type: "text", x: 0, y: 0, width: 10, height: 10, content: "" },
      { type: "image", x: 0, y: 0, width: 10, height: 10 },
    ];
    const result = validateLayout(layout);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("layout[0] (text) needs non-empty content");
    expect(result.errors).toContain("layout[1] (image) needs non-empty src");
  });

  it("ok for an empty array (operator may save an empty draft)", () => {
    expect(validateLayout([])).toEqual({ ok: true, errors: [] });
  });
});

describe("validateTemplate", () => {
  const okTemplate = {
    palette: {
      primaryHex: "#265855",
      secondaryHex: "#CD9481",
      textHex: "#1A1A1A",
      bgHex: "#FFF8F0",
    },
    layout: [
      { type: "text", x: 0, y: 0, width: 400, height: 40, content: "Umrah" },
      { type: "divider", x: 0, y: 50, width: 400, height: 2 },
    ],
    assets: { logo: "https://cdn.example.com/logo.png", hero: null },
  };

  it("ok for a fully valid template", () => {
    expect(validateTemplate(okTemplate)).toEqual({ ok: true, errors: [] });
  });

  it("ok when assets is omitted", () => {
    const { assets: _assets, ...rest } = okTemplate;
    expect(validateTemplate(rest)).toEqual({ ok: true, errors: [] });
  });

  it("propagates palette errors", () => {
    const result = validateTemplate({
      ...okTemplate,
      palette: { ...okTemplate.palette, primaryHex: "red" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "palette.primaryHex must be 6-digit hex (#RRGGBB)"
    );
  });

  it("propagates layout errors with indices", () => {
    const result = validateTemplate({
      ...okTemplate,
      layout: [{ type: "cta", x: 0, y: 0, width: 10, height: 10 }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("layout[0] (cta) needs non-empty content");
    // href is optional now — a content-less cta no longer ALSO fails on href.
    expect(result.errors).not.toContain("layout[0] (cta) needs non-empty href");
  });

  it("accepts the studio's default flyer — headline + price + href-less cta", () => {
    // Mirrors the exact INVALID_TEMPLATE case operators hit: a Price block plus
    // a "Book Now" CTA with no href. Both used to be rejected.
    const result = validateTemplate({
      ...okTemplate,
      layout: [
        { type: "text", x: 24, y: 24, width: 480, height: 80, content: "Headline" },
        { type: "price", x: 24, y: 120, width: 200, height: 48, content: "₹ 49,999" },
        { type: "cta", x: 24, y: 200, width: 200, height: 50, content: "Book Now" },
      ],
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("flags assets when provided as a non-object", () => {
    const result = validateTemplate({ ...okTemplate, assets: "logo.png" });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("assets must be an object if provided");
  });

  it("flags assets when provided as an array", () => {
    const result = validateTemplate({ ...okTemplate, assets: [] });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("assets must be an object if provided");
  });

  it("rejects null input with a single envelope error", () => {
    expect(validateTemplate(null)).toEqual({
      ok: false,
      errors: ["template must be an object"],
    });
  });

  it("rejects non-object input", () => {
    expect(validateTemplate("flyer").errors).toEqual([
      "template must be an object",
    ]);
    expect(validateTemplate(42).errors).toEqual([
      "template must be an object",
    ]);
    expect(validateTemplate([]).errors).toEqual([
      "template must be an object",
    ]);
  });
});
