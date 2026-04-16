const Sentry = require('@sentry/node');

// Sentry initialization wrapper.
// If SENTRY_DSN is not set, this is a no-op so local/dev environments stay quiet.

function initSentry(app) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.warn('[Sentry] SENTRY_DSN not set — error monitoring disabled');
    return null;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
    ],
  });

  console.log('[Sentry] Error monitoring initialized');
  return Sentry;
}

function captureException(err, context) {
  if (process.env.SENTRY_DSN) {
    require('@sentry/node').captureException(err, { extra: context });
  }
}

module.exports = { initSentry, captureException };
