// Unit tests for lib/travelReviewContent.js — the review-request email copy.

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const content = requireCJS("../../lib/travelReviewContent");

describe("travelReviewContent — buildRequestEmail", () => {
  it("weaves destination + name + review link into the email", () => {
    const m = content.buildRequestEmail({ destination: "Bali", customerName: "Mohit", reviewUrl: "https://app/p/review/tok123" });
    expect(m.subject).toContain("Bali");
    expect(m.text).toContain("Mohit");
    expect(m.text).toContain("Bali");
    expect(m.text).toContain("https://app/p/review/tok123");
    expect(m.html).toContain("<br>");
  });

  it("falls back gracefully when fields are missing", () => {
    const m = content.buildRequestEmail({});
    expect(m.text).toContain("traveller");
    expect(m.text).toContain("your recent trip");
  });
});
