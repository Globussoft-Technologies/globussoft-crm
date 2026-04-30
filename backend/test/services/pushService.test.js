// Unit tests for backend/services/pushService.js — VAPID config, sendPush
// over a stubbed web-push library, and sendToUser fanout over a mocked
// PushSubscription table. The SUT requires `web-push` defensively in a
// try/catch and pins the loaded module to a closure variable; we therefore
// import the same module here (Node's require cache will return the same
// object) and replace its methods with vi.fn() stubs in beforeEach.
import { describe, test, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import webpush from 'web-push';
import push from '../../services/pushService.js';
const { getVapidKeys, sendPush, sendToUser } = push;

let realSetVapidDetails;
let realSendNotification;

beforeAll(() => {
  realSetVapidDetails = webpush.setVapidDetails;
  realSendNotification = webpush.sendNotification;
});

afterAll(() => {
  webpush.setVapidDetails = realSetVapidDetails;
  webpush.sendNotification = realSendNotification;
});

beforeEach(() => {
  webpush.setVapidDetails = vi.fn();
  webpush.sendNotification = vi.fn().mockResolvedValue({ statusCode: 201 });
  process.env.VAPID_PUBLIC_KEY = 'pub_key';
  process.env.VAPID_PRIVATE_KEY = 'priv_key';
});

afterEach(() => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

describe('pushService — module shape', () => {
  test('exports getVapidKeys, sendPush, sendToUser', () => {
    expect(typeof getVapidKeys).toBe('function');
    expect(typeof sendPush).toBe('function');
    expect(typeof sendToUser).toBe('function');
  });
});

describe('pushService — getVapidKeys', () => {
  test('returns env vars when set', () => {
    expect(getVapidKeys()).toEqual({ publicKey: 'pub_key', privateKey: 'priv_key' });
  });
  test('returns empty strings when env unset', () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    expect(getVapidKeys()).toEqual({ publicKey: '', privateKey: '' });
  });
});

describe('pushService — sendPush', () => {
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: { p256dh: 'p256dh_key', auth: 'auth_key' },
  };
  const payload = { title: 'New lead', body: 'A patient just booked', url: '/wellness' };

  test('returns success when web-push resolves', async () => {
    const out = await sendPush(sub, payload);
    expect(out).toEqual({ success: true });
    expect(webpush.setVapidDetails).toHaveBeenCalledWith(
      'mailto:admin@globussoft.com',
      'pub_key',
      'priv_key'
    );
    const [pushSub, body] = webpush.sendNotification.mock.calls[0];
    expect(pushSub.endpoint).toBe(sub.endpoint);
    expect(pushSub.keys).toEqual(sub.keys);
    expect(JSON.parse(body)).toEqual(payload);
  });

  test('accepts flat-shape subscription (p256dh/auth on root)', async () => {
    const flatSub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      p256dh: 'flat_p',
      auth: 'flat_a',
    };
    await sendPush(flatSub, payload);
    const [pushSub] = webpush.sendNotification.mock.calls[0];
    expect(pushSub.keys).toEqual({ p256dh: 'flat_p', auth: 'flat_a' });
  });

  test('returns error when VAPID public key missing', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const out = await sendPush(sub, payload);
    expect(out).toEqual({ success: false, error: 'VAPID keys not configured' });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  test('returns error when VAPID private key missing', async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    const out = await sendPush(sub, payload);
    expect(out).toEqual({ success: false, error: 'VAPID keys not configured' });
  });

  test('returns success:false with err.message when web-push throws', async () => {
    webpush.sendNotification.mockRejectedValue(new Error('410 Gone'));
    const out = await sendPush(sub, payload);
    expect(out).toEqual({ success: false, error: '410 Gone' });
  });
});

describe('pushService — sendToUser', () => {
  function makePrisma(subs) {
    return {
      pushSubscription: {
        findMany: vi.fn().mockResolvedValue(subs),
        update: vi.fn().mockResolvedValue({}),
      },
    };
  }

  const payload = { title: 'Hi', body: 'msg' };

  test('returns {sent:0, failed:0} when no subs', async () => {
    const prisma = makePrisma([]);
    const out = await sendToUser(42, payload, prisma);
    expect(out).toEqual({ sent: 0, failed: 0 });
    expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith({
      where: { userId: 42, isActive: true },
    });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  test('counts each successful send', async () => {
    const prisma = makePrisma([
      { id: 1, endpoint: 'a', p256dh: 'p1', auth: 'a1' },
      { id: 2, endpoint: 'b', p256dh: 'p2', auth: 'a2' },
    ]);
    const out = await sendToUser(7, payload, prisma);
    expect(out).toEqual({ sent: 2, failed: 0 });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  test('mixed sends report sent/failed totals', async () => {
    webpush.sendNotification
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ statusCode: 201 });
    const prisma = makePrisma([
      { id: 1, endpoint: 'a', p256dh: 'p', auth: 'a' },
      { id: 2, endpoint: 'b', p256dh: 'p', auth: 'a' },
      { id: 3, endpoint: 'c', p256dh: 'p', auth: 'a' },
    ]);
    const out = await sendToUser(7, payload, prisma);
    expect(out).toEqual({ sent: 2, failed: 1 });
  });

  test('410 Gone deactivates the subscription', async () => {
    webpush.sendNotification.mockRejectedValue(new Error('410 Gone'));
    const prisma = makePrisma([{ id: 17, endpoint: 'dead', p256dh: 'p', auth: 'a' }]);
    const out = await sendToUser(7, payload, prisma);
    expect(out).toEqual({ sent: 0, failed: 1 });
    expect(prisma.pushSubscription.update).toHaveBeenCalledWith({
      where: { id: 17 },
      data: { isActive: false },
    });
  });

  test('"expired" message also deactivates', async () => {
    webpush.sendNotification.mockRejectedValue(new Error('subscription expired'));
    const prisma = makePrisma([{ id: 5, endpoint: 'x', p256dh: 'p', auth: 'a' }]);
    await sendToUser(7, payload, prisma);
    expect(prisma.pushSubscription.update).toHaveBeenCalledTimes(1);
    expect(prisma.pushSubscription.update.mock.calls[0][0].data.isActive).toBe(false);
  });

  test('non-410 / non-expired errors do NOT deactivate', async () => {
    webpush.sendNotification.mockRejectedValue(new Error('500 Internal Error'));
    const prisma = makePrisma([{ id: 9, endpoint: 'flaky', p256dh: 'p', auth: 'a' }]);
    const out = await sendToUser(7, payload, prisma);
    expect(out).toEqual({ sent: 0, failed: 1 });
    expect(prisma.pushSubscription.update).not.toHaveBeenCalled();
  });

  test('passes payload through to web-push as JSON', async () => {
    const prisma = makePrisma([{ id: 1, endpoint: 'a', p256dh: 'p', auth: 'a' }]);
    await sendToUser(7, { title: 'Visit booked', body: 'tomorrow' }, prisma);
    const sentBody = webpush.sendNotification.mock.calls[0][1];
    expect(JSON.parse(sentBody)).toEqual({ title: 'Visit booked', body: 'tomorrow' });
  });

  test('VAPID-missing failure still increments failed counter (no DB deactivate)', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    const prisma = makePrisma([{ id: 1, endpoint: 'a', p256dh: 'p', auth: 'a' }]);
    const out = await sendToUser(7, payload, prisma);
    expect(out).toEqual({ sent: 0, failed: 1 });
    expect(prisma.pushSubscription.update).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});
