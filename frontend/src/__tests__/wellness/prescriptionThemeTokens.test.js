/**
 * Theme-token guard for the prescription renewal + drug/inventory surfaces.
 *
 * THE BUG THIS PREVENTS
 *   These pages shipped looking correct in dark mode and broken in light,
 *   because two tokens do not mean what their names suggest:
 *
 *   1. `--card-bg` IS NOT DEFINED ANYWHERE. Every use was written as
 *      `var(--card-bg, var(--subtle-bg-2))`, so it always fell through to the
 *      fallback.
 *
 *   2. `--subtle-bg-2` is `rgba(0,0,0,0.02)` in light mode — a 2%-opaque tint,
 *      not a surface. Used as the background of the searchable product
 *      dropdown it made the list effectively TRANSPARENT, and the table rows
 *      underneath rendered straight through the options. Used as a card
 *      background it made every card invisible against the cream page.
 *
 *   The same class of mistake hit the status/stock chips: hard-coded hex pairs
 *   (`#15803d` on `rgba(34,197,94,0.16)`) were picked against a light ground
 *   and lost contrast on the dark one.
 *
 * THE RULES
 *   surfaces that must be OPAQUE (dropdowns, popovers) -> --modal-bg
 *   card / panel surfaces                              -> .glass or --surface-color
 *   form fields                                        -> --input-bg
 *   semantic state colour                              -> --success/--warning/
 *                                                          --danger/--accent-color,
 *                                                          tinted via color-mix
 *   `--subtle-bg-2` / `--subtle-bg-3`                  -> tints only, never a surface
 *
 * Sibling of __tests__/callifiedThemeTokens.test.js, which pins the
 * foreground half of the same family of theme bugs.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../..');

const GUARDED_FILES = [
  'pages/wellness/PrescriptionRequests.jsx',
  'pages/wellness/MyPrescriptionRequests.jsx',
  'components/wellness/PrescriptionRenewalComposer.jsx',
];

const read = (relative) => readFileSync(resolve(SRC, relative), 'utf8');

/** Strip line comments so the rules describe code, not the notes about them. */
const code = (source) =>
  source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

describe('prescription surfaces — theme tokens', () => {
  for (const relative of GUARDED_FILES) {
    test(`${relative} never references the undefined --card-bg`, () => {
      // It resolves to nothing, so every use silently became its fallback.
      expect(code(read(relative))).not.toMatch(/--card-bg/);
    });

    test(`${relative} never uses --subtle-bg-2 as a background`, () => {
      // 2% opacity is a tint. As a surface it is transparent in light mode.
      const offenders = code(read(relative)).match(
        /\bbackground:\s*['"`]var\(\s*--subtle-bg-2/g,
      ) || [];
      expect(offenders).toEqual([]);
    });

    test(`${relative} uses no hard-coded hex colour except white`, () => {
      // White-on-charcoal is the documented CTA pairing; anything else must
      // come from a token so it moves with the theme.
      const hexes = code(read(relative)).match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      const offenders = hexes.filter((h) => !/^#(fff|ffffff)$/i.test(h));
      expect(offenders).toEqual([]);
    });
  }

  test('status and stock chips derive their tint from the same semantic token', () => {
    for (const relative of [
      'pages/wellness/PrescriptionRequests.jsx',
      'pages/wellness/MyPrescriptionRequests.jsx',
    ]) {
      const source = code(read(relative));
      // Foreground and background move together, so they can never drift into
      // an unreadable pair on one of the two themes.
      expect(source).toMatch(/color-mix\(in srgb, var\(\$\{token\}\) \d+%, transparent\)/);
      expect(source).toMatch(/fg:\s*['"`]var\(--(success|warning|danger|accent)-color\)/);
    }
  });

  test('form fields use --input-bg, which is defined in both themes', () => {
    for (const relative of GUARDED_FILES) {
      const source = code(read(relative));
      if (!/placeholder=/.test(source)) continue;
      expect(source).toMatch(/background:\s*['"`]var\(--input-bg\)/);
    }
  });
});
