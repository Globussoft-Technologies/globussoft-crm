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
 *   - lib/cronRegistry — the SUT registers via cronRegistry.register({...})
 *     (Super Admin Portal / Cron Maintenance retrofit) instead of calling
 *     node-cron directly; we mock register() and capture the tickFn option
 *     to drive tick-behavior assertions, same role the old node-cron
 *     scheduleMock played.
 *
 * NOT covered (intentional):
 *   - formatIndiaMARTDate is exercised indirectly through the IndiaMART
 *     happy path; its exact string format is implementation-detail. We do
 *     not pin it as a separate assertion.
 *   - The 5-min cron schedule (initMarketplaceCron) — wires one
 *     registration; we assert cronRegistry.register was called with the
 *     right name/defaultSchedule/defaultEnabled.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

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

// ── Fake cronRegistry module in require cache (BEFORE requiring SUT) ──
const registerMock = vi.fn().mockResolvedValue({ name: 'marketplaceEngine' });
const cronRegistryPath = requireCJS.resolve('../../lib/cronRegistry.js');
Module._cache[cronRegistryPath] = {
  id: cronRegistryPath,
  filename: cronRegistryPath,
  loaded: true,
  exports: { register: registerMock },
};

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
  registerMock.mockReset().mockResolvedValue({ name: 'marketplaceEngine' });

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

/** Build a fetch Response stub. */
function fakeResponse({ ok = true, status = 200, body = {} } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

// The post-214017c1 engine is tenant-scoped: syncMarketplace(tenantId, provider, io)
// and the MarketplaceConfig lookup/update keys on the composite unique
// { tenantId_provider: { tenantId, provider } }. Tests pass this fixed tenant.
const TENANT = 'tenant-A';

describe('cron/marketplaceEngine — config gating', () => {
  test('inactive config → { skipped: true, reason }', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'indiamart',
      isActive: false,
    });
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'indiamart', null);
    expect(result).toEqual({
      provider: 'indiamart',
      tenantId: TENANT,
      skipped: true,
      reason: 'Not configured or inactive',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('missing config → { skipped: true, reason }', async () => {
    prisma.marketplaceConfig.findUnique.mockResolvedValue(null);
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'justdial', null);
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
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'indiamart', null);
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
      where: { tenantId_provider: { tenantId: TENANT, provider: 'indiamart' } },
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
    // Post-214017c1 dedup is enforced at the DB layer: create() throws a
    // Prisma P2002 unique-constraint violation, which the engine catches and
    // counts as a duplicate (replacing the old findDuplicateMarketplaceLead
    // pre-check). Every create rejects → every row is a duplicate.
    prisma.marketplaceLead.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'indiamart', null);
    logSpy.mockRestore();

    expect(result.created).toBe(0);
    expect(result.duplicates).toBe(2);
    // create IS attempted twice (the dedup race is resolved by the catch).
    expect(prisma.marketplaceLead.create).toHaveBeenCalledTimes(2);
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
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'indiamart', null);
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
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'indiamart', null);
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
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'indiamart', null);
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
    await marketplaceEngine.syncMarketplace(TENANT, 'indiamart', ioMock);
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
    await marketplaceEngine.syncMarketplace(TENANT, 'indiamart', ioMock);
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
    await marketplaceEngine.syncMarketplace(TENANT, 'indiamart', null);
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
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'justdial', null);
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
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'justdial', null);
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
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'justdial', null);
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
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'tradeindia', null);
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
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'tradeindia', null);
    warnSpy.mockRestore();
    logSpy.mockRestore();
    expect(result.fetched).toBe(0);
  });
});

