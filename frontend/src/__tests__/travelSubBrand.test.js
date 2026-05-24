/**
 * travelSubBrand.test.js — vitest unit coverage for
 * frontend/src/utils/travelSubBrand.js (rule-of-3-extracted helper shipped
 * tick #99 commit 9310196 from SuppliersAdmin + QuotesAdmin + InvoicesAdmin).
 *
 * Scope — pure helper, no I/O, no React, no mocks needed:
 *   1. SUB_BRAND_IDS canonical id set — [tmc, rfu, travelstall, visasure]
 *      ordering matches dropdown render order (per DD-5.1 Q25 sub-brand
 *      isolation). Drift here means a sub-brand was added/removed/reordered
 *      without updating the dropdown contract.
 *   2. SUB_BRAND_BG palette — every canonical id maps to a non-empty rgba()
 *      string. Pinned values match the placeholder palette pending Yasin's
 *      Q22 brand pack handoff; when Yasin's pack lands, these values become
 *      the single replace-point (per SUT header).
 *   3. SUB_BRAND_LABEL human-readable map — every canonical id has a friendly
 *      label distinct from the raw id (catches accidental "tmc → 'tmc'" rot).
 *   4. SUB_BRAND_BG_FALLBACK constant — flat string per SUT shape, matches
 *      the literal fallback the 3 retrofitted callsites used inline.
 *   5. subBrandBackground(id) — known id → palette entry; unknown id →
 *      fallback; null / undefined / "" → fallback. The `||` fallback shape
 *      is exact-pinned (returns the FALLBACK string, not the id-as-string).
 *   6. subBrandLabel(id) — known id → human label; unknown id → "(<id>)"
 *      pretty-print; null / undefined / "" → em-dash "—".
 *   7. Cross-consistency invariant — SUB_BRAND_IDS, SUB_BRAND_BG, and
 *      SUB_BRAND_LABEL all cover the same id set (catches an id added to
 *      one map but not the others).
 *
 * Drift pinned around (prompt vs. actual SUT exports):
 *   - Prompt referenced `subBrandBadgeStyle(key)` returning a style object;
 *     actual export is `subBrandBackground(key)` returning a flat rgba()
 *     STRING. Tests pin the real shape (string return, not object).
 *   - Prompt referenced "SUB_BRAND_BG[key] flat string OR {bg, fg} object";
 *     SUT explicitly preserves the flat string shape (per SUT header — "We
 *     preserve that shape exactly so the 3 retrofitted callers don't need
 *     any logic change"). Tests assert flat-string shape.
 *
 * Mocking discipline: none — pure helper, no I/O, no React, no hooks.
 */
import { describe, it, expect } from 'vitest';
import {
  SUB_BRAND_BG,
  SUB_BRAND_LABEL,
  SUB_BRAND_IDS,
  SUB_BRAND_BG_FALLBACK,
  subBrandBackground,
  subBrandLabel,
} from '../utils/travelSubBrand';

