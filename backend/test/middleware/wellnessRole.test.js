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
import { describe, test, expect, vi } from 'vitest';
import { verifyWellnessRole } from '../../middleware/wellnessRole.js';

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

describe('forbidden envelope', () => {
  test('403 carries WELLNESS_ROLE_FORBIDDEN code and the allowed array', async () => {
    const allowed = ['doctor', 'professional'];
    const mw = verifyWellnessRole(allowed);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'helper' },
    });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Insufficient wellness role',
      code: 'WELLNESS_ROLE_FORBIDDEN',
      allowed,
    });
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
    expect(res.json).toHaveBeenCalledWith({
      error: 'Wellness vertical required',
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
