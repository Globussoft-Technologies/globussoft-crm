// Unit tests for lib/paymentDeadlineContent.js — the pay-or-cancel deposit
// reminder copy. llmRouter is grabbed via createRequire + monkeypatched (the
// proven idiom in this repo — vi.mock can't reach the SUT's CJS require chain;
// see test/lib/tripCountdownContent.test.js).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const llmRouter = requireCJS("../../lib/llmRouter");
const content = requireCJS("../../lib/paymentDeadlineContent");

describe("paymentDeadlineContent — reminder schedule", () => {
  it("reminds across the T-10 → T-7 run-up only", () => {
    expect(content.FIRE_DAYS).toEqual([10, 9, 8, 7]);
    expect(content.shouldRemind(10)).toBe(true);
    expect(content.shouldRemind(7)).toBe(true);
    expect(content.shouldRemind(6)).toBe(false); // T-6 is the overdue case, not a reminder
    expect(content.shouldRemind(11)).toBe(false);
    expect(content.dayTag(10)).toBe("d10");
  });
});

describe("paymentDeadlineContent — formatMoney", () => {
  it("uses ₹ for INR, the code for others, and a safe label for nothing", () => {
    expect(content.formatMoney(50000, "INR")).toBe("₹50,000");
    expect(content.formatMoney(50000, "USD")).toBe("USD 50,000");
    expect(content.formatMoney(0, "INR")).toBe("the deposit");
    expect(content.formatMoney(null, "INR")).toBe("the deposit");
  });
});

describe("paymentDeadlineContent — fallback templates", () => {
  const base = { destination: "Goa", customerName: "Mohit", depositAmount: 50000, currency: "INR", deadlineLabel: "13 Jun 2026" };

  it("interpolates dest/name/amount/deadline and escalates across days", () => {
    const ten = content.buildFallbackReminder({ ...base, daysToGo: 10 });
    expect(ten.text).toContain("Goa");
    expect(ten.text).toContain("Mohit");
    expect(ten.text).toContain("₹50,000");
    expect(ten.text).toContain("13 Jun 2026");
    expect(ten.html).toContain("<br>");
    expect(ten.llmSourced).toBe(false);

    const seven = content.buildFallbackReminder({ ...base, daysToGo: 7 });
    expect(seven.subject).not.toBe(ten.subject); // distinct copy per day
    expect(seven.subject).toMatch(/today/i); // T-7 is the deadline-day urgency
  });

  it("falls back gracefully when name/destination/amount are missing", () => {
    const n = content.buildFallbackReminder({ daysToGo: 9 });
    expect(n.text).toContain("traveller");
    expect(n.text).toContain("your destination");
    expect(n.text).toContain("the deposit");
  });
});

describe("paymentDeadlineContent — overdue notice + advisor flag", () => {
  it("builds an at-risk customer notice (fixed wording, no LLM)", () => {
    const n = content.buildOverdueNotice({ destination: "Goa", customerName: "Mohit", depositAmount: 50000, currency: "INR" });
    expect(n.subject).toMatch(/at risk|overdue/i);
    expect(n.text).toContain("Goa");
    expect(n.text).toMatch(/at risk|overdue|deadline has now passed/i);
    expect(n.llmSourced).toBe(false);
  });

  it("builds an advisor flag pointing at the itinerary + the 'expired' action", () => {
    const f = content.buildOverdueAdvisorFlag({ destination: "Goa", customerName: "Mohit", depositAmount: 50000, currency: "INR", itineraryId: 42 });
    expect(f.title).toMatch(/review for cancellation/i);
    expect(f.message).toContain("#42");
    expect(f.message).toContain("expired");
  });
});

describe("paymentDeadlineContent — buildReminder (LLM ↔ fallback)", () => {
  const base = { tenantId: 1, destination: "Goa", customerName: "Asha", depositAmount: 50000, currency: "INR", daysToGo: 9, deadlineLabel: "13 Jun 2026" };

  beforeEach(() => {
    llmRouter.routeRequest = vi.fn();
  });

  it("uses the template fallback when the LLM is in stub mode", async () => {
    llmRouter.routeRequest.mockResolvedValue({ stub: true, text: "" });
    const n = await content.buildReminder(base);
    expect(n.llmSourced).toBe(false);
    expect(n.text).toContain("Goa");
  });

  it("uses LLM copy when a non-stub JSON {subject,body} comes back", async () => {
    llmRouter.routeRequest.mockResolvedValue({ stub: false, text: '{"subject":"Pay your Goa deposit","body":"Hi {name}, deposit due soon."}' });
    const n = await content.buildReminder(base);
    expect(n.llmSourced).toBe(true);
    expect(n.subject).toBe("Pay your Goa deposit");
    expect(n.text).toContain("Asha"); // {name} interpolated
  });

  it("falls back when the LLM returns unparseable text", async () => {
    llmRouter.routeRequest.mockResolvedValue({ stub: false, text: "not json" });
    const n = await content.buildReminder(base);
    expect(n.llmSourced).toBe(false);
  });
});
