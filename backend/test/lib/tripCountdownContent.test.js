// Unit tests for lib/tripCountdownContent.js — the pre-trip nudge copy.
//
// Mocking strategy: this repo's vitest setup does NOT reliably let vi.mock()
// intercept a CJS module's `require()` chain (see the comment blocks in
// test/cron/leadScoringEngine.test.js + dealInsightsEngine-tick.test.js). The
// proven idiom is to import the real singleton and monkeypatch the method —
// llmRouter is inlined (vitest.config server.deps.inline) so the object the
// SUT holds and the object we import here are the same instance. buildNudge
// reads `llmRouter.routeRequest` at call time, so the patch takes effect.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

// createRequire (not ESM `import`) so the llmRouter object we monkeypatch is
// the *same* instance the SUT holds via its CJS `require("./llmRouter")` — an
// ESM default-import yields a separate namespace and the patch wouldn't take.
const requireCJS = createRequire(import.meta.url);
const llmRouter = requireCJS("../../lib/llmRouter");
const content = requireCJS("../../lib/tripCountdownContent");

describe("tripCountdownContent — fire schedule", () => {
  it("fires on the early check-ins + the final week, daily", () => {
    expect(content.FIRE_DAYS).toEqual([30, 14, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(content.shouldFire(5)).toBe(true);
    expect(content.shouldFire(0)).toBe(true);
    expect(content.shouldFire(10)).toBe(false); // not a fire day
    expect(content.shouldFire(-1)).toBe(false); // trip already started
    expect(content.dayTag(5)).toBe("d5");
  });
});

describe("tripCountdownContent — fallback templates", () => {
  it("interpolates destination + name and differs across days", () => {
    const five = content.buildFallbackNudge({ destination: "Hyderabad", daysToGo: 5, customerName: "Mohit" });
    expect(five.subject).toMatch(/5 days/i);
    expect(five.text).toContain("Hyderabad");
    expect(five.text).toContain("Mohit");
    expect(five.llmSourced).toBe(false);
    expect(five.html).toContain("<br>");

    const zero = content.buildFallbackNudge({ destination: "Hyderabad", daysToGo: 0, customerName: "Mohit" });
    expect(zero.subject).not.toBe(five.subject); // creative variety: T-0 ≠ T-5
    expect(zero.subject).toMatch(/bon voyage|amazing/i);
  });

  it("falls back gracefully when name/destination are missing", () => {
    const n = content.buildFallbackNudge({ daysToGo: 7 });
    expect(n.text).toContain("traveller");
    expect(n.text).toContain("your destination");
  });
});

describe("tripCountdownContent — buildNudge (LLM ↔ fallback)", () => {
  beforeEach(() => {
    llmRouter.routeRequest = vi.fn();
  });

  it("uses the template fallback when the LLM is in stub mode", async () => {
    llmRouter.routeRequest.mockResolvedValue({ stub: true, text: "" });
    const n = await content.buildNudge({ tenantId: 1, destination: "Goa", daysToGo: 3, customerName: "A" });
    expect(n.llmSourced).toBe(false);
    expect(n.text).toContain("Goa");
  });

  it("uses LLM copy when a non-stub JSON {subject,body} comes back", async () => {
    llmRouter.routeRequest.mockResolvedValue({ stub: false, text: '{"subject":"3 days to Goa!","body":"Pack your bags, {name}!"}' });
    const n = await content.buildNudge({ tenantId: 1, destination: "Goa", daysToGo: 3, customerName: "Asha" });
    expect(n.llmSourced).toBe(true);
    expect(n.subject).toBe("3 days to Goa!");
    expect(n.text).toContain("Asha"); // {name} still interpolated
  });

  it("falls back when the LLM returns unparseable text", async () => {
    llmRouter.routeRequest.mockResolvedValue({ stub: false, text: "not json" });
    const n = await content.buildNudge({ tenantId: 1, destination: "Goa", daysToGo: 3, customerName: "A" });
    expect(n.llmSourced).toBe(false);
  });
});
