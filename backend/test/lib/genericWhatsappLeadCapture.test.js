// Unit tests for backend/lib/genericWhatsappLeadCapture.js
//
// What this module does:
//   Auto-lead capture from inbound WhatsApp for GENERIC-vertical tenants on the
//   Meta Cloud transport. Sibling of lib/travelWhatsappLeadCapture.js (which is
//   travel-gated and wired to the WhatsApp Web QR transport instead). Before
//   this module the Meta webhook invoked no lead capture at all.
//
// Surface area covered (19 cases):
//   - heuristicClassify (6): enquiry keywords qualify, strong intent lifts
//                            confidence, bare greeting does not qualify,
//                            spam/negative signal suppresses, empty → 0,
//                            confidence is clamped to ≤0.95
//   - vertical gate (3):     generic passes, travel/wellness → not-generic,
//                            null vertical treated as generic (historical default)
//   - throttle (3):          below MIN_INBOUND skipped, above CAP skipped,
//                            re-analysis throttled to every STEP messages
//   - lead creation (4):     unknown phone → Contact{status:Lead, source:whatsapp},
//                            aiScore derived from confidence + stamped,
//                            thread linked + Touchpoint written,
//                            not-an-enquiry → nothing created
//   - existing contact (2):  known phone qualifies → NO duplicate row and NO
//                            status overwrite (attribution only);
//                            GENERIC_WA_LEAD_RESTATUS_KNOWN=1 opts into the flip
//   - resilience (1):        safeMaybeCaptureLead swallows a thrown error
//
// The contract these pin is that ingestion is never harmed (never throws), a
// paying customer is never silently demoted to a lead, and no tenant outside the
// generic vertical is ever touched.

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Monkey-patch the CJS singletons post-load (repo convention — see
// test/lib/whatsappOnboardingService.test.js) rather than vi.mock.
prisma.tenant.findUnique = vi.fn();
prisma.contact.findFirst = vi.fn();
prisma.contact.create = vi.fn();
prisma.contact.update = vi.fn();
prisma.whatsAppMessage.count = vi.fn();
prisma.whatsAppMessage.findMany = vi.fn();
prisma.whatsAppThread.update = vi.fn();
prisma.touchpoint.create = vi.fn();

const sut = require('../../lib/genericWhatsappLeadCapture');

const ENQUIRY = 'Hi, what is the price for your annual plan? I am interested, please send a quote.';

function seedGenericTenant(vertical = 'generic') {
  prisma.tenant.findUnique.mockResolvedValue({ vertical });
}

/** A chat that has enough inbound context and one qualifying message. */
function seedQualifyingChat(body = ENQUIRY) {
  prisma.whatsAppMessage.count.mockResolvedValue(3);
  prisma.whatsAppMessage.findMany.mockResolvedValue([{ body }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // The vertical + throttle caches are module-level; clear between cases so
  // tenant ids and phones don't leak verdicts across tests.
  sut._verticalCache.clear();
  sut._lastAnalyzedCount.clear();
  prisma.contact.findFirst.mockResolvedValue(null);
  prisma.contact.create.mockResolvedValue({ id: 501 });
  prisma.whatsAppThread.update.mockResolvedValue({});
  prisma.touchpoint.create.mockResolvedValue({});
  delete process.env.GENERIC_WA_LEAD_RESTATUS_KNOWN;
  delete process.env.GENERIC_WHATSAPP_AUTOLEADS;
  // NODE_ENV=test makes llmRouter.routeRequest return stub:true, so
  // classifyConversation always falls through to the heuristic here. That is
  // the offline path CI must exercise; the LLM branch is covered by
  // llmRouter's own suite.
});

describe('heuristicClassify', () => {
  test('a pricing enquiry qualifies', () => {
    const r = sut.heuristicClassify(ENQUIRY);
    expect(r.isEnquiry).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(sut.CONFIDENCE_THRESHOLD);
    expect(r.source).toBe('heuristic');
  });

  test('strong intent lifts confidence above a bare keyword hit', () => {
    const weak = sut.heuristicClassify('do you offer support');
    const strong = sut.heuristicClassify('do you offer support? how much does it cost, call me back');
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
  });

  test('a bare greeting does not qualify', () => {
    const r = sut.heuristicClassify('good morning');
    expect(r.isEnquiry).toBe(false);
  });

  test('spam / negative signal suppresses an incidental keyword', () => {
    const r = sut.heuristicClassify('click here to win a prize, unsubscribe to stop');
    expect(r.isEnquiry).toBe(false);
  });

  test('empty input → zero confidence, not an enquiry', () => {
    for (const v of ['', '   ', null, undefined]) {
      const r = sut.heuristicClassify(v);
      expect(r.isEnquiry).toBe(false);
      expect(r.confidence).toBe(0);
    }
  });

  test('confidence is clamped to 0.95 even with many hits', () => {
    const r = sut.heuristicClassify(
      'price cost quote quotation how much rate budget demo trial callback interested requirement proposal',
    );
    expect(r.confidence).toBeLessThanOrEqual(0.95);
  });
});

describe('vertical gate', () => {
  test('generic tenant proceeds', async () => {
    seedGenericTenant('generic');
    seedQualifyingChat();
    const res = await sut.maybeCaptureLead({ tenantId: 1, phone: '+919876543210', threadId: 9 });
    expect(res.skipped).toBeUndefined();
    expect(res.created).toBe(true);
  });

  test.each([['travel'], ['wellness']])('%s tenant is a no-op', async (vertical) => {
    seedGenericTenant(vertical);
    seedQualifyingChat();
    const res = await sut.maybeCaptureLead({ tenantId: 2, phone: '+919876543210', threadId: 9 });
    expect(res.skipped).toBe('not-generic');
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('null vertical is treated as generic (historical default)', async () => {
    seedGenericTenant(null);
    seedQualifyingChat();
    const res = await sut.maybeCaptureLead({ tenantId: 3, phone: '+919876543210', threadId: 9 });
    expect(res.created).toBe(true);
  });
});

describe('analysis throttle', () => {
  test('below MIN_INBOUND messages of context → skipped', async () => {
    seedGenericTenant();
    prisma.whatsAppMessage.count.mockResolvedValue(sut.MIN_INBOUND - 1);
    const res = await sut.maybeCaptureLead({ tenantId: 1, phone: '+91999', threadId: 9 });
    expect(res.skipped).toBe('below-threshold');
    expect(prisma.whatsAppMessage.findMany).not.toHaveBeenCalled();
  });

  test('past the CAP → gives up rather than classifying forever', async () => {
    seedGenericTenant();
    prisma.whatsAppMessage.count.mockResolvedValue(999);
    const res = await sut.maybeCaptureLead({ tenantId: 1, phone: '+91999', threadId: 9 });
    expect(res.skipped).toBe('below-threshold');
  });

  test('re-analysis is throttled until STEP further messages arrive', async () => {
    seedGenericTenant();
    // First pass at 3 inbound messages, non-qualifying so no lead is created.
    prisma.whatsAppMessage.count.mockResolvedValue(3);
    prisma.whatsAppMessage.findMany.mockResolvedValue([{ body: 'good morning' }]);
    const first = await sut.maybeCaptureLead({ tenantId: 1, phone: '+91888', threadId: 9 });
    expect(first.skipped).toBe('not-enquiry');

    // One more message (4 < 3+STEP) → throttled, no second classify.
    prisma.whatsAppMessage.count.mockResolvedValue(4);
    prisma.whatsAppMessage.findMany.mockClear();
    const second = await sut.maybeCaptureLead({ tenantId: 1, phone: '+91888', threadId: 9 });
    expect(second.skipped).toBe('throttled');
    expect(prisma.whatsAppMessage.findMany).not.toHaveBeenCalled();
  });
});

describe('lead creation', () => {
  test('unknown phone → Contact with status Lead and source whatsapp', async () => {
    seedGenericTenant();
    seedQualifyingChat();
    await sut.maybeCaptureLead({ tenantId: 7, phone: '+919876543210', name: 'Priya Sharma', threadId: 9 });

    expect(prisma.contact.create).toHaveBeenCalledTimes(1);
    const data = prisma.contact.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId: 7,
      name: 'Priya Sharma',
      phone: '+919876543210',
      source: 'whatsapp',
      status: 'Lead',
      email: null,
    });
  });

  test('falls back to a phone-derived name when Meta sent no profile name', async () => {
    seedGenericTenant();
    seedQualifyingChat();
    await sut.maybeCaptureLead({ tenantId: 7, phone: '+919876543210', name: null, threadId: 9 });
    expect(prisma.contact.create.mock.calls[0][0].data.name).toBe('WhatsApp +919876543210');
  });

  test('aiScore derives from confidence and is stamped so leadScoringEngine leaves it alone', async () => {
    seedGenericTenant();
    seedQualifyingChat();
    await sut.maybeCaptureLead({ tenantId: 7, phone: '+91777', threadId: 9 });

    const data = prisma.contact.create.mock.calls[0][0].data;
    expect(data.aiScore).toBeGreaterThan(0);
    expect(data.aiScore).toBeLessThanOrEqual(100);
    expect(data.aiScoreLastComputedAt).toBeInstanceOf(Date);
  });

  test('links the thread to the new contact and writes a Touchpoint', async () => {
    seedGenericTenant();
    seedQualifyingChat();
    await sut.maybeCaptureLead({ tenantId: 7, phone: '+91777', threadId: 9 });

    expect(prisma.whatsAppThread.update).toHaveBeenCalledWith({
      where: { tenantId_contactPhone: { tenantId: 7, contactPhone: '+91777' } },
      data: { contactId: 501 },
    });
    expect(prisma.touchpoint.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 7,
        contactId: 501,
        channel: 'whatsapp',
        source: 'inbound:whatsapp',
      }),
    });
  });

  test('a non-enquiry conversation creates nothing', async () => {
    seedGenericTenant();
    prisma.whatsAppMessage.count.mockResolvedValue(3);
    prisma.whatsAppMessage.findMany.mockResolvedValue([{ body: 'hi' }, { body: 'good night' }]);
    const res = await sut.maybeCaptureLead({ tenantId: 7, phone: '+91666', threadId: 9 });

    expect(res.skipped).toBe('not-enquiry');
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });
});

