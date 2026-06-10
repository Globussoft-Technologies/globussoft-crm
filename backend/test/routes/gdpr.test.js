// @ts-check
/**
 * Unit tests for backend/routes/gdpr.js — pin the GDPR / DPDP data-subject
 * compliance surface (DSAR export + right-to-be-forgotten + ConsentRecord
 * CRUD + RetentionPolicy + manual retention sweep) against regression.
 *
 * Why this file exists
 * ────────────────────
 * gdpr.js is the regulatory-evidence surface of the CRM. Every endpoint
 * here is either:
 *   - touched by a regulator's audit (Article 15 export, Article 17 erasure),
 *   - or part of the destructive-cron's manual-trigger lane (POST
 *     /retention/run is G-11's mirror of recurring-invoice / forecasting /
 *     wellness-ops `/run` endpoints — admin-only + confirmDestructive +
 *     requireStepUp triple-guard).
 *
 * Several issues have closed inside this route:
 *   - #443  — every export writes an AuditLog row via writeAudit (action
 *             'GDPR_EXPORT'). The previous handler only recorded a
 *             DataExportRequest row, leaving the WHO/WHEN of self-exports
 *             missing from the Article 30 audit trail.
 *   - #654  — destructive endpoints (PUT /retention-policies, POST
 *             /retention/run) gate on requireStepUp() — fresh stepUpToken
 *             required. Reverse-only via redeploy.
 *   - #712  — PUT /retention-policies validates every row BEFORE any DB
 *             writes (ENTITY_REQUIRED / RETAIN_DAYS_REQUIRED /
 *             INVALID_RETENTION_DAYS with code field set). Pre-fix the
 *             loop silently `continue`'d on bad rows, making the save look
 *             successful while skipping them.
 *   - #576  — retention upserts capture before-state and write an audit
 *             diff (CREATE vs UPDATE depending on whether the row existed
 *             pre-upsert). Manual /retention/run mirror of the cron engine.
 *   - perf hardening — /export/me caps every findMany at HEAVY_TABLE_CAP
 *             (5000) with `truncated` + `cap` envelope keys so the consumer
 *             knows when to paginate.
 *
 * What this file pins
 * ───────────────────
 *   1. POST /export/contact/:id      — happy path, INVALID_ID guard,
 *      404 on missing/cross-tenant, audit + DataExportRequest side-effects.
 *   2. POST /export/me               — happy path returns truncated + cap
 *      envelope; missing userId → 400; writes audit row.
 *   3. DELETE /contact/:id           — happy path anonymises the contact
 *      (name='Deleted Contact', email='deleted-<id>@redacted.local'); 404
 *      on missing.
 *   4. GET /consent/:contactId       — happy path returns tenant-scoped
 *      records; non-numeric contactId → 400 INVALID_ID.
 *   5. POST /consent                 — happy path 201s + stamps ip/UA;
 *      400 on missing contactId/type/granted.
 *   6. GET /retention-policies       — happy path returns tenant slice.
 *   7. PUT /retention-policies       — happy path upsert + audit;
 *      empty body → 400; INVALID_RETENTION_DAYS (>36500) → 400 with code.
 *   8. POST /retention/run           — confirmDestructive missing → 400
 *      CONFIRMATION_REQUIRED (no policies fetched); happy path produces
 *      per-policy summary with deleted count + cutoff iso string +
 *      writes AuditLog row per policy; tenant-isolation contract — the
 *      deleteMany WHERE clause MUST carry req.user.tenantId.
 *
 * Pattern reference: billing.test.js (auth-middleware bypass + prisma
 * singleton-monkey-patch) + custom-objects.test.js (audit-lib stub via
 * CJS exports surface). The route's CJS
 * `require('../middleware/auth')` + destructured imports are replaced at
 * module-load with pass-through fns so we exercise route logic without
 * minting JWTs or step-up tokens.
 *
 * What this file does NOT cover (intentional):
 *   - The full per-entity findMany shape on /export/contact/:id — the
 *     happy-path test confirms ALL 11 sub-queries fire with the correct
 *     where clause; we don't enumerate every entity's row count.
 *   - The retention-cron engine itself — covered by
 *     backend/test/cron/retentionEngine.test.js. This file only pins the
 *     manual /retention/run trigger's contract.
 *   - The downstream side-effects of consent revocation — Consent records
 *     are persisted; cascading unsubscribe-from-sequence is a separate
 *     responsibility (sequenceEngine + workflow rules).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// ── Auth middleware bypass ─────────────────────────────────────────
// The router uses `const { verifyToken, verifyRole, requireStepUp } =
// require('../middleware/auth')` at module load. We swap all three for
// pass-throughs BEFORE the router is required so the destructured refs
// capture the stubs, not the real JWT verification chain.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();
// requireStepUp is a FACTORY — production callsite is `requireStepUp()`
// (no args). Return a pass-through so the destructive endpoints
// (PUT /retention-policies, POST /retention/run) don't 401 in tests
// when no `x-step-up-token` header is supplied. The step-up gate's own
// contract is exhaustively covered by auth-stepup.test.js.
authMw.requireStepUp = () => (_req, _res, next) => next();

// ── Audit lib stub ─────────────────────────────────────────────────
// The router calls `writeAudit(...)` for GDPR_EXPORT + retention-policy
// diff rows. Replace it on the CJS exports surface so we can spy on the
// invocations without touching the real prisma.auditLog.findFirst/create
// path (which would trip the chain-hash recompute).
const auditMock = requireCJS('../../lib/audit');
const writeAuditMock = vi.fn().mockResolvedValue({ id: 1 });
auditMock.writeAudit = writeAuditMock;

// ── Prisma singleton monkey-patch ──────────────────────────────────
prisma.contact = {
  findFirst: vi.fn(),
  update: vi.fn(),
};
prisma.user = {
  findFirst: vi.fn(),
};
prisma.activity = {
  findMany: vi.fn().mockResolvedValue([]),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.deal = {
  findMany: vi.fn().mockResolvedValue([]),
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.emailMessage = {
  findMany: vi.fn().mockResolvedValue([]),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.callLog = {
  findMany: vi.fn().mockResolvedValue([]),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.task = {
  findMany: vi.fn().mockResolvedValue([]),
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.invoice = {
  findMany: vi.fn().mockResolvedValue([]),
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.contract = {
  findMany: vi.fn().mockResolvedValue([]),
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.estimate = {
  findMany: vi.fn().mockResolvedValue([]),
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.smsMessage = {
  findMany: vi.fn().mockResolvedValue([]),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.whatsAppMessage = {
  findMany: vi.fn().mockResolvedValue([]),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.expense = {
  findMany: vi.fn().mockResolvedValue([]),
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.project = {
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.consentRecord = {
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.pushSubscription = {
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.contactAttachment = {
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.sequenceEnrollment = {
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.marketplaceLead = {
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.dataExportRequest = {
  create: vi.fn().mockResolvedValue({ id: 1 }),
};
prisma.auditLog = {
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.retentionPolicy = {
  findMany: vi.fn().mockResolvedValue([]),
  findUnique: vi.fn(),
  upsert: vi.fn(),
};
// Wellness models (RETENTION_ENTITY_MAP references them on require — the
// router does `Patient: prisma.patient` at top level, so these need to
// be objects even though the tests below don't exercise them).
prisma.patient = { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) };
prisma.visit = { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) };
prisma.prescription = { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) };
prisma.consentForm = { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) };
prisma.treatmentPlan = { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) };
prisma.attachment = { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) };

import express from 'express';
import request from 'supertest';
const gdprRouter = requireCJS('../../routes/gdpr');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/gdpr', gdprRouter);
  return app;
}

beforeEach(() => {
  // Reset every mock; restore the always-resolves-empty defaults that
  // bulk-deleteMany and audit-related findFirst calls need.
  const allMocks = [
    prisma.contact.findFirst, prisma.contact.update,
    prisma.user.findFirst,
    prisma.activity.findMany, prisma.activity.deleteMany,
    prisma.deal.findMany, prisma.deal.updateMany,
    prisma.emailMessage.findMany, prisma.emailMessage.deleteMany,
    prisma.callLog.findMany, prisma.callLog.deleteMany,
    prisma.task.findMany, prisma.task.updateMany,
    prisma.invoice.findMany, prisma.invoice.updateMany,
    prisma.contract.findMany, prisma.contract.updateMany,
    prisma.estimate.findMany, prisma.estimate.updateMany,
    prisma.smsMessage.findMany, prisma.smsMessage.deleteMany,
    prisma.whatsAppMessage.findMany, prisma.whatsAppMessage.deleteMany,
    prisma.expense.findMany, prisma.expense.updateMany,
    prisma.project.updateMany,
    prisma.consentRecord.findMany, prisma.consentRecord.create, prisma.consentRecord.deleteMany,
    prisma.pushSubscription.deleteMany,
    prisma.contactAttachment.deleteMany,
    prisma.sequenceEnrollment.deleteMany,
    prisma.marketplaceLead.updateMany,
    prisma.dataExportRequest.create,
    prisma.auditLog.create, prisma.auditLog.findFirst,
    prisma.retentionPolicy.findMany, prisma.retentionPolicy.findUnique, prisma.retentionPolicy.upsert,
  ];
  for (const m of allMocks) m.mockReset();

  // Re-arm the sensible defaults wiped by mockReset().
  prisma.activity.findMany.mockResolvedValue([]);
  prisma.activity.deleteMany.mockResolvedValue({ count: 0 });
  prisma.deal.findMany.mockResolvedValue([]);
  prisma.deal.updateMany.mockResolvedValue({ count: 0 });
  prisma.emailMessage.findMany.mockResolvedValue([]);
  prisma.emailMessage.deleteMany.mockResolvedValue({ count: 0 });
  prisma.callLog.findMany.mockResolvedValue([]);
  prisma.callLog.deleteMany.mockResolvedValue({ count: 0 });
  prisma.task.findMany.mockResolvedValue([]);
  prisma.task.updateMany.mockResolvedValue({ count: 0 });
  prisma.invoice.findMany.mockResolvedValue([]);
  prisma.invoice.updateMany.mockResolvedValue({ count: 0 });
  prisma.contract.findMany.mockResolvedValue([]);
  prisma.contract.updateMany.mockResolvedValue({ count: 0 });
  prisma.estimate.findMany.mockResolvedValue([]);
  prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
  prisma.smsMessage.findMany.mockResolvedValue([]);
  prisma.smsMessage.deleteMany.mockResolvedValue({ count: 0 });
  prisma.whatsAppMessage.findMany.mockResolvedValue([]);
  prisma.whatsAppMessage.deleteMany.mockResolvedValue({ count: 0 });
  prisma.expense.findMany.mockResolvedValue([]);
  prisma.expense.updateMany.mockResolvedValue({ count: 0 });
  prisma.project.updateMany.mockResolvedValue({ count: 0 });
  prisma.consentRecord.findMany.mockResolvedValue([]);
  prisma.consentRecord.deleteMany.mockResolvedValue({ count: 0 });
  prisma.pushSubscription.deleteMany.mockResolvedValue({ count: 0 });
  prisma.contactAttachment.deleteMany.mockResolvedValue({ count: 0 });
  prisma.sequenceEnrollment.deleteMany.mockResolvedValue({ count: 0 });
  prisma.marketplaceLead.updateMany.mockResolvedValue({ count: 0 });
  prisma.dataExportRequest.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.retentionPolicy.findMany.mockResolvedValue([]);
  writeAuditMock.mockClear();
  writeAuditMock.mockResolvedValue({ id: 1 });
});

// ─── POST /export/contact/:id ────────────────────────────────────

describe('POST /api/gdpr/export/contact/:id — DSAR export (#443)', () => {
  test('happy path: returns export envelope + writes DataExportRequest + audit row', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 42, tenantId: 1, name: 'Acme', email: 'a@b.com' });
    prisma.activity.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    prisma.deal.findMany.mockResolvedValue([{ id: 10 }]);
    const app = makeApp();
    const res = await request(app).post('/api/gdpr/export/contact/42');
    expect(res.status).toBe(200);
    expect(res.body.contact.id).toBe(42);
    expect(res.body.tenantId).toBe(1);
    expect(Array.isArray(res.body.activities)).toBe(true);
    expect(res.body.activities.length).toBe(2);
    // Attachment header set — browser interprets response as a file download.
    expect(res.headers['content-disposition']).toMatch(/contact-42-export\.json/);
    // Side-effects: DataExportRequest row + canonical GDPR_EXPORT audit.
    expect(prisma.dataExportRequest.create).toHaveBeenCalledTimes(1);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const auditArgs = writeAuditMock.mock.calls[0];
    expect(auditArgs[0]).toBe('Contact');
    expect(auditArgs[1]).toBe('GDPR_EXPORT');
    expect(auditArgs[2]).toBe(42);
    // Details payload carries counts only — never row contents.
    expect(auditArgs[5].counts.activities).toBe(2);
    expect(auditArgs[5].counts.deals).toBe(1);
  });

  test('non-numeric id → 400 Invalid contact ID (parseInt-NaN guard, no Prisma touched)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/gdpr/export/contact/not-a-number');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid contact ID/i);
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant fetch → 404 (findFirst returns null when tenant mismatches)', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 99 });
    const res = await request(app).post('/api/gdpr/export/contact/42');
    expect(res.status).toBe(404);
    // Tenant-isolation contract: where clause carries caller's tenantId.
    const findArgs = prisma.contact.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 42, tenantId: 99 });
    // No side-effects on the 404 path.
    expect(prisma.dataExportRequest.create).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});

// ─── POST /export/me ─────────────────────────────────────────────

describe('POST /api/gdpr/export/me — Article 15 self-export (#443 + perf cap)', () => {
  test('happy path: returns envelope with truncated + cap keys (perf hardening)', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 7, email: 'me@example.com', name: 'Me', role: 'ADMIN' });
    // Small tenant — every slice well under HEAVY_TABLE_CAP (5000).
    prisma.deal.findMany.mockResolvedValue([{ id: 1 }]);
    prisma.task.findMany.mockResolvedValue([{ id: 1 }]);
    prisma.expense.findMany.mockResolvedValue([]);
    prisma.activity.findMany.mockResolvedValue([]);
    prisma.emailMessage.findMany.mockResolvedValue([]);
    prisma.callLog.findMany.mockResolvedValue([]);
    prisma.smsMessage.findMany.mockResolvedValue([]);
    prisma.whatsAppMessage.findMany.mockResolvedValue([]);
    prisma.auditLog.findFirst.mockResolvedValue(null);
    // auditLog.findMany is hit by /export/me only (not the chain lookup).
    // The router calls prisma.auditLog.findMany; make it return a small slice.
    prisma.auditLog.findMany = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const app = makeApp();
    const res = await request(app).post('/api/gdpr/export/me');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(7);
    expect(res.body.tenantId).toBe(1);
    // Perf hardening envelope — additive, doesn't break the original spec
    // contract on top-level entity keys.
    expect(res.body.cap).toBe(5000);
    expect(res.body.truncated).toBeTruthy();
    expect(res.body.truncated.auditLogs).toBe(false); // 2 < cap
    // Each findMany uses orderBy desc + take=HEAVY_TABLE_CAP. Spot-check one.
    const dealCall = prisma.deal.findMany.mock.calls[0][0];
    expect(dealCall.where.ownerId).toBe(7);
    expect(dealCall.where.tenantId).toBe(1);
    expect(dealCall.orderBy).toEqual({ createdAt: 'desc' });
    expect(dealCall.take).toBe(5000);
    // Side-effects: DataExportRequest + GDPR_EXPORT audit row.
    expect(prisma.dataExportRequest.create).toHaveBeenCalledTimes(1);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0][0]).toBe('User');
    expect(writeAuditMock.mock.calls[0][1]).toBe('GDPR_EXPORT');
  });

  test('missing userId on token → 400 No user id (no side-effects)', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Simulate a degenerate token: tenantId set, but no userId.
      req.user = { userId: undefined, tenantId: 1, role: 'ADMIN' };
      next();
    });
    app.use('/api/gdpr', gdprRouter);
    const res = await request(app).post('/api/gdpr/export/me');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No user id/i);
    expect(prisma.dataExportRequest.create).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});

// ─── DELETE /contact/:id — right to be forgotten ────────────────

describe('DELETE /api/gdpr/contact/:id — Article 17 erasure (anonymise)', () => {
  test('happy path: anonymises name/email, hard-deletes message records, writes audit', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 42, tenantId: 1, email: 'real@user.com', name: 'Real User' });
    prisma.contact.update.mockResolvedValue({ id: 42, name: 'Deleted Contact', email: 'deleted-42@redacted.local' });
    const app = makeApp();
    const res = await request(app).delete('/api/gdpr/contact/42');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.anonymized).toBe(true);
    // Anonymise pattern — these are the contract for the redacted shape.
    const updateArgs = prisma.contact.update.mock.calls[0][0];
    expect(updateArgs.data.name).toBe('Deleted Contact');
    expect(updateArgs.data.email).toBe('deleted-42@redacted.local');
    expect(updateArgs.data.phone).toBeNull();
    expect(updateArgs.data.company).toBeNull();
    // Hard-deletes the message records (PII-bearing).
    expect(prisma.emailMessage.deleteMany).toHaveBeenCalled();
    expect(prisma.smsMessage.deleteMany).toHaveBeenCalled();
    expect(prisma.whatsAppMessage.deleteMany).toHaveBeenCalled();
    expect(prisma.callLog.deleteMany).toHaveBeenCalled();
    // Detaches financial records (preserved for accounting integrity).
    const dealUpdateArgs = prisma.deal.updateMany.mock.calls[0][0];
    expect(dealUpdateArgs.data.contactId).toBeNull();
    // Direct prisma.auditLog.create row (not via writeAudit).
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditCallArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditCallArgs.data.action).toBe('DELETE');
    expect(auditCallArgs.data.entity).toBe('Contact');
    expect(auditCallArgs.data.entityId).toBe(42);
  });

  test('non-existent contact → 404 (no mutations)', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).delete('/api/gdpr/contact/9999');
    expect(res.status).toBe(404);
    expect(prisma.contact.update).not.toHaveBeenCalled();
    expect(prisma.emailMessage.deleteMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

// ─── GET /consent/:contactId ─────────────────────────────────────

describe('GET /api/gdpr/consent/:contactId — list consent records', () => {
  test('happy path: returns tenant-scoped records ordered desc by createdAt', async () => {
    prisma.consentRecord.findMany.mockResolvedValue([
      { id: 2, contactId: 42, type: 'marketing', granted: false, createdAt: new Date('2026-05-20') },
      { id: 1, contactId: 42, type: 'marketing', granted: true, createdAt: new Date('2026-05-01') },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/gdpr/consent/42');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].granted).toBe(false);
    const findArgs = prisma.consentRecord.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ contactId: 42, tenantId: 1 });
    expect(findArgs.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('non-numeric contactId → 400 Invalid contact ID', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/gdpr/consent/abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid contact ID/i);
    expect(prisma.consentRecord.findMany).not.toHaveBeenCalled();
  });
});

// ─── GET /consent/:contactId?fields=summary — #920 slice 32 ──────
/**
 * #920 slice 32 — `?fields=summary` slim-shape opt-in.
 *
 * ConsentRecord rows carry two forensic-evidence columns the
 * consent-picker UI never shows (ipAddress + userAgent — captured for
 * GDPR Art. 7 proof-of-consent, surfaced only on DSAR Art. 15 exports).
 * The slim shape drops those plus tenantId, returning only the columns
 * a status grid needs: id, contactId, type, granted, source, createdAt.
 *
 * What this describe pins
 * ───────────────────────
 *   1. Default GET (no ?fields) preserves full-shape Prisma call —
 *      no `select` key, all forensic columns returned (the Art. 15
 *      DSAR path depends on this — making `summary` the default would
 *      break the legally mandated export payload).
 *   2. ?fields=summary switches to `select` with the 6-field projection.
 *   3. ?fields=summary EXCLUDES `ipAddress` + `userAgent` (the forensic
 *      blobs that motivated the slim shape) — pinned via assertion on
 *      the absence of those keys in the `select` object.
 *   4. ?fields=summary EXCLUDES `tenantId` (leaked-tenant-id defence
 *      surface — mirrors slices 20 / 21 / 23 / 24 / 25).
 *   5. ?fields=summary still scopes tenantId in WHERE clause
 *      (slim-shape is orthogonal to tenant-isolation — the response
 *      shape narrows, the row set does not widen).
 *   6. Bogus `?fields=junk` falls through to the full-shape branch
 *      (defence-in-depth — only the exact literal `summary` opts in).
 */

