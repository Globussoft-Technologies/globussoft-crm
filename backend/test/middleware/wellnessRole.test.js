// Unit tests for backend/middleware/wellnessRole.js
// Covers the verifyWellnessRole gate factory: input validation, the "admin"
// and "manager" RBAC aliases, the literal wellnessRole match, the
// auth-required 401, the WELLNESS_ROLE_FORBIDDEN 403 envelope, and the
// #325 WELLNESS_TENANT_REQUIRED gate (post-fix the middleware also
// refuses any user whose tenant.vertical !== 'wellness').
//
// Note: the middleware is now async (it may DB-look-up tenant.vertical
// when the JWT lacks the claim). Every call site awaits it. Tests
// pre-populate `req.user.vertical` so the middleware never hits prisma.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import { verifyWellnessRole } from '../../middleware/wellnessRole.js';
// The middleware looks up `getUserPermissions` on the requirePermission
// module object at CALL TIME (not destructured at require-time), so we
// can swap it with a deterministic fake here. The eslint rule is fine
// with this pattern — it's the standard "module reference patch" used
// throughout the test suite.
const requirePermissionModule = require('../../middleware/requirePermission.js');
const realGetUserPermissions = requirePermissionModule.getUserPermissions;

// All tests use vertical='wellness' by default — only the dedicated
// "tenant vertical gate" describe block flips it to test the refusal.
function makeReqResNext({ user = null, vertical = 'wellness' } = {}) {
  const req = { user: user ? { ...user, vertical: user.vertical ?? vertical } : null };
  let statusCode = 200;
  const res = {
    status: vi.fn(function (c) {
      statusCode = c;
      return this;
    }),
    json: vi.fn(function (data) {
      this.body = data;
      return this;
    }),
    get statusCode() {
      return statusCode;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

describe('factory input validation', () => {
  test('throws when allowed list is not an array', () => {
    expect(() => verifyWellnessRole('admin')).toThrow(/non-empty array/i);
  });

  test('throws when allowed list is empty', () => {
    expect(() => verifyWellnessRole([])).toThrow(/non-empty array/i);
  });

  test('throws when allowed is undefined', () => {
    expect(() => verifyWellnessRole()).toThrow(/non-empty array/i);
  });
});

describe('admin alias (RBAC ADMIN passes via "admin")', () => {
  test('ADMIN passes when "admin" is allowed', async () => {
    const mw = verifyWellnessRole(['admin']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'ADMIN' },
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('MANAGER does NOT pass on ["admin"] alone', async () => {
    const mw = verifyWellnessRole(['admin']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'MANAGER' },
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('USER (no wellnessRole) does NOT pass on ["admin"]', async () => {
    const mw = verifyWellnessRole(['admin']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER' },
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('manager alias', () => {
  test('MANAGER passes when "manager" is allowed', async () => {
    const mw = verifyWellnessRole(['manager']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'MANAGER' },
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('both ADMIN and MANAGER pass on ["admin","manager"]', async () => {
    const mw = verifyWellnessRole(['admin', 'manager']);
    const a = makeReqResNext({ user: { role: 'ADMIN' } });
    await mw(a.req, a.res, a.next);
    expect(a.next).toHaveBeenCalledOnce();

    const m = makeReqResNext({ user: { role: 'MANAGER' } });
    await mw(m.req, m.res, m.next);
    expect(m.next).toHaveBeenCalledOnce();
  });
});

describe('literal wellnessRole match', () => {
  test('USER with wellnessRole=doctor passes on ["doctor"]', async () => {
    const mw = verifyWellnessRole(['doctor']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'doctor' },
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('USER with wellnessRole=professional passes on ["professional"]', async () => {
    const mw = verifyWellnessRole(['professional']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'professional' },
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('USER with wellnessRole=telecaller passes on ["telecaller","helper"]', async () => {
    const mw = verifyWellnessRole(['telecaller', 'helper']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'telecaller' },
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('ADMIN does NOT pass on ["doctor"] (no admin alias on this list)', async () => {
    const mw = verifyWellnessRole(['doctor']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'ADMIN' },
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('ADMIN passes on ["doctor","admin"] via the admin alias', async () => {
    const mw = verifyWellnessRole(['doctor', 'admin']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'ADMIN' },
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('USER with wellnessRole=doctor passes on ["doctor","admin"]', async () => {
    const mw = verifyWellnessRole(['doctor', 'admin']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'doctor' },
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('USER with wellnessRole=helper does NOT pass on ["doctor"]', async () => {
    const mw = verifyWellnessRole(['doctor']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'helper' },
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('USER with no wellnessRole at all does NOT pass on ["doctor"]', async () => {
    const mw = verifyWellnessRole(['doctor']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER' },
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('auth required', () => {
  test('401 when req.user is null', async () => {
    const mw = verifyWellnessRole(['admin']);
    const { req, res, next } = makeReqResNext({ user: null });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Authentication required',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('401 when req.user is undefined', async () => {
    const mw = verifyWellnessRole(['admin']);
    const req = {};
    let statusCode = 200;
    const res = {
      status: vi.fn(function (c) {
        statusCode = c;
        return this;
      }),
      json: vi.fn(),
      get statusCode() {
        return statusCode;
      },
    };
    const next = vi.fn();
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// #590 / #591: canonical RBAC denial envelope.
//
// Pre-fix, verifyWellnessRole emitted "Insufficient wellness role" as
// the human-facing `error` — that string leaked the wellness role
// taxonomy to non-privileged users (enumeration-helpful for social-
// engineering / JWT-tampering attempts).
//
// Now the human-facing `error` is the SAME neutral copy emitted by
// verifyRole's RBAC_DENIED envelope. The granular `code` stays
// (WELLNESS_ROLE_FORBIDDEN) so SDKs / specs can still distinguish
// wellness from generic role denials by intent. The `allowed` array
// stays in the JSON envelope to honour the #274 contract (it's
// technical metadata, not user-visible toast copy).
describe('forbidden envelope (#590 / #591 canonical RBAC_DENIED copy)', () => {
  test('403 carries WELLNESS_ROLE_FORBIDDEN code and neutral user-facing message', async () => {
    const allowed = ['doctor', 'professional'];
    const mw = verifyWellnessRole(allowed);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'helper' },
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error:
        "You don't have permission to perform this action. Contact your administrator.",
      code: 'WELLNESS_ROLE_FORBIDDEN',
      allowed,
    });
    // No role-taxonomy leakage in the human-facing copy. Body must NOT
    // mention internal role tokens in the `error` field — that's the
    // string the frontend renders into the toast. "administrator" is
    // the user-facing escalation path, not a role-token. The `allowed`
    // array is technical metadata for the frontend mapper (#274 contract).
    const body = res.json.mock.calls[0][0];
    expect(body.error).not.toMatch(/system admin|wellness role|\bADMIN\b|\bMANAGER\b|\bdoctor\b|\bprofessional\b|\btelecaller\b|\bhelper\b/i);
    expect(next).not.toHaveBeenCalled();
  });
});

// #325: tenant vertical gate. ADMIN from a non-wellness tenant
// (e.g. `admin@globussoft.com` on the GENERIC tenant) used to pass
// every wellness-gated route just because role==='ADMIN' and 'admin'
// was in the allowed list. Now the middleware refuses them with
// WELLNESS_TENANT_REQUIRED before any role check fires.
describe('tenant vertical gate (#325)', () => {
  test('403 WELLNESS_TENANT_REQUIRED when vertical=generic, even for ADMIN', async () => {
    const mw = verifyWellnessRole(['admin']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'ADMIN', vertical: 'generic' },
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    // #590 / #591: body uses the canonical neutral RBAC copy (no
    // "Wellness vertical required" leakage). Granular code stays so
    // SDKs / specs can still branch on intent.
    expect(res.json).toHaveBeenCalledWith({
      error:
        "You don't have permission to perform this action. Contact your administrator.",
      code: 'WELLNESS_TENANT_REQUIRED',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('403 WELLNESS_TENANT_REQUIRED when vertical=generic for USER+doctor', async () => {
    const mw = verifyWellnessRole(['doctor']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'doctor', vertical: 'generic' },
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].code).toBe('WELLNESS_TENANT_REQUIRED');
    expect(next).not.toHaveBeenCalled();
  });

  test('passes through when vertical=wellness (the existing behaviour)', async () => {
    const mw = verifyWellnessRole(['admin']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'ADMIN', vertical: 'wellness' },
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

// "clinical" meta-token: dynamically resolves against the per-tenant
// WellnessRoleType catalog. Lets admins add a brand-new clinical
// wellnessRole (e.g. "nurse", "physiotherapist") in Settings → Wellness
// Role Types and have it flow through every clinical-gated route with
// ZERO code change. The middleware checks `canTakeVisits = true` on the
// user's wellnessRole in the catalog; if true and "clinical" is in the
// allowed list, the request passes.
describe('"clinical" meta-token (catalog-driven dynamic gate)', () => {
  // The middleware uses prisma.wellnessRoleType.findMany to read the
  // catalog. Tests inject a `_wellnessRoleCatalog` Map on req.user so the
  // middleware never hits prisma — this is the same memoization key the
  // middleware itself populates on the request after one lookup.
  function withCatalog(user, catalog) {
    return { ...user, vertical: 'wellness' };
  }
  function makeReqWithCatalog({ user, catalog }) {
    const req = { user: { ...user, vertical: 'wellness' } };
    // The middleware memoizes the catalog on req._wellnessRoleCatalog
    // after its first lookup. Pre-populate it so the middleware reads
    // ours instead of hitting prisma in unit tests.
    req._wellnessRoleCatalog = catalog;
    let statusCode = 200;
    const res = {
      status: vi.fn(function (c) { statusCode = c; return this; }),
      json: vi.fn(function (data) { this.body = data; return this; }),
      get statusCode() { return statusCode; },
    };
    const next = vi.fn();
    return { req, res, next };
  }

  test('USER with wellnessRole=nurse passes on ["clinical"] when nurse has canTakeVisits=true', async () => {
    const mw = verifyWellnessRole(['clinical']);
    const catalog = new Map([
      ['doctor', true],
      ['professional', true],
      ['nurse', true],
      ['stylist', true],
      ['telecaller', false],
      ['helper', false],
    ]);
    const { req, res, next } = makeReqWithCatalog({
      user: { role: 'USER', wellnessRole: 'nurse', tenantId: 1 },
      catalog,
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('USER with wellnessRole=physiotherapist (new custom role) passes on ["clinical"]', async () => {
    const mw = verifyWellnessRole(['clinical']);
    const catalog = new Map([
      ['doctor', true],
      ['physiotherapist', true], // admin just added this in Settings → Wellness Role Types
    ]);
    const { req, res, next } = makeReqWithCatalog({
      user: { role: 'USER', wellnessRole: 'physiotherapist', tenantId: 1 },
      catalog,
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('USER with wellnessRole=helper (canTakeVisits=false) does NOT pass on ["clinical"]', async () => {
    const mw = verifyWellnessRole(['clinical']);
    const catalog = new Map([
      ['doctor', true],
      ['helper', false],
    ]);
    const { req, res, next } = makeReqWithCatalog({
      user: { role: 'USER', wellnessRole: 'helper', tenantId: 1 },
      catalog,
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('USER with wellnessRole=nurse does NOT pass on ["doctor"] (no "clinical" token in allow-list)', async () => {
    // Without "clinical" in the allow-list, only literal matches count —
    // nurse stays denied. Important: admin-only routes ["admin","manager"]
    // continue to reject every wellnessRole regardless of canTakeVisits.
    const mw = verifyWellnessRole(['doctor']);
    const catalog = new Map([['doctor', true], ['nurse', true]]);
    const { req, res, next } = makeReqWithCatalog({
      user: { role: 'USER', wellnessRole: 'nurse', tenantId: 1 },
      catalog,
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('USER with wellnessRole=nurse does NOT pass on ["admin","manager"] (admin-only gate stays admin-only)', async () => {
    const mw = verifyWellnessRole(['admin', 'manager']);
    const catalog = new Map([['doctor', true], ['nurse', true]]);
    const { req, res, next } = makeReqWithCatalog({
      user: { role: 'USER', wellnessRole: 'nurse', tenantId: 1 },
      catalog,
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('USER with wellnessRole=nurse passes on ["clinical","telecaller","admin","manager"] (the new phiReadGate shape)', async () => {
    const mw = verifyWellnessRole(['clinical', 'telecaller', 'admin', 'manager']);
    const catalog = new Map([['doctor', true], ['nurse', true], ['telecaller', false]]);
    const { req, res, next } = makeReqWithCatalog({
      user: { role: 'USER', wellnessRole: 'nurse', tenantId: 1 },
      catalog,
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('USER with wellnessRole=doctor passes via LITERAL match on ["clinical","doctor",...] before catalog lookup', async () => {
    // Performance contract: when the literal "doctor" is in the allow-list,
    // it matches FIRST and short-circuits the catalog DB query. The
    // catalog is irrelevant in this hot path — verified by passing an
    // empty catalog and still seeing next() called.
    const mw = verifyWellnessRole(['clinical', 'doctor', 'professional', 'admin', 'manager']);
    const { req, res, next } = makeReqWithCatalog({
      user: { role: 'USER', wellnessRole: 'doctor', tenantId: 1 },
      catalog: new Map(), // empty catalog — proves literal short-circuit
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('USER with no wellnessRole does NOT pass on ["clinical"]', async () => {
    const mw = verifyWellnessRole(['clinical']);
    const catalog = new Map([['doctor', true]]);
    const { req, res, next } = makeReqWithCatalog({
      user: { role: 'USER', tenantId: 1 }, // no wellnessRole
      catalog,
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // Silences eslint no-unused-vars on the unused helper
  void withCatalog;
});

// anyOfPermissions: RBAC-permission fallback. When the route declares
// a list of {module, action} grants AND the calling user's effective
// permissions (from the merged UserRole→RolePermission set) include
// AT LEAST ONE of them, the request passes — even without a matching
// wellnessRole. Implements the "I created a Receptionist role, granted
// appointments.read, expect the appointments UI to work" use case.
describe('anyOfPermissions (RBAC fallback)', () => {
  // Swap getUserPermissions with a deterministic fake; restore after.
  beforeEach(() => {
    requirePermissionModule.getUserPermissions = vi.fn(
      async () => new Set(),
    );
  });
  afterEach(() => {
    requirePermissionModule.getUserPermissions = realGetUserPermissions;
  });

  function makeReq({ user, perms = [] }) {
    const req = { user: { ...user, vertical: 'wellness' } };
    let statusCode = 200;
    const res = {
      status: vi.fn(function (c) { statusCode = c; return this; }),
      json: vi.fn(function (data) { this.body = data; return this; }),
      get statusCode() { return statusCode; },
    };
    const next = vi.fn();
    requirePermissionModule.getUserPermissions = vi.fn(
      async () => new Set(perms),
    );
    return { req, res, next };
  }

  test('USER with appointments.read passes on ["clinical","doctor",...] + anyOfPermissions [appointments.read]', async () => {
    const mw = verifyWellnessRole(
      ['clinical', 'doctor', 'professional', 'telecaller', 'admin', 'manager'],
      { anyOfPermissions: [{ module: 'appointments', action: 'read' }] },
    );
    // User has no wellnessRole and isn't ADMIN/MANAGER — only the RBAC
    // grant lets them through.
    const { req, res, next } = makeReq({
      user: { role: 'USER', userId: 42, tenantId: 1 },
      perms: ['appointments.read'],
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('USER without the listed permission falls through to 403', async () => {
    const mw = verifyWellnessRole(
      ['doctor', 'professional', 'admin', 'manager'],
      { anyOfPermissions: [{ module: 'patients', action: 'read' }] },
    );
    const { req, res, next } = makeReq({
      user: { role: 'USER', userId: 42, tenantId: 1 },
      perms: ['unrelated.read'],
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('user with ANY one of multiple listed grants passes', async () => {
    const mw = verifyWellnessRole(
      ['doctor', 'admin', 'manager'],
      {
        anyOfPermissions: [
          { module: 'patients', action: 'read' },
          { module: 'appointments', action: 'read' },
          { module: 'visits', action: 'read' },
        ],
      },
    );
    const { req, res, next } = makeReq({
      user: { role: 'USER', userId: 42, tenantId: 1 },
      perms: ['visits.read'], // only the 3rd in the list
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('omitting anyOfPermissions leaves behaviour identical to before (literal-only)', async () => {
    // No 2nd argument → no RBAC fallback. USER with no wellnessRole and
    // appointments.read grant still gets 403 because the gate has no
    // anyOfPermissions declared.
    const mw = verifyWellnessRole(['doctor', 'professional', 'admin', 'manager']);
    const { req, res, next } = makeReq({
      user: { role: 'USER', userId: 42, tenantId: 1 },
      perms: ['appointments.read'],
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('admin/manager literal aliases still short-circuit before RBAC lookup', async () => {
    // ADMIN passes via the "admin" alias before any DB lookup. Same
    // for MANAGER. anyOfPermissions is irrelevant to that path.
    const mw = verifyWellnessRole(
      ['admin', 'manager'],
      { anyOfPermissions: [{ module: 'patients', action: 'read' }] },
    );
    const { req, res, next } = makeReq({
      user: { role: 'ADMIN', userId: 42, tenantId: 1 },
      perms: [], // empty — proves admin alias short-circuits
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
