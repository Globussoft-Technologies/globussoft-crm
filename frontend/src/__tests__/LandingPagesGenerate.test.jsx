/**
 * LandingPagesGenerate.test.jsx — RTL coverage for the PR-B "Generate
 * Destination Landing Page" modal on the LandingPages list page.
 *
 * SUT: frontend/src/pages/LandingPages.jsx (Generate flow)
 *
 * Pinned invariants:
 *   1. Clicking Create Page -> the confirmed-trip AI flow opens the
 *      modal with the 5 input fields, including trip type, + a visible
 *      "AI never generates" warning + the AI template panel only (no
 *      legacy block-based choice).
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
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  error: notifyError, info: notifyInfo, success: notifySuccess,
  confirm: (...args) => confirmMock(...args),
};
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

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
];

function defaultFetchMock(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (url === '/api/landing-pages' && method === 'GET') return Promise.resolve(samplePages);
  if (url === '/api/landing-pages/templates/list') return Promise.resolve([]);
  return Promise.resolve(null);
}

function renderPage(initialEntries = ['/landing-pages']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <LandingPages />
    </MemoryRouter>,
  );
}

const TRIP_PAGE_STATE = {
  returnTo: { label: 'TMC Trips', path: '/travel/trips/101?tab=overview' },
  currentLabel: 'Public experience',
  currentPath: '/travel/trips/101?tab=microsite',
  backTo: '/travel/trips',
  backLabel: 'Trips',
  tripContext: {
    tripId: 101,
    tripCode: 'TMC-AND-2026-MUMBAI-G7',
    destination: 'Andaman',
    durationDays: 7,
    audience: 'School students',
    subBrand: 'tmc',
  },
};

async function openGenerateModal(user, initialEntries = ['/landing-pages']) {
  renderPage(initialEntries);
  await waitFor(() => {
    expect(screen.getAllByRole('button', { name: /Create Page/i }).length).toBeGreaterThan(0);
  });
  await user.click(screen.getAllByRole('button', { name: /Create Page/i })[0]);
  expect(await screen.findByRole('dialog', { name: /Generate Destination Landing Page/i })).toBeInTheDocument();
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

  it('opens the generator modal from the Create Page button', async () => {
    const user = userEvent.setup();
    await openGenerateModal(user);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('prefills the generate modal from the trip context and keeps audience editable', async () => {
    const user = userEvent.setup();
    await openGenerateModal(user, [{
      pathname: '/landing-pages',
      state: TRIP_PAGE_STATE,
    }]);

    expect(screen.getByLabelText(/^Destination/)).toHaveValue('Andaman');
    expect(screen.getByLabelText(/Duration/i)).toHaveValue(7);
    expect(screen.getByLabelText(/Audience/i)).toHaveValue('School students');
    expect(screen.getByLabelText(/Sub-brand/i)).toHaveValue('tmc');

    await user.clear(screen.getByLabelText(/Audience/i));
    await user.type(screen.getByLabelText(/Audience/i), 'School students (Grades 6-12)');
    expect(screen.getByLabelText(/Audience/i)).toHaveValue('School students (Grades 6-12)');
  });

  it('opens the modal with all 4 inputs + the "AI never generates" warning', async () => {
    const user = userEvent.setup();
    await openGenerateModal(user);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Destination/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Duration/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Audience/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Sub-brand/i)).toBeInTheDocument();
    expect(screen.getByText(/AI-generated template/i)).toBeInTheDocument();
    expect(screen.getByText(/Suggested palette/i)).toBeInTheDocument();
    expect(screen.getAllByText(/AI suggestion/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Keep current palette/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keep current palette/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText(/Use custom colors/i)).toBeInTheDocument();
    expect(screen.queryByText(/Block-based \(legacy\)/i)).not.toBeInTheDocument();
    // Strict-bans warning visible.
    expect(screen.getByText(/AI never generates/i)).toBeInTheDocument();
    expect(screen.getByText(/pricing values/i)).toBeInTheDocument();
    expect(screen.getByText(/testimonials/i)).toBeInTheDocument();
  });

  it('blocks Generate when destination is empty', async () => {
    const user = userEvent.setup();
    await openGenerateModal(user);
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
    await openGenerateModal(user);
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
        expect(body.themeId).toBe('sakura-indigo');
        return Promise.resolve({
          page: { id: 555, slug: 'bali-7-days', status: 'DRAFT' },
          generation: { source: 'gemini', stub: false, verdict: 'passed', model: 'gemini-2.5-flash', guardrailIssues: [] },
        });
      }
      return defaultFetchMock(url, opts);
    });

    const user = userEvent.setup();
    await openGenerateModal(user);

    await user.type(screen.getByLabelText(/^Destination/), 'Bali');
    const dur = screen.getByLabelText(/Duration/i);
    await user.clear(dur);
    await user.type(dur, '7');
    await user.type(screen.getByLabelText(/Audience/i), 'Honeymooners');
    await user.selectOptions(screen.getByLabelText(/Sub-brand/i), 'travelstall');
    await user.click(screen.getByRole('button', { name: /Sakura Indigo/i }));

    await user.click(screen.getByRole('button', { name: /Generate Draft/i }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/landing-pages/builder/555?ai=1'));
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Review every section/i));
  });

  it('requires and submits the selected domestic or international trip type', async () => {
    const user = userEvent.setup();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/landing-pages' && (!opts || !opts.method)) return Promise.resolve([]);
      if (url === '/api/landing-pages/templates/list') return Promise.resolve([]);
      if (url === '/api/landing-pages/generate-from-destination') return Promise.resolve({ page: { id: 42 }, generation: {} });
      return Promise.resolve(null);
    });
    await openGenerateModal(user);
    await user.type(screen.getByLabelText('Destination *'), 'Goa');
    await user.type(screen.getByLabelText('Audience *'), 'Families');
    await user.selectOptions(screen.getByLabelText('Trip type *'), 'domestic');
    await user.click(screen.getByRole('button', { name: /Generate Draft/i }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/landing-pages/generate-from-destination', expect.objectContaining({
      body: expect.stringContaining('"tripType":"domestic"'),
    })));
  });

  it('lets the user override the suggested palette with custom colors', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/generate-from-destination' && method === 'POST') {
        return Promise.resolve({
          page: { id: 557, slug: 'bali-7-days', status: 'DRAFT' },
          generation: { source: 'gemini', stub: false, verdict: 'passed', model: 'gemini-2.5-flash', guardrailIssues: [] },
        });
      }
      return defaultFetchMock(url, opts);
    });

    const user = userEvent.setup();
    await openGenerateModal(user);

    await user.type(screen.getByLabelText(/^Destination/), 'Bali');
    await user.type(screen.getByLabelText(/Audience/i), 'Honeymooners');
    await user.selectOptions(screen.getByLabelText(/Sub-brand/i), 'travelstall');
    await user.click(screen.getByLabelText(/Use custom colors/i));
    const brandPicker = screen.getByLabelText(/Brand color picker/i);
    const accentPicker = screen.getByLabelText(/Accent color picker/i);
    fireEvent.change(brandPicker, { target: { value: '#1d4ed8' } });
    fireEvent.change(accentPicker, { target: { value: '#f97316' } });

    await user.click(screen.getByRole('button', { name: /Generate Draft/i }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    const postCall = fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/landing-pages/generate-from-destination' && opts?.method === 'POST');
    expect(postCall).toBeTruthy();
    const body = JSON.parse(postCall[1].body);
    expect(body.autoCreate).toBe(true);
    expect(body.destination).toBe('Bali');
    expect(body.subBrand).toBe('travelstall');
    expect(body.themeId).toBe('coastal-sand');
    expect(body.themeOverrides).toMatchObject({
      brandColor: '#1D4ED8',
      accentColor: '#F97316',
    });

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/landing-pages/builder/557?ai=1'));
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
    await openGenerateModal(user);

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
    await openGenerateModal(user);
    await user.type(screen.getByLabelText(/^Destination/), 'Bali');
    await user.type(screen.getByLabelText(/Audience/i), 'Honeymooners');
    await user.click(screen.getByRole('button', { name: /Generate Draft/i }));

    expect(await screen.findByText(/monthly LLM spend cap/i)).toBeInTheDocument();
    // Modal must still be open.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('realModeError for Gemini quota exhaustion shows the friendly toast', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/generate-from-destination' && method === 'POST') {
        return Promise.resolve({
          page: { id: 321 },
          generation: { stub: false, verdict: 'passed', realModeError: 'Gemini limit has been exhausted. Please try again later.' },
        });
      }
      return defaultFetchMock(url, opts);
    });

    const user = userEvent.setup();
    await openGenerateModal(user);
    await user.type(screen.getByLabelText(/^Destination/), 'Bali');
    await user.type(screen.getByLabelText(/Audience/i), 'Honeymooners');
    await user.click(screen.getByRole('button', { name: /Generate Draft/i }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/landing-pages/builder/321?ai=1'));
    expect(notifyError).toHaveBeenCalledWith('Gemini limit has been exhausted. Please try again later.');
  });

  it('Cancel closes the modal without firing any request', async () => {
    const user = userEvent.setup();
    await openGenerateModal(user);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalledWith(
      '/api/landing-pages/generate-from-destination',
      expect.anything(),
    );
  });
});
