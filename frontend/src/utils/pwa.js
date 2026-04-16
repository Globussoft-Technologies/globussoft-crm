// PWA service worker registration helper.
// The PWA worker is intentionally separate from /sw.js (push) and lives at /sw-pwa.js.

let deferredInstallPrompt = null;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });
}

export async function registerPWA() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw-pwa.js', { scope: '/' });
    // eslint-disable-next-line no-console
    console.log('[PWA] Registered:', reg.scope);
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[PWA] Registration failed:', e && e.message);
    return false;
  }
}

export async function unregisterPWA() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      regs
        .filter((r) => r.active && r.active.scriptURL && r.active.scriptURL.includes('/sw-pwa.js'))
        .map((r) => r.unregister())
    );
    return true;
  } catch {
    return false;
  }
}

export function canInstall() {
  return !!deferredInstallPrompt;
}

export async function showInstallPrompt() {
  if (!deferredInstallPrompt) return { outcome: 'unavailable' };
  try {
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    return choice || { outcome: 'dismissed' };
  } catch (e) {
    return { outcome: 'error', error: e && e.message };
  }
}
