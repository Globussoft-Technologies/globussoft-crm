// Unit tests for backend/services/smsProvider.js — pure-input dispatch +
// resolveProviderConfig over a mocked SmsConfig table. The provider HTTP
// helpers use Node's `https.request`, which we monkey-patch (vi.spyOn)
// rather than mocking the built-in module — that's the reliable path
// when the SUT is CJS and uses `require("https")`.
import { describe, test, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import https from 'node:https';

import smsProvider from '../../services/smsProvider.js';
const { normalizePhone, substituteVars, sendSms, sendViaFast2SMS, resolveProviderConfig } =
  smsProvider;

// ---- https.request stub --------------------------------------------------
// We replace https.request with a fake that captures options + payload and
// resolves with a scripted response. Each test sets `httpsState.nextResponse`.
const httpsState = {
  lastRequest: null,
  nextResponse: null, // { statusCode, body } | { error: Error }
};

function makeFakeReq() {
  const req = new EventEmitter();
  req.write = vi.fn();
  req.end = vi.fn();
  return req;
}

function makeFakeRes(statusCode, body) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  setImmediate(() => {
    res.emit('data', Buffer.from(body));
    res.emit('end');
  });
  return res;
}

let realRequest;

beforeAll(() => {
  realRequest = https.request;
  https.request = (options, callback) => {
    httpsState.lastRequest = { options, payload: '' };
    const req = makeFakeReq();
    const origWrite = req.write;
    req.write = (chunk) => {
      httpsState.lastRequest.payload += chunk.toString();
      return origWrite(chunk);
    };
    setImmediate(() => {
      if (httpsState.nextResponse?.error) {
        req.emit('error', httpsState.nextResponse.error);
        return;
      }
      const { statusCode = 200, body = '{}' } = httpsState.nextResponse || {};
      callback(makeFakeRes(statusCode, body));
    });
    return req;
  };
});

afterAll(() => {
  https.request = realRequest;
});

