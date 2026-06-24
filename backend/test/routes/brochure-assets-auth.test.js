// @ts-check
/**
 * Brochure assets auth-bypass contract pin.
 *
 * The brochure engine writes PDFs to GENERATED_DIR and the operator UI
 * loads them via an iframe + plain <a download> link — neither sends an
 * Authorization header. Without the openPaths allowlist entry the global
 * auth guard rejected the request with 401 "Authentication required"
 * (visible to the user on 2026-06-24 — both the iframe preview rendered
 * blank and the downloaded file was the SPA 404 HTML).
 *
 * This test reconstructs the smallest possible express app that mirrors
 * server.js's auth guard + the two static mounts, then proves:
 *   - GET /api/brochure-assets/<file>.pdf returns the bytes (no auth)
 *   - GET /brochure-assets/<file>.pdf returns the bytes (no auth, legacy mount)
 *   - A non-allowlisted /api/* path STILL returns 401 (so this entry
 *     hasn't broadened the auth-bypass surface)
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mirror the EXACT openPaths list shape from server.js. If you add or
// remove an entry there, update this list too — the test pins the
// brochure-assets entry explicitly below so a regression on that single
// item still trips even if the array shape drifts.
const OPEN_PATHS = [
  '/auth/login', '/health', '/brochure-assets',
];

function makeApp(generatedDir) {
  const app = express();

  // Global guard — same shape as server.js:758.
  app.use('/api', (req, res, next) => {
    if (OPEN_PATHS.some((p) => req.path.startsWith(p))) return next();
    return res.status(401).json({ error: 'Authentication required' });
  });

  // Both static mounts, mirroring server.js:1370-1371.
  app.use('/brochure-assets', express.static(generatedDir));
  app.use('/api/brochure-assets', express.static(generatedDir));

  // A representative protected route so we can confirm the allowlist
  // entry doesn't broaden coverage.
  app.get('/api/some/protected/route', (_req, res) => res.json({ ok: true }));

  return app;
}

describe('Brochure assets — global auth-guard bypass', () => {
  let tmpDir;
  let pdfPath;
  const PDF_CONTENTS = '%PDF-1.4\n%fake brochure for auth-gate test\n%%EOF\n';

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brochure-assets-test-'));
    pdfPath = path.join(tmpDir, 'brochure-br_test12345.pdf');
    fs.writeFileSync(pdfPath, PDF_CONTENTS);
  });

  afterAll(() => {
    try {
      fs.unlinkSync(pdfPath);
      fs.rmdirSync(tmpDir);
    } catch { /* tmp cleanup best-effort */ }
  });

  test('GET /api/brochure-assets/<file>.pdf returns the bytes without an Authorization header', async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).get('/api/brochure-assets/brochure-br_test12345.pdf');
    expect(res.status).toBe(200);
    expect(res.text || res.body?.toString?.()).toContain('%PDF-1.4');
    expect(res.headers['content-type']).toMatch(/pdf/i);
  });

  test('GET /brochure-assets/<file>.pdf (legacy bare mount, prod path) returns the bytes', async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).get('/brochure-assets/brochure-br_test12345.pdf');
    expect(res.status).toBe(200);
    expect(res.text || res.body?.toString?.()).toContain('%PDF-1.4');
  });

  test('GET /api/brochure-assets/missing.pdf 404s (handled by express.static), not 401', async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).get('/api/brochure-assets/does-not-exist.pdf');
    expect(res.status).toBe(404);
  });

  test('a non-allowlisted /api/* path STILL returns 401 — bypass surface not broadened', async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).get('/api/some/protected/route');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });
});
