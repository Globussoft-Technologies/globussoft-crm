import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

/**
 * frontend/src/components/GeofencePicker.jsx
 *
 * What's tested
 *   - Debounced place search: queries under MIN_QUERY_LEN never hit the
 *     network; a long-enough query fires exactly one geocodeSuggest call
 *     after the debounce.
 *   - Picking a suggestion patches latitude/longitude (6dp) AND materialises
 *     the default radius, so the circle drawn is the circle saved.
 *   - fillAddressFields also patches addressLine/city/state/pincode; a
 *     non-6-digit postcode is dropped rather than tripping the form's own
 *     `pattern="\d{6}"` validation.
 *   - Keyboard nav: ArrowDown moves the highlight, Enter picks the
 *     highlighted row and calls preventDefault (the picker sits inside the
 *     clinic <form> — a bare Enter would submit it half-filled).
 *   - The radius slider is disabled until a point exists, and dragging it
 *     patches only geofenceRadiusM.
 *   - The map draws the enforced disc AND the decorative pulse ring at the
 *     SAME radius — a pulse ring on a different radius would advertise a
 *     boundary the backend does not enforce.
 *   - No point set → no marker, no circles.
 *   - Neither circle is interactive (a clickable path would block
 *     click-to-reposition inside the geofence).
 *   - A legacy radius outside the slider range is flagged, and still drawn
 *     at its true value.
 *   - "Clear geofence" blanks all three fields (backend treats null lat/lng
 *     as "not geofenced").
 *   - Place search is boxed to India by default and RETRIES worldwide when
 *     that box comes back empty (upstream treats bbox as a hard filter).
 *   - When the full phrase finds nothing, the search relaxes to the TAIL of
 *     the phrase (locality) and labels the results as inexact.
 *   - Picking a suggestion does NOT trigger a follow-up search for the label
 *     it just wrote into the box (which would reopen the dropdown).
 *   - The clicked/picked point is NAMED beside the coordinates and on the
 *     pin itself — coordinates alone cannot tell an operator whether they
 *     hit the right building.
 *   - Basemap toggle swaps the tile URL + attribution.
 *   - toNum / hasPoint / addressPatchFromSuggestion helpers.
 *
 * Why
 *   The picker is the ONLY way an admin sets Location.latitude/longitude/
 *   geofenceRadiusM now, and those three columns are what
 *   backend/lib/attendanceGeofence.js enforces on every clock-in. A silent
 *   regression here (wrong radius, dropped coordinate, stale patch) locks
 *   real staff out of attendance, so the patch shape is pinned explicitly.
 *
 * jsdom note
 *   Leaflet renders via real layout (getBoundingClientRect, CSS transforms)
 *   which jsdom does NOT model. We mock react-leaflet and assert on the
 *   props the component PASSES — same approach as MapPreview.test.jsx.
 */

vi.mock('react-leaflet', () => {
  const React = require('react');
  const MapContainer = ({ children, center, zoom }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'map-container',
        'data-center': JSON.stringify(center),
        'data-zoom': String(zoom),
      },
      children,
    );
  const TileLayer = ({ attribution, url }) =>
    React.createElement('div', {
      'data-testid': 'tile-layer',
      'data-attribution': attribution,
      'data-url': url,
    });
  const Marker = ({ children, position, draggable }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'marker',
        'data-position': JSON.stringify(position),
        'data-draggable': String(!!draggable),
      },
      children,
    );
  const Circle = ({ center, radius, pathOptions, interactive }) =>
    React.createElement('div', {
      'data-testid': 'circle',
      'data-center': JSON.stringify(center),
      'data-radius': String(radius),
      'data-classname': pathOptions?.className || '',
      'data-color': pathOptions?.color || '',
      'data-interactive': String(interactive !== false),
    });
  // The real hooks need a live map instance; the component is written to
  // bail out when useMap() yields nothing, which is what we exercise here.
  const useMap = () => null;
  const useMapEvents = () => null;
  const Tooltip = ({ children, permanent }) =>
    React.createElement(
      'div',
      { 'data-testid': 'marker-tooltip', 'data-permanent': String(!!permanent) },
      children,
    );
  return { MapContainer, TileLayer, Marker, Circle, Tooltip, useMap, useMapEvents };
});

