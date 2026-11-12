import { describe, expect, test } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const {
  loadBundledTmcConsentTerms,
  normalizeTmcConsentTripType,
} = requireCJS("../../lib/tmcConsentTerms");

describe("TMC consent terms", () => {
  test("normalizes the three supported trip types", () => {
    expect(normalizeTmcConsentTripType("day tour")).toBe("day_trip");
    expect(normalizeTmcConsentTripType("domestic")).toBe("domestic");
    expect(normalizeTmcConsentTripType("international")).toBe("international");
    expect(normalizeTmcConsentTripType("unknown")).toBeNull();
  });

  test("loads the approved international terms from the bundled source document", async () => {
    const terms = await loadBundledTmcConsentTerms("international");
    expect(terms).toContain("TERMS AND CONDITIONS FOR INTERNATIONAL EDUCATIONAL TRAVEL PROGRAMMES");
    expect(terms).toContain("PASSPORTS, VISAS AND TRAVEL DOCUMENTATION");
  });
});
