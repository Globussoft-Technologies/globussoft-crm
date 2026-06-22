// destinationTheme — pure visual-theme resolver for public travel pages.
// Verifies curated matches (+ aliases), the deterministic fallback for unknown
// destinations, stability, and the Wikipedia title used for photo lookup.
import { describe, it, expect } from 'vitest';
import { destinationTheme } from '../utils/destinationTheme';

describe('destinationTheme — curated destinations', () => {
  it('resolves Paris with its motif + accent + wiki title', () => {
    const t = destinationTheme('Paris');
    expect(t.key).toBe('paris');
    expect(t.motif).toBe('🗼');
    expect(t.accent).toBe('#2E5AAC');
    expect(t.gradient).toContain('linear-gradient');
    expect(t.wikiTitle).toBe('Paris');
  });

  it('resolves Banaras / Varanasi aliases to the same theme', () => {
    expect(destinationTheme('Banaras').key).toBe('varanasi');
    expect(destinationTheme('Varanasi (Kashi)').key).toBe('varanasi');
    expect(destinationTheme('banarash').motif).toBe('🛕');
  });

  it('maps curated wiki titles that differ from the label', () => {
    expect(destinationTheme('Makkah').wikiTitle).toBe('Mecca');
    expect(destinationTheme('Madinah').wikiTitle).toBe('Medina');
    expect(destinationTheme('New York').wikiTitle).toBe('New York City');
  });

  it('matches a destination embedded in a longer string', () => {
    expect(destinationTheme('Paris, France').key).toBe('paris');
    expect(destinationTheme('10-day Umrah — Makkah & Madinah').key).toBe('makkah');
  });
});

describe('destinationTheme — unknown destinations (smart fallback)', () => {
  it('returns a generated theme with the generic motif + no curated wiki title', () => {
    const t = destinationTheme('Wakanda');
    expect(t.key).toBeNull();
    expect(t.motif).toBe('✈️');
    expect(t.gradient).toMatch(/^linear-gradient\(135deg,hsl\(/);
    expect(t.wikiTitle).toBeNull();
  });

  it('is deterministic — same destination yields the same theme', () => {
    expect(destinationTheme('Reykjavik')).toEqual(destinationTheme('Reykjavik'));
  });

  it('handles empty / null safely', () => {
    const t = destinationTheme('');
    expect(t.key).toBeNull();
    expect(t.motif).toBe('✈️');
  });
});
