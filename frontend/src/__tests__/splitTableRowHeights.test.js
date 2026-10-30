import { describe, it, expect, vi } from 'vitest';
import { syncSplitTableRowHeights, observeSplitTableRowHeights } from '../utils/splitTableRowHeights';

function table(heights) {
  const element = document.createElement('table');
  element.innerHTML = '<thead><tr><th>Name</th></tr></thead><tbody>'
    + heights.slice(1).map(() => '<tr><td>Content</td></tr>').join('') + '</tbody>';
  element.querySelectorAll('tr').forEach((row, index) => {
    row.getBoundingClientRect = vi.fn(() => {
      expect(row.style.height).toBe('');
      return { height: heights[index] };
    });
  });
  return element;
}

describe('split table row heights', () => {
  it('shares the larger natural height for each header and body row', () => {
    const left = table([50, 66, 52]);
    const right = table([60, 52, 90]);
    syncSplitTableRowHeights(left, right);
    for (const element of [left, right]) {
      expect([...element.querySelectorAll('tr')].map(row => row.style.height)).toEqual(['60px', '66px', '90px']);
    }
  });
  it('clears previous measurements so content can shrink', () => {
    const heights = [50, 110];
    const left = table(heights);
    const right = table([50, 52]);
    syncSplitTableRowHeights(left, right);
    heights[1] = 66;
    syncSplitTableRowHeights(left, right);
    expect(left.querySelector('tbody tr').style.height).toBe('66px');
    expect(right.querySelector('tbody tr').style.height).toBe('66px');
  });
  it('does not pair rows while tables have different row counts', () => {
    const left = table([50, 66]);
    const right = table([50]);
    syncSplitTableRowHeights(left, right);
    expect(left.querySelector('tbody tr').style.height).toBe('');
  });
  it('disconnects observers and restores styles on cleanup', () => {
    const left = table([50, 66]);
    const right = table([50, 52]);
    const cleanup = observeSplitTableRowHeights(left, right);
    expect(left.querySelector('tbody tr').style.height).toBe('66px');
    cleanup();
    expect([...left.querySelectorAll('tr'), ...right.querySelectorAll('tr')].every(row => row.style.height === '')).toBe(true);
  });
});
