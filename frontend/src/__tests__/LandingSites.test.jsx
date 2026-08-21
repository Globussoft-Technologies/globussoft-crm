import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../App';

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
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import LandingSites from '../pages/LandingSites';

let intersectionCallback = null;
beforeEach(() => {
  intersectionCallback = null;
  global.IntersectionObserver = class IntersectionObserver {
    constructor(cb) {
      intersectionCallback = cb;
    }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
  };
});

function isoAtLocalMonthOffset(monthOffset, day = 1) {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth() + monthOffset,
    day,
    10,
    0,
    0,
    0,
  ).toISOString();
}

function defaultFetchMock(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (String(url).startsWith('/api/landing-sites') && method === 'GET') {
    return Promise.resolve({ pages: [], pinnedPage: null, hasMore: false, total: 0 });
  }
  if (url === '/api/landing-sites/generate' && method === 'POST') {
    return Promise.resolve({ page: { id: 99 }, generation: { stub: false, verdict: 'passed' } });
  }
  return Promise.resolve([]);
}

const LANDING_SITE_FIXTURE = [
  {
    id: 10,
    title: 'Hair Treatment Launch',
    slug: 'hair-treatment-launch',
    status: 'PUBLISHED',
    visits: 142,
    submissions: 18,
    templateType: 'generic-site-wellness-v1',
    description: 'Live wellness landing site',
    createdAt: isoAtLocalMonthOffset(0, 1),
    updatedAt: isoAtLocalMonthOffset(0, 2),
    publishedAt: isoAtLocalMonthOffset(0, 3),
  },
  {
    id: 11,
    title: 'Hair Consultation Draft',
    slug: 'hair-consultation-draft',
    status: 'DRAFT',
    visits: 12,
    submissions: 2,
    templateType: 'generic-site-wellness-v1',
    description: 'Draft wellness landing site',
    createdAt: isoAtLocalMonthOffset(-1, 4),
    updatedAt: isoAtLocalMonthOffset(-1, 5),
    publishedAt: null,
  },
];

const LANDING_SITE_PAGE_2 = {
  id: 12,
  title: 'Weekend Wellness Reset',
  slug: 'weekend-wellness-reset',
  status: 'DRAFT',
  visits: 4,
  submissions: 1,
  templateType: 'generic-site-wellness-v1',
  description: 'Second page loaded via infinite scroll',
  createdAt: isoAtLocalMonthOffset(-2, 6),
  updatedAt: isoAtLocalMonthOffset(-2, 7),
  publishedAt: null,
};

function makeLandingSitesResponse(pages, pinnedPage = null, hasMore = false) {
  return { pages, pinnedPage, hasMore, total: pages.length + (pinnedPage ? 1 : 0) };
}