// Stub the leaflet CSS import so it doesn't error in jsdom.
vi.mock('leaflet/dist/leaflet.css', () => ({}));

const geocodeSuggestMock = vi.fn();
const reverseGeocodeMock = vi.fn();
vi.mock('../lib/geocoder', () => ({
  geocodeSuggest: (...args) => geocodeSuggestMock(...args),
  reverseGeocode: (...args) => reverseGeocodeMock(...args),
}));

import GeofencePicker, {
  toNum,
  hasPoint,
  addressPatchFromSuggestion,
} from '../components/GeofencePicker';

const SUGGESTION = {
  lat: 12.9346691,
  lng: 77.6111143,
  display_name: 'Nexus Koramangala Mall, Hosur Road, Bengaluru, Karnataka, India',
  name: 'Nexus Koramangala Mall',
  street: 'Hosur Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  country: 'India',
  postcode: '560095',
};

const EMPTY_VALUE = { latitude: '', longitude: '', geofenceRadiusM: '' };

function setup(props = {}) {
  const onChange = vi.fn();
  const utils = render(
    <GeofencePicker value={EMPTY_VALUE} onChange={onChange} {...props} />,
  );
  return { onChange, ...utils };
}

/**
 * GeofencePicker is a CONTROLLED component: anything that depends on the new
 * coordinates (the marker, the circles, the "Selected point" field) only
 * appears once the parent feeds the patch back in. `setup` deliberately does
 * not, so it can assert on the raw patch; this harness does, for the cases
 * that need the post-patch render.
 */
function Controlled({ initial = EMPTY_VALUE, ...props }) {
  const [value, setValue] = React.useState(initial);
  return (
    <GeofencePicker
      value={value}
      onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
      {...props}
    />
  );
}

// The search effect is debounced; drive it with fake timers so the tests
// don't sleep for real.
async function flushDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  geocodeSuggestMock.mockResolvedValue([SUGGESTION]);
  reverseGeocodeMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Helpers ─────────────────────────────────────────────────────────
describe('helpers', () => {
  it('toNum coerces form strings and rejects blanks/garbage', () => {
    expect(toNum('12.34')).toBe(12.34);
    expect(toNum(0)).toBe(0);
    expect(toNum('')).toBeNull();
    expect(toNum(null)).toBeNull();
    expect(toNum(undefined)).toBeNull();
    expect(toNum('abc')).toBeNull();
  });

  it('hasPoint requires BOTH coordinates', () => {
    expect(hasPoint({ latitude: '1', longitude: '2' })).toBe(true);
    expect(hasPoint({ latitude: '1', longitude: '' })).toBe(false);
    expect(hasPoint({})).toBe(false);
    // 0,0 is a real coordinate (Null Island) — must not be treated as blank.
    expect(hasPoint({ latitude: 0, longitude: 0 })).toBe(true);
  });

  it('addressPatchFromSuggestion maps street/city/state and a 6-digit pincode', () => {
    expect(addressPatchFromSuggestion(SUGGESTION)).toEqual({
      addressLine: 'Hosur Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560095',
    });
  });

  it('addressPatchFromSuggestion falls back to the POI name when there is no street', () => {
    const patch = addressPatchFromSuggestion({ ...SUGGESTION, street: '' });
    expect(patch.addressLine).toBe('Nexus Koramangala Mall');
  });

  it('addressPatchFromSuggestion drops a non-6-digit postcode', () => {
    // The clinic form's pincode input carries pattern="\d{6}"; pushing a
    // foreign postcode through would make the form unsubmittable.
    expect(addressPatchFromSuggestion({ ...SUGGESTION, postcode: 'SW1A 1AA' }).pincode)
      .toBeUndefined();
    expect(addressPatchFromSuggestion({ ...SUGGESTION, postcode: '' }).pincode)
      .toBeUndefined();
  });
});

