import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * frontend/src/components/MapPreview.jsx
 *
 * What's tested
 *   - Renders a marker per pinnable item (items with finite lat/lng).
 *   - Items without lat/lng are silently skipped (no crash, no marker).
 *   - Empty / null items renders an empty-state map (zero markers).
 *   - centerLat/centerLng override the auto-fit bbox path.
 *   - onMarkerClick fires with the clicked item.
 *   - Distinct colours per dayNumber rotate through the palette.
 *   - OSM attribution text is visible in the DOM.
 *   - Popup shows "Day N: locationName" verbatim.
 *   - colorForDay helper is stable + palette-rotated.
 *   - computeBounds returns null on empty + a 2-corner box on items.
 *   - pinnableItems helper strips draft rows correctly.
 *
 * Why
 *   MapPreview is consumed by Itineraries.jsx, ItineraryDetail.jsx, and
 *   ItineraryDayEditor.jsx (S9). The "skip draft rows without lat/lng"
 *   behaviour is the load-bearing fail-soft path — the editor will hand
 *   us items mid-construction. The OSM attribution is a license
 *   requirement (no attribution = OSM tile policy violation).
 *
 * jsdom note
 *   Leaflet renders via the real DOM (getBoundingClientRect, transforms)
 *   which jsdom does NOT model. We mock react-leaflet to stub the heavy
 *   DOM and pin the prop-passing contract instead — what the component
 *   PASSES to MapContainer/Marker/Popup is what we care about.
 *
 * S83 — print-CSS hardening
 *   The attribution overlay gained a stable className
 *   `map-preview__attribution` (and the outer wrapper gained
 *   `.map-preview`) so frontend/src/styles/print.css can target them
 *   inside @media print blocks. jsdom does NOT evaluate @media print
 *   rules, so this suite cannot directly assert the print-mode style
 *   computation — what we CAN pin (and do, below) is the className +
 *   text contract that the print-css rules depend on. If a future
 *   refactor drops the className, the print rule stops applying
 *   silently; these tests turn that into a loud failure.
 */

vi.mock('react-leaflet', () => {
  const React = require('react');
  const MapContainer = ({ children, center, zoom, ...rest }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'map-container',
        'data-center': JSON.stringify(center),
        'data-zoom': String(zoom),
        ...rest,
      },
      children,
    );
  const TileLayer = ({ attribution, url, ...rest }) =>
    React.createElement('div', {
      'data-testid': 'tile-layer',
      'data-attribution': attribution,
      'data-url': url,
      ...rest,
    });
  const Marker = ({ children, position, eventHandlers, ...rest }) =>
    React.createElement(
      'div',
      {
        'data-testid': rest['data-testid'] || 'marker',
        'data-position': JSON.stringify(position),
        'data-day-color': rest['data-day-color'],
        onClick: () => {
          if (eventHandlers && typeof eventHandlers.click === 'function') {
            eventHandlers.click({});
          }
        },
      },
      children,
    );
  const Popup = ({ children, ...rest }) =>
    React.createElement(
      'div',
      { 'data-testid': rest['data-testid'] || 'popup', ...rest },
      children,
    );
  const useMap = () => ({
    fitBounds: vi.fn(),
    setView: vi.fn(),
  });
  return { MapContainer, TileLayer, Marker, Popup, useMap };
});

// Stub the leaflet CSS import so it doesn't error in jsdom.
vi.mock('leaflet/dist/leaflet.css', () => ({}));

import MapPreview, {
  colorForDay,
  pinnableItems,
  computeBounds,
} from '../components/MapPreview';

