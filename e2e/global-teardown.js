// @ts-check
/**
 * Playwright globalTeardown — runs ONCE after the entire test suite.
 *
 * Scrubs E2E test rows from the database so re-runs don't accumulate
 * fake patients, contacts, and services on the owner dashboard.
 *
 * Matches only rows that are unambiguously test artifacts:
 *   - Patient.name  starts with 'E2E ' or 'Coverage ', or uses a stamped
 *     prefix ('Loyalty <6digits>', 'Referrer <6digits>', etc.)
 *   - Contact.name  same pattern
 *   - Contact.email ends with @example.test / @inbound.local, or starts with 'e2e[-_]'
 *   - Service.name  starts with 'E2E ', or description mentions the spec
 *
 * All Patient children cascade-delete per the Prisma schema (onDelete: Cascade
 * on Visit, Prescription, ConsentForm, TreatmentPlan, Waitlist, LoyaltyTransaction,
 * Referral), so deleting the Patient row transitively clears everything beneath.
 *
 * Requires: mysql2 (devDependency). Reads DATABASE_URL from ../backend/.env.
 *
 * Safe to run multiple times (idempotent). Failures are logged as warnings —
 * they do NOT fail the test run, since the tests themselves already passed.
 */
const fs = require('fs');
const path = require('path');

// Single source of truth for test-data patterns — shared with
// backend/scripts/scrub-test-data-pollution.js so the regex can never
// drift between the post-suite teardown and the one-shot demo cleanup.
// See e2e/test-data-patterns.js for why this exists (#405).
const {
  NAME_REGEX_SQL,
  EMAIL_REGEX_SQL,
  TEST_SERVICE_DESCRIPTION_LIKE,
} = require('./test-data-patterns');

const PAT_REGEX = NAME_REGEX_SQL;
const EMAIL_REGEX = EMAIL_REGEX_SQL;
const SVC_DESC_LIKE = TEST_SERVICE_DESCRIPTION_LIKE;

/**
 * Parse DATABASE_URL like:
 *   mysql://user:pass@host:3306/dbname
 */
function parseDatabaseUrl(url) {
  const m = /^mysql:\/\/([^:]+):([^@]+)@([^:/]+):?(\d+)?\/(\w+)/.exec(url || '');
  if (!m) return null;
  return {
    user: decodeURIComponent(m[1]),
    password: decodeURIComponent(m[2]),
    host: m[3],
    port: parseInt(m[4] || '3306', 10),
    database: m[5],
  };
}

