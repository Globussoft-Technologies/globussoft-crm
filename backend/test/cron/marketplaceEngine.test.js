// @ts-check
/**
 * Unit tests for backend/cron/marketplaceEngine.js — Wave 11 Agent A.
 *
 * Why this file exists (regression class):
 *   Pre-Wave-11 the module was 0% covered. The engine syncs leads every 5
 *   minutes from three marketplace providers (IndiaMART / JustDial /
 *   TradeIndia). Each provider is fetched via global fetch; per-record
 *   dedup via findDuplicateMarketplaceLead (utils/deduplication). The
 *   contract under test:
 *     - Inactive / missing config → { skipped: true, reason }
 *     - Missing API key → fetched=0 (graceful skip, no exception)
 *     - Happy path → creates new MarketplaceLead rows + updates lastSyncAt
 *     - Dedup branch → existing row triggers onDuplicate, no create
 *     - Records without externalId are skipped (continue)
 *     - IndiaMART HTTP error → throws → outer catch logs + returns { error }
 *     - JustDial / TradeIndia HTTP error → swallowed (returns 0 — soft fail)
 *     - Socket.io emit fires when at least one new lead was created
 *     - Cron tick wires schedule (init function exported)
 *
 * Mocking strategy:
 *   - createRequire + cache delete (matches backupEngine.test.js pattern).
 *     The SUT destructures findDuplicateMarketplaceLead from
 *     '../utils/deduplication' at module load. We install a fake module
 *     in the cache BEFORE requiring the SUT.
 *   - lib/prisma — re-use the existing singleton, monkey-patch model
 *     methods (mirrors slaBreachEngine.test.js).
 *   - global.fetch — vi.fn() reset per test.
 *   - node-cron — same monkey-patch dance.
 *
 * NOT covered (intentional):
 *   - formatIndiaMARTDate is exercised indirectly through the IndiaMART
 *     happy path; its exact string format is implementation-detail. We do
 *     not pin it as a separate assertion.
 *   - The 5-min cron schedule (initMarketplaceCron) — wires one schedule;
 *     we assert it was called.
 */
import { describe, test, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const nodeCron = requireCJS('node-cron');

// ── Fake deduplication module in require cache ─────────────────────────
const findDupMock = vi.fn();
const Module = requireCJS('node:module');
const dedupPath = requireCJS.resolve('../../utils/deduplication.js');
const fakeDedupExports = {
  findDuplicateMarketplaceLead: findDupMock,
};
Module._cache[dedupPath] = {
  id: dedupPath,
  filename: dedupPath,
  loaded: true,
  exports: fakeDedupExports,
};

// ── Mock prisma BEFORE requiring SUT ───────────────────────────────────
import prisma from '../../lib/prisma.js';
prisma.marketplaceConfig = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
};
prisma.marketplaceLead = {
  create: vi.fn(),
};

// ── Patch node-cron BEFORE requiring SUT ───────────────────────────────
const originalSchedule = nodeCron.schedule;
const scheduleMock = vi.fn();
nodeCron.schedule = scheduleMock;

// ── Require SUT — destructured findDup ref captured against the fake ──
const sutPath = requireCJS.resolve('../../cron/marketplaceEngine.js');
delete requireCJS.cache[sutPath];
const marketplaceEngine = requireCJS('../../cron/marketplaceEngine.js');

// ── global.fetch mock ──────────────────────────────────────────────────
let fetchMock;
const originalFetch = global.fetch;

beforeEach(() => {
  findDupMock.mockReset();
  prisma.marketplaceConfig.findUnique.mockReset();
  prisma.marketplaceConfig.findMany.mockReset();
  prisma.marketplaceConfig.update.mockReset();
  prisma.marketplaceLead.create.mockReset();
  scheduleMock.mockReset();

  // Defaults
  findDupMock.mockResolvedValue(null);
  prisma.marketplaceConfig.update.mockResolvedValue({});
  prisma.marketplaceLead.create.mockResolvedValue({ id: 1 });

  fetchMock = vi.fn();
  global.fetch = fetchMock;
});

afterEach(() => {
  global.fetch = originalFetch;
});

afterAll(() => {
  nodeCron.schedule = originalSchedule;
});

