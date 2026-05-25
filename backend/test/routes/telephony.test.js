// @ts-check
/**
 * Unit + integration tests for backend/routes/telephony.js — pins the
 * click-to-call lifecycle (CallLog persistence on success AND failure),
 * MyOperator + Knowlarity CDR webhooks (no-auth, tenant inference), the
 * ADMIN-only /config GET (masked) + PUT (rotation + audit) surface, and
 * /recordings tenant-scoped lookup.
 *
 * Why this file exists
 * ────────────────────
 *   routes/telephony.js is a 313-LOC five-endpoint module mixing three
 *   distinct concerns:
 *     1. POST /click-to-call — authed; pulls the tenant's active
 *        TelephonyConfig, decrypts apiKey/apiSecret on read (#651 contract),
 *        delegates to services/telephonyProvider.initiateCall, then persists
 *        a CallLog row whose status reflects provider outcome (INITIATED
 *        when ok, FAILED when not — STILL persisted so the operator can
 *        see what was attempted). The 502 envelope on provider failure
 *        carries `callLogId` so the UI can deep-link to the failure row.
 *     2. POST /webhook/{myoperator,knowlarity} — UNAUTHED CDR ingest. Both
 *        webhooks share a near-identical shape: lookup-existing-by-
 *        providerCallId OR create-new, normalize phone numbers, resolve
 *        contact by phone, infer tenantId from existing-call OR contact
 *        OR default-1 (the "tenant-1 floor" is intentional — orphan CDRs
 *        from unmatched webhooks land in the default org so they aren't
 *        silently dropped).
 *     3. GET /config + PUT /config/:provider — ADMIN-only #651 credential
 *        rotation surface: GET projects apiKey/apiSecret as
 *        `{configured, last4}` (never plaintext); PUT requires the FULL
 *        fresh value, rejects masked sentinels (so a round-tripped GET
 *        result doesn't accidentally rotate the credential to gibberish),
 *        and emits a ProviderConfig.ROTATE audit row only when at least
 *        one secret field actually changed.
 *
 * What this file pins
 * ───────────────────
 *   CLICK-TO-CALL
 *   1. POST /click-to-call → 400 when `to` is missing.
 *   2. POST /click-to-call → 400 when no active TelephonyConfig for tenant.
 *   3. POST /click-to-call → persists CallLog with status='INITIATED' on
 *      provider success, returns 200 with callLogId + provider callId.
 *   4. POST /click-to-call → persists CallLog with status='FAILED' on
 *      provider error, returns 502 envelope carrying callLogId so the
 *      UI can surface the failure reason inline.
 *   5. POST /click-to-call → cross-tenant contact lookup result is
 *      DISCARDED (resolvedContactId stays null) — the route only sets
 *      contactId when the looked-up contact's tenantId matches the
 *      caller's. This is the load-bearing isolation pin.
 *
 *   WEBHOOKS (no-auth ingest)
 *   6. POST /webhook/myoperator → creates new CallLog when no providerCallId
 *      match, normalizes caller + callee phone numbers via normalizePhone.
 *   7. POST /webhook/myoperator → updates EXISTING CallLog (no duplicate
 *      row) when providerCallId matches; status normalised to UPPERCASE.
 *   8. POST /webhook/myoperator → tenantId defaults to 1 when there's no
 *      existing-call match AND no contact match. The "default-1" floor
 *      is the difference between an orphan CDR landing somewhere vs
 *      being silently dropped.
 *   9. POST /webhook/knowlarity → creates new CallLog with provider=
 *      'knowlarity' (separate provider tag from myoperator).
 *
 *   CONFIG (ADMIN-only, #651)
 *  10. GET /config → ADMIN scopes findMany by tenantId AND projects
 *      apiKey / apiSecret as `{ configured, last4 }` — plaintext NEVER
 *      reaches the response body.
 *  11. GET /config → returns 403 RBAC_DENIED when role !== ADMIN.
 *  12. PUT /config/:provider → 400 when provider is not in the
 *      {myoperator, knowlarity} allowlist.
 *  13. PUT /config/:provider → upsert encrypts plaintext apiKey via
 *      credentialMasking.encryptCredential, stamps lastRotatedAt, AND
 *      emits writeAudit('ProviderConfig', 'ROTATE', …) — single audit
 *      row covers ANY rotated secret set, with rotatedFields detail.
 *  14. PUT /config/:provider → masked-sentinel input (e.g. '****a3f1')
 *      is silently SKIPPED — does not overwrite the stored value, does
 *      NOT count as a rotation, does NOT emit an audit row. Pins the
 *      "round-tripped GET result never rotates" guarantee.
 *
 *   RECORDINGS
 *  15. GET /recordings/:callLogId → 404 when CallLog is in another tenant
 *      (tenant filter pinned on the findFirst).
 *  16. GET /recordings/:callLogId → 404 when CallLog exists but
 *      recordingUrl is null (separate envelope: "No recording available").
 *  17. GET /recordings/:callLogId → 200 returns just the recordingUrl
 *      (lean response — does NOT leak the full CallLog row).
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/chatbots.test.js + communications.test.js
 *   — prisma singleton monkey-patch BEFORE the router is required,
 *   monkey-patch `verifyToken` to pass-through (we want verifyRole(['ADMIN'])
 *   to stay REAL so the 403 path is end-to-end), mock the
 *   services/telephonyProvider surface (initiateCall, lookupContact,
 *   normalizePhone) and the lib/credentialMasking surface (encryptCredential
 *   is mocked to a tagged sentinel so we can prove encryption happened
 *   without depending on a real WELLNESS_FIELD_KEY) and the lib/audit
 *   writeAudit so the rotation-emits-audit assertion fires without hitting
 *   the AuditLog hash-chain code path.
 *
 *   No real DB, no real HTTP, no real crypto. Pure contract pins.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Auth middleware bypass — pass-through verifyToken so we exercise the
// route + verifyRole(['ADMIN']) without minting JWTs. verifyRole stays
// REAL so the 403 RBAC path is exercised end-to-end (test 11).
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Prisma singleton patching — MUST happen BEFORE the router is required.
// telephony.js's top-level `require('../lib/prisma')` resolves at import
// time and captures whatever shape these models point at then.
prisma.telephonyConfig = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
};
prisma.callLog = {
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();

// Service + lib singleton patching — done by mutating the real module
// exports BEFORE the router is required. This is the pattern that works
// reliably for CJS-requiring routes (vi.mock's ESM hoist doesn't always
// intercept inner `require()` calls when services/ isn't in vitest's
// inline-deps regex). The route's `require('../services/telephonyProvider')`
// picks up the SAME object reference we mutate here.
const telephonyProvider = requireCJS('../../services/telephonyProvider');
telephonyProvider.initiateCall = vi.fn();
telephonyProvider.lookupContact = vi.fn();
// normalizePhone stays at its real implementation — the route's calleeNumber
// / callerNumber assertions depend on the actual normalisation contract.

const credentialMasking = requireCJS('../../lib/credentialMasking');
credentialMasking.encryptCredential = vi.fn((v) =>
  v == null || v === '' ? v : `ENC:v1:${v}`
);
credentialMasking.decryptCredential = vi.fn((v) => {
  if (v == null || v === '') return v;
  return typeof v === 'string' && v.startsWith('ENC:v1:') ? v.slice(7) : v;
});
credentialMasking.looksLikeMaskedSentinel = vi.fn((v) => {
  if (typeof v !== 'string') return false;
  if (v.length === 0 || v.length > 12) return false;
  if (v.startsWith('****') && v.length <= 8) return true;
  if (v.endsWith('****') && v.length <= 12) return true;
  return false;
});
credentialMasking.maskConfigRow = vi.fn((row, fields) => {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) {
    const v = row[f];
    if (typeof v !== 'string' || v.length === 0) {
      out[f] = { configured: false, last4: null };
    } else {
      const plain = v.startsWith('ENC:v1:') ? v.slice(7) : v;
      out[f] = { configured: true, last4: '****' + plain.slice(-4) };
    }
  }
  return out;
});

const auditLib = requireCJS('../../lib/audit');
auditLib.writeAudit = vi.fn().mockResolvedValue(undefined);

import express from 'express';
import request from 'supertest';

// Aliases for the mocked exports (already mutated above on the real
// module objects).
const { initiateCall, lookupContact } = telephonyProvider;
const { writeAudit } = auditLib;

const telephonyRouter = requireCJS('../../routes/telephony');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/telephony', telephonyRouter);
  return app;
}

beforeEach(() => {
  prisma.telephonyConfig.findFirst.mockReset();
  prisma.telephonyConfig.findMany.mockReset();
  prisma.telephonyConfig.upsert.mockReset();
  prisma.callLog.findFirst.mockReset();
  prisma.callLog.create.mockReset();
  prisma.callLog.update.mockReset();
  prisma.contact.findFirst.mockReset();

  initiateCall.mockReset();
  lookupContact.mockReset();
  writeAudit.mockReset();
  credentialMasking.encryptCredential.mockClear();
  credentialMasking.decryptCredential.mockClear();
  credentialMasking.looksLikeMaskedSentinel.mockClear();
  credentialMasking.maskConfigRow.mockClear();

  // Sensible defaults
  prisma.telephonyConfig.findFirst.mockResolvedValue(null);
  prisma.telephonyConfig.findMany.mockResolvedValue([]);
  prisma.callLog.findFirst.mockResolvedValue(null);
  prisma.callLog.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: 9001, ...data, createdAt: new Date() })
  );
  prisma.callLog.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ id: where.id, ...data })
  );
  lookupContact.mockResolvedValue(null);
});

// ─── POST /click-to-call ────────────────────────────────────────────

describe('POST /api/telephony/click-to-call', () => {
  test('400 when `to` is missing from the body', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/telephony/click-to-call')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Destination number/i);
    expect(prisma.telephonyConfig.findFirst).not.toHaveBeenCalled();
    expect(initiateCall).not.toHaveBeenCalled();
  });

  test('400 when no active TelephonyConfig for the tenant', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.telephonyConfig.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/telephony/click-to-call')
      .send({ to: '9999999999' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No active telephony provider/i);
    // Tenant filter pinned on the lookup.
    const args = prisma.telephonyConfig.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
    expect(args.where.isActive).toBe(true);
    expect(initiateCall).not.toHaveBeenCalled();
  });

  test('persists CallLog with status=INITIATED on provider success + returns 200 envelope', async () => {
    const app = makeApp({ tenantId: 42, userId: 7 });
    prisma.telephonyConfig.findFirst.mockResolvedValue({
      id: 1,
      provider: 'myoperator',
      virtualNumber: '912000000000',
      agentNumber: '919876543210',
      apiKey: 'ENC:v1:secret-key',
      apiSecret: 'ENC:v1:secret-token',
      isActive: true,
      tenantId: 42,
    });
    initiateCall.mockResolvedValue({ success: true, callId: 'mo-call-abc-123' });

    const res = await request(app)
      .post('/api/telephony/click-to-call')
      .send({ to: '9876543210', contactId: 555 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      callId: 'mo-call-abc-123',
      callLogId: 9001,
    });

    // Provider was called with DECRYPTED credentials (the route decrypts on read).
    expect(initiateCall).toHaveBeenCalledTimes(1);
    const providerArgs = initiateCall.mock.calls[0][0];
    expect(providerArgs.provider).toBe('myoperator');
    expect(providerArgs.apiKey).toBe('secret-key');
    expect(providerArgs.apiSecret).toBe('secret-token');

    // CallLog persisted with the success status + provider call id + the
    // caller-supplied contactId pass-through.
    expect(prisma.callLog.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.callLog.create.mock.calls[0][0];
    expect(createArgs.data.direction).toBe('OUTBOUND');
    expect(createArgs.data.status).toBe('INITIATED');
    expect(createArgs.data.provider).toBe('myoperator');
    expect(createArgs.data.providerCallId).toBe('mo-call-abc-123');
    expect(createArgs.data.contactId).toBe(555);
    expect(createArgs.data.tenantId).toBe(42);
    expect(createArgs.data.userId).toBe(7);
    expect(createArgs.data.notes).toBeNull();
    // Phone normalization landed: 10-digit "9876543210" → "919876543210".
    expect(createArgs.data.calleeNumber).toBe('919876543210');
    expect(createArgs.data.callerNumber).toBe('912000000000');
  });

  test('persists CallLog with status=FAILED on provider error + 502 envelope carries callLogId', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.telephonyConfig.findFirst.mockResolvedValue({
      id: 1,
      provider: 'knowlarity',
      virtualNumber: '914000000000',
      apiKey: 'ENC:v1:k-key',
      apiSecret: 'ENC:v1:k-secret',
      isActive: true,
      tenantId: 42,
    });
    initiateCall.mockResolvedValue({ success: false, error: 'Provider rate limit exceeded' });

    const res = await request(app)
      .post('/api/telephony/click-to-call')
      .send({ to: '9876543210' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Provider rate limit exceeded');
    // The 502 envelope carries the callLogId so the UI can deep-link to
    // the failure row — this is the load-bearing contract pin.
    expect(res.body.callLogId).toBe(9001);

    // Row was still persisted with FAILED status + the provider's error
    // copy as the notes column.
    const createArgs = prisma.callLog.create.mock.calls[0][0];
    expect(createArgs.data.status).toBe('FAILED');
    expect(createArgs.data.notes).toBe('Provider rate limit exceeded');
    expect(createArgs.data.providerCallId).toBeNull();
  });

  test('cross-tenant lookupContact result is DISCARDED (resolvedContactId stays null)', async () => {
    // Tenant 42 caller; lookupContact resolves to a contact owned by
    // tenant 99 — the route MUST reject that linkage rather than leak.
    const app = makeApp({ tenantId: 42 });
    prisma.telephonyConfig.findFirst.mockResolvedValue({
      id: 1,
      provider: 'myoperator',
      virtualNumber: '912000000000',
      apiKey: 'ENC:v1:k',
      apiSecret: 'ENC:v1:s',
      isActive: true,
      tenantId: 42,
    });
    // Cross-tenant contact match — the route MUST ignore it.
    lookupContact.mockResolvedValue({ id: 88, tenantId: 99, phone: '919999999999' });
    initiateCall.mockResolvedValue({ success: true, callId: 'mo-1' });

    const res = await request(app)
      .post('/api/telephony/click-to-call')
      .send({ to: '9999999999' }); // no contactId — forces the lookup path

    expect(res.status).toBe(200);
    const createArgs = prisma.callLog.create.mock.calls[0][0];
    // contactId resolution rejected the cross-tenant match → null.
    expect(createArgs.data.contactId).toBeNull();
    expect(createArgs.data.tenantId).toBe(42); // still the caller's tenant
  });
});

// ─── POST /webhook/myoperator (no auth) ─────────────────────────────

describe('POST /api/telephony/webhook/myoperator', () => {
  test('creates new CallLog when no providerCallId match, normalises phone numbers', async () => {
    const app = makeApp();
    prisma.callLog.findFirst.mockResolvedValue(null); // no existing match
    lookupContact.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/telephony/webhook/myoperator')
      .send({
        caller_number: '9876543210',
        callee_number: '912000000000',
        duration: '125',
        recording_url: 'https://cdn.myoperator.com/rec/abc.mp3',
        status: 'completed',
        call_id: 'mo-webhook-fresh-1',
        direction: 'outbound',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });

    expect(prisma.callLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.callLog.update).not.toHaveBeenCalled();
    const createArgs = prisma.callLog.create.mock.calls[0][0];
    expect(createArgs.data.provider).toBe('myoperator');
    expect(createArgs.data.providerCallId).toBe('mo-webhook-fresh-1');
    // status uppercased
    expect(createArgs.data.status).toBe('COMPLETED');
    // phone normalised: 10-digit → 91-prefix
    expect(createArgs.data.callerNumber).toBe('919876543210');
    // duration parseInt'd
    expect(createArgs.data.duration).toBe(125);
    expect(createArgs.data.recordingUrl).toBe('https://cdn.myoperator.com/rec/abc.mp3');
    expect(createArgs.data.direction).toBe('OUTBOUND');
  });

  test('updates EXISTING CallLog when providerCallId matches (no duplicate row)', async () => {
    const app = makeApp();
    prisma.callLog.findFirst.mockResolvedValue({
      id: 555,
      tenantId: 7,
      callerNumber: '919999999999',
      calleeNumber: '918888888888',
      contactId: 42,
    });

    const res = await request(app)
      .post('/api/telephony/webhook/myoperator')
      .send({
        call_id: 'mo-existing-id',
        duration: '88',
        status: 'completed',
        recording_url: 'https://cdn.myoperator.com/rec/done.mp3',
      });

    expect(res.status).toBe(200);
    expect(prisma.callLog.update).toHaveBeenCalledTimes(1);
    expect(prisma.callLog.create).not.toHaveBeenCalled();

    const updateArgs = prisma.callLog.update.mock.calls[0][0];
    expect(updateArgs.where.id).toBe(555);
    expect(updateArgs.data.duration).toBe(88);
    expect(updateArgs.data.status).toBe('COMPLETED');
    expect(updateArgs.data.recordingUrl).toBe('https://cdn.myoperator.com/rec/done.mp3');
  });

  test('tenantId defaults to 1 when neither existing-call match nor contact match', async () => {
    const app = makeApp();
    prisma.callLog.findFirst.mockResolvedValue(null); // no existing match
    lookupContact.mockResolvedValue(null); // no contact match

    const res = await request(app)
      .post('/api/telephony/webhook/myoperator')
      .send({
        caller_number: '9876543210',
        callee_number: '912000000000',
        status: 'completed',
        call_id: 'mo-orphan-1',
      });

    expect(res.status).toBe(200);
    const createArgs = prisma.callLog.create.mock.calls[0][0];
    // Orphan CDR floor — lands in tenant 1 rather than being dropped.
    expect(createArgs.data.tenantId).toBe(1);
  });
});

// ─── POST /webhook/knowlarity (no auth) ─────────────────────────────

describe('POST /api/telephony/webhook/knowlarity', () => {
  test('creates new CallLog with provider=knowlarity + normalised phones', async () => {
    const app = makeApp();
    prisma.callLog.findFirst.mockResolvedValue(null);
    lookupContact.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/telephony/webhook/knowlarity')
      .send({
        caller_id: '9876543210',
        destination: '912000000000',
        call_duration: '47',
        rec_url: 'https://kpi.knowlarity.com/rec/x.mp3',
        call_status: 'completed',
        uuid: 'kn-uuid-fresh-1',
        call_type: 'outgoing',
      });

    expect(res.status).toBe(200);
    expect(prisma.callLog.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.callLog.create.mock.calls[0][0];
    expect(createArgs.data.provider).toBe('knowlarity');
    expect(createArgs.data.providerCallId).toBe('kn-uuid-fresh-1');
    expect(createArgs.data.duration).toBe(47);
    expect(createArgs.data.status).toBe('COMPLETED');
    expect(createArgs.data.callerNumber).toBe('919876543210');
    expect(createArgs.data.direction).toBe('OUTBOUND');
  });
});

// ─── GET /config (ADMIN-only) ───────────────────────────────────────

describe('GET /api/telephony/config', () => {
  test('ADMIN: scopes findMany by tenantId AND masks apiKey + apiSecret', async () => {
    const app = makeApp({ tenantId: 42, role: 'ADMIN' });
    prisma.telephonyConfig.findMany.mockResolvedValue([
      {
        id: 1,
        provider: 'myoperator',
        virtualNumber: '912000000000',
        apiKey: 'ENC:v1:plaintext-a3f1',
        apiSecret: 'ENC:v1:plaintext-b7d2',
        isActive: true,
        tenantId: 42,
      },
    ]);

    const res = await request(app).get('/api/telephony/config');

    expect(res.status).toBe(200);
    // Tenant filter pinned.
    const args = prisma.telephonyConfig.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });

    // Plaintext NEVER appears in the response — only the {configured, last4}
    // projection. This is the load-bearing #651 pin.
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].apiKey).toEqual({ configured: true, last4: '****a3f1' });
    expect(res.body[0].apiSecret).toEqual({ configured: true, last4: '****b7d2' });
    // Plaintext sanity-check: no raw key material appears anywhere in the body.
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain('plaintext-a3f1');
    expect(blob).not.toContain('plaintext-b7d2');
  });

  test('non-ADMIN: 403 RBAC_DENIED — does NOT hit the database', async () => {
    const app = makeApp({ role: 'USER' });
    const res = await request(app).get('/api/telephony/config');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.telephonyConfig.findMany).not.toHaveBeenCalled();
  });
});

// ─── PUT /config/:provider (ADMIN-only, #651 rotation) ──────────────

describe('PUT /api/telephony/config/:provider', () => {
  test('400 when provider is not in the {myoperator, knowlarity} allowlist', async () => {
    const app = makeApp({ role: 'ADMIN' });
    const res = await request(app)
      .put('/api/telephony/config/exotel')
      .send({ apiKey: 'fresh-key' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/myoperator or knowlarity/i);
    expect(prisma.telephonyConfig.upsert).not.toHaveBeenCalled();
  });

  test('encrypts plaintext apiKey via encryptCredential + stamps lastRotatedAt + emits ROTATE audit', async () => {
    const app = makeApp({ tenantId: 42, userId: 7, role: 'ADMIN' });
    prisma.telephonyConfig.upsert.mockResolvedValue({
      id: 1,
      provider: 'myoperator',
      apiKey: 'ENC:v1:fresh-key-xyz',
      apiSecret: 'ENC:v1:fresh-secret-abc',
      isActive: true,
      tenantId: 42,
    });

    const res = await request(app)
      .put('/api/telephony/config/myoperator')
      .send({
        apiKey: 'fresh-key-xyz',
        apiSecret: 'fresh-secret-abc',
        virtualNumber: '912000000000',
        isActive: true,
      });

    expect(res.status).toBe(200);

    // Both secret fields were encrypted before the upsert.
    expect(credentialMasking.encryptCredential).toHaveBeenCalledWith('fresh-key-xyz');
    expect(credentialMasking.encryptCredential).toHaveBeenCalledWith('fresh-secret-abc');

    // Upsert was called with the ENCRYPTED values, never plaintext.
    expect(prisma.telephonyConfig.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = prisma.telephonyConfig.upsert.mock.calls[0][0];
    expect(upsertArgs.where.tenantId_provider).toEqual({
      tenantId: 42,
      provider: 'myoperator',
    });
    expect(upsertArgs.update.apiKey).toBe('ENC:v1:fresh-key-xyz');
    expect(upsertArgs.update.apiSecret).toBe('ENC:v1:fresh-secret-abc');
    // Rotation timestamp stamped (Date instance, not a literal value match).
    expect(upsertArgs.update.lastRotatedAt).toBeInstanceOf(Date);

    // ROTATE audit emitted with rotatedFields detail.
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const auditArgs = writeAudit.mock.calls[0];
    expect(auditArgs[0]).toBe('ProviderConfig');
    expect(auditArgs[1]).toBe('ROTATE');
    expect(auditArgs[3]).toBe(7); // userId
    expect(auditArgs[4]).toBe(42); // tenantId
    expect(auditArgs[5]).toMatchObject({
      provider: 'telephony:myoperator',
      rotatedFields: expect.arrayContaining(['apiKey', 'apiSecret']),
    });

    // Response is the MASKED row — no plaintext on the rotation path either.
    // last4 = last 4 chars of "fresh-key-xyz" → "-xyz".
    expect(res.body.apiKey).toEqual({ configured: true, last4: '****-xyz' });
  });

  test('masked sentinel input is SKIPPED (no rotation, no audit, no overwrite)', async () => {
    const app = makeApp({ tenantId: 42, role: 'ADMIN' });
    prisma.telephonyConfig.upsert.mockResolvedValue({
      id: 1,
      provider: 'myoperator',
      apiKey: 'ENC:v1:original-key',
      apiSecret: '',
      isActive: true,
      tenantId: 42,
    });

    // User sent back a masked sentinel for apiKey (e.g. round-tripped from
    // the GET /config response) + edited only isActive. The route MUST
    // skip the apiKey field, NOT call encryptCredential on the sentinel,
    // and NOT emit a ROTATE audit.
    const res = await request(app)
      .put('/api/telephony/config/myoperator')
      .send({
        apiKey: '****key1', // 8-char "**** + 4-char tail" sentinel
        isActive: false,
      });

    expect(res.status).toBe(200);

    // No encryption call on the sentinel.
    expect(credentialMasking.encryptCredential).not.toHaveBeenCalled();
    // No rotation audit emitted.
    expect(writeAudit).not.toHaveBeenCalled();

    // The upsert ran (to flip isActive) but its update payload did NOT
    // include an apiKey override AND did NOT stamp lastRotatedAt.
    const upsertArgs = prisma.telephonyConfig.upsert.mock.calls[0][0];
    expect(upsertArgs.update.apiKey).toBeUndefined();
    expect(upsertArgs.update.lastRotatedAt).toBeUndefined();
    expect(upsertArgs.update.isActive).toBe(false);
  });
});

// ─── GET /recordings/:callLogId ─────────────────────────────────────

describe('GET /api/telephony/recordings/:callLogId', () => {
  test('404 when CallLog is in another tenant (tenant filter pinned)', async () => {
    const app = makeApp({ tenantId: 42 });
    // findFirst returns null because the route's where-clause includes
    // tenantId=42 — a CallLog owned by tenant 99 will not match.
    prisma.callLog.findFirst.mockResolvedValue(null);

    const res = await request(app).get('/api/telephony/recordings/555');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);

    // Verify the tenant filter pin was actually on the lookup.
    const args = prisma.callLog.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
    expect(args.where.id).toBe(555);
  });

  test('404 with "No recording available" when CallLog exists but recordingUrl is null', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.callLog.findFirst.mockResolvedValue({
      id: 555,
      tenantId: 42,
      recordingUrl: null,
    });

    const res = await request(app).get('/api/telephony/recordings/555');

    expect(res.status).toBe(404);
    // Separate envelope from "Call log not found" — pinned so the UI can
    // distinguish "call doesn't exist" from "call exists but no recording".
    expect(res.body.error).toMatch(/No recording available/i);
  });

  test('happy path returns ONLY the recordingUrl (does not leak the full CallLog row)', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.callLog.findFirst.mockResolvedValue({
      id: 555,
      tenantId: 42,
      recordingUrl: 'https://cdn.example.com/rec/x.mp3',
      // Sensitive fields that MUST NOT leak through the recordings endpoint:
      callerNumber: '919876543210',
      calleeNumber: '912000000000',
      notes: 'private operator notes',
      providerCallId: 'mo-call-abc',
    });

    const res = await request(app).get('/api/telephony/recordings/555');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recordingUrl: 'https://cdn.example.com/rec/x.mp3' });
    // Lean response — none of the CallLog's other columns are surfaced.
    expect(res.body.callerNumber).toBeUndefined();
    expect(res.body.notes).toBeUndefined();
    expect(res.body.providerCallId).toBeUndefined();
  });
});
