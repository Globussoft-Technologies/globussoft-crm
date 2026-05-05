// Regression test for the 940b4f0 wave's anti-pattern finding:
// `/api/health` previously returned a hardcoded "3.2.0" string in the
// version field, surviving 5+ release tags of drift and misleading the
// triaging-stuck-deploy-gate skill's "verify demo divergence" step.
//
// The fix wired both /api/health and / through `APP_VERSION =
// require('./package.json').version` (server.js top-level). This test
// pins the contract via static grep against server.js source so a future
// refactor that re-introduces a hardcoded version literal fails in CI
// before it ships.
//
// Static-grep is the right shape here because:
//   - We want to catch the LITERAL drift, not test runtime behaviour.
//     A runtime test would only fail when version strings are ALREADY
//     out of sync; this catches the regression at the source-code level.
//   - Booting express + hitting /api/health from a vitest is overkill
//     when the failure mode is "someone typed a version string into
//     server.js again".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_JS = path.resolve(__dirname, '..', 'server.js');
const PACKAGE_JSON = path.resolve(__dirname, '..', 'package.json');

describe('server.js version source — regression guard for the 940b4f0 wave', () => {
  test('server.js does NOT contain a hardcoded version: "<X.Y.Z>" literal', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    // Match `version: "3.2.0"` / `version: '3.2.0'` / variants with extra
    // whitespace. Allow `version: APP_VERSION` (the canonical form).
    // Pattern caught by this regex:
    //   version: "3.2.0"
    //   version:'3.10.0'
    //   version : "4.1.2"
    // NOT caught (good):
    //   version: APP_VERSION
    //   version: pkg.version
    //   "version": "3.3.0"   (this is package.json, not server.js — the path
    //                         is what scopes the test)
    const HARDCODED_VERSION_RE = /\bversion\s*:\s*['"]\d+\.\d+\.\d+['"]/g;
    const matches = src.match(HARDCODED_VERSION_RE) || [];
    expect(
      matches,
      `server.js contains hardcoded version literal(s) — read from package.json instead.\n` +
        `Use \`APP_VERSION = require('./package.json').version\` once at top + reference \n` +
        `\`APP_VERSION\` in the response payloads. Hits:\n  - ${matches.join('\n  - ')}`,
    ).toEqual([]);
  });

  test('server.js loads APP_VERSION from package.json', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    // The canonical pattern. If a future refactor moves to a different
    // helper name or import style, update this assertion AND ensure the
    // hardcoded-literal test above still passes.
    expect(
      src,
      'server.js must require package.json for version (do not hardcode)',
    ).toMatch(/APP_VERSION\s*=\s*require\(['"]\.\/package\.json['"]\)\.version/);
  });

  test('package.json has a non-empty semver version string', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    expect(pkg.version, 'package.json must have a version field').toBeTruthy();
    expect(pkg.version, 'package.json version must be semver-shaped').toMatch(/^\d+\.\d+\.\d+/);
  });
});