describe('existing contact — no duplicate, no silent demotion', () => {
  test('known phone qualifies → attribution only, status untouched', async () => {
    seedGenericTenant();
    seedQualifyingChat();
    prisma.contact.findFirst.mockResolvedValue({ id: 42, status: 'Customer' });

    const res = await sut.maybeCaptureLead({ tenantId: 7, phone: '+91555', threadId: 9 });

    expect(res.attributed).toBe(true);
    expect(res.contactId).toBe(42);
    // The whole point: a paying customer is neither duplicated nor demoted.
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
    // The enquiry is still recorded against their timeline.
    expect(prisma.touchpoint.create).toHaveBeenCalled();
  });

  test('GENERIC_WA_LEAD_RESTATUS_KNOWN=1 opts into flipping them to Lead', async () => {
    process.env.GENERIC_WA_LEAD_RESTATUS_KNOWN = '1';
    seedGenericTenant();
    seedQualifyingChat();
    prisma.contact.findFirst.mockResolvedValue({ id: 42, status: 'Customer' });
    prisma.contact.update.mockResolvedValue({ id: 42 });

    const res = await sut.maybeCaptureLead({ tenantId: 7, phone: '+91555', threadId: 9 });

    expect(res.restatused).toBe(true);
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { status: 'Lead' },
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });
});

describe('resilience', () => {
  test('safeMaybeCaptureLead never throws out to the caller', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.tenant.findUnique.mockRejectedValue(new Error('DB down'));
    prisma.whatsAppMessage.count.mockRejectedValue(new Error('DB down'));

    const res = await sut.safeMaybeCaptureLead({ tenantId: 7, phone: '+91444', threadId: 9 });

    // Ingestion continues regardless — the webhook must never 500 because lead
    // capture had a bad day.
    expect(res).toBeDefined();
    expect(res.created).toBeUndefined();
    errSpy.mockRestore();
  });
});
