import { describe, expect, it } from 'vitest';
import { anchoredMenuPosition } from '../utils/anchoredMenuPosition';

describe('anchoredMenuPosition', () => {
  it('opens downward when there is sufficient space', () => {
    expect(anchoredMenuPosition({ top: 60, bottom: 90, right: 400 }, 1000, 800))
      .toMatchObject({ position: 'fixed', left: 136, top: 96, bottom: 'auto', maxHeight: 420 });
  });

  it('uses the larger space on a short viewport instead of the old upward-opening threshold', () => {
    const style = anchoredMenuPosition({ top: 276, bottom: 306, right: 400 }, 1000, 600);
    expect(style).toMatchObject({ top: 312, bottom: 'auto', maxHeight: 280 });
    expect(style.top + style.maxHeight).toBe(592);
  });

  it('opens upward near the viewport bottom', () => {
    expect(anchoredMenuPosition({ top: 550, bottom: 580, right: 400 }, 1000, 600))
      .toMatchObject({ top: 'auto', bottom: 56, maxHeight: 420 });
  });

  it('clamps the width and horizontal position on narrow screens', () => {
    expect(anchoredMenuPosition({ top: 50, bottom: 80, right: 40 }, 240, 600))
      .toMatchObject({ width: 224, left: 8, boxSizing: 'border-box' });
  });
});
