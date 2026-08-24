import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

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

import TripsShareResolver from '../pages/public/TripsShareResolver';

const fetchMock = vi.fn();

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

function renderPage(initialPath = '/trips/101') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <LocationProbe />
      <Routes>
        <Route path="/trips/:tripRef" element={<TripsShareResolver />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('<TripsShareResolver />', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the public landing page by id and renders it in place on /trips/:tripRef', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 101,
        slug: 'umrah-2026',
        title: 'Umrah 2026',
        status: 'PUBLISHED',
        templateType: 'travel_destination',
        content: [],
      }),
    });

    renderPage('/trips/101');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/landing-pages/public/by-id/101',
        expect.objectContaining({
          method: 'GET',
          headers: { Accept: 'application/json' },
        }),
      );
    });

    expect(await screen.findByTestId('landing-page-renderer')).toHaveTextContent('Umrah 2026');
    expect(screen.getByTestId('landing-page-renderer')).toHaveAttribute('data-slug', 'umrah-2026');
    expect(screen.getByTestId('landing-page-renderer')).toHaveAttribute('data-public-submit', 'true');
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/trips/101');
  });

  it('fetches the public landing page by slug and renders it in place on /trips/:tripRef', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 202,
        slug: 'japan-2026',
        title: 'Japan 2026',
        status: 'PUBLISHED',
        templateType: 'travel_destination',
        content: [],
      }),
    });

    renderPage('/trips/japan-2026');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/landing-pages/public/by-slug/japan-2026',
        expect.objectContaining({
          method: 'GET',
          headers: { Accept: 'application/json' },
        }),
      );
    });

    expect(await screen.findByTestId('landing-page-renderer')).toHaveTextContent('Japan 2026');
    expect(screen.getByTestId('landing-page-renderer')).toHaveAttribute('data-slug', 'japan-2026');
    expect(screen.getByTestId('landing-page-renderer')).toHaveAttribute('data-public-submit', 'true');
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/trips/japan-2026');
  });
});
