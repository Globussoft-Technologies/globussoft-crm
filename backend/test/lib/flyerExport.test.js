// Travel CRM — vitest cases for flyerExport (#908 slice 8).
//
// Pins the substrate the future PDF (pdfkit-extended) + PNG (Puppeteer-
// based imageRenderer.js, deferred) slices both need:
//
//   - hashTemplateShape is stable under property-iteration-order
//     differences (canonicalizes keys before hashing) → enables
//     FR-3.4.5 output-URL caching to hit on semantically-identical
//     shapes regardless of how the JSON arrived.
//   - hashTemplateShape distinguishes between layout block reorderings
//     (arrays preserve order — re-ordering blocks changes the render
//     output, so it must hash differently).
//   - validateExportRequest enforces the format/aspect taxonomy
//     (FR-3.4.1 PDF a4/us_letter; FR-3.4.2 PNG square/portrait/
//     landscape/email_banner) — wrong combos return INVALID_EXPORT
//     errors that the future route surfaces as 400.
//   - buildOutputCacheKey produces the verbatim `<format>:<aspect>:
//     <hash>` shape consumers (MarketingFlyer.outputUrls JSON column,
//     renderer cache-lookup logic) commit to.
//
// Pure unit test — no Prisma, no HTTP, no fs. Mirrors the style of
// backend/test/lib/flyerTemplateValidator.test.js (the sibling pure-
// validator from slice 1).

import { describe, it, expect } from "vitest";
import {
  FORMATS,
  PDF_PAPER_SIZES,
  PNG_ASPECTS,
  FORMAT_ASPECT_TABLE,
  canonicalize,
  hashTemplateShape,
  validateExportRequest,
  buildOutputCacheKey,
} from "../../lib/flyerExport.js";

describe("flyerExport — taxonomy constants", () => {
  it("exports the PDF paper size catalogue", () => {
    expect(PDF_PAPER_SIZES).toEqual(["a4", "us_letter"]);
  });

  it("exports the PNG aspect catalogue", () => {
    expect(PNG_ASPECTS).toEqual([
      "square",
      "portrait",
      "landscape",
      "email_banner",
    ]);
  });

  it("exports the format catalogue", () => {
    expect(FORMATS).toEqual(["pdf", "png"]);
  });

  it("exports the format→aspect lookup table mapping each format to its allowed set", () => {
    expect(FORMAT_ASPECT_TABLE.pdf).toBe(PDF_PAPER_SIZES);
    expect(FORMAT_ASPECT_TABLE.png).toBe(PNG_ASPECTS);
  });
});

describe("canonicalize", () => {
  it("sorts object keys alphabetically (deep)", () => {
    const input = { b: 1, a: { z: 2, y: 1 }, c: [3, 1, 2] };
    const result = canonicalize(input);
    expect(Object.keys(result)).toEqual(["a", "b", "c"]);
    expect(Object.keys(result.a)).toEqual(["y", "z"]);
  });

  it("preserves array order (layout block order is semantically meaningful)", () => {
    const input = [{ type: "text" }, { type: "image" }, { type: "cta" }];
    expect(canonicalize(input)).toEqual(input);
  });

  it("returns primitives unchanged", () => {
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize("hello")).toBe("hello");
    expect(canonicalize(null)).toBe(null);
    expect(canonicalize(true)).toBe(true);
  });
});

