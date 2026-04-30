// Unit tests for backend/middleware/validateInput.js
// Covers stripDangerous (deletes id/createdAt/updatedAt/tenantId/userId,
// preserves benign keys, no-ops on missing body), whitelist (returns a
// middleware that strips non-allowed keys), and ALLOWED_FIELDS (snapshot
// shape).
import { describe, test, expect, vi } from 'vitest';
import {
  whitelist,
  stripDangerous,
  ALLOWED_FIELDS,
} from '../../middleware/validateInput.js';

function makeReqResNext({ body } = {}) {
  const req = { body };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  return { req, res, next };
}

describe('stripDangerous', () => {
  test('deletes id, createdAt, updatedAt, tenantId, userId', () => {
    const { req, res, next } = makeReqResNext({
      body: {
        id: 99,
        createdAt: 'now',
        updatedAt: 'now',
        tenantId: 7,
        userId: 4,
        name: 'Acme',
      },
    });
    stripDangerous(req, res, next);
    expect(req.body).toEqual({ name: 'Acme' });
    expect(next).toHaveBeenCalledOnce();
  });

  test('preserves all other keys', () => {
    const { req, res, next } = makeReqResNext({
      body: {
        name: 'Acme',
        email: 'a@b.co',
        phone: '+919999999999',
        amount: 100,
        nested: { ok: true },
      },
    });
    stripDangerous(req, res, next);
    expect(req.body).toEqual({
      name: 'Acme',
      email: 'a@b.co',
      phone: '+919999999999',
      amount: 100,
      nested: { ok: true },
    });
    expect(next).toHaveBeenCalledOnce();
  });

  test('handles undefined body gracefully', () => {
    const { req, res, next } = makeReqResNext({ body: undefined });
    stripDangerous(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('handles null body gracefully', () => {
    const { req, res, next } = makeReqResNext({ body: null });
    stripDangerous(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('handles empty body gracefully', () => {
    const { req, res, next } = makeReqResNext({ body: {} });
    stripDangerous(req, res, next);
    expect(req.body).toEqual({});
    expect(next).toHaveBeenCalledOnce();
  });

  test('always calls next exactly once', () => {
    const { req, res, next } = makeReqResNext({
      body: { id: 1, name: 'x' },
    });
    stripDangerous(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('whitelist', () => {
  test('returns a middleware function', () => {
    expect(typeof whitelist('contact')).toBe('function');
  });

  test('strips keys not in the allow list', () => {
    const mw = whitelist('contact');
    const { req, res, next } = makeReqResNext({
      body: {
        name: 'Suresh',
        email: 'suresh@globussoft.com',
        evilField: 'drop me',
        password: 'leak',
      },
    });
    mw(req, res, next);
    expect(req.body).toEqual({
      name: 'Suresh',
      email: 'suresh@globussoft.com',
    });
    expect(next).toHaveBeenCalledOnce();
  });

  test('preserves allowed keys verbatim', () => {
    const mw = whitelist('deal');
    const { req, res, next } = makeReqResNext({
      body: {
        title: 'Big Deal',
        amount: 50000,
        probability: 0.8,
        stage: 'qualified',
        currency: 'INR',
      },
    });
    mw(req, res, next);
    expect(req.body).toEqual({
      title: 'Big Deal',
      amount: 50000,
      probability: 0.8,
      stage: 'qualified',
      currency: 'INR',
    });
  });

  test('skips undefined values from the source body', () => {
    const mw = whitelist('contact');
    const { req, res, next } = makeReqResNext({
      body: { name: 'Acme', email: undefined },
    });
    mw(req, res, next);
    expect(req.body).toEqual({ name: 'Acme' });
    expect(req.body).not.toHaveProperty('email');
  });

  test('preserves explicit null and false values', () => {
    const mw = whitelist('contact');
    const { req, res, next } = makeReqResNext({
      body: { name: 'Acme', email: null, status: false },
    });
    mw(req, res, next);
    expect(req.body.email).toBeNull();
    expect(req.body.status).toBe(false);
  });

  test('no-ops when entity is unknown (passes body through unchanged)', () => {
    const mw = whitelist('not-a-real-entity');
    const { req, res, next } = makeReqResNext({
      body: { anything: 'goes', here: true },
    });
    mw(req, res, next);
    expect(req.body).toEqual({ anything: 'goes', here: true });
    expect(next).toHaveBeenCalledOnce();
  });

  test('no-ops when body is missing', () => {
    const mw = whitelist('contact');
    const { req, res, next } = makeReqResNext({ body: undefined });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('no-ops on string body (typeof !== object)', () => {
    const mw = whitelist('contact');
    const { req, res, next } = makeReqResNext({ body: 'raw-text' });
    mw(req, res, next);
    expect(req.body).toBe('raw-text');
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('ALLOWED_FIELDS', () => {
  test('exports an object', () => {
    expect(typeof ALLOWED_FIELDS).toBe('object');
    expect(ALLOWED_FIELDS).not.toBeNull();
  });

  test.each([
    'contact',
    'deal',
    'ticket',
    'task',
    'invoice',
    'campaign',
    'project',
    'contract',
    'expense',
    'estimate',
  ])('has a non-empty array for entity "%s"', (entity) => {
    expect(Array.isArray(ALLOWED_FIELDS[entity])).toBe(true);
    expect(ALLOWED_FIELDS[entity].length).toBeGreaterThan(0);
    for (const field of ALLOWED_FIELDS[entity]) {
      expect(typeof field).toBe('string');
      expect(field.length).toBeGreaterThan(0);
    }
  });

  test('contact allow list contains email and name', () => {
    expect(ALLOWED_FIELDS.contact).toContain('name');
    expect(ALLOWED_FIELDS.contact).toContain('email');
    expect(ALLOWED_FIELDS.contact).toContain('phone');
  });

  test('deal allow list contains amount and stage', () => {
    expect(ALLOWED_FIELDS.deal).toContain('amount');
    expect(ALLOWED_FIELDS.deal).toContain('stage');
  });

  test('NEVER includes id/createdAt/updatedAt/tenantId/userId', () => {
    for (const entity of Object.keys(ALLOWED_FIELDS)) {
      const list = ALLOWED_FIELDS[entity];
      expect(list).not.toContain('id');
      expect(list).not.toContain('createdAt');
      expect(list).not.toContain('updatedAt');
      expect(list).not.toContain('tenantId');
      // userId is allowed for the task entity (assignee user); see source.
      if (entity !== 'task') {
        expect(list).not.toContain('userId');
      }
    }
  });
});