function respondNext(statusCode, body) {
  httpsState.nextResponse = {
    statusCode,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}
function failNext(err) {
  httpsState.nextResponse = { error: err };
}

beforeEach(() => {
  httpsState.lastRequest = null;
  httpsState.nextResponse = null;
});

afterEach(() => {
  delete process.env.MSG91_AUTH_KEY;
  delete process.env.MSG91_SENDER_ID;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM;
  delete process.env.FAST2SMS_API_KEY;
  delete process.env.FAST2SMS_SENDER_ID;
});

describe('smsProvider — module shape', () => {
  test('exports the public surface', () => {
    expect(typeof normalizePhone).toBe('function');
    expect(typeof substituteVars).toBe('function');
    expect(typeof sendSms).toBe('function');
    expect(typeof sendViaFast2SMS).toBe('function');
    expect(typeof resolveProviderConfig).toBe('function');
  });
});

describe('smsProvider — normalizePhone', () => {
  test('returns "" on null/undefined/empty', () => {
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
    expect(normalizePhone('')).toBe('');
  });
  test('strips +, spaces, parens, dashes', () => {
    expect(normalizePhone('+91 (987) 654-3210')).toBe('919876543210');
  });
  test('prepends 91 to a 10-digit number', () => {
    expect(normalizePhone('9876543210')).toBe('919876543210');
  });
  test('leaves 12-digit number alone', () => {
    expect(normalizePhone('919876543210')).toBe('919876543210');
  });
  test('handles numeric input via toString', () => {
    expect(normalizePhone(9876543210)).toBe('919876543210');
  });
  test('strips letters', () => {
    expect(normalizePhone('call 9876543210')).toBe('919876543210');
  });
});

describe('smsProvider — substituteVars', () => {
  test('returns "" on empty template', () => {
    expect(substituteVars('', { name: 'X' })).toBe('');
    expect(substituteVars(null, { name: 'X' })).toBe('');
  });
  test('returns template untouched when no contact', () => {
    expect(substituteVars('Hi {{name}}', null)).toBe('Hi {{name}}');
  });
  test('substitutes name', () => {
    expect(substituteVars('Hi {{name}}', { name: 'Rishu' })).toBe('Hi Rishu');
  });
  test('falls back to firstName when name missing', () => {
    expect(substituteVars('Hi {{name}}', { firstName: 'Rishu' })).toBe('Hi Rishu');
  });
  test('substitutes company, email, phone', () => {
    const out = substituteVars(
      '{{name}}@{{company}} <{{email}}> {{phone}}',
      { name: 'A', company: 'Acme', email: 'a@b.co', phone: '999' }
    );
    expect(out).toBe('A@Acme <a@b.co> 999');
  });
  test('replaces all occurrences globally', () => {
    expect(substituteVars('{{name}} and {{name}}', { name: 'X' })).toBe('X and X');
  });
  test('blanks out missing fields rather than leaving placeholder', () => {
    expect(substituteVars('Hi {{name}}', {})).toBe('Hi ');
  });
});

describe('smsProvider — sendSms dispatch', () => {
  test('rejects unknown provider', async () => {
    const out = await sendSms({ to: '9876543210', body: 'hi', provider: 'mailgun' });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Unsupported SMS provider/);
  });

  test('msg91 happy path → returns success + providerMsgId', async () => {
    respondNext(200, { type: 'success', request_id: 'mid_1' });
    const out = await sendSms({
      to: '9876543210',
      body: 'hello',
      provider: 'msg91',
      apiKey: 'KEY',
      senderId: 'GLOBSF',
    });
    expect(out).toEqual({ success: true, providerMsgId: 'mid_1' });
    expect(httpsState.lastRequest.options.hostname).toBe('api.msg91.com');
    expect(httpsState.lastRequest.options.headers.authkey).toBe('KEY');
    const payload = JSON.parse(httpsState.lastRequest.payload);
    expect(payload.sender).toBe('GLOBSF');
    expect(payload.sms[0].to).toEqual(['919876543210']); // normalized
  });

  test('msg91 returns success on 2xx even without "type" field', async () => {
    respondNext(200, { msg: 'ok' });
    const out = await sendSms({
      to: '9876543210',
      body: 'x',
      provider: 'msg91',
      apiKey: 'K',
      senderId: 'S',
    });
    expect(out.success).toBe(true);
  });

  test('msg91 failure → returns error from response.message', async () => {
    respondNext(400, { type: 'error', message: 'bad authkey' });
    const out = await sendSms({
      to: '9876543210',
      body: 'x',
      provider: 'msg91',
      apiKey: 'BAD',
      senderId: 'S',
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/bad authkey/);
  });

  test('msg91 unparseable body + 5xx → returns error', async () => {
    respondNext(500, '<html>nginx 502</html>');
    const out = await sendSms({
      to: '9876543210',
      body: 'x',
      provider: 'msg91',
      apiKey: 'K',
      senderId: 'S',
    });
    expect(out.success).toBe(false);
  });

  test('msg91 network error → resolves with error', async () => {
    failNext(new Error('ECONNRESET'));
    const out = await sendSms({
      to: '9876543210',
      body: 'x',
      provider: 'msg91',
      apiKey: 'K',
      senderId: 'S',
    });
    expect(out).toEqual({ success: false, error: 'ECONNRESET' });
  });

  test('twilio happy path → returns sid as providerMsgId', async () => {
    respondNext(201, { sid: 'SM123', status: 'queued' });
    const out = await sendSms({
      to: '9876543210',
      body: 'hi',
      provider: 'twilio',
      apiKey: 'AC_test',
      authToken: 'tok',
      senderId: '+15551234',
    });
    expect(out).toEqual({ success: true, providerMsgId: 'SM123' });
    expect(httpsState.lastRequest.options.hostname).toBe('api.twilio.com');
    expect(httpsState.lastRequest.options.path).toBe(
      '/2010-04-01/Accounts/AC_test/Messages.json'
    );
    const expected = 'Basic ' + Buffer.from('AC_test:tok').toString('base64');
    expect(httpsState.lastRequest.options.headers.Authorization).toBe(expected);
  });

  test('twilio prefixes a + on numbers without one', async () => {
    respondNext(201, { sid: 'SM1' });
    await sendSms({
      to: '9876543210',
      body: 'x',
      provider: 'twilio',
      apiKey: 'AC',
      authToken: 't',
      senderId: '15551234',
    });
    const decoded = new URLSearchParams(httpsState.lastRequest.payload);
    expect(decoded.get('To')).toBe('+919876543210');
    expect(decoded.get('From')).toBe('+15551234');
    expect(decoded.get('Body')).toBe('x');
  });

  test('twilio passes through numbers that already have +', async () => {
    respondNext(201, { sid: 'SM1' });
    await sendSms({
      to: '+919876543210',
      body: 'x',
      provider: 'twilio',
      apiKey: 'AC',
      authToken: 't',
      senderId: '+15551234',
    });
    const decoded = new URLSearchParams(httpsState.lastRequest.payload);
    expect(decoded.get('To')).toBe('+919876543210');
    expect(decoded.get('From')).toBe('+15551234');
  });

  test('twilio failure body → surfaces .message field', async () => {
    respondNext(400, { code: 21211, message: "Invalid 'To' Phone Number" });
    const out = await sendSms({
      to: '9876543210',
      body: 'x',
      provider: 'twilio',
      apiKey: 'AC',
      authToken: 't',
      senderId: '+1',
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Invalid/);
  });

  test('twilio 200 without sid → counts as failure', async () => {
    respondNext(200, { weird: true });
    const out = await sendSms({
      to: '9876543210',
      body: 'x',
      provider: 'twilio',
      apiKey: 'AC',
      authToken: 't',
      senderId: '+1',
    });
    expect(out.success).toBe(false);
  });

  test('twilio unparseable body → returns HTTP-level error', async () => {
    respondNext(503, 'Service Unavailable');
    const out = await sendSms({
      to: '9876543210',
      body: 'x',
      provider: 'twilio',
      apiKey: 'AC',
      authToken: 't',
      senderId: '+1',
    });
    expect(out.success).toBe(false);
  });

  test('twilio network error', async () => {
    failNext(new Error('ETIMEDOUT'));
    const out = await sendSms({
      to: '9876543210',
      body: 'x',
      provider: 'twilio',
      apiKey: 'AC',
      authToken: 't',
      senderId: '+1',
    });
    expect(out).toEqual({ success: false, error: 'ETIMEDOUT' });
  });

  test('fast2sms happy path → success + stringified request_id', async () => {
    respondNext(200, { return: true, request_id: 12345, message: ['Sent'] });
    const out = await sendSms({
      to: '9876543210',
      body: 'hi',
      provider: 'fast2sms',
      apiKey: 'F2S',
      senderId: 'FSTSMS',
    });
    expect(out).toEqual({ success: true, providerMsgId: '12345' });
    expect(httpsState.lastRequest.options.hostname).toBe('www.fast2sms.com');
    expect(httpsState.lastRequest.options.headers.authorization).toBe('F2S');
    const payload = JSON.parse(httpsState.lastRequest.payload);
    expect(payload.numbers).toBe('9876543210'); // 10-digit, no 91
    expect(payload.route).toBe('q'); // no DLT
  });

  test('fast2sms with dltTemplateId switches route to "dlt"', async () => {
    respondNext(200, { return: true, request_id: 'r1' });
    await sendSms({
      to: '9876543210',
      body: 'hi',
      provider: 'fast2sms',
      apiKey: 'F2S',
      senderId: 'GBSCRM',
      dltTemplateId: 'TPL_42',
    });
    const payload = JSON.parse(httpsState.lastRequest.payload);
    expect(payload.route).toBe('dlt');
    expect(payload.template_id).toBe('TPL_42');
  });

  test('fast2sms rejects when normalized number is not 10 digits', async () => {
    const out = await sendViaFast2SMS({
      to: '12345',
      body: 'x',
      apiKey: 'F2S',
      senderId: 'FSTSMS',
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/10-digit/);
  });

  test('fast2sms strips leading 91 country code', async () => {
    respondNext(200, { return: true, request_id: 'r' });
    await sendViaFast2SMS({
      to: '919876543210',
      body: 'x',
      apiKey: 'F2S',
      senderId: 'X',
    });
    const payload = JSON.parse(httpsState.lastRequest.payload);
    expect(payload.numbers).toBe('9876543210');
  });

  test('fast2sms server returns return:false → maps message array to error', async () => {
    respondNext(400, { return: false, status_code: 412, message: ['Invalid Authentication', 'check API key'] });
    const out = await sendSms({
      to: '9876543210',
      body: 'x',
      provider: 'fast2sms',
      apiKey: 'BAD',
      senderId: 'X',
    });
    expect(out.success).toBe(false);
    expect(out.error).toBe('Invalid Authentication; check API key');
  });

  test('fast2sms unparseable body → HTTP error', async () => {
    respondNext(500, 'oops');
    const out = await sendSms({
      to: '9876543210',
      body: 'x',
      provider: 'fast2sms',
      apiKey: 'F',
      senderId: 'X',
    });
    expect(out.success).toBe(false);
  });

  test('fast2sms defaults sender_id to FSTSMS when not given', async () => {
    respondNext(200, { return: true, request_id: 'r' });
    await sendViaFast2SMS({
      to: '9876543210',
      body: 'x',
      apiKey: 'F',
      senderId: '',
    });
    const payload = JSON.parse(httpsState.lastRequest.payload);
    expect(payload.sender_id).toBe('FSTSMS');
  });
});

describe('smsProvider — resolveProviderConfig', () => {
  test('returns config from DB row when active row exists', async () => {
    const fakePrisma = {
      smsConfig: {
        findFirst: vi.fn().mockResolvedValue({
          provider: 'msg91',
          apiKey: 'db_key',
          senderId: 'DBID',
          authToken: '',
        }),
      },
    };
    const cfg = await resolveProviderConfig(fakePrisma, 7);
    expect(cfg).toEqual({
      provider: 'msg91',
      apiKey: 'db_key',
      senderId: 'DBID',
      authToken: '',
      source: 'db',
    });
    expect(fakePrisma.smsConfig.findFirst).toHaveBeenCalledWith({
      where: { isActive: true, tenantId: 7 },
    });
  });

  test('falls through to MSG91 env vars when DB row missing', async () => {
    const fakePrisma = {
      smsConfig: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    process.env.MSG91_AUTH_KEY = 'env_key';
    process.env.MSG91_SENDER_ID = 'ENVID';
    const cfg = await resolveProviderConfig(fakePrisma, 1);
    expect(cfg).toEqual({
      provider: 'msg91',
      apiKey: 'env_key',
      senderId: 'ENVID',
      source: 'env',
    });
  });

  test('falls through to Twilio env vars when MSG91 missing', async () => {
    const fakePrisma = {
      smsConfig: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    process.env.TWILIO_ACCOUNT_SID = 'AC_x';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_FROM = '+1555';
    const cfg = await resolveProviderConfig(fakePrisma, 1);
    expect(cfg).toEqual({
      provider: 'twilio',
      apiKey: 'AC_x',
      authToken: 'tok',
      senderId: '+1555',
      source: 'env',
    });
  });

  test('falls through to Fast2SMS env var when others missing', async () => {
    const fakePrisma = {
      smsConfig: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    process.env.FAST2SMS_API_KEY = 'F2S_KEY';
    const cfg = await resolveProviderConfig(fakePrisma, 1);
    expect(cfg).toEqual({
      provider: 'fast2sms',
      apiKey: 'F2S_KEY',
      senderId: 'FSTSMS',
      source: 'env',
    });
  });

  test('Fast2SMS env path honours FAST2SMS_SENDER_ID override', async () => {
    const fakePrisma = {
      smsConfig: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    process.env.FAST2SMS_API_KEY = 'F2S_KEY';
    process.env.FAST2SMS_SENDER_ID = 'GBSCRM';
    const cfg = await resolveProviderConfig(fakePrisma, 1);
    expect(cfg.senderId).toBe('GBSCRM');
  });

  test('returns null when nothing configured', async () => {
    const fakePrisma = {
      smsConfig: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const cfg = await resolveProviderConfig(fakePrisma, 1);
    expect(cfg).toBeNull();
  });

  test('DB row with empty apiKey is treated as no-config and falls through', async () => {
    const fakePrisma = {
      smsConfig: { findFirst: vi.fn().mockResolvedValue({ provider: 'msg91', apiKey: '' }) },
    };
    process.env.FAST2SMS_API_KEY = 'F';
    const cfg = await resolveProviderConfig(fakePrisma, 1);
    expect(cfg.source).toBe('env');
  });

  test('Prisma throw → falls through to env-var resolution', async () => {
    const fakePrisma = {
      smsConfig: { findFirst: vi.fn().mockRejectedValue(new Error('DB unreachable')) },
    };
    process.env.MSG91_AUTH_KEY = 'env';
    process.env.MSG91_SENDER_ID = 'ENVID';
    const cfg = await resolveProviderConfig(fakePrisma, 1);
    expect(cfg.source).toBe('env');
    expect(cfg.provider).toBe('msg91');
  });

  test('priority: MSG91 wins over Twilio when both env vars set', async () => {
    const fakePrisma = {
      smsConfig: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    process.env.MSG91_AUTH_KEY = 'env';
    process.env.MSG91_SENDER_ID = 'ENVID';
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 't';
    process.env.TWILIO_FROM = '+1';
    const cfg = await resolveProviderConfig(fakePrisma, 1);
    expect(cfg.provider).toBe('msg91');
  });
});
