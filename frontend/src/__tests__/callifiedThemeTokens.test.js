/**
 * Theme-token guard for the Callified calling surface.
 *
 * THE BUG THIS PREVENTS
 *   Under the wellness theme `--primary-color` is `#1F2220` — a dark charcoal
 *   that is the SIDEBAR / HERO BACKGROUND, and it is the same value in light
 *   and dark mode (frontend/src/theme/wellness.css). Used as a `background`
 *   with white text it is correct. Used as a foreground `color:` on a
 *   transparent surface it renders charcoal-on-black in dark mode:
 *
 *       #1F2220 on #0D0F0E  ->  1.20:1 contrast  ->  invisible
 *
 *   That is exactly what happened to the Call button and the "Open in
 *   calendar" link on wellness/Appointments — the Actions column rendered as
 *   an empty outlined box.
 *
 *   The repo convention "primary CTAs use var(--primary-color,
 *   var(--accent-color))" is about FILLS. This file pins the foreground half
 *   of the rule so the convention is not mis-applied again.
 *
 * THE RULE
 *   - foreground `color:`  -> --text-primary / --text-secondary / --accent-color
 *                             (all three are redefined per light+dark mode)
 *   - `background:`        -> --primary-color is fine, paired with a light label
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..');

const GUARDED_FILES = [
  'components/CallifiedCallDialog.jsx',
  'components/CallifiedManualCallPanel.jsx',
  'pages/wellness/Appointments.jsx',
];

// `color: 'var(--primary-color...)'` in an inline style object — the exact
// shape of the defect. Deliberately does NOT match `background: 'var(--primary-color...)'`.
const FOREGROUND_PRIMARY = /\bcolor:\s*['"`]var\(\s*--primary-color/g;

describe('Callified surface theme tokens', () => {
  for (const relative of GUARDED_FILES) {
    test(`${relative} never uses --primary-color as a foreground colour`, () => {
      const source = readFileSync(resolve(SRC, relative), 'utf8');
      const offenders = source.match(FOREGROUND_PRIMARY) || [];
      expect(
        offenders,
        `--primary-color is #1F2220 in BOTH wellness modes; as a foreground it is ` +
          `1.2:1 on the dark surface (invisible). Use --text-primary for text or ` +
          `--accent-color for decorative icons.`,
      ).toEqual([]);
    });
  }

  test('the wellness theme really does define --primary-color identically in both modes', () => {
    // If this ever stops being true the guard above can be relaxed — but until
    // then the token is unusable as a foreground, and this documents why.
    const theme = readFileSync(resolve(SRC, 'theme/wellness.css'), 'utf8');
    const values = [...theme.matchAll(/--primary-color:\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThanOrEqual(2); // light block + dark block
    expect(new Set(values).size).toBe(1);
  });

  test('the tokens we DO use for foregrounds are redefined for dark mode', () => {
    const theme = readFileSync(resolve(SRC, 'theme/wellness.css'), 'utf8');
    for (const token of ['--text-primary', '--text-secondary', '--accent-color']) {
      const values = [...theme.matchAll(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{3,8})`, 'g'))].map(
        (m) => m[1].toLowerCase(),
      );
      expect(values.length, `${token} should appear in both the light and dark blocks`)
        .toBeGreaterThanOrEqual(2);
      expect(new Set(values).size, `${token} must differ between light and dark`)
        .toBeGreaterThan(1);
    }
  });
});
