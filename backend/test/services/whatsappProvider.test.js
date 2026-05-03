// Unit tests for backend/services/whatsappProvider.js — sendTemplate +
// sendText over Meta Cloud Graph API (HTTPS) and verifyWebhook over a
// minimal fake Express req. The provider HTTP helper uses Node's
// `https.request`, which we monkey-patch (the same pattern as
// smsProvider.test.js — reliable for CJS modules that `require("https")`
// at the top of the file).
import { describe, test, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import https from 'node:https';

import whatsappProvider from '../../services/whatsappProvider.js';
const { sendTemplate, sendText, verifyWebhook } = whatsappProvider;

// ---- https.request stub --------------------------------------------------
// Replace https.request with a fake that captures options + payload and
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

describe('whatsappProvider — module shape', () => {
  test('exports the public surface', () => {
    expect(typeof sendTemplate).toBe('function');
    expect(typeof sendText).toBe('function');
    expect(typeof verifyWebhook).toBe('function');
  });
});

describe('whatsappProvider — sendTemplate', () => {
  test('happy path → returns providerMsgId from Cloud API', async () => {
    respondNext(200, {
      messaging_product: 'whatsapp',
      contacts: [{ input: '919876543210', wa_id: '919876543210' }],
      messages: [{ id: 'wamid.HBgM_test_123' }],
    });
    const out = await sendTemplate({
      to: '919876543210',
      templateName: 'appointment_reminder',
      language: 'en_US',
      parameters: ['Rishu', 'Tomorrow 10am'],
      phoneNumberId: 'PNID_42',
      accessToken: 'EAA_test_token',
    });
    expect(out).toEqual({ success: true, providerMsgId: 'wamid.HBgM_test_123' });

    // Inspect the outbound HTTPS call
    const { options, payload } = httpsState.lastRequest;
    expect(options.hostname).toBe('graph.facebook.com');
    expect(options.path).toBe('/v18.0/PNID_42/messages');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.headers.Authorization).toBe('Bearer EAA_test_token');

    const body = JSON.parse(payload);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('919876543210');
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('appointment_reminder');
    expect(body.template.language).toEqual({ code: 'en_US' });
    expect(body.template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Rishu' },
          { type: 'text', text: 'Tomorrow 10am' },
        ],
      },
    ]);
  });

  test('omits components array when no parameters supplied', async () => {
    respondNext(200, { messages: [{ id: 'wamid.no_params' }] });
    const out = await sendTemplate({
      to: '919876543210',
      templateName: 'hello_world',
      language: 'en_US',
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    expect(out.success).toBe(true);
    const body = JSON.parse(httpsState.lastRequest.payload);
    expect(body.template.components).toBeUndefined();
  });

  test('omits components when parameters is empty array', async () => {
    respondNext(200, { messages: [{ id: 'wamid.empty' }] });
    await sendTemplate({
      to: '919876543210',
      templateName: 'hello_world',
      language: 'en_US',
      parameters: [],
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    const body = JSON.parse(httpsState.lastRequest.payload);
    expect(body.template.components).toBeUndefined();
  });

  test('defaults language to en_US when not provided', async () => {
    respondNext(200, { messages: [{ id: 'wamid.default_lang' }] });
    await sendTemplate({
      to: '919876543210',
      templateName: 'hello_world',
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    const body = JSON.parse(httpsState.lastRequest.payload);
    expect(body.template.language).toEqual({ code: 'en_US' });
  });

  test('coerces non-string parameters via String(...)', async () => {
    respondNext(200, { messages: [{ id: 'wamid.coerce' }] });
    await sendTemplate({
      to: '919876543210',
      templateName: 'order',
      language: 'en_US',
      parameters: [42, true, null],
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    const body = JSON.parse(httpsState.lastRequest.payload);
    expect(body.template.components[0].parameters).toEqual([
      { type: 'text', text: '42' },
      { type: 'text', text: 'true' },
      { type: 'text', text: 'null' },
    ]);
  });

  test('Cloud API error response → returns structured error, does not throw', async () => {
    respondNext(400, {
      error: {
        message: '(#132012) Parameter format does not match format in the created template',
        type: 'OAuthException',
        code: 132012,
        fbtrace_id: 'AbC123',
      },
    });
    const out = await sendTemplate({
      to: '919876543210',
      templateName: 'broken',
      language: 'en_US',
      parameters: ['x'],
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Parameter format/);
  });

  test('falls back to error_user_msg when error.message is absent', async () => {
    respondNext(403, {
      error: { error_user_msg: 'You are not allowed to send to this number' },
    });
    const out = await sendTemplate({
      to: '919876543210',
      templateName: 'x',
      language: 'en_US',
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    expect(out.success).toBe(false);
    expect(out.error).toBe('You are not allowed to send to this number');
  });

  test('serializes parsed body when no error.message and no error_user_msg', async () => {
    respondNext(400, { foo: 'bar', n: 1 });
    const out = await sendTemplate({
      to: '919876543210',
      templateName: 'x',
      language: 'en_US',
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    expect(out.success).toBe(false);
    expect(out.error).toContain('"foo":"bar"');
  });

  test('2xx but no messages array → counts as failure', async () => {
    respondNext(200, { messaging_product: 'whatsapp' });
    const out = await sendTemplate({
      to: '919876543210',
      templateName: 'x',
      language: 'en_US',
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    expect(out.success).toBe(false);
  });

  test('2xx with empty messages array → counts as failure', async () => {
    respondNext(200, { messages: [] });
    const out = await sendTemplate({
      to: '919876543210',
      templateName: 'x',
      language: 'en_US',
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    expect(out.success).toBe(false);
  });

  test('unparseable body → returns body string as error', async () => {
    respondNext(502, '<html>Bad Gateway</html>');
    const out = await sendTemplate({
      to: '919876543210',
      templateName: 'x',
      language: 'en_US',
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Bad Gateway/);
  });

  test('empty body + non-2xx → falls back to "HTTP <status>"', async () => {
    respondNext(503, '');
    const out = await sendTemplate({
      to: '919876543210',
      templateName: 'x',
      language: 'en_US',
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/HTTP 503/);
  });

  test('network error → resolves with success:false + error message', async () => {
    failNext(new Error('ECONNRESET'));
    const out = await sendTemplate({
      to: '919876543210',
      templateName: 'x',
      language: 'en_US',
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    expect(out).toEqual({ success: false, error: 'ECONNRESET' });
  });

  test('Content-Length header reflects payload byte length', async () => {
    respondNext(200, { messages: [{ id: 'wamid.cl' }] });
    await sendTemplate({
      to: '919876543210',
      templateName: 'x',
      language: 'en_US',
      parameters: ['café'], // multi-byte char
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    const { options, payload } = httpsState.lastRequest;
    expect(options.headers['Content-Length']).toBe(Buffer.byteLength(payload));
  });
});

describe('whatsappProvider — sendText (free-form session message)', () => {
  test('happy path → returns providerMsgId, request body uses type=text', async () => {
    respondNext(200, { messages: [{ id: 'wamid.text_1' }] });
    const out = await sendText({
      to: '919876543210',
      body: 'Hi Rishu, your visit is confirmed.',
      phoneNumberId: 'PNID_T',
      accessToken: 'TOK_T',
    });
    expect(out).toEqual({ success: true, providerMsgId: 'wamid.text_1' });

    const { options, payload } = httpsState.lastRequest;
    expect(options.hostname).toBe('graph.facebook.com');
    expect(options.path).toBe('/v18.0/PNID_T/messages');
    expect(options.headers.Authorization).toBe('Bearer TOK_T');

    const body = JSON.parse(payload);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('919876543210');
    expect(body.type).toBe('text');
    expect(body.text).toEqual({ body: 'Hi Rishu, your visit is confirmed.' });
    // free-form must NOT have a `template` field
    expect(body.template).toBeUndefined();
  });

  test('error response → structured error, does not throw', async () => {
    respondNext(400, { error: { message: 'Recipient is not in allowed list' } });
    const out = await sendText({
      to: '919876543210',
      body: 'hi',
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Recipient is not in allowed list/);
  });

  test('network error → caught and surfaced', async () => {
    failNext(new Error('ETIMEDOUT'));
    const out = await sendText({
      to: '919876543210',
      body: 'hi',
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    expect(out).toEqual({ success: false, error: 'ETIMEDOUT' });
  });

  test('does not mutate the body string (sent as-is)', async () => {
    respondNext(200, { messages: [{ id: 'wamid.x' }] });
    const original = '  Spaces  preserved  ';
    await sendText({
      to: '919876543210',
      body: original,
      phoneNumberId: 'PNID',
      accessToken: 'TOK',
    });
    const body = JSON.parse(httpsState.lastRequest.payload);
    expect(body.text.body).toBe(original);
  });
});

describe('whatsappProvider — verifyWebhook', () => {
  test('returns verified:true + challenge when mode=subscribe and token matches', () => {
    const req = {
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'my_secret_token',
        'hub.challenge': 'CHAL_42',
      },
    };
    expect(verifyWebhook(req, 'my_secret_token')).toEqual({
      verified: true,
      challenge: 'CHAL_42',
    });
  });

  test('returns verified:false when token mismatches', () => {
    const req = {
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong',
        'hub.challenge': 'CHAL_42',
      },
    };
    expect(verifyWebhook(req, 'my_secret_token')).toEqual({ verified: false });
  });

  test('returns verified:false when mode is not "subscribe"', () => {
    const req = {
      query: {
        'hub.mode': 'unsubscribe',
        'hub.verify_token': 'my_secret_token',
        'hub.challenge': 'CHAL_42',
      },
    };
    expect(verifyWebhook(req, 'my_secret_token')).toEqual({ verified: false });
  });

  test('returns verified:false when query params absent', () => {
    expect(verifyWebhook({ query: {} }, 'my_secret_token')).toEqual({
      verified: false,
    });
  });
});
