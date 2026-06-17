// Unit tests for lib/webCheckinContent.js — web check-in reminder EMAIL copy
// (built from a WebCheckin row's flight fields). Pure module (no LLM, no I/O).

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const content = requireCJS("../../lib/webCheckinContent");

describe("webCheckinContent — milestone windows", () => {
  it("exposes the 36/24/12h milestones", () => {
    expect(content.MILESTONES).toEqual([36, 24, 12]);
    expect(content.milestoneTag(36)).toBe("h36");
    expect(content.milestoneTag(12)).toBe("h12");
  });

  it("maps hours-to-departure into disjoint 12h windows", () => {
    expect(content.dueMilestone(36)).toBe(36);
    expect(content.dueMilestone(30)).toBe(36);
    expect(content.dueMilestone(24)).toBe(24);
    expect(content.dueMilestone(20)).toBe(24);
    expect(content.dueMilestone(12)).toBe(12);
    expect(content.dueMilestone(1)).toBe(12);
    expect(content.dueMilestone(40)).toBe(null);
    expect(content.dueMilestone(0)).toBe(null);
    expect(content.dueMilestone(-5)).toBe(null);
  });
});

describe("webCheckinContent — flightLabel", () => {
  it("joins airline + flight, falls back when missing", () => {
    expect(content.flightLabel({ airlineCode: "AI", flightNumber: "302" })).toBe("AI 302");
    expect(content.flightLabel({})).toBe("your flight");
  });
});

describe("webCheckinContent — buildReminder", () => {
  const base = { passengerName: "Mohit", airlineCode: "AI", flightNumber: "302", pnr: "ABC123", portalUrl: "https://app/travel/portal" };

  it("interpolates passenger/flight/pnr/portal and varies copy per milestone", () => {
    const h36 = content.buildReminder({ ...base, milestone: 36 });
    expect(h36.subject).toContain("AI 302");
    expect(h36.text).toContain("Mohit");
    expect(h36.text).toContain("ABC123");
    expect(h36.text).toContain("https://app/travel/portal");
    expect(h36.html).toContain("<br>");

    const h24 = content.buildReminder({ ...base, milestone: 24 });
    const h12 = content.buildReminder({ ...base, milestone: 12 });
    expect(h24.subject).not.toBe(h36.subject);
    expect(h12.subject).toMatch(/last reminder/i);
  });

  it("falls back gracefully when fields are missing", () => {
    const n = content.buildReminder({ milestone: 24 });
    expect(n.text).toContain("traveller");
    expect(n.text).toContain("your flight");
    expect(n.text).toContain("your customer portal");
  });
});
