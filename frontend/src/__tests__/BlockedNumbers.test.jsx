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

// ─────────────────────────────────────────────────────────────────────────
// Extended coverage — pin the remaining surface paths of the page.
// Added cases cover:
//   • Loading state (renders "Loading…" before the fetch resolves)
//   • Error state (notify.error fired on fetch reject)
//   • Refresh button (a second GET fires with limit=100)
//   • Search submit (phone query param added to the GET URL)
//   • Phone validation in Add modal (no POST + error notify on garbage)
//   • POST shape includes optional notes when provided
//   • POST shape OMITS notes when blank (undefined, not empty string)
//   • Successful POST closes the modal and re-fetches the list
//   • Add modal Cancel resets state and closes the modal
//   • Unblock modal Cancel closes without firing DELETE
//   • Row badge renders the reason code (STOP_KEYWORD)
//   • Each row renders a Notes column ('—' when null)
//   • Admin sees the Unblock button (counterpart to the MANAGER RBAC case)
// ─────────────────────────────────────────────────────────────────────────

describe('<BlockedNumbers /> — extended list + state coverage', () => {
  it('renders Loading… while the initial fetch is pending', async () => {
    let resolveFetch;
    fetchApiMock.mockImplementation(
      () => new Promise((res) => { resolveFetch = res; })
    );
    render(<BlockedNumbers />);

    // Initial render shows the loading placeholder, no rows yet.
    expect(screen.getByText(/Loading…/i)).toBeInTheDocument();
    expect(screen.queryByTestId('blocked-row-501')).not.toBeInTheDocument();

    // Resolve so cleanup can finish.
    resolveFetch({ optOuts: [] });
    await waitFor(() => {
      expect(screen.queryByText(/Loading…/i)).not.toBeInTheDocument();
    });
  });

  it('notify.error fires when the list fetch rejects', async () => {
    fetchApiMock.mockImplementation(() =>
      Promise.reject(new Error('Network down')),
    );
    render(<BlockedNumbers />);

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
      const msg = notifyObj.error.mock.calls[0][0];
      expect(msg).toMatch(/Network down|Failed to load/);
    });
    // Empty-state still renders after the error path resets rows to [].
    expect(await screen.findByText(/No blocked numbers/i)).toBeInTheDocument();
  });

  it('renders the reason badge text + notes column per row', async () => {
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    // Row 501 has notes "Replied STOP via keyword" + reason STOP_KEYWORD.
    expect(screen.getByText('STOP_KEYWORD')).toBeInTheDocument();
    expect(screen.getByText(/Replied STOP via keyword/i)).toBeInTheDocument();

    // Row 502 has notes = null → renders as '—'.
    // The em-dash also appears in formatDate fallback paths — use getAllByText.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);

    // USER_REQUESTED reason badge renders for row 502.
    expect(screen.getByText('USER_REQUESTED')).toBeInTheDocument();
  });

  it('shows the Unblock button on every row when the user is ADMIN', async () => {
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    expect(screen.getByTestId('blocked-unblock-501')).toBeInTheDocument();
    expect(screen.getByTestId('blocked-unblock-502')).toBeInTheDocument();
  });
});

describe('<BlockedNumbers /> — refresh + search', () => {
  it('Refresh button fires a second GET to /api/whatsapp/opt-outs', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    const beforeCalls = fetchApiMock.mock.calls.length;
    // The Refresh button has the title attribute "Refresh".
    await user.click(screen.getByTitle('Refresh'));

    await waitFor(() => {
      expect(fetchApiMock.mock.calls.length).toBeGreaterThan(beforeCalls);
    });
    const refreshCall = fetchApiMock.mock.calls[fetchApiMock.mock.calls.length - 1];
    expect(refreshCall[0]).toContain('/api/whatsapp/opt-outs');
    expect(refreshCall[0]).toContain('limit=100');
  });

  it('Search submit adds the phone query param to the GET URL', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    const searchInput = screen.getByLabelText(/Search blocked numbers/i);
    await user.type(searchInput, '+9199');
    await user.click(screen.getByRole('button', { name: /^Go$/ }));

    await waitFor(() => {
      const searchCall = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('phone='),
      );
      expect(searchCall).toBeTruthy();
      // URLSearchParams encodes "+" as "%2B".
      expect(searchCall[0]).toMatch(/phone=(%2B|\+)9199/);
    });
  });
});