describe("hashTemplateShape", () => {
  const baseShape = {
    palette: {
      primaryHex: "#122647",
      secondaryHex: "#265855",
      textHex: "#222222",
      bgHex: "#FFFDF7",
    },
    layout: [{ type: "text", x: 0, y: 0, width: 100, height: 50, content: "Hi" }],
    assets: { logo: "https://cdn.example/logo.png" },
  };

  it("returns a 64-char lowercase hex SHA-256", () => {
    const hash = hashTemplateShape(baseShape);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input yields same hash across calls", () => {
    expect(hashTemplateShape(baseShape)).toBe(hashTemplateShape(baseShape));
  });

  it("is stable under property-iteration-order differences (palette key reordering)", () => {
    const reordered = {
      palette: {
        bgHex: "#FFFDF7",
        textHex: "#222222",
        secondaryHex: "#265855",
        primaryHex: "#122647",
      },
      layout: baseShape.layout,
      assets: baseShape.assets,
    };
    expect(hashTemplateShape(reordered)).toBe(hashTemplateShape(baseShape));
  });

  it("distinguishes between layout block reorderings (arrays are order-significant)", () => {
    const reordered = {
      ...baseShape,
      layout: [
        { type: "image", x: 0, y: 0, width: 100, height: 50, src: "a" },
        { type: "text", x: 0, y: 0, width: 100, height: 50, content: "Hi" },
      ],
    };
    const original = {
      ...baseShape,
      layout: [
        { type: "text", x: 0, y: 0, width: 100, height: 50, content: "Hi" },
        { type: "image", x: 0, y: 0, width: 100, height: 50, src: "a" },
      ],
    };
    expect(hashTemplateShape(reordered)).not.toBe(hashTemplateShape(original));
  });

  it("distinguishes between palettes with different colors", () => {
    const swapped = {
      ...baseShape,
      palette: { ...baseShape.palette, primaryHex: "#000000" },
    };
    expect(hashTemplateShape(swapped)).not.toBe(hashTemplateShape(baseShape));
  });

  it("hashes a missing-assets shape distinctly from an explicit-null assets shape vs the same shape with assets present", () => {
    const noAssets = { palette: baseShape.palette, layout: baseShape.layout };
    const nullAssets = { ...noAssets, assets: null };
    const withAssets = baseShape;
    // missing == null after envelope folding, so noAssets and nullAssets hash equal.
    expect(hashTemplateShape(noAssets)).toBe(hashTemplateShape(nullAssets));
    // but withAssets (assets: { logo: ... }) hashes distinctly.
    expect(hashTemplateShape(withAssets)).not.toBe(hashTemplateShape(noAssets));
  });

  it("returns the empty-envelope hash for invalid input rather than throwing", () => {
    const expected = hashTemplateShape({});
    expect(hashTemplateShape(null)).toBe(expected);
    expect(hashTemplateShape(undefined)).toBe(expected);
    expect(hashTemplateShape("not an object")).toBe(expected);
    expect(hashTemplateShape([])).toBe(expected);
  });
});

describe("validateExportRequest", () => {
  it("accepts a valid pdf+a4 request", () => {
    expect(validateExportRequest({ format: "pdf", aspect: "a4" })).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("accepts a valid pdf+us_letter request", () => {
    expect(
      validateExportRequest({ format: "pdf", aspect: "us_letter" })
    ).toEqual({ ok: true, errors: [] });
  });

  it("accepts every valid png aspect", () => {
    for (const aspect of PNG_ASPECTS) {
      expect(validateExportRequest({ format: "png", aspect })).toEqual({
        ok: true,
        errors: [],
      });
    }
  });

  it("rejects an unknown format with a format-error", () => {
    const result = validateExportRequest({ format: "gif", aspect: "square" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /format/.test(e))).toBe(true);
  });

  it("rejects a cross-format aspect (pdf+square)", () => {
    const result = validateExportRequest({ format: "pdf", aspect: "square" });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => /aspect must be one of.*for format=pdf/.test(e))
    ).toBe(true);
  });

  it("rejects a cross-format aspect (png+a4)", () => {
    const result = validateExportRequest({ format: "png", aspect: "a4" });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => /aspect must be one of.*for format=png/.test(e))
    ).toBe(true);
  });

  it("rejects missing aspect", () => {
    const result = validateExportRequest({ format: "pdf" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /aspect is required/.test(e))).toBe(true);
  });

  it("rejects null / non-object input", () => {
    expect(validateExportRequest(null).ok).toBe(false);
    expect(validateExportRequest(undefined).ok).toBe(false);
    expect(validateExportRequest("pdf").ok).toBe(false);
    expect(validateExportRequest([]).ok).toBe(false);
  });
});

describe("buildOutputCacheKey", () => {
  it("composes the verbatim `<format>:<aspect>:<hash>` shape", () => {
    expect(
      buildOutputCacheKey({ format: "pdf", aspect: "a4", hash: "abc123" })
    ).toBe("pdf:a4:abc123");
  });

  it("composes png variants with the same separator", () => {
    expect(
      buildOutputCacheKey({
        format: "png",
        aspect: "portrait",
        hash: "deadbeef",
      })
    ).toBe("png:portrait:deadbeef");
  });

  it("throws when format / aspect / hash is missing", () => {
    expect(() => buildOutputCacheKey({ aspect: "a4", hash: "h" })).toThrow();
    expect(() => buildOutputCacheKey({ format: "pdf", hash: "h" })).toThrow();
    expect(() =>
      buildOutputCacheKey({ format: "pdf", aspect: "a4" })
    ).toThrow();
  });

  it("interoperates with hashTemplateShape end-to-end", () => {
    const shape = {
      palette: {
        primaryHex: "#122647",
        secondaryHex: "#265855",
        textHex: "#000000",
        bgHex: "#FFFFFF",
      },
      layout: [],
    };
    const hash = hashTemplateShape(shape);
    const key = buildOutputCacheKey({
      format: "png",
      aspect: "portrait",
      hash,
    });
    expect(key).toBe(`png:portrait:${hash}`);
    expect(key).toMatch(/^png:portrait:[0-9a-f]{64}$/);
  });
});