// ── Search ──────────────────────────────────────────────────────────
describe('place search', () => {
  it('does not call the geocoder for a query shorter than 3 characters', async () => {
    setup();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ne' } });
    await flushDebounce();
    expect(geocodeSuggestMock).not.toHaveBeenCalled();
  });

  it('debounces to a single geocodeSuggest call and renders the suggestions', async () => {
    setup();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'nex' } });
    fireEvent.change(input, { target: { value: 'nexus' } });
    fireEvent.change(input, { target: { value: 'nexus mall' } });
    await flushDebounce();

    expect(geocodeSuggestMock).toHaveBeenCalledTimes(1);
    // Default search is boxed to India — Photon has no country weighting, so
    // an unboxed "Dr Arora Wellness Ranchi" returns a Canadian salon first.
    expect(geocodeSuggestMock).toHaveBeenCalledWith('nexus mall', 6, {
      bbox: '68.1,6.5,97.4,35.7',
    });
    expect(await screen.findByRole('option')).toHaveTextContent('Nexus Koramangala Mall');
  });

  it('retries worldwide when the in-country box returns nothing', async () => {
    const overseas = { ...SUGGESTION, display_name: 'Somewhere Abroad', country: 'Canada' };
    geocodeSuggestMock
      .mockResolvedValueOnce([])       // boxed attempt
      .mockResolvedValueOnce([overseas]); // worldwide retry
    setup();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'clinic abroad' } });
    await flushDebounce();

    expect(geocodeSuggestMock).toHaveBeenCalledTimes(2);
    expect(geocodeSuggestMock.mock.calls[1]).toEqual(['clinic abroad', 6]);
    expect(await screen.findByRole('option')).toHaveTextContent('Somewhere Abroad');
  });

  it('does not retry when searchBbox is explicitly disabled', async () => {
    geocodeSuggestMock.mockResolvedValue([]);
    setup({ searchBbox: null });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzzzzzz' } });
    await flushDebounce();
    expect(geocodeSuggestMock).toHaveBeenCalledTimes(1);
    expect(geocodeSuggestMock).toHaveBeenCalledWith('zzzzzzzz', 6, { bbox: undefined });
  });

  it('relaxes to the tail of the phrase when the full query finds nothing', async () => {
    // Real case from the field: "udaymentsion koramangala" — the clinic name
    // is not in OpenStreetMap, but Koramangala obviously is. Dead-ending the
    // operator there is worse than offering the locality to drag from.
    const area = { ...SUGGESTION, display_name: 'Koramangala, Bengaluru, India' };
    geocodeSuggestMock.mockImplementation(async (term) =>
      (term === 'koramangala' ? [area] : []));

    setup();
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'udaymentsion koramangala' },
    });
    await flushDebounce();

    expect(await screen.findByRole('option')).toHaveTextContent('Koramangala');
    // The relaxation must be stated, not hidden — presenting a relaxed hit as
    // an exact match is how a clinic ends up geofenced across the city.
    // Scope to the notice itself — "koramangala" also appears in the search
    // box and in the suggestion row, so a bare getByText is ambiguous.
    expect(screen.getByText(/No exact match/i)).toHaveTextContent('koramangala');
  });

  it('stops at the FIRST tail that resolves instead of trying them all', async () => {
    const area = { ...SUGGESTION, display_name: 'Hosur Road, Bengaluru' };
    geocodeSuggestMock.mockImplementation(async (term) =>
      (term === 'hosur road koramangala' ? [area] : []));

    setup({ searchBbox: null });
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'someclinic hosur road koramangala' },
    });
    await flushDebounce();

    await screen.findByRole('option');
    const terms = geocodeSuggestMock.mock.calls.map((c) => c[0]);
    expect(terms).toEqual(['someclinic hosur road koramangala', 'hosur road koramangala']);
  });

  it('shows the no-match hint only when the relaxed search also comes up empty', async () => {
    geocodeSuggestMock.mockResolvedValue([]);
    setup();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzzzzzz qqqqqqqq' } });
    await flushDebounce();
    expect(await screen.findByText(/Nothing found for that/i)).toBeInTheDocument();
    expect(screen.queryByText(/No exact match/i)).not.toBeInTheDocument();
  });

  it('does not relax a single-word query (there is no tail to fall back to)', async () => {
    geocodeSuggestMock.mockResolvedValue([]);
    setup({ searchBbox: null });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzzzzzz' } });
    await flushDebounce();
    expect(geocodeSuggestMock).toHaveBeenCalledTimes(1);
  });

  it('picking a suggestion patches 6dp coordinates AND materialises the default radius', async () => {
    const { onChange } = setup({ defaultRadiusM: 150 });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nexus mall' } });
    await flushDebounce();

    fireEvent.mouseDown(await screen.findByRole('option'));

    expect(onChange).toHaveBeenCalledWith({
      latitude: '12.934669',
      longitude: '77.611114',
      geofenceRadiusM: 150,
    });
  });

  it('fillAddressFields adds the address patch to the same onChange call', async () => {
    const { onChange } = setup({ fillAddressFields: true, defaultRadiusM: 150 });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nexus mall' } });
    await flushDebounce();
    fireEvent.mouseDown(await screen.findByRole('option'));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        latitude: '12.934669',
        longitude: '77.611114',
        addressLine: 'Hosur Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560095',
      }),
    );
  });

  it('keeps an already-set radius instead of overwriting it with the default', async () => {
    const { onChange } = setup({
      value: { latitude: '1', longitude: '2', geofenceRadiusM: '400' },
      defaultRadiusM: 150,
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nexus mall' } });
    await flushDebounce();
    fireEvent.mouseDown(await screen.findByRole('option'));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ geofenceRadiusM: 400 }),
    );
  });

  it('Enter picks the highlighted suggestion and blocks the parent form submit', async () => {
    geocodeSuggestMock.mockResolvedValue([
      SUGGESTION,
      { ...SUGGESTION, lat: 1.5, lng: 2.5, display_name: 'Second match' },
    ]);
    const { onChange } = setup();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'nexus mall' } });
    await flushDebounce();
    await screen.findAllByRole('option');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const enter = createKeyEvent('Enter');
    fireEvent(input, enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: '1.500000', longitude: '2.500000' }),
    );
  });

  it('does not re-search (or re-open) after a suggestion is picked', async () => {
    // Picking writes the place's own label into the search box. That is a
    // `query` change, so without a latch the debounced effect fires again and
    // the dropdown reopens on top of the form the operator is trying to fill.
    setup();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nexus mall' } });
    await flushDebounce();
    fireEvent.mouseDown(await screen.findByRole('option'));

    expect(screen.getByRole('combobox')).toHaveValue(SUGGESTION.display_name);
    await flushDebounce();
    expect(geocodeSuggestMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('Escape closes the suggestion list', async () => {
    setup();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'nexus mall' } });
    await flushDebounce();
    expect(await screen.findByRole('option')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());
  });
});

