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

// Same regex used by the one-off scrub we ran on 2026-04-23. Anchored at
// start, so a real patient named "Loyalty" (no number) is never matched.
const PAT_REGEX =
  '^(E2E |Coverage |Loyalty [0-9]{6}|Referrer [0-9]{6}|' +
  'Waitlist [0-9]{6}|Lifecycle [0-9]{6}|Friend [0-9]{6}|' +
  'Junk [0-9]{6}|Telecaller Queue Lead [0-9]{6})';
const EMAIL_REGEX = '(@example\\.test$|@inbound\\.local$|^e2e[-_])';
const SVC_DESC_LIKE = '%wellness-real-user-journeys%';

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

    const total = results.patients + results.contacts + results.services;
    if (total > 0) {
      console.log(
        `[teardown] scrubbed E2E rows: ${results.patients} patient(s), ` +
          `${results.contacts} contact(s), ${results.services} service(s) ` +
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
