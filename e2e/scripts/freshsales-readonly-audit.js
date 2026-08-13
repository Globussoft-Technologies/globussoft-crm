#!/usr/bin/env node
// Read-only Freshsales UI auditor.
//
// Usage from repo root:
//   cd e2e
//   $env:FRESHSALES_URL="https://your-domain.myfreshworks.com/login?redirect_uri=..."
//   $env:FRESHSALES_EMAIL="user@example.com"
//   $env:FRESHSALES_PASSWORD="..."
//   node scripts/freshsales-readonly-audit.js
//
// The browser is headed by default so the operator can watch every navigation.
// After login, non-GET/HEAD/OPTIONS requests are blocked unless you explicitly
// set FRESHSALES_READONLY_NET=observe for a looser discovery-only run.

const { chromium } = require('@playwright/test');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOGIN_URL = process.env.FRESHSALES_URL || '';
const EMAIL = process.env.FRESHSALES_EMAIL || '';
const PASSWORD = process.env.FRESHSALES_PASSWORD || '';
const HEADLESS = /^1|true$/i.test(process.env.FRESHSALES_HEADLESS || '');
const SLOW_MO = Number(process.env.FRESHSALES_SLOW_MO || 300);
const MAX_PAGES = Number(process.env.FRESHSALES_MAX_PAGES || 80);
const READONLY_NET = (process.env.FRESHSALES_READONLY_NET || 'block').toLowerCase();
const REDACT_DATA = !/^0|false$/i.test(process.env.FRESHSALES_REDACT_DATA || '');
const LOGIN_TIMEOUT_MS = Number(process.env.FRESHSALES_LOGIN_TIMEOUT_MS || 180000);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(REPO_ROOT, 'e2e', 'playwright-results');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.join(OUT_ROOT, `freshsales-readonly-audit-${RUN_ID}`);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SKIP_LINK_RE = /(logout|signout|sign-out|delete|remove|destroy|archive|unsubscribe|forgot|reset|billing|upgrade|marketplace|apps\/new)/i;

const report = {
  startedAt: new Date().toISOString(),
  loginUrlHost: LOGIN_URL ? safeHost(LOGIN_URL) : '',
  readOnlyNetworkMode: READONLY_NET,
  maxPages: MAX_PAGES,
  pages: [],
  network: [],
  blockedRequests: [],
  console: [],
  pageErrors: [],
  discoveredLinks: [],
  notes: [],
};

function requireEnv() {
  const missing = [];
  if (!LOGIN_URL) missing.push('FRESHSALES_URL');
  if (!EMAIL) missing.push('FRESHSALES_EMAIL');
  if (!PASSWORD) missing.push('FRESHSALES_PASSWORD');
  if (missing.length) {
    console.error(`[freshsales-audit] Missing required env vars: ${missing.join(', ')}`);
    console.error('[freshsales-audit] Credentials are intentionally read from env vars so they are not written to git.');
    process.exit(1);
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch (_err) {
    return '';
  }
}

function sameHost(url, host) {
  try {
    return new URL(url).host === host;
  } catch (_err) {
    return false;
  }
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function redact(value) {
  let text = normalizeText(value);
  if (!REDACT_DATA || !text) return text;
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
  text = text.replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone-or-id]');
  text = text.replace(/\b[A-Z0-9]{12,}\b/g, '[token-or-id]');
  return text;
}

function uniqueStrings(values, limit = 120) {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const value = redact(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function fileSafeName(url, index) {
  const parsed = new URL(url);
  const pathPart = `${parsed.pathname}${parsed.search}`
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'home';
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  return `${String(index + 1).padStart(3, '0')}-${pathPart}-${hash}`;
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: 5000 });
      return locator;
    } catch (_err) {
      // Try the next selector.
    }
  }
  return null;
}

