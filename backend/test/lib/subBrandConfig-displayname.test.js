// Branding Wave 4 G101 — unit tests for resolveDisplayName +
// DEFAULT_DISPLAY_NAMES (lib/subBrandConfig.js extension).
//
// Pins the fallback chain SMS / WhatsApp callers rely on:
//   1. tenant.subBrandConfigJson[brand].displayName (admin-curated; Q22)
//   2. DEFAULT_DISPLAY_NAMES[brand] (placeholder constant)
//   3. null (caller uses provider-default sender)
//
// Pure unit — no Prisma, no network. The companion file
// backend/test/lib/subBrandConfig.test.js (existing) covers the
// resolveForSubBrand contract; this file adds the displayName contract
// without touching the existing test (rule-of-3: keep tests cohesive by
// concern rather than by file boundary).

import { describe, it, expect } from "vitest";

const { resolveDisplayName, DEFAULT_DISPLAY_NAMES, VALID_SUB_BRANDS } = await import(
  "../../lib/subBrandConfig.js"
);

describe("subBrandConfig — DEFAULT_DISPLAY_NAMES", () => {
  it("declares a placeholder for every valid sub-brand", () => {
    for (const sb of VALID_SUB_BRANDS) {
      expect(typeof DEFAULT_DISPLAY_NAMES[sb]).toBe("string");
      expect(DEFAULT_DISPLAY_NAMES[sb].length).toBeGreaterThan(0);
    }
  });

  it("uses recognisable brand chrome (sniff-test the v1 placeholders)", () => {
    // These are pre-Q22 placeholders; when Yasin's brand pack lands they
    // get overridden by subBrandConfigJson per-tenant. Locking the v1
    // strings here as a regression guard.
    expect(DEFAULT_DISPLAY_NAMES.tmc).toBe("TMC");
    expect(DEFAULT_DISPLAY_NAMES.rfu).toBe("RFU Umrah");
    expect(DEFAULT_DISPLAY_NAMES.travelstall).toBe("Travel Stall");
    expect(DEFAULT_DISPLAY_NAMES.visasure).toBe("Visa Sure");
  });
});

describe("subBrandConfig — resolveDisplayName", () => {
  it("prefers tenant-curated displayName when present", () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({
        tmc: { displayName: "TMC by Travel Stall (Schools)" },
      }),
    };
    expect(resolveDisplayName(tenant, "tmc")).toBe("TMC by Travel Stall (Schools)");
  });

  it("falls back to DEFAULT_DISPLAY_NAMES when curated value missing", () => {
    const tenant = { subBrandConfigJson: JSON.stringify({ tmc: { wabaId: "abc" } }) };
    expect(resolveDisplayName(tenant, "tmc")).toBe("TMC");
  });

  it("falls back to DEFAULT_DISPLAY_NAMES for null subBrandConfigJson", () => {
    const tenant = { subBrandConfigJson: null };
    expect(resolveDisplayName(tenant, "rfu")).toBe("RFU Umrah");
  });

  it("returns null for invalid sub-brand", () => {
    expect(resolveDisplayName({}, "unknown")).toBeNull();
    expect(resolveDisplayName({}, "")).toBeNull();
    expect(resolveDisplayName({}, null)).toBeNull();
    expect(resolveDisplayName({}, undefined)).toBeNull();
  });

  it("ignores non-string curated displayName (defensive)", () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({
        tmc: { displayName: 42 }, // not a string
      }),
    };
    // resolveForSubBrand whitelists non-empty values, so 42 (number) actually
    // passes the whitelist and emerges as the value — resolveDisplayName
    // guards by checking typeof === 'string', so it falls back to DEFAULT.
    expect(resolveDisplayName(tenant, "tmc")).toBe("TMC");
  });

  it("falls back when curated displayName is empty string", () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({
        rfu: { displayName: "" }, // empty stripped by resolveForSubBrand
      }),
    };
    expect(resolveDisplayName(tenant, "rfu")).toBe("RFU Umrah");
  });

  it("handles all 4 valid sub-brands end-to-end with defaults", () => {
    const out = {};
    for (const sb of VALID_SUB_BRANDS) {
      out[sb] = resolveDisplayName({}, sb);
    }
    expect(out).toEqual(DEFAULT_DISPLAY_NAMES);
  });
});
