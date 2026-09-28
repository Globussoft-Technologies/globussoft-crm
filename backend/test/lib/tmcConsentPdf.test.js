import { describe, expect, test } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const {
  convertTmcConsentTemplateToPdf,
} = requireCJS("../../lib/tmcConsentPdf");

describe("TMC consent PDF delivery", () => {
  test("keeps the supplied consent PDF as a real PDF", async () => {
    const fileBlob = Buffer.from("%PDF-1.7 supplied consent terms");
    const rendered = await convertTmcConsentTemplateToPdf({
      filename: "day-tour-terms.pdf",
      mimeType: "application/pdf",
      fileBlob,
    });

    expect(rendered.filename).toBe("day-tour-terms.pdf");
    expect(rendered.mimeType).toBe("application/pdf");
    expect(rendered.buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("keeps an existing PDF as PDF without changing its bytes", async () => {
    const fileBlob = Buffer.from("%PDF-1.7 existing terms");
    const rendered = await convertTmcConsentTemplateToPdf({
      filename: "terms.pdf",
      mimeType: "application/pdf",
      fileBlob,
    });

    expect(rendered.filename).toBe("terms.pdf");
    expect(rendered.buffer).toBe(fileBlob);
  });
});