async function clickFirstMatchingButton(page, names) {
  for (const name of names) {
    const button = page.getByRole('button', { name }).first();
    try {
      await button.waitFor({ state: 'visible', timeout: 4000 });
      await button.click();
      return true;
    } catch (_err) {
      // Try the next accessible name.
    }
  }
  return false;
}

async function submitVisibleForm(page) {
  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  try {
    await submit.waitFor({ state: 'visible', timeout: 4000 });
    await submit.click();
    return true;
  } catch (_err) {
    return clickFirstMatchingButton(page, [/sign in/i, /login/i, /log in/i, /continue/i]);
  }
}

function isLoginLikeUrl(url) {
  return /\/login|forgot-password|freshid|authorize/i.test(url);
}

async function login(page) {
  console.log('[freshsales-audit] Opening login page in headed browser.');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const emailInput = await firstVisible(page, [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[name*="username" i]',
    'input[id*="email" i]',
    'input[id*="username" i]',
    'input[placeholder*="email" i]',
  ]);

  if (emailInput) {
    await emailInput.fill(EMAIL);
  } else {
    report.notes.push('Email input was not auto-detected; operator may need to complete login manually.');
  }

  const passwordInput = await firstVisible(page, [
    'input[type="password"]',
    'input[name*="password" i]',
    'input[id*="password" i]',
    'input[placeholder*="password" i]',
  ]);

  if (passwordInput) {
    await passwordInput.fill(PASSWORD);
    await submitVisibleForm(page);
  } else {
    await clickFirstMatchingButton(page, [/next/i, /continue/i]);
    report.notes.push('Password input was not auto-detected; operator may need to complete login manually.');
  }

  console.log('[freshsales-audit] Waiting for the app shell. Complete MFA manually if Freshsales asks for it.');
  await page.waitForURL((url) => !isLoginLikeUrl(url.href), {
    timeout: LOGIN_TIMEOUT_MS,
  }).catch(() => {
    report.notes.push('Login wait timed out. The script will continue from the current visible page.');
  });
  await settle(page);

  if (isLoginLikeUrl(page.url())) {
    await snapshotPage(page, 0, new URL(LOGIN_URL).host).catch(() => {});
    throw new Error('Freshsales login did not complete. Check credentials, CAPTCHA, MFA, or account access in the headed browser.');
  }
}