/** Build a fetch Response stub. */
function fakeResponse({ ok = true, status = 200, body = {} } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

describe('cron/marketplaceEngine — config gating', () => {
  test('inactive config → { skipped: true, reason }', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'indiamart',
      isActive: false,
    });
    const result = await marketplaceEngine.syncMarketplace('indiamart', null);
    expect(result).toEqual({
      provider: 'indiamart',
      skipped: true,
      reason: 'Not configured or inactive',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('missing config → { skipped: true, reason }', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue(null);
    const result = await marketplaceEngine.syncMarketplace('justdial', null);
    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('cron/marketplaceEngine — IndiaMART sync', () => {
  test('happy path: 2 new leads → creates 2 + updates lastSyncAt', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'indiamart',
      isActive: true,
      glueCrmKey: 'abc-key',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(
      fakeResponse({
        body: [
          {
            UNIQUE_QUERY_ID: 'IM-1',
            SENDER_NAME: 'Acme',
            SENDER_EMAIL: 'a@b.com',
            SENDER_MOBILE: '+919999999999',
            SENDER_COMPANY: 'AcmeCo',
            QUERY_PRODUCT_NAME: 'Widget',
            QUERY_MESSAGE: 'Send quote',
            SENDER_CITY: 'Mumbai',
          },
          { UNIQUE_QUERY_ID: 'IM-2', SENDER_NAME: 'Bob' },
        ],
      })
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace('indiamart', null);
    logSpy.mockRestore();

    expect(result).toMatchObject({
      provider: 'indiamart',
      fetched: 2,
      created: 2,
      duplicates: 0,
    });
    expect(prisma.marketplaceLead.create).toHaveBeenCalledTimes(2);
    const firstCreate = prisma.marketplaceLead.create.mock.calls[0][0];
    expect(firstCreate.data.provider).toBe('indiamart');
    expect(firstCreate.data.externalLeadId).toBe('IM-1');
    expect(firstCreate.data.name).toBe('Acme');
    expect(firstCreate.data.email).toBe('a@b.com');
    expect(firstCreate.data.status).toBe('New');
    expect(prisma.marketplaceConfig.update).toHaveBeenCalledWith({
      where: { provider: 'indiamart' },
      data: { lastSyncAt: expect.any(Date) },
    });
  });

  test('all duplicates: existing rows trigger onDuplicate, no creates', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'indiamart',
      isActive: true,
      glueCrmKey: 'abc-key',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(
      fakeResponse({
        body: [
          { UNIQUE_QUERY_ID: 'IM-EXISTING-1' },
          { UNIQUE_QUERY_ID: 'IM-EXISTING-2' },
        ],
      })
    );
    findDupMock.mockResolvedValue({ id: 99 }); // every lookup returns existing

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace('indiamart', null);
    logSpy.mockRestore();

    expect(result.created).toBe(0);
    expect(result.duplicates).toBe(2);
    expect(prisma.marketplaceLead.create).not.toHaveBeenCalled();
  });

  test('records without externalId are skipped', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'indiamart',
      isActive: true,
      apiKey: 'key',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(
      fakeResponse({
        body: [{ SENDER_NAME: 'NoId' }, { UNIQUE_QUERY_ID: 'IM-3' }],
      })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace('indiamart', null);
    logSpy.mockRestore();

    // 2 leads "fetched" but only 1 created (the one with an externalId).
    expect(result.created).toBe(1);
    expect(prisma.marketplaceLead.create).toHaveBeenCalledTimes(1);
  });

  test('missing API key → returns fetched=0 (no fetch call)', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'indiamart',
      isActive: true,
      // both glueCrmKey + apiKey absent
      lastSyncAt: null,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace('indiamart', null);
    logSpy.mockRestore();
    expect(result.fetched).toBe(0);
    expect(result.created).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('IndiaMART HTTP 500 → throws → outer catch returns { error }', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'indiamart',
      isActive: true,
      apiKey: 'k',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 500 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace('indiamart', null);
    errSpy.mockRestore();
    expect(result.provider).toBe('indiamart');
    expect(result.error).toMatch(/500/);
  });

  test('socket.io io.emit fires when at least one new lead created', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'indiamart',
      isActive: true,
      apiKey: 'k',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(
      fakeResponse({ body: [{ UNIQUE_QUERY_ID: 'IM-emit' }] })
    );
    const ioMock = { emit: vi.fn() };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await marketplaceEngine.syncMarketplace('indiamart', ioMock);
    logSpy.mockRestore();
    expect(ioMock.emit).toHaveBeenCalledWith('marketplace_lead_new', {
      provider: 'indiamart',
      count: 1,
    });
  });

  test('io.emit does NOT fire when no new leads created', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'indiamart',
      isActive: true,
      apiKey: 'k',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(fakeResponse({ body: [] }));
    const ioMock = { emit: vi.fn() };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await marketplaceEngine.syncMarketplace('indiamart', ioMock);
    logSpy.mockRestore();
    expect(ioMock.emit).not.toHaveBeenCalled();
  });

  test('lastSyncAt drives the start_time query param when present', async () => {
    const since = new Date('2026-05-01T00:00:00Z');
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'indiamart',
      isActive: true,
      apiKey: 'k',
      lastSyncAt: since,
    });
    fetchMock.mockResolvedValue(fakeResponse({ body: [] }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await marketplaceEngine.syncMarketplace('indiamart', null);
    logSpy.mockRestore();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0];
    // The formatted IndiaMART date should appear (DD-Mon-YYYY HH:MM:SS).
    expect(url).toMatch(/start_time=/);
    expect(decodeURIComponent(url)).toMatch(/2026/);
  });
});

describe('cron/marketplaceEngine — JustDial sync (soft-fail)', () => {
  test('happy path: creates a lead from leadid', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'justdial',
      isActive: true,
      apiKey: 'jd-key',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(
      fakeResponse({
        body: {
          leads: [
            {
              leadid: 'JD-1',
              name: 'Charlie',
              email: 'c@d.com',
              mobile: '+919876543210',
              category: 'Service',
            },
          ],
        },
      })
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace('justdial', null);
    logSpy.mockRestore();

    expect(result.created).toBe(1);
    expect(prisma.marketplaceLead.create).toHaveBeenCalledOnce();
    expect(prisma.marketplaceLead.create.mock.calls[0][0].data.provider).toBe('justdial');
    expect(prisma.marketplaceLead.create.mock.calls[0][0].data.externalLeadId).toBe('JD-1');
  });

  test('non-OK HTTP soft-fails → returns 0 (does NOT throw)', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'justdial',
      isActive: true,
      apiKey: 'k',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 401 }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace('justdial', null);
    warnSpy.mockRestore();
    logSpy.mockRestore();
    expect(result.fetched).toBe(0);
    expect(result.created).toBe(0);
    // lastSyncAt still updated — soft-fail does not abort the outer pipeline.
    expect(prisma.marketplaceConfig.update).toHaveBeenCalled();
  });

  test('fetch network error soft-fails (returns 0)', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'justdial',
      isActive: true,
      apiKey: 'k',
      lastSyncAt: null,
    });
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace('justdial', null);
    warnSpy.mockRestore();
    logSpy.mockRestore();
    expect(result.fetched).toBe(0);
  });
});

