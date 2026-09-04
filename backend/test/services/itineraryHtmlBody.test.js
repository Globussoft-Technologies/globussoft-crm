// itineraryHtmlBody — the HTML/CSS body path for itinerary PDF templates.
//
// The browser render itself needs a real Chromium, so these tests pin the
// parts that decide whether that render is correct and safe: the document
// shell (page sizing, @import hoisting), the unit conversion puppeteer is
// picky about, and the request allow-list that keeps an AI-drafted template
// from reaching anything but webfonts.

import { describe, it, expect } from "vitest";

const htmlBody = require("../../services/itineraryHtmlBody");
const starter = require("../../services/itineraryHtmlStarterTemplate");
const { renderTemplate } = require("../../lib/microTemplate");

describe("itineraryHtmlBody", () => {
  describe("ptToInches", () => {
    // page.pdf() accepts only px/in/cm/mm. "500pt" is not rejected outright —
    // it falls through to Number("500pt") = NaN and throws, so every render
    // silently fell back until this conversion existed.
    it("converts PDF points to inches at 72pt = 1in", () => {
      expect(htmlBody.ptToInches(72)).toBe("1.0000in");
      expect(htmlBody.ptToInches(36)).toBe("0.5000in");
    });

    it("tames the long float tails that scaled content boxes produce", () => {
      expect(htmlBody.ptToInches(500.03150400000004)).toBe("6.9449in");
    });
  });

  describe("buildHtmlDocument", () => {
    it("sizes the page to the content box so Chromium paginates against it", () => {
      const doc = htmlBody.buildHtmlDocument({ bodyHtml: "x", bodyCss: "", box: { width: 500, height: 600 } });
      expect(doc).toContain("@page { size: 500pt 600pt; margin: 0; }");
    });

    it("rounds the @page size rather than emitting a long float", () => {
      const doc = htmlBody.buildHtmlDocument({
        bodyHtml: "x",
        bodyCss: "",
        box: { width: 500.03150400000004, height: 639.8362480000001 },
      });
      expect(doc).toContain("size: 500.03pt 639.84pt");
    });

    it("puts the author's CSS after the base sheet so it can override", () => {
      const doc = htmlBody.buildHtmlDocument({
        bodyHtml: "x",
        bodyCss: "body{color:red}",
        box: { width: 100, height: 100 },
      });
      expect(doc.indexOf("box-sizing")).toBeLessThan(doc.indexOf("body{color:red}"));
    });

    it("embeds the interpolated body", () => {
      const doc = htmlBody.buildHtmlDocument({ bodyHtml: "<p>hello</p>", bodyCss: "", box: { width: 10, height: 10 } });
      expect(doc).toContain("<p>hello</p>");
    });
  });

  describe("splitCssImports", () => {
    // CSS drops any @import that is not first, and author CSS is concatenated
    // last — so without hoisting, every webfont a template pulls is ignored
    // and it renders in the fallback face.
    it("hoists @import above every other rule", () => {
      const css = "@import url('https://fonts.googleapis.com/css2?family=Poppins');\nbody{color:red}";
      const doc = htmlBody.buildHtmlDocument({ bodyHtml: "x", bodyCss: css, box: { width: 10, height: 10 } });
      expect(doc.indexOf("@import")).toBeLessThan(doc.indexOf("@page"));
      expect(doc.indexOf("@import")).toBeLessThan(doc.indexOf("box-sizing"));
    });

    it("keeps a Google Fonts URL whole despite the semicolons in its query", () => {
      // family=Poppins:wght@400;500;600;700 — stopping at the first ";" left
      // the tail loose in the stylesheet and broke every rule after it.
      const css = "@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');\n.title{font-size:21pt}";
      const { imports, rest } = htmlBody.splitCssImports(css);
      expect(imports).toContain("display=swap");
      expect(rest).not.toContain("display=swap");
      expect(rest).toContain(".title{font-size:21pt}");
    });

    it("is a no-op for CSS with no imports", () => {
      expect(htmlBody.splitCssImports("body{color:red}")).toEqual({ imports: "", rest: "body{color:red}" });
    });

    it("handles empty/missing CSS", () => {
      expect(htmlBody.splitCssImports("")).toEqual({ imports: "", rest: "" });
      expect(htmlBody.splitCssImports(null)).toEqual({ imports: "", rest: "" });
    });
  });

  describe("isAllowedRequestUrl", () => {
    // Template HTML is AI-drafted and operator-editable, and it is handed to a
    // browser launched with --no-sandbox. Without this allow-list a template
    // could read local files or probe internal services via <img>/<link>.
    it("permits inlined data URIs", () => {
      expect(htmlBody.isAllowedRequestUrl("data:image/png;base64,AAA")).toBe(true);
    });

    it("permits Google webfont hosts", () => {
      expect(htmlBody.isAllowedRequestUrl("https://fonts.googleapis.com/css2?family=Poppins")).toBe(true);
      expect(htmlBody.isAllowedRequestUrl("https://fonts.gstatic.com/s/poppins.woff2")).toBe(true);
    });

    it("blocks local files", () => {
      expect(htmlBody.isAllowedRequestUrl("file:///etc/passwd")).toBe(false);
    });

    it("blocks internal and arbitrary remote hosts", () => {
      expect(htmlBody.isAllowedRequestUrl("http://localhost:3000/admin")).toBe(false);
      expect(htmlBody.isAllowedRequestUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
      expect(htmlBody.isAllowedRequestUrl("https://evil.example.com/x.png")).toBe(false);
    });

    it("is not fooled by an allowed host appearing later in the URL", () => {
      expect(htmlBody.isAllowedRequestUrl("https://evil.example.com/?u=https://fonts.gstatic.com/")).toBe(false);
    });
  });

  describe("renderHtmlSection guards", () => {
    // Every "cannot render" path must return null, because null is what makes
    // the caller fall back to the built-in renderer instead of failing the PDF.
    it("returns null for an empty template", async () => {
      expect(await htmlBody.renderHtmlSection({ bodyHtml: "", context: {}, box: { width: 100, height: 100 } })).toBeNull();
      expect(await htmlBody.renderHtmlSection({ bodyHtml: "   ", context: {}, box: { width: 100, height: 100 } })).toBeNull();
    });

    it("returns null for a missing or malformed box", async () => {
      expect(await htmlBody.renderHtmlSection({ bodyHtml: "<p>x</p>", context: {} })).toBeNull();
      expect(
        await htmlBody.renderHtmlSection({ bodyHtml: "<p>x</p>", context: {}, box: { width: NaN, height: 10 } }),
      ).toBeNull();
    });
  });

  describe("starter template", () => {
    it("provides a body for every fillable role and none for static", () => {
      expect(starter.starterHtmlForRole("cover")).toBeTruthy();
      expect(starter.starterHtmlForRole("itinerary")).toBeTruthy();
      expect(starter.starterHtmlForRole("details")).toBeTruthy();
      expect(starter.starterHtmlForRole("static")).toBeNull();
    });

    it("parses with an empty context — a trip missing every optional field", () => {
      for (const role of ["cover", "itinerary", "details"]) {
        expect(() => renderTemplate(starter.starterHtmlForRole(role), {})).not.toThrow();
      }
    });

    it("renders the schedule rows a real trip produces", () => {
      const out = renderTemplate(starter.starterHtmlForRole("itinerary"), {
        accent: "#00A9CE",
        title: "Goa",
        hasDays: true,
        days: [
          {
            label: "DAY I",
            hasTitle: false,
            hasRoute: true,
            route: "Airport to North Goa",
            hasLearning: false,
            items: [{ time: "06:00", activity: "Flight to Goa", hasLocation: false }],
          },
        ],
      });
      expect(out).toContain("DAY I");
      expect(out).toContain("Airport to North Goa");
      expect(out).toContain("06:00");
      expect(out).toContain("Flight to Goa");
    });

    it("falls back to a placeholder day title when the trip has none", () => {
      const out = renderTemplate(starter.starterHtmlForRole("itinerary"), {
        hasDays: true,
        days: [{ label: "DAY I", hasTitle: false, items: [] }],
      });
      expect(out).toContain("Daily Programme");
    });
  });
});