async function installReadOnlyNetworkGuard(page) {
  const context = page.context();
  context.on('requestfinished', async (request) => {
    const method = request.method();
    const resourceType = request.resourceType();
    if (!['xhr', 'fetch', 'document'].includes(resourceType)) return;
    report.network.push({
      method,
      url: request.url(),
      resourceType,
    });
  });

  await context.route('**/*', async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    if (MUTATING_METHODS.has(method)) {
      const entry = {
        method,
        url: request.url(),
        blockedAt: new Date().toISOString(),
      };
      report.blockedRequests.push(entry);
      if (READONLY_NET === 'block') {
        console.log(`[freshsales-audit] BLOCKED ${method} ${request.url()}`);
        await route.abort('blockedbyclient');
        return;
      }
      console.log(`[freshsales-audit] OBSERVED ${method} ${request.url()}`);
    }
    await route.continue();
  });
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function snapshotPage(page, index, appHost) {
  await settle(page);
  const fileBase = fileSafeName(page.url(), index);
  const screenshot = path.join(OUT_DIR, `${fileBase}.png`);
  await page.screenshot({ path: screenshot, fullPage: true }).catch((err) => {
    report.notes.push(`Screenshot failed for ${page.url()}: ${err.message}`);
  });

  const dom = await page.evaluate(() => {
    const textOf = (node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    const ariaOf = (node) => node.getAttribute('aria-label') || node.getAttribute('title') || '';
    const labelFor = (node) => {
      if (node.labels && node.labels.length) {
        return Array.from(node.labels).map((label) => textOf(label)).join(' ');
      }
      const id = node.getAttribute('id');
      if (id) {
        const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (explicit) return textOf(explicit);
      }
      return ariaOf(node) || node.getAttribute('placeholder') || node.getAttribute('name') || '';
    };

    const controls = Array.from(document.querySelectorAll('input, textarea, select, button, [role="button"], [role="tab"], [role="menuitem"]'))
      .filter((node) => !node.closest('[hidden]') && !node.disabled)
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        type: node.getAttribute('type') || node.getAttribute('role') || '',
        label: labelFor(node) || textOf(node),
        placeholder: node.getAttribute('placeholder') || '',
      }));

    const tables = Array.from(document.querySelectorAll('table')).slice(0, 10).map((table) => ({
      caption: table.caption ? textOf(table.caption) : '',
      headers: Array.from(table.querySelectorAll('th')).map(textOf).filter(Boolean).slice(0, 30),
      sampleRows: Array.from(table.querySelectorAll('tbody tr')).slice(0, 3).map((row) =>
        Array.from(row.querySelectorAll('td')).map(textOf).filter(Boolean).slice(0, 12)
      ),
    }));

    const links = Array.from(document.querySelectorAll('a[href]')).map((link) => ({
      text: textOf(link) || ariaOf(link),
      href: link.href,
    }));

    return {
      title: document.title,
      headings: Array.from(document.querySelectorAll('h1, h2, h3')).map(textOf).filter(Boolean),
      navText: Array.from(document.querySelectorAll('nav, aside, [role="navigation"]')).flatMap((node) =>
        textOf(node).split(/\n| {2,}/).map((part) => part.trim()).filter(Boolean)
      ),
      controls,
      tables,
      links,
    };
  });

  const pageSummary = {
    url: page.url(),
    title: redact(dom.title),
    screenshot: path.relative(REPO_ROOT, screenshot).replace(/\\/g, '/'),
    headings: uniqueStrings(dom.headings, 80),
    navigationText: uniqueStrings(dom.navText, 120),
    controls: dom.controls
      .map((control) => ({
        tag: control.tag,
        type: redact(control.type),
        label: redact(control.label),
        placeholder: redact(control.placeholder),
      }))
      .filter((control) => control.label || control.placeholder)
      .slice(0, 160),
    tables: dom.tables.map((table) => ({
      caption: redact(table.caption),
      headers: uniqueStrings(table.headers, 40),
      sampleRows: table.sampleRows.map((row) => uniqueStrings(row, 12)),
    })),
  };

  const discovered = dom.links
    .map((link) => ({
      text: redact(link.text),
      href: link.href,
    }))
    .filter((link) => link.href && sameHost(link.href, appHost))
    .filter((link) => !SKIP_LINK_RE.test(`${link.text} ${link.href}`));

  report.pages.push(pageSummary);
  report.discoveredLinks.push(...discovered);
  return discovered;
}

function chooseLinks(links, appHost) {
  const unique = new Map();
  for (const link of links) {
    try {
      const url = new URL(link.href);
      url.hash = '';
      if (url.host !== appHost) continue;
      if (!/^https?:$/.test(url.protocol)) continue;
      if (SKIP_LINK_RE.test(`${link.text} ${url.href}`)) continue;
      unique.set(url.href, link.text);
    } catch (_err) {
      // Ignore malformed hrefs.
    }
  }
  return Array.from(unique, ([href, text]) => ({ href, text }));
}

