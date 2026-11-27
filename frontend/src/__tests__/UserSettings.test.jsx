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
import NotificationEmailCcSettings from '../components/NotificationEmailCcSettings';
import { AuthContext } from '../App';

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

// Page-catalog paths covering every notification category — by default the
// suite acts as if the signed-in user has every relevant sidebar surface, so
// the "all categories visible" contract holds without each test having to
// set up the catalog mock by hand. New categories added to UserSettings'
// categoryOptions need a representative path here.
const ALL_CATEGORY_PATHS = [
  { path: '/pipeline' },
  { path: '/tasks' },
  { path: '/tickets' },
  { path: '/leads' },
  { path: '/approvals' },
  { path: '/wellness/leave' },
  { path: '/expenses' },
  { path: '/wellness/book-appointment' },
  { path: '/wellness/my-prescriptions' },
  { path: '/wellness/visits' },
  { path: '/wellness/memberships' },
  { path: '/wellness/my-transactions' },
  { path: '/wellness/invoices' },
  { path: '/wellness/waitlist' },
  { path: '/wellness/inventory' },
];

function setSuccessfulLoad(prefs = SAMPLE_PREFS, pages = ALL_CATEGORY_PATHS) {
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/notifications/preferences') {
      return Promise.resolve(prefs);
    }
    if (url === '/api/pages/me') {
      return Promise.resolve({ pages });
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

  it('opens email notification settings from the gear without toggling email delivery', async () => {
    setSuccessfulLoad();
    const user = userEvent.setup();
    render(
      <AuthContext.Provider value={{ user: { role: 'ADMIN' }, tenant: { vertical: 'generic' } }}>
        <UserSettings />
      </AuthContext.Provider>,
    );

    const emailToggle = await screen.findByRole('checkbox', { name: 'Email', exact: true });
    expect(emailToggle).toBeChecked();
    expect(screen.queryByRole('heading', { name: 'Email notification settings' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Open email notification settings' }));
    expect(await screen.findByRole('heading', { name: 'Email notification settings' })).toBeInTheDocument();
    expect(emailToggle).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Close email notification settings' }));
    expect(screen.queryByRole('heading', { name: 'Email notification settings' })).toBeNull();
  });

  describe('NotificationEmailCcSettings', () => {
    it('lets admins select tenant staff and add alternate addresses as CC recipients', async () => {
      fetchApiMock.mockImplementation((url, options) => {
        if (url === '/api/notifications/email-cc-recipients' && !options) {
          return Promise.resolve({
            staff: [
              { id: 14, name: 'Jordan Staff', email: 'jordan@example.com' },
              { id: 15, name: 'Morgan Team', email: 'morgan@example.com' },
            ],
            recipients: { staffUserIds: [], externalEmails: [] },
            receiverEmail: 'admin@example.com',
            defaultReceiverEmail: 'admin@example.com',
          });
        }
        if (url === '/api/notifications/email-cc-recipients' && options?.method === 'PUT') {
          return Promise.resolve({
            recipients: { staffUserIds: [14], externalEmails: ['copy@example.com'] },
            receiverEmail: 'alerts@example.com',
            defaultReceiverEmail: 'admin@example.com',
          });
        }
        return Promise.resolve({});
      });
      const user = userEvent.setup();
      render(<NotificationEmailCcSettings isAdmin />);

      const addPerson = await screen.findByRole('button', { name: 'Add person' });
      expect(screen.queryByRole('textbox', { name: 'Search staff by name or email' })).toBeNull();
      await user.click(addPerson);
      const search = await screen.findByRole('textbox', { name: 'Search staff by name or email' });
      await user.type(search, 'jordan@');
      expect(await screen.findByRole('checkbox', {
        name: 'Jordan Staff (jordan@example.com)',
      })).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Morgan Team (morgan@example.com)' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Close staff picker' }));
      await user.click(screen.getByRole('button', { name: 'Add person' }));
      const searchByName = await screen.findByRole('textbox', { name: 'Search staff by name or email' });
      await user.type(searchByName, 'Jordan Staff');
      expect(screen.getByRole('checkbox', { name: 'Jordan Staff (jordan@example.com)' })).toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: 'Jordan Staff (jordan@example.com)' }));
      await user.click(screen.getByRole('button', { name: 'Close staff picker' }));
      expect(screen.getByText('Jordan Staff')).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Search staff by name or email' })).toBeNull();
      const emailInput = screen.getByLabelText('Add an email address');
      await user.type(emailInput, 'copy@example.com');
      await user.click(screen.getByRole('button', { name: 'Add', exact: true }));
      expect(screen.getByText('copy@example.com')).toBeInTheDocument();
      expect(screen.queryByText(/No CC recipients added yet/)).toBeNull();
      expect(screen.getByLabelText('Default notification receiver email')).toHaveValue('admin@example.com');
      await user.click(screen.getByRole('button', { name: 'Use account email' }));
      expect(screen.getByLabelText('Default notification receiver email')).toHaveValue('admin@example.com');
      await user.clear(screen.getByLabelText('Default notification receiver email'));
      await user.type(screen.getByLabelText('Default notification receiver email'), 'alerts@example.com');
      await user.click(screen.getByRole('button', { name: 'Save email settings' }));

      await waitFor(() => {
        expect(fetchApiMock).toHaveBeenCalledWith('/api/notifications/email-cc-recipients', {
          method: 'PUT',
          body: JSON.stringify({
            staffUserIds: [14],
            externalEmails: ['copy@example.com'],
            receiverEmail: 'alerts@example.com',
          }),
        });
      });
      expect(notifySuccess).toHaveBeenCalledWith('Email settings saved');
    });

    it('cancels unsaved recipient and receiver changes', async () => {
      fetchApiMock.mockResolvedValue({
        staff: [],
        recipients: { staffUserIds: [], externalEmails: ['saved@example.com'] },
        receiverEmail: 'admin@example.com',
        defaultReceiverEmail: 'admin@example.com',
      });
      const user = userEvent.setup();
      render(<NotificationEmailCcSettings isAdmin />);

      const emailInput = await screen.findByLabelText('Add an email address');
      await user.type(emailInput, 'draft@example.com');
      await user.click(screen.getByRole('button', { name: 'Add', exact: true }));
      await user.clear(screen.getByLabelText('Default notification receiver email'));
      await user.type(screen.getByLabelText('Default notification receiver email'), 'changed@example.com');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.getByText('saved@example.com')).toBeInTheDocument();
      expect(screen.queryByText('draft@example.com')).toBeNull();
      expect(screen.getByLabelText('Default notification receiver email')).toHaveValue('admin@example.com');
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the default receiver unchanged when an additional CC email is added', async () => {
      fetchApiMock.mockImplementation((url, options) => {
        if (url === '/api/notifications/email-cc-recipients' && !options) {
          return Promise.resolve({
            staff: [],
            recipients: { staffUserIds: [], externalEmails: [] },
            receiverEmail: 'admin@example.com',
            defaultReceiverEmail: 'admin@example.com',
          });
        }
        if (url === '/api/notifications/email-cc-recipients' && options?.method === 'PUT') {
          return Promise.resolve({
            recipients: { staffUserIds: [], externalEmails: ['copy@example.com'] },
            receiverEmail: 'admin@example.com',
            defaultReceiverEmail: 'admin@example.com',
          });
        }
        return Promise.resolve({});
      });
      const user = userEvent.setup();
      render(<NotificationEmailCcSettings isAdmin />);

      await user.type(await screen.findByLabelText('Add an email address'), 'copy@example.com');
      await user.click(screen.getByRole('button', { name: 'Add', exact: true }));
      expect(screen.getByLabelText('Default notification receiver email')).toHaveValue('admin@example.com');
      await user.click(screen.getByRole('button', { name: 'Save email settings' }));

      await waitFor(() => {
        expect(fetchApiMock).toHaveBeenCalledWith('/api/notifications/email-cc-recipients', {
          method: 'PUT',
          body: JSON.stringify({
            staffUserIds: [],
            externalEmails: ['copy@example.com'],
            receiverEmail: 'admin@example.com',
          }),
        });
      });
    });

    it('does not render recipient management for non-admins', () => {
      const { container } = render(<NotificationEmailCcSettings isAdmin={false} />);
      expect(container).toBeEmptyDOMElement();
      expect(fetchApiMock).not.toHaveBeenCalled();
    });
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

  it('renders every notification category when the user has all mapped paths', async () => {
    setSuccessfulLoad();
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Notification Settings/i)).toBeInTheDocument();
    });
    // Spot-check the generic CRM workflow categories.
    expect(screen.getByText('Deals & Opportunities')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Support Tickets')).toBeInTheDocument();
    expect(screen.getByText('Leads')).toBeInTheDocument();
    expect(screen.getByText('Approvals')).toBeInTheDocument();
    expect(screen.getByText('Leave Requests')).toBeInTheDocument();
    expect(screen.getByText('Expense Reports')).toBeInTheDocument();
    // And the wellness vertical categories.
    expect(screen.getByText('Appointments & Bookings')).toBeInTheDocument();
    expect(screen.getByText('Prescriptions')).toBeInTheDocument();
    expect(screen.getByText('Visits')).toBeInTheDocument();
    expect(screen.getByText('Memberships')).toBeInTheDocument();
    expect(screen.getByText('Payments & Transactions')).toBeInTheDocument();
  });

  it('shows wellness-relevant categories for a wellness customer-tier sidebar', async () => {
    // Mirrors the screenshot: a wellness customer-tier user whose sidebar
    // surfaces prescriptions / visits / memberships / transactions / bookings
    // but none of the generic CRM workflow surfaces. The category list should
    // show the wellness categories AND hide every generic-only category.
    setSuccessfulLoad(SAMPLE_PREFS, [
      { path: '/wellness/my-prescriptions' },
      { path: '/wellness/visits' },
      { path: '/wellness/memberships' },
      { path: '/wellness/my-transactions' },
      { path: '/wellness/book-appointment' },
      { path: '/wellness/my-bookings' },
      { path: '/notification-settings' },
    ]);
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByText('Prescriptions')).toBeInTheDocument();
    });
    expect(screen.getByText('Visits')).toBeInTheDocument();
    expect(screen.getByText('Memberships')).toBeInTheDocument();
    expect(screen.getByText('Payments & Transactions')).toBeInTheDocument();
    expect(screen.getByText('Appointments & Bookings')).toBeInTheDocument();
    // Generic CRM categories — hidden because their paths aren't in the catalog.
    expect(screen.queryByText('Deals & Opportunities')).toBeNull();
    expect(screen.queryByText('Tasks')).toBeNull();
    expect(screen.queryByText('Support Tickets')).toBeNull();
    expect(screen.queryByText('Leads')).toBeNull();
    expect(screen.queryByText('Approvals')).toBeNull();
    expect(screen.queryByText('Leave Requests')).toBeNull();
    expect(screen.queryByText('Expense Reports')).toBeNull();
  });

  it('shows Payments & Transactions when /wellness/invoices is accessible', async () => {
    setSuccessfulLoad(SAMPLE_PREFS, [
      { path: '/wellness/invoices' },
      { path: '/notification-settings' },
    ]);
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByText('Payments & Transactions')).toBeInTheDocument();
    });
    expect(screen.queryByText('Appointments & Bookings')).toBeNull();
    expect(screen.queryByText('Visits')).toBeNull();
  });

  it('hides the entire Categories section when no sidebar paths match', async () => {
    // Pathological case: the user can access pages but none map to any
    // notification category (e.g. only /notification-settings + /home).
    // The "Notification Categories" sub-block hides; the rest of the
    // settings surface (delivery channels + quiet hours) stays usable.
    setSuccessfulLoad(SAMPLE_PREFS, [
      { path: '/home' },
      { path: '/notification-settings' },
    ]);
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Delivery Channels/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Notification Categories/i)).toBeNull();
    expect(screen.queryByText('Deals & Opportunities')).toBeNull();
    expect(screen.queryByText('Prescriptions')).toBeNull();
    expect(screen.queryByText('Appointments & Bookings')).toBeNull();
  });

  it('shows only the subset of categories whose paths the user can access', async () => {
    // Wellness manager with leave + expense + approvals workflows but no
    // sales / support / patient-facing surfaces — only the matching subset
    // renders; everything else is hidden.
    setSuccessfulLoad(SAMPLE_PREFS, [
      { path: '/wellness/leave' },
      { path: '/expenses' },
      { path: '/approvals' },
    ]);
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByText('Leave Requests')).toBeInTheDocument();
    });
    expect(screen.getByText('Expense Reports')).toBeInTheDocument();
    expect(screen.getByText('Approvals')).toBeInTheDocument();
    expect(screen.queryByText('Deals & Opportunities')).toBeNull();
    expect(screen.queryByText('Tasks')).toBeNull();
    expect(screen.queryByText('Support Tickets')).toBeNull();
    expect(screen.queryByText('Leads')).toBeNull();
    expect(screen.queryByText('Prescriptions')).toBeNull();
  });

  it('falls back to all categories when /api/pages/me fails', async () => {
    // Catalog fetch rejects — accessiblePaths stays null and the surface
    // degrades to showing every category. Losing the notification settings
    // entirely on a fetch hiccup would be worse than over-displaying.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/notifications/preferences') {
        return Promise.resolve(SAMPLE_PREFS);
      }
      if (url === '/api/pages/me') {
        return Promise.reject(new Error('500'));
      }
      return Promise.resolve({});
    });
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByText('Deals & Opportunities')).toBeInTheDocument();
    });
    // Generic + wellness categories all show on the fallback path.
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Leads')).toBeInTheDocument();
    expect(screen.getByText('Appointments & Bookings')).toBeInTheDocument();
    expect(screen.getByText('Prescriptions')).toBeInTheDocument();
    expect(screen.getByText('Payments & Transactions')).toBeInTheDocument();
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

  it('saves a delivery channel immediately when toggled', async () => {
    const user = userEvent.setup();
    setSuccessfulLoad();
    render(<UserSettings />);
    await waitFor(() => {
      expect(screen.getByText('Browser Push')).toBeInTheDocument();
    });
    // "Browser Push" starts at false in SAMPLE_PREFS.
    const pushCheckbox = screen.getByText('Browser Push').closest('label').querySelector('input[type="checkbox"]');
    const leadsCheckbox = screen.getByText('Leads').closest('label').querySelector('input[type="checkbox"]');
    expect(pushCheckbox.checked).toBe(false);
    await user.click(leadsCheckbox);
    expect(leadsCheckbox.checked).toBe(true);
    await user.click(pushCheckbox);
    expect(pushCheckbox.checked).toBe(true);

    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(([url, options]) =>
        url === '/api/notifications/preferences' && options?.method === 'PUT'
      );
      expect(put).toBeDefined();
      const body = JSON.parse(put[1].body);
      expect(body.channels.push).toBe(true);
      // Category edits remain drafts for the explicit Save Preferences action.
      expect(body.categoryToggles.lead).toBe(false);
    });
    expect(screen.getByText(/Changes save automatically/i)).toBeInTheDocument();
  });

  it('restores a delivery channel when its automatic save fails', async () => {
    fetchApiMock.mockImplementation((url, options) => {
      if (url === '/api/notifications/preferences' && options?.method === 'PUT') {
        return Promise.reject(new Error('500'));
      }
      if (url === '/api/notifications/preferences') return Promise.resolve(SAMPLE_PREFS);
      if (url === '/api/pages/me') return Promise.resolve({ pages: ALL_CATEGORY_PATHS });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<UserSettings />);

    const pushCheckbox = await screen.findByRole('checkbox', { name: 'Browser Push' });
    expect(pushCheckbox).not.toBeChecked();
    await user.click(pushCheckbox);

    await waitFor(() => expect(pushCheckbox).not.toBeChecked());
    expect(notifyError).toHaveBeenCalledWith('Failed to update delivery channel');
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
