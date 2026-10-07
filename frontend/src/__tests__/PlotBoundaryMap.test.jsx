import { describe, expect, it, vi } from 'vitest';

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ children }) => <div>{children}</div>,
  MapContainer: ({ children }) => <div>{children}</div>,
  Polygon: ({ children }) => <div>{children}</div>,
  Polyline: () => <div />,
  TileLayer: () => <div />,
  Tooltip: ({ children }) => <span>{children}</span>,
  useMap: () => ({ invalidateSize: vi.fn(), fitBounds: vi.fn(), setView: vi.fn() }),
  useMapEvents: vi.fn(),
}));
vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('../lib/geocoder', () => ({ geocodeSuggest: vi.fn().mockResolvedValue([]) }));

import {
  calculateBoundaryAreaSqFt,
  coordinatesToText,
  parseCoordinateText,
} from '../utils/plotBoundary';

describe('PlotBoundaryMap coordinate helpers', () => {
  const boundary = [
    { latitude: 12.935, longitude: 77.61 },
    { latitude: 12.935, longitude: 77.6101 },
    { latitude: 12.9351, longitude: 77.6101 },
    { latitude: 12.9351, longitude: 77.61 },
  ];

  it('parses one latitude/longitude pair per line', () => {
    expect(parseCoordinateText('12.935, 77.61\n12.935 77.6101\n12.9351,77.6101')).toEqual(boundary.slice(0, 3));
  });

  it('rejects incomplete and out-of-range coordinates', () => {
    expect(() => parseCoordinateText('12,77\n13,78')).toThrow(/at least 3/i);
    expect(() => parseCoordinateText('91,77\n12,78\n13,79')).toThrow(/Line 1/i);
  });

  it('formats coordinates and calculates a mapped square-foot area', () => {
    expect(coordinatesToText(boundary)).toContain('12.9350000, 77.6100000');
    expect(calculateBoundaryAreaSqFt(boundary)).toBeGreaterThan(1200);
    expect(calculateBoundaryAreaSqFt(boundary)).toBeLessThan(1400);
  });
});
