// Unit tests for backend/lib/emailRender.js — Branding Wave 4 G090.
//
// Pins the brand-kit token interpolation contract that the email send
// pipeline (routes/email.js, cron/scheduledEmailEngine.js, G097) relies on:
//   - Sub-brand-scoped BrandKit row wins; tenant-wide row is the fallback.
//   - Missing kit OR missing field → empty-string substitution (never
//     leaves the literal {{brand_xxx}} in the rendered body).
//   - Non-brand tokens (e.g. {{name}}) pass through untouched so the
//     existing substituteVars / template-engine layers downstream still
//     get a clean shot at them.
//   - applyTokens is shape-preserving for null / undefined input.
//
// Mocking strategy: stub a minimal `prisma` object that returns canned
// BrandKit rows from the brandKit.findFirst seam. emailRender's
// resolveBrandKit reads ONLY brandKit.findFirst — no other tables — so
// the stub stays small.

import { describe, it, expect, vi } from "vitest";

const {
  renderEmailWithBrand,
  buildTokenMap,
  applyTokens,
  TOKEN_NAMES,
  TOKEN_FIELD_MAP,
} = await import("../../lib/emailRender.js");

function fakePrisma(rows) {
  // rows: array of BrandKit rows; findFirst walks them in order, returning
  // the first row matching the supplied where clause's tenantId/subBrand
  // pair. isActive is honoured (only true rows match).
  return {
    brandKit: {
      findFirst: vi.fn(async ({ where }) => {
        for (const row of rows) {
          if (row.tenantId !== where.tenantId) continue;
          if (where.subBrand === null && row.subBrand !== null) continue;
          if (where.subBrand && row.subBrand !== where.subBrand) continue;
          if (where.isActive === true && row.isActive !== true) continue;
          return row;
        }
        return null;
      }),
    },
  };
}

describe("emailRender — buildTokenMap", () => {
  it("maps every brand field to a string", () => {
    const kit = {
      logoUrl: "https://cdn.example/tmc.png",
      primaryColor: "#122647",
      tagline: "School trips, done right.",
      signatureTemplate: "<p>— TMC team</p>",
      footerText: "TMC by Travel Stall",
    };
    const map = buildTokenMap(kit);
    expect(map.brand_logo_url).toBe("https://cdn.example/tmc.png");
    expect(map.brand_primary_color).toBe("#122647");
    expect(map.brand_tagline).toBe("School trips, done right.");
    expect(map.brand_signature_template).toBe("<p>— TMC team</p>");
    expect(map.brand_footer_text).toBe("TMC by Travel Stall");
  });

  it("returns empty strings for null kit", () => {
    const map = buildTokenMap(null);
    for (const t of TOKEN_NAMES) expect(map[t]).toBe("");
  });

  it("returns empty strings for missing fields on a partial kit", () => {
    const map = buildTokenMap({ primaryColor: "#265855" });
    expect(map.brand_primary_color).toBe("#265855");
    expect(map.brand_logo_url).toBe("");
    expect(map.brand_tagline).toBe("");
    expect(map.brand_signature_template).toBe("");
    expect(map.brand_footer_text).toBe("");
  });

  it("declares every documented token", () => {
    // Lock the token catalogue so a future renamer can't silently
    // change the PRD contract without updating both ends.
    expect(TOKEN_NAMES.sort()).toEqual(
      [
        "brand_logo_url",
        "brand_primary_color",
        "brand_tagline",
        "brand_signature_template",
        "brand_footer_text",
      ].sort(),
    );
    // Every token maps to a field name that exists on the BrandKit
    // model (per backend/prisma/schema.prisma BrandKit block).
    expect(TOKEN_FIELD_MAP.brand_logo_url).toBe("logoUrl");
    expect(TOKEN_FIELD_MAP.brand_primary_color).toBe("primaryColor");
    expect(TOKEN_FIELD_MAP.brand_tagline).toBe("tagline");
    expect(TOKEN_FIELD_MAP.brand_signature_template).toBe("signatureTemplate");
    expect(TOKEN_FIELD_MAP.brand_footer_text).toBe("footerText");
  });
});

