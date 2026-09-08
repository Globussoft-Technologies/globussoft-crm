/**
 * anchorDropdown — where a portal-rendered dropdown menu is allowed to sit.
 *
 * Two bugs live here, both from the menu being `position: fixed` and
 * re-anchored to its trigger on every scroll:
 *
 *   1. A menu that hangs off the bottom of the viewport can never be scrolled
 *      into view — scrolling the page just drags the menu along with the
 *      trigger. On the package builder that left the lower half of the
 *      validity list permanently unreachable.
 *   2. A menu that flips above the trigger has to be pinned by its BOTTOM
 *      edge. Pinning it by `top` at the 340px ceiling left a three-item list
 *      floating a couple of hundred pixels above its trigger, reading as the
 *      menu opening somewhere near the top of the page.
 *
 * The contract is therefore about CONTAINMENT and ADJACENCY: wherever the
 * trigger sits, the menu ends up wholly on screen and visually attached to it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  anchorDropdown,
  estimateDropdownHeight,
  DROPDOWN_MAX_HEIGHT,
} from '../pages/wellness/services/shared';

const VIEWPORT_H = 800;
const GAP = 8;
const MARGIN = 12;

// A fake trigger at a given vertical offset. Only getBoundingClientRect is
// consulted, so nothing needs to be in the DOM.
function triggerAt(top, { height = 40, left = 100, width = 300 } = {}) {
  return {
    getBoundingClientRect: () => ({ top, bottom: top + height, left, width, height, right: left + width }),
  };
}

// Where the menu's edges land, whichever edge it happens to be pinned by.
function edges(rect, viewportH = VIEWPORT_H) {
  const top = rect.openUp ? viewportH - rect.bottom - rect.maxHeight : rect.top;
  return { top, bottom: top + rect.maxHeight };
}

beforeEach(() => {
  window.innerHeight = VIEWPORT_H;
});

describe('anchorDropdown', () => {
  it('opens below the trigger when there is room, at full height', () => {
    const rect = anchorDropdown(triggerAt(100));

    expect(rect.openUp).toBe(false);
    expect(rect.top).toBe(148); // 100 + 40 + 8
    expect(rect.maxHeight).toBe(DROPDOWN_MAX_HEIGHT);
    expect(rect.left).toBe(100);
    expect(rect.width).toBe(300);
  });

  it('flips above the trigger when the space below is the smaller side', () => {
    // Trigger 120px from the bottom: ~60px below, ~660px above.
    const triggerTop = VIEWPORT_H - 120;
    const rect = anchorDropdown(triggerAt(triggerTop));

    expect(rect.openUp).toBe(true);
    // Pinned by its bottom edge, one gap above the trigger.
    expect(rect.bottom).toBe(VIEWPORT_H - triggerTop + GAP);
    expect(edges(rect).bottom).toBe(triggerTop - GAP);
    expect(edges(rect).top).toBeGreaterThanOrEqual(MARGIN);
  });

  it('keeps a short upward menu against the trigger, not floating above it', () => {
    // The reported bug: a 3-option tax menu opened from near the bottom used
    // to be placed a full 340px above the trigger, leaving a wide gap. Its
    // bottom edge must sit one gap above the trigger no matter how tall the
    // ceiling is.
    const triggerTop = VIEWPORT_H - 90;
    const short = anchorDropdown(triggerAt(triggerTop), { desiredHeight: estimateDropdownHeight(3) });
    const tall = anchorDropdown(triggerAt(triggerTop), { desiredHeight: estimateDropdownHeight(20) });

    expect(short.openUp).toBe(true);
    expect(short.bottom).toBe(tall.bottom); // same anchor regardless of height
    expect(edges(short).bottom).toBe(triggerTop - GAP);
    // And it is only as tall as three rows need.
    expect(short.maxHeight).toBeLessThan(tall.maxHeight);
    expect(short.maxHeight).toBe(estimateDropdownHeight(3));
  });

  it('keeps dropping down when the list is short enough to fit below', () => {
    // 3 options need ~126px and 292px are free below — flipping over the
    // trigger there is what made the menu feel like it jumped away.
    const rect = anchorDropdown(triggerAt(VIEWPORT_H - 320), {
      desiredHeight: estimateDropdownHeight(3),
    });

    expect(rect.openUp).toBe(false);
    expect(rect.top).toBe(VIEWPORT_H - 320 + 40 + GAP);
  });

  it('caps the height to the room available instead of overflowing', () => {
    // A short window, trigger mid-page: neither side fits a full-height menu.
    // 260px below beats 160px above, so it stays below — shortened to fit and
    // scrolling internally rather than spilling past the viewport edge.
    window.innerHeight = 500;
    const rect = anchorDropdown(triggerAt(180));

    expect(rect.openUp).toBe(false);
    expect(rect.top).toBe(228); // 180 + 40 + 8 — still below the trigger
    expect(rect.maxHeight).toBe(260);
    expect(rect.maxHeight).toBeLessThan(DROPDOWN_MAX_HEIGHT);
    expect(edges(rect, 500).bottom).toBeLessThanOrEqual(500 - MARGIN);
  });

  it('keeps the whole menu on screen wherever the trigger sits', () => {
    // The containment regression: every trigger position down the page must
    // yield a menu that fits between the viewport edges.
    for (let top = 0; top <= VIEWPORT_H - 40; top += 20) {
      const rect = anchorDropdown(triggerAt(top));
      const { top: menuTop, bottom: menuBottom } = edges(rect);
      expect(menuTop).toBeGreaterThanOrEqual(MARGIN);
      expect(menuBottom).toBeLessThanOrEqual(VIEWPORT_H - MARGIN);
      // A menu too short to show anything is no better than one off-screen.
      expect(rect.maxHeight).toBeGreaterThanOrEqual(140);
    }
  });

  it('honours an explicit max height for shorter lists', () => {
    const rect = anchorDropdown(triggerAt(100), { maxHeight: 200 });
    expect(rect.maxHeight).toBe(200);
  });
});

describe('estimateDropdownHeight', () => {
  it('grows with the row count and stops at the ceiling', () => {
    expect(estimateDropdownHeight(1)).toBeLessThan(estimateDropdownHeight(5));
    expect(estimateDropdownHeight(100)).toBe(DROPDOWN_MAX_HEIGHT);
  });

  it('never returns zero for an empty or unknown list', () => {
    // An empty menu still renders its "No options" row.
    expect(estimateDropdownHeight(0)).toBeGreaterThan(0);
    expect(estimateDropdownHeight(undefined)).toBeGreaterThan(0);
  });
});
