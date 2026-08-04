import { describe, expect, it } from "vitest";
import { buildSingleImagePdfBytes } from "../pages/travel/flightOfferPdf";

describe("buildSingleImagePdfBytes", () => {
  it("wraps the image bytes in a valid one-page PDF shell", () => {
    const pdfBytes = buildSingleImagePdfBytes(new Uint8Array([1, 2, 3, 4, 5]));
    const text = Buffer.from(pdfBytes).toString("latin1");

    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Subtype /Image");
    expect(text).toContain("/Width 1200");
    expect(text).toContain("/Height 1437");
    expect(text).toContain("/Filter /DCTDecode");
    expect(text).toContain("/MediaBox [0 0 595 842]");
    expect(text).toContain("startxref");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });
});
