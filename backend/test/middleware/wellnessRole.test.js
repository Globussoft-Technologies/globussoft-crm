// Unit tests for backend/middleware/wellnessRole.js
// Covers the verifyWellnessRole gate factory: input validation, the "admin"
// and "manager" RBAC aliases, the literal wellnessRole match, the
// auth-required 401, and the WELLNESS_ROLE_FORBIDDEN 403 envelope.
import { describe, test, expect, vi } from 'vitest';
import { verifyWellnessRole } from '../../middleware/wellnessRole.js';

function makeReqResNext({ user = null } = {}) {
  const req = { user };
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
  test('ADMIN passes when "admin" is allowed', () => {
    const mw = verifyWellnessRole(['admin']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'ADMIN' },
    });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('MANAGER does NOT pass on ["admin"] alone', () => {
    const mw = verifyWellnessRole(['admin']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'MANAGER' },
    });
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('USER (no wellnessRole) does NOT pass on ["admin"]', () => {
    const mw = verifyWellnessRole(['admin']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER' },
    });
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('manager alias', () => {
  test('MANAGER passes when "manager" is allowed', () => {
    const mw = verifyWellnessRole(['manager']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'MANAGER' },
    });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('both ADMIN and MANAGER pass on ["admin","manager"]', () => {
    const mw = verifyWellnessRole(['admin', 'manager']);
    const a = makeReqResNext({ user: { role: 'ADMIN' } });
    mw(a.req, a.res, a.next);
    expect(a.next).toHaveBeenCalledOnce();

    const m = makeReqResNext({ user: { role: 'MANAGER' } });
    mw(m.req, m.res, m.next);
    expect(m.next).toHaveBeenCalledOnce();
  });
});

describe('literal wellnessRole match', () => {
  test('USER with wellnessRole=doctor passes on ["doctor"]', () => {
    const mw = verifyWellnessRole(['doctor']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'doctor' },
    });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('USER with wellnessRole=professional passes on ["professional"]', () => {
    const mw = verifyWellnessRole(['professional']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'professional' },
    });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('USER with wellnessRole=telecaller passes on ["telecaller","helper"]', () => {
    const mw = verifyWellnessRole(['telecaller', 'helper']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'telecaller' },
    });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('ADMIN does NOT pass on ["doctor"] (no admin alias on this list)', () => {
    const mw = verifyWellnessRole(['doctor']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'ADMIN' },
    });
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('ADMIN passes on ["doctor","admin"] via the admin alias', () => {
    const mw = verifyWellnessRole(['doctor', 'admin']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'ADMIN' },
    });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('USER with wellnessRole=doctor passes on ["doctor","admin"]', () => {
    const mw = verifyWellnessRole(['doctor', 'admin']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'doctor' },
    });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('USER with wellnessRole=helper does NOT pass on ["doctor"]', () => {
    const mw = verifyWellnessRole(['doctor']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'helper' },
    });
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('USER with no wellnessRole at all does NOT pass on ["doctor"]', () => {
    const mw = verifyWellnessRole(['doctor']);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER' },
    });
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('auth required', () => {
  test('401 when req.user is null', () => {
    const mw = verifyWellnessRole(['admin']);
    const { req, res, next } = makeReqResNext({ user: null });
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Authentication required',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('401 when req.user is undefined', () => {
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
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('forbidden envelope', () => {
  test('403 carries WELLNESS_ROLE_FORBIDDEN code and the allowed array', () => {
    const allowed = ['doctor', 'professional'];
    const mw = verifyWellnessRole(allowed);
    const { req, res, next } = makeReqResNext({
      user: { role: 'USER', wellnessRole: 'helper' },
    });
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Insufficient wellness role',
      code: 'WELLNESS_ROLE_FORBIDDEN',
      allowed,
    });
    expect(next).not.toHaveBeenCalled();
  });
});
