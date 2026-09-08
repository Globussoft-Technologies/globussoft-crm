/**
 * Theme safety for the package builder and its tab.
 *
 * These components are styled inline, so a colour that only exists in one
 * theme fails silently: `var(--card-bg, #1f2430)` painted a dark tooltip on a
 * white page, and a `rgba(255,255,255,0.04)` wash was invisible in light mode.
 * Neither shows up in a render test, because jsdom resolves no CSS variables.
 *
 * So this reads the source instead: every variable the components reference
 * must be defined for BOTH themes, and no background may be hard-coded white.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'index.css'), 'utf8');

const FILES = [
  'pages/wellness/services/PackageBuilder.jsx',
  'pages/wellness/services/ActivePackagesTab.jsx',
];

/** Variable names declared inside the block a selector opens. */
function declaredIn(selector) {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) return new Set();
  const end = CSS.indexOf('\n}', start);
  const body = CSS.slice(start, end);
  return new Set([...body.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
}

const DARK = declaredIn(':root');
const LIGHT = declaredIn('[data-theme="light"]');

describe('package builder — theme variables', () => {
  it('index.css really does define both palettes', () => {
    // Guards the parser above: an empty set would make every test below pass.
    expect(DARK.size).toBeGreaterThan(20);
    expect(LIGHT.size).toBeGreaterThan(20);
  });

  for (const file of FILES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const used = [...source.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);

    it(`${file} only uses variables the dark theme defines`, () => {
      const missing = [...new Set(used)].filter((v) => !DARK.has(v));
      expect(missing).toEqual([]);
    });

    it(`${file} only uses variables the light theme overrides or inherits`, () => {
      // A variable declared once on :root is shared by both themes; one that
      // encodes a colour must be re-declared for light or it stays dark.
      const missing = [...new Set(used)].filter((v) => !DARK.has(v) && !LIGHT.has(v));
      expect(missing).toEqual([]);
    });

    it(`${file} hard-codes no white surface`, () => {
      // Invisible on a light background. Text colours on a coloured button
      // (#fff on --accent-color) are fine, so only backgrounds and borders
      // are checked.
      const offenders = [...source.matchAll(/(background|borderTop|borderBottom|border)\s*:\s*'([^']*)'/g)]
        .filter(([, , value]) => /rgba\(\s*255\s*,\s*255\s*,\s*255/.test(value) || /#fff\b|#ffffff/i.test(value))
        .map(([, prop, value]) => `${prop}: ${value}`);
      expect(offenders).toEqual([]);
    });
  }
});
