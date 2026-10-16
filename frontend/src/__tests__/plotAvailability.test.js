import { describe, expect, it } from 'vitest';
import {
  expandPlotGroupKeys,
  groupPlotsByName,
  isAssignablePlot,
  selectedPlotGroupKeys,
} from '../utils/plotAvailability';

describe('plotAvailability helpers', () => {
  it('treats booked, reserved, and sold plots as unavailable case-insensitively', () => {
    expect(isAssignablePlot({ availability: 'booked' })).toBe(false);
    expect(isAssignablePlot({ availability: 'RESERVED' })).toBe(false);
    expect(isAssignablePlot({ availability: 'Sold' })).toBe(false);
    expect(isAssignablePlot({ availability: 'AVAILABLE' })).toBe(true);
  });

  it('groups plot-number rows by a trimmed, case-insensitive site name', () => {
    const plots = [
      { id: 10, name: ' Green Acres ', plotNumber: 'A-1' },
      { id: 11, name: 'green acres', plotNumber: 'A-2' },
      { id: 12, name: 'Lake View', plotNumber: 'B-1' },
      { id: 13, name: '', plotNumber: 'C-1' },
    ];

    expect(groupPlotsByName(plots)).toEqual([
      expect.objectContaining({ key: 'green acres', name: 'Green Acres', representative: plots[0], plotIds: [10, 11] }),
      expect.objectContaining({ key: 'lake view', name: 'Lake View', representative: plots[2], plotIds: [12] }),
      expect.objectContaining({ key: 'plot-13', name: 'Unnamed plot', representative: plots[3], plotIds: [13] }),
    ]);
  });

  it('round-trips selected plot ids through grouped site keys', () => {
    const groups = groupPlotsByName([
      { id: 10, name: 'Green Acres' },
      { id: 11, name: 'green acres' },
      { id: 12, name: 'Lake View' },
    ]);

    const selectedKeys = selectedPlotGroupKeys(groups, ['11', 12]);
    expect(selectedKeys).toEqual(['green acres', 'lake view']);
    expect(expandPlotGroupKeys(groups, selectedKeys)).toEqual([10, 11, 12]);
  });
});