describe('travelSubBrand — constants', () => {
  it('SUB_BRAND_IDS contains the 4 canonical sub-brand identifiers in dropdown order', () => {
    expect(SUB_BRAND_IDS).toEqual(['tmc', 'rfu', 'travelstall', 'visasure']);
  });

  it('SUB_BRAND_BG maps every canonical id to a non-empty rgba() string (flat-string shape)', () => {
    for (const id of SUB_BRAND_IDS) {
      const bg = SUB_BRAND_BG[id];
      expect(typeof bg).toBe('string');
      expect(bg.length).toBeGreaterThan(0);
      expect(bg).toMatch(/^rgba\(/);
    }
    // Pin the placeholder palette values verbatim — they become the single
    // replace-point when Yasin's Q22 brand pack lands.
    expect(SUB_BRAND_BG.tmc).toBe('rgba(18, 38, 71, 0.18)');
    expect(SUB_BRAND_BG.rfu).toBe('rgba(38, 88, 85, 0.18)');
    expect(SUB_BRAND_BG.travelstall).toBe('rgba(200, 154, 78, 0.18)');
    expect(SUB_BRAND_BG.visasure).toBe('rgba(99, 102, 241, 0.18)');
  });

  it('SUB_BRAND_LABEL maps every canonical id to a human-readable label distinct from the id', () => {
    for (const id of SUB_BRAND_IDS) {
      const label = SUB_BRAND_LABEL[id];
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(id); // Catches accidental "tmc → 'tmc'" rot.
    }
    expect(SUB_BRAND_LABEL.tmc).toBe('TMC (School trips)');
    expect(SUB_BRAND_LABEL.rfu).toBe('RFU (Umrah)');
    expect(SUB_BRAND_LABEL.travelstall).toBe('Travel Stall (Family)');
    expect(SUB_BRAND_LABEL.visasure).toBe('Visa Sure');
  });

  it('SUB_BRAND_BG_FALLBACK is a flat rgba string matching the inline-callsite literal', () => {
    expect(SUB_BRAND_BG_FALLBACK).toBe('rgba(255,255,255,0.08)');
  });
});

describe('travelSubBrand — subBrandBackground()', () => {
  it('returns the palette entry for each known sub-brand id', () => {
    expect(subBrandBackground('tmc')).toBe(SUB_BRAND_BG.tmc);
    expect(subBrandBackground('rfu')).toBe(SUB_BRAND_BG.rfu);
    expect(subBrandBackground('travelstall')).toBe(SUB_BRAND_BG.travelstall);
    expect(subBrandBackground('visasure')).toBe(SUB_BRAND_BG.visasure);
  });

  it('returns SUB_BRAND_BG_FALLBACK for an unknown sub-brand id', () => {
    expect(subBrandBackground('unknown-brand')).toBe(SUB_BRAND_BG_FALLBACK);
    expect(subBrandBackground('wellness')).toBe(SUB_BRAND_BG_FALLBACK);
  });

  it('returns SUB_BRAND_BG_FALLBACK for null / undefined / empty string', () => {
    expect(subBrandBackground(null)).toBe(SUB_BRAND_BG_FALLBACK);
    expect(subBrandBackground(undefined)).toBe(SUB_BRAND_BG_FALLBACK);
    expect(subBrandBackground('')).toBe(SUB_BRAND_BG_FALLBACK);
  });

  it('does not crash on no argument (defaults via the || fallback)', () => {
    expect(() => subBrandBackground()).not.toThrow();
    expect(subBrandBackground()).toBe(SUB_BRAND_BG_FALLBACK);
  });
});

describe('travelSubBrand — subBrandLabel()', () => {
  it('returns the human label for each known sub-brand id', () => {
    expect(subBrandLabel('tmc')).toBe('TMC (School trips)');
    expect(subBrandLabel('rfu')).toBe('RFU (Umrah)');
    expect(subBrandLabel('travelstall')).toBe('Travel Stall (Family)');
    expect(subBrandLabel('visasure')).toBe('Visa Sure');
  });

  it('returns "(<id>)" pretty-print for an unknown sub-brand id', () => {
    expect(subBrandLabel('unknown-brand')).toBe('(unknown-brand)');
    expect(subBrandLabel('wellness')).toBe('(wellness)');
  });

  it('returns em-dash "—" for null / undefined / empty string', () => {
    expect(subBrandLabel(null)).toBe('—');
    expect(subBrandLabel(undefined)).toBe('—');
    expect(subBrandLabel('')).toBe('—');
  });

  it('does not crash on no argument', () => {
    expect(() => subBrandLabel()).not.toThrow();
    expect(subBrandLabel()).toBe('—');
  });
});

describe('travelSubBrand — cross-map consistency', () => {
  it('SUB_BRAND_IDS, SUB_BRAND_BG, and SUB_BRAND_LABEL all cover the same id set', () => {
    const bgKeys = Object.keys(SUB_BRAND_BG).sort();
    const labelKeys = Object.keys(SUB_BRAND_LABEL).sort();
    const idsSorted = [...SUB_BRAND_IDS].sort();
    expect(bgKeys).toEqual(idsSorted);
    expect(labelKeys).toEqual(idsSorted);
  });
});