const SAMPLE_ITEMS = [
  { id: 'i1', latitude: 15.2993, longitude: 74.124, locationName: 'Calangute', dayNumber: 1, sortOrder: 0 },
  { id: 'i2', latitude: 15.55, longitude: 73.755, locationName: 'Anjuna', dayNumber: 1, sortOrder: 1 },
  { id: 'i3', latitude: 15.05, longitude: 73.99, locationName: 'Palolem', dayNumber: 2, sortOrder: 0 },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('colorForDay', () => {
  it('returns a hex colour from the palette', () => {
    expect(colorForDay(1)).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(colorForDay(2)).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('rotates through the palette beyond 8 days', () => {
    expect(colorForDay(1)).toBe(colorForDay(9));
    expect(colorForDay(2)).toBe(colorForDay(10));
  });

  it('falls back to day-1 colour for non-finite / sub-1 input', () => {
    const d1 = colorForDay(1);
    expect(colorForDay(0)).toBe(d1);
    expect(colorForDay(NaN)).toBe(d1);
    expect(colorForDay('not-a-number')).toBe(d1);
  });

  it('different days within the palette range produce different colours', () => {
    const colours = new Set([1, 2, 3, 4].map(colorForDay));
    expect(colours.size).toBe(4);
  });
});

describe('pinnableItems', () => {
  it('returns only items with finite lat/lng', () => {
    const items = [
      { id: 'a', latitude: 1, longitude: 2 },
      { id: 'b', latitude: null, longitude: 2 },        // draft
      { id: 'c', latitude: 1, longitude: undefined },   // draft
      { id: 'd', latitude: 'not-a-number', longitude: 2 },
      { id: 'e', latitude: 3, longitude: 4 },
    ];
    const result = pinnableItems(items);
    expect(result.map((it) => it.id)).toEqual(['a', 'e']);
  });

  it('handles null / non-array input gracefully', () => {
    expect(pinnableItems(null)).toEqual([]);
    expect(pinnableItems(undefined)).toEqual([]);
    expect(pinnableItems('not-an-array')).toEqual([]);
  });
});

describe('computeBounds', () => {
  it('returns null on empty / null items', () => {
    expect(computeBounds([])).toBeNull();
    expect(computeBounds(null)).toBeNull();
  });

  it('returns [[minLat, minLng], [maxLat, maxLng]] for multi-pin input', () => {
    const bounds = computeBounds(SAMPLE_ITEMS);
    expect(bounds).toEqual([[15.05, 73.755], [15.55, 74.124]]);
  });

  it('returns a degenerate box for a single pin', () => {
    const bounds = computeBounds([SAMPLE_ITEMS[0]]);
    expect(bounds).toEqual([[15.2993, 74.124], [15.2993, 74.124]]);
  });
});

describe('<MapPreview />', () => {
  it('renders the map container with OSM tile layer and attribution', () => {
    render(<MapPreview items={SAMPLE_ITEMS} />);
    expect(screen.getByTestId('map-container')).toBeInTheDocument();
    const tile = screen.getByTestId('tile-layer');
    expect(tile).toHaveAttribute(
      'data-url',
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    );
    expect(tile.getAttribute('data-attribution')).toMatch(/OpenStreetMap/);
  });

  it('renders one marker per pinnable item', () => {
    render(<MapPreview items={SAMPLE_ITEMS} />);
    expect(screen.getByTestId('marker-i1')).toBeInTheDocument();
    expect(screen.getByTestId('marker-i2')).toBeInTheDocument();
    expect(screen.getByTestId('marker-i3')).toBeInTheDocument();
    expect(screen.getByTestId('map-preview')).toHaveAttribute('data-pin-count', '3');
  });

  it('skips items without lat/lng', () => {
    const items = [
      ...SAMPLE_ITEMS,
      { id: 'draft', latitude: null, longitude: null, locationName: 'TBD', dayNumber: 3 },
    ];
    render(<MapPreview items={items} />);
    expect(screen.queryByTestId('marker-draft')).not.toBeInTheDocument();
    expect(screen.getByTestId('map-preview')).toHaveAttribute('data-pin-count', '3');
  });

  it('renders an empty-state map when items is empty', () => {
    render(<MapPreview items={[]} />);
    expect(screen.getByTestId('map-container')).toBeInTheDocument();
    expect(screen.getByTestId('map-preview')).toHaveAttribute('data-pin-count', '0');
  });

  it('renders an empty-state map when items is null', () => {
    render(<MapPreview items={null} />);
    expect(screen.getByTestId('map-container')).toBeInTheDocument();
    expect(screen.getByTestId('map-preview')).toHaveAttribute('data-pin-count', '0');
  });

  it('honours explicit centerLat/centerLng/zoom over the bbox auto-fit', () => {
    render(
      <MapPreview
        items={SAMPLE_ITEMS}
        centerLat={20}
        centerLng={80}
        zoom={6}
      />,
    );
    const container = screen.getByTestId('map-container');
    expect(container).toHaveAttribute('data-center', JSON.stringify([20, 80]));
    expect(container).toHaveAttribute('data-zoom', '6');
  });

  it('fires onMarkerClick with the item when a marker is clicked', () => {
    const onClick = vi.fn();
    render(<MapPreview items={SAMPLE_ITEMS} onMarkerClick={onClick} />);
    fireEvent.click(screen.getByTestId('marker-i1'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0][0]).toMatchObject({ id: 'i1' });
  });

  it('assigns distinct colours per dayNumber via data-day-color', () => {
    render(<MapPreview items={SAMPLE_ITEMS} />);
    const day1Color = screen.getByTestId('marker-i1').getAttribute('data-day-color');
    const day2Color = screen.getByTestId('marker-i3').getAttribute('data-day-color');
    expect(day1Color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(day2Color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(day1Color).not.toBe(day2Color);
  });

  it('renders the visible OSM attribution overlay', () => {
    render(<MapPreview items={SAMPLE_ITEMS} />);
    const attr = screen.getByTestId('map-attribution');
    expect(attr).toBeInTheDocument();
    expect(attr.textContent).toMatch(/OpenStreetMap contributors/);
  });

  it('popup content includes the dayNumber and locationName', () => {
    render(<MapPreview items={SAMPLE_ITEMS} />);
    // The Popup mock renders children; the text "Day 1: Calangute" + others.
    expect(screen.getByText('Day 1: Calangute')).toBeInTheDocument();
    expect(screen.getByText('Day 1: Anjuna')).toBeInTheDocument();
    expect(screen.getByText('Day 2: Palolem')).toBeInTheDocument();
  });

  it('does NOT crash when onMarkerClick is omitted', () => {
    render(<MapPreview items={SAMPLE_ITEMS} />);
    expect(() => fireEvent.click(screen.getByTestId('marker-i1'))).not.toThrow();
  });

  it('respects a custom height prop', () => {
    render(<MapPreview items={SAMPLE_ITEMS} height={250} />);
    const root = screen.getByTestId('map-preview');
    expect(root.style.height).toBe('250px');
  });

  it('renders without explicit center using world-view defaults', () => {
    render(<MapPreview items={[]} />);
    const container = screen.getByTestId('map-container');
    expect(container).toHaveAttribute('data-center', JSON.stringify([0, 0]));
    expect(container).toHaveAttribute('data-zoom', '1');
  });
});

/**
 * S83 — print-CSS class-hook contract
 *
 * The print.css @media print rules target two classnames:
 *   - .map-preview              — outer wrapper
 *   - .map-preview__attribution — visible OSM chip
 *
 * These tests pin the className + text contract so a future refactor
 * doesn't silently drop the hooks (which would silently break
 * print-mode attribution visibility — an OSM license risk).
 *
 * jsdom can't evaluate @media print rules, so the BEHAVIOURAL contract
 * (position:static + visibility:visible at print-time) isn't asserted
 * directly here. It is verified manually in browser print preview
 * AND documented in the print.css header comment.
 */
describe('<MapPreview /> — S83 print-css hooks', () => {
  it('outer wrapper has the stable `map-preview` className for print.css targeting', () => {
    render(<MapPreview items={SAMPLE_ITEMS} />);
    const wrapper = screen.getByTestId('map-preview');
    expect(wrapper.className).toMatch(/\bmap-preview\b/);
  });

  it('attribution element has the stable `map-preview__attribution` className', () => {
    render(<MapPreview items={SAMPLE_ITEMS} />);
    const attr = screen.getByTestId('map-attribution');
    expect(attr.className).toMatch(/\bmap-preview__attribution\b/);
  });

  it('attribution text is the exact OSM-required literal', () => {
    render(<MapPreview items={SAMPLE_ITEMS} />);
    const attr = screen.getByTestId('map-attribution');
    // Exact literal — substring matches would let a bad refactor pass.
    expect(attr.textContent).toBe('© OpenStreetMap contributors');
  });

  it('attribution text is wrapped in a <span> so print.css can target inline-text', () => {
    render(<MapPreview items={SAMPLE_ITEMS} />);
    const attr = screen.getByTestId('map-attribution');
    const span = attr.querySelector('span');
    expect(span).not.toBeNull();
    expect(span.textContent).toBe('© OpenStreetMap contributors');
  });

  it('attribution + wrapper class hooks both survive when items list is empty', () => {
    // Print export of a blank-map page (e.g. an itinerary draft without
    // pinned coords) must still carry the attribution + class hooks.
    render(<MapPreview items={[]} />);
    expect(screen.getByTestId('map-preview').className).toMatch(/\bmap-preview\b/);
    expect(screen.getByTestId('map-attribution').className).toMatch(/\bmap-preview__attribution\b/);
    expect(screen.getByTestId('map-attribution').textContent).toBe('© OpenStreetMap contributors');
  });

  it('attribution element renders inside the .map-preview wrapper (DOM parent chain)', () => {
    // print.css targets `.map-preview__attribution` outside of any
    // class-nesting selector, but the rule for `.map-preview` (page-break
    // avoidance + overflow:visible) needs the wrapper to be the visible
    // ancestor. Pin the parent relationship so a refactor that lifts the
    // attribution outside the wrapper raises a test failure.
    render(<MapPreview items={SAMPLE_ITEMS} />);
    const wrapper = screen.getByTestId('map-preview');
    const attr = screen.getByTestId('map-attribution');
    expect(wrapper.contains(attr)).toBe(true);
  });
});