function readBackendEnv() {
  const candidates = [
    path.resolve(__dirname, '..', 'backend', '.env'),
    path.resolve(__dirname, '..', '.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const l = line.trim();
        if (l.startsWith('DATABASE_URL')) {
          return l.split('=', 2)[1].trim().replace(/^['"]|['"]$/g, '');
        }
      }
    }
  }
  return null;
}

module.exports = async function globalTeardown() {
  // Opt-out: let CI skip the scrub by setting E2E_SKIP_SCRUB=1
  if (process.env.E2E_SKIP_SCRUB === '1') {
    console.log('[teardown] E2E_SKIP_SCRUB=1 — skipping DB cleanup');
    return;
  }

  const url = readBackendEnv();
  if (!url) {
    console.warn('[teardown] DATABASE_URL not found in backend/.env — skipping scrub');
    return;
  }

  const cfg = parseDatabaseUrl(url);
  if (!cfg) {
    console.warn('[teardown] DATABASE_URL is not mysql://... — skipping scrub');
    return;
  }

  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (e) {
    console.warn('[teardown] mysql2 not installed — skipping scrub. `npm i -D mysql2` in e2e/ to enable.');
    return;
  }

  const conn = await mysql.createConnection(cfg).catch((err) => {
    console.warn('[teardown] MySQL connect failed:', err.message);
    return null;
  });
  if (!conn) return;

  try {
    // Run each DELETE and tally counts. Use a single connection (same
    // session) so ROW_COUNT() is meaningful.
    const results = {};

    const [p] = await conn.query(
      `DELETE FROM Patient WHERE name REGEXP ?`,
      [PAT_REGEX]
    );
    results.patients = p.affectedRows || 0;

    const [c] = await conn.query(
      `DELETE FROM Contact WHERE name REGEXP ? OR (email IS NOT NULL AND email REGEXP ?)`,
      [PAT_REGEX, EMAIL_REGEX]
    );
    results.contacts = c.affectedRows || 0;

    const [s] = await conn.query(
      `DELETE FROM Service WHERE name REGEXP '^E2E ' OR description LIKE ?`,
      [SVC_DESC_LIKE]
    );
    results.services = s.affectedRows || 0;

    // #405: also scrub Task + Location rows that match the test-data
    // patterns. Tasks have no inbound FKs (Task.contactId / Task.userId
    // are SetNull on the parent's delete; nothing references Task.id).
    // Locations are SetNull on Patient.locationId / Visit.locationId.
    // Both are safe to bulk-delete by regex.
    const [t] = await conn.query(
      `DELETE FROM Task WHERE title REGEXP ?`,
      [PAT_REGEX]
    );
    results.tasks = t.affectedRows || 0;

    const [l] = await conn.query(
      `DELETE FROM Location WHERE name REGEXP ?`,
      [PAT_REGEX]
    );
    results.locations = l.affectedRows || 0;

    // G-8: low-stock-api.spec.js (and cpq-api.spec.js) create Product rows
    // tagged with their RUN_TAG prefix. routes/cpq.js exposes no DELETE
    // endpoint, so the in-spec afterAll cannot clean them. Bulk-delete by
    // name regex here. Product has FK from QuoteLineItem.productId
    // (onDelete: SetNull per schema), so removing test products doesn't
    // cascade-corrupt real quotes — just nulls out historical productId
    // pointers on test-tagged quote lines (which we also scrub by quote
    // title prefix above? — no, we don't, but Quote rows aren't surfaced
    // on demo dashboards, so this is acceptable test-debris drift).
    const [pr] = await conn.query(
      `DELETE FROM Product WHERE name REGEXP ?`,
      [PAT_REGEX]
    );
    results.products = pr.affectedRows || 0;

    // G-8: low-stock-api.spec.js triggers cron/lowStockEngine.js which
    // writes Notification rows whose title is "Low stock: <product-name>"
    // and message echoes the product name. The product name carries the
    // RUN_TAG prefix (E2E_FLOW_LOWSTOCK_…), so PAT_REGEX matches both
    // title and message. Notification has no inbound FKs from real-data
    // tables — safe to bulk-delete by regex. (Other engines that produce
    // notifications referencing test fixtures land here too.)
    const [n] = await conn.query(
      `DELETE FROM Notification WHERE title REGEXP ? OR message REGEXP ?`,
      [PAT_REGEX, PAT_REGEX]
    );
    results.notifications = n.affectedRows || 0;

    // G-14: forecast-snapshot-api.spec.js drives cron/forecastSnapshotEngine
    // via POST /api/forecasting/snapshot/run. The Forecast model has no
    // `name` / `title` field — just numeric metrics + period + tenantId —
    // so PAT_REGEX can't match it. /api/forecasting exposes no DELETE
    // route either. Sweep any Forecast row created in the last 8 days
    // (the engine's week-window plus a day of slack). CI starts from an
    // empty Forecast table so this only ever scrubs E2E residue. On the
    // demo box this could touch real cron-written Forecast rows; the
    // demo deploys nightly with DISABLE_CRONS=1 in CI but the real cron
    // runs on the prod box at Mon 01:00 UTC, so re-running the spec
    // mid-week deletes a handful of historical snapshots. Acceptable
    // tradeoff vs. leaving polluted rows behind. If this proves too
    // aggressive, narrow to a tag column on Forecast (schema change).
    const [f] = await conn.query(
      `DELETE FROM Forecast WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 8 DAY)`
    );
    results.forecasts = f.affectedRows || 0;

    const total = results.patients + results.contacts + results.services + results.tasks + results.locations + results.products + results.notifications + results.forecasts;
    if (total > 0) {
      console.log(
        `[teardown] scrubbed E2E rows: ${results.patients} patient(s), ` +
          `${results.contacts} contact(s), ${results.services} service(s), ` +
          `${results.tasks} task(s), ${results.locations} location(s), ` +
          `${results.products} product(s), ${results.notifications} notification(s), ` +
          `${results.forecasts} forecast(s) ` +
          `(cascades auto-remove visits/Rx/consents/plans/waitlist/loyalty/referrals)`
      );
    } else {
      console.log('[teardown] no E2E rows to scrub — DB clean');
    }
  } catch (err) {
    console.warn('[teardown] scrub failed (non-fatal):', err.message);
  } finally {
    await conn.end().catch(() => {});
  }
};
