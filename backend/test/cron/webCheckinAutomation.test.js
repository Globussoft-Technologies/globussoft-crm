/**
 * Unit tests for backend/cron/webCheckinAutomation.js — the airline web
 * check-in AUTOMATION engine (PRD_AIRLINE_WEBCHECKIN_AUTOMATION).
 *
 * State machine (processRow), driven with injected fake adapters:
 *   - adapter ok            → status 'done' + boardingPassUrl + completedAt + success run
 *   - adapter captcha       → status 'fallback-agent' immediately + captcha run (no retry)
 *   - adapter not-implemented → status 'fallback-agent' + not-implemented run
 *   - no adapter (null)     → status 'fallback-agent' + not-implemented run (no claim)
 *   - adapter transient (1st)→ status 'in-progress' + failure run (retry scheduled)
 *   - adapter transient (3rd)→ status 'fallback-agent' + failure run (retry budget exhausted)
 *   - backoff gate          → recent failure → 'backoff-wait', no DB writes
 *
 * Tick (runWebCheckinAutomationTick):
 *   - paid + non-visasure itinerary → processed
 *   - unpaid / visasure itinerary   → skipped (gate)
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  processRow,
  runWebCheckinAutomationTick,
  MAX_ATTEMPTS,
} from '../../cron/webCheckinAutomation.js';

const NOW = new Date('2026-07-01T00:00:00.000Z');

// Fake adapters
const okAdapter = { performCheckIn: vi.fn().mockResolvedValue({ ok: true, boardingPassUrl: '/uploads/boarding-passes/x.pdf' }) };
const captchaAdapter = { performCheckIn: vi.fn().mockResolvedValue({ ok: false, reason: 'captcha', error: 'cap' }) };
const notImplAdapter = { performCheckIn: vi.fn().mockResolvedValue({ ok: false, reason: 'not-implemented', error: 'ni' }) };
const failAdapter = { performCheckIn: vi.fn().mockResolvedValue({ ok: false, reason: 'transient', error: 'boom' }) };

function baseRow(overrides = {}) {
  return {
    id: 501, tenantId: 1, itineraryId: 90, contactId: 7,
    pnr: 'ABC123', airlineCode: '6E', flightNumber: '6E-201',
    passengerName: 'Asha Rao', seatPref: 'window',
    departureAt: new Date('2026-07-02T06:00:00.000Z'),
    status: 'reminded', attemptsJson: null, boardingPassUrl: null,
    ...overrides,
  };
}

// Last call args to prisma.webCheckin.update
function lastUpdateData() {
  const calls = prisma.webCheckin.update.mock.calls;
  return calls.length ? calls[calls.length - 1][0].data : null;
}
function lastRunOutcome() {
  const calls = prisma.webCheckinAutomationRun.create.mock.calls;
  return calls.length ? calls[calls.length - 1][0].data.outcome : null;
}

beforeAll(() => {
  prisma.webCheckin = { findMany: vi.fn(), update: vi.fn() };
  prisma.itinerary = { findMany: vi.fn() };
  prisma.webCheckinAutomationRun = { create: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  // writeAudit() chains off the latest audit row then creates a new one.
  prisma.auditLog = { findFirst: vi.fn(), create: vi.fn() };
});

beforeEach(() => {
  for (const m of [okAdapter, captchaAdapter, notImplAdapter, failAdapter]) m.performCheckIn.mockClear();
  prisma.webCheckin.findMany.mockReset().mockResolvedValue([]);
  prisma.webCheckin.update.mockReset().mockResolvedValue({});
  prisma.itinerary.findMany.mockReset().mockResolvedValue([]);
  prisma.webCheckinAutomationRun.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.notification.findFirst.mockReset().mockResolvedValue(null);
  prisma.notification.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('processRow — happy path', () => {
  test('adapter ok → done + boardingPassUrl + completedAt + success run', async () => {
    const action = await processRow(baseRow(), { now: NOW, resolveAdapter: () => okAdapter });
    expect(action).toBe('done');
    const data = lastUpdateData();
    expect(data.status).toBe('done');
    expect(data.boardingPassUrl).toBe('/uploads/boarding-passes/x.pdf');
    expect(data.completedAt).toBe(NOW);
    expect(lastRunOutcome()).toBe('success');
    // seat pref forwarded
    expect(okAdapter.performCheckIn).toHaveBeenCalledWith(expect.objectContaining({ seatPref: 'window', pnr: 'ABC123' }));
  });
});

describe('processRow — captcha (FR-7, immediate fallback, no retry)', () => {
  test('adapter captcha → fallback-agent + captcha run', async () => {
    const action = await processRow(baseRow(), { now: NOW, resolveAdapter: () => captchaAdapter });
    expect(action).toBe('fallback');
    expect(lastUpdateData().status).toBe('fallback-agent');
    expect(lastRunOutcome()).toBe('captcha');
  });
});

describe('processRow — not-implemented adapter / no adapter', () => {
  test('adapter not-implemented → fallback-agent + not-implemented run', async () => {
    const action = await processRow(baseRow(), { now: NOW, resolveAdapter: () => notImplAdapter });
    expect(action).toBe('fallback');
    expect(lastUpdateData().status).toBe('fallback-agent');
    expect(lastRunOutcome()).toBe('not-implemented');
  });

  test('no adapter (null) → fallback-agent + not-implemented run, no adapter call', async () => {
    const action = await processRow(baseRow(), { now: NOW, resolveAdapter: () => null });
    expect(action).toBe('fallback');
    expect(lastUpdateData().status).toBe('fallback-agent');
    expect(lastRunOutcome()).toBe('not-implemented');
  });
});

describe('processRow — transient retry policy (FR-6)', () => {
  test('1st transient failure → in-progress + failure run (retry scheduled)', async () => {
    const action = await processRow(baseRow(), { now: NOW, resolveAdapter: () => failAdapter });
    expect(action).toBe('retry-scheduled');
    const data = lastUpdateData();
    expect(data.status).toBe('in-progress');
    expect(JSON.parse(data.attemptsJson)).toHaveLength(1);
    expect(lastRunOutcome()).toBe('failure');
  });

  test(`${MAX_ATTEMPTS}rd transient failure → fallback-agent`, async () => {
    // Two prior failures, both well past any backoff window.
    const old = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const row = baseRow({
      status: 'in-progress',
      attemptsJson: JSON.stringify([
        { at: old, result: 'failure', reason: 'transient' },
        { at: old, result: 'failure', reason: 'transient' },
      ]),
    });
    const action = await processRow(row, { now: NOW, resolveAdapter: () => failAdapter });
    expect(action).toBe('fallback');
    const data = lastUpdateData();
    expect(data.status).toBe('fallback-agent');
    expect(JSON.parse(data.attemptsJson)).toHaveLength(3);
  });

  test('recent failure within backoff window → backoff-wait, no DB writes', async () => {
    const recent = new Date(NOW.getTime() - 10 * 1000).toISOString(); // 10s ago < 1min backoff
    const row = baseRow({
      status: 'in-progress',
      attemptsJson: JSON.stringify([{ at: recent, result: 'failure', reason: 'transient' }]),
    });
    const action = await processRow(row, { now: NOW, resolveAdapter: () => failAdapter });
    expect(action).toBe('backoff-wait');
    expect(prisma.webCheckin.update).not.toHaveBeenCalled();
    expect(failAdapter.performCheckIn).not.toHaveBeenCalled();
  });
});

describe('runWebCheckinAutomationTick — paid/visasure gate', () => {
  test('paid + non-visasure itinerary → processed (done)', async () => {
    prisma.webCheckin.findMany.mockResolvedValueOnce([baseRow()]);
    prisma.itinerary.findMany.mockResolvedValueOnce([{ id: 90, status: 'fully_paid', subBrand: 'tmc' }]);
    const summary = await runWebCheckinAutomationTick(NOW, { resolveAdapter: () => okAdapter });
    expect(summary.scanned).toBe(1);
    expect(summary.done).toBe(1);
  });

  test('unpaid itinerary → skipped (no adapter call)', async () => {
    prisma.webCheckin.findMany.mockResolvedValueOnce([baseRow()]);
    prisma.itinerary.findMany.mockResolvedValueOnce([{ id: 90, status: 'draft', subBrand: 'tmc' }]);
    const summary = await runWebCheckinAutomationTick(NOW, { resolveAdapter: () => okAdapter });
    expect(summary.skipped).toBe(1);
    expect(summary.done).toBe(0);
    expect(okAdapter.performCheckIn).not.toHaveBeenCalled();
  });

  test('visasure itinerary → skipped', async () => {
    prisma.webCheckin.findMany.mockResolvedValueOnce([baseRow()]);
    prisma.itinerary.findMany.mockResolvedValueOnce([{ id: 90, status: 'fully_paid', subBrand: 'visasure' }]);
    const summary = await runWebCheckinAutomationTick(NOW, { resolveAdapter: () => okAdapter });
    expect(summary.skipped).toBe(1);
    expect(summary.done).toBe(0);
  });
});
