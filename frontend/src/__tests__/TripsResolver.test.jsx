/**
 * TripsResolver.test.jsx — RTL coverage of the /trips dynamic entry
 * point.
 *
 * SUT: frontend/src/pages/public/TripsResolver.jsx
 *
 * Resolution flow (updated):
 *   1. GET /api/landing-pages/public/featured-html (no auth, Accept: text/html).
 *      Returns rendered HTML of the live trip, or 404 if nothing published.
 *   2. On 200 → write the HTML into the current document via document.open() /
 *      document.write() / document.close(). URL stays at /trips.
 *   3. On 404 / error → render the hardcoded TripsLanding fallback.
 *
 * global.fetch is stubbed per test. document.open/write/close are stubbed so
 * jsdom doesn't actually blow away the test document.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Stub the lazy-imported fallback so we don't load the full TripsLanding page.
vi.mock('../pages/public/TripsLanding', () => ({
  default: () => <div data-testid="trips-fallback">FALLBACK TripsLanding</div>,
}));

import TripsResolver from '../pages/public/TripsResolver';

function renderResolver() {
  return render(
    <MemoryRouter initialEntries={['/trips']}>
      <Routes>
        <Route path="/trips" element={<TripsResolver />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('<TripsResolver />', () => {
  let documentOpen;
  let documentWrite;
  let documentClose;
  let origOpen;
  let origWrite;
  let origClose;

  beforeEach(() => {
    global.fetch = vi.fn();
    // Stub document.open/write/close so the test document isn't replaced.
    // Use direct property assignment on the real document object rather than
    // vi.stubGlobal('document', {...}) — the latter replaces the entire
    // document reference, which breaks RTL's render() because it needs the
    // real document.body.appendChild to mount the React tree.
    origOpen = document.open.bind(document);
    origWrite = document.write.bind(document);
    origClose = document.close.bind(document);
    documentOpen = vi.fn();
    documentWrite = vi.fn();
    documentClose = vi.fn();
    document.open = documentOpen;
    document.write = documentWrite;
    document.close = documentClose;
  });

  afterEach(() => {
    document.open = origOpen;
    document.write = origWrite;
    document.close = origClose;
  });

  it('writes the server-rendered HTML into the document when featured-html returns 200', async () => {
    const TRIP_HTML = '<html><body><h1>Japan 2026</h1></body></html>';
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => TRIP_HTML,
    });
    renderResolver();
    await waitFor(() => {
      expect(documentOpen).toHaveBeenCalled();
      expect(documentWrite).toHaveBeenCalledWith(TRIP_HTML);
      expect(documentClose).toHaveBeenCalled();
    });
    // The fallback should NOT have rendered (document.write replaced the page).
    expect(screen.queryByTestId('trips-fallback')).not.toBeInTheDocument();
  });

  it('falls back to the hardcoded TripsLanding on 404 NO_FEATURED_PAGE', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });
    renderResolver();
    await waitFor(() => {
      expect(screen.getByTestId('trips-fallback')).toBeInTheDocument();
    });
    expect(documentWrite).not.toHaveBeenCalled();
  });

  it('falls back to the hardcoded TripsLanding on network error', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network down'));
    renderResolver();
    await waitFor(() => {
      expect(screen.getByTestId('trips-fallback')).toBeInTheDocument();
    });
    expect(documentWrite).not.toHaveBeenCalled();
  });

  it('falls back when the response is 200 but the HTML body is empty', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '',
    });
    renderResolver();
    await waitFor(() => {
      expect(screen.getByTestId('trips-fallback')).toBeInTheDocument();
    });
    expect(documentWrite).not.toHaveBeenCalled();
  });

  it('calls /api/landing-pages/public/featured-html with GET + Accept: text/html', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '<html><body>trip</body></html>',
    });
    renderResolver();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/landing-pages/public/featured-html');
    expect(opts?.method).toBe('GET');
    expect(opts?.headers?.Accept).toBe('text/html');
  });
});
