// Template-faithful itinerary PDF renderer.
//
// The point of this renderer is that a generated trip document keeps the
// operator's own brochure chrome (logo, address rail, footer) while the body
// is rebuilt from live CRM data — a day-banded TIME | ACTIVITY schedule plus
// the inclusions/terms blocks. These tests pin the structural contract:
// page-role handling, overflow onto extra copies of the RIGHT template page,
// static pages passing through untouched, and the day grouping/ordering the
// schedule table depends on.

import { describe, it, expect, beforeAll } from "vitest";
import { PDFDocument, rgb } from "pdf-lib";
import {
  renderItineraryOnTemplate,
  toRoman,
  groupItemsByDay,
  parseBullets,
  readSchedule,
  scaleBoxToPage,
  contrastInk,
  resolveSpec,
} from "../../services/itineraryTemplatePdf.js";

// Build a synthetic multi-page "brand template": each page carries a coloured
// header band so we can tell the pages apart after copying.
async function makeTemplate(pageCount) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    const page = pdf.addPage([595.28, 841.89]);
    page.drawRectangle({
      x: 0, y: 780, width: 595.28, height: 60,
      color: rgb(0.1 * (i + 1), 0.4, 0.8),
    });
  }
  return Buffer.from(await pdf.save());
}

function makeItem(over = {}) {
  return {
    id: over.id ?? Math.floor(Math.random() * 1e6),
    itemType: "activity",
    description: "Facilities tour",
    position: 0,
    dayNumber: 1,
    startTime: null,
    endTime: null,
    locationName: null,
    detailsJson: null,
    totalPrice: 1000,
    ...over,
  };
}

const BASE_ITINERARY = {
  title: "Aviation Discovery",
  destination: "Bangalore",
  currency: "INR",
  pax: 45,
  totalAmount: 45000,
  introText: "An immersive day exploring the world of aviation.\n\nStudents gain hands-on insight into flight.",
  inclusionsJson: JSON.stringify(["1 Lunch", "All activities mentioned", "Tour directors"]),
  exclusionsJson: JSON.stringify(["Transfers to & from school", "Personal expenses"]),
  otherDetailsJson: JSON.stringify(["1 teacher per 20 students"]),
  termsText: "Cancellations are effective on the date written intimation is received.",
  items: [],
};

const FOUR_PAGE_SPEC = {
  accentColor: "#00A9CE",
  pages: [
    { index: 1, role: "cover" },
    { index: 2, role: "itinerary" },
    { index: 3, role: "details" },
    { index: 4, role: "static" },
  ],
};