function writeReports() {
  const jsonPath = path.join(OUT_DIR, 'freshsales-readonly-audit.json');
  const mdPath = path.join(OUT_DIR, 'freshsales-readonly-audit.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const lines = [
    '# Freshsales Read-Only UI Audit',
    '',
    `Started: ${report.startedAt}`,
    `Host: ${report.loginUrlHost}`,
    `Read-only network mode: ${report.readOnlyNetworkMode}`,
    `Pages captured: ${report.pages.length}`,
    `Blocked mutating requests: ${report.blockedRequests.length}`,
    '',
    '## Notes',
    '',
    ...(report.notes.length ? report.notes.map((note) => `- ${note}`) : ['- None']),
    '',
    '## Pages',
    '',
  ];

  for (const page of report.pages) {
    lines.push(`### ${page.title || page.url}`);
    lines.push('');
    lines.push(`URL: ${page.url}`);
    lines.push(`Screenshot: ${page.screenshot}`);
    lines.push('');
    lines.push(`Headings: ${page.headings.join(' | ') || 'None detected'}`);
    lines.push('');
    lines.push('Controls:');
    if (page.controls.length) {
      for (const control of page.controls.slice(0, 60)) {
        const label = control.label || control.placeholder || '(unlabeled)';
        lines.push(`- ${control.tag}${control.type ? `/${control.type}` : ''}: ${label}`);
      }
    } else {
      lines.push('- None detected');
    }
    lines.push('');
    lines.push('Tables:');
    if (page.tables.length) {
      for (const table of page.tables) {
        lines.push(`- ${table.caption || 'Table'}: ${table.headers.join(' | ') || 'no headers detected'}`);
      }
    } else {
      lines.push('- None detected');
    }
    lines.push('');
  }

  lines.push('## Blocked Requests');
  lines.push('');
  if (report.blockedRequests.length) {
    for (const req of report.blockedRequests.slice(0, 200)) {
      lines.push(`- ${req.method} ${req.url}`);
    }
  } else {
    lines.push('- None');
  }

  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`);
  return { jsonPath, mdPath };
}

async function main() {
  requireEnv();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[freshsales-audit] Output directory: ${OUT_DIR}`);
  console.log(`[freshsales-audit] Browser: ${HEADLESS ? 'headless' : 'headed'}, slowMo=${SLOW_MO}ms`);
  console.log(`[freshsales-audit] Post-login network mode: ${READONLY_NET}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: SLOW_MO,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 950 } },
  });
  const page = await context.newPage();
  const appHost = new URL(LOGIN_URL).host;

  page.on('console', (msg) => {
    if (!['error', 'warning'].includes(msg.type())) return;
    report.console.push({ type: msg.type(), text: redact(msg.text()), url: page.url() });
  });
  page.on('pageerror', (err) => {
    report.pageErrors.push({ message: redact(err.message), url: page.url() });
  });

  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
    report.notes.push('Run interrupted by operator with Ctrl+C; partial report written.');
    console.log('\n[freshsales-audit] Ctrl+C received. Writing partial report before exit...');
  });

  try {
    await login(page);
    await installReadOnlyNetworkGuard(page);

    const queue = [page.url()];
    const queued = new Set(queue);
    const visited = new Set();

    for (let i = 0; queue.length && visited.size < MAX_PAGES; i++) {
      if (interrupted) break;
      const url = queue.shift();
      if (!url || visited.has(url) || SKIP_LINK_RE.test(url)) continue;

      console.log(`[freshsales-audit] Visiting ${visited.size + 1}/${MAX_PAGES}: ${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.keyboard.press('Home').catch(() => {});
        const links = await snapshotPage(page, visited.size, appHost);
        visited.add(url);

        for (const link of chooseLinks(links, appHost)) {
          if (visited.has(link.href) || queued.has(link.href)) continue;
          queued.add(link.href);
          queue.push(link.href);
        }
      } catch (err) {
        report.notes.push(`Failed to capture ${url}: ${err.message}`);
      }
    }
  } finally {
    const paths = writeReports();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    console.log('[freshsales-audit] Report written:');
    console.log(`  ${paths.mdPath}`);
    console.log(`  ${paths.jsonPath}`);
    console.log(`[freshsales-audit] Pages captured: ${report.pages.length}`);
    console.log(`[freshsales-audit] Blocked mutating requests: ${report.blockedRequests.length}`);
  }
}

main().catch((err) => {
  report.notes.push(`Fatal error: ${err.message}`);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  writeReports();
  console.error('[freshsales-audit] Fatal error:', err);
  process.exit(1);
});
