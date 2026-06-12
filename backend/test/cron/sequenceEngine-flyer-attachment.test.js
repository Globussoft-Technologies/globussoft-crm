/**
 * Unit tests for the S19 flyer-attachment extension of
 * backend/cron/sequenceEngine.js — SequenceStep.attachmentRefsJson with
 * `kind:'flyer'` entries render via services/flyerRenderEngine.renderFlyer
 * at send time + emit audit rows.
 *
 * What this file pins (PRD_TRAVEL_MARKETING_FLYER FR-3.5 / AC-6.5):
 *
 *   - SequenceStep.attachmentRefsJson is the additive-nullable column that
 *     carries the array of attachment refs. Backward-compat: null + empty
 *     string + missing field all yield "no attachments" without throwing.
 *   - resolveStepAttachments(step, enrollment, channel) is the new exported
 *     helper that returns Promise<Array<descriptor>>. Tests drive it
 *     directly — the email/sms branches in processStep call it inline.
 *   - For each ref:
 *       kind:'file' → passed through as {kind:'file', url, filename}
 *       kind:'flyer' → looks up TravelFlyerTemplate (tenant-scoped) +
 *                      calls renderFlyer({template, data, format}) +
 *                      returns {kind:'flyer', buffer, mimeType, filename,
 *                      flyerId, format, engine}
 *   - Render failures (template missing, parse fail, render exception):
 *     logged + skipped + audit row 'sequence.step.flyer-attach-failed'.
 *     Surrounding step still sends.
 *   - Render success: audit row 'sequence.step.flyer-attached' with
 *     {enrollmentId, flyerId, format, channel, engine}.
 *   - Stub-engine PNG (engine:'stub-1x1' when Puppeteer is absent) is
 *     still attached — the operator's job to swap to real Chrome.
 *   - processStep (email branch): when attachmentRefsJson is populated,
 *     the email row is still written + delivery still attempted, and the
 *     resolved attachments are threaded into trySendGridSend (covered by
 *     asserting the email row write completes irrespective of attach
 *     outcome).
 *   - processStep (sms branch): attachments are resolved (audit fires)
 *     but the body itself is not mutated (short-link wire-in is a
 *     follow-up slice).
 *
 * Mocking strategy:
 *   - prisma singleton monkey-patched (mirrors sequenceEngine.test.js
 *     pattern + writing-vitest-unit-test skill). prisma.travelFlyerTemplate
 *     is added to support the flyer lookup branch.
 *   - services/flyerRenderEngine is vi.mock'd at the module level so we
 *     can intercept renderFlyer() calls without booting pdfkit/puppeteer.
 *   - lib/audit's writeAudit is vi.mock'd so we can assert action verb +
 *     payload without a real Prisma write.
 *
 * Notes on the CJS self-mocking-seam pattern (CLAUDE.md 2026-05-24):
 *   sequenceEngine.js uses `getFlyerRenderEngine()` / `getAuditWriter()`
 *   indirection so vi.mock at the SUT-resolved module path is the right
 *   interception point — the engine resolves the module via require()
 *   inside the helper, which is exactly what vi.mock factories patch.
 *   No module.exports-based spy gymnastics are needed.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

// CJS-self-mocking-seam pattern (CLAUDE.md cron-learnings 2026-05-24
// ~01:43 UTC, walletExpiryEngine.test.js precedent). Load the SUT via
// createRequire so we get the same module-cache instance the SUT uses
// internally — tests reassign `engine.renderFlyerSafe` + `engine.writeAuditSafe`
// to vi.fn() spies, and because the SUT calls them via
// `module.exports.renderFlyerSafe(...)` the spies intercept cleanly.
const requireCJS = createRequire(import.meta.url);
const engine = requireCJS('../../cron/sequenceEngine.js');

// Convenience handles to the spies (re-bound in beforeEach).
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
  // Reassign each test so prior-test state doesn't leak.
  renderFlyer = vi.fn();
  writeAudit = vi.fn().mockResolvedValue(undefined);
  engine.renderFlyerSafe = renderFlyer;
  engine.writeAuditSafe = writeAudit;
  delete process.env.SENDGRID_API_KEY;
});

const { resolveStepAttachments, processStep } = engine;

// ── helpers ────────────────────────────────────────────────────────────

function makeEnrollment(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    sequenceId: 50,
    status: 'Active',
    currentStep: 0,
    nextRun: null,
    contact: {
      id: 7,
      name: 'Aisha Khan',
      email: 'aisha@example.com',
      phone: '+91-9876543210',
      company: 'Travel Stall',
      status: 'Lead',
    },
    ...overrides,
  };
}

function makeStep(overrides = {}) {
  return {
    id: 9,
    sequenceId: 50,
    position: 0,
    kind: 'email',
    emailTemplate: null,
    smsBody: null,
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
    id: 42,
    tenantId: 1,
    name: 'Umrah 2026 Spring',
    subBrand: 'rfu',
    paletteJson: JSON.stringify({ primaryHex: '#122647', bgHex: '#FFFFFF' }),
    layoutJson: JSON.stringify([
      { type: 'text', x: 10, y: 10, width: 200, height: 40, content: 'Umrah Spring' },
      { type: 'price', x: 10, y: 60, width: 200, height: 40, content: '₹78,000' },
    ]),
    assetsJson: JSON.stringify({ hero: 'https://cdn/x.jpg' }),
    isActive: true,
    notes: null,
    ...overrides,
  };
}

// ─── attachmentRefsJson — schema-shape acceptance ──────────────────────

describe('S19 — attachmentRefsJson nullable + JSON-shape contract', () => {
  test('attachmentRefsJson null on step → no flyer lookup, no audit, empty result', async () => {
    const step = makeStep({ attachmentRefsJson: null });
    const out = await resolveStepAttachments(step, makeEnrollment(), 'email');
    expect(out).toEqual([]);
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(renderFlyer).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  test('attachmentRefsJson empty string → no-op', async () => {
    const out = await resolveStepAttachments(
      makeStep({ attachmentRefsJson: '' }),
      makeEnrollment(),
      'email',
    );
    expect(out).toEqual([]);
  });

  test('attachmentRefsJson empty array → no-op', async () => {
    const out = await resolveStepAttachments(
      makeStep({ attachmentRefsJson: '[]' }),
      makeEnrollment(),
      'email',
    );
    expect(out).toEqual([]);
    expect(renderFlyer).not.toHaveBeenCalled();
  });

  test('attachmentRefsJson malformed JSON → skip + log, no throw', async () => {
    const out = await resolveStepAttachments(
      makeStep({ attachmentRefsJson: 'not-json{' }),
      makeEnrollment(),
      'email',
    );
    expect(out).toEqual([]);
    expect(renderFlyer).not.toHaveBeenCalled();
  });

  test('attachmentRefsJson with non-array JSON → no-op', async () => {
    const out = await resolveStepAttachments(
      makeStep({ attachmentRefsJson: '{"kind":"flyer","flyerId":1}' }),
      makeEnrollment(),
      'email',
    );
    expect(out).toEqual([]);
  });
});

// ─── flyer ref happy path ──────────────────────────────────────────────

describe('S19 — flyer ref render-on-send happy path', () => {
  test('single flyer ref → lookup + render + descriptor + audit success row', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('PDFBYTES'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      widthPx: null,
      heightPx: null,
      engine: 'pdfkit',
    });

    const step = makeStep({
      attachmentRefsJson: JSON.stringify([
        { kind: 'flyer', flyerId: 42, format: 'pdf-a4' },
      ]),
    });
    const out = await resolveStepAttachments(step, makeEnrollment(), 'email');

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('flyer');
    expect(out[0].flyerId).toBe(42);
    expect(out[0].format).toBe('pdf-a4');
    expect(out[0].mimeType).toBe('application/pdf');
    expect(Buffer.isBuffer(out[0].buffer)).toBe(true);
    expect(out[0].buffer.toString()).toBe('PDFBYTES');
    expect(out[0].engine).toBe('pdfkit');
    expect(out[0].filename).toMatch(/\.pdf$/);

    // Tenant-scoped lookup
    expect(prisma.travelFlyerTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: 42, tenantId: 1 },
    });

    // renderFlyer called with parsed template + projected data + format
    expect(renderFlyer).toHaveBeenCalledTimes(1);
    const call = renderFlyer.mock.calls[0][0];
    expect(call.format).toBe('pdf-a4');
    expect(call.template.palette).toEqual({ primaryHex: '#122647', bgHex: '#FFFFFF' });
    expect(Array.isArray(call.template.layout)).toBe(true);
    expect(call.data.titleOverride).toContain('Aisha Khan');

    // Audit success row
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const auditCall = writeAudit.mock.calls[0];
    expect(auditCall[0]).toBe('SequenceStep');
    expect(auditCall[1]).toBe('sequence.step.flyer-attached');
    expect(auditCall[2]).toBe(step.id);
    expect(auditCall[4]).toBe(1); // tenantId
    expect(auditCall[5]).toMatchObject({
      enrollmentId: 100,
      flyerId: 42,
      format: 'pdf-a4',
      channel: 'email',
      engine: 'pdfkit',
    });
  });

  test('format omitted → defaults to pdf-a4', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('X'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      engine: 'pdfkit',
    });

    const out = await resolveStepAttachments(
      makeStep({ attachmentRefsJson: JSON.stringify([{ kind: 'flyer', flyerId: 42 }]) }),
      makeEnrollment(),
      'email',
    );

    expect(out).toHaveLength(1);
    expect(renderFlyer.mock.calls[0][0].format).toBe('pdf-a4');
    expect(out[0].format).toBe('pdf-a4');
  });

  test('explicit format flows through to renderFlyer (png-square)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('PNGBYTES'),
      mimeType: 'image/png',
      extension: 'png',
      widthPx: 1200,
      heightPx: 1200,
      engine: 'puppeteer',
    });

    const out = await resolveStepAttachments(
      makeStep({
        attachmentRefsJson: JSON.stringify([{ kind: 'flyer', flyerId: 42, format: 'png-square' }]),
      }),
      makeEnrollment(),
      'email',
    );

    expect(renderFlyer.mock.calls[0][0].format).toBe('png-square');
    expect(out[0].mimeType).toBe('image/png');
    expect(out[0].filename).toMatch(/\.png$/);
    expect(out[0].engine).toBe('puppeteer');
  });

  test('multiple flyer refs → all rendered in order, multiple audit rows', async () => {
    prisma.travelFlyerTemplate.findFirst.mockImplementation(({ where: { id } }) =>
      Promise.resolve(makeFlyerRow({ id, name: `flyer-${id}` })),
    );
    renderFlyer.mockImplementation(({ format }) =>
      Promise.resolve({
        buffer: Buffer.from(`B-${format}`),
        mimeType: format.startsWith('pdf') ? 'application/pdf' : 'image/png',
        extension: format.startsWith('pdf') ? 'pdf' : 'png',
        engine: 'pdfkit',
      }),
    );

    const step = makeStep({
      attachmentRefsJson: JSON.stringify([
        { kind: 'flyer', flyerId: 1, format: 'pdf-a4' },
        { kind: 'flyer', flyerId: 2, format: 'pdf-a5' },
        { kind: 'flyer', flyerId: 3, format: 'png-square' },
      ]),
    });
    const out = await resolveStepAttachments(step, makeEnrollment(), 'email');

    expect(out).toHaveLength(3);
    expect(out.map((a) => a.flyerId)).toEqual([1, 2, 3]);
    expect(renderFlyer).toHaveBeenCalledTimes(3);
    expect(writeAudit).toHaveBeenCalledTimes(3);
    // Every audit row references the same channel + step + tenant
    for (const call of writeAudit.mock.calls) {
      expect(call[1]).toBe('sequence.step.flyer-attached');
      expect(call[5].channel).toBe('email');
    }
  });
});

// ─── stub-engine PNG fallback ─────────────────────────────────────────

describe('S19 — stub-engine fallback still attached', () => {
  test('renderFlyer returns engine:"stub-1x1" → still attached', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    const stubBuf = Buffer.from('89504e470d0a1a0a', 'hex');
    renderFlyer.mockResolvedValue({
      buffer: stubBuf,
      mimeType: 'image/png',
      extension: 'png',
      widthPx: 1200,
      heightPx: 1200,
      engine: 'stub-1x1',
    });

    const out = await resolveStepAttachments(
      makeStep({
        attachmentRefsJson: JSON.stringify([{ kind: 'flyer', flyerId: 42, format: 'png-square' }]),
      }),
      makeEnrollment(),
      'email',
    );

    expect(out).toHaveLength(1);
    expect(out[0].engine).toBe('stub-1x1');
    expect(out[0].buffer).toBe(stubBuf);
    // Stub engine is still considered a success — emits attached, not failed
    expect(writeAudit).toHaveBeenCalledWith(
      'SequenceStep',
      'sequence.step.flyer-attached',
      expect.any(Number),
      null,
      1,
      expect.objectContaining({ engine: 'stub-1x1' }),
      expect.any(Object),
    );
  });
});

// ─── failure modes ────────────────────────────────────────────────────

describe('S19 — failure modes per-attachment', () => {
  test('flyer template not found → skipped + failed-audit row, others still attach', async () => {
    prisma.travelFlyerTemplate.findFirst
      .mockResolvedValueOnce(null)                     // flyerId=1 missing
      .mockResolvedValueOnce(makeFlyerRow({ id: 2 })); // flyerId=2 found
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('X'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      engine: 'pdfkit',
    });

    const step = makeStep({
      attachmentRefsJson: JSON.stringify([
        { kind: 'flyer', flyerId: 1, format: 'pdf-a4' },
        { kind: 'flyer', flyerId: 2, format: 'pdf-a4' },
      ]),
    });
    const out = await resolveStepAttachments(step, makeEnrollment(), 'email');

    expect(out).toHaveLength(1);
    expect(out[0].flyerId).toBe(2);
    // Audit rows: one fail (flyerId=1) + one success (flyerId=2)
    const actions = writeAudit.mock.calls.map((c) => c[1]);
    expect(actions).toContain('sequence.step.flyer-attach-failed');
    expect(actions).toContain('sequence.step.flyer-attached');
    const failedCall = writeAudit.mock.calls.find(
      (c) => c[1] === 'sequence.step.flyer-attach-failed',
    );
    expect(failedCall[5]).toMatchObject({
      flyerId: 1,
      reason: 'template_not_found',
    });
  });

  test('renderFlyer throws → caught, failed-audit row, surrounding refs still process', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer
      .mockRejectedValueOnce(new Error('Puppeteer crash'))
      .mockResolvedValueOnce({
        buffer: Buffer.from('X'),
        mimeType: 'application/pdf',
        extension: 'pdf',
        engine: 'pdfkit',
      });

    const out = await resolveStepAttachments(
      makeStep({
        attachmentRefsJson: JSON.stringify([
          { kind: 'flyer', flyerId: 1, format: 'png-square' },
          { kind: 'flyer', flyerId: 2, format: 'pdf-a4' },
        ]),
      }),
      makeEnrollment(),
      'email',
    );

    expect(out).toHaveLength(1);
    expect(out[0].flyerId).toBe(2);
    const failedCall = writeAudit.mock.calls.find(
      (c) => c[1] === 'sequence.step.flyer-attach-failed',
    );
    expect(failedCall[5]).toMatchObject({
      reason: 'render_error',
      message: 'Puppeteer crash',
    });
  });

  test('prisma lookup throws → caught, failed-audit, continues', async () => {
    prisma.travelFlyerTemplate.findFirst.mockRejectedValueOnce(new Error('DB outage'));

    const out = await resolveStepAttachments(
      makeStep({
        attachmentRefsJson: JSON.stringify([{ kind: 'flyer', flyerId: 1, format: 'pdf-a4' }]),
      }),
      makeEnrollment(),
      'email',
    );

    expect(out).toEqual([]);
    expect(renderFlyer).not.toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit.mock.calls[0][1]).toBe('sequence.step.flyer-attach-failed');
    expect(writeAudit.mock.calls[0][5]).toMatchObject({ reason: 'lookup_error' });
  });

  test('audit write failure does not abort send', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('X'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      engine: 'pdfkit',
    });
    writeAudit.mockRejectedValue(new Error('audit DB down'));

    const out = await resolveStepAttachments(
      makeStep({
        attachmentRefsJson: JSON.stringify([{ kind: 'flyer', flyerId: 42, format: 'pdf-a4' }]),
      }),
      makeEnrollment(),
      'email',
    );

    // The attachment is still surfaced even though the audit row blew up.
    expect(out).toHaveLength(1);
  });
});

// ─── tenant-scoping ────────────────────────────────────────────────────

describe('S19 — tenant scoping', () => {
  test('flyer lookup uses enrollment.tenantId, never a body-supplied tenant', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow({ tenantId: 7 }));
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('X'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      engine: 'pdfkit',
    });

    await resolveStepAttachments(
      makeStep({
        attachmentRefsJson: JSON.stringify([{ kind: 'flyer', flyerId: 42, format: 'pdf-a4' }]),
      }),
      makeEnrollment({ tenantId: 7 }),
      'email',
    );

    expect(prisma.travelFlyerTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: 42, tenantId: 7 },
    });
  });
});

// ─── kind:'file' passthrough ──────────────────────────────────────────

describe('S19 — kind:file passthrough', () => {
  test('file ref passes through untouched alongside flyer ref', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('X'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      engine: 'pdfkit',
    });

    const out = await resolveStepAttachments(
      makeStep({
        attachmentRefsJson: JSON.stringify([
          { kind: 'file', url: 'https://cdn/x.pdf', filename: 'brochure.pdf' },
          { kind: 'flyer', flyerId: 42, format: 'pdf-a4' },
        ]),
      }),
      makeEnrollment(),
      'email',
    );

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      kind: 'file',
      url: 'https://cdn/x.pdf',
      filename: 'brochure.pdf',
    });
    expect(out[1].kind).toBe('flyer');
    // file refs do NOT trigger renderFlyer
    expect(renderFlyer).toHaveBeenCalledTimes(1);
  });

  test('unrecognised ref kind is silently skipped', async () => {
    const out = await resolveStepAttachments(
      makeStep({
        attachmentRefsJson: JSON.stringify([
          { kind: 'mystery', flyerId: 1 },
          { kind: 'flyer' /* no flyerId */ },
          null,
          'not-an-object',
        ]),
      }),
      makeEnrollment(),
      'email',
    );

    expect(out).toEqual([]);
    expect(renderFlyer).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