describe('GET /api/gdpr/consent/:contactId?fields=summary — slim-shape opt-in (#920 slice 32)', () => {
  test('default (no ?fields) → full-shape findMany (no `select` key, ipAddress + userAgent + tenantId returned)', async () => {
    prisma.consentRecord.findMany.mockResolvedValue([
      { id: 1, contactId: 42, type: 'marketing', granted: true, ipAddress: '203.0.113.7', userAgent: 'Mozilla/5.0', source: 'app', tenantId: 1, createdAt: new Date() },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/gdpr/consent/42');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const findArgs = prisma.consentRecord.findMany.mock.calls[0][0];
    // Default branch: no `select` key — Prisma returns ALL columns.
    expect(findArgs.select).toBeUndefined();
    expect(findArgs.where).toEqual({ contactId: 42, tenantId: 1 });
    expect(findArgs.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields=summary → slim `select` with 6-field projection (id, contactId, type, granted, source, createdAt)', async () => {
    prisma.consentRecord.findMany.mockResolvedValue([
      { id: 1, contactId: 42, type: 'marketing', granted: true, source: 'app', createdAt: new Date() },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/gdpr/consent/42?fields=summary');
    expect(res.status).toBe(200);
    const findArgs = prisma.consentRecord.findMany.mock.calls[0][0];
    expect(findArgs.select).toEqual({
      id: true,
      contactId: true,
      type: true,
      granted: true,
      source: true,
      createdAt: true,
    });
  });

  test('?fields=summary → slim shape EXCLUDES `ipAddress` + `userAgent` (the forensic blobs motivating slim shape)', async () => {
    prisma.consentRecord.findMany.mockResolvedValue([]);
    const app = makeApp();
    await request(app).get('/api/gdpr/consent/42?fields=summary');
    const findArgs = prisma.consentRecord.findMany.mock.calls[0][0];
    expect(findArgs.select.ipAddress).toBeUndefined();
    expect(findArgs.select.userAgent).toBeUndefined();
  });

  test('?fields=summary → slim shape EXCLUDES `tenantId` (leaked-tenant-id defence — mirrors slices 20/21/23/24/25)', async () => {
    prisma.consentRecord.findMany.mockResolvedValue([]);
    const app = makeApp();
    await request(app).get('/api/gdpr/consent/42?fields=summary');
    const findArgs = prisma.consentRecord.findMany.mock.calls[0][0];
    expect(findArgs.select.tenantId).toBeUndefined();
  });

  test('?fields=summary still scopes tenantId in WHERE clause (slim shape orthogonal to tenant isolation)', async () => {
    prisma.consentRecord.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 99 });
    await request(app).get('/api/gdpr/consent/42?fields=summary');
    const findArgs = prisma.consentRecord.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ contactId: 42, tenantId: 99 });
    expect(findArgs.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('bogus ?fields=junk → falls through to full-shape branch (only exact literal `summary` opts in)', async () => {
    prisma.consentRecord.findMany.mockResolvedValue([]);
    const app = makeApp();
    await request(app).get('/api/gdpr/consent/42?fields=junk');
    const findArgs = prisma.consentRecord.findMany.mock.calls[0][0];
    expect(findArgs.select).toBeUndefined();
  });
});

// ─── POST /consent ───────────────────────────────────────────────

describe('POST /api/gdpr/consent — record a grant/revoke', () => {
  test('happy path: creates ConsentRecord with ip + UA + tenantId', async () => {
    prisma.consentRecord.create.mockResolvedValue({
      id: 99, contactId: 42, type: 'marketing', granted: true, ipAddress: '203.0.113.7', userAgent: 'Mozilla/5.0', source: 'app', tenantId: 1,
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/gdpr/consent')
      .set('x-forwarded-for', '203.0.113.7, 10.0.0.1')
      .set('user-agent', 'Mozilla/5.0')
      .send({ contactId: 42, type: 'marketing', granted: true });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(99);
    const createArgs = prisma.consentRecord.create.mock.calls[0][0];
    expect(createArgs.data.contactId).toBe(42);
    expect(createArgs.data.type).toBe('marketing');
    expect(createArgs.data.granted).toBe(true);
    // x-forwarded-for: only the first IP, trimmed.
    expect(createArgs.data.ipAddress).toBe('203.0.113.7');
    expect(createArgs.data.userAgent).toBe('Mozilla/5.0');
    expect(createArgs.data.source).toBe('app');
    expect(createArgs.data.tenantId).toBe(1);
  });

  test('missing granted (or non-boolean) → 400, no create', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/gdpr/consent')
      .send({ contactId: 42, type: 'marketing' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contactId, type, and granted are required/i);
    expect(prisma.consentRecord.create).not.toHaveBeenCalled();
  });
});

// ─── GET /retention-policies ─────────────────────────────────────

describe('GET /api/gdpr/retention-policies — list tenant policies', () => {
  test('happy path: returns tenant-scoped policies sorted by entity asc', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, entity: 'Activity', retainDays: 180, isActive: true, tenantId: 1 },
      { id: 2, entity: 'CallLog', retainDays: 365, isActive: true, tenantId: 1 },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/gdpr/retention-policies');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const findArgs = prisma.retentionPolicy.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 1 });
    expect(findArgs.orderBy).toEqual({ entity: 'asc' });
  });
});

// ─── PUT /retention-policies — validation gate (#712) + audit (#576) ─

describe('PUT /api/gdpr/retention-policies — pre-write validation (#712) + audit (#576)', () => {
  test('empty body array → 400 (no upsert called)', async () => {
    const app = makeApp();
    const res = await request(app).put('/api/gdpr/retention-policies').send([]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty array/i);
    expect(prisma.retentionPolicy.upsert).not.toHaveBeenCalled();
  });

  test('retainDays > 36500 → 400 INVALID_RETENTION_DAYS (validation BEFORE any upsert, #712)', async () => {
    const app = makeApp();
    const res = await request(app)
      .put('/api/gdpr/retention-policies')
      .send([{ entity: 'Activity', retainDays: 99999, isActive: true }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RETENTION_DAYS');
    expect(res.body.entity).toBe('Activity');
    // The #712 contract — validation runs BEFORE any write so a mixed
    // valid+invalid batch fails as a whole; no partial-save state.
    expect(prisma.retentionPolicy.upsert).not.toHaveBeenCalled();
  });

  test('missing entity → 400 ENTITY_REQUIRED', async () => {
    const app = makeApp();
    const res = await request(app)
      .put('/api/gdpr/retention-policies')
      .send([{ retainDays: 90, isActive: true }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ENTITY_REQUIRED');
    expect(prisma.retentionPolicy.upsert).not.toHaveBeenCalled();
  });

  test('happy path: upsert + writeAudit with CREATE action when no prior row exists (#576)', async () => {
    // before-state lookup returns null → CREATE audit action.
    prisma.retentionPolicy.findUnique.mockResolvedValue(null);
    prisma.retentionPolicy.upsert.mockResolvedValue({
      id: 11, entity: 'Activity', retainDays: 180, isActive: true, tenantId: 1,
    });
    const app = makeApp();
    const res = await request(app)
      .put('/api/gdpr/retention-policies')
      .send([{ entity: 'Activity', retainDays: 180, isActive: true }]);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(prisma.retentionPolicy.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = prisma.retentionPolicy.upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ tenantId_entity: { tenantId: 1, entity: 'Activity' } });
    expect(upsertArgs.create).toEqual({ tenantId: 1, entity: 'Activity', retainDays: 180, isActive: true });
    // Audit diff written — CREATE because before was null.
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const auditArgs = writeAuditMock.mock.calls[0];
    expect(auditArgs[0]).toBe('RetentionPolicy');
    expect(auditArgs[1]).toBe('CREATE');
    expect(auditArgs[5].entity).toBe('Activity');
    expect(auditArgs[5].from).toBeNull();
    expect(auditArgs[5].to).toEqual({ retainDays: 180, isActive: true });
  });
});

// ─── POST /retention/run — destructive trigger (G-11) ──────────

describe('POST /api/gdpr/retention/run — destructive trigger (G-11 + #654)', () => {
  test('missing confirmDestructive → 400 CONFIRMATION_REQUIRED (no policies fetched)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/gdpr/retention/run').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRMATION_REQUIRED');
    // Critical: the destructive lane MUST short-circuit BEFORE touching
    // RetentionPolicy / before any deleteMany dispatch.
    expect(prisma.retentionPolicy.findMany).not.toHaveBeenCalled();
    expect(prisma.activity.deleteMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('happy path: per-policy summary with deleted count + cutoff iso + AuditLog row per policy (tenant-isolated)', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, entity: 'Activity', retainDays: 90, isActive: true, tenantId: 1 },
      { id: 2, entity: 'CallLog', retainDays: 365, isActive: true, tenantId: 1 },
    ]);
    prisma.activity.deleteMany.mockResolvedValue({ count: 17 });
    prisma.callLog.deleteMany.mockResolvedValue({ count: 4 });
    const app = makeApp({ tenantId: 1 });
    const res = await request(app)
      .post('/api/gdpr/retention/run')
      .send({ confirmDestructive: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tenantId).toBe(1);
    expect(res.body.summary).toHaveLength(2);
    expect(res.body.summary[0]).toMatchObject({ entity: 'Activity', deleted: 17, retainDays: 90 });
    expect(res.body.summary[0].cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.summary[1]).toMatchObject({ entity: 'CallLog', deleted: 4, retainDays: 365 });
    // TENANT-ISOLATION CONTRACT — the deleteMany WHERE clauses MUST
    // carry req.user.tenantId. A leak here would be a catastrophic
    // cross-tenant mass-deletion bug. Pin this hard.
    const activityDeleteArgs = prisma.activity.deleteMany.mock.calls[0][0];
    expect(activityDeleteArgs.where.tenantId).toBe(1);
    expect(activityDeleteArgs.where.createdAt).toBeTruthy();
    expect(activityDeleteArgs.where.createdAt.lt).toBeInstanceOf(Date);
    const callLogDeleteArgs = prisma.callLog.deleteMany.mock.calls[0][0];
    expect(callLogDeleteArgs.where.tenantId).toBe(1);
    // One AuditLog row per policy (DELETE action with the retention payload).
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    const firstAuditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(firstAuditArgs.data.action).toBe('DELETE');
    expect(firstAuditArgs.data.entity).toBe('Activity');
    expect(firstAuditArgs.data.userId).toBe(7);
    expect(firstAuditArgs.data.tenantId).toBe(1);
    // details JSON includes via:'manual' + deleted + retainDays.
    const detailsParsed = JSON.parse(firstAuditArgs.data.details);
    expect(detailsParsed.via).toBe('manual');
    expect(detailsParsed.deleted).toBe(17);
    expect(detailsParsed.retainDays).toBe(90);
    expect(detailsParsed.source).toBe('RetentionEngine');
  });

  test('policy referencing unknown entity → summary entry with skipped:true + reason (no deletion)', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 99, entity: 'NotAModelName', retainDays: 30, isActive: true, tenantId: 1 },
    ]);
    const app = makeApp();
    const res = await request(app)
      .post('/api/gdpr/retention/run')
      .send({ confirmDestructive: true });
    expect(res.status).toBe(200);
    expect(res.body.summary).toHaveLength(1);
    expect(res.body.summary[0]).toEqual({
      entity: 'NotAModelName',
      deleted: 0,
      skipped: true,
      reason: 'unknown_entity',
    });
    // Defence-in-depth: no deleteMany dispatch on unknown entity.
    expect(prisma.activity.deleteMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
