import { describe, expect, it } from "vitest";
import {
  normalizeRelativeBox,
  normalizeRequiredFields,
  normalizeTemplateDesign,
} from "../../lib/aiPdfTemplateAnalysis.js";

describe("AI PDF template design normalization", () => {
  it("keeps supported visual traits and clamps unsafe values", () => {
    expect(normalizeTemplateDesign({
      typography: "serif",
      headingCase: "uppercase",
      coverAlignment: "center",
      heroPosition: "before-title",
      heroTreatment: "edge-to-edge",
      tableStyle: "cards",
      tableHeaderStyle: "dark",
      dayBandStyle: "outline",
      dayBandLayout: "split-title",
      showRouteStrip: true,
      showLearningBox: true,
      timeColumnRatio: 0.24,
      continuationStyle: "table-only",
      density: "airy",
      borderRadius: 99,
      textColor: "#222222",
      mutedColor: "invalid",
      secondaryColor: "#101820",
    })).toMatchObject({
      typography: "serif",
      headingCase: "uppercase",
      coverAlignment: "center",
      heroTreatment: "edge-to-edge",
      tableStyle: "cards",
      tableHeaderStyle: "dark",
      dayBandStyle: "outline",
      dayBandLayout: "split-title",
      showRouteStrip: true,
      showLearningBox: true,
      timeColumnRatio: 0.24,
      continuationStyle: "table-only",
      density: "airy",
      borderRadius: 16,
      textColor: "#222222",
      mutedColor: "#5B6470",
      secondaryColor: "#101820",
    });
  });

  it("returns null when AI omitted the design object", () => {
    expect(normalizeTemplateDesign(null)).toBeNull();
  });

  it("normalizes page replacement boxes and template-specific fields", () => {
    expect(normalizeRelativeBox({ x: -1, y: 0.1, width: 2, height: 0.8 })).toEqual({
      x: 0, y: 0.1, width: 1, height: 0.8,
    });
    expect(normalizeRequiredFields([
      { key: "trip-style", label: "Trip style", type: "textarea", required: true, source: "custom", pageIndex: 1 },
      { key: "trip-style", label: "Duplicate" },
      { key: "destination", label: "Destination", source: "auto", pageIndex: 1 },
    ])).toEqual([
      // `hint` is an added field: a short note on where the value appears in
      // the template, so the editor can explain what it is asking for instead
      // of showing a bare label. Absent input normalises to "".
      { key: "tripstyle", label: "Trip style", type: "textarea", required: true, source: "custom", pageIndex: 1, hint: "" },
      { key: "destination", label: "Destination", type: "text", required: false, source: "auto", pageIndex: 1, hint: "" },
    ]);
  });
});