describe("itineraryTemplatePdf — pure helpers", () => {
  it("labels days in Roman numerals the way brochures do", () => {
    expect(toRoman(1)).toBe("I");
    expect(toRoman(4)).toBe("IV");
    expect(toRoman(9)).toBe("IX");
    expect(toRoman(14)).toBe("XIV");
  });

  it("orders a day by time, then by position for untimed items", () => {
    const groups = groupItemsByDay([
      makeItem({ id: 1, dayNumber: 1, startTime: "13:30", description: "Workshop" }),
      makeItem({ id: 2, dayNumber: 1, startTime: "07:45", description: "Assemble" }),
      makeItem({ id: 3, dayNumber: 1, startTime: null, position: 9, description: "Untimed late" }),
      makeItem({ id: 4, dayNumber: 1, startTime: null, position: 2, description: "Untimed early" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.description)).toEqual([
      "Assemble", "Workshop", "Untimed early", "Untimed late",
    ]);
  });

  it("sorts day groups ascending and parks day-less items in a trailing bucket", () => {
    const groups = groupItemsByDay([
      makeItem({ id: 1, dayNumber: 3 }),
      makeItem({ id: 2, dayNumber: null }),
      makeItem({ id: 3, dayNumber: 1 }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["DAY I", "DAY III", "ADDITIONAL"]);
  });

  it("reads times from detailsJson for rows written before the columns existed", () => {
    const legacy = makeItem({
      startTime: null,
      detailsJson: JSON.stringify({ startTime: "09:45", locationName: "MyFlying Academy" }),
    });
    expect(readSchedule(legacy)).toMatchObject({
      startTime: "09:45",
      locationName: "MyFlying Academy",
    });
  });

  it("prefers the real column over a stale detailsJson copy", () => {
    const item = makeItem({
      startTime: "10:00",
      detailsJson: JSON.stringify({ startTime: "09:45" }),
    });
    expect(readSchedule(item).startTime).toBe("10:00");
  });

  it("accepts bullets as a JSON array or a newline block", () => {
    expect(parseBullets(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
    expect(parseBullets("a\n b \n\nc")).toEqual(["a", "b", "c"]);
    expect(parseBullets(null)).toEqual([]);
  });

  it("scales a content box when the template page size changed", () => {
    const box = scaleBoxToPage(
      { x: 30, y: 100, width: 500, height: 600 },
      { width: 595, height: 842 },
      { width: 1190, height: 1684 },
    );
    expect(box.x).toBeCloseTo(60, 0);
    expect(box.width).toBeCloseTo(1000, 0);
    expect(box.height).toBeCloseTo(1200, 0);
  });

  it("keeps band text readable on both light and dark accents", () => {
    expect(contrastInk("#00A9CE")).toBe("#ffffff");
    expect(contrastInk("#FFE800")).toBe("#1a1a1a");
  });

  // Regression: every template uploaded before per-page role classification
  // existed (pdfStyleSpecJson) has styleSpec=null. resolveSpec used to leave
  // every page's role as null in that case, which made the "ensure a
  // schedule page exists" promotion in the main renderer grab page 1 —
  // almost always the COVER — and stamp the day-by-day table onto it, while
  // every other page (costing, contact) silently passed through untouched
  // (i.e. rendered mostly blank, since blanking had already wiped their
  // content). This is the exact bug a real uploaded template hit in
  // production: cover page showed the intro text bleeding through under a
  // plain activity table, and the costing/contact pages came out blank.
  it("classifies pages with the cover/itinerary/details/static heuristic when no style spec is stored", () => {
    const sizes = [
      { width: 595.28, height: 841.89 },
      { width: 595.28, height: 841.89 },
      { width: 595.28, height: 841.89 },
      { width: 595.28, height: 841.89 },
    ];
    const { pages } = resolveSpec({ styleSpec: null, regions: null, srcPageSizes: sizes });
    expect(pages.map((p) => p.role)).toEqual(["cover", "itinerary", "details", "static"]);
    // The bug specifically: page index 0 (page 1, the cover) must NOT be
    // the one carrying the schedule.
    expect(pages[0].role).not.toBe("itinerary");
  });

  it("still classifies sensibly when styleSpec is present but has an empty pages array", () => {
    const sizes = [{ width: 595.28, height: 841.89 }, { width: 595.28, height: 841.89 }];
    const { pages } = resolveSpec({ styleSpec: { accentColor: "#00A9CE", pages: [] }, regions: null, srcPageSizes: sizes });
    expect(pages.some((p) => p.role === "itinerary")).toBe(true);
    expect(pages[0].role).not.toBe("itinerary");
  });
});

describe("itineraryTemplatePdf — rendering", () => {
  let template4;
  beforeAll(async () => {
    template4 = await makeTemplate(4);
  });

  it("emits one output page per template page for a short trip", async () => {
    const itinerary = {
      ...BASE_ITINERARY,
      items: [
        makeItem({ id: 1, dayNumber: 1, startTime: "07:45", description: "Assemble in school" }),
        makeItem({ id: 2, dayNumber: 1, startTime: "09:45", description: "Arrive at the academy" }),
      ],
    };
    const buf = await renderItineraryOnTemplate(itinerary, { name: "Test School" }, {
      templateBuffer: template4,
      styleSpec: FOUR_PAGE_SPEC,
    });
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    const out = await PDFDocument.load(buf);
    expect(out.getPageCount()).toBe(4);
  });

  it("grows onto extra pages when the schedule is too long for one", async () => {
    const many = Array.from({ length: 90 }, (_, i) =>
      makeItem({
        id: i + 1,
        dayNumber: Math.floor(i / 10) + 1,
        startTime: `${String(8 + (i % 10)).padStart(2, "0")}:00`,
        description: `Activity ${i + 1} with a deliberately long description so rows wrap onto multiple lines`,
      }));
    const buf = await renderItineraryOnTemplate({ ...BASE_ITINERARY, items: many }, null, {
      templateBuffer: template4,
      styleSpec: FOUR_PAGE_SPEC,
    });
    const out = await PDFDocument.load(buf);
    // cover + N schedule pages + details + static, N > 1
    expect(out.getPageCount()).toBeGreaterThan(4);
  });

  it("never drops the schedule when no page is tagged 'itinerary'", async () => {
    const spec = {
      accentColor: "#00A9CE",
      pages: [
        { index: 1, role: "cover" },
        { index: 2, role: "details" },
        { index: 3, role: "details" },
        { index: 4, role: "static" },
      ],
    };
    const itinerary = {
      ...BASE_ITINERARY,
      items: [makeItem({ id: 1, dayNumber: 1, startTime: "07:45" })],
    };
    const buf = await renderItineraryOnTemplate(itinerary, null, {
      templateBuffer: template4,
      styleSpec: spec,
    });
    const out = await PDFDocument.load(buf);
    expect(out.getPageCount()).toBe(4);
  });

  it("falls back to the legacy single contentBox when no style spec is stored", async () => {
    const itinerary = {
      ...BASE_ITINERARY,
      items: [makeItem({ id: 1, dayNumber: 1, startTime: "07:45" })],
    };
    const buf = await renderItineraryOnTemplate(itinerary, null, {
      templateBuffer: template4,
      regions: {
        pageSize: { width: 595.28, height: 841.89 },
        contentBox: { x: 30, y: 90, width: 535, height: 650 },
      },
    });
    const out = await PDFDocument.load(buf);
    // Every page is untagged → all pass through, none are corrupted.
    expect(out.getPageCount()).toBe(4);
    expect(buf.length).toBeGreaterThan(500);
  });

  it("renders a trip with no items at all rather than throwing", async () => {
    const buf = await renderItineraryOnTemplate({ ...BASE_ITINERARY, items: [] }, null, {
      templateBuffer: template4,
      styleSpec: FOUR_PAGE_SPEC,
    });
    const out = await PDFDocument.load(buf);
    expect(out.getPageCount()).toBe(4);
  });

  // Regression: a reference example's OWN schedule sometimes spans more than
  // one physical page (e.g. a 3-day sample where days spill from page 2 onto
  // page 3, both sharing the same design). Before the fix, each page tagged
  // "itinerary" was rendered independently — meaning the FULL real itinerary
  // got drawn once per tagged page, duplicating the whole schedule across
  // pages 2 AND 3 instead of treating them as one continuous, growable
  // section. This is exactly the scenario the operator will hit when their
  // uploaded example (however many days it shows) is reused for a real trip
  // of a different length.
  it("does not duplicate the schedule when the reference template has multiple consecutive itinerary-tagged pages", async () => {
    const template4 = await makeTemplate(4);
    const spec = {
      accentColor: "#00A9CE",
      pages: [
        { index: 1, role: "cover" },
        { index: 2, role: "itinerary" }, // example's own schedule spanned 2 pages
        { index: 3, role: "itinerary" },
        { index: 4, role: "static" },
      ],
    };
    // Small schedule — comfortably fits on ONE generated content page, so if
    // grouping works, page 3 (redundant) is skipped entirely: cover + one
    // itinerary page + static = 3 output pages, not 4.
    const itinerary = {
      ...BASE_ITINERARY,
      items: [
        makeItem({ id: 1, dayNumber: 1, startTime: "07:45", description: "Assemble" }),
        makeItem({ id: 2, dayNumber: 1, startTime: "09:00", description: "Depart" }),
      ],
    };
    const buf = await renderItineraryOnTemplate(itinerary, null, { templateBuffer: template4, styleSpec: spec });
    const out = await PDFDocument.load(buf);
    expect(out.getPageCount()).toBe(3);
  });

  it("groups multiple consecutive itinerary pages but still overflows onto a 4th physical copy when the real trip genuinely needs it", async () => {
    const template4 = await makeTemplate(4);
    const spec = {
      accentColor: "#00A9CE",
      pages: [
        { index: 1, role: "cover" },
        { index: 2, role: "itinerary" },
        { index: 3, role: "itinerary" },
        { index: 4, role: "static" },
      ],
    };
    const many = Array.from({ length: 60 }, (_, i) =>
      makeItem({
        id: i + 1,
        dayNumber: Math.floor(i / 8) + 1,
        startTime: `${String(8 + (i % 8)).padStart(2, "0")}:00`,
        description: `Activity ${i + 1} with a deliberately long description so rows wrap onto multiple lines and force overflow`,
      }));
    const buf = await renderItineraryOnTemplate({ ...BASE_ITINERARY, items: many }, null, {
      templateBuffer: template4, styleSpec: spec,
    });
    const out = await PDFDocument.load(buf);
    // cover(1) + itinerary(N>1, driven by real content, not the example's 2
    // physical pages) + static(1) — page count reflects the REAL trip's
    // length, never capped at what the reference example happened to show.
    expect(out.getPageCount()).toBeGreaterThan(4);
  });

  it("renders when the itinerary carries no inclusions/terms content", async () => {
    const bare = {
      destination: "Goa",
      currency: "INR",
      pax: 1,
      totalAmount: null,
      items: [makeItem({ id: 1, dayNumber: 1, description: "Beach walk" })],
    };
    const buf = await renderItineraryOnTemplate(bare, null, {
      templateBuffer: template4,
      styleSpec: FOUR_PAGE_SPEC,
    });
    const out = await PDFDocument.load(buf);
    expect(out.getPageCount()).toBe(4);
  });

  it("works with a single-page template", async () => {
    const template1 = await makeTemplate(1);
    const itinerary = {
      ...BASE_ITINERARY,
      items: [makeItem({ id: 1, dayNumber: 1, startTime: "07:45" })],
    };
    const buf = await renderItineraryOnTemplate(itinerary, null, {
      templateBuffer: template1,
      styleSpec: { accentColor: "#00A9CE", pages: [{ index: 1, role: "itinerary" }] },
    });
    const out = await PDFDocument.load(buf);
    expect(out.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("rejects a missing template buffer instead of producing a broken file", async () => {
    await expect(
      renderItineraryOnTemplate(BASE_ITINERARY, null, { templateBuffer: null }),
    ).rejects.toThrow(/templateBuffer/i);
  });
});
