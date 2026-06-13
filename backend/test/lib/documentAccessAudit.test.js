// documentAccessAudit.test.js — unit tests for lib/documentAccessAudit.js.
//
// Master PRD A3 / G124 — per-document view/download/share audit rows. The
// helper is a thin wrapper around writeAudit (the existing per-tenant
// hash-chained audit-log emitter); it normalises the (event → action) verb
// mapping + the details payload shape across every route that needs to log
// a document fetch.
//
// Contracts pinned:
//   1. Each allowed event ('view' / 'download' / 'share') maps to the right
//      DOCUMENT_<X> action verb.
//   2. The helper short-circuits + warns on missing tenantId, missing event,
//      invalid event verb, missing documentType, and missing documentId — it
//      MUST NOT throw and MUST NOT call writeAudit on any of those branches.
//   3. viewerEmail / ipAddress / userAgent / shareTokenId / extra all ride
//      inside the `details` JSON blob — NO new schema is involved.
//   4. shareTokenId is truncated (first 8 + last 4) so the raw bearer secret
//      never lands in audit details.
//   5. Anonymous viewers (null userId) get actorType='customer' in opts so
//      audit-viewer can separate customer share-link visits from operator
//      accesses; userId-provided callers get the default actorType=user.
//   6. Tenant isolation — tenantId is passed straight through to writeAudit
//      (chain scope) so cross-tenant audit-row writes are impossible at the
//      helper layer.
//   7. writeAudit failures (mocked) must NOT propagate — helper swallows
//      errors with a console.warn (audit emission is best-effort).
//
// Mocking strategy: lib/documentAccessAudit.js is CJS and loads its writeAudit
// dependency via `require('./audit')`. vitest's ESM-level vi.mock can't reach
// require() calls inside CJS modules, so we use Node's Module._cache to
// pre-populate the cached audit module with our mock BEFORE the SUT loads.
// This is the same pattern used by services/appointmentService.test.js.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

const mocks = vi.hoisted(() => {
  const auditMock = { writeAudit: vi.fn().mockResolvedValue(undefined) };

  const Module = require('node:module');
  const requireFromCwd = Module.createRequire(process.cwd() + '/');
  const auditLibPath = requireFromCwd.resolve('./lib/audit');
  Module._cache[auditLibPath] = {
    id: auditLibPath,
    filename: auditLibPath,
    loaded: true,
    exports: auditMock,
    children: [],
    paths: [],
  };
  return { audit: auditMock };
});

let sut;

