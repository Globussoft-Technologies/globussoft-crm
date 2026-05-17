/**
 * BlockedNumbers.jsx — admin page for managing WhatsApp opt-outs.
 *
 * Closes Zylu-Gap #800 (WA-005).
 *
 * What this test pins
 * ───────────────────
 *   1. List render — GET /api/whatsapp/opt-outs returns rows; each row
 *      renders phone + reason + captured-at + Unblock button (for admins).
 *   2. Add modal — clicking "Add blocked number" opens a modal; submitting
 *      with phone + reason POSTs /opt-outs.
 *   3. Unblock modal — clicking "Unblock" opens a modal requiring a
 *      ≥10-char reason (DPDP §11); submitting DELETEs /opt-outs/:id with
 *      the reason in the body.
 *   4. Non-admin users see "Admin-only" copy instead of the Unblock button.
 *
 * Backend contracts pinned by this test
 * ─────────────────────────────────────
 *   - GET    /api/whatsapp/opt-outs?limit=100     (returns { optOuts, pagination })
 *   - POST   /api/whatsapp/opt-outs               ({ contactPhone, reason, notes? })
 *   - DELETE /api/whatsapp/opt-outs/:id           ({ reason — min 10 chars })
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable mock object per CLAUDE.md RTL standing rule.
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => children,
}));

// AuthContext lives on App.jsx — re-mock it so the page reads a known role
// without importing the real router-bound App. The page reads
// `user.role === 'ADMIN'` to decide whether to show the Unblock button.
vi.mock('../App', () => ({
  AuthContext: React.createContext({ user: { id: 1, role: 'ADMIN' } }),
}));

import BlockedNumbers from '../pages/wellness/BlockedNumbers';

const sampleOptOuts = [
  {
    id: 501,
    contactPhone: '+919999988888',
    reason: 'STOP_KEYWORD',
    capturedAt: new Date(Date.now() - 86_400_000).toISOString(),
    notes: 'Replied STOP via keyword',
  },
  {
    id: 502,
    contactPhone: '+919999977777',
    reason: 'USER_REQUESTED',
    capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
    notes: null,
  },
];

function defaultFetch(url, opts) {
  if (!opts || !opts.method || opts.method === 'GET') {
    if (url.startsWith('/api/whatsapp/opt-outs')) {
      return Promise.resolve({ optOuts: sampleOptOuts });
    }
  }
  if (opts?.method === 'POST') {
    return Promise.resolve({ id: 999, contactPhone: '+919876543210', reason: 'USER_REQUESTED' });
  }
  if (opts?.method === 'DELETE') {
    return Promise.resolve({ success: true });
  }
  return Promise.resolve({});
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.info.mockReset();
  notifyObj.success.mockReset();
  fetchApiMock.mockImplementation(defaultFetch);
});

describe('<BlockedNumbers /> — list rendering', () => {
  it('fetches /api/whatsapp/opt-outs on mount and renders one row per opt-out', async () => {
    render(<BlockedNumbers />);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.startsWith('/api/whatsapp/opt-outs')
      );
      expect(call).toBeTruthy();
      expect(call[0]).toContain('limit=100');
    });

    expect(await screen.findByTestId('blocked-row-501')).toBeInTheDocument();
    expect(screen.getByTestId('blocked-row-502')).toBeInTheDocument();
    expect(screen.getByText('+919999988888')).toBeInTheDocument();
    expect(screen.getByText('+919999977777')).toBeInTheDocument();
  });

  it('renders an empty-state when no opt-outs exist', async () => {
    fetchApiMock.mockImplementation(() => Promise.resolve({ optOuts: [] }));
    render(<BlockedNumbers />);

    expect(await screen.findByText(/No blocked numbers/i)).toBeInTheDocument();
  });
});

describe('<BlockedNumbers /> — Add modal', () => {
  it('clicking "Add blocked number" opens the modal', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    await user.click(screen.getByTestId('blocked-add-button'));

    expect(await screen.findByTestId('blocked-add-modal')).toBeInTheDocument();
    expect(screen.getByTestId('blocked-add-phone')).toBeInTheDocument();
    expect(screen.getByTestId('blocked-add-reason')).toBeInTheDocument();
  });

  it('submitting the form POSTs /api/whatsapp/opt-outs with contactPhone + reason', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    await user.click(screen.getByTestId('blocked-add-button'));
    await user.type(screen.getByTestId('blocked-add-phone'), '+919876543210');
    await user.selectOptions(screen.getByTestId('blocked-add-reason'), 'COMPLAINT');
    await user.click(screen.getByTestId('blocked-add-submit'));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/whatsapp/opt-outs' && opts?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.contactPhone).toBe('+919876543210');
      expect(body.reason).toBe('COMPLAINT');
    });
  });
});

describe('<BlockedNumbers /> — Unblock modal (DPDP §11 reason capture)', () => {
  it('clicking Unblock opens a modal asking for a reason', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    await user.click(screen.getByTestId('blocked-unblock-501'));

    expect(await screen.findByTestId('blocked-unblock-modal')).toBeInTheDocument();
    expect(screen.getByTestId('blocked-unblock-reason')).toBeInTheDocument();
  });

  it('disables the Confirm button until the reason is ≥10 chars', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    await user.click(screen.getByTestId('blocked-unblock-501'));
    const submitBtn = await screen.findByTestId('blocked-unblock-submit');
    expect(submitBtn).toBeDisabled();

    // 9 chars — still disabled
    await user.type(screen.getByTestId('blocked-unblock-reason'), 'too short');
    expect(submitBtn).toBeDisabled();

    // 10+ chars — enabled
    await user.type(screen.getByTestId('blocked-unblock-reason'), ' enough now');
    expect(submitBtn).not.toBeDisabled();
  });

  it('submitting DELETEs /api/whatsapp/opt-outs/:id with the reason in the body', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    await user.click(screen.getByTestId('blocked-unblock-501'));
    await user.type(
      screen.getByTestId('blocked-unblock-reason'),
      'Customer called back and requested re-opt-in on 2026-05-17'
    );
    await user.click(screen.getByTestId('blocked-unblock-submit'));

    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/whatsapp/opt-outs/501' && opts?.method === 'DELETE'
      );
      expect(delCall).toBeTruthy();
      const body = JSON.parse(delCall[1].body);
      expect(body.reason).toMatch(/Customer called back/);
      expect(body.reason.length).toBeGreaterThanOrEqual(10);
    });
  });
});

describe('<BlockedNumbers /> — non-admin RBAC', () => {
  it('hides the Unblock button for non-admin users', async () => {
    // Re-mock AuthContext to return a MANAGER (not ADMIN).
    vi.resetModules();
    vi.doMock('../App', () => ({
      AuthContext: React.createContext({ user: { id: 1, role: 'MANAGER' } }),
    }));
    vi.doMock('../utils/api', () => ({
      fetchApi: (...args) => fetchApiMock(...args),
    }));
    vi.doMock('../utils/notify', () => ({
      useNotify: () => notifyObj,
      NotifyProvider: ({ children }) => children,
    }));
    const { default: BlockedNumbersIsolated } = await import('../pages/wellness/BlockedNumbers');

    render(<BlockedNumbersIsolated />);
    await screen.findByTestId('blocked-row-501');

    expect(screen.queryByTestId('blocked-unblock-501')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Admin-only/i).length).toBeGreaterThan(0);
  });
});