describe('cron/marketplaceEngine — initMarketplaceCron registration', () => {
  test('initMarketplaceCron registers via cronRegistry with the 5-minute default, disabled by default', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    marketplaceEngine.initMarketplaceCron(null);
    logSpy.mockRestore();
    expect(registerMock).toHaveBeenCalledTimes(1);
    const opts = registerMock.mock.calls[0][0];
    expect(opts.name).toBe('marketplaceEngine');
    expect(opts.defaultSchedule).toBe('*/5 * * * *');
    expect(opts.defaultEnabled).toBe(false);
    expect(typeof opts.tickFn).toBe('function');
  });

  test('cron tick iterates active configs and dispatches syncMarketplace per provider', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    marketplaceEngine.initMarketplaceCron(null);
    // Drive the tick. Post-214017c1 the tick lists ALL active configs across
    // tenants (findMany where isActive) and dispatches per (tenantId, provider).
    prisma.marketplaceConfig.findMany.mockResolvedValue([
      { tenantId: TENANT, provider: 'indiamart' },
      { tenantId: TENANT, provider: 'justdial' },
    ]);
    // Each provider call will go through syncMarketplace; pre-stage findUnique
    // to return inactive so each is a fast no-op.
    prisma.marketplaceConfig.findUnique.mockResolvedValue({ isActive: false });
    const tick = registerMock.mock.calls[0][0].tickFn;
    await tick();
    logSpy.mockRestore();
    // findMany scopes to active configs only.
    expect(prisma.marketplaceConfig.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
    });
    // We expect 2 findUnique calls (one per provider in the loop).
    expect(prisma.marketplaceConfig.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.marketplaceConfig.findUnique.mock.calls[0][0]).toEqual({
      where: { tenantId_provider: { tenantId: TENANT, provider: 'indiamart' } },
    });
  });
});

// ───────────────────────────────────────────────────────────────────────
// Extension cases — appended (do NOT modify or interleave with the 17 above).
// Coverage targets:
//   • Unknown provider name → no fetch, no create, lastSyncAt still updates
//   • IndiaMART RESPONSE-wrapped envelope vs bare array
//   • IndiaMART fallback identifiers (QUERY_ID, SENDER_PHONE)
//   • JustDial bare-array response shape + lead_id / id fallback chain
//   • TradeIndia rfi_id + contact_person fallback identifiers
//   • Cron-tick fault isolation: one provider error does NOT block siblings
//   • Cron-tick outer-catch: prisma.findMany throw does NOT kill the tick
//   • Empty active configs list → tick is a graceful no-op
// ───────────────────────────────────────────────────────────────────────

describe('cron/marketplaceEngine — extension: provider dispatch edge cases', () => {
  test('unknown provider name falls through the if/else chain (no fetch, lastSyncAt still bumped)', async () => {
    // Contract: when provider doesn't match indiamart/justdial/tradeinda, fetched
    // stays 0 (no sync function called) but lastSyncAt is still updated. This pins
    // the "graceful unknown-provider" behaviour — useful if a new provider value
    // ever lands in MarketplaceConfig before the engine learns it.
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'newvendor',
      isActive: true,
      apiKey: 'k',
      lastSyncAt: null,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'newvendor', null);
    logSpy.mockRestore();
    expect(result.fetched).toBe(0);
    expect(result.created).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    // lastSyncAt should still be touched — that part of the contract runs AFTER
    // the if/else branches regardless of which (or no) provider matched.
    expect(prisma.marketplaceConfig.update).toHaveBeenCalledWith({
      where: { tenantId_provider: { tenantId: TENANT, provider: 'newvendor' } },
      data: { lastSyncAt: expect.any(Date) },
    });
  });
});

