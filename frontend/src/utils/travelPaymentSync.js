export const TRAVEL_PAYMENT_SYNC_CHANNEL = "globus-travel-payment-status";
export const TRAVEL_PAYMENT_SYNC_EVENT = "globus:travel-payment-complete";

/**
 * Notify another portal tab that a travel payment has completed. Broadcast
 * channels work even when the payment page was opened with noopener, while
 * postMessage keeps the callback compatible with older browser flows.
 */
export function publishTravelPaymentSync(details = {}) {
  if (typeof window === "undefined") return;
  const message = {
    type: TRAVEL_PAYMENT_SYNC_EVENT,
    at: Date.now(),
    ...details,
  };

  try {
    if (typeof window.BroadcastChannel === "function") {
      const channel = new window.BroadcastChannel(TRAVEL_PAYMENT_SYNC_CHANNEL);
      channel.postMessage(message);
      channel.close();
    }
  } catch (_err) {
    // The payment is already confirmed; notification is best-effort.
  }

  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(message, window.location.origin);
    }
  } catch (_err) {
    // Cross-window access can be blocked by browser security settings.
  }
}