describe("emailRender — applyTokens", () => {
  it("replaces tokens with mapped values", () => {
    const map = buildTokenMap({
      logoUrl: "https://cdn.example/rfu.png",
      tagline: "Sacred journeys.",
    });
    const out = applyTokens(
      "Welcome! <img src='{{brand_logo_url}}' alt='logo'/> — {{brand_tagline}}",
      map,
    );
    expect(out).toContain("https://cdn.example/rfu.png");
    expect(out).toContain("Sacred journeys.");
    expect(out).not.toContain("{{brand_logo_url}}");
    expect(out).not.toContain("{{brand_tagline}}");
  });

  it("tolerates inner whitespace inside the braces", () => {
    const map = buildTokenMap({ primaryColor: "#122647" });
    expect(applyTokens("color:{{ brand_primary_color }};", map)).toBe(
      "color:#122647;",
    );
  });

  it("replaces a missing-field token with empty string", () => {
    const map = buildTokenMap(null);
    expect(applyTokens("Sig: {{brand_signature_template}} end", map)).toBe(
      "Sig:  end",
    );
  });

  it("leaves unknown tokens untouched (handed off to substituteVars later)", () => {
    const map = buildTokenMap({ logoUrl: "x.png" });
    // {{name}} and {{appointment_date}} are NOT brand tokens — they belong
    // to the SMS/email template layer downstream. emailRender must not
    // consume them.
    const out = applyTokens("Hi {{name}}, see {{brand_logo_url}} on {{appointment_date}}", map);
    expect(out).toBe("Hi {{name}}, see x.png on {{appointment_date}}");
  });

  it("treats null/undefined input as empty string", () => {
    const map = buildTokenMap(null);
    expect(applyTokens(null, map)).toBe("");
    expect(applyTokens(undefined, map)).toBe("");
  });
});

describe("emailRender — renderEmailWithBrand", () => {
  it("resolves sub-brand-scoped kit before tenant-wide fallback", async () => {
    const tmcKit = {
      tenantId: 9,
      subBrand: "tmc",
      isActive: true,
      logoUrl: "https://cdn.example/tmc.png",
      primaryColor: "#122647",
      tagline: "TMC trips",
      signatureTemplate: "",
      footerText: "",
    };
    const tenantWide = {
      tenantId: 9,
      subBrand: null,
      isActive: true,
      logoUrl: "https://cdn.example/tenant.png",
      primaryColor: "#000000",
      tagline: "Tenant default",
      signatureTemplate: "",
      footerText: "",
    };
    const prisma = fakePrisma([tmcKit, tenantWide]);
    const out = await renderEmailWithBrand({
      prisma,
      tenantId: 9,
      subBrand: "tmc",
      body: "Logo: {{brand_logo_url}} tag: {{brand_tagline}}",
      subject: "From {{brand_tagline}}",
    });
    expect(out.renderedBody).toContain("https://cdn.example/tmc.png");
    expect(out.renderedBody).toContain("TMC trips");
    expect(out.renderedSubject).toBe("From TMC trips");
    // brandKit pointer returns the sub-brand row (call-site debug aid).
    expect(out.brandKit?.subBrand).toBe("tmc");
  });

  it("falls back to tenant-wide kit when sub-brand row missing", async () => {
    const tenantWide = {
      tenantId: 9,
      subBrand: null,
      isActive: true,
      logoUrl: "https://cdn.example/tenant.png",
      primaryColor: "#000000",
      tagline: "Tenant default",
      signatureTemplate: "",
      footerText: "",
    };
    const prisma = fakePrisma([tenantWide]);
    const out = await renderEmailWithBrand({
      prisma,
      tenantId: 9,
      subBrand: "rfu", // no rfu kit; tenant-wide falls in
      body: "{{brand_tagline}}",
    });
    expect(out.renderedBody).toBe("Tenant default");
    expect(out.brandKit?.subBrand).toBe(null);
  });

  it("renders empty tokens when neither kit exists", async () => {
    const prisma = fakePrisma([]);
    const out = await renderEmailWithBrand({
      prisma,
      tenantId: 9,
      subBrand: "tmc",
      body: "Body {{brand_logo_url}} end",
      subject: "Subj {{brand_primary_color}}",
    });
    expect(out.renderedBody).toBe("Body  end");
    expect(out.renderedSubject).toBe("Subj ");
    expect(out.brandKit).toBeNull();
  });

  it("ignores inactive kits", async () => {
    const inactive = {
      tenantId: 9, subBrand: "tmc", isActive: false,
      logoUrl: "https://cdn.example/inactive.png",
    };
    const prisma = fakePrisma([inactive]);
    const out = await renderEmailWithBrand({
      prisma,
      tenantId: 9,
      subBrand: "tmc",
      body: "{{brand_logo_url}}",
    });
    expect(out.renderedBody).toBe("");
    expect(out.brandKit).toBeNull();
  });

  it("gracefully degrades when prisma read throws", async () => {
    const prisma = {
      brandKit: { findFirst: vi.fn(async () => { throw new Error("DB down"); }) },
    };
    const out = await renderEmailWithBrand({
      prisma,
      tenantId: 9,
      subBrand: "tmc",
      body: "x {{brand_tagline}} y",
    });
    expect(out.renderedBody).toBe("x  y");
    expect(out.brandKit).toBeNull();
  });

  it("returns body unchanged when no tokens present (shape preservation)", async () => {
    const prisma = fakePrisma([]);
    const out = await renderEmailWithBrand({
      prisma, tenantId: 9, subBrand: null,
      body: "Plain text. No tokens here.",
    });
    expect(out.renderedBody).toBe("Plain text. No tokens here.");
  });
});
