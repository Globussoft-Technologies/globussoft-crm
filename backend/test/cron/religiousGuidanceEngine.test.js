/**
 * Unit tests for backend/cron/religiousGuidanceEngine.js — PRD §4.8 +
 * §4.10 RFU religious-guidance content delivery cron. Mirrors the
 * contactGreetingsEngine.test.js mocking pattern (hoisted prisma
 * mocks via the shared backend/lib/prisma.js singleton + per-test
 * reset).
 *
 * Branches covered:
 *   daysToDeparture (pure):
 *     - today's date (~0 days)
 *     - 5 days from now → 5
 *     - 5 days ago → -5 (already departed)
 *     - null / invalid → null
 *
 *   runReligiousGuidanceForTenant:
 *     - no active packets → fast-path {0,0}
 *     - no itineraries → fast-path {0,0}
 *     - status filter shape: subBrand="rfu" + status in ELIGIBLE + startDate not null
 *     - dayOffset match: packet at T-7d fires for itinerary 7 days out
 *     - dayOffset mismatch: packet at T-14d does NOT fire for T-7d itinerary
 *     - already-departed itinerary (daysToDeparture<0) → skipped
 *     - far-future itinerary (daysToDeparture>14) → skipped
 *     - dedup: existing year-tagged notification → skipped (no double-fire)
 *     - channels wa+email → both stub log lines printed
 *     - race-tolerance: notification.create throws → cron continues
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from "vitest";
import prisma from "../../lib/prisma.js";

import {
  runReligiousGuidanceForTenant,
  runReligiousGuidanceForAllTravelTenants,
  daysToDeparture,
  ELIGIBLE_STATUSES,
  MAX_LOOKAHEAD_DAYS,
} from "../../cron/religiousGuidanceEngine.js";

beforeAll(() => {
  prisma.religiousGuidancePacket = { findMany: vi.fn() };
  prisma.itinerary = { findMany: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  // subBrandConfig resolver pull — Q9 cut-over plumbing reads tenant
  // .subBrandConfigJson once per pass. Default mock returns null
  // config; resolver yields {} downstream.
  prisma.tenant = { findUnique: vi.fn(), findMany: vi.fn() };
});

beforeEach(() => {
  prisma.religiousGuidancePacket.findMany.mockReset();
  prisma.itinerary.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.findMany.mockReset();

  prisma.religiousGuidancePacket.findMany.mockResolvedValue([]);
  prisma.itinerary.findMany.mockResolvedValue([]);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({ subBrandConfigJson: null });
  prisma.tenant.findMany.mockResolvedValue([]);
});

describe("cron/religiousGuidanceEngine — daysToDeparture (pure)", () => {
  test("today (same instant) → 0", () => {
    const now = new Date();
    expect(daysToDeparture(now, now)).toBe(0);
  });

  test("5 days from now → 5", () => {
    const now = new Date();
    const future = new Date(now.getTime() + 5 * 86_400_000);
    expect(daysToDeparture(future, now)).toBe(5);
  });

  test("5 days ago → negative (already departed)", () => {
    const now = new Date();
    const past = new Date(now.getTime() - 5 * 86_400_000);
    // -5 or -6 depending on floor of fractional ms — both negative.
    expect(daysToDeparture(past, now)).toBeLessThan(0);
  });

  test("null / invalid → null", () => {
    expect(daysToDeparture(null)).toBeNull();
    expect(daysToDeparture(undefined)).toBeNull();
    expect(daysToDeparture("not-a-date")).toBeNull();
  });

  test("ELIGIBLE_STATUSES exports the expected booking-status whitelist", () => {
    expect(ELIGIBLE_STATUSES).toEqual([
      "sent",
      "accepted",
      "advance_paid",
      "fully_paid",
    ]);
  });

  test("MAX_LOOKAHEAD_DAYS is 14 (PRD pre-departure window)", () => {
    expect(MAX_LOOKAHEAD_DAYS).toBe(14);
  });
});

describe("cron/religiousGuidanceEngine — runReligiousGuidanceForTenant", () => {
  test("no active packets → fast-path {0,0} (no itinerary fetch)", async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([]);
    const result = await runReligiousGuidanceForTenant(42);
    expect(result).toEqual({ fired: 0, skipped: 0 });
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test("no itineraries → fast-path {0,0}", async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 1, dayOffset: 7, title: "T-7d", contentHtml: "<p>X</p>", channels: "wa,email" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([]);
    const result = await runReligiousGuidanceForTenant(42);
    expect(result).toEqual({ fired: 0, skipped: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test("query shape: tenant + subBrand=rfu + status whitelist + startDate non-null", async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 1, dayOffset: 7, title: "T-7d", contentHtml: "<p>X</p>", channels: "wa,email" },
    ]);
    await runReligiousGuidanceForTenant(42);
    expect(prisma.religiousGuidancePacket.findMany).toHaveBeenCalledTimes(1);
    const pktArg = prisma.religiousGuidancePacket.findMany.mock.calls[0][0];
    expect(pktArg.where).toEqual({ tenantId: 42, subBrand: "rfu", isActive: true });

    expect(prisma.itinerary.findMany).toHaveBeenCalledTimes(1);
    const itinArg = prisma.itinerary.findMany.mock.calls[0][0];
    expect(itinArg.where.tenantId).toBe(42);
    expect(itinArg.where.subBrand).toBe("rfu");
    expect(itinArg.where.status).toEqual({ in: ELIGIBLE_STATUSES });
    expect(itinArg.where.startDate).toEqual({ not: null });
  });

  test("dayOffset match: packet at T-7d fires for itinerary 7 days out", async () => {
    const startDate = new Date(Date.now() + 7 * 86_400_000 + 60_000); // +60s headroom for floor
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 11, dayOffset: 7, title: "One week to Umrah", contentHtml: "<p>Check list</p>", channels: "wa,email" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 500, contactId: 99, destination: "Makkah + Madinah", startDate },
    ]);

    const result = await runReligiousGuidanceForTenant(42);
    expect(result.fired).toBe(1);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.notification.create.mock.calls[0][0];
    expect(createArg.data.entityType).toBe("Itinerary");
    expect(createArg.data.entityId).toBe(500);
    expect(createArg.data.title).toContain("religious-guidance-11-itin-500");
    expect(createArg.data.title).toContain(String(new Date().getFullYear()));
    expect(createArg.data.title).toContain("🕋");
  });

  test("dayOffset mismatch: T-14d packet does NOT fire for T-7d itinerary", async () => {
    const startDate = new Date(Date.now() + 7 * 86_400_000 + 60_000);
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 11, dayOffset: 14, title: "Two weeks out", contentHtml: "<p>X</p>", channels: "wa" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 500, contactId: 99, destination: "Makkah", startDate },
    ]);

    const result = await runReligiousGuidanceForTenant(42);
    expect(result.fired).toBe(0);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test("already-departed itinerary (daysToDeparture<0) → skipped", async () => {
    const startDate = new Date(Date.now() - 3 * 86_400_000);
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      // dayOffset that would otherwise match the negative computation
      { id: 11, dayOffset: 0, title: "Day of", contentHtml: "<p>X</p>", channels: "wa" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 500, contactId: 99, destination: "Makkah", startDate },
    ]);

    const result = await runReligiousGuidanceForTenant(42);
    expect(result.fired).toBe(0);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test("far-future itinerary (daysToDeparture>14) → skipped", async () => {
    const startDate = new Date(Date.now() + 30 * 86_400_000);
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 11, dayOffset: 30, title: "30 days out", contentHtml: "<p>X</p>", channels: "wa" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 500, contactId: 99, destination: "Makkah", startDate },
    ]);

    const result = await runReligiousGuidanceForTenant(42);
    expect(result.fired).toBe(0);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test("dedup: existing year-tagged notification → skipped (no double-fire)", async () => {
    const startDate = new Date(Date.now() + 7 * 86_400_000 + 60_000);
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 11, dayOffset: 7, title: "T-7d", contentHtml: "<p>X</p>", channels: "wa" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 500, contactId: 99, destination: "Makkah", startDate },
    ]);
    prisma.notification.findFirst.mockResolvedValue({ id: 999 });

    const result = await runReligiousGuidanceForTenant(42);
    expect(result.fired).toBe(0);
    expect(result.skipped).toBe(1);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test("channels wa+email → both stub log lines printed", async () => {
    const startDate = new Date(Date.now() + 7 * 86_400_000 + 60_000);
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 11, dayOffset: 7, title: "T-7d", contentHtml: "<p>X</p>", channels: "wa,email" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 500, contactId: 99, destination: "Makkah", startDate },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runReligiousGuidanceForTenant(42);

    const allLogs = logSpy.mock.calls.flat().join("\n");
    // Log format changed when the wa channel went from pure stub-log to a
    // real watiClient dispatch (Q9 wiring) — the line is now "[wati] ..."
    // and the send itself stubs inside watiClient when creds are absent.
    expect(allLogs).toMatch(/\[wati\] religious-guidance packet 11/);
    expect(allLogs).toMatch(/\[religious-guidance\] email channel — TODO wire scheduledEmail/);
    logSpy.mockRestore();
  });

  test("race-tolerance: notification.create throws on one itin → others still fire", async () => {
    const startDate = new Date(Date.now() + 7 * 86_400_000 + 60_000);
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 11, dayOffset: 7, title: "T-7d", contentHtml: "<p>X</p>", channels: "wa" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 500, contactId: 99, destination: "Makkah", startDate },
      { id: 501, contactId: 100, destination: "Madinah", startDate },
    ]);
    prisma.notification.create
      .mockRejectedValueOnce(new Error("FK race"))
      .mockResolvedValueOnce({ id: 7 });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runReligiousGuidanceForTenant(42);
    expect(result.fired).toBe(1); // second itin succeeded
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("per-tenant scoping: only the requested tenant's data is queried", async () => {
    await runReligiousGuidanceForTenant(123);
    const pktArg = prisma.religiousGuidancePacket.findMany.mock.calls[0][0];
    expect(pktArg.where.tenantId).toBe(123);
  });

  // ---------------------------------------------------------------------
  // +8 new cases (tick #N of the test-writing cron).
  // Covers: lookahead-boundary T-14d hit, multi-channel WA+email+SMS
  // dispatch, isActive=false packet exclusion via where-clause shape,
  // sub-brand RFU-narrowing in packet + itinerary queries, dedup tag
  // year-tagging, contentHtml→snippet plain-text strip with 280-char
  // truncation, idempotency on a second pass with the same already-
  // dispatched packet, and the Q9 wabaId log line indicating which WABA
  // would route once Wati creds land.
  // ---------------------------------------------------------------------

  test("boundary T-14d hit: packet at dayOffset=14 fires for itinerary exactly 14 days out", async () => {
    // +14d + 60s headroom so floor() lands on 14, not 13.
    const startDate = new Date(Date.now() + 14 * 86_400_000 + 60_000);
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 22, dayOffset: 14, title: "Two weeks out", contentHtml: "<p>Y</p>", channels: "wa" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 600, contactId: 1, destination: "Madinah", startDate },
    ]);

    const result = await runReligiousGuidanceForTenant(42);
    expect(result.fired).toBe(1);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    const arg = prisma.notification.create.mock.calls[0][0];
    expect(arg.data.message).toContain("T-14d");
  });

  test("multi-channel dispatch: wa+email+sms packet emits all three stub log lines on a single fire", async () => {
    const startDate = new Date(Date.now() + 1 * 86_400_000 + 60_000);
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 33, dayOffset: 1, title: "T-1d final reminder", contentHtml: "<p>Ready?</p>", channels: "wa,email,sms" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 700, contactId: 7, destination: "Makkah", startDate },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runReligiousGuidanceForTenant(42);
    const out = logSpy.mock.calls.flat().join("\n");

    expect(result.fired).toBe(1);
    expect(out).toMatch(/\[wati\] religious-guidance packet 33/);
    expect(out).toMatch(/\[religious-guidance\] email channel — TODO wire scheduledEmail/);
    expect(out).toMatch(/\[religious-guidance\] sms channel — TODO/);
    logSpy.mockRestore();
  });

  test("packet where-clause includes isActive=true (inactive packets are excluded at the query layer)", async () => {
    await runReligiousGuidanceForTenant(42);
    const pktArg = prisma.religiousGuidancePacket.findMany.mock.calls[0][0];
    expect(pktArg.where.isActive).toBe(true);
    // confirm the engine does not accidentally pull all packets and filter client-side
    expect(pktArg.where.subBrand).toBe("rfu");
  });

  test("sub-brand RFU narrowing: both packet query AND itinerary query pin subBrand='rfu'", async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 11, dayOffset: 7, title: "x", contentHtml: "<p>X</p>", channels: "wa" },
    ]);
    await runReligiousGuidanceForTenant(42);

    const pktArg = prisma.religiousGuidancePacket.findMany.mock.calls[0][0];
    const itinArg = prisma.itinerary.findMany.mock.calls[0][0];
    expect(pktArg.where.subBrand).toBe("rfu");
    expect(itinArg.where.subBrand).toBe("rfu");
  });

  test("dedup tag includes current year as belt-and-braces (per-year tag prevents cross-year false-positive matches)", async () => {
    const startDate = new Date(Date.now() + 7 * 86_400_000 + 60_000);
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 11, dayOffset: 7, title: "T-7d", contentHtml: "<p>X</p>", channels: "wa" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 500, contactId: 99, destination: "Makkah", startDate },
    ]);

    await runReligiousGuidanceForTenant(42);
    const findArg = prisma.notification.findFirst.mock.calls[0][0];
    const yr = String(new Date().getFullYear());
    // tag passed to findFirst is `[religious-guidance-{packetId}-itin-{itinId}-{year}]`
    expect(findArg.where.title.contains).toBe(`[religious-guidance-11-itin-500-${yr}]`);
    expect(findArg.where.entityType).toBe("Itinerary");
    expect(findArg.where.entityId).toBe(500);
    expect(findArg.where.tenantId).toBe(42);
  });

  test("contentHtml → plain-text snippet: HTML stripped, whitespace collapsed, capped at 280 chars in message body", async () => {
    const longHtml = "<p>" + "Pack your ihram garments and Quran. ".repeat(40) + "</p>";
    const startDate = new Date(Date.now() + 7 * 86_400_000 + 60_000);
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 11, dayOffset: 7, title: "T-7d", contentHtml: longHtml, channels: "wa" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 500, contactId: 99, destination: "Makkah + Madinah", startDate },
    ]);

    await runReligiousGuidanceForTenant(42);
    const arg = prisma.notification.create.mock.calls[0][0];
    // strip tag check: no '<' or '>' from the original HTML
    expect(arg.data.message).not.toMatch(/<p>|<\/p>/);
    // the 280-char snippet head appears before the parenthetical itinerary line
    const head = arg.data.message.split(" (Itinerary ")[0];
    expect(head.length).toBeLessThanOrEqual(280);
    // and the message includes the destination + advisor link tail
    expect(arg.data.message).toContain("Makkah + Madinah");
    expect(arg.data.message).toContain("Advisor link:");
  });

  test("idempotent second pass: second invocation with same already-dispatched packet skips, does not double-create", async () => {
    const startDate = new Date(Date.now() + 7 * 86_400_000 + 60_000);
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 11, dayOffset: 7, title: "T-7d", contentHtml: "<p>X</p>", channels: "wa" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 500, contactId: 99, destination: "Makkah", startDate },
    ]);

    // First pass: no existing notification → fires
    prisma.notification.findFirst.mockResolvedValueOnce(null);
    const r1 = await runReligiousGuidanceForTenant(42);
    expect(r1.fired).toBe(1);

    // Second pass: notification now exists → skip (no second create call)
    prisma.notification.findFirst.mockResolvedValueOnce({ id: 12345 });
    const r2 = await runReligiousGuidanceForTenant(42);
    expect(r2.fired).toBe(0);
    expect(r2.skipped).toBe(1);
    // only ONE create call across both passes
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  test("Q9 cut-over plumbing: WA stub log line includes resolved wabaId from tenant.subBrandConfigJson when configured", async () => {
    const startDate = new Date(Date.now() + 7 * 86_400_000 + 60_000);
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { id: 11, dayOffset: 7, title: "T-7d", contentHtml: "<p>X</p>", channels: "wa" },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 500, contactId: 99, destination: "Makkah", startDate },
    ]);
    // configured wabaId for RFU sub-brand
    prisma.tenant.findUnique.mockResolvedValue({
      subBrandConfigJson: JSON.stringify({ rfu: { wabaId: "WABA_RFU_123" } }),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runReligiousGuidanceForTenant(42);
    const out = logSpy.mock.calls.flat().join("\n");
    expect(out).toMatch(/wabaId=WABA_RFU_123/);
    expect(out).toMatch(/subBrand=rfu/);
    logSpy.mockRestore();
  });
});

describe("cron/religiousGuidanceEngine — runReligiousGuidanceForAllTravelTenants (multi-tenant fanout)", () => {
  test("scopes tenant lookup to vertical=travel + isActive=true and continues past per-tenant errors", async () => {
    // 3 travel tenants. Middle tenant's packet fetch throws — outer loop
    // should log the error and continue with the next tenant rather
    // than aborting the whole fanout.
    prisma.tenant.findMany.mockResolvedValue([
      { id: 1, slug: "good-1" },
      { id: 2, slug: "bad-mid" },
      { id: 3, slug: "good-3" },
    ]);

    let call = 0;
    prisma.religiousGuidancePacket.findMany.mockImplementation(async ({ where }) => {
      call++;
      if (where.tenantId === 2) throw new Error("simulated tenant-2 prisma fail");
      return []; // good tenants → empty packets → fast-path {0,0}
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runReligiousGuidanceForAllTravelTenants();

    // tenant query shape
    const tArg = prisma.tenant.findMany.mock.calls[0][0];
    expect(tArg.where.vertical).toBe("travel");
    expect(tArg.where.isActive).toBe(true);

    // all 3 tenants were attempted (packet-findMany called 3×)
    expect(call).toBe(3);
    // the middle tenant error was logged but did not crash the fanout
    expect(errSpy).toHaveBeenCalled();
    // overall return is the sum of survivors → 0/0 (both survivors had no packets)
    expect(result).toEqual({ fired: 0, skipped: 0 });

    errSpy.mockRestore();
  });
});
