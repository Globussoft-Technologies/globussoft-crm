/**
 * legal.js — Public legal/policy pages rendered from Markdown.
 *
 * Routes:
 *   GET /privacy-policy        → docs/PRIVACY_POLICY.md
 *   GET /deleted-account-policy → docs/DELETED_ACCOUNT_POLICY.md
 *   GET /terms-and-conditions  → docs/TERMS_AND_CONDITIONS.md
 *
 * Each page is converted from Markdown to HTML via `marked` and wrapped
 * in a lightweight branded shell with light/dark theme support.
 */

const fs = require("fs");
const path = require("path");
const { marked } = require("marked");
const express = require("express");

const router = express.Router();

// Absolute paths to the markdown source files (repo root → docs/)
const DOCS_DIR = path.resolve(__dirname, "../../docs");

const FILES = {
  "/privacy-policy": "PRIVACY_POLICY.md",
  "/deleted-account-policy": "DELETED_ACCOUNT_POLICY.md",
  "/terms-and-conditions": "TERMS_AND_CONDITIONS.md",
};

const TITLES = {
  "/privacy-policy": "Privacy Policy — Globus CRM",
  "/deleted-account-policy": "Account & Data Deletion Policy — Globus CRM",
  "/terms-and-conditions": "Terms and Conditions — Globus CRM",
};

/**
 * Convert Markdown to HTML and wrap it in a clean, responsive page shell.
 */
function renderLegalPage(route, mdSource) {
  const title = TITLES[route] || "Globus CRM";
  const bodyHtml = marked(mdSource, { headerIds: true, mangle: false });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#265855" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <title>${title}</title>
  <style>
    :root {
      --bg: #ffffff;
      --bg-secondary: #f8fafc;
      --text: #0f172a;
      --text-secondary: #475569;
      --accent: #2563eb;
      --border: #e2e8f0;
      --code-bg: #f1f5f9;
      --link: #2563eb;
      --link-hover: #1d4ed8;
      --max-width: 800px;
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --bg-secondary: #1e293b;
        --text: #f1f5f9;
        --text-secondary: #94a3b8;
        --accent: #60a5fa;
        --border: #334155;
        --code-bg: #1e293b;
        --link: #60a5fa;
        --link-hover: #93c5fd;
      }
    }
    html[data-theme="light"] {
      --bg: #ffffff;
      --bg-secondary: #f8fafc;
      --text: #0f172a;
      --text-secondary: #475569;
      --accent: #2563eb;
      --border: #e2e8f0;
      --code-bg: #f1f5f9;
      --link: #2563eb;
      --link-hover: #1d4ed8;
    }
    html[data-theme="dark"] {
      --bg: #0f172a;
      --bg-secondary: #1e293b;
      --text: #f1f5f9;
      --text-secondary: #94a3b8;
      --accent: #60a5fa;
      --border: #334155;
      --code-bg: #1e293b;
      --link: #60a5fa;
      --link-hover: #93c5fd;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--text);
      line-height: 1.7;
      -webkit-font-smoothing: antialiased;
    }
    nav {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(255,255,255,0.85);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border);
    }
    @media (prefers-color-scheme: dark) {
      nav { background: rgba(15,23,42,0.85); }
    }
    html[data-theme="light"] nav { background: rgba(255,255,255,0.85); }
    html[data-theme="dark"] nav { background: rgba(15,23,42,0.85); }
    .nav-inner {
      max-width: var(--max-width);
      margin: 0 auto;
      padding: 0 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 56px;
    }
    .nav-inner a { text-decoration: none; color: var(--text); font-weight: 600; font-size: 0.95rem; }
    .nav-inner a:hover { color: var(--accent); }
    .nav-links { display: flex; gap: 24px; align-items: center; }
    .nav-links a { font-weight: 500; font-size: 0.85rem; color: var(--text-secondary); }
    .nav-links a:hover { color: var(--accent); }
    main {
      max-width: var(--max-width);
      margin: 0 auto;
      padding: 48px 24px 80px;
    }
    h1 { font-size: 2rem; font-weight: 800; margin: 0 0 8px; letter-spacing: -0.02em; line-height: 1.2; }
    h2 { font-size: 1.35rem; font-weight: 700; margin: 40px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
    h3 { font-size: 1.1rem; font-weight: 600; margin: 28px 0 8px; }
    h4 { font-size: 1rem; font-weight: 600; margin: 20px 0 6px; }
    p { margin: 0 0 16px; color: var(--text-secondary); }
    a { color: var(--link); text-decoration: none; }
    a:hover { color: var(--link-hover); text-decoration: underline; }
    ul, ol { margin: 0 0 16px; padding-left: 24px; }
    li { margin-bottom: 8px; }
    li > p { margin-bottom: 8px; }
    blockquote {
      margin: 0 0 16px;
      padding: 12px 16px;
      border-left: 4px solid var(--accent);
      background: var(--bg-secondary);
      border-radius: 0 8px 8px 0;
    }
    blockquote p { margin: 0; color: var(--text); }
    blockquote p:last-child { margin-bottom: 0; }
    code {
      font-family: var(--font-mono);
      font-size: 0.85em;
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 4px;
      color: var(--accent);
    }
    pre {
      background: var(--code-bg);
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 0.85rem;
      line-height: 1.5;
      border: 1px solid var(--border);
      margin: 0 0 16px;
    }
    pre code { background: transparent; padding: 0; color: var(--text); }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 0 0 16px;
      font-size: 0.9rem;
    }
    th, td {
      padding: 10px 12px;
      border: 1px solid var(--border);
      text-align: left;
    }
    th { background: var(--bg-secondary); font-weight: 600; }
    tr:nth-child(even) { background: var(--bg-secondary); }
    hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
    .effective-date { color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 32px; }
    footer {
      text-align: center;
      padding: 32px 24px;
      border-top: 1px solid var(--border);
      color: var(--text-secondary);
      font-size: 0.8rem;
    }
    @media (max-width: 640px) {
      h1 { font-size: 1.6rem; }
      h2 { font-size: 1.15rem; }
      main { padding: 32px 16px 60px; }
      .nav-links { display: none; }
    }
  </style>
  <script>
    (function() {
      try {
        var saved = localStorage.getItem('theme');
        var effective = saved;
        if (saved === 'system' || !saved) {
          effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        document.documentElement.setAttribute('data-theme', effective);
      } catch (e) {}
    })();
  </script>
</head>
<body>
  <nav>
    <div class="nav-inner">
      <a href="/">Globus CRM</a>
      <div class="nav-links">
        <a href="/privacy-policy">Privacy</a>
        <a href="/terms-and-conditions">Terms</a>
        <a href="/deleted-account-policy">Deletion</a>
        <a href="/login">Login</a>
      </div>
    </div>
  </nav>
  <main>
    ${bodyHtml}
  </main>
  <footer>
    &copy; 2026 Globussoft Technologies. All rights reserved.
  </footer>
</body>
</html>`;
}

function serveLegal(route) {
  return (req, res) => {
    const filePath = path.join(DOCS_DIR, FILES[route]);
    let mdSource;
    try {
      mdSource = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      console.error(`[legal] failed to read ${filePath}:`, err.message);
      return res.status(500).send("Internal server error — document unavailable.");
    }
    const html = renderLegalPage(route, mdSource);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(html);
  };
}

router.get("/privacy-policy", serveLegal("/privacy-policy"));
router.get("/deleted-account-policy", serveLegal("/deleted-account-policy"));
router.get("/terms-and-conditions", serveLegal("/terms-and-conditions"));

module.exports = router;
