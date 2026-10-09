import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

describe('Pickup & Plot table scroll cards', () => {
  it('disables the global card shimmer that creates phantom horizontal overflow', () => {
    expect(css).toMatch(/\.card\.pickup-plot-table-scroll::before\s*\{[^}]*display:\s*none\s*;/s);
  });

  it('does not translate table scroll cards on hover', () => {
    expect(css).toMatch(/\.card\.pickup-plot-table-scroll:hover\s*\{[^}]*transform:\s*none\s*;/s);
  });
});
