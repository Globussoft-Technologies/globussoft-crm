#!/usr/bin/env node
// Refresh the screenshots referenced from the top-level README.md.
//
// Why this exists
// ───────────────
// The README's "Feature Highlights" section embeds 7 PNGs from
// qa_screenshots/feature-*.png. They go stale every time the relevant
// page gets a UI refresh (the v3.4.x arc redesigned the Sidebar, KB,
// Marketing, Channels, Patients, Marketplace Leads — all of which
// changed dramatically since the original April 3 capture).
//
// Run this script against the live demo (or local stack) and it will
// log in as the generic Admin, navigate to each page, wait for it to
// settle, and overwrite the corresponding qa_screenshots/feature-*.png
// at desktop viewport (1440 × 900). Commit + push the new PNGs in a
// single commit; the README's `![](path)` references stay the same.
//
// Usage
// ─────
//   node e2e/scripts/refresh-readme-screenshots.js                 # against demo
//   BASE_URL=http://localhost:5173 node e2e/scripts/refresh-readme-screenshots.js  # against local
//
// Override the credentials with ADMIN_EMAIL + ADMIN_PASSWORD env vars.
//
// Requirements
// ────────────
// - Run from the repo root OR from anywhere — the script resolves
//   qa_screenshots/ relative to its own location.
// - The local stack must serve the SPA on the chosen BASE_URL (usually
//   the vite dev server on :5173, OR the deployed Nginx-served bundle
//   at https://crm.globusdemos.com).
// - Playwright + chromium browsers must be installed (run once:
//   `cd e2e && npx playwright install chromium`).

const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@globussoft.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password123';

// Path to qa_screenshots/ — resolved from this script's location, so
// `node e2e/scripts/refresh-readme-screenshots.js` works no matter
// where you cd to first.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'qa_screenshots');

// What the README embeds. Each entry maps a SPA path to the file the
// README references. Keep this list in lockstep with the README's
// "Feature Highlights" section — if you add a new ![](feature-foo.png)
// embed, add a new entry here.
const SHOTS = [
  { path: '/dashboard',                  out: 'feature-dashboard.png',                wait: 'networkidle' },
  { path: '/leads',                      out: 'feature-agent-assignment-leads.png',   wait: 'networkidle' },
  { path: '/contacts',                   out: 'feature-agent-assignment-contacts.png', wait: 'networkidle' },
  { path: '/agent-reports',              out: 'feature-agent-reports.png',            wait: 'networkidle' },
  { path: '/reports',                    out: 'feature-reports-charts.png',           wait: 'networkidle' },
  { path: '/reports?tab=detailed',       out: 'feature-reports-detailed.png',         wait: 'networkidle' },
  { path: '/reports?tab=schedules',      out: 'feature-auto-email-schedule.png',      wait: 'networkidle' },
];

async function main() {
  if (!fs.existsSync(OUT_DIR)) {
    console.error(`[refresh-screenshots] qa_screenshots/ not found at ${OUT_DIR}`);
    process.exit(1);
  }
  console.log(`[refresh-screenshots] BASE_URL=${BASE_URL}`);
  console.log(`[refresh-screenshots] ADMIN=${ADMIN_EMAIL}`);
  console.log(`[refresh-screenshots] Output: ${OUT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    // Suppress the "you're using a development build" banner that
    // sometimes overlays the viewport on CRM pages.
    extraHTTPHeaders: { 'x-screenshot-mode': '1' },
  });
  const page = await context.newPage();

  // 1. Log in as Admin via the API (faster + more reliable than the UI form).
  console.log('[refresh-screenshots] Logging in via /api/auth/login …');
  const loginRes = await page.request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  if (!loginRes.ok()) {
    console.error(`[refresh-screenshots] Login failed: ${loginRes.status()}`);
    console.error(await loginRes.text());
    await browser.close();
    process.exit(1);
  }
  const { token, tenant, user } = await loginRes.json();
  console.log(`[refresh-screenshots] Logged in as ${user?.email || ADMIN_EMAIL} on tenant ${tenant?.name || tenant?.id}`);

  // 2. Seed the SPA's auth state — token in sessionStorage (per the
  //    v3.2.5 #343 hardening that moved JWTs off localStorage), plus
  //    `tenant` JSON in localStorage (read by Sidebar + KB to derive
  //    the tenant slug + display name).
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token, tenant, user }) => {
    // sessionStorage = primary token store post-#343
    sessionStorage.setItem('token', token);
    if (tenant) localStorage.setItem('tenant', JSON.stringify(tenant));
    if (user) localStorage.setItem('user', JSON.stringify(user));
  }, { token, tenant, user });

  // 3. Walk each path, screenshot, save.
  for (const { path: spaPath, out, wait } of SHOTS) {
    const url = `${BASE_URL}${spaPath}`;
    const outFile = path.join(OUT_DIR, out);
    process.stdout.write(`[refresh-screenshots] ${spaPath}  →  ${out}  …  `);
    try {
      await page.goto(url, { waitUntil: wait || 'networkidle', timeout: 30000 });
      // Brief settle so animations/charts finish painting.
      await page.waitForTimeout(1500);
      await page.screenshot({ path: outFile, fullPage: false });
      console.log('OK');
    } catch (err) {
      console.log(`SKIPPED — ${err.message}`);
    }
  }

  await browser.close();
  console.log('[refresh-screenshots] Done. Review the diffs in qa_screenshots/ before committing:');
  console.log('  git diff --stat qa_screenshots/');
  console.log('  git add qa_screenshots/feature-*.png && git commit -m "docs: refresh README feature screenshots"');
}

main().catch((err) => {
  console.error('[refresh-screenshots] Fatal error:', err);
  process.exit(1);
});
