// ─────────────────────────────────────────────────────────────────
// msw-server.js — outbound HTTP interceptor for the integration tier
// ─────────────────────────────────────────────────────────────────
// Sets up an msw v2 Node server that intercepts ANY HTTP call to
// api.stripe.com so a misbehaving SUT (route, helper, future code)
// can never reach the real Stripe API from a unit/integration run.
//
// Today the Stripe webhook handler in routes/payments.js does NOT
// make outbound calls after constructEvent — it just updates the
// local DB. But:
//   1. We want the safety net so future commits that add
//      `stripe.paymentIntents.retrieve(...)` or similar in the
//      handler don't silently exfiltrate to api.stripe.com from CI.
//   2. The msw infrastructure is the concrete pattern this repo
//      will reuse for Razorpay, Mailgun, web-push, OAuth callback
//      success branches (all called out in docs/E2E_GAPS.md L-2).
//
// Default behaviour: every api.stripe.com path returns 500 + a clear
// error body so a test author who needs an outbound mock has to opt
// in explicitly via `mswServer.use(...)` per-test. Surprise outbound
// calls fail loudly.
//
// Usage in a test file:
//   import { mswServer } from './_helpers/msw-server';
//   import { http, HttpResponse } from 'msw';
//
//   beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
//   afterEach(() => mswServer.resetHandlers());
//   afterAll(() => mswServer.close());
//
//   test('handler retrieves paymentIntent', () => {
//     mswServer.use(
//       http.get('https://api.stripe.com/v1/payment_intents/:id', () =>
//         HttpResponse.json({ id: 'pi_x', status: 'succeeded' })
//       )
//     );
//     // ... drive the route, assert outbound was intercepted
//   });

const { setupServer } = require('msw/node');
const { http, HttpResponse } = require('msw');

// ── default handlers ───────────────────────────────────────────────
// These fire only if a test forgets to register a handler for an
// outbound call. We deliberately return 500 (not 200) so a leak
// doesn't silently pass.
const defaultHandlers = [
  http.all('https://api.stripe.com/*', ({ request }) => {
    return HttpResponse.json(
      {
        error: {
          type: 'integration_test_unhandled',
          message: `[msw] unhandled outbound to ${request.method} ${request.url} — register a handler in your test`,
        },
      },
      { status: 500 }
    );
  }),
  http.all('https://api.razorpay.com/*', ({ request }) => {
    return HttpResponse.json(
      { error: `[msw] unhandled outbound to ${request.method} ${request.url}` },
      { status: 500 }
    );
  }),
];

const mswServer = setupServer(...defaultHandlers);

module.exports = { mswServer, http, HttpResponse };
