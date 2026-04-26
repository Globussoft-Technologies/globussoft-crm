// Push notification setup helper for authenticated CRM users.
// Registers the service worker, requests permission, fetches VAPID key,
// subscribes via PushManager, and posts subscription to backend.

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Set up web push notifications for an authenticated CRM user.
 * @param {string} token - JWT token for the logged-in user.
 * @returns {Promise<boolean>} true on success, false on failure / unsupported.
 */
export async function setupPush(token) {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.warn('[push] Service workers or Push API not supported in this browser');
      return false;
    }

    if (!token) {
      console.warn('[push] No auth token provided to setupPush');
      return false;
    }

    // Register the service worker (served from /sw.js)
    const registration = await navigator.serviceWorker.register('/sw.js');
    // Wait for the SW to be ready before subscribing
    await navigator.serviceWorker.ready;

    // Request permission (will no-op if already granted)
    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      console.warn('[push] Notification permission not granted:', permission);
      return false;
    }

    // Fetch VAPID public key
    const vapidRes = await fetch('/api/push/vapid-key');
    if (!vapidRes.ok) {
      console.warn('[push] Failed to fetch VAPID key:', vapidRes.status);
      return false;
    }
    const { publicKey } = await vapidRes.json();
    if (!publicKey) {
      console.warn('[push] VAPID public key missing from server response');
      return false;
    }

    // Reuse existing subscription if present, else create one
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    const sub = subscription.toJSON();
    const payload = {
      endpoint: sub.endpoint,
      p256dh: sub.keys && sub.keys.p256dh,
      auth: sub.keys && sub.keys.auth,
    };

    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.warn('[push] Failed to register subscription on server:', res.status);
      return false;
    }

    return true;
  } catch (err) {
    // #206: AbortError ("Registration failed - push service error") is expected
    // on tenants where push isn't configured (no FCM project, browser blocks
    // push, etc.). Demote to debug to avoid noisy console warnings on every
    // navigation. Other unexpected errors still surface via console.warn.
    const name = err && err.name;
    const msg = (err && err.message) || '';
    if (name === 'AbortError' || /Registration failed/i.test(msg)) {
      console.debug('[push] setupPush skipped:', name || msg);
      return false;
    }
    console.warn('[push] setupPush error:', err);
    return false;
  }
}

/**
 * Unsubscribe and clean up the push subscription.
 * @returns {Promise<boolean>}
 */
export async function unsubscribePush() {
  try {
    if (!('serviceWorker' in navigator)) return false;
    const registration = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!registration) return false;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
    }
    return true;
  } catch (err) {
    console.error('[push] unsubscribePush error:', err);
    return false;
  }
}

export default setupPush;
