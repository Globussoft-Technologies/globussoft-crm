// Stable per-browser device identifier for the WhatsApp device-session lock.
//
// The WhatsApp Web connection is one shared session per tenant; this id lets the
// backend tell WHICH browser/device a given CRM user is driving it from, so the
// same user can't hold the connection from two devices at once (see
// backend/lib/whatsappSessionGuard.js). It is NOT a security credential — just a
// stable random tag persisted in localStorage so it survives refreshes and
// identifies this browser across reconnects.
const KEY = 'crm_wa_device_id';

export function getDeviceId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // localStorage disabled (private mode) — fall back to a per-session id so
    // the lock still functions within this tab.
    if (!getDeviceId._mem) {
      getDeviceId._mem = `dev-mem-${Math.random().toString(36).slice(2, 12)}`;
    }
    return getDeviceId._mem;
  }
}
