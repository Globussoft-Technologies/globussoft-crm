/**
 * LandingPagesFeatured.test.jsx — RTL coverage for the Featured /trips
 * resolver UX on the LandingPages list page.
 *
 * SUT: frontend/src/pages/LandingPages.jsx
 *
 * Post-merge behavior: publishing a trip now keeps it published but does
 * NOT change the featured /trips page. The travel cards expose explicit
 * Feature / Unfeature actions so operators can choose which published
 * trip should point to /trips, while every other published trip keeps its
 * own /trips/<id> share URL.
 *
 * Scope:
 *   1. The currently-featured row renders a "★ Featured" badge.
  *   2. Publishing a sibling keeps it publishable without changing the
  *      current /trips holder.
 *   3. Clicking Feature on a published travel row POSTs /:id/feature and
 *      moves the /trips pointer to that trip.
 *   4. Unpublish POSTs /:id/unpublish directly and clears featured state
 *      if the row was the current /trips holder.
 *   5. Backend 409 PUBLISH_GATE_FAILED surfaces a friendly confirm
 *      that, on accept, navigates into the builder so the operator
 *      can fix the issues (defence-in-depth for travel pages with
 *      missing content).
 *
 * Standing-rule notes (CLAUDE.md):
 *   - Stable mock object for useNotify (fresh objects per render trip
 *     the useCallback dep-identity infinite loop).
 *   - confirmMock is a vi.fn() so each test can choose accept / reject.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const real = await vi.importActual('react-router-dom');
  return { ...real, useNavigate: () => navigateMock };
});

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const confirmMock = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => confirmMock(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import LandingPages from '../pages/LandingPages';

// Three pages in the same tenant and travel bucket. publishedFeatured
// is the current /trips holder; publishedSibling is a publish candidate;
// draftRow is publish-first.
const FIXTURE = [
  {
    id: 100,
    title: 'Japan 2026',
    slug: 'japan-2026',
    status: 'PUBLISHED',
    visits: 200,
    submissions: 14,
    subBrand: 'tmc',
    isFeatured: true,
    featuredAt: '2026-06-22T10:00:00.000Z',
  },
  {
    id: 101,
    title: 'Umrah 2026',
    slug: 'umrah-2026',
    status: 'PUBLISHED',
    visits: 80,
    submissions: 5,
    subBrand: 'rfu',
    isFeatured: false,
    featuredAt: null,
  },
  {
    id: 102,
    title: 'Bali Draft',
    slug: 'bali-draft',
    status: 'DRAFT',
    visits: 0,
    submissions: 0,
    subBrand: 'travelstall',
    isFeatured: false,
    featuredAt: null,
  },
];

function defaultFetchMock(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (url === '/api/landing-pages' && method === 'GET') return Promise.resolve(FIXTURE);
  if (url === '/api/landing-pages/templates/list') return Promise.resolve([]);
  return Promise.resolve(null);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <LandingPages />
    </MemoryRouter>,
  );
}

describe('<LandingPages /> — Featured badge + publish-swap UX', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    navigateMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    // jsdom has no navigator.clipboard — stub so the Public Link copy button
    // on PUBLISHED cards doesn't crash tests that trigger nearby interactions.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  it('renders the ★ Featured badge on the currently-featured row (exactly one in the DOM)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Japan 2026')).toBeInTheDocument());
    // The badge text is "Featured" — pin via getByText.
    const badge = screen.getByText('Featured');
    expect(badge).toBeInTheDocument();
    // Only the Japan row should carry the badge — exactly one in the DOM.
    expect(screen.getAllByText('Featured').length).toBe(1);
  });

  it('published travel rows expose explicit Feature / Unfeature actions', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Japan 2026')).toBeInTheDocument());
    const japanCard = screen.getByText('Japan 2026').closest('.card');
    const umrahCard = screen.getByText('Umrah 2026').closest('.card');
    expect(japanCard).toBeTruthy();
    expect(umrahCard).toBeTruthy();

    expect(japanCard.querySelector('button[title="Remove this trip from /trips"]')).toBeTruthy();
    expect(umrahCard.querySelector('button[title="Make this trip the featured /trips page"]')).toBeTruthy();
    // Publish/Unpublish buttons still render on each row: Unpublish on the
    // PUBLISHED rows (Japan + Umrah), Publish on the DRAFT row (Bali).
    expect(screen.getAllByRole('button', { name: /^Unpublish$/i }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: /^Publish$/i }).length).toBe(1);
  });

  it('Bali Draft Publish button stays enabled when another PUBLISHED page exists and still POSTs /publish', async () => {
    // FIXTURE has Japan (id=100, PUBLISHED) and Umrah (id=101, PUBLISHED).
    // Bali Draft can still publish — featuring is separate, so publish only
    // changes the draft's own status/share URL.
    renderPage();
    await waitFor(() => expect(screen.getByText('Bali Draft')).toBeInTheDocument());

    const publishBtn = screen.getByRole('button', { name: /^Publish$/i });
    expect(publishBtn).not.toBeDisabled();
    expect(publishBtn.title).toMatch(/make it live at \/trips\/102/i);

    fetchApiMock.mockClear();
    fireEvent.click(publishBtn);
    await waitFor(() => {
      const postCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => o?.method === 'POST' && /publish/.test(u),
      );
      expect(postCalls.length).toBe(1);
    });
  });

  it('clicking Feature on a published travel row POSTs /feature and keeps publish separate', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Japan 2026')).toBeInTheDocument());

    const umrahCard = screen.getByText('Umrah 2026').closest('.card');
    const featureBtn = umrahCard.querySelector('button[title="Make this trip the featured /trips page"]');
    expect(featureBtn).toBeTruthy();

    fetchApiMock.mockClear();
    await user.click(featureBtn);

    await waitFor(() => {
      const postCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/landing-pages/101/feature' && o?.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
    });
  });

  it('published travel rows expose the expected share URLs and copy buttons', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Japan 2026')).toBeInTheDocument());

    const japanCard = screen.getByText('Japan 2026').closest('.card');
    const umrahCard = screen.getByText('Umrah 2026').closest('.card');
    expect(japanCard).toBeTruthy();
    expect(umrahCard).toBeTruthy();

    expect(japanCard.querySelector('input[readonly]')?.value).toMatch(/\/trips$/);
    expect(japanCard.querySelector('button[title="Copy public URL"]')).toBeTruthy();
    expect(umrahCard.querySelector('input[readonly]')?.value).toMatch(/\/trips\/101$/);
    expect(umrahCard.querySelector('button[title="Copy public URL"]')).toBeTruthy();
  });

  it('with no PUBLISHED page the Publish button is enabled and POSTs /publish on click', async () => {
    // Use a fixture with only the DRAFT so the button is not disabled,
    // confirming the hard-block only engages when a PUBLISHED page exists.
    const SOLO = [{ ...FIXTURE[2] }]; // Bali Draft only
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages' && method === 'GET') return Promise.resolve(SOLO);
      if (url === '/api/landing-pages/templates/list') return Promise.resolve([]);
      if (url === '/api/landing-pages/102/publish' && method === 'POST') {
        return Promise.resolve({ id: 102, status: 'PUBLISHED' });
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Bali Draft')).toBeInTheDocument());

    const publishBtn = screen.getByRole('button', { name: /^Publish$/i });
    expect(publishBtn).not.toBeDisabled();

    fetchApiMock.mockClear();
    await user.click(publishBtn);

    await waitFor(() => {
      const postCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/landing-pages/102/publish' && o?.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
    });
  });

  it('Unpublish on the currently-featured row skips the swap-confirm and POSTs /:id/unpublish directly', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/100/unpublish' && method === 'POST') {
        return Promise.resolve({ id: 100, status: 'DRAFT', isFeatured: false });
      }
      return defaultFetchMock(url, opts);
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Japan 2026')).toBeInTheDocument());

    // There are two "Unpublish" buttons (Japan + Umrah). The Japan row owns
    // the first one — find the button that lives in the same .card as
    // Japan 2026.
    const japanCard = screen.getByText('Japan 2026').closest('.card');
    const unpubBtn = japanCard.querySelector('button[title*="Take this page down"]');
    expect(unpubBtn).toBeTruthy();
    await user.click(unpubBtn);

    // No confirm fires for unpublish — the un-feature is atomic with
    // the unpublish on the backend side.
    expect(confirmMock).not.toHaveBeenCalled();
    await waitFor(() => {
      const postCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/landing-pages/100/unpublish' && o?.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/no longer live/i));
  });

  it('backend 409 PUBLISH_GATE_FAILED surfaces a friendly confirm that opens the builder on accept', async () => {
    // Use a single-page fixture (no current /trips holder) so the SUT skips
    // the swap-confirm and goes straight to the POST → backend rejects.
    const SOLO = [{ ...FIXTURE[2] }];
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages' && method === 'GET') return Promise.resolve(SOLO);
      if (url === '/api/landing-pages/templates/list') return Promise.resolve([]);
      if (url === '/api/landing-pages/102/publish' && method === 'POST') {
        const err = new Error('Publish blocked');
        err.status = 409;
        err.code = 'PUBLISH_GATE_FAILED';
        err.data = { issues: [{ code: 'NO_HERO', message: 'Hero block is empty' }] };
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Bali Draft')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Publish$/i }));

    // Confirm modal — only one call (the publish-gate prompt, no swap
    // confirm because there is no current /trips holder).
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0]).toMatch(/1 issue/);
    expect(confirmMock.mock.calls[0][0]).toMatch(/builder/i);
    // Accept → navigate to the builder.
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/landing-pages/builder/102');
    });
  });
});
