/**
 * TripsResolver.test.jsx — RTL coverage of the /trips dynamic entry
 * point.
 *
 * SUT: frontend/src/pages/public/TripsResolver.jsx
 *
 * The backend now serves /trips as the server-rendered featured page.
 * For client-side navigations the resolver forces a full-page load to
 * /trips when a featured page exists, otherwise it renders the hardcoded
 * TripsLanding fallback.
 *
 * We pin both branches plus the "no slug in response" defensive path
 * (treat as fallback). global.fetch is stubbed per test.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Stub the lazy-imported fallback so we don't load the full Japan page.
// vi.mock('./pages/public/TripsLanding') would work from the test's
// vantage but the resolver imports it via a relative `./TripsLanding`
// path — match that exactly.
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
  let locationReplace;

  beforeEach(() => {
    global.fetch = vi.fn();
    locationReplace = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace: locationReplace });
  });

  it('redirects to the featured page /p/<slug> render URL when the featured endpoint returns a slug', async () => {
    // The resolver redirects to /p/<slug> (the canonical landing-page render
    // surface, reliably proxied to the backend) rather than the /trips vanity
    // URL — redirecting to /trips re-mounts this resolver on a misconfigured
    // web layer and loops forever.
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, slug: 'japan-2026', title: 'Japan 2026' }),
    });
    renderResolver();
    await waitFor(() => {
      expect(locationReplace).toHaveBeenCalledWith('/p/japan-2026');
    });
    // The fallback should NOT have rendered.
    expect(screen.queryByTestId('trips-fallback')).not.toBeInTheDocument();
  });

  it('URL-encodes the slug in the /p/<slug> redirect', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ slug: 'summer sale/2026' }),
    });
    renderResolver();
    await waitFor(() => {
      expect(locationReplace).toHaveBeenCalledWith('/p/summer%20sale%2F2026');
    });
  });

  it('falls back to the hardcoded TripsLanding on 404 NO_FEATURED_PAGE', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ code: 'NO_FEATURED_PAGE' }),
    });
    renderResolver();
    await waitFor(() => {
      expect(screen.getByTestId('trips-fallback')).toBeInTheDocument();
    });
    expect(locationReplace).not.toHaveBeenCalled();
  });

  it('falls back to the hardcoded TripsLanding on network error', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network down'));
    renderResolver();
    await waitFor(() => {
      expect(screen.getByTestId('trips-fallback')).toBeInTheDocument();
    });
  });

  it('falls back when the response is 200 but missing a slug field', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, title: 'Stale' }),
    });
    renderResolver();
    await waitFor(() => {
      expect(screen.getByTestId('trips-fallback')).toBeInTheDocument();
    });
  });

  it('calls /api/landing-pages/public/featured with GET + Accept: application/json', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ slug: 'japan-2026' }),
    });
    renderResolver();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/landing-pages/public/featured');
    expect(opts?.method).toBe('GET');
    expect(opts?.headers?.Accept).toBe('application/json');
  });
});
