import { describe, expect, test } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const {
  convertTmcConsentTemplateToPdf,
  parseDigitalConsentTerms,
  renderTmcDigitalConsentPdf,
} = requireCJS("../../lib/tmcConsentPdf");

describe("TMC consent PDF delivery", () => {
  test("parses the introductory title and numbered terms headings", () => {
    const parsed = parseDigitalConsentTerms(
      "TERMS AND CONDITIONS FOR INTERNATIONAL EDUCATIONAL TRAVEL PROGRAMMES These Terms apply. 1. DEFINITIONS These are definitions. 14. TERM These terms remain in force.",
    );

    expect(parsed.title).toBe("TERMS AND CONDITIONS FOR INTERNATIONAL EDUCATIONAL TRAVEL PROGRAMMES");
    expect(parsed.sections.map((section) => section.heading)).toEqual(["1. DEFINITIONS", "14. TERM"]);
  });

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

  test("renders submitted digital consent details into a PDF", async () => {
    const rendered = await renderTmcDigitalConsentPdf({
      id: 103,
      documentType: "Parent consent form",
      tripId: 7,
      answersJson: JSON.stringify({
        parentName: "Arijit Singh",
        participantName: "Anaya Singh",
        relationship: "Parent",
        signatureName: "Arijit Singh",
        notes: "No medical restrictions.",
      }),
      termsSnapshot: "I agree to the Darjeeling trip terms.",
      agreedAt: "2026-11-13T10:00:00.000Z",
    });

    expect(rendered.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
