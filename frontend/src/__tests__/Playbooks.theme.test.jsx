/**
 * Playbooks.theme.test.jsx — source-level pins for the white-theme
 * invisibility incident (Sales Playbooks page).
 *
 * The page hardcoded a dark-theme palette: near-white button text
 * (`#e2e8f0`) on near-white secondary backgrounds, dark-navy surface
 * rgba() boxes, and `#94a3b8` body text. On the white/light theme the
 * Edit + Duplicate buttons vanished entirely (white-on-white) and cards,
 * inputs, selects, and the editor modal rendered dark boxes that clashed
 * with the light page.
 *
 * The fix routes every surface through theme CSS vars (with the old dark
 * values kept ONLY as var() fallbacks). These tests pin the file so a
 * future edit reintroducing a bare dark-only literal reds the suite.
 * Pattern reference: Reports.cellStyle.test.jsx (source-level grep pins).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

function playbooksSrc() {
  return readFileSync(path.join(REPO_ROOT, 'src/pages/Playbooks.jsx'), 'utf8');
}

describe('Playbooks white-theme readability — surfaces resolve through CSS vars', () => {
  it('glassCard background resolves through --surface-color', () => {
    const src = playbooksSrc();
    expect(src).toMatch(/glassCard\s*=\s*\{[^}]*background:\s*['"]var\(--surface-color/);
    expect(src).toMatch(/glassCard\s*=\s*\{[^}]*border:\s*['"]1px solid var\(--border-color/);
  });

  it('inputStyle resolves through --input-bg/--border-color/--text-primary and sets colorScheme', () => {
    const src = playbooksSrc();
    expect(src).toMatch(/inputStyle\s*=\s*\{[\s\S]*?background:\s*['"]var\(--input-bg/);
    expect(src).toMatch(/inputStyle\s*=\s*\{[\s\S]*?color:\s*['"]var\(--text-primary/);
    expect(src).toMatch(/inputStyle\s*=\s*\{[\s\S]*?colorScheme:\s*['"]light dark['"]/);
  });

  it('secondary buttons use --text-primary (not near-white #e2e8f0)', () => {
    const src = playbooksSrc();
    expect(src).toMatch(/secondary:\s*\{[^}]*color:\s*['"]var\(--text-primary/);
    expect(src).toMatch(/ghost:\s*\{[^}]*color:\s*['"]var\(--text-secondary/);
  });

  it('no bare near-white #e2e8f0 text literals outside var() fallbacks', () => {
    // Bare `color: '#e2e8f0'` was the Edit/Duplicate invisibility bug.
    // Every remaining #e2e8f0 sits inside a var() fallback, which this
    // pattern (colon-quote immediately before the hex) does not match.
    const src = playbooksSrc();
    expect(src.match(/:\s*['"]#e2e8f0['"]/g) || []).toHaveLength(0);
  });

  it('no bare muted #94a3b8 text literals except the Lead stage badge color', () => {
    // The single allowed instance is the STAGES palette entry for the Lead
    // stage badge — a data color paired with its own tinted background,
    // readable on both themes. Body/label text must use --text-secondary.
    const src = playbooksSrc();
    expect(src).toMatch(/label:\s*['"]Lead['"],\s*color:\s*['"]#94a3b8['"]/);
    expect(src.match(/color:\s*['"]#94a3b8['"]/g) || []).toHaveLength(1);
  });

  it('no bare dark-navy rgba(15,23,42 backgrounds outside var() fallbacks', () => {
    const src = playbooksSrc();
    expect(src.match(/background:\s*['"]rgba\(15,23,42/g) || []).toHaveLength(0);
  });

  it('no bare white rgba(255,255,255 borders outside var() fallbacks', () => {
    const src = playbooksSrc();
    expect(src.match(/border:\s*['"]1px solid rgba\(255,255,255/g) || []).toHaveLength(0);
  });

  it('no bare #cbd5e1 label literals', () => {
    const src = playbooksSrc();
    expect(src.match(/['"]#cbd5e1['"]/g) || []).toHaveLength(0);
  });
});
