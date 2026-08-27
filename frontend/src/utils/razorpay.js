// Razorpay Checkout SDK loader.
//
// The SDK is fetched on demand rather than bundled, so a visitor who never
// pays never downloads it. Repeat calls resolve immediately once the global is
// present, and concurrent calls share one in-flight script rather than
// appending a second <script> tag.

let pending = null;

export function loadRazorpaySdk() {
  if (typeof window !== 'undefined' && window.Razorpay) return Promise.resolve();
  if (pending) return pending;

  pending = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => {
      // Let a later attempt retry — a failed load is usually a dropped
      // connection, not a permanent condition.
      pending = null;
      reject(new Error('Could not load Razorpay SDK'));
    };
    document.body.appendChild(script);
  });
  return pending;
}
