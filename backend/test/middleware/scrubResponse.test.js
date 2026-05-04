// Unit tests for backend/middleware/scrubResponse.js
//
// Covers the deep-scrubber walker (scrubValue) and the Express middleware
// wrapper (scrubResponse). The walker is the bug-prevention layer for #426 —
// every Contact-returning route relies on this scrub to strip
// portalPasswordHash, including deeply-nested cases like
// `include: { contact: true }` on a billing invoice.
//
// Test surface:
//   - direct top-level Contact strip (the GET /api/contacts case)
//   - array of Contacts (the list endpoint case)
//   - nested Contact under an Invoice (the include: { contact: true } case)
//   - mixed types: Date, Buffer, null, primitives — must pass through
//   - benign keys preserved
//   - middleware patches res.json once and forwards the patched body

import { describe, test, expect, vi } from 'vitest';
import {
  scrubResponse,
  scrubValue,
  FORBIDDEN_FIELDS,
} from '../../middleware/scrubResponse.js';

describe('FORBIDDEN_FIELDS', () => {
  test('includes portalPasswordHash (the #426 bug class)', () => {
    expect(FORBIDDEN_FIELDS.has('portalPasswordHash')).toBe(true);
  });

  test('does NOT strip benign field names that look credential-ish', () => {
    // Whitelisting by name is fragile; the codebase intentionally restricts
    // the strip-list to known leaks. If you add a name here, document why
    // in the middleware header so future callers know what to expect.
    expect(FORBIDDEN_FIELDS.has('email')).toBe(false);
    expect(FORBIDDEN_FIELDS.has('phone')).toBe(false);
    expect(FORBIDDEN_FIELDS.has('apiKey')).toBe(false);
  });
});

describe('scrubValue — top-level Contact', () => {
  test('strips portalPasswordHash from a flat Contact', () => {
    const contact = {
      id: 1,
      name: 'Test',
      email: 'a@b.co',
      portalPasswordHash: '$2b$10$bcrypt.hash.here',
    };
    scrubValue(contact);
    expect(contact).toEqual({ id: 1, name: 'Test', email: 'a@b.co' });
    expect('portalPasswordHash' in contact).toBe(false);
  });

  test('preserves benign fields', () => {
    const contact = {
      id: 1,
      name: 'Test',
      email: 'a@b.co',
      aiScore: 75,
      assignedToId: 4,
      tenantId: 2,
    };
    const before = { ...contact };
    scrubValue(contact);
    expect(contact).toEqual(before);
  });

  test('no-op on Contact without portalPasswordHash', () => {
    const contact = { id: 1, name: 'Test' };
    scrubValue(contact);
    expect(contact).toEqual({ id: 1, name: 'Test' });
  });
});

describe('scrubValue — collections', () => {
  test('strips from every element in an array of Contacts', () => {
    const list = [
      { id: 1, name: 'A', portalPasswordHash: 'hash1' },
      { id: 2, name: 'B', portalPasswordHash: 'hash2' },
      { id: 3, name: 'C' }, // missing the field — must not error
    ];
    scrubValue(list);
    for (const c of list) {
      expect('portalPasswordHash' in c).toBe(false);
    }
    expect(list[0].name).toBe('A');
    expect(list[1].name).toBe('B');
    expect(list[2].name).toBe('C');
  });

  test('strips from nested include: { contact: true } shape', () => {
    // This is the actual shape returned by routes/billing.js:
    //   prisma.invoice.findMany({ include: { contact: true, deal: true } })
    const invoice = {
      id: 100,
      amount: 999,
      status: 'PAID',
      contact: {
        id: 5,
        name: 'Customer',
        email: 'c@x.co',
        portalPasswordHash: 'leaked-via-include',
      },
      deal: {
        id: 50,
        title: 'Q1 deal',
      },
    };
    scrubValue(invoice);
    expect('portalPasswordHash' in invoice.contact).toBe(false);
    expect(invoice.contact.name).toBe('Customer');
    expect(invoice.deal.title).toBe('Q1 deal');
  });

  test('strips from doubly-nested arrays (list of invoices each with a contact)', () => {
    const invoices = [
      { id: 1, contact: { id: 10, name: 'A', portalPasswordHash: 'h1' } },
      { id: 2, contact: { id: 11, name: 'B', portalPasswordHash: 'h2' } },
    ];
    scrubValue(invoices);
    for (const inv of invoices) {
      expect('portalPasswordHash' in inv.contact).toBe(false);
    }
  });
});

describe('scrubValue — type guards', () => {
  test('returns null/undefined unchanged', () => {
    expect(scrubValue(null)).toBeNull();
    expect(scrubValue(undefined)).toBeUndefined();
  });

  test('returns primitives unchanged', () => {
    expect(scrubValue('string')).toBe('string');
    expect(scrubValue(42)).toBe(42);
    expect(scrubValue(true)).toBe(true);
  });

  test('preserves Date instances (does not iterate keys)', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const wrapper = { createdAt: d, name: 'x' };
    scrubValue(wrapper);
    expect(wrapper.createdAt).toBe(d);
    expect(wrapper.createdAt instanceof Date).toBe(true);
  });

  test('preserves Buffer instances (does not iterate bytes)', () => {
    const buf = Buffer.from('hello', 'utf8');
    const wrapper = { payload: buf };
    scrubValue(wrapper);
    expect(Buffer.isBuffer(wrapper.payload)).toBe(true);
    expect(wrapper.payload.toString('utf8')).toBe('hello');
  });
});

describe('scrubResponse middleware', () => {
  function makeReqResNext() {
    const captured = { body: undefined };
    const res = {
      json: vi.fn((body) => {
        captured.body = body;
        return res;
      }),
    };
    const next = vi.fn();
    return { req: {}, res, next, captured };
  }

  test('patches res.json so the scrub runs at response boundary', () => {
    const { req, res, next, captured } = makeReqResNext();
    scrubResponse(req, res, next);
    expect(next).toHaveBeenCalledOnce();

    res.json({ id: 1, name: 'C', portalPasswordHash: 'leaked' });
    expect(captured.body).toEqual({ id: 1, name: 'C' });
    expect('portalPasswordHash' in captured.body).toBe(false);
  });

  test('passes through benign payloads unchanged', () => {
    const { req, res, next, captured } = makeReqResNext();
    scrubResponse(req, res, next);
    const payload = { ok: true, items: [1, 2, 3], count: 3 };
    res.json(payload);
    expect(captured.body).toEqual(payload);
  });

  test('strips inside nested includes (the billing invoice case)', () => {
    const { req, res, next, captured } = makeReqResNext();
    scrubResponse(req, res, next);
    res.json({
      id: 100,
      amount: 50,
      contact: { id: 5, name: 'C', portalPasswordHash: 'h' },
    });
    expect('portalPasswordHash' in captured.body.contact).toBe(false);
  });

  test('handles array payloads (the list endpoint shape)', () => {
    const { req, res, next, captured } = makeReqResNext();
    scrubResponse(req, res, next);
    res.json([
      { id: 1, portalPasswordHash: 'h1' },
      { id: 2, portalPasswordHash: 'h2' },
    ]);
    for (const c of captured.body) {
      expect('portalPasswordHash' in c).toBe(false);
    }
  });

  test('does not alter the original res.json contract when called twice', () => {
    const { req, res, next, captured } = makeReqResNext();
    scrubResponse(req, res, next);
    res.json({ portalPasswordHash: 'first' });
    res.json({ portalPasswordHash: 'second' });
    // Last call wins; the patched json kept working
    expect('portalPasswordHash' in captured.body).toBe(false);
  });
});
