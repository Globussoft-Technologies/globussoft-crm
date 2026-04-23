import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupPush, unsubscribePush } from '../utils/pushSetup';

function makeSubscription() {
  return {
    toJSON: () => ({
      endpoint: 'https://push.example.test/endpoint-xyz',
      keys: { p256dh: 'pubkey', auth: 'authkey' },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

function makeRegistration({ existingSub = null } = {}) {
  return {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(existingSub),
      subscribe: vi.fn().mockResolvedValue(makeSubscription()),
    },
  };
}

function mockGoodServiceWorker(registration) {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
      getRegistration: vi.fn().mockResolvedValue(registration),
    },
  });
  Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
}

function mockNotificationGranted() {
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: Object.assign(
      function Notification() {},
      { permission: 'granted', requestPermission: vi.fn().mockResolvedValue('granted') },
    ),
  });
}

function mockNotificationDenied() {
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: Object.assign(
      function Notification() {},
      { permission: 'denied', requestPermission: vi.fn().mockResolvedValue('denied') },
    ),
  });
}

function mockNotificationDefault(granted = true) {
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: Object.assign(
      function Notification() {},
      {
        permission: 'default',
        requestPermission: vi.fn().mockResolvedValue(granted ? 'granted' : 'denied'),
      },
    ),
  });
}

describe('utils/pushSetup — setupPush', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete navigator.serviceWorker;
    delete window.PushManager;
    delete window.Notification;
  });

  it('returns false when serviceWorker / PushManager unsupported', async () => {
    // Ensure both are absent
    delete navigator.serviceWorker;
    delete window.PushManager;
    const ok = await setupPush('token');
    expect(ok).toBe(false);
  });

  it('returns false when no token is provided', async () => {
    mockGoodServiceWorker(makeRegistration());
    mockNotificationGranted();
    expect(await setupPush('')).toBe(false);
    expect(await setupPush(null)).toBe(false);
  });

  it('returns false when Notification.permission is denied', async () => {
    mockGoodServiceWorker(makeRegistration());
    mockNotificationDenied();
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: () => Promise.resolve({ publicKey: 'abc' }) });
    expect(await setupPush('token')).toBe(false);
  });

  it('returns false when VAPID key fetch fails', async () => {
    mockGoodServiceWorker(makeRegistration());
    mockNotificationGranted();
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 });
    expect(await setupPush('token')).toBe(false);
  });

  it('returns false when VAPID key is missing from response', async () => {
    mockGoodServiceWorker(makeRegistration());
    mockNotificationGranted();
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    expect(await setupPush('token')).toBe(false);
  });

  it('happy path: registers SW, subscribes, posts to /api/push/subscribe, returns true', async () => {
    const reg = makeRegistration();
    mockGoodServiceWorker(reg);
    mockNotificationGranted();
    const fetchSpy = vi.spyOn(global, 'fetch')
      // 1st call — VAPID key
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ publicKey: 'YWJjZA' /* base64 'abcd' */ }) })
      // 2nd call — subscribe POST
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    const ok = await setupPush('jwt-token');
    expect(ok).toBe(true);

    // Called /api/push/vapid-key first, then /api/push/subscribe with auth header
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/push/vapid-key');
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/push/subscribe');
    const [, opts] = fetchSpy.mock.calls[1];
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer jwt-token');

    const sent = JSON.parse(opts.body);
    expect(sent.endpoint).toMatch(/endpoint-xyz/);
    expect(sent.p256dh).toBe('pubkey');
    expect(sent.auth).toBe('authkey');
  });

  it('reuses existing subscription if present (no re-subscribe)', async () => {
    const existing = makeSubscription();
    const reg = makeRegistration({ existingSub: existing });
    mockGoodServiceWorker(reg);
    mockNotificationGranted();
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ publicKey: 'YWJjZA' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    await setupPush('jwt-token');
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('returns false when subscribe POST to backend fails', async () => {
    mockGoodServiceWorker(makeRegistration());
    mockNotificationGranted();
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ publicKey: 'YWJjZA' }) })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    expect(await setupPush('jwt-token')).toBe(false);
  });

  it('requests permission when permission is default', async () => {
    mockGoodServiceWorker(makeRegistration());
    mockNotificationDefault(true);
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ publicKey: 'YWJjZA' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    const ok = await setupPush('jwt-token');
    expect(ok).toBe(true);
    expect(window.Notification.requestPermission).toHaveBeenCalled();
  });
});

describe('utils/pushSetup — unsubscribePush', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete navigator.serviceWorker;
  });

  it('returns false when serviceWorker is unsupported', async () => {
    delete navigator.serviceWorker;
    expect(await unsubscribePush()).toBe(false);
  });

  it('returns false when no registration exists', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue(null) },
    });
    expect(await unsubscribePush()).toBe(false);
  });

  it('unsubscribes when a subscription exists', async () => {
    const sub = makeSubscription();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: vi.fn().mockResolvedValue(sub) },
        }),
      },
    });
    expect(await unsubscribePush()).toBe(true);
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it('returns true even when no active subscription (idempotent)', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: vi.fn().mockResolvedValue(null) },
        }),
      },
    });
    expect(await unsubscribePush()).toBe(true);
  });

  it('returns false when an error is thrown', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockRejectedValue(new Error('bad')) },
    });
    expect(await unsubscribePush()).toBe(false);
  });
});
