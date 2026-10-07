import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  normalizeBoundary,
  calculateBoundaryAreaSqFt,
  parseStoredBoundary,
} = requireCJS('../../lib/plotBoundary');

describe('plotBoundary', () => {
  const square = [
    { latitude: 12.935, longitude: 77.61 },
    { latitude: 12.935, longitude: 77.6101 },
    { latitude: 12.9351, longitude: 77.6101 },
    { latitude: 12.9351, longitude: 77.61 },
  ];

  test('normalizes object, tuple, and closed-ring coordinate input', () => {
    expect(normalizeBoundary([
      [12.935, 77.61],
      { lat: 12.935, lng: 77.6101 },
      { latitude: 12.9351, longitude: 77.6101 },
      [12.935, 77.61],
    ])).toEqual([
      { latitude: 12.935, longitude: 77.61 },
      { latitude: 12.935, longitude: 77.6101 },
      { latitude: 12.9351, longitude: 77.6101 },
    ]);
  });

  test('calculates a positive square-foot area for a GPS polygon', () => {
    expect(calculateBoundaryAreaSqFt(square)).toBeGreaterThan(1200);
    expect(calculateBoundaryAreaSqFt(square)).toBeLessThan(1400);
  });

  test('rejects invalid and degenerate boundaries', () => {
    expect(() => normalizeBoundary([{ lat: 91, lng: 77 }, [12, 77], [13, 77]])).toThrow(/invalid/i);
    expect(() => calculateBoundaryAreaSqFt([[12, 77], [12, 77], [12, 77]])).toThrow(/distinct/i);
  });

  test('fails soft when legacy stored JSON is malformed', () => {
    expect(parseStoredBoundary('not-json')).toEqual([]);
    expect(parseStoredBoundary(JSON.stringify(square))).toEqual(square);
  });
});
