// Unit tests for lib/travelWhatsappLeadCapture.js — the WhatsApp → Travel
// auto-lead capture. prisma singleton monkeypatched via createRequire (proven
// idiom). NODE_ENV='test' makes llmRouter stub, so classification falls through
// to the deterministic keyword heuristic — exactly the no-Q11-key demo path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS("../../lib/prisma");
const cap = requireCJS("../../lib/travelWhatsappLeadCapture");

const travelMsgs = [
  "Hi, I want to plan a trip to Bali for 4 people in December",
  "What's the package price?",
  "Do you handle the hotel and flight booking too?",
];

beforeEach(() => {
  cap._verticalCache.clear();
  cap._lastAnalyzedCount.clear();
  prisma.tenant = { findUnique: vi.fn(async () => ({ vertical: "travel" })) };
  prisma.contact = {
    findFirst: vi.fn(async () => null), // no existing lead
    create: vi.fn(async ({ data }) => ({ id: 501, ...data })),
  };
  prisma.whatsAppMessage = {
    count: vi.fn(async () => 3), // ≥ MIN_INBOUND
    findMany: vi.fn(async () => travelMsgs.map((b) => ({ body: b })).reverse()), // desc order
  };
  prisma.whatsAppThread = { update: vi.fn(async () => ({})) };
  prisma.touchpoint = { create: vi.fn(async () => ({})) };
});

describe("heuristicClassify", () => {
  it("flags a travel enquiry + extracts destination/pax/sub-brand", () => {
    const r = cap.heuristicClassify("I want a trip to Bali for 4 people, what's the package price?");
    expect(r.isEnquiry).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(cap.CONFIDENCE_THRESHOLD);
    expect(r.destination).toMatch(/Bali/i);
    expect(r.pax).toBe(4);
    expect(r.suggestedSubBrand).toBe("travelstall");
  });
  it("routes umrah/visa keywords to the right sub-brand", () => {
    expect(cap.heuristicClassify("need umrah package for makkah").suggestedSubBrand).toBe("rfu");
    expect(cap.heuristicClassify("how much for a tourist visa to dubai").suggestedSubBrand).toBe("visasure");
  });
  it("does NOT flag personal / non-travel chatter", () => {
    expect(cap.heuristicClassify("hey are we still meeting for lunch tomorrow?").isEnquiry).toBe(false);
    expect(cap.heuristicClassify("").isEnquiry).toBe(false);
  });
});

describe("maybeCaptureLead", () => {
  it("creates a Travel lead from a business chat after a few messages", async () => {
    const r = await cap.maybeCaptureLead({ tenantId: 7, phone: "+919876543210", name: "Asha", threadId: 99 });
    expect(r.created).toBe(true);
    const createArg = prisma.contact.create.mock.calls[0][0].data;
    expect(createArg).toMatchObject({ tenantId: 7, phone: "+919876543210", source: "whatsapp", status: "Lead" });
    expect(createArg.email).toBe(null); // blank — asked for in chat, filled later
    expect(typeof createArg.aiScore).toBe("number"); // conversation-based score
    expect(createArg.aiScore).toBeGreaterThan(0);
    expect(createArg.aiScoreLastComputedAt).toBeInstanceOf(Date); // so the scoring cron doesn't immediately overwrite it
    // links the thread + writes an attribution touchpoint
    expect(prisma.whatsAppThread.update).toHaveBeenCalled();
    expect(prisma.touchpoint.create).toHaveBeenCalled();
  });

  it("skips when the tenant is not travel", async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ vertical: "wellness" });
    const r = await cap.maybeCaptureLead({ tenantId: 8, phone: "+1", threadId: 1 });
    expect(r.skipped).toBe("not-travel");
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  it("skips (no duplicate) when a contact already exists for the phone", async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 1 });
    const r = await cap.maybeCaptureLead({ tenantId: 7, phone: "+919876543210", threadId: 99 });
    expect(r.skipped).toBe("exists");
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  it("skips below the message threshold (waits for context)", async () => {
    prisma.whatsAppMessage.count.mockResolvedValueOnce(1);
    const r = await cap.maybeCaptureLead({ tenantId: 7, phone: "+919876543210", threadId: 99 });
    expect(r.skipped).toBe("below-threshold");
  });

  it("does NOT create a lead for a non-business conversation", async () => {
    prisma.whatsAppMessage.findMany.mockResolvedValueOnce([{ body: "lunch tomorrow?" }, { body: "ok cool" }]);
    const r = await cap.maybeCaptureLead({ tenantId: 7, phone: "+10000000000", threadId: 42 });
    expect(r.skipped).toBe("not-enquiry");
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  it("skips group chats", async () => {
    const r = await cap.maybeCaptureLead({ tenantId: 7, phone: "123@g.us", threadId: 99, isGroup: true });
    expect(r.skipped).toBe("ineligible");
  });
});
