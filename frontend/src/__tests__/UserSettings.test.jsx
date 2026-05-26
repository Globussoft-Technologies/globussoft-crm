/**
 * UserSettings.test.jsx — vitest + RTL coverage for the per-user Notification
 * Settings page (frontend/src/pages/UserSettings.jsx, 217 LOC).
 *
 * What this SUT actually is: despite the generic "UserSettings" filename, the
 * page is dedicated to NOTIFICATION preferences for the signed-in user. It
 * does NOT cover profile fields (name/email) or password changes — those live
 * on Profile.jsx + Profile2FA.jsx. The test contract here matches the SUT's
 * actual surface (notification categories + delivery channels + quiet hours),
 * not the misleading filename.
 *
 * Scope: pins the page-surface invariants:
 *   1. Loading state — "Loading preferences…" renders before the first fetch.
 *   2. Initial fetch — mounts hit GET /api/notifications/preferences exactly
 *      once.
 *   3. Load failure — when the fetch rejects, notify.error fires and the
 *      page degrades to null (no crash from the defensive guard at L103).
 *   4. Defensive null guard — when the API returns malformed prefs
 *      ({ categoryToggles: undefined }), the page returns null instead of
 *      crashing on the categoryOptions.map.
 *   5. Renders 7 category checkboxes (deal / task / ticket / lead / approval /
 *      leave / expense) with the right labels.
 *   6. Renders 4 channel checkboxes (db / socket / push / email).
 *   7. Renders Quiet Hours block: timezone select + start/end time inputs.
 *   8. Toggle a category checkbox — UI state flips immediately (optimistic).
 *   9. Toggle a channel checkbox — UI state flips immediately (optimistic).
 *  10. Save — PUTs /api/notifications/preferences with the current prefs
 *      body; notify.success on resolve.
 *  11. Save error path — notify.error fires when the PUT rejects; the
 *      Save button re-enables (saving flag clears in finally).
 *  12. Reset confirm-deny — clicking Reset when notify.confirm resolves
 *      false skips the POST entirely.
 *  13. Reset confirm-accept — POSTs /api/notifications/preferences/reset,
 *      triggers a reload, and notify.success fires.
 *
 * Backend contracts pinned by this test:
 *   GET  /api/notifications/preferences            → {categoryToggles, channels, ...}
 *   PUT  /api/notifications/preferences            (saves the current prefs)
 *   POST /api/notifications/preferences/reset      (resets to defaults)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object — re-creating per render would invalidate the
// useCallback identity in the SUT and trigger infinite-render loops in RTL.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn();
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import UserSettings from '../pages/UserSettings';

const SAMPLE_PREFS = {
  categoryToggles: {
    deal: true,
    task: true,
    ticket: true,
    lead: false,
    approval: true,
    leave: true,
    expense: false,
  },
  channels: {
    db: true,
    socket: true,
    push: false,
    email: true,
  },
  timezone: 'Asia/Kolkata',
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
};

function setSuccessfulLoad(prefs = SAMPLE_PREFS) {
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/notifications/preferences') {
      return Promise.resolve(prefs);
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
});

describe('UserSettings (Notification Settings)', () => {
  it('renders a loading state before the first fetch resolves', () => {
    // Never-resolving fetch keeps loading=true.
    fetchApiMock.mockImplementation(() => new Promise(() => {}));
    render(<UserSettings />);
    expect(screen.getByText(/Loading preferences/i)).toBeInTheDocument();
  });

  it('fetches /api/notifications/preferences on mount', async () => {
    setSuccessfulLoad();
    render(<UserSettings />);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/notifications/preferences');
    });
  });

  it('shows notify.error and renders nothing when the initial fetch rejects', async () => {
    fetchApiMock.mockRejectedValueOnce(new Error('boom'));
    const { container } = render(<UserSettings />);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to load notification preferences/i)
      );
    });
    // After load fails, prefs stays null → the L103 defensive guard returns null.
    expect(container.querySelector('h1')).toBeNull();
  });

  it('returns null (no crash) when the API returns malformed prefs without categoryToggles', async () => {
    // Defensive guard at L103: empty/malformed prefs would otherwise crash on
    // the categoryOptions.map's categoryToggles[cat.key] read.
    fetchApiMock.mockResolvedValueOnce({ /* no categoryToggles, no channels */ });
    const { container } = render(<UserSettings />);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
    // The defensive `if (!prefs.categoryToggles || !prefs.channels) return null`
    // means the heading never renders.
    await waitFor(() => {
      expect(container.querySelector('h1')).toBeNull();
    });
  });

  it('renders the 7 notification category checkboxes after load', async () => {
    setSuccessfulLoad();
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Notification Settings/i)).toBeInTheDocument();
    });
    // Spot-check labels from categoryOptions.
    expect(screen.getByText('Deals & Opportunities')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Support Tickets')).toBeInTheDocument();
    expect(screen.getByText('Leads')).toBeInTheDocument();
    expect(screen.getByText('Approvals')).toBeInTheDocument();
    expect(screen.getByText('Leave Requests')).toBeInTheDocument();
    expect(screen.getByText('Expense Reports')).toBeInTheDocument();
  });

  it('renders the 4 delivery channel checkboxes after load', async () => {
    setSuccessfulLoad();
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByText('In-App Bell')).toBeInTheDocument();
    });
    expect(screen.getByText('Real-Time Updates')).toBeInTheDocument();
    expect(screen.getByText('Browser Push')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('renders the Quiet Hours block with timezone, start, and end inputs', async () => {
    setSuccessfulLoad();
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Quiet Hours/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/^Timezone$/i)).toBeInTheDocument();
    expect(screen.getByText(/Start Time/i)).toBeInTheDocument();
    expect(screen.getByText(/End Time/i)).toBeInTheDocument();
  });

  it('toggles a category checkbox optimistically when clicked', async () => {
    const user = userEvent.setup();
    setSuccessfulLoad();
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByText('Leads')).toBeInTheDocument();
    });
    // "Leads" starts at false in SAMPLE_PREFS.
    const leadsCheckbox = screen.getByText('Leads').closest('label').querySelector('input[type="checkbox"]');
    expect(leadsCheckbox.checked).toBe(false);
    await user.click(leadsCheckbox);
    expect(leadsCheckbox.checked).toBe(true);
  });

  it('toggles a channel checkbox optimistically when clicked', async () => {
    const user = userEvent.setup();
    setSuccessfulLoad();
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByText('Browser Push')).toBeInTheDocument();
    });
    // "Browser Push" starts at false in SAMPLE_PREFS.
    const pushCheckbox = screen.getByText('Browser Push').closest('label').querySelector('input[type="checkbox"]');
    expect(pushCheckbox.checked).toBe(false);
    await user.click(pushCheckbox);
    expect(pushCheckbox.checked).toBe(true);
  });

  it('Save sends PUT /api/notifications/preferences and shows success notify', async () => {
    const user = userEvent.setup();
    setSuccessfulLoad();
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save Preferences/i })).toBeInTheDocument();
    });

    // Subsequent calls to fetchApi go through the load-mock — make the PUT
    // succeed by overriding once.
    fetchApiMock.mockImplementationOnce((url, opts) => {
      expect(url).toBe('/api/notifications/preferences');
      expect(opts.method).toBe('PUT');
      expect(typeof opts.body).toBe('string');
      const parsed = JSON.parse(opts.body);
      expect(parsed.categoryToggles).toBeDefined();
      expect(parsed.channels).toBeDefined();
      return Promise.resolve({ ok: true });
    });

    await user.click(screen.getByRole('button', { name: /Save Preferences/i }));

    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Notification preferences saved/i)
      );
    });
  });

  it('Save failure path fires notify.error and re-enables the button', async () => {
    const user = userEvent.setup();
    setSuccessfulLoad();
    render(<UserSettings />);
    const saveBtn = await screen.findByRole('button', { name: /Save Preferences/i });

    // Next call (the PUT) rejects.
    fetchApiMock.mockImplementationOnce(() => Promise.reject(new Error('500')));

    await user.click(saveBtn);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to save notification preferences/i)
      );
    });
    // Saving flag clears in finally → button is enabled again.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save Preferences/i })).not.toBeDisabled();
    });
  });

  it('Reset is a no-op when notify.confirm resolves false', async () => {
    const user = userEvent.setup();
    setSuccessfulLoad();
    notifyConfirm.mockResolvedValueOnce(false);
    render(<UserSettings />);
    const resetBtn = await screen.findByRole('button', { name: /Reset to Defaults/i });

    const callsBeforeReset = fetchApiMock.mock.calls.length;
    await user.click(resetBtn);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // No POST fired — call count unchanged.
    expect(fetchApiMock.mock.calls.length).toBe(callsBeforeReset);
    expect(notifySuccess).not.toHaveBeenCalled();
  });

  it('Reset confirm-accept POSTs /reset and re-fetches the prefs', async () => {
    const user = userEvent.setup();
    setSuccessfulLoad();
    notifyConfirm.mockResolvedValueOnce(true);
    render(<UserSettings />);
    const resetBtn = await screen.findByRole('button', { name: /Reset to Defaults/i });

    // Next call is the reset POST; then a follow-up reload.
    fetchApiMock.mockImplementationOnce((url, opts) => {
      expect(url).toBe('/api/notifications/preferences/reset');
      expect(opts.method).toBe('POST');
      return Promise.resolve({ ok: true });
    });

    await user.click(resetBtn);

    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Preferences reset to defaults/i)
      );
    });
    // After reset, load() fires again → fetchApi called with the GET URL.
    await waitFor(() => {
      const getCalls = fetchApiMock.mock.calls.filter(
        ([url]) => url === '/api/notifications/preferences'
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