beforeEach(() => {
  // Fresh load per test — purges any prior caching so the mock writeAudit is
  // wired in cleanly.
  delete requireCjs.cache[requireCjs.resolve('../../lib/documentAccessAudit.js')];
  sut = requireCjs('../../lib/documentAccessAudit.js');
  mocks.audit.writeAudit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('EVENT_TO_ACTION mapping (contract #1)', () => {
  test('maps the three PRD A3 events to DOCUMENT_<X> action verbs', () => {
    expect(sut.EVENT_TO_ACTION.view).toBe('DOCUMENT_VIEW');
    expect(sut.EVENT_TO_ACTION.download).toBe('DOCUMENT_DOWNLOAD');
    expect(sut.EVENT_TO_ACTION.share).toBe('DOCUMENT_SHARE');
  });

  test('exposes the allowed-events list for downstream validators', () => {
    expect(sut.ALLOWED_EVENTS).toEqual(['view', 'download', 'share']);
  });
});

describe('recordDocumentAccess — happy path (contract #1, #3, #5, #6)', () => {
  test('view event writes the right entity + action + tenant', async () => {
    await sut.recordDocumentAccess({
      tenantId: 42,
      userId: 7,
      documentType: 'Itinerary',
      documentId: 101,
      event: 'view',
    });

    expect(mocks.audit.writeAudit).toHaveBeenCalledTimes(1);
    const [entity, action, documentId, userId, tenantId, details, opts] =
      mocks.audit.writeAudit.mock.calls[0];
    expect(entity).toBe('Itinerary');
    expect(action).toBe('DOCUMENT_VIEW');
    expect(documentId).toBe(101);
    expect(userId).toBe(7);
    expect(tenantId).toBe(42);
    expect(details.documentType).toBe('Itinerary');
    expect(details.event).toBe('view');
    // Authenticated caller → no actorType opts override (defaults to 'user').
    expect(opts).toBeUndefined();
  });

  test('download event writes the right action verb', async () => {
    await sut.recordDocumentAccess({
      tenantId: 3,
      userId: 5,
      documentType: 'TravelInvoice',
      documentId: 999,
      event: 'download',
    });

    const [, action] = mocks.audit.writeAudit.mock.calls[0];
    expect(action).toBe('DOCUMENT_DOWNLOAD');
  });

  test('share event writes the right action verb', async () => {
    await sut.recordDocumentAccess({
      tenantId: 3,
      userId: 5,
      documentType: 'Itinerary',
      documentId: 17,
      event: 'share',
    });

    const [, action] = mocks.audit.writeAudit.mock.calls[0];
    expect(action).toBe('DOCUMENT_SHARE');
  });

  test('captures viewerEmail + ipAddress + userAgent in the details blob', async () => {
    await sut.recordDocumentAccess({
      tenantId: 1,
      userId: 8,
      documentType: 'TravelQuote',
      documentId: 555,
      event: 'view',
      viewerEmail: 'customer@example.com',
      ipAddress: '203.0.113.4',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
    });

    const details = mocks.audit.writeAudit.mock.calls[0][5];
    expect(details.viewerEmail).toBe('customer@example.com');
    expect(details.ipAddress).toBe('203.0.113.4');
    expect(details.userAgent).toBe('Mozilla/5.0 (Windows NT 10.0)');
  });

  test('extra fields merge into details (sub-brand, version, etc.)', async () => {
    await sut.recordDocumentAccess({
      tenantId: 1,
      userId: 8,
      documentType: 'Itinerary',
      documentId: 555,
      event: 'download',
      extra: { subBrand: 'tmc', version: 3 },
    });

    const details = mocks.audit.writeAudit.mock.calls[0][5];
    expect(details.subBrand).toBe('tmc');
    expect(details.version).toBe(3);
  });

  test('anonymous viewer (null userId) gets actorType=customer (contract #5)', async () => {
    await sut.recordDocumentAccess({
      tenantId: 1,
      userId: null,
      documentType: 'TravelQuote',
      documentId: 7,
      event: 'view',
    });

    const [, , , userId, , , opts] = mocks.audit.writeAudit.mock.calls[0];
    expect(userId).toBeNull();
    expect(opts).toEqual({ actorType: 'customer' });
  });
});

describe('recordDocumentAccess — share-token truncation (contract #4)', () => {
  test('long share token is truncated to first-8...last-4', async () => {
    const fullToken = 'abcdef0123456789ZZZZ_secret_tail_4ZZZ';
    await sut.recordDocumentAccess({
      tenantId: 1,
      userId: null,
      documentType: 'Itinerary',
      documentId: 1,
      event: 'view',
      shareTokenId: fullToken,
    });

    const details = mocks.audit.writeAudit.mock.calls[0][5];
    // Truncated: first 8 chars + "..." + last 4 chars.
    expect(details.shareTokenId).toBe('abcdef01...4ZZZ');
    // Full secret must NEVER land in details.
    expect(details.shareTokenId).not.toContain('secret');
  });

  test('short share-token is recorded verbatim (already opaque)', async () => {
    await sut.recordDocumentAccess({
      tenantId: 1,
      userId: null,
      documentType: 'Itinerary',
      documentId: 1,
      event: 'view',
      shareTokenId: 'tiny',
    });

    expect(mocks.audit.writeAudit.mock.calls[0][5].shareTokenId).toBe('tiny');
  });
});

describe('recordDocumentAccess — short-circuits + never throws (contract #2)', () => {
  test('missing tenantId → no writeAudit call + no throw', async () => {
    await expect(
      sut.recordDocumentAccess({
        userId: 1,
        documentType: 'Itinerary',
        documentId: 1,
        event: 'view',
      }),
    ).resolves.toBeUndefined();
    expect(mocks.audit.writeAudit).not.toHaveBeenCalled();
  });

  test('invalid event verb → no writeAudit call', async () => {
    await sut.recordDocumentAccess({
      tenantId: 1,
      documentType: 'Itinerary',
      documentId: 1,
      event: 'spy', // not in ALLOWED_EVENTS
    });
    expect(mocks.audit.writeAudit).not.toHaveBeenCalled();
  });

  test('missing event → no writeAudit call', async () => {
    await sut.recordDocumentAccess({
      tenantId: 1,
      documentType: 'Itinerary',
      documentId: 1,
    });
    expect(mocks.audit.writeAudit).not.toHaveBeenCalled();
  });

  test('missing documentType → no writeAudit call', async () => {
    await sut.recordDocumentAccess({
      tenantId: 1,
      documentId: 1,
      event: 'view',
    });
    expect(mocks.audit.writeAudit).not.toHaveBeenCalled();
  });

  test('missing documentId → no writeAudit call', async () => {
    await sut.recordDocumentAccess({
      tenantId: 1,
      documentType: 'Itinerary',
      event: 'view',
    });
    expect(mocks.audit.writeAudit).not.toHaveBeenCalled();
  });

  test('writeAudit throws → helper swallows + no rethrow (contract #7)', async () => {
    mocks.audit.writeAudit.mockRejectedValueOnce(new Error('chain head conflict'));
    await expect(
      sut.recordDocumentAccess({
        tenantId: 1,
        userId: 2,
        documentType: 'Itinerary',
        documentId: 99,
        event: 'view',
      }),
    ).resolves.toBeUndefined();
    expect(mocks.audit.writeAudit).toHaveBeenCalledTimes(1);
  });
});

describe('recordDocumentAccess — tenant isolation (contract #6)', () => {
  test('tenantA + tenantB write to their own scopes', async () => {
    await sut.recordDocumentAccess({
      tenantId: 10,
      userId: 1,
      documentType: 'Itinerary',
      documentId: 5,
      event: 'view',
    });
    await sut.recordDocumentAccess({
      tenantId: 20,
      userId: 2,
      documentType: 'Itinerary',
      documentId: 5,
      event: 'view',
    });

    expect(mocks.audit.writeAudit).toHaveBeenCalledTimes(2);
    // Tenant args are passed straight through — the chain helper handles
    // per-tenant scope, so a misrouted tenant would surface here.
    expect(mocks.audit.writeAudit.mock.calls[0][4]).toBe(10);
    expect(mocks.audit.writeAudit.mock.calls[1][4]).toBe(20);
  });
});

describe('recordDocumentAccess — PII length caps (defensive)', () => {
  test('over-long viewerEmail / ipAddress / userAgent are capped', async () => {
    const longEmail = 'a'.repeat(500) + '@example.com';
    const longUa = 'UA-' + 'x'.repeat(500);
    await sut.recordDocumentAccess({
      tenantId: 1,
      userId: 1,
      documentType: 'Itinerary',
      documentId: 1,
      event: 'view',
      viewerEmail: longEmail,
      ipAddress: '1'.repeat(200),
      userAgent: longUa,
    });
    const details = mocks.audit.writeAudit.mock.calls[0][5];
    expect(details.viewerEmail.length).toBeLessThanOrEqual(200);
    expect(details.ipAddress.length).toBeLessThanOrEqual(64);
    expect(details.userAgent.length).toBeLessThanOrEqual(200);
  });
});
