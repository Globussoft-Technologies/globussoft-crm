/**
 * LandingPages.test.jsx — vitest + RTL coverage for the marketing
 * Landing Pages INDEX page (sibling to LandingPageBuilder which is its
 * own page + own test file).
 *
 * SUT: frontend/src/pages/LandingPages.jsx (183 LOC, was previously
 *      untested at the page level; closes the test-coverage gap).
 *
 * Scope: pins the page-surface invariants exactly as the source code
 * renders them today — what the operator sees on /landing-pages.
 *
 *   1. Header chrome — "Landing Pages" heading + subtitle + a "Create
 *      Page" CTA in the top-right.
 *   2. Loading state — "Loading..." text renders while the initial
 *      /api/landing-pages fetch is in-flight.
 *   3. Empty state — when the list is [], the page renders the empty-
 *      state card with "No landing pages yet" + a secondary "Create
 *      Page" CTA inside the card.
 *   4. Populated list — one card per page with title, status badge, and
 *      a per-page analytics summary (Visits / Leads / Conv. tiles).
 *   5. Conversion rate is formatPercent(submissions / visits * 100)
 *      with 1-decimal precision (#639 contract) — 7 leads / 100 visits
 *      renders as "7.0%", not "7%" or "0%".
 *   6. Conversion rate falls back to "0.0%" (not "—" / "NaN%") when
 *      visits == 0 — pre-#639 the bare-integer fallback rendered "0%".
 *   7. The "View" link was removed (the hardcoded :5173→:5000 port swap
 *      only worked on default Vite dev port). Edit links remain — one
 *      per row (PUBLISHED + DRAFT) — pointing at /landing-pages/builder/:id.
 *   8. The publish-toggle button reads "Publish" for a DRAFT page and
 *      "Unpublish" for a PUBLISHED page; clicking fires the matching
 *      POST /api/landing-pages/:id/{publish|unpublish}.
 *   9. Clicking "Create Page" opens the template-picker modal with the
 *      templates from /api/landing-pages/templates/list plus a "Blank
 *      Page" tile (#377 — blank picks a seeded heading + text block
 *      pair so the editor doesn't render an empty canvas).
 *  10. Picking a template POSTs /api/landing-pages with the seed
 *      content + navigates to the builder for the returned id.
 *  11. The delete confirm dialog (#452) embeds the page title and a
 *      stronger warning when the page is PUBLISHED (mentions the
 *      public URL going offline); cancelling does NOT fire DELETE.
 *
 * Drift / known-bug discipline: if any assertion catches a real bug,
 * the test is marked `it.skip()` with a TODO referencing a GH issue
 * filed via `gh issue create` (no source-file edits in this scope).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

// Stable single mock object — fresh objects per render trip the
// useCallback dependency-identity infinite-loop class (see CLAUDE.md
// "RTL: stable mock object references for hooks used in useCallback").
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

const samplePages = [
  {
    id: 11,
    title: 'Spring Launch',
    slug: 'spring-launch',
    status: 'PUBLISHED',
    visits: 100,
    submissions: 7,
  },
  {
    id: 12,
    title: 'Winter Promo Draft',
    slug: 'winter-promo',
    status: 'DRAFT',
    visits: 0,
    submissions: 0,
  },
];

const sampleTemplates = [
  { id: 'lead-gen', name: 'Lead Gen', description: 'Capture leads fast', content: [{ id: 'h1', type: 'heading', props: { text: 'LeadGen Hero' } }] },
  { id: 'event', name: 'Event RSVP', description: 'RSVP capture', content: [{ id: 'h2', type: 'heading', props: { text: 'Event Hero' } }] },
];

function defaultFetchMock(url, opts) {
  if (url === '/api/landing-pages' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(samplePages);
  }
  if (url === '/api/landing-pages/templates/list') {
    return Promise.resolve(sampleTemplates);
  }
  return Promise.resolve(null);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <LandingPages />
    </MemoryRouter>
  );
}

describe('<LandingPages /> — index page surface', () => {
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

  it('renders the header + subtitle + a top-right "Create Page" CTA', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Landing Pages/i })).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Build no-code landing pages to capture leads/i),
    ).toBeInTheDocument();
    // The header CTA is one of (potentially) two "Create Page" buttons —
    // empty-state has a second one, but with populated data it's the only
    // one. Pin via getAllByRole + length >= 1.
    expect(
      screen.getAllByRole('button', { name: /Create Page/i }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('shows "Loading..." while the initial /api/landing-pages fetch is in flight', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/landing-pages') {
        return new Promise((r) => { resolveList = r; });
      }
      if (url === '/api/landing-pages/templates/list') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText(/Loading\.\.\./i)).toBeInTheDocument();
    // Resolve cleanly so the component unmounts without an unhandled promise.
    resolveList([]);
    await waitFor(() => {
      expect(screen.queryByText(/Loading\.\.\./i)).not.toBeInTheDocument();
    });
  });

  it('renders the empty-state card with "No landing pages yet" + an in-card Create Page CTA when the list is []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/landing-pages') return Promise.resolve([]);
      if (url === '/api/landing-pages/templates/list') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText(/No landing pages yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Create your first landing page from a template/i),
    ).toBeInTheDocument();
    // Header CTA + empty-state CTA = at least 2 "Create Page" buttons.
    expect(
      screen.getAllByRole('button', { name: /Create Page/i }).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('renders one card per page with title, status badge, and Visits / Leads / Conv. tiles', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Spring Launch')).toBeInTheDocument();
    });
    expect(screen.getByText('Winter Promo Draft')).toBeInTheDocument();
    // Status badges render as raw uppercase text.
    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    // Tile labels.
    expect(screen.getAllByText(/Visits/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Leads/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Conv\./i).length).toBeGreaterThanOrEqual(1);
    // Per-page numeric tiles render — page 11 has 100 visits + 7 leads.
    expect(screen.getByText('100')).toBeInTheDocument();
    // Both pages have a 0-submissions tile (page 12) + page 11's 7
    // submissions. Pin specifically that "7" appears as a Leads tile.
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('renders the conversion rate with 1-decimal precision (#639 — "7.0%" not "7%")', async () => {
    renderPage();
    // 7 submissions / 100 visits = 7.0%
    expect(await screen.findByText('7.0%')).toBeInTheDocument();
    // Sibling DRAFT page has 0 visits → 0.0% fallback (NOT "0%" or "—").
    // formatPercent guarantees "0.0%" for the literal-zero case (#639).
    expect(screen.getByText('0.0%')).toBeInTheDocument();
  });

  it('does NOT render a "View" link any more (button was removed); each row has an Edit link to /landing-pages/builder/:id', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Spring Launch')).toBeInTheDocument());
    // No "View" link on either row — the SUT comment explains the hardcoded
    // :5173→:5000 host swap was unreliable and the Preview action inside the
    // builder covers the same need.
    expect(screen.queryByRole('link', { name: /^View$/i })).toBeNull();
    // Edit links go to the builder, one per page = 2.
    const editLinks = screen.getAllByRole('link', { name: /Edit/i });
    expect(editLinks.length).toBe(2);
    expect(editLinks.some((a) => a.getAttribute('href') === '/landing-pages/builder/11')).toBe(true);
    expect(editLinks.some((a) => a.getAttribute('href') === '/landing-pages/builder/12')).toBe(true);
  });

  it('publish-toggle reads "Publish" for DRAFT + "Unpublish" for PUBLISHED; clicking fires the matching POST', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Spring Launch')).toBeInTheDocument());
    // Both buttons render on first paint — one for each row.
    expect(screen.getByRole('button', { name: /^Publish$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Unpublish$/i })).toBeInTheDocument();

    // Click Unpublish (row 11, PUBLISHED → unpublish). loadPages() then
    // re-fires GET /api/landing-pages which under the default mock returns
    // the SAME samplePages array, so the buttons render again afterwards.
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Unpublish$/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/landing-pages/11/unpublish' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
    });

    // Re-query the Publish button (post-rerender — the original reference
    // detaches after loadPages() refetches).
    fetchApiMock.mockClear();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Publish$/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Publish$/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/landing-pages/12/publish' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
    });
  });

  it('clicking the header Create Page button opens the template picker with templates + Blank Page tile', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Spring Launch')).toBeInTheDocument());
    // Click the FIRST Create Page button (the header one — only one renders
    // when pages exist, so getByRole works for the populated case).
    fireEvent.click(screen.getByRole('button', { name: /Create Page/i }));
    // Modal heading.
    expect(await screen.findByText(/Choose a Template/i)).toBeInTheDocument();
    // Both fetched templates render.
    expect(screen.getByText('Lead Gen')).toBeInTheDocument();
    expect(screen.getByText('Event RSVP')).toBeInTheDocument();
    expect(screen.getByText(/Capture leads fast/i)).toBeInTheDocument();
    // Blank Page tile renders alongside the fetched templates (#377 seeded).
    expect(screen.getByText(/Blank Page/i)).toBeInTheDocument();
    expect(screen.getByText(/Start from scratch/i)).toBeInTheDocument();
    // Cancel button is rendered.
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
  });

  it('clicking a template tile POSTs /api/landing-pages with seed content + navigates to the builder', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/landing-pages' && opts?.method === 'POST') {
        return Promise.resolve({ id: 42, title: 'Lead Gen', status: 'DRAFT' });
      }
      return defaultFetchMock(url, opts);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Spring Launch')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Create Page/i }));
    await screen.findByText(/Choose a Template/i);
    // Click the "Lead Gen" template tile.
    fireEvent.click(screen.getByText('Lead Gen'));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/landing-pages' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.templateType).toBe('lead-gen');
      expect(body.title).toBe('Lead Gen');
      // Seed content is a JSON-stringified array of blocks.
      const parsedContent = JSON.parse(body.content);
      expect(Array.isArray(parsedContent)).toBe(true);
      expect(parsedContent[0].type).toBe('heading');
    });
    // Post-create navigation goes to the builder for the returned id.
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/landing-pages/builder/42');
    });
  });

  it('delete confirm dialog (#452) embeds the page title + a stronger warning when PUBLISHED; cancel skips the DELETE', async () => {
    // Reject the first confirm so the DELETE is never fired.
    confirmMock.mockResolvedValueOnce(false);
    renderPage();
    await waitFor(() => expect(screen.getByText('Spring Launch')).toBeInTheDocument());
    // Find the delete button for the PUBLISHED page. The Trash icon button
    // has no accessible name, so locate it by sibling-button position
    // within the published card. Per the post-merge Publish-also-features
    // collapse, the page renders Edit (link) + Unpublish + duplicate +
    // delete; the delete button is the only one styled with red color,
    // but in the DOM the easiest unique pin is by walking from the
    // Spring Launch <h3> up to its card ancestor and querying buttons
    // inside.
    const cardTitle = screen.getByText('Spring Launch');
    const card = cardTitle.closest('.card');
    expect(card).toBeTruthy();
    const buttons = card.querySelectorAll('button');
    // The 3 buttons inside a published card: Unpublish (with text),
    // duplicate (icon-only), delete (icon-only). DRAFT card is the
    // same shape (Publish in place of Unpublish). Delete is the LAST
    // button in the action row.
    const deleteBtn = buttons[buttons.length - 1];

    fetchApiMock.mockClear();
    fireEvent.click(deleteBtn);

    // The confirm dialog message embeds the title + PUBLISHED warning.
    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalled();
    });
    const msg = confirmMock.mock.calls[0][0];
    expect(msg).toMatch(/Spring Launch/);
    expect(msg).toMatch(/PUBLISHED/i);
    expect(msg).toMatch(/\/p\/spring-launch/);

    // Cancel path → DELETE never fires.
    const deleteCall = fetchApiMock.mock.calls.find(
      ([, o]) => o?.method === 'DELETE',
    );
    expect(deleteCall).toBeUndefined();
  });
});
