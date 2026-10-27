import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/styles/travel-global-scaling.css'), 'utf8');

describe('Travel responsive typography', () => {
  it('keeps text token minimums readable as the viewport shrinks', () => {
    const tokens = [...css.matchAll(/--travel-(?:ui-(?:text|control|cell)|font-[\d-]+|dashboard-(?:label|meta)-size|sidebar-(?:nav|subnav|meta)-size):\s*([^;]+);/g)];
    expect(tokens.length).toBeGreaterThan(20);
    for (const [, value] of tokens) {
      const minimum = Number((value.match(/^(?:clamp\()?([\d.]+)rem/) || [])[1]);
      expect(minimum, value).toBeGreaterThanOrEqual(0.75);
    }
    expect(css).toMatch(/--travel-ui-control:\s*clamp\(0\.875rem/);
  });

  it('does not introduce sub-12px rem minima in direct font-size clamps', () => {
    const fontSizes = [...css.matchAll(/font-size:\s*clamp\(([\d.]+)rem/g)];
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const [, minimum] of fontSizes) expect(Number(minimum)).toBeGreaterThanOrEqual(0.75);
  });
});
