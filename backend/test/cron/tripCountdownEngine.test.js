// Unit tests for cron/tripCountdownEngine.js — scan → fire-gate → idempotent
// claim → email.
//
// Mocking strategy: import the real singletons and monkeypatch their methods
// (the proven idiom in this repo — vi.mock can't intercept the SUT's CJS
// require chain under this vitest setup; see leadScoringEngine.test.js). prisma
// + emailSender + content.buildNudge are read at call time through their module
// objects, so the patches take effect. shouldFire/dayTag stay REAL so the
// fire-schedule behaviour is exercised end-to-end.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

// createRequire (not ESM `import`) so the singletons we monkeypatch are the
// *same* instances the cron + SUT hold via their CJS `require(...)` — an ESM
// default-import yields a separate namespace and the patches wouldn't take.
const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS("../../lib/prisma");
const emailSender = requireCJS("../../lib/emailSender");
const content = requireCJS("../../lib/tripCountdownContent");
const { runTripCountdownTick } = requireCJS("../../cron/tripCountdownEngine");

const NOW = new Date("2026-06-20T09:00:00Z");
const plusDays = (n) => new Date(Date.UTC(2026, 5, 20 + n, 9, 0, 0)); // 2026-06-20 + n days

beforeEach(() => {
  prisma.itinerary = { findMany: vi.fn() };
  prisma.contact = { findMany: vi.fn() };
  prisma.tripCountdownNudge = { create: vi.fn(), update: vi.fn() };
  emailSender.sendEmail = vi.fn();
  content.buildNudge = vi.fn(async () => ({ subject: "S", text: "T", html: "T", llmSourced: false }));

  prisma.contact.findMany.mockResolvedValue([{ id: 7, name: "Mohit", email: "mohit@example.com" }]);
  prisma.tripCountdownNudge.create.mockResolvedValue({ id: 100 });
  prisma.tripCountdownNudge.update.mockResolvedValue({});
  emailSender.sendEmail.mockResolvedValue({ sent: true });
});

function itin(overrides = {}) {
  return { id: 1, tenantId: 1, subBrand: "travelstall", contactId: 7, destination: "Hyderabad", startDate: plusDays(5), ...overrides };
}

describe("tripCountdownEngine.runTripCountdownTick", () => {
  it("fires + emails a confirmed itinerary on a fire-day (T-5)", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin()]);
    const s = await runTripCountdownTick(NOW);
    expect(prisma.tripCountdownNudge.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ itineraryId: 1, dayTag: "d5", channel: "email" }) }),
    );
    expect(content.buildNudge).toHaveBeenCalledWith(expect.objectContaining({ daysToGo: 5, destination: "Hyderabad", customerName: "Mohit" }));
    expect(emailSender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "mohit@example.com", subject: "S" }));
    expect(prisma.tripCountdownNudge.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "sent" }) }));
    expect(s).toMatchObject({ fired: 1, sent: 1 });
  });

  it("skips a non-fire day (T-10) — no claim, no email", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin({ startDate: plusDays(10) })]);
    const s = await runTripCountdownTick(NOW);
    expect(prisma.tripCountdownNudge.create).not.toHaveBeenCalled();
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
    expect(s).toMatchObject({ fired: 0, skipped: 1 });
  });

  it("is idempotent — a unique-violation on the claim skips without emailing", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin()]);
    prisma.tripCountdownNudge.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const s = await runTripCountdownTick(NOW);
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
    expect(s).toMatchObject({ fired: 0, skipped: 1 });
  });

  it("skips an itinerary whose contact has no email", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin()]);
    prisma.contact.findMany.mockResolvedValue([{ id: 7, name: "Mohit", email: null }]);
    const s = await runTripCountdownTick(NOW);
    expect(prisma.tripCountdownNudge.create).not.toHaveBeenCalled();
    expect(s).toMatchObject({ fired: 0, skipped: 1 });
  });

  it("records 'logged' (not 'sent') when SendGrid is unconfigured", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin({ startDate: plusDays(1) })]);
    emailSender.sendEmail.mockResolvedValue({ sent: false, reason: "no_api_key" });
    const s = await runTripCountdownTick(NOW);
    expect(prisma.tripCountdownNudge.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "logged" }) }));
    expect(s).toMatchObject({ fired: 1, sent: 0 });
  });
});
