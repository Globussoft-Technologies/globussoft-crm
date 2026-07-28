import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

function defaultFetchMock(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (url === '/api/landing-sites' && method === 'GET') return Promise.resolve([]);
  if (url === '/api/landing-sites/generate' && method === 'POST') {
    return Promise.resolve({ page: { id: 99 }, generation: { stub: false, verdict: 'passed' } });
  }
  return Promise.resolve([]);
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

  it('still shows the dropdown for non-wellness tenants', async () => {
    const user = userEvent.setup();
    renderPage('generic');

    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Landing Site/i })).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: /Generate Landing Site/i })[0]);

    const sectorSelect = screen.getByRole('combobox', { name: /Sector/i });
    expect(sectorSelect).toHaveValue('general');
    expect(screen.queryByRole('textbox', { name: /Sector/i })).not.toBeInTheDocument();
  });
});

