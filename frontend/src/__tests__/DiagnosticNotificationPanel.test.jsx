/**
 * DiagnosticNotificationPanel.jsx — "who gets told, and how" when a new
 * diagnostic is submitted for a sub-brand (2026-08-28).
 *
 * Cases:
 *   - Loads GET .../notification-settings + GET /api/staff on mount
 *   - Empty state explains the zero-config fallback behavior
 *   - Renders existing recipients with their channel chips
 *   - Add person: search filters the staff roster, excludes already-added,
 *     selecting adds a row defaulted to the "db" channel
 *   - Toggling a channel chip flips it locally
 *   - Removing a recipient drops the row
 *   - Save is disabled until something changes, then PUTs the new list
 *   - "Send test notification" POSTs and renders the per-channel result
 *   - isAdmin=false disables Save/Test + shows the read-only notice
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import DiagnosticNotificationPanel from '../pages/travel/DiagnosticNotificationPanel';

const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
};

const STAFF = [
  { id: 7, name: 'Priya Sharma', email: 'priya@example.com', role: 'ADMIN' },
  { id: 8, name: 'Raj Verma', email: 'raj@example.com', role: 'MANAGER' },
];

function mockLoad({ recipients = [], channelAvailability = { db: true, email: true, whatsapp: false }, staff = STAFF } = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (typeof url === 'string' && url.includes('/notification-settings') && !url.includes('/test')) {
      return Promise.resolve({ recipients, channelAvailability });
    }
    if (typeof url === 'string' && url.includes('/api/staff')) {
      return Promise.resolve(staff);
    }
    return Promise.resolve({});
  });
}

function renderPanel({ isAdmin = true } = {}) {
  return render(<DiagnosticNotificationPanel subBrand="tmc" notify={notifyObj} isAdmin={isAdmin} />);
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
});

describe('DiagnosticNotificationPanel — loading + empty state', () => {
  it('loads settings + staff roster on mount', async () => {
    mockLoad();
    renderPanel();
    await waitFor(() => {
      expect(fetchApiMock.mock.calls.some(([u]) => String(u).includes('notification-settings?subBrand=tmc'))).toBe(true);
      expect(fetchApiMock.mock.calls.some(([u]) => String(u).includes('/api/staff'))).toBe(true);
    });
  });

  it('shows the zero-config fallback explanation when there are no recipients', async () => {
    mockLoad({ recipients: [] });
    renderPanel();
    expect(await screen.findByText(/No one is configured yet/i)).toBeInTheDocument();
    expect(screen.getByText(/notify every Admin\/Manager on the dashboard only/i)).toBeInTheDocument();
  });
});

describe('DiagnosticNotificationPanel — recipients', () => {
  it('renders an existing recipient with active channel chips', async () => {
    mockLoad({
      recipients: [{ userId: 7, name: 'Priya Sharma', email: 'priya@example.com', hasPhone: true, channels: ['db', 'email'] }],
    });
    renderPanel();
    await screen.findByText('Priya Sharma');
    expect(screen.getByText('priya@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop notifying Priya Sharma via Dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop notifying Priya Sharma via Email/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Notify Priya Sharma via WhatsApp/i })).toBeInTheDocument();
  });

  it('adding a person from the staff search creates a row defaulted to Dashboard', async () => {
    mockLoad({ recipients: [] });
    renderPanel();
    await screen.findByText(/No one is configured yet/i);

    fireEvent.click(screen.getByRole('button', { name: /Add person/i }));
    const search = await screen.findByLabelText(/Search staff to add/i);
    fireEvent.change(search, { target: { value: 'Priya' } });
    fireEvent.click(await screen.findByRole('button', { name: /Priya Sharma/i }));

    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop notifying Priya Sharma via Dashboard/i })).toBeInTheDocument();
    // Not yet saved — email/whatsapp default off.
    expect(screen.getByRole('button', { name: /Notify Priya Sharma via Email/i })).toBeInTheDocument();
  });

  it('already-added people are excluded from the add-person search results', async () => {
    mockLoad({
      recipients: [{ userId: 7, name: 'Priya Sharma', email: 'priya@example.com', hasPhone: false, channels: ['db'] }],
    });
    renderPanel();
    await screen.findByText('Priya Sharma');
    fireEvent.click(screen.getByRole('button', { name: /Add person/i }));
    await screen.findByLabelText(/Search staff to add/i);
    expect(screen.queryByRole('button', { name: /^Priya Sharma/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Raj Verma/i })).toBeInTheDocument();
  });

  it('toggling a channel chip flips it, and removing a recipient drops the row', async () => {
    mockLoad({
      recipients: [{ userId: 7, name: 'Priya Sharma', email: 'priya@example.com', hasPhone: false, channels: ['db'] }],
    });
    renderPanel();
    await screen.findByText('Priya Sharma');

    fireEvent.click(screen.getByRole('button', { name: /Notify Priya Sharma via Email/i }));
    expect(screen.getByRole('button', { name: /Stop notifying Priya Sharma via Email/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Remove Priya Sharma/i }));
    expect(screen.queryByText('Priya Sharma')).not.toBeInTheDocument();
  });
});

describe('DiagnosticNotificationPanel — save', () => {
  it('Save is disabled until the list actually changes, then PUTs the new recipient list', async () => {
    mockLoad({ recipients: [] });
    renderPanel();
    await screen.findByText(/No one is configured yet/i);

    const saveBtn = screen.getByRole('button', { name: /^Save$/i });
    expect(saveBtn.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Add person/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Priya Sharma/i }));
    expect(saveBtn.disabled).toBe(false);

    fetchApiMock.mockImplementation((url, opts) => {
      if (opts?.method === 'PUT') {
        return Promise.resolve({ recipients: JSON.parse(opts.body).recipients });
      }
      if (String(url).includes('/notification-settings')) return Promise.resolve({ recipients: [], channelAvailability: { db: true, email: true, whatsapp: false } });
      if (String(url).includes('/api/staff')) return Promise.resolve(STAFF);
      return Promise.resolve({});
    });

    fireEvent.click(saveBtn);
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(([, o]) => o?.method === 'PUT');
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body).toEqual({ subBrand: 'tmc', recipients: [{ userId: 7, channels: ['db'] }] });
    });
    await waitFor(() => expect(notifyObj.success).toHaveBeenCalled());
  });

  it('isAdmin=false disables Save + test, and shows the read-only notice', async () => {
    mockLoad({ recipients: [] });
    renderPanel({ isAdmin: false });
    await screen.findByText(/No one is configured yet/i);
    expect(screen.getByText(/Read-only\. Admin access is required to save\./i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Send test notification/i }).disabled).toBe(true);
  });
});

describe('DiagnosticNotificationPanel — test notification', () => {
  it('sends a test ping and renders the per-channel result', async () => {
    mockLoad({ recipients: [] });
    renderPanel();
    await screen.findByText(/No one is configured yet/i);

    fetchApiMock.mockImplementation((url, opts) => {
      if (opts?.method === 'POST' && String(url).includes('/test')) {
        return Promise.resolve({ db: 'sent', email: 'sent', whatsapp: 'unavailable' });
      }
      if (String(url).includes('/notification-settings')) return Promise.resolve({ recipients: [], channelAvailability: { db: true, email: true, whatsapp: false } });
      if (String(url).includes('/api/staff')) return Promise.resolve(STAFF);
      return Promise.resolve({});
    });

    fireEvent.click(screen.getByRole('button', { name: /Send test notification/i }));

    expect(await screen.findByText(/Test notification result/i)).toBeInTheDocument();
    expect(screen.getByText(/Dashboard: sent/i)).toBeInTheDocument();
    expect(screen.getByText(/Email: sent/i)).toBeInTheDocument();
    expect(screen.getByText(/WhatsApp: unavailable/i)).toBeInTheDocument();
  });
});
