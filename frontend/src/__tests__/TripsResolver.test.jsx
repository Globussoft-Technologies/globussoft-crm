/**
 * TripsResolver.test.jsx - RTL coverage of the /trips public entry.
 *
 * SUT: frontend/src/pages/public/TripsResolver.jsx
 *
 * Resolution flow:
 *   1. GET /api/landing-pages/public/featured-full?vertical=travel (no auth).
 *      Returns the full featured published travel page, or 404 if nothing
 *      is featured yet.
 *   2. On 200 -> render the page in place at /trips.
 *   3. On 404 / error -> render the hardcoded TripsLanding fallback.
 *
 * The route stays on /trips instead of bouncing through /p/<slug>.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// Stub the fallback page so we don't load the full TripsLanding page.
vi.mock('../pages/public/TripsLanding', () => ({
  default: () => <div data-testid="trips-fallback">FALLBACK TripsLanding</div>,
}));

vi.mock('../components/landing-page-renderers', () => ({
  LandingPageReactRenderer: ({ landingPage }) => (
    <div
      data-testid="landing-page-renderer"
      data-slug={landingPage?.slug ?? ''}
      data-public-submit={String(Boolean(landingPage?.publicSubmit))}
    >
      {landingPage?.title ?? ''}
    </div>
  ),
}));

import TripsResolver from '../pages/public/TripsResolver';

function LocationProbe() {
  const location = useLocation();
  return (
    <div
      data-testid="location-probe"
      data-path={`${location.pathname}${location.search}${location.hash}`}
    />
  );
}

function renderResolver(initialEntries = ['/trips']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <LocationProbe />
      <Routes>
        <Route path="/trips" element={<TripsResolver />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('<TripsResolver />', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('renders the featured page in place at /trips when the featured page resolves', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 51,
        slug: 'japan-2026',
        title: 'Japan 2026',
        status: 'PUBLISHED',
        templateType: 'travel_destination',
        destination: 'Japan',
        subBrand: 'travelstall',
        metaTitle: 'Japan 2026',
        metaDescription: 'Visit Japan',
        content: [],
        cssOverrides: '',
        tripId: 51,
      }),
    });

    renderResolver(['/trips?utm_source=demo#section']);

    expect(await screen.findByTestId('landing-page-renderer')).toBeInTheDocument();
    expect(screen.getByTestId('location-probe')).toHaveAttribute(
      'data-path',
      '/trips?utm_source=demo#section',
    );
    expect(screen.getByTestId('landing-page-renderer')).toHaveAttribute('data-slug', 'japan-2026');
    expect(screen.getByTestId('landing-page-renderer')).toHaveAttribute('data-public-submit', 'true');
    expect(screen.getByTestId('landing-page-renderer')).toHaveTextContent('Japan 2026');
    expect(global.fetch).toHaveBeenCalledWith('/api/landing-pages/public/featured-full?vertical=travel', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    expect(screen.queryByTestId('trips-fallback')).not.toBeInTheDocument();
  });

  it('keeps the route empty while the featured page request is pending', () => {
    global.fetch.mockReturnValueOnce(new Promise(() => {}));

    renderResolver();

    expect(screen.queryByTestId('trips-fallback')).not.toBeInTheDocument();
    expect(screen.getByTestId('location-probe')).toHaveAttribute('data-path', '/trips');
    expect(screen.queryByTestId('landing-page-renderer')).not.toBeInTheDocument();
  });

  it('falls back to the hardcoded TripsLanding on 404 NO_FEATURED_PAGE', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    renderResolver();

    expect(await screen.findByTestId('trips-fallback')).toBeInTheDocument();
    expect(screen.getByTestId('location-probe')).toHaveAttribute('data-path', '/trips');
    expect(screen.queryByTestId('landing-page-renderer')).not.toBeInTheDocument();
  });

  it('falls back to the hardcoded TripsLanding on network error', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network down'));

    renderResolver();

    expect(await screen.findByTestId('trips-fallback')).toBeInTheDocument();
    expect(screen.getByTestId('location-probe')).toHaveAttribute('data-path', '/trips');
    expect(screen.queryByTestId('landing-page-renderer')).not.toBeInTheDocument();
  });

  it('falls back when the response is 200 but the payload is missing a slug', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ title: 'Featured trip without slug' }),
    });

    renderResolver();

    expect(await screen.findByTestId('trips-fallback')).toBeInTheDocument();
    expect(screen.getByTestId('location-probe')).toHaveAttribute('data-path', '/trips');
    expect(screen.queryByTestId('landing-page-renderer')).not.toBeInTheDocument();
  });

  it('calls /api/landing-pages/public/featured-full with GET + Accept: application/json', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 52,
        slug: 'manali-2026',
        title: 'Manali 2026',
        status: 'PUBLISHED',
        templateType: 'travel_destination',
        destination: 'Manali',
        subBrand: 'travelstall',
        metaTitle: 'Manali 2026',
        metaDescription: 'Visit Manali',
        content: [],
        cssOverrides: '',
        tripId: 52,
      }),
    });

    renderResolver();

    await screen.findByTestId('landing-page-renderer');

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/landing-pages/public/featured-full?vertical=travel');
    expect(opts?.method).toBe('GET');
    expect(opts?.headers?.Accept).toBe('application/json');
  });
});
