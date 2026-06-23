/**
 * LandingPagesFeatured.test.jsx — RTL coverage for the Featured /trips
 * resolver UX added to the LandingPages list page.
 *
 * SUT: frontend/src/pages/LandingPages.jsx
 *
 * Scope:
 *   1. PUBLISHED rows render a "Feature" button.
 *   2. DRAFT rows render a disabled "Feature" button (publish-first
 *      affordance — backend would 409 PAGE_NOT_PUBLISHED anyway).
 *   3. Currently-featured rows render the "★ Featured" badge AND
 *      swap the action button to "Unfeature".
 *   4. Clicking Feature on a PUBLISHED page when no other page is
 *      featured shows a simple confirm + POSTs /:id/feature.
 *   5. Clicking Feature when another page is already featured in the
 *      same (tenantId, subBrand) scope shows a swap-confirm naming
 *      the page that will be unfeatured.
 *   6. Backend 409 PAGE_NOT_PUBLISHED surfaces as an error toast (not
 *      a modal) — defence-in-depth in case the client-side disable
 *      somehow gets bypassed.
 *   7. Unfeature flow confirms + POSTs /:id/unfeature.
 *
 * Standing-rule notes (CLAUDE.md):
 *   - Stable mock object for useNotify (fresh objects per render trip
 *     the useCallback dep-identity infinite loop).
 *   - Confirm is a vi.fn() so each test can choose accept / reject.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

// Three pages in the same (tenantId, subBrand=tmc) scope. publishedFeatured
// is the current /trips holder; publishedSibling is a candidate to swap in;
// draftRow is a publish-first row.
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
    subBrand: 'tmc',
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
    subBrand: 'tmc',
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

describe('<LandingPages /> — Featured / Unfeature UX', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    navigateMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });

  it('renders the ★ Featured badge on the currently featured row', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Japan 2026')).toBeInTheDocument());
    // The badge text is "Featured" — pin via getByText.
    const badge = screen.getByText('Featured');
    expect(badge).toBeInTheDocument();
    // Only the Japan row should carry the badge — exactly one in the DOM.
    expect(screen.getAllByText('Featured').length).toBe(1);
  });

  it('the currently-featured row shows the Unfeature action button (not Feature)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Japan 2026')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Unfeature/i })).toBeInTheDocument();
  });

  it('PUBLISHED non-featured row shows an enabled Feature button', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Umrah 2026')).toBeInTheDocument());
    // There may be multiple Feature buttons (one per non-featured PUBLISHED row + draft rows).
    const featureButtons = screen.getAllByRole('button', { name: /^Feature$/i });
    // The PUBLISHED sibling's button is enabled.
    const enabled = featureButtons.find((b) => !b.disabled);
    expect(enabled).toBeTruthy();
  });

  it('DRAFT row renders a disabled Feature button with publish-first tooltip', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bali Draft')).toBeInTheDocument());
    const featureButtons = screen.getAllByRole('button', { name: /^Feature$/i });
    const disabled = featureButtons.find((b) => b.disabled);
    expect(disabled).toBeTruthy();
    expect(disabled).toHaveAttribute('title', expect.stringMatching(/Publish first/i));
  });

  it('clicking Feature on a sibling shows a swap-confirm naming the current featured page', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/101/feature' && method === 'POST') {
        return Promise.resolve({ id: 101, isFeatured: true });
      }
      return defaultFetchMock(url, opts);
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Umrah 2026')).toBeInTheDocument());

    const featureButtons = screen.getAllByRole('button', { name: /^Feature$/i });
    const enabledFeature = featureButtons.find((b) => !b.disabled);
    await user.click(enabledFeature);

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    const confirmArg = confirmMock.mock.calls[0][0];
    expect(confirmArg).toMatch(/Umrah 2026/);
    expect(confirmArg).toMatch(/Japan 2026/);
    expect(confirmArg).toMatch(/unfeature/i);

    // Confirm resolves true → POST /feature should have been fired.
    await waitFor(() => {
      const postCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/landing-pages/101/feature' && o?.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/featured/i));
  });

  it('declining the swap-confirm does NOT POST /feature', async () => {
    confirmMock.mockResolvedValue(false);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Umrah 2026')).toBeInTheDocument());

    const enabledFeature = screen.getAllByRole('button', { name: /^Feature$/i }).find((b) => !b.disabled);
    await user.click(enabledFeature);

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    const postCalls = fetchApiMock.mock.calls.filter(
      ([u, o]) => o?.method === 'POST' && /feature/.test(u),
    );
    expect(postCalls.length).toBe(0);
  });

  it('backend 409 PAGE_NOT_PUBLISHED surfaces as an error toast', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/101/feature' && method === 'POST') {
        const err = new Error('Only published pages can be featured.');
        err.status = 409;
        err.code = 'PAGE_NOT_PUBLISHED';
        return Promise.reject(err);
      }
      return defaultFetchMock(url, opts);
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Umrah 2026')).toBeInTheDocument());

    const enabledFeature = screen.getAllByRole('button', { name: /^Feature$/i }).find((b) => !b.disabled);
    await user.click(enabledFeature);

    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    const errArg = notifyError.mock.calls[0][0];
    expect(errArg).toMatch(/Publish/i);
  });

  it('clicking Unfeature shows a confirm + POSTs /:id/unfeature on accept', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/100/unfeature' && method === 'POST') {
        return Promise.resolve({ id: 100, isFeatured: false });
      }
      return defaultFetchMock(url, opts);
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Japan 2026')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Unfeature/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0]).toMatch(/Japan 2026/);
    await waitFor(() => {
      const postCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/landing-pages/100/unfeature' && o?.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/no longer featured/i));
  });
});