// ─── processStep integration (email + sms branches) ───────────────────

describe('S19 — processStep integration', () => {
  test('email step with no attachmentRefsJson: existing send path unchanged', async () => {
    const step = makeStep({
      kind: 'email',
      attachmentRefsJson: null,
      emailTemplate: { subject: 'Hi', body: 'Body' },
    });
    const result = await processStep(step, makeEnrollment());

    expect(result).toEqual({ advance: true });
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    expect(renderFlyer).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  test('email step with flyer attachment: renderFlyer fires + email row still written', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('PDF'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      engine: 'pdfkit',
    });

    const step = makeStep({
      kind: 'email',
      attachmentRefsJson: JSON.stringify([{ kind: 'flyer', flyerId: 42, format: 'pdf-a4' }]),
      emailTemplate: { subject: 'Hi {{contact.name}}', body: 'Have a look.' },
    });
    const result = await processStep(step, makeEnrollment());

    expect(result).toEqual({ advance: true });
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    const emailArg = prisma.emailMessage.create.mock.calls[0][0];
    expect(emailArg.data.subject).toBe('Hi Aisha Khan');
    expect(renderFlyer).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      'SequenceStep',
      'sequence.step.flyer-attached',
      step.id,
      null,
      1,
      expect.objectContaining({ channel: 'email' }),
      expect.any(Object),
    );
  });

  test('sms step with flyer attachment: audit fires under channel=sms, SMS row written', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockResolvedValue({
      buffer: Buffer.from('PDF'),
      mimeType: 'application/pdf',
      extension: 'pdf',
      engine: 'pdfkit',
    });

    const step = makeStep({
      kind: 'sms',
      smsBody: 'Hi {{contact.name}}, flyer attached.',
      attachmentRefsJson: JSON.stringify([{ kind: 'flyer', flyerId: 42, format: 'pdf-a4' }]),
    });
    const result = await processStep(step, makeEnrollment());

    expect(result).toEqual({ advance: true });
    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      'SequenceStep',
      'sequence.step.flyer-attached',
      step.id,
      null,
      1,
      expect.objectContaining({ channel: 'sms' }),
      expect.any(Object),
    );
  });

  test('email step where flyer render fails: email still sends, no throw', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeFlyerRow());
    renderFlyer.mockRejectedValue(new Error('boom'));

    const step = makeStep({
      kind: 'email',
      attachmentRefsJson: JSON.stringify([{ kind: 'flyer', flyerId: 42, format: 'pdf-a4' }]),
      emailTemplate: { subject: 'Hi', body: 'Body' },
    });
    const result = await processStep(step, makeEnrollment());

    expect(result).toEqual({ advance: true });
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      'SequenceStep',
      'sequence.step.flyer-attach-failed',
      expect.any(Number),
      null,
      1,
      expect.objectContaining({ reason: 'render_error' }),
      expect.any(Object),
    );
  });
});
