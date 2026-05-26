/**
 * Tests for frontend/src/utils/timing.js — Tick #139.
 *
 * What's tested
 *   - SEARCH_DEBOUNCE_MS is exported as a number (not a string / undefined).
 *   - Its value is exactly 300ms — the value pen-test #548 settled on after
 *     finding Patients at 250ms vs Omnibar at 300ms.
 *   - Value sits in a sane interactive-feel band (>=150ms feels live, <=500ms
 *     before a typist notices lag). Pins the design intent, not just the literal.
 *
 * Why
 *   This module is a single-constant shared-timing source. Two existing
 *   consumers (Patients search, Omnibar) import it. A regression that flipped
 *   the value to 0 (instant — would hammer the backend per keystroke) or to a
 *   string (`"300"` — millisecond math elsewhere would coerce silently and
 *   create flake) would be invisible without coverage.
 *
 * Contract pinned
 *   - export const SEARCH_DEBOUNCE_MS: number === 300
 *   - Lives in the interactive-feel window 150..500ms
 *
 * Scaled down from the dispatch's debounce/throttle/sleep enumeration because
 * the SUT only exports one numeric constant — no functions to exercise. If
 * future modules (Contacts/Deals/etc.) add helpers here, extend this file.
 */

import { describe, it, expect } from 'vitest';
import * as timing from '../utils/timing';
import { SEARCH_DEBOUNCE_MS } from '../utils/timing';

describe('utils/timing — SEARCH_DEBOUNCE_MS', () => {
  it('is exported as a finite number', () => {
    expect(typeof SEARCH_DEBOUNCE_MS).toBe('number');
    expect(Number.isFinite(SEARCH_DEBOUNCE_MS)).toBe(true);
    expect(Number.isNaN(SEARCH_DEBOUNCE_MS)).toBe(false);
  });

  it('is exactly 300ms — the pen-test #548 reconciled value', () => {
    // Hard-pin the literal so a casual edit to (say) 250 or 500 reds the gate
    // and the author has to justify the change in the diff.
    expect(SEARCH_DEBOUNCE_MS).toBe(300);
  });

  it('sits inside the interactive-feel window (150..500ms)', () => {
    // Below 150ms: a typist's burst becomes N fetches → backend hammered.
    // Above 500ms: noticeable lag, users assume the box is broken.
    expect(SEARCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(150);
    expect(SEARCH_DEBOUNCE_MS).toBeLessThanOrEqual(500);
  });

  it('is positive and non-zero (0ms would defeat debouncing)', () => {
    expect(SEARCH_DEBOUNCE_MS).toBeGreaterThan(0);
  });

  it('module exposes SEARCH_DEBOUNCE_MS on the namespace import', () => {
    // Catches accidental rename via default-export refactor.
    expect(timing.SEARCH_DEBOUNCE_MS).toBe(SEARCH_DEBOUNCE_MS);
  });
});
