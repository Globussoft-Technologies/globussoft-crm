import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Module under test is imported fresh per describe so the top-level
// `beforeinstallprompt` listener registers against our mocked window.
let registerPWA, unregisterPWA, canInstall, showInstallPrompt;

async function loadFresh() {
  vi.resetModules();
  const mod = await import('../utils/pwa');
  registerPWA = mod.registerPWA;
  unregisterPWA = mod.unregisterPWA;
  canInstall = mod.canInstall;
  showInstallPrompt = mod.showInstallPrompt;
}

describe('utils/pwa — registerPWA', () => {
  beforeEach(async () => {
    await loadFresh();
  });

  afterEach(() => {
    delete navigator.serviceWorker;
  });

  it('returns false when serviceWorker is not supported', async () => {
    // jsdom may not ship serviceWorker — ensure it's absent
    expect('serviceWorker' in navigator ? typeof navigator.serviceWorker : 'absent').toBeDefined();
    // If present, temporarily hide it
    const saved = navigator.serviceWorker;
    if (saved) {
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
    }
    try {
      const ok = await registerPWA();
      expect(ok).toBe(false);
    } finally {
      if (saved) {
        Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: saved });
      }
    }
  });

  it('returns true when registration succeeds', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn().mockResolvedValue({ scope: '/' }),
        getRegistrations: vi.fn().mockResolvedValue([]),
      },
    });
    const ok = await registerPWA();
    expect(ok).toBe(true);
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/sw-pwa.js', { scope: '/' });
  });

  it('returns false when registration throws', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn().mockRejectedValue(new Error('blocked')),
        getRegistrations: vi.fn().mockResolvedValue([]),
      },
    });
    const ok = await registerPWA();
    expect(ok).toBe(false);
  });
});

describe('utils/pwa — unregisterPWA', () => {
  beforeEach(async () => {
    await loadFresh();
  });

  it('returns false when serviceWorker is not supported', async () => {
    const saved = navigator.serviceWorker;
    if (saved) {
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
    }
    try {
      expect(await unregisterPWA()).toBe(false);
    } finally {
      if (saved) {
        Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: saved });
      }
    }
  });

  it('unregisters matching PWA service workers', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistrations: vi.fn().mockResolvedValue([
          { active: { scriptURL: 'https://host/sw-pwa.js' }, unregister },
          { active: { scriptURL: 'https://host/sw.js' }, unregister: vi.fn() }, // should be skipped
          { active: null, unregister: vi.fn() },
        ]),
      },
    });
    const ok = await unregisterPWA();
    expect(ok).toBe(true);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('returns false on throw', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistrations: vi.fn().mockRejectedValue(new Error('bad')) },
    });
    expect(await unregisterPWA()).toBe(false);
  });
});

describe('utils/pwa — install prompt flow', () => {
  beforeEach(async () => {
    await loadFresh();
  });

  it('canInstall() is false by default', () => {
    expect(canInstall()).toBe(false);
  });

  it('beforeinstallprompt event stashes + canInstall() flips true', async () => {
    const event = {
      preventDefault: vi.fn(),
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    };
    window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), event));
    // The module's listener must have stashed it
    expect(canInstall()).toBe(true);
  });

  it('showInstallPrompt returns user choice when prompt is available', async () => {
    const event = Object.assign(new Event('beforeinstallprompt'), {
      preventDefault: vi.fn(),
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    });
    window.dispatchEvent(event);
    const res = await showInstallPrompt();
    expect(res.outcome).toBe('accepted');
    // Second call now returns unavailable (prompt consumed)
    const res2 = await showInstallPrompt();
    expect(res2.outcome).toBe('unavailable');
  });

  it('showInstallPrompt returns error object on failure', async () => {
    const event = Object.assign(new Event('beforeinstallprompt'), {
      preventDefault: vi.fn(),
      prompt: () => { throw new Error('user gesture required'); },
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    window.dispatchEvent(event);
    const res = await showInstallPrompt();
    expect(res.outcome).toBe('error');
    expect(res.error).toMatch(/user gesture/);
  });

  it('showInstallPrompt with no prompt available → unavailable', async () => {
    const res = await showInstallPrompt();
    expect(res.outcome).toBe('unavailable');
  });
});