describe('<BlockedNumbers /> — Add modal: validation + payload', () => {
  it('rejects an obviously-invalid phone without firing POST', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    await user.click(screen.getByTestId('blocked-add-button'));
    // 5 chars max via the page's /^[+\d\s()-]{6,}$/ regex — supply 4 letters.
    await user.type(screen.getByTestId('blocked-add-phone'), 'abcd');
    await user.click(screen.getByTestId('blocked-add-submit'));

    // No POST should have fired.
    const postCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/whatsapp/opt-outs' && opts?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
    // notify.error fires with the E.164 message.
    expect(notifyObj.error).toHaveBeenCalled();
    const lastCall = notifyObj.error.mock.calls[notifyObj.error.mock.calls.length - 1][0];
    expect(lastCall).toMatch(/E\.164|valid/);
  });

  it('POST body INCLUDES notes when the operator types them', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    await user.click(screen.getByTestId('blocked-add-button'));
    await user.type(screen.getByTestId('blocked-add-phone'), '+918888877777');
    await user.selectOptions(screen.getByTestId('blocked-add-reason'), 'UNSUBSCRIBE_LINK');

    // The notes textarea is unlabeled by testid — find it via its visible label.
    const notesField = screen
      .getByText(/Notes \(optional\)/i)
      .closest('label')
      .querySelector('textarea');
    await user.type(notesField, 'Clicked unsubscribe link in 2026-05-21 newsletter');

    await user.click(screen.getByTestId('blocked-add-submit'));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/whatsapp/opt-outs' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.contactPhone).toBe('+918888877777');
      expect(body.reason).toBe('UNSUBSCRIBE_LINK');
      expect(body.notes).toMatch(/Clicked unsubscribe/);
    });
  });

  it('POST body OMITS notes (undefined, stripped by JSON.stringify) when blank', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    await user.click(screen.getByTestId('blocked-add-button'));
    await user.type(screen.getByTestId('blocked-add-phone'), '+917777766666');
    await user.click(screen.getByTestId('blocked-add-submit'));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/whatsapp/opt-outs' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      // The SUT passes `notes: addNotes.trim() || undefined` — JSON.stringify
      // drops undefined keys entirely.
      expect('notes' in body).toBe(false);
    });
  });

  it('closes the modal and re-fetches the list after a successful POST', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    await user.click(screen.getByTestId('blocked-add-button'));
    expect(screen.getByTestId('blocked-add-modal')).toBeInTheDocument();

    await user.type(screen.getByTestId('blocked-add-phone'), '+916666655555');
    const beforeGets = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        typeof url === 'string' &&
        url.startsWith('/api/whatsapp/opt-outs') &&
        (!opts || !opts.method || opts.method === 'GET'),
    ).length;

    await user.click(screen.getByTestId('blocked-add-submit'));

    // Modal disappears.
    await waitFor(() => {
      expect(screen.queryByTestId('blocked-add-modal')).not.toBeInTheDocument();
    });
    // A second GET is issued to refresh the list.
    await waitFor(() => {
      const afterGets = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          typeof url === 'string' &&
          url.startsWith('/api/whatsapp/opt-outs') &&
          (!opts || !opts.method || opts.method === 'GET'),
      ).length;
      expect(afterGets).toBeGreaterThan(beforeGets);
    });
  });

  it('Add modal Cancel button closes the modal without firing POST', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    await user.click(screen.getByTestId('blocked-add-button'));
    await user.type(screen.getByTestId('blocked-add-phone'), '+915555544444');

    // Locate the modal-footer Cancel button (there's only one "Cancel" on screen
    // while the add modal is open).
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));

    expect(screen.queryByTestId('blocked-add-modal')).not.toBeInTheDocument();
    const postCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/whatsapp/opt-outs' && opts?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });
});

describe('<BlockedNumbers /> — Unblock modal: cancel path', () => {
  it('Cancel closes the Unblock modal without firing DELETE', async () => {
    const user = userEvent.setup();
    render(<BlockedNumbers />);
    await screen.findByTestId('blocked-row-501');

    await user.click(screen.getByTestId('blocked-unblock-501'));
    expect(await screen.findByTestId('blocked-unblock-modal')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));

    expect(screen.queryByTestId('blocked-unblock-modal')).not.toBeInTheDocument();
    const delCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        typeof url === 'string' &&
        url.startsWith('/api/whatsapp/opt-outs/') &&
        opts?.method === 'DELETE',
    );
    expect(delCalls.length).toBe(0);
  });
});
