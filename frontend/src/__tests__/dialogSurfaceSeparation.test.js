/**
 * Regression guard for modal backdrop/panel separation across CRM themes.
 *
 * Many dialogs put role="dialog" on the full-screen backdrop. A global theme
 * rule that paints every role="dialog" element with --modal-bg therefore
 * turns the translucent backdrop opaque and hides the page behind the modal.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..');
const read = (relative) => readFileSync(resolve(SRC, relative), 'utf8');
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');

function dialogBackgroundRules(source) {
  const css = withoutComments(source);
  const offenders = [];

  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selectorList, declarations] = match;
    if (!/(?:^|;)\s*background(?:-color)?\s*:/.test(declarations)) continue;

    for (const selector of selectorList.split(',')) {
      // Component-specific selectors such as
      // `.generic-import-step-overlay[role="dialog"]` deliberately own their
      // surface. Only a bare role selector (global or below a theme scope) is
      // broad enough to recreate the regression.
      if (/(?:^|\s)\[role=["']dialog["']\]\s*$/.test(selector.trim())) {
        offenders.push(selector.trim());
      }
    }
  }

  return offenders;
}

describe('dialog backdrop and panel theme surfaces', () => {
  test('generic and travel styles never paint role=dialog backdrops globally', () => {
    expect(dialogBackgroundRules(read('index.css'))).toEqual([]);
    expect(dialogBackgroundRules(read('theme/travel.css'))).toEqual([]);
  });

  test('generic dialogs keep a translucent backdrop and opaque panel', () => {
    const source = read('components/DuplicateContactModal.jsx');

    expect(source).toMatch(/role="dialog"[\s\S]*?background:\s*"rgba\(0,0,0,0\.45\)"/);
    expect(source).toMatch(/background:\s*"var\(--surface-color\)"/);
  });

  test('wellness dialogs keep a translucent backdrop and themed glass panel', () => {
    const modal = read('components/wellness/ModalShell.jsx');
    const globalStyles = withoutComments(read('index.css'));

    expect(modal).toMatch(/role="dialog"[\s\S]*?background:\s*"rgba\(0,0,0,0\.45\)"/);
    expect(modal).toMatch(/className="glass"/);
    expect(globalStyles).toMatch(/\.glass\s*\{[^}]*background:\s*var\(--glass-bg\)/s);
  });

  test('travel dialogs keep a translucent backdrop and opaque panel', () => {
    const source = read('pages/travel/ItineraryTemplates.jsx');

    expect(source).toMatch(/role="dialog"[\s\S]*?background:\s*'rgba\(0, 0, 0, 0\.5\)'/);
    expect(source).toMatch(/background:\s*'var\(--surface-color\)'/);
  });
});
