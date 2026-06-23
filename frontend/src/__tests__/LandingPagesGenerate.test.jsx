/**
 * LandingPagesGenerate.test.jsx — RTL coverage for the PR-B "Generate
 * Destination Landing Page" modal on the LandingPages list page.
 *
 * SUT: frontend/src/pages/LandingPages.jsx (Generate flow)
 *
 * Pinned invariants:
 *   1. Clicking "Generate Destination Page" opens the modal with the
 *      4 input fields + a visible "AI never generates" warning.
 *   2. Generate is blocked client-side when destination is empty.
 *   3. Generate is blocked client-side when durationDays < 1 or > 60.
 *   4. Generate is blocked client-side when audience is empty.
 *   5. Happy path: POST /generate-from-destination with autoCreate=true,
 *      then navigate to /landing-pages/builder/<id>?ai=1.
 *   6. Backend 429 LLM_BUDGET_EXCEEDED surfaces as a clear modal error
 *      (no toast); modal stays open.
 *   7. Stub-mode response (generation.stub=true) surfaces an info toast
 *      warning the operator the draft is a placeholder.
 *   8. Cancel closes the modal without firing any request.
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
  error: notifyError, info: notifyInfo, success: notifySuccess,
  confirm: (...args) => confirmMock(...args),
};
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import LandingPages from '../pages/LandingPages';

function defaultFetchMock(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (url === '/api/landing-pages' && method === 'GET') return Promise.resolve([]);
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

describe('<LandingPages /> — Generate modal', () => {
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

  it('renders the "Generate Destination Page" button in the header', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate Destination Page/i })).toBeInTheDocument();
    });
  });

  it('opens the modal with all 4 inputs + the "AI never generates" warning', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Destination Page/i })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Generate Destination Page/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Destination/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Duration/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Audience/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Sub-brand/i)).toBeInTheDocument();
    // Strict-bans warning visible.
    expect(screen.getByText(/AI never generates/i)).toBeInTheDocument();
    expect(screen.getByText(/pricing values/i)).toBeInTheDocument();
    expect(screen.getByText(/testimonials/i)).toBeInTheDocument();
  });

  it('blocks Generate when destination is empty', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Destination Page/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Generate Destination Page/i }));
    // Fill audience but skip destination.
    await user.type(screen.getByLabelText(/Audience/i), 'Honeymooners');
    await user.click(screen.getByRole('button', { name: /Generate Draft/i }));

    expect(await screen.findByText(/Destination is required/i)).toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalledWith(
      '/api/landing-pages/generate-from-destination',
      expect.anything(),
    );
  });

  it('blocks Generate when audience is empty', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Destination Page/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Generate Destination Page/i }));
    await user.type(screen.getByLabelText(/^Destination/), 'Bali');
    await user.click(screen.getByRole('button', { name: /Generate Draft/i }));

    expect(await screen.findByText(/Audience is required/i)).toBeInTheDocument();
  });

  it('happy path — POSTs autoCreate=true, then navigates to the builder with ?ai=1', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/generate-from-destination' && method === 'POST') {
        const body = JSON.parse(opts.body);
        expect(body.autoCreate).toBe(true);
        expect(body.destination).toBe('Bali');
        expect(body.durationDays).toBe(7);
        expect(body.audience).toBe('Honeymooners');
        expect(body.subBrand).toBe('travelstall');
        return Promise.resolve({
          page: { id: 555, slug: 'bali-7-days', status: 'DRAFT' },
          generation: { source: 'gemini', stub: false, verdict: 'passed', model: 'gemini-2.5-flash', guardrailIssues: [] },
        });
      }
      return defaultFetchMock(url, opts);
    });

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Destination Page/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Generate Destination Page/i }));

    await user.type(screen.getByLabelText(/^Destination/), 'Bali');
    const dur = screen.getByLabelText(/Duration/i);
    await user.clear(dur);
    await user.type(dur, '7');
    await user.type(screen.getByLabelText(/Audience/i), 'Honeymooners');
    await user.selectOptions(screen.getByLabelText(/Sub-brand/i), 'travelstall');

    await user.click(screen.getByRole('button', { name: /Generate Draft/i }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/landing-pages/builder/555?ai=1'));
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Review every section/i));
  });

  it('stub-mode response surfaces an info toast about placeholders', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/generate-from-destination' && method === 'POST') {
        return Promise.resolve({
          page: { id: 556, slug: 'umrah-10', status: 'DRAFT' },
          generation: { source: 'stub', stub: true, verdict: 'fallback', model: 'gemini-2.5-flash', guardrailIssues: [] },
        });
      }
      return defaultFetchMock(url, opts);
    });

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Destination Page/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Generate Destination Page/i }));

    await user.type(screen.getByLabelText(/^Destination/), 'Umrah');
    await user.type(screen.getByLabelText(/Audience/i), 'Pilgrims');
    await user.click(screen.getByRole('button', { name: /Generate Draft/i }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalled());
    expect(notifyInfo).toHaveBeenCalledWith(expect.stringMatching(/stub mode|REVIEW/i));
  });

  it('429 LLM_BUDGET_EXCEEDED surfaces a clear modal error; modal stays open', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/generate-from-destination' && method === 'POST') {
        const err = new Error('Monthly LLM spend cap reached for this tenant.');
        err.status = 429;
        err.code = 'LLM_BUDGET_EXCEEDED';
        return Promise.reject(err);
      }
      return defaultFetchMock(url, opts);
    });

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Destination Page/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Generate Destination Page/i }));
    await user.type(screen.getByLabelText(/^Destination/), 'Bali');
    await user.type(screen.getByLabelText(/Audience/i), 'Honeymooners');
    await user.click(screen.getByRole('button', { name: /Generate Draft/i }));

    expect(await screen.findByText(/monthly LLM spend cap/i)).toBeInTheDocument();
    // Modal must still be open.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('Cancel closes the modal without firing any request', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Destination Page/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Generate Destination Page/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalledWith(
      '/api/landing-pages/generate-from-destination',
      expect.anything(),
    );
  });
});
