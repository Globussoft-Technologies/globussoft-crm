// Unit tests for backend/services/telephonyProvider.js — initiateCall over
// MyOperator + Knowlarity (HTTP via global fetch) and lookupContact over a
// mocked Prisma client.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import telephony from '../../services/telephonyProvider.js';
const { initiateCall, lookupContact, normalizePhone } = telephony;

// Helper: build a fake fetch Response.
function fakeResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  delete global.fetch;
});

describe('telephonyProvider — module shape', () => {
  test('exports initiateCall, lookupContact, normalizePhone', () => {
    expect(typeof initiateCall).toBe('function');
    expect(typeof lookupContact).toBe('function');
    expect(typeof normalizePhone).toBe('function');
  });
});

describe('telephonyProvider — normalizePhone', () => {
  test('strips non-digits and prepends 91 for 10-digit numbers', () => {
    expect(normalizePhone('+91 (987) 654-3210')).toBe('919876543210');
  });
  test('prepends 91 for bare 10-digit number', () => {
    expect(normalizePhone('9876543210')).toBe('919876543210');
  });
  test('passes through 12-digit number untouched', () => {
    expect(normalizePhone('919876543210')).toBe('919876543210');
  });
  test('does not prepend 91 to a 7-digit number', () => {
    expect(normalizePhone('1234567')).toBe('1234567');
  });
});

describe('telephonyProvider — initiateCall (myoperator)', () => {
  test('happy path → success + callId', async () => {
    global.fetch.mockReturnValue(
      fakeResponse(200, { status: 'success', call_id: 'mo_call_42' })
    );
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'myoperator',
      apiKey: 'COMPANY_X',
      apiSecret: 'SECRET',
      virtualNumber: '+9180123',
    });
    expect(out).toEqual({ success: true, callId: 'mo_call_42' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.myoperator.com/obd/make-call');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Api-Key']).toBe('COMPANY_X');
    expect(init.headers.Authorization).toBe('Bearer SECRET');
    const body = JSON.parse(init.body);
    expect(body.company_id).toBe('COMPANY_X');
    expect(body.secret_token).toBe('SECRET');
    expect(body.type).toBe('obd');
    expect(body.public_ivr_id).toBe('+9180123');
    expect(body.agent_number).toBe('919876543210'); // normalized
    expect(body.customer_number).toBe('918765432109');
  });

  test('returns success even if call_id missing but id present', async () => {
    global.fetch.mockReturnValue(
      fakeResponse(200, { status: 'success', id: 'fallback_id' })
    );
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'myoperator',
      apiKey: 'COMP',
      apiSecret: 'SEC',
      virtualNumber: '+91',
    });
    expect(out).toEqual({ success: true, callId: 'fallback_id' });
  });

  test('returns success with null callId when neither call_id nor id is present', async () => {
    global.fetch.mockReturnValue(fakeResponse(200, { status: 'success' }));
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'myoperator',
      apiKey: 'C',
      apiSecret: 'S',
      virtualNumber: '+1',
    });
    expect(out).toEqual({ success: true, callId: null });
  });

  test('non-success status in 200 body → failure with provider message', async () => {
    global.fetch.mockReturnValue(
      fakeResponse(200, { status: 'error', message: 'Insufficient credits' })
    );
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'myoperator',
      apiKey: 'C',
      apiSecret: 'S',
      virtualNumber: '+1',
    });
    expect(out).toEqual({ success: false, error: 'Insufficient credits' });
  });

  test('http 4xx → failure with default error if no message', async () => {
    global.fetch.mockReturnValue(fakeResponse(401, {}));
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'myoperator',
      apiKey: 'BAD',
      apiSecret: 'S',
      virtualNumber: '+1',
    });
    expect(out.success).toBe(false);
    expect(out.error).toBe('MyOperator call failed');
  });

  test('http 4xx with message in body → surfaces that', async () => {
    global.fetch.mockReturnValue(fakeResponse(403, { message: 'invalid api key' }));
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'myoperator',
      apiKey: 'BAD',
      apiSecret: 'S',
      virtualNumber: '+1',
    });
    expect(out).toEqual({ success: false, error: 'invalid api key' });
  });
});

