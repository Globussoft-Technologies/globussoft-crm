/**
 * Unit tests for slice S87 — sequenceEngine.js SMS branch appends a
 * short-link per flyer attachment via services/shortUrl.shortenUrl.
 *
 * What this file pins (closes the carry-over flagged by S19):
 *
 *   - SMS step with no attachments → body unchanged (regression guard for
 *     non-flyer sequence steps).
 *   - SMS step with 1 flyer attachment → body has `📎 <shortUrl>` line
 *     appended after a blank-line separator.
 *   - SMS step with 2 flyer attachments → body has both URLs each on
 *     their own line.
 *   - Non-SMS step (email) → SMS branch is not reached, no shortener call.
 *   - shortenUrl throws → SMS still sends (fail-soft), audit row
 *     `sequence.step.sms-flyer-shortlink-failed` emitted.
 *   - shortenUrl succeeds → audit row
 *     `sequence.step.sms-flyer-shortlinked` emitted with shortUrl + source.
 *   - file-kind attachments use their existing URL verbatim (no
 *     shortener call) — backwards-compat with existing kind:'file' refs.
 *   - audit best-effort: when writeAudit throws, SMS body still mutates
 *     and SmsMessage row still writes.
 *
 * Mocking strategy:
 *   - prisma singleton monkey-patched (mirrors sequenceEngine-flyer-attachment
 *     test pattern) — adds `smsMessage.create` + `travelFlyerTemplate.findFirst`.
 *   - engine.shortenUrlSafe + engine.renderFlyerSafe + engine.writeAuditSafe
 *     reassigned to vi.fn() spies via the CJS self-mocking seam, per the
 *     standing rule (CLAUDE.md cron-learnings 2026-05-24 ~01:43 UTC).
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const engine = requireCJS('../../cron/sequenceEngine.js');

let shortenUrl;
let renderFlyer;
let writeAudit;

beforeAll(() => {
  prisma.emailMessage = { create: vi.fn(), findMany: vi.fn(), update: vi.fn() };
  prisma.smsMessage = { create: vi.fn() };
  prisma.travelFlyerTemplate = { findFirst: vi.fn() };
});

beforeEach(() => {
  prisma.emailMessage.create.mockReset().mockResolvedValue({ id: 'em-1' });
  prisma.smsMessage.create.mockReset().mockResolvedValue({ id: 'sms-1' });
  prisma.travelFlyerTemplate.findFirst.mockReset().mockResolvedValue(null);
  shortenUrl = vi.fn();
  renderFlyer = vi.fn();
  writeAudit = vi.fn().mockResolvedValue(undefined);
  engine.shortenUrlSafe = shortenUrl;
  engine.renderFlyerSafe = renderFlyer;
  engine.writeAuditSafe = writeAudit;
});

const { processStep } = engine;

// ── helpers ────────────────────────────────────────────────────────────

function makeEnrollment(overrides = {}) {
  return {
    id: 200,
    tenantId: 4,
    sequenceId: 60,
    status: 'Active',
    currentStep: 0,
    nextRun: null,
    contact: {
      id: 11,
      name: 'Rohan Singh',
      email: 'rohan@example.com',
      phone: '+91-9876501234',
      company: 'TMC',
      status: 'Lead',
    },
    ...overrides,
  };
}

function makeStep(overrides = {}) {
  return {
    id: 71,
    sequenceId: 60,
    position: 0,
    kind: 'sms',
    emailTemplate: null,
    smsBody: 'Hello {{contact.name}}, please review the attached flyer.',
    delayMinutes: null,
    conditionJson: null,
    trueNextPosition: null,
    falseNextPosition: null,
    pauseOnReply: false,
    attachmentRefsJson: null,
    ...overrides,
  };
}

function makeFlyerRow(overrides = {}) {
  return {
    id: 88,
    tenantId: 4,
    name: 'TMC Summer School Trip',
    subBrand: 'tmc',
    paletteJson: JSON.stringify({ primaryHex: '#122647' }),
    layoutJson: JSON.stringify([]),
    assetsJson: JSON.stringify({}),
    isActive: true,
    notes: null,
    ...overrides,
  };
}

// ── no attachments → body unchanged ────────────────────────────────────

describe('S87 — SMS step without flyer attachment', () => {
  test('attachmentRefsJson null → body unchanged, no shortener call', async () => {
    const step = makeStep({ attachmentRefsJson: null });
    const result = await processStep(step, makeEnrollment());

    expect(result).toEqual({ advance: true });
    expect(shortenUrl).not.toHaveBeenCalled();
    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    const smsArg = prisma.smsMessage.create.mock.calls[0][0];
    expect(smsArg.data.body).toBe('Hello Rohan Singh, please review the attached flyer.');
    expect(smsArg.data.body).not.toContain('📎');
    expect(smsArg.data.body).not.toContain('stub-flyer.demo');
  });

  test('attachmentRefsJson empty array → body unchanged', async () => {
    const step = makeStep({ attachmentRefsJson: '[]' });
    await processStep(step, makeEnrollment());

    expect(shortenUrl).not.toHaveBeenCalled();
    const smsArg = prisma.smsMessage.create.mock.calls[0][0];
    expect(smsArg.data.body).toBe('Hello Rohan Singh, please review the attached flyer.');
  });
});

// ── 1 flyer attachment → 1 link appended ───────────────────────────────

describe('S87 — single flyer attachment', () => {
  test('body has 📎 + short URL on a new paragraph', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('PDF-A'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      engine: 'pdfkit',
    });
    shortenUrl.mockResolvedValue({
      shortUrl: 'https://stub-flyer.demo/abcdef123456?t=86400',
      source: 'stub',
      filename: 'tmc-flyer.pdf',
      mimeType: 'application/pdf',
    });

    const step = makeStep({
      attachmentRefsJson: JSON.stringify([
        { kind: 'flyer', flyerId: 88, format: 'pdf-a4' },
      ]),
    });
    await processStep(step, makeEnrollment());

    expect(shortenUrl).toHaveBeenCalledTimes(1);
    const shortenArg = shortenUrl.mock.calls[0][0];
    expect(Buffer.isBuffer(shortenArg.buffer)).toBe(true);
    expect(shortenArg.buffer.toString()).toBe('PDF-A');
    expect(shortenArg.mimeType).toBe('application/pdf');

    const smsArg = prisma.smsMessage.create.mock.calls[0][0];
    expect(smsArg.data.body).toContain('Hello Rohan Singh');
    expect(smsArg.data.body).toContain('📎 https://stub-flyer.demo/abcdef123456?t=86400');
    // Blank-line separator between original body and links
    expect(smsArg.data.body).toMatch(/\n\n📎 /);
  });
});

// ── 2 flyer attachments → 2 link lines ─────────────────────────────────

describe('S87 — multiple flyer attachments', () => {
  test('body contains all short URLs, each on its own line', async () => {
    prisma.travelFlyerTemplate.findFirst.mockImplementation(({ where: { id } }) =>
      Promise.resolve(makeFlyerRow({ id, name: `flyer-${id}` })),
    );
    renderFlyer.mockImplementation(({ format }) =>
      Promise.resolve({
        buffer: Buffer.from(`BUF-${format}`),
        mimeType: format.startsWith('pdf') ? 'application/pdf' : 'image/png',
        extension: format.startsWith('pdf') ? 'pdf' : 'png',
        engine: 'pdfkit',
      }),
    );
    shortenUrl.mockImplementation(({ buffer }) =>
      Promise.resolve({
        shortUrl: `https://stub-flyer.demo/${buffer.toString().slice(0, 6)}?t=86400`,
        source: 'stub',
        filename: 'attachment',
        mimeType: 'application/pdf',
      }),
    );

    const step = makeStep({
      attachmentRefsJson: JSON.stringify([
        { kind: 'flyer', flyerId: 1, format: 'pdf-a4' },
        { kind: 'flyer', flyerId: 2, format: 'png-square' },
      ]),
    });
    await processStep(step, makeEnrollment());

    expect(shortenUrl).toHaveBeenCalledTimes(2);
    const smsArg = prisma.smsMessage.create.mock.calls[0][0];
    expect(smsArg.data.body).toContain('📎 https://stub-flyer.demo/BUF-pd?t=86400');
    expect(smsArg.data.body).toContain('📎 https://stub-flyer.demo/BUF-pn?t=86400');
    // Two 📎-prefixed lines exist in the final body
    const linkLines = smsArg.data.body.split('\n').filter((l) => l.startsWith('📎'));
    expect(linkLines).toHaveLength(2);
  });
});

// ── non-SMS step (email) → no shortener call ───────────────────────────

describe('S87 — non-SMS branches untouched', () => {
  test('email step does not invoke the shortener (S87 is SMS-only)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('PDF'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      engine: 'pdfkit',
    });

    const step = makeStep({
      kind: 'email',
      emailTemplate: { subject: 'Hi', body: 'See attached' },
      attachmentRefsJson: JSON.stringify([
        { kind: 'flyer', flyerId: 88, format: 'pdf-a4' },
      ]),
    });
    await processStep(step, makeEnrollment());

    expect(shortenUrl).not.toHaveBeenCalled();
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });
});

// ── fail-soft on shortener throw ──────────────────────────────────────

describe('S87 — fail-soft path', () => {
  test('shortenUrl throws → SMS still sends, audit logs the failure', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('PDF'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      engine: 'pdfkit',
    });
    shortenUrl.mockRejectedValue(new Error("provider 'bitly' not implemented"));

    const step = makeStep({
      attachmentRefsJson: JSON.stringify([
        { kind: 'flyer', flyerId: 88, format: 'pdf-a4' },
      ]),
    });
    const result = await processStep(step, makeEnrollment());

    expect(result).toEqual({ advance: true });
    // SMS row still written — fail-soft
    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    const smsArg = prisma.smsMessage.create.mock.calls[0][0];
    // No 📎 link in the body because the shortener never produced one
    expect(smsArg.data.body).not.toContain('📎');
    // Failed-shortlink audit emitted
    const failedCall = writeAudit.mock.calls.find(
      (c) => c[1] === 'sequence.step.sms-flyer-shortlink-failed',
    );
    expect(failedCall).toBeDefined();
    expect(failedCall[5]).toMatchObject({
      flyerId: 88,
      format: 'pdf-a4',
      channel: 'sms',
      reason: 'shorten_error',
    });
  });

  test('audit write failure does not abort the SMS send', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('PDF'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      engine: 'pdfkit',
    });
    shortenUrl.mockResolvedValue({
      shortUrl: 'https://stub-flyer.demo/xyz?t=86400',
      source: 'stub',
      filename: 'x.pdf',
      mimeType: 'application/pdf',
    });
    writeAudit.mockRejectedValue(new Error('audit DB down'));

    const step = makeStep({
      attachmentRefsJson: JSON.stringify([
        { kind: 'flyer', flyerId: 88, format: 'pdf-a4' },
      ]),
    });
    const result = await processStep(step, makeEnrollment());

    expect(result).toEqual({ advance: true });
    // SMS row still written even though audit blew up — the link is still
    // in the body because shortenUrl succeeded before audit was attempted.
    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    const smsArg = prisma.smsMessage.create.mock.calls[0][0];
    expect(smsArg.data.body).toContain('📎 https://stub-flyer.demo/xyz?t=86400');
  });
});

// ── success-audit emission ─────────────────────────────────────────────

describe('S87 — sms-flyer-shortlinked audit row', () => {
  test('emits sequence.step.sms-flyer-shortlinked on success', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('PDF'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      engine: 'pdfkit',
    });
    shortenUrl.mockResolvedValue({
      shortUrl: 'https://stub-flyer.demo/deadbeef0011?t=86400',
      source: 'stub',
      filename: 'flyer.pdf',
      mimeType: 'application/pdf',
    });

    const step = makeStep({
      attachmentRefsJson: JSON.stringify([
        { kind: 'flyer', flyerId: 88, format: 'pdf-a4' },
      ]),
    });
    await processStep(step, makeEnrollment());

    const successCall = writeAudit.mock.calls.find(
      (c) => c[1] === 'sequence.step.sms-flyer-shortlinked',
    );
    expect(successCall).toBeDefined();
    expect(successCall[0]).toBe('SequenceStep');
    expect(successCall[2]).toBe(step.id);
    expect(successCall[4]).toBe(4); // tenantId from enrollment
    expect(successCall[5]).toMatchObject({
      enrollmentId: 200,
      flyerId: 88,
      format: 'pdf-a4',
      channel: 'sms',
      shortUrl: 'https://stub-flyer.demo/deadbeef0011?t=86400',
      source: 'stub',
    });
    // CRITICAL: the audit payload must NOT contain the raw buffer
    expect(successCall[5].buffer).toBeUndefined();
  });
});

// ── file-kind passthrough ──────────────────────────────────────────────

describe('S87 — file-kind attachment passthrough', () => {
  test('file ref uses its existing URL verbatim, no shortener call', async () => {
    const step = makeStep({
      attachmentRefsJson: JSON.stringify([
        { kind: 'file', url: 'https://cdn.example.com/brochure.pdf', filename: 'brochure.pdf' },
      ]),
    });
    await processStep(step, makeEnrollment());

    expect(shortenUrl).not.toHaveBeenCalled();
    const smsArg = prisma.smsMessage.create.mock.calls[0][0];
    expect(smsArg.data.body).toContain('📎 https://cdn.example.com/brochure.pdf');
  });
});

// ── enrollment without phone — SMS row not written, no shortener ──────

describe('S87 — enrollment without phone', () => {
  test('no contact.phone → SMS row not written, no shortener call', async () => {
    const step = makeStep({
      attachmentRefsJson: JSON.stringify([
        { kind: 'flyer', flyerId: 88, format: 'pdf-a4' },
      ]),
    });
    const result = await processStep(step, makeEnrollment({ contact: { id: 1, phone: null } }));

    expect(result).toEqual({ advance: true });
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
    expect(shortenUrl).not.toHaveBeenCalled();
  });
});