describe('cron/marketplaceEngine — TradeIndia sync (soft-fail)', () => {
  test('happy path: creates a lead from inquiry_id', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'tradeindia',
      isActive: true,
      apiKey: 'ti-key',
      apiSecret: 'ti-secret',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(
      fakeResponse({
        body: {
          inquiries: [
            {
              inquiry_id: 'TI-1',
              sender_name: 'Dave',
              sender_email: 'd@e.com',
              sender_mobile: '+919811111111',
              product_name: 'Pump',
            },
          ],
        },
      })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace('tradeindia', null);
    logSpy.mockRestore();
    expect(result.created).toBe(1);
    expect(prisma.marketplaceLead.create.mock.calls[0][0].data.externalLeadId).toBe('TI-1');
  });

  test('non-OK HTTP soft-fails → returns 0', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'tradeindia',
      isActive: true,
      apiKey: 'k',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 503 }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace('tradeindia', null);
    warnSpy.mockRestore();
    logSpy.mockRestore();
    expect(result.fetched).toBe(0);
  });
});

describe('cron/marketplaceEngine — initMarketplaceCron registration', () => {
  test('initMarketplaceCron registers a 5-minute schedule', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    marketplaceEngine.initMarketplaceCron(null);
    logSpy.mockRestore();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0][0]).toBe('*/5 * * * *');
    expect(typeof scheduleMock.mock.calls[0][1]).toBe('function');
  });

  test('cron tick iterates active configs and dispatches syncMarketplace per provider', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    marketplaceEngine.initMarketplaceCron(null);
    // Drive the tick
    prisma.marketplaceConfig.findMany.mockResolvedValue([
      { provider: 'indiamart' },
      { provider: 'justdial' },
    ]);
    // Each provider call will go through syncMarketplace; pre-stage findUnique
    // to return inactive so each is a fast no-op.
    prisma.marketplaceConfig.findUnique.mockResolvedValue({ isActive: false });
    const tick = scheduleMock.mock.calls[0][1];
    await tick();
    logSpy.mockRestore();
    // We expect 2 findUnique calls (one per provider in the loop).
    expect(prisma.marketplaceConfig.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.marketplaceConfig.findUnique.mock.calls[0][0]).toEqual({
      where: { provider: 'indiamart' },
    });
  });
});