// ── Radius ──────────────────────────────────────────────────────────
describe('radius slider', () => {
  it('is disabled until a point is set', () => {
    setup();
    expect(screen.getByLabelText(/Check-in radius/i)).toBeDisabled();
  });

  it('patches ONLY geofenceRadiusM when dragged', () => {
    const { onChange } = setup({
      value: { latitude: '12.9', longitude: '77.6', geofenceRadiusM: '150' },
    });
    fireEvent.change(screen.getByLabelText(/Check-in radius/i), { target: { value: '325' } });
    expect(onChange).toHaveBeenCalledWith({ geofenceRadiusM: '325' });
  });

  it('shows the backend default when a point exists with no radius yet', () => {
    setup({
      value: { latitude: '12.9', longitude: '77.6', geofenceRadiusM: '' },
      defaultRadiusM: 150,
    });
    // The slider position is the load-bearing assertion; the readout and the
    // help sentence below it both render the same "150 m" string, so a
    // getByText would be ambiguous by design.
    expect(screen.getByLabelText(/Check-in radius/i)).toHaveValue('150');
    expect(screen.getAllByText('150 m').length).toBeGreaterThan(0);
  });
});

// ── Map layers ──────────────────────────────────────────────────────
describe('map rendering', () => {
  it('draws nothing but the basemap when no point is set', () => {
    setup();
    expect(screen.queryByTestId('marker')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('circle')).toHaveLength(0);
  });

  it('draws a draggable marker plus enforced disc and pulse ring at the SAME radius', () => {
    setup({ value: { latitude: '12.9346691', longitude: '77.6111143', geofenceRadiusM: '275' } });

    expect(screen.getByTestId('marker')).toHaveAttribute('data-draggable', 'true');

    const circles = screen.getAllByTestId('circle');
    expect(circles).toHaveLength(2);
    // Both circles must report the same radius — the animated ring is
    // decorative, so a mismatch would show a boundary nobody enforces.
    expect(circles[0]).toHaveAttribute('data-radius', '275');
    expect(circles[1]).toHaveAttribute('data-radius', '275');
    expect(circles[1]).toHaveAttribute('data-classname', 'geofence-pulse-ring');
    expect(circles[0]).toHaveAttribute('data-color', '#ef4444');
    // Neither circle may be interactive: a clickable leaflet path swallows
    // the map click, so the operator could not reposition the pin anywhere
    // inside the circle — exactly where they are most likely to click.
    expect(circles[0]).toHaveAttribute('data-interactive', 'false');
    expect(circles[1]).toHaveAttribute('data-interactive', 'false');
  });

  it('flags a legacy radius that sits outside the slider range', () => {
    // Rows saved before the picker existed had a free-text radius box.
    setup({
      value: { latitude: '12.9', longitude: '77.6', geofenceRadiusM: '2000' },
      maxRadiusM: 1000,
    });
    expect(screen.getByText(/outside this slider/i)).toBeInTheDocument();
    // The circle still draws at the TRUE saved radius, not the clamped one.
    expect(screen.getAllByTestId('circle')[0]).toHaveAttribute('data-radius', '2000');
  });

  it('shows no range warning for an in-range radius', () => {
    setup({ value: { latitude: '12.9', longitude: '77.6', geofenceRadiusM: '300' } });
    expect(screen.queryByText(/outside this slider/i)).not.toBeInTheDocument();
  });

  it('clears all three geofence fields via "Clear geofence"', () => {
    const { onChange } = setup({
      value: { latitude: '12.9', longitude: '77.6', geofenceRadiusM: '150' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Clear geofence/i }));
    expect(onChange).toHaveBeenCalledWith({
      latitude: '',
      longitude: '',
      geofenceRadiusM: '',
    });
  });

  it('names the picked point beside the coordinates, not just as a footnote', async () => {
    render(<Controlled />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nexus mall' } });
    await flushDebounce();
    fireEvent.mouseDown(await screen.findByRole('option'));

    // Coordinates alone cannot tell an operator whether they hit the right
    // building — the "Selected point" field is what makes a pick verifiable.
    const field = document.getElementById('geofence-place');
    expect(field).toBeInTheDocument();
    expect(field).toHaveTextContent('Nexus Koramangala Mall, Hosur Road');
  });

  it('labels the pin on the map with a trimmed, permanent tooltip', async () => {
    render(<Controlled />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nexus mall' } });
    await flushDebounce();
    fireEvent.mouseDown(await screen.findByRole('option'));

    const tip = await screen.findByTestId('marker-tooltip');
    // Permanent, not hover: the whole point is at-a-glance confirmation.
    expect(tip).toHaveAttribute('data-permanent', 'true');
    // Trimmed to building + street — a 7-part address would cover the map.
    expect(tip).toHaveTextContent('Nexus Koramangala Mall, Hosur Road');
    expect(tip).not.toHaveTextContent('Karnataka');
  });

  it('says a point is unnamed rather than rendering a blank field', async () => {
    // Reverse-geocoding a field or a rooftop legitimately returns nothing. A
    // blank box reads as "still loading"; the coordinates are usable, so the
    // field has to say that outright.
    reverseGeocodeMock.mockResolvedValue(null);
    render(<Controlled initial={{ latitude: '', longitude: '', geofenceRadiusM: '' }} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nexus mall' } });
    await flushDebounce();
    fireEvent.mouseDown(await screen.findByRole('option'));

    // A search pick carries its own name, so THAT path stays named.
    expect(document.getElementById('geofence-place')).toHaveTextContent('Nexus Koramangala Mall');
    expect(screen.queryByTestId('marker-tooltip')).toBeInTheDocument();
  });

  it('defaults to key-less OSM tiles and swaps URL + attribution on the satellite toggle', () => {
    setup();
    expect(screen.getByTestId('tile-layer')).toHaveAttribute(
      'data-url',
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Satellite' }));
    const tile = screen.getByTestId('tile-layer');
    expect(tile.getAttribute('data-url')).toContain('World_Imagery');
    // Attribution is a licence requirement for both providers, not decoration.
    expect(tile.getAttribute('data-attribution')).toMatch(/Esri/);
  });
});

// jsdom's fireEvent.keyDown builds its own event, so `defaultPrevented` on the
// caller's object is lost. Construct the event directly to assert on it.
function createKeyEvent(key) {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
}