describe('cron/marketplaceEngine — extension: IndiaMART response shapes & fallbacks', () => {
  test('RESPONSE-wrapped envelope ({ RESPONSE: [...] }) is parsed identically to a bare array', async () => {
    // IndiaMART's actual production API returns { RESPONSE: [...] } (object envelope).
    // The SUT supports BOTH bare-array and object-envelope; this case pins the envelope
    // path so a future SUT refactor doesn't silently regress to "array only".
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'indiamart',
      isActive: true,
      glueCrmKey: 'k',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(
      fakeResponse({
        body: {
          RESPONSE: [
            { UNIQUE_QUERY_ID: 'IM-ENV-1', SENDER_NAME: 'EnvelopedLead' },
          ],
        },
      })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'indiamart', null);
    logSpy.mockRestore();
    expect(result.fetched).toBe(1);
    expect(result.created).toBe(1);
    expect(prisma.marketplaceLead.create.mock.calls[0][0].data.externalLeadId).toBe('IM-ENV-1');
    expect(prisma.marketplaceLead.create.mock.calls[0][0].data.name).toBe('EnvelopedLead');
  });

  test('IndiaMART externalId falls back to QUERY_ID when UNIQUE_QUERY_ID absent', async () => {
    // Per SUT line 71: externalId = UNIQUE_QUERY_ID || QUERY_ID || ''. Pin the
    // QUERY_ID fallback — without this, an older IndiaMART payload variant goes
    // silently skipped and we lose leads.
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'indiamart',
      isActive: true,
      apiKey: 'k',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(
      fakeResponse({
        body: [
          // No UNIQUE_QUERY_ID — only QUERY_ID
          { QUERY_ID: 'IM-FALLBACK-Q-42', SENDER_NAME: 'FallbackLead', SENDER_PHONE: '+91 555 0123' },
        ],
      })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'indiamart', null);
    logSpy.mockRestore();
    expect(result.created).toBe(1);
    const createArgs = prisma.marketplaceLead.create.mock.calls[0][0].data;
    expect(createArgs.externalLeadId).toBe('IM-FALLBACK-Q-42');
    // SENDER_PHONE should also be picked up as the phone field when SENDER_MOBILE absent.
    expect(createArgs.phone).toBe('+91 555 0123');
  });
});

describe('cron/marketplaceEngine — extension: JustDial response shapes & id fallbacks', () => {
  test('JustDial bare-array response (not envelope-wrapped) is parsed identically', async () => {
    // SUT line 117: leads = Array.isArray(data) ? data : data.leads || []. The
    // existing happy-path test only exercises the { leads: [...] } envelope shape.
    // Pin the bare-array path so the dual-shape contract holds.
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'justdial',
      isActive: true,
      apiKey: 'k',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(
      fakeResponse({
        body: [
          { leadid: 'JD-BARE-1', name: 'BareJD', phone: '+919000000000' },
        ],
      })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'justdial', null);
    logSpy.mockRestore();
    expect(result.created).toBe(1);
    expect(prisma.marketplaceLead.create.mock.calls[0][0].data.externalLeadId).toBe('JD-BARE-1');
    expect(prisma.marketplaceLead.create.mock.calls[0][0].data.phone).toBe('+919000000000');
  });

  test('JustDial externalId falls back through leadid → lead_id → id chain', async () => {
    // SUT line 121: externalId = leadid || lead_id || id || ''. Pin the SECOND
    // and THIRD fallbacks — current happy-path test only covers leadid.
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'justdial',
      isActive: true,
      apiKey: 'k',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(
      fakeResponse({
        body: {
          leads: [
            { lead_id: 'JD-2ND-FB', name: 'SecondFallback' },
            { id: 'JD-3RD-FB', name: 'ThirdFallback' },
          ],
        },
      })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'justdial', null);
    logSpy.mockRestore();
    expect(result.created).toBe(2);
    const ids = prisma.marketplaceLead.create.mock.calls.map((c) => c[0].data.externalLeadId);
    expect(ids).toEqual(['JD-2ND-FB', 'JD-3RD-FB']);
  });
});

