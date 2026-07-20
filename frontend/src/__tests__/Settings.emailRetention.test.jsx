/**
 * Settings.jsx — #611 email-message retention toggle.
 *
 * What this test pins
 * -------------------
 *   #611 — On a freshly-loaded Settings page, the "Store sent messages"
 *          toggle MUST appear under an "Email Messages" card. The
 *          checkbox state mirrors tenant.emailRetention (industry-default
 *          ON for new tenants — pre-fix the default was OFF, sent emails
 *          vanished, the Sent folder stayed empty, threading broke).
 *
 *          When the user flips the toggle, the page MUST PUT the new
 *          value to /api/tenants/current with body { emailRetention: ... }.
 *          When retention is currently OFF a warning banner is shown.
 *
 * Backend contract pinned by this test
 * ------------------------------------
 *   - PUT /api/tenants/current accepts emailRetention boolean
 *   - GET /api/tenants/current returns tenant with emailRetention field
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifySuccess = vi.fn();
const notifyError = vi.fn();
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    success: notifySuccess,
    error: notifyError,
    info: vi.fn(),
    confirm: () => Promise.resolve(true),
  }),
}));

// Settings.jsx pulls ThemeContext + AuthContext from App.jsx; stub the
// module so the page renders standalone without booting the full app.
vi.mock('../App', () => {
  const React = require('react');
  return {
    ThemeContext: React.createContext({ theme: 'light', setTheme: () => {}, toggleTheme: () => {} }),
    AuthContext: React.createContext({ tenant: null, setTenant: () => {} }),
  };
});

import Settings from '../pages/Settings';

const baseTenant = {
  id: 1, name: 'Acme', slug: 'acme', plan: 'starter', vertical: 'generic',
  ownerEmail: 'admin@acme.com', emailRetention: true,
};

function defaultFetch(url, opts) {
  const method = opts?.method || 'GET';
  if (url === '/api/tenants/current' && method === 'GET') {
    return Promise.resolve(baseTenant);
  }
  if (url === '/api/tenants/current' && method === 'PUT') {
    const body = JSON.parse(opts.body);
    return Promise.resolve({ ...baseTenant, ...body });
  }
  if (url === '/api/wellness/branding') return Promise.reject(new Error('not wellness'));
  if (url === '/api/auth/users') return Promise.resolve([]);
  if (url === '/api/pipeline_stages') return Promise.resolve([]);
  return Promise.resolve([]);
}

function renderSettings() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>
  );
}

describe('<Settings /> — #611 email retention toggle', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifySuccess.mockReset();
    notifyError.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  it('renders the Email Messages card and reflects the current retention state', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByTestId('email-retention-card')).toBeInTheDocument());
    const toggle = screen.getByTestId('email-retention-toggle');
    expect(toggle).toBeChecked();
    // No warning banner when retention is on.
    expect(screen.queryByText(/Retention is OFF/i)).not.toBeInTheDocument();
  });

  it('renders an OFF warning banner when emailRetention === false', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/tenants/current' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ ...baseTenant, emailRetention: false });
      }
      return defaultFetch(url, opts);
    });
    renderSettings();
    await waitFor(() => expect(screen.getByTestId('email-retention-toggle')).not.toBeChecked());
    expect(screen.getByText(/Retention is OFF/i)).toBeInTheDocument();
  });

  it('flipping the toggle PUTs emailRetention to /api/tenants/current', async () => {
    const user = userEvent.setup();
    renderSettings();
    await waitFor(() => expect(screen.getByTestId('email-retention-toggle')).toBeChecked());
    await user.click(screen.getByTestId('email-retention-toggle'));

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/tenants/current' && opts?.method === 'PUT'
      );
      expect(calls.length).toBeGreaterThan(0);
      const body = JSON.parse(calls[0][1].body);
      expect(body).toEqual({ emailRetention: false });
    });
  });
});
