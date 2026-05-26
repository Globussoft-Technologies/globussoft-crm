// Unit tests for backend/lib/subBrandConfig.js
//
// Pins the Q9 / Q14 / Q21 cut-over plumbing contract: tenant.subBrandConfigJson
// → resolved per-sub-brand { wabaId, phoneNumberId, legalEntityCode, gstin,
// driveRootFolderId } block, with malformed-JSON tolerance + whitelist guard
// against arbitrary key leaks + empty-string field stripping.
//
// No prisma / network mocks needed — the resolver is pure (tenant, subBrand)
// → object. Mirrors the csvHelpers.test.js shape (pure unit, ESM test file
// importing CJS lib via vitest's inline transform).
//
// Once Q9 lands and the admin endpoint populates subBrandConfigJson, the
// cron + route consumers downstream stop reading `{}` and start reading
// real {wabaId, phoneNumberId, ...} blocks. The contract MUST stay stable
// across that transition — these tests are the guardrail.

import { describe, it, expect } from "vitest";

const { resolveForSubBrand, parseConfig, VALID_SUB_BRANDS, RETURN_FIELDS } = await import(
  "../../lib/subBrandConfig.js"
);

describe("subBrandConfig — parseConfig", () => {
  it("returns {} for null", () => {
    expect(parseConfig(null)).toEqual({});
  });

  it("returns {} for empty string", () => {
    expect(parseConfig("")).toEqual({});
  });

  it("returns {} for non-string input (undefined)", () => {
    expect(parseConfig(undefined)).toEqual({});
  });

  it("returns {} for non-string input (number)", () => {
    expect(parseConfig(42)).toEqual({});
  });

  it("returns {} for malformed JSON without throwing", () => {
    // Should warn (not asserted) and return {} — the resolver must not
    // crash the caller's request just because admin pasted bad JSON.
    expect(parseConfig("not json {{{")).toEqual({});
  });

  it("parses valid JSON into object", () => {
    const json = JSON.stringify({ tmc: { wabaId: "WABA_TMC_1" } });
    expect(parseConfig(json)).toEqual({ tmc: { wabaId: "WABA_TMC_1" } });
  });

  it("returns {} for top-level JSON array (not an object)", () => {
    expect(parseConfig("[1,2,3]")).toEqual({});
  });

  it("returns {} for top-level JSON string (not an object)", () => {
    // typeof "string" !== "object" so the guard rejects it.
    expect(parseConfig('"someString"')).toEqual({});
  });

  it("returns {} for top-level JSON null", () => {
    expect(parseConfig("null")).toEqual({});
  });
});

describe("subBrandConfig — resolveForSubBrand", () => {
  const TENANT_WITH_FULL_TMC = {
    subBrandConfigJson: JSON.stringify({
      tmc: {
        wabaId: "WABA_TMC_1",
        phoneNumberId: "PN_TMC_1",
        legalEntityCode: "TMC_LLP",
        gstin: "29ABCDE1234F1Z5",
        driveRootFolderId: "DRIVE_TMC_ROOT",
      },
    }),
  };

  it("returns {} for empty tenant", () => {
    expect(resolveForSubBrand({}, "tmc")).toEqual({});
  });

  it("returns {} for null tenant", () => {
    expect(resolveForSubBrand(null, "tmc")).toEqual({});
  });

  it("returns {} when subBrandConfigJson is null", () => {
    expect(resolveForSubBrand({ subBrandConfigJson: null }, "tmc")).toEqual({});
  });

  it("returns {} when subBrandConfigJson is empty", () => {
    expect(resolveForSubBrand({ subBrandConfigJson: "" }, "tmc")).toEqual({});
  });

  it("returns all 5 fields when JSON has a complete TMC block", () => {
    const got = resolveForSubBrand(TENANT_WITH_FULL_TMC, "tmc");
    expect(got).toEqual({
      wabaId: "WABA_TMC_1",
      phoneNumberId: "PN_TMC_1",
      legalEntityCode: "TMC_LLP",
      gstin: "29ABCDE1234F1Z5",
      driveRootFolderId: "DRIVE_TMC_ROOT",
    });
  });

  it("returns {} when asked for a sub-brand absent from the JSON", () => {
    // JSON only has tmc; rfu lookup yields {}.
    expect(resolveForSubBrand(TENANT_WITH_FULL_TMC, "rfu")).toEqual({});
  });

  it("returns {} for an invalid sub-brand name", () => {
    expect(resolveForSubBrand(TENANT_WITH_FULL_TMC, "INVALID_SUB_BRAND")).toEqual({});
  });

  it("returns {} for empty sub-brand name", () => {
    expect(resolveForSubBrand(TENANT_WITH_FULL_TMC, "")).toEqual({});
  });

  it("whitelists return fields — arbitrary extra keys do NOT leak", () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({
        tmc: {
          wabaId: "X",
          someOtherField: "leak",
          internalToken: "should-not-leak",
        },
      }),
    };
    const got = resolveForSubBrand(tenant, "tmc");
    expect(got).toEqual({ wabaId: "X" });
    expect(got).not.toHaveProperty("someOtherField");
    expect(got).not.toHaveProperty("internalToken");
  });

  it("strips empty-string fields from the return value", () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({
        tmc: { wabaId: "", phoneNumberId: "PN_1" },
      }),
    };
    const got = resolveForSubBrand(tenant, "tmc");
    expect(got).toEqual({ phoneNumberId: "PN_1" });
    expect(got).not.toHaveProperty("wabaId");
  });

  it("strips null fields from the return value", () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({
        tmc: { wabaId: null, phoneNumberId: "PN_1" },
      }),
    };
    const got = resolveForSubBrand(tenant, "tmc");
    expect(got).toEqual({ phoneNumberId: "PN_1" });
  });

  it("returns {} when sub-brand block is an array (not an object)", () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({ tmc: ["wabaId", "WABA_X"] }),
    };
    expect(resolveForSubBrand(tenant, "tmc")).toEqual({});
  });

  it("returns {} when sub-brand block is a string (not an object)", () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({ tmc: "WABA_TMC_1" }),
    };
    expect(resolveForSubBrand(tenant, "tmc")).toEqual({});
  });

  it("handles all 4 valid sub-brands when fully populated", () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({
        tmc: { wabaId: "W_TMC" },
        rfu: { wabaId: "W_RFU" },
        travelstall: { wabaId: "W_TS" },
        visasure: { wabaId: "W_VS" },
      }),
    };
    expect(resolveForSubBrand(tenant, "tmc")).toEqual({ wabaId: "W_TMC" });
    expect(resolveForSubBrand(tenant, "rfu")).toEqual({ wabaId: "W_RFU" });
    expect(resolveForSubBrand(tenant, "travelstall")).toEqual({ wabaId: "W_TS" });
    expect(resolveForSubBrand(tenant, "visasure")).toEqual({ wabaId: "W_VS" });
  });

  it("survives malformed JSON without exposing internals", () => {
    const tenant = { subBrandConfigJson: "{ broken json" };
    expect(resolveForSubBrand(tenant, "tmc")).toEqual({});
  });
});

describe("subBrandConfig — exported constants", () => {
  it("exports the canonical 4 sub-brand names", () => {
    expect(VALID_SUB_BRANDS).toEqual(["tmc", "rfu", "travelstall", "visasure"]);
  });

  it("exports the canonical 5 return fields", () => {
    expect(RETURN_FIELDS).toEqual([
      "wabaId",
      "phoneNumberId",
      "legalEntityCode",
      "gstin",
      "driveRootFolderId",
    ]);
  });
});