describe('cron/marketplaceEngine — extension: TradeIndia field fallbacks', () => {
  test('TradeIndia externalId falls back to rfi_id when inquiry_id absent + contact_person fills name', async () => {
    // SUT line 174: externalId = inquiry_id || rfi_id || ''. And line 185:
    // name = sender_name || contact_person || null. Pin both fallback paths
    // — TradeIndia ships at least two distinct payload schemas in production.
    prisma.marketplaceConfig.findUnique.mockResolvedValue({
      provider: 'tradeindia',
      isActive: true,
      apiKey: 'k',
      apiSecret: 's',
      lastSyncAt: null,
    });
    fetchMock.mockResolvedValue(
      fakeResponse({
        body: {
          inquiries: [
            {
              // No inquiry_id — must fall back to rfi_id
              rfi_id: 'TI-RFI-77',
              // No sender_name — must fall back to contact_person
              contact_person: 'Eva Buyer',
              sender_email: 'eva@example.com',
              product_name: 'Industrial Pump',
            },
          ],
        },
      })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await marketplaceEngine.syncMarketplace(TENANT, 'tradeindia', null);
    logSpy.mockRestore();
    expect(result.created).toBe(1);
    const data = prisma.marketplaceLead.create.mock.calls[0][0].data;
    expect(data.externalLeadId).toBe('TI-RFI-77');
    expect(data.name).toBe('Eva Buyer');
    expect(data.email).toBe('eva@example.com');
    expect(data.product).toBe('Industrial Pump');
  });
});

describe('cron/marketplaceEngine — extension: cron-tick fault isolation', () => {
  test('one provider syncMarketplace throw does NOT block sibling providers in same tick', async () => {
    // SUT line 232-236: per-provider try/catch inside the loop. Pin the isolation:
    // if syncMarketplace throws on provider #1, provider #2 still runs. Without
    // this guard one bad partner-API call could brick the entire 5-min cycle.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    marketplaceEngine.initMarketplaceCron(null);

    prisma.marketplaceConfig.findMany.mockResolvedValue([
      { tenantId: TENANT, provider: 'indiamart' },
      { tenantId: TENANT, provider: 'justdial' },
    ]);

    // First findUnique (indiamart) throws synchronously inside syncMarketplace.
    // Second findUnique (justdial) resolves to inactive → fast no-op.
    let call = 0;
    prisma.marketplaceConfig.findUnique.mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error('PRISMA_DOWN');
      return { isActive: false };
    });

    const tick = registerMock.mock.calls[0][0].tickFn;
    await tick(); // must not reject
    logSpy.mockRestore();
    errSpy.mockRestore();
    // Both providers attempted, despite #1 throwing.
    expect(prisma.marketplaceConfig.findUnique).toHaveBeenCalledTimes(2);
  });

  test('a prisma.findMany throw propagates to the caller — cronRegistry.runTick (not this engine) now owns tick-level fault isolation', async () => {
    // Since the Super Admin Portal / Cron Maintenance retrofit, the outer
    // "never let a tick reject" guarantee moved to cronRegistry.runTick
    // (see test/lib/cronRegistry.test.js's "thrown tickFn error is caught,
    // logged as failed... and does not propagate" case) so every engine's
    // failures are uniformly captured as a CronExecutionLog row instead of
    // each engine re-implementing its own outer try/catch. This engine's
    // tick() therefore no longer swallows a findMany throw itself — it
    // propagates, and the registry is what contains it.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    marketplaceEngine.initMarketplaceCron(null);

    prisma.marketplaceConfig.findMany.mockRejectedValue(new Error('DB_CONNECTION_LOST'));

    const tick = registerMock.mock.calls[0][0].tickFn;
    await expect(tick()).rejects.toThrow('DB_CONNECTION_LOST');
    logSpy.mockRestore();
    // Loop never started — findUnique never reached.
    expect(prisma.marketplaceConfig.findUnique).not.toHaveBeenCalled();
  });

  test('empty active configs list → tick is a graceful no-op (no provider work, no throw)', async () => {
    // SUT: findMany returns []. The for-loop body never runs. Pin this
    // because a freshly-provisioned tenant with no configured marketplaces is the
    // STEADY STATE for most installs.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    marketplaceEngine.initMarketplaceCron(null);

    prisma.marketplaceConfig.findMany.mockResolvedValue([]);

    const tick = registerMock.mock.calls[0][0].tickFn;
    await expect(tick()).resolves.toBeUndefined();
    logSpy.mockRestore();
    // No syncMarketplace work → no findUnique, no fetch, no create.
    expect(prisma.marketplaceConfig.findUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.marketplaceLead.create).not.toHaveBeenCalled();
  });
});