describe('telephonyProvider — initiateCall (knowlarity)', () => {
  test('happy path → success + uuid as callId', async () => {
    global.fetch.mockReturnValue(
      fakeResponse(200, { success: true, uuid: 'kw_uuid_99' })
    );
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'knowlarity',
      apiKey: 'KW_KEY',
      apiSecret: 'KW_SEC',
      virtualNumber: '+918012345',
    });
    expect(out).toEqual({ success: true, callId: 'kw_uuid_99' });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://kpi.knowlarity.com/Basic/v1/account/call/makecall');
    // Knowlarity uses Authorization (bare) and an x-api-key header (with the
    // typo bracket as written in source — capture it as-is).
    expect(init.headers.Authorization).toBe('KW_SEC');
    const body = JSON.parse(init.body);
    expect(body.k_number).toBe('+918012345');
    // Numbers are passed with leading + after normalize
    expect(body.agent_number).toBe('+919876543210');
    expect(body.customer_number).toBe('+918765432109');
  });

  test('happy path uses call_id when present', async () => {
    global.fetch.mockReturnValue(
      fakeResponse(200, { call_id: 'kw_call_1' })
    );
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'knowlarity',
      apiKey: 'K',
      apiSecret: 'S',
      virtualNumber: '+1',
    });
    expect(out).toEqual({ success: true, callId: 'kw_call_1' });
  });

  test('failure when neither success nor call_id is set', async () => {
    global.fetch.mockReturnValue(fakeResponse(200, { error: 'bad number' }));
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'knowlarity',
      apiKey: 'K',
      apiSecret: 'S',
      virtualNumber: '+1',
    });
    expect(out).toEqual({ success: false, error: 'bad number' });
  });

  test('failure with .message field', async () => {
    global.fetch.mockReturnValue(fakeResponse(400, { message: 'agent offline' }));
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'knowlarity',
      apiKey: 'K',
      apiSecret: 'S',
      virtualNumber: '+1',
    });
    expect(out.success).toBe(false);
    expect(out.error).toBe('agent offline');
  });

  test('default error string when nothing in body', async () => {
    global.fetch.mockReturnValue(fakeResponse(500, {}));
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'knowlarity',
      apiKey: 'K',
      apiSecret: 'S',
      virtualNumber: '+1',
    });
    expect(out.success).toBe(false);
    expect(out.error).toBe('Knowlarity call failed');
  });
});

describe('telephonyProvider — initiateCall (unsupported / errors)', () => {
  test('rejects unknown provider', async () => {
    const out = await initiateCall({
      from: '1',
      to: '2',
      provider: 'plivo',
      apiKey: 'k',
      apiSecret: 's',
      virtualNumber: '+1',
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Unsupported provider/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('fetch throw → returns success:false with error message', async () => {
    global.fetch.mockImplementation(() => {
      throw new Error('ENOTFOUND');
    });
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'myoperator',
      apiKey: 'K',
      apiSecret: 'S',
      virtualNumber: '+1',
    });
    expect(out).toEqual({ success: false, error: 'ENOTFOUND' });
  });

  test('fetch rejects → caught and surfaced', async () => {
    global.fetch.mockReturnValue(Promise.reject(new Error('ETIMEDOUT')));
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'knowlarity',
      apiKey: 'K',
      apiSecret: 'S',
      virtualNumber: '+1',
    });
    expect(out).toEqual({ success: false, error: 'ETIMEDOUT' });
  });

  test('json() throw → caught', async () => {
    global.fetch.mockReturnValue(
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('bad json')),
      })
    );
    const out = await initiateCall({
      from: '9876543210',
      to: '8765432109',
      provider: 'myoperator',
      apiKey: 'K',
      apiSecret: 'S',
      virtualNumber: '+1',
    });
    expect(out.success).toBe(false);
    expect(out.error).toBe('bad json');
  });
});

describe('telephonyProvider — lookupContact', () => {
  function makePrisma(rows) {
    return {
      contact: {
        findFirst: vi.fn().mockResolvedValue(rows.length ? rows[0] : null),
      },
    };
  }

  test('returns the contact when one is found', async () => {
    const rishu = { id: 1, name: 'Rishu Goyal', phone: '919876543210' };
    const prisma = makePrisma([rishu]);
    const out = await lookupContact('+91 98765-43210', prisma);
    expect(out).toEqual(rishu);
    expect(prisma.contact.findFirst).toHaveBeenCalledTimes(1);
  });

  test('passes the right where-clause shape (OR with normalized variants)', async () => {
    const prisma = makePrisma([{ id: 1 }]);
    await lookupContact('9876543210', prisma);
    const arg = prisma.contact.findFirst.mock.calls[0][0];
    expect(arg.where.OR).toBeInstanceOf(Array);
    const phoneVariants = arg.where.OR.map((c) => c.phone);
    // Should include normalized form, +-prefixed form, raw input, and an endsWith fallback
    expect(phoneVariants).toContain('919876543210');
    expect(phoneVariants).toContain('+919876543210');
    expect(phoneVariants).toContain('9876543210');
    const endsWithEntry = arg.where.OR.find(
      (c) => c.phone && typeof c.phone === 'object' && 'endsWith' in c.phone
    );
    expect(endsWithEntry.phone.endsWith).toMatch(/\d{10}/);
  });

  test('returns null when nothing matches', async () => {
    const prisma = makePrisma([]);
    const out = await lookupContact('9999999999', prisma);
    expect(out).toBeNull();
  });

  test('propagates prisma errors as rejection', async () => {
    const prisma = {
      contact: {
        findFirst: vi.fn().mockRejectedValue(new Error('DB down')),
      },
    };
    await expect(lookupContact('9876543210', prisma)).rejects.toThrow('DB down');
  });
});