function renderPage(vertical = 'generic') {
  return render(
    <AuthContext.Provider value={{ tenant: { vertical }, user: { tenant: { vertical } } }}>
      <MemoryRouter>
        <LandingSites />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('<LandingSites /> wellness generate modal', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    navigateMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a fixed wellness text field instead of the sector dropdown', async () => {
    const user = userEvent.setup();
    renderPage('wellness');

    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Landing Site/i })).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: /Generate Landing Site/i })[0]);

    const sectorField = screen.getByRole('textbox', { name: /Sector/i });
    expect(sectorField).toHaveValue('wellness');
    expect(sectorField).toHaveAttribute('readOnly');
    expect(screen.queryByRole('combobox', { name: /Sector/i })).not.toBeInTheDocument();
  });

  it('posts sectorKey=wellness when generating from the wellness modal', async () => {
    const user = userEvent.setup();
    renderPage('wellness');

    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Landing Site/i })).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: /Generate Landing Site/i })[0]);

    await user.type(screen.getByLabelText(/Campaign name/i), 'Rooted Wellness Camp');
    await user.type(screen.getByLabelText(/Campaign goal/i), 'collect registrations');
    await user.type(screen.getByLabelText(/Audience/i), 'members');

    await user.click(screen.getByRole('button', { name: /^Generate$/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/landing-sites/generate' && opts?.method === 'POST');
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.sectorKey).toBe('wellness');
      expect(body.campaignName).toBe('Rooted Wellness Camp');
      expect(navigateMock).toHaveBeenCalledWith('/landing-sites/builder/99?ai=1');
    });
  });

  it('pins event date/time to now and rejects past slots before submit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 11, 13, 35, 0));

    const user = userEvent.setup();
    renderPage('wellness');

    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Landing Site/i })).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: /Generate Landing Site/i })[0]);

    const dateInput = screen.getByLabelText(/Event date/i);
    const timeInput = screen.getByLabelText(/Event time/i);
    expect(dateInput).toHaveAttribute('min', '2026-08-11');

    await user.type(screen.getByLabelText(/Campaign name/i), 'Rooted Wellness Camp');
    await user.type(screen.getByLabelText(/Campaign goal/i), 'collect registrations');
    await user.type(screen.getByLabelText(/Audience/i), 'members');

    fireEvent.change(dateInput, { target: { value: '2026-08-11' } });
    expect(timeInput).toHaveAttribute('min', '13:35');

    fireEvent.change(timeInput, { target: { value: '13:34' } });
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));

    await waitFor(() => expect(screen.getAllByText(/event time cannot be earlier than the current time/i).length).toBeGreaterThan(0));
    expect(fetchApiMock.mock.calls.some(([url, opts]) => url === '/api/landing-sites/generate' && opts?.method === 'POST')).toBe(false);
  });
  it('realModeError for Gemini quota exhaustion shows the friendly toast', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-sites/generate' && method === 'POST') {
        return Promise.resolve({
          page: { id: 777 },
          generation: { stub: false, verdict: 'passed', realModeError: 'Gemini limit has been exhausted. Please try again later.' },
        });
      }
      return defaultFetchMock(url, opts);
    });

    const user = userEvent.setup();
    renderPage('wellness');

    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Landing Site/i })).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: /Generate Landing Site/i })[0]);
    await user.type(screen.getByLabelText(/Campaign name/i), 'Rooted Wellness Camp');
    await user.type(screen.getByLabelText(/Campaign goal/i), 'collect registrations');
    await user.type(screen.getByLabelText(/Audience/i), 'members');
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/landing-sites/builder/777?ai=1'));
    expect(notifyError).toHaveBeenCalledWith('Gemini limit has been exhausted. Please try again later.');
  });

  it('still shows the dropdown for non-wellness tenants', async () => {
    const user = userEvent.setup();
    renderPage('generic');

    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Landing Site/i })).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: /Generate Landing Site/i })[0]);

    const sectorSelect = screen.getByRole('combobox', { name: /Sector/i });
    expect(sectorSelect).toHaveValue('general');
    expect(screen.queryByRole('textbox', { name: /Sector/i })).not.toBeInTheDocument();
  });

  it('filters wellness landing sites by created date and keeps the live page pinned first', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (String(url).startsWith('/api/landing-sites') && method === 'GET') return Promise.resolve(makeLandingSitesResponse([LANDING_SITE_FIXTURE[1]], LANDING_SITE_FIXTURE[0], false));
      if (url === '/api/landing-sites/templates/list' && method === 'GET') return Promise.resolve([]);
      return defaultFetchMock(url, opts);
    });
    renderPage('wellness');

    await waitFor(() => expect(screen.getByText('Hair Treatment Launch')).toBeInTheDocument());
    expect(screen.getByText('Pinned - Active Site')).toBeInTheDocument();

    const filterSelect = screen.getByRole('combobox');
    fireEvent.change(filterSelect, { target: { value: 'thisMonth' } });

    await waitFor(() => expect(screen.queryByText('Hair Consultation Draft')).not.toBeInTheDocument());
    expect(screen.getByText('Hair Treatment Launch')).toBeInTheDocument();
    expect(screen.queryByText('Hair Consultation Draft')).toBeNull();
  });
  it('pins the published landing site first and disables draft publish when another page is already live', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (String(url).startsWith('/api/landing-sites') && method === 'GET') return Promise.resolve(makeLandingSitesResponse([LANDING_SITE_FIXTURE[1]], LANDING_SITE_FIXTURE[0], false));
      if (url === '/api/landing-sites/templates/list' && method === 'GET') return Promise.resolve([]);
      return defaultFetchMock(url, opts);
    });
    renderPage('wellness');

    await waitFor(() => expect(screen.getByText('Hair Treatment Launch')).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 3, name: 'Hair Treatment Launch' })).toBeInTheDocument();

    const publishButton = screen.getByRole('button', { name: /^Publish$/i });
    expect(publishButton).toBeDisabled();
    expect(publishButton.title).toMatch(/only one published landing site/i);
  });

  it('loads the next page when the infinite-scroll sentinel enters view', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (String(url).startsWith('/api/landing-sites') && method === 'GET') {
        const isPageTwo = String(url).includes('page=2');
        if (isPageTwo) {
          return Promise.resolve(makeLandingSitesResponse([LANDING_SITE_PAGE_2], LANDING_SITE_FIXTURE[0], false));
        }
        return Promise.resolve(makeLandingSitesResponse([LANDING_SITE_FIXTURE[1]], LANDING_SITE_FIXTURE[0], true));
      }
      if (url === '/api/landing-sites/templates/list' && method === 'GET') return Promise.resolve([]);
      return defaultFetchMock(url, opts);
    });

    renderPage('wellness');

    await waitFor(() => expect(screen.getByText('Hair Treatment Launch')).toBeInTheDocument());
    expect(screen.queryByText('Weekend Wellness Reset')).not.toBeInTheDocument();

    await act(async () => {
      intersectionCallback?.([{ isIntersecting: true }]);
    });

    await waitFor(() => expect(screen.getByText('Weekend Wellness Reset')).toBeInTheDocument());
  });
});

