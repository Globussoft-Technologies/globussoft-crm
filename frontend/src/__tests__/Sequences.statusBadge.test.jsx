/**
 * Sequences status-badge regression spec — issue #640.
 *
 * Pre-fix: ACTIVE rendered as `#10b981` (green) and PAUSED rendered as
 * a white-transparent surface with `var(--text-secondary)` text — both
 * looked the same family at a glance and were indistinguishable for
 * colour-blind users. Marketers misread paused sequences as still
 * running.
 *
 * Gap-card-vs-reality drift documented:
 *   - Card listed ACTIVE / PAUSED / DRAFT / ARCHIVED. The Sequence schema
 *     today has only `isActive: Boolean` (Sequence model in
 *     prisma/schema.prisma:679). The route renders ACTIVE/PAUSED only.
 *     The helper exposes a DRAFT fall-through for forward-compat when the
 *     enum lands; this spec pins ACTIVE + PAUSED + DRAFT (no ARCHIVED yet).
 *
 * Test pins: status → palette mapping via the exported helper
 * `sequenceStatusBadgeStyle`, NOT via literal hex in the rendered DOM.
 * Asserting via class name (`badge-active` / `badge-paused` /
 * `badge-draft`) and the helper's return value lets the rendered
 * surface evolve (e.g. switch to a CSS-token system later) without
 * breaking the test.
 */
import { describe, it, expect } from 'vitest';
import { sequenceStatusBadgeStyle } from '../pages/Sequences';

describe('sequenceStatusBadgeStyle — #640', () => {
  it('ACTIVE renders with success-green palette', () => {
    const p = sequenceStatusBadgeStyle('ACTIVE');
    expect(p.cls).toBe('badge-active');
    // colour string references the success var (or the green hex fallback)
    expect(p.fg).toMatch(/success-color|#10b981/);
  });

  it('PAUSED renders with warning-amber palette (NOT green)', () => {
    const p = sequenceStatusBadgeStyle('PAUSED');
    expect(p.cls).toBe('badge-paused');
    // colour string references the warning var (or amber hex fallback)
    expect(p.fg).toMatch(/warning-color|#f59e0b/);
    // explicit drift guard: PAUSED must not pick up the green family
    expect(p.fg).not.toMatch(/success-color|#10b981/);
    expect(p.cls).not.toBe('badge-active');
  });

  it('PAUSED background is amber-tinted, not green-tinted', () => {
    const p = sequenceStatusBadgeStyle('PAUSED');
    // 245,158,11 is the amber rgb
    expect(p.bg).toMatch(/245.*158.*11/);
    // 16,185,129 is the green rgb — must NOT appear
    expect(p.bg).not.toMatch(/16.*185.*129/);
  });

  it('DRAFT renders with neutral text-secondary palette', () => {
    const p = sequenceStatusBadgeStyle('DRAFT');
    expect(p.cls).toBe('badge-draft');
    expect(p.fg).toMatch(/text-secondary/);
  });

  it('unknown status falls through to DRAFT (neutral grey)', () => {
    const p = sequenceStatusBadgeStyle('SOMETHING_NEW');
    expect(p.cls).toBe('badge-draft');
  });

  it('ACTIVE and PAUSED do not share a class name (visually distinguishable)', () => {
    const a = sequenceStatusBadgeStyle('ACTIVE');
    const p = sequenceStatusBadgeStyle('PAUSED');
    expect(a.cls).not.toBe(p.cls);
    expect(a.fg).not.toBe(p.fg);
  });
});
