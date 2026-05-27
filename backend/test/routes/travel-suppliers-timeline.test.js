// @ts-check
/**
 * Arc 2 #903 slice 21 — GET /api/travel/suppliers/:id/timeline
 * unified supplier-event activity feed.
 *
 * Pins the contract for the supplier-dashboard activity stream endpoint
 * added to backend/routes/travel_suppliers.js + the pure event-merge
 * helper at backend/lib/supplierTimeline.js. Heterogeneous event streams
 * (supplier-master, payables, credentials, credential-access-log) merged
 * + sorted newest-first via a pure composer (no schema edits).
 *
 * What's pinned
 * -------------
 *   - Happy path: 4 sources → events of every kind, sorted descending.
 *   - SUPPLIER_UPDATED suppressed when updatedAt - createdAt <= 1s (auto-
 *     stamp at row create); fires when delta exceeds 1s threshold.
 *   - PAYABLE_PAID fires only when paidAt is set; CANCELLED uses updatedAt.
 *   - CREDENTIAL_<ACTION> uppercases + slugifies the action token
 *     (`used-in-checkin` → `CREDENTIAL_USED_IN_CHECKIN`).
 *   - ?limit clamped to MAX (500); default 100; invalid silently → default.
 *   - ?since strict-after filter (cursor event itself excluded).
 *   - ?since=garbage → 400 INVALID_SINCE.
 *   - 404 SUPPLIER_NOT_FOUND when supplier missing.
 *   - 403 SUB_BRAND_DENIED for cross-sub-brand MANAGER.
 *   - 400 INVALID_ID for non-numeric :id.
 *   - Route ordering: /suppliers/:id/timeline registers BEFORE /suppliers/:id
 *     (sub-paths-before-:id standing rule) — the response carries `events`,
 *     never the bare supplier row.
 *
 * Test pattern mirrors travel-suppliers-scorecard.test.js (slice 16) — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router, then
 * drive supertest with HS256 JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelSupplier = prisma.travelSupplier || {};
prisma.travelSupplier.findFirst = vi.fn();
prisma.travelSupplierPayable = prisma.travelSupplierPayable || {};
prisma.travelSupplierPayable.findMany = vi.fn();
prisma.supplierCredential = prisma.supplierCredential || {};
prisma.supplierCredential.findMany = vi.fn();
prisma.supplierCredentialAccessLog = prisma.supplierCredentialAccessLog || {};
prisma.supplierCredentialAccessLog.findMany = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelSuppliersRouter = requireCJS('../../routes/travel_suppliers');
const { composeSupplierTimeline } = requireCJS('../../lib/supplierTimeline');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelSuppliersRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000);
}

beforeEach(() => {
  prisma.travelSupplier.findFirst.mockReset();
  prisma.travelSupplierPayable.findMany.mockReset();
  prisma.supplierCredential.findMany.mockReset();
  prisma.supplierCredentialAccessLog.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
});

describe('composeSupplierTimeline (pure helper)', () => {
  test('merges + sorts events newest-first across all sources', () => {
    const supplier = {
      id: 1,
      createdAt: daysAgo(30),
      // 5 days later — well past 1s threshold → SUPPLIER_UPDATED fires.
      updatedAt: daysAgo(25),
      name: 'Hilton',
    };
    const payables = [
      { id: 11, createdAt: daysAgo(20), paidAt: daysAgo(10), status: 'paid', amount: '500.00', currency: 'INR', poNumber: 'PO-1' },
      { id: 12, createdAt: daysAgo(15), updatedAt: daysAgo(5), paidAt: null, status: 'cancelled', amount: '200.00', currency: 'INR', poNumber: 'PO-2' },
    ];
    const credentials = [
      { id: 21, createdAt: daysAgo(28), category: 'hotel' },
    ];
    const accessLog = [
      { id: 31, credentialId: 21, userId: 7, action: 'rotated', at: daysAgo(8) },
      { id: 32, credentialId: 21, userId: 7, action: 'used-in-checkin', at: daysAgo(2) },
    ];

    const events = composeSupplierTimeline({ supplier, payables, credentials, accessLog });

    // 1 created + 1 updated + 2 payable-created + 1 paid + 1 cancelled + 1 cred-created + 2 access-log = 9
    expect(events).toHaveLength(9);

    // Newest-first ordering
    const times = events.map((e) => e.at.getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
    }

    // Top event is the CREDENTIAL_USED_IN_CHECKIN (most recent = 2 days ago)
    expect(events[0].kind).toBe('CREDENTIAL_USED_IN_CHECKIN');
    expect(events[0].credentialId).toBe(21);
    expect(events[0].userId).toBe(7);

    // Payload propagation — payable events carry amount + currency + poNumber.
    const paid = events.find((e) => e.kind === 'PAYABLE_PAID');
    expect(paid).toMatchObject({ payableId: 11, amount: 500, currency: 'INR', poNumber: 'PO-1' });
    const cancelled = events.find((e) => e.kind === 'PAYABLE_CANCELLED');
    expect(cancelled).toMatchObject({ payableId: 12, amount: 200, currency: 'INR', poNumber: 'PO-2' });
  });

  test('SUPPLIER_UPDATED suppressed when updatedAt within 1s of createdAt (auto-stamp mirror)', () => {
    const createdAt = daysAgo(10);
    const supplier = {
      id: 5,
      createdAt,
      // Only 500ms later — Prisma auto-stamp mirror, not a real update.
      updatedAt: new Date(createdAt.getTime() + 500),
    };
    const events = composeSupplierTimeline({ supplier });
    expect(events.map((e) => e.kind)).toEqual(['SUPPLIER_CREATED']);
  });

  test('PAYABLE_PAID only fires when paidAt is set; not for pending status', () => {
    const supplier = { id: 1, createdAt: daysAgo(5), updatedAt: daysAgo(5) };
    const payables = [
      { id: 100, createdAt: daysAgo(3), paidAt: null, status: 'pending', amount: '100' },
      { id: 101, createdAt: daysAgo(2), paidAt: null, status: 'scheduled', amount: '200' },
    ];
    const events = composeSupplierTimeline({ supplier, payables });
    const paidEvents = events.filter((e) => e.kind === 'PAYABLE_PAID');
    expect(paidEvents).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'PAYABLE_CREATED')).toHaveLength(2);
  });

  test('limit clamped to MAX (500); default 100; invalid silently falls to default', () => {
    const supplier = { id: 1, createdAt: daysAgo(100), updatedAt: daysAgo(100) };
    // Generate 600 payable-created events.
    const payables = Array.from({ length: 600 }, (_, i) => ({
      id: i + 1,
      createdAt: new Date(Date.now() - i * 1000),
      paidAt: null,
      status: 'pending',
    }));

    // Limit 50 → 50 events.
    expect(composeSupplierTimeline({ supplier, payables }, { limit: 50 })).toHaveLength(50);
    // Limit 9999 → clamped to 500 (helper MAX_LIMIT). Supplier-created adds 1 → 501 total events; cap at 500.
    expect(composeSupplierTimeline({ supplier, payables }, { limit: 9999 })).toHaveLength(500);
    // Default (no limit) → 100.
    expect(composeSupplierTimeline({ supplier, payables })).toHaveLength(100);
    // Negative limit silently falls to default.
    expect(composeSupplierTimeline({ supplier, payables }, { limit: -1 })).toHaveLength(100);
  });

  test('?since filter is STRICTLY-AFTER (cursor event itself excluded)', () => {
    const cursor = daysAgo(10);
    const supplier = { id: 1, createdAt: daysAgo(20), updatedAt: daysAgo(20) };
    const payables = [
      // Equal-to cursor → EXCLUDED.
      { id: 1, createdAt: cursor, paidAt: null, status: 'pending' },
      // Strictly after → INCLUDED.
      { id: 2, createdAt: daysAgo(5), paidAt: null, status: 'pending' },
      // Before cursor → EXCLUDED.
      { id: 3, createdAt: daysAgo(15), paidAt: null, status: 'pending' },
    ];
    const events = composeSupplierTimeline({ supplier, payables }, { since: cursor });
    // Only payable 2 + (supplier-created at -20d which is < cursor → excluded).
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'PAYABLE_CREATED', payableId: 2 });
  });

  test('credential action token normalised: uppercase + slug', () => {
    const supplier = { id: 1, createdAt: daysAgo(5), updatedAt: daysAgo(5) };
    const credentials = [{ id: 1, createdAt: daysAgo(4), category: 'gds' }];
    const accessLog = [
      { id: 1, credentialId: 1, userId: 7, action: 'viewed', at: daysAgo(3) },
      { id: 2, credentialId: 1, userId: 7, action: 'used-in-checkin', at: daysAgo(2) },
      { id: 3, credentialId: 1, userId: 7, action: 'rotated', at: daysAgo(1) },
    ];
    const events = composeSupplierTimeline({ supplier, credentials, accessLog });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('CREDENTIAL_VIEWED');
    expect(kinds).toContain('CREDENTIAL_USED_IN_CHECKIN');
    expect(kinds).toContain('CREDENTIAL_ROTATED');
  });
});

describe('GET /api/travel/suppliers/:id/timeline (route)', () => {
  test('happy path: composes events across all sources', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 42, name: 'Hilton Mumbai', supplierCategory: 'hotel', subBrand: 'tmc',
      createdAt: daysAgo(30), updatedAt: daysAgo(25),
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, createdAt: daysAgo(20), updatedAt: daysAgo(20), paidAt: daysAgo(10), status: 'paid', amount: '500', currency: 'INR', poNumber: 'PO-1' },
    ]);
    prisma.supplierCredential.findMany.mockResolvedValue([
      { id: 11, createdAt: daysAgo(28), category: 'hotel' },
    ]);
    prisma.supplierCredentialAccessLog.findMany.mockResolvedValue([
      { id: 101, credentialId: 11, userId: 7, action: 'rotated', at: daysAgo(5) },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/timeline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.supplier).toMatchObject({
      id: 42, name: 'Hilton Mumbai', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    expect(res.body.limit).toBe(100);
    // SUPPLIER_CREATED + SUPPLIER_UPDATED + PAYABLE_CREATED + PAYABLE_PAID
    //   + CREDENTIAL_CREATED + CREDENTIAL_ROTATED = 6
    expect(res.body.count).toBe(6);
    expect(res.body.events).toHaveLength(6);
    // Newest first → CREDENTIAL_ROTATED (5d ago) is on top.
    expect(res.body.events[0].kind).toBe('CREDENTIAL_ROTATED');

    // findMany called with the correct supplier-name join for credentials.
    const credCall = prisma.supplierCredential.findMany.mock.calls[0][0];
    expect(credCall.where).toMatchObject({ tenantId: 1, supplierName: 'Hilton Mumbai' });

    // Access log queried via the credential id-list (in:[]).
    const accessCall = prisma.supplierCredentialAccessLog.findMany.mock.calls[0][0];
    expect(accessCall.where.credentialId).toMatchObject({ in: [11] });
  });

  test('no credentials → access-log query short-circuited (skipped)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 43, name: 'Bare Supplier', supplierCategory: 'other', subBrand: 'tmc',
      createdAt: daysAgo(5), updatedAt: daysAgo(5),
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);
    prisma.supplierCredential.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/43/timeline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1); // SUPPLIER_CREATED only
    expect(res.body.events[0].kind).toBe('SUPPLIER_CREATED');
    // No findMany on access-log when no creds.
    expect(prisma.supplierCredentialAccessLog.findMany).not.toHaveBeenCalled();
  });

  test('?limit=N capped by helper; default 100', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 44, name: 'Big Supplier', supplierCategory: 'flight', subBrand: 'tmc',
      createdAt: daysAgo(200), updatedAt: daysAgo(200),
    });
    // 250 payables, each generating 1 PAYABLE_CREATED.
    prisma.travelSupplierPayable.findMany.mockResolvedValue(
      Array.from({ length: 250 }, (_, i) => ({
        id: i + 1, createdAt: new Date(Date.now() - i * 1000), paidAt: null, status: 'pending',
      })),
    );
    prisma.supplierCredential.findMany.mockResolvedValue([]);

    const r1 = await request(makeApp())
      .get('/api/travel/suppliers/44/timeline?limit=10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(r1.status).toBe(200);
    expect(r1.body.events).toHaveLength(10);
    expect(r1.body.limit).toBe(10);

    const r2 = await request(makeApp())
      .get('/api/travel/suppliers/44/timeline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(r2.body.events).toHaveLength(100); // default
    expect(r2.body.limit).toBe(100);
  });

  test('?since=garbage → 400 INVALID_SINCE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/45/timeline?since=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SINCE' });
    // Should NOT have looked up the supplier (defensive — fail-fast on bad query).
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('?since=<date> filter passed through to helper', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 46, name: 'S', supplierCategory: 'other', subBrand: 'tmc',
      createdAt: daysAgo(30), updatedAt: daysAgo(30),
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, createdAt: daysAgo(20), paidAt: null, status: 'pending' },
      { id: 2, createdAt: daysAgo(5), paidAt: null, status: 'pending' },
    ]);
    prisma.supplierCredential.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get(`/api/travel/suppliers/46/timeline?since=${encodeURIComponent(daysAgo(10).toISOString())}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // SUPPLIER_CREATED -30d → excluded; payable@-20d → excluded; payable@-5d → included
    expect(res.body.count).toBe(1);
    expect(res.body.events[0]).toMatchObject({ kind: 'PAYABLE_CREATED', payableId: 2 });
  });

  test('supplier missing → 404 SUPPLIER_NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/999/timeline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'SUPPLIER_NOT_FOUND' });
    // No payable/credential queries fired.
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('non-numeric :id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/abc/timeline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('sub-brand denied → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockReset().mockResolvedValue({
      role: 'MANAGER', subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 47, name: 'TMC supplier', supplierCategory: 'hotel', subBrand: 'tmc',
      createdAt: daysAgo(5), updatedAt: daysAgo(5),
    });

    const res = await request(makeApp())
      .get('/api/travel/suppliers/47/timeline')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    // Payable/credential queries must NOT fire post-deny.
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
    expect(prisma.supplierCredential.findMany).not.toHaveBeenCalled();
  });

  test('route ordering: /suppliers/:id/timeline does NOT hit the bare :id handler', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 48, name: 'X', supplierCategory: 'other', subBrand: 'tmc',
      createdAt: daysAgo(1), updatedAt: daysAgo(1),
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);
    prisma.supplierCredential.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/48/timeline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Timeline returns `events` + `count` — the bare :id handler returns
    // the raw supplier row. Presence of `events` confirms ordering.
    expect(res.body).toHaveProperty('events');
    expect(res.body).toHaveProperty('count');
  });
});
