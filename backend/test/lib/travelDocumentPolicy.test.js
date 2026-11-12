import { describe, expect, test } from "vitest";
import policy from "../../lib/travelDocumentPolicy.js";

describe("travel document policy", () => {
  test("normalizes only supported admin-selected file types and applies defaults", () => {
    expect(policy.normalizeAcceptedFileTypes(["PDF", "docx", "unknown", "pdf"])).toEqual(["pdf", "docx"]);
    expect(policy.normalizeAcceptedFileTypes("[\"jpg\",\"png\"]")).toEqual(["jpg", "png"]);
    expect(policy.normalizeAcceptedFileTypes([])).toEqual(["pdf", "jpg", "png"]);
  });

  test("matches configured MIME types and filename extensions", () => {
    expect(policy.acceptedFileTypeMatches(
      { mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", originalname: "clearance.docx" },
      ["docx"],
    )).toBe(true);
    expect(policy.acceptedFileTypeMatches(
      { mimetype: "application/octet-stream", originalname: "clearance.DOCX" },
      ["docx"],
    )).toBe(true);
    expect(policy.acceptedFileTypeMatches(
      { mimetype: "text/plain", originalname: "notes.txt" },
      ["pdf", "jpg"],
    )).toBe(false);
  });

  test("projects persisted requirements with normalized file type arrays", () => {
    expect(policy.projectTripDocumentRequirement({
      id: 7,
      docType: "School medical clearance",
      acceptedFileTypes: "[\"pdf\",\"docx\"]",
      required: true,
    })).toEqual({
      id: 7,
      docType: "School medical clearance",
      captureMode: "file",
      acceptedFileTypes: ["pdf", "docx"],
      required: true,
    });
  });
});
