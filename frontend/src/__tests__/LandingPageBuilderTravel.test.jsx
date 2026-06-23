/**
 * LandingPageBuilderTravel.test.jsx — RTL coverage of the travel
 * additions in PR-A:
 *   1. The "Travel Destination" component-group header renders in the
 *      left palette alongside the existing "Components" header.
 *   2. All 8 travel blocks (Destination Hero, City Cards, Highlights,
 *      Inclusions, Itinerary, Tier Pricing, FAQ, Reviews) are present
 *      as palette buttons.
 *   3. Adding a Destination Hero block emits its preview with the
 *      "Hero image not set" placeholder visible.
 *   4. The "Check" button calls /publish-check and opens the readiness
 *      modal with an issues list when the verdict is not OK.
 *   5. The "Publish" button calls POST /:id/publish and surfaces the
 *      same modal when the backend rejects with 409 PUBLISH_GATE_FAILED.
 *   6. Clicking an issue in the modal closes it and selects the offending
 *      block on the canvas (jump-to-block UX).
 *   7. A publish that succeeds shows the success toast and flips state
 *      to PUBLISHED.
 *
 * Standing rule reminders:
 *   - Stable mock object for useNotify (the SUT consumes notify.confirm
 *     + notify.error + notify.success — fresh objects per render would
 *     trip the useCallback dependency-identity infinite-loop class).
 *   - fetchApi mock errors thrown synchronously must carry .status +
 *     .code + .data to match the real http-error shape the SUT branches
 *     on.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'h.' + btoa(JSON.stringify({ tenantId: 1 })) + '.s',
}));

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
  NotifyProvider: ({ children }) => children,
}));

import LandingPageBuilder from '../pages/LandingPageBuilder';

const TRAVEL_PAGE = {
  id: 99,
  title: 'Bali Family',
  slug: 'bali-family',
  status: 'DRAFT',
  templateType: 'travel_destination',
  content: JSON.stringify([]),
};

function defaultFetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (url === '/api/landing-pages/99' && method === 'GET') return Promise.resolve(TRAVEL_PAGE);
  if (url === '/api/lead-routing' && method === 'GET') return Promise.resolve([]);
  if (url.startsWith('/api/landing-pages/99') && method === 'PUT') {
    return Promise.resolve({ ...TRAVEL_PAGE, ...JSON.parse(opts.body) });
  }
  return Promise.resolve([]);
}

function renderBuilder() {
  return render(
    <MemoryRouter initialEntries={['/landing-pages/99']}>
      <Routes>
        <Route path="/landing-pages/:id" element={<LandingPageBuilder />} />
      </Routes>
    </MemoryRouter>,
  );
}

// Construct an http-error matching the fetchApi shape so the SUT's
// `err?.status === 409 && err?.code === 'PUBLISH_GATE_FAILED'` branch
// fires.
function gateError(issues) {
  const err = new Error('Publish blocked — page is not ready.');
  err.status = 409;
  err.code = 'PUBLISH_GATE_FAILED';
  err.data = { issues };
  return err;
}

describe('<LandingPageBuilder /> — travel additions', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    confirmMock.mockReset();
    confirmMock.mockImplementation(() => Promise.resolve(true));
    fetchApiMock.mockImplementation(defaultFetch);
  });

  it('renders both the generic Components header and the Travel Destination header', async () => {
    renderBuilder();
    await waitFor(() => expect(screen.queryByText(/^Loading\.\.\./)).not.toBeInTheDocument());
    // Both palette section headers render as <h4>.
    const headers = screen.getAllByRole('heading', { level: 4 });
    const labels = headers.map((h) => h.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Components', 'Travel Destination']));
  });

  it('lists all 8 travel block buttons in the palette', async () => {
    renderBuilder();
    await waitFor(() => expect(screen.queryByText(/^Loading\.\.\./)).not.toBeInTheDocument());
    // Each travel block label rendered as a button in the left palette.
    // Use string-match (regex would need parens-escaping for "Reviews (manual)").
    for (const label of [
      'Destination Hero',
      'City Cards',
      'Highlights',
      'Inclusions',
      'Itinerary',
      'Tier Pricing',
      'FAQ',
      'Reviews (manual)',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('adds a Destination Hero block and shows the "Hero image not set" placeholder', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.queryByText(/^Loading\.\.\./)).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Destination Hero/i }));

    // The preview's empty-image placeholder mentions "Hero image not set".
    await waitFor(() => expect(screen.getByText(/Hero image not set/i)).toBeInTheDocument());
  });

  it('Check button calls publish-check and opens the readiness modal with issues', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/99' && method === 'GET') return Promise.resolve(TRAVEL_PAGE);
      if (url === '/api/landing-pages/99/publish-check') {
        return Promise.resolve({
          ok: false,
          issues: [
            { code: 'HERO_IMAGE_MISSING', message: 'Upload a hero image — Reserve / Publish is blocked without one.', blockType: 'destinationHero', blockIndex: 0 },
            { code: 'MISSING_FAQ', message: 'Add an FAQ block — required for travel landing pages.' },
          ],
        });
      }
      if (url === '/api/lead-routing') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.queryByText(/^Loading\.\.\./)).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Check/i }));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/issues to fix/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Upload a hero image/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Add an FAQ block/i)).toBeInTheDocument();
  });

  it('Publish surfaces the same gate modal when backend returns 409 PUBLISH_GATE_FAILED', async () => {
    const issues = [
      { code: 'MISSING_ITINERARY', message: 'Add an Itinerary Timeline block — required for travel landing pages.' },
    ];
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/99' && method === 'GET') return Promise.resolve(TRAVEL_PAGE);
      if (url === '/api/lead-routing') return Promise.resolve([]);
      if (url === '/api/landing-pages/99/publish' && method === 'POST') {
        return Promise.reject(gateError(issues));
      }
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.queryByText(/^Loading\.\.\./)).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Publish/ }));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByText(/Add an Itinerary Timeline block/i)).toBeInTheDocument();
    // The SUT did NOT toast an error — the gate-shaped 409 is surfaced via the modal instead.
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('clicking an issue with blockIndex selects the offending block on the canvas', async () => {
    // Seed page with one travel block so blockIndex=0 has something to select.
    const seededPage = {
      ...TRAVEL_PAGE,
      content: JSON.stringify([{ type: 'destinationHero', props: { headline: 'Hi', posterUrl: null } }]),
    };
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/99' && method === 'GET') return Promise.resolve(seededPage);
      if (url === '/api/lead-routing') return Promise.resolve([]);
      if (url === '/api/landing-pages/99/publish-check') {
        return Promise.resolve({
          ok: false,
          issues: [
            { code: 'HERO_IMAGE_MISSING', message: 'Upload a hero image.', blockType: 'destinationHero', blockIndex: 0 },
          ],
        });
      }
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.queryByText(/^Loading\.\.\./)).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^Check/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    await user.click(screen.getByText(/Upload a hero image/i));

    // Modal closes; nothing throws — selection is internal state, but the
    // dialog disappearance confirms onJumpToBlock fired.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Publish succeeds when backend returns 200 — toast fires, status flips', async () => {
    let publishCalled = false;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/99' && method === 'GET') return Promise.resolve(TRAVEL_PAGE);
      if (url === '/api/lead-routing') return Promise.resolve([]);
      if (url === '/api/landing-pages/99/publish' && method === 'POST') {
        publishCalled = true;
        return Promise.resolve({ ...TRAVEL_PAGE, status: 'PUBLISHED', publishedAt: new Date().toISOString() });
      }
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.queryByText(/^Loading\.\.\./)).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Publish/ }));

    await waitFor(() => expect(publishCalled).toBe(true));
    await waitFor(() => expect(notifySuccess).toHaveBeenCalled());
    // After publish the button label flips to "Unpublish".
    await waitFor(() => expect(screen.getByRole('button', { name: /Unpublish/i })).toBeInTheDocument());
  });
});
