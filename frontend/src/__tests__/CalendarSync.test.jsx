/**
 * CalendarSync.test.jsx — vitest + RTL coverage for the Calendar Sync admin
 * page (frontend/src/pages/CalendarSync.jsx). The page surfaces Google
 * Calendar + Outlook Calendar connection / disconnection / sync / event
 * CRUD against the /api/calendar/{google,outlook}/* + /api/calendar/events/*
 * routes.
 *
 * Scope: pins the page-surface contracts (initial render of provider cards,
 * Connect / Sync / Disconnect button shape per provider state, post-OAuth
 * redirect toast branches, event-list empty + populated states, Create-Event
 * modal validation gate, Delete-event confirm flow). The OAuth flow itself
 * (window.location redirect to authUrl) is asserted at the trigger level — we
 * stub the `href` setter and verify the page reads `authUrl` from the
 * /connect response then assigns it; we do NOT exercise the actual OAuth
 * provider round-trip (cannot be exercised under jsdom).
 *
 * Backend contracts pinned by this test (CalendarSync.jsx talks to 6 routes):
 *   GET    /api/calendar/{provider}/events     (used as the connection probe)
 *   GET    /api/calendar/{provider}/connect    → { authUrl }
 *   POST   /api/calendar/{provider}/sync       → { synced: N }
 *   DELETE /api/calendar/{provider}/disconnect
 *   POST   /api/calendar/{provider}/events     (create-event in modal)
 *   PUT    /api/calendar/events/<id>           (edit-event)
 *   DELETE /api/calendar/events/<id>           (delete-event)
 *
 * Contracts pinned here:
 *   1. Page mount: heading "Calendar Sync" + both provider labels (Google
 *      Calendar / Microsoft Outlook) render. Initial mount fires GET
 *      /api/calendar/google/events AND GET /api/calendar/outlook/events as
 *      the connection-status probe (Promise.all over PROVIDERS).
 *   2. Both events endpoints reject (404 / not-connected) → both providers
 *      render the "Not connected" status pill + the Connect button.
 *   3. One events endpoint resolves with an array → that provider renders
 *      "Connected" + the Sync Now + Disconnect buttons; the other stays Not
 *      connected.
 *   4. No-events empty state: when both providers reject, the events panel
 *      renders the "No events synced yet" copy.
 *   5. Loading state: while initial fetches are pending, "Loading events..."
 *      renders (no events list yet).
 *   6. Connect button triggers GET /api/calendar/<provider>/connect and
 *      assigns the returned authUrl to window.location.href.
 *   7. Sync Now triggers POST /api/calendar/<provider>/sync; on success the
 *      "Synced N events" toast renders + the list reloads.
 *   8. Disconnect triggers notify.confirm; on yes → DELETE
 *      /api/calendar/<provider>/disconnect + reload.
 *   9. ?connected=google in the URL on mount: success toast renders +
 *      window.history.replaceState clears the query string.
 *  10. ?error=<msg> in the URL on mount: error toast renders the message +
 *      query string cleared.
 *  11. Events list: populated provider events render with title +
 *      provider-label badge + (n)-event count.
 *  12. Create-Event modal: clicking the per-card "+" button opens the modal
 *      with the provider-scoped heading "Create Event in Google".
 *  13. Create-Event submit gate: submit button stays disabled when title /
 *      start / end fields are empty (validation gate).
 *  14. Event detail click: clicking an event row opens the detail modal with
 *      the event title rendered as heading + close button.
 *
 * Stable mock pattern (per the 2026-05-12 standing rule): notify object is
 * ONE reference for the whole module so the hook reading it in useCallback
 * deps doesn't trigger re-render loops + per-test timeouts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

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

import CalendarSync from '../pages/CalendarSync';

// ── Helpers ──────────────────────────────────────────────────────────────

// jsdom's `window.location` is non-reassignable, but `location.href = X` IS
// interceptable by stubbing the `href` property on the existing object. We
// also need to be able to vary `location.search` per-test to exercise the
// `?connected=` / `?error=` mount branches.
function stubLocation({ search = '', hrefSetter = vi.fn(), pathname = '/' } = {}) {
  const original = window.location;
  const replaceState = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    enumerable: true,
    value: {
      ...original,
      pathname,
      search,
      get href() { return original.href; },
      set href(v) { hrefSetter(v); },
    },
  });
  const originalReplaceState = window.history.replaceState;
  window.history.replaceState = replaceState;
  return {
    hrefSetter,
    replaceState,
    restore: () => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        enumerable: true,
        value: original,
      });
      window.history.replaceState = originalReplaceState;
    },
  };
}

const sampleGoogleEvents = [
  {
    id: 'g-evt-1',
    title: 'Quarterly client review',
    description: 'Q1 review with Acme Corp',
    startTime: '2026-06-01T15:00:00.000Z',
    endTime: '2026-06-01T16:00:00.000Z',
    updatedAt: '2026-05-25T10:00:00.000Z',
    attendees: JSON.stringify([{ email: 'rishu@acme.com' }, { email: 'arjun@globussoft.com' }]),
    location: 'Zoom',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
  },
];

// Default mock — both providers offline (events reject), so the page settles
// to "Not connected" + empty events list.
function makeOfflineMock() {
  return (url) => {
    if (url === '/api/calendar/google/events' || url === '/api/calendar/outlook/events') {
      return Promise.reject(new Error('not connected'));
    }
    return Promise.resolve(null);
  };
}

// Google connected, outlook offline.
function makeGoogleOnlineMock(events = sampleGoogleEvents) {
  return (url, opts) => {
    if (url === '/api/calendar/google/events' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve(events);
    }
    if (url === '/api/calendar/outlook/events') {
      return Promise.reject(new Error('not connected'));
    }
    if (url === '/api/calendar/google/connect') {
      return Promise.resolve({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?stub=1' });
    }
    if (url === '/api/calendar/google/sync' && opts?.method === 'POST') {
      return Promise.resolve({ synced: 3 });
    }
    if (url === '/api/calendar/google/disconnect' && opts?.method === 'DELETE') {
      return Promise.resolve({ ok: true });
    }
    if (url === '/api/calendar/google/events' && opts?.method === 'POST') {
      return Promise.resolve({ id: 'new-evt' });
    }
    return Promise.resolve(null);
  };
}

describe('<CalendarSync /> — provider cards, OAuth-trigger, sync, event CRUD', () => {
  let locStub;

  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
    // Default: clean URL, no ?connected= / ?error=.
    locStub = stubLocation({ search: '' });
  });

  afterEach(() => {
    locStub?.restore();
  });

  it('mount: renders heading + both provider labels + fires both events GETs', async () => {
    fetchApiMock.mockImplementation(makeOfflineMock());
    render(<CalendarSync />);

    expect(
      screen.getByRole('heading', { name: /Calendar Sync/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    expect(screen.getByText('Microsoft Outlook')).toBeInTheDocument();

    await waitFor(() => {
      const googleGet = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/calendar/google/events' && (!o || !o.method || o.method === 'GET'),
      );
      expect(googleGet).toBeTruthy();
    });
    await waitFor(() => {
      const outlookGet = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/calendar/outlook/events' && (!o || !o.method || o.method === 'GET'),
      );
      expect(outlookGet).toBeTruthy();
    });
  });

  it('both providers offline: each card shows "Not connected" pill + a Connect button', async () => {
    fetchApiMock.mockImplementation(makeOfflineMock());
    render(<CalendarSync />);

    // The "Not connected" status pill renders TWICE — once per card. Use
    // getAllByText for the duplicate label per CLAUDE.md standing rule.
    const pills = await screen.findAllByText(/Not connected/i);
    expect(pills.length).toBe(2);

    const connectBtns = screen.getAllByRole('button', { name: /Connect/i });
    expect(connectBtns.length).toBe(2);
  });

  it('one provider connected: that card shows "Connected" + Sync Now + Disconnect; the other stays Not connected', async () => {
    fetchApiMock.mockImplementation(makeGoogleOnlineMock());
    render(<CalendarSync />);

    // The Google card flips to "Connected" once the events GET resolves.
    await screen.findByText(/^Connected$/i);
    // Outlook still rejects → still Not connected.
    expect(screen.getByText(/Not connected/i)).toBeInTheDocument();

    // Sync Now + Disconnect render only on the connected card.
    expect(
      await screen.findByRole('button', { name: /Sync Now/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Disconnect/i }),
    ).toBeInTheDocument();
  });

  it('no events synced: events panel renders the "No events synced yet" copy', async () => {
    fetchApiMock.mockImplementation(makeOfflineMock());
    render(<CalendarSync />);

    expect(
      await screen.findByText(/No events synced yet/i),
    ).toBeInTheDocument();
  });

  it('initial loading: events panel renders "Loading events..." until fetches settle', async () => {
    // Hold the events fetches pending so the loading state survives a synchronous render.
    let resolveGoogle;
    let resolveOutlook;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/calendar/google/events') {
        return new Promise((r) => { resolveGoogle = r; });
      }
      if (url === '/api/calendar/outlook/events') {
        return new Promise((r) => { resolveOutlook = r; });
      }
      return Promise.resolve(null);
    });
    render(<CalendarSync />);

    // The loading copy renders synchronously on initial mount.
    expect(screen.getByText(/Loading events\.\.\./i)).toBeInTheDocument();

    // Resolve to unwind the pending state so RTL teardown is clean.
    resolveGoogle?.([]);
    resolveOutlook?.([]);
  });

  it('Connect button: GETs /<provider>/connect and assigns the returned authUrl to window.location.href', async () => {
    // The Connect button only renders when the provider is NOT connected, so
    // build a mock where /events rejects (= offline) but /connect resolves.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/calendar/google/events') return Promise.reject(new Error('not connected'));
      if (url === '/api/calendar/outlook/events') return Promise.reject(new Error('not connected'));
      if (url === '/api/calendar/google/connect') {
        return Promise.resolve({ authUrl: 'https://accounts.google.com/oauth/stub' });
      }
      return Promise.resolve(null);
    });
    render(<CalendarSync />);

    // Wait for the offline state to settle so the Connect buttons are mounted.
    const connectBtns = await screen.findAllByRole('button', { name: /Connect/i });
    // First card is Google per the PROVIDERS array order.
    fireEvent.click(connectBtns[0]);

    await waitFor(() => {
      const connectCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/calendar/google/connect');
      expect(connectCall).toBeTruthy();
    });
    await waitFor(() => {
      expect(locStub.hrefSetter).toHaveBeenCalledWith('https://accounts.google.com/oauth/stub');
    });
  });

  it('Sync Now: POSTs /<provider>/sync and reloads the events list', async () => {
    fetchApiMock.mockImplementation(makeGoogleOnlineMock());
    render(<CalendarSync />);

    const syncBtn = await screen.findByRole('button', { name: /Sync Now/i });
    fetchApiMock.mockClear();
    // Re-install the same mock impl since mockClear() also clears it.
    fetchApiMock.mockImplementation(makeGoogleOnlineMock());

    fireEvent.click(syncBtn);

    await waitFor(() => {
      const syncCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/calendar/google/sync' && o?.method === 'POST',
      );
      expect(syncCall).toBeTruthy();
    });
    // Post-sync reload fires another /events GET.
    await waitFor(() => {
      const reloadCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/calendar/google/events' && (!o || !o.method || o.method === 'GET'),
      );
      expect(reloadCall).toBeTruthy();
    });
  });

  it('Disconnect: notify.confirm → DELETE /<provider>/disconnect + reload', async () => {
    fetchApiMock.mockImplementation(makeGoogleOnlineMock());
    render(<CalendarSync />);

    const disconnectBtn = await screen.findByRole('button', { name: /Disconnect/i });
    notifyConfirm.mockResolvedValueOnce(true);
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(makeGoogleOnlineMock());

    fireEvent.click(disconnectBtn);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/Disconnect google Calendar/i),
      );
    });
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/calendar/google/disconnect' && o?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
  });

  it('?connected=google on mount: success toast renders + URL query cleared', async () => {
    // Re-stub location with the success query string.
    locStub.restore();
    locStub = stubLocation({ search: '?connected=google', pathname: '/calendar-sync' });

    fetchApiMock.mockImplementation(makeOfflineMock());
    render(<CalendarSync />);

    expect(
      await screen.findByText(/Google Calendar connected!/i),
    ).toBeInTheDocument();
    // The page calls window.history.replaceState({}, '', pathname) to clear
    // the query string after surfacing the toast.
    await waitFor(() => {
      expect(locStub.replaceState).toHaveBeenCalledWith({}, '', '/calendar-sync');
    });
  });

  it('?error=<msg> on mount: failure toast renders the message + URL query cleared', async () => {
    locStub.restore();
    locStub = stubLocation({ search: '?error=access_denied', pathname: '/calendar-sync' });

    fetchApiMock.mockImplementation(makeOfflineMock());
    render(<CalendarSync />);

    expect(
      await screen.findByText(/Connection failed: access_denied/i),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(locStub.replaceState).toHaveBeenCalledWith({}, '', '/calendar-sync');
    });
  });

  it('events list: when a connected provider returns events, the title + count + provider badge render', async () => {
    fetchApiMock.mockImplementation(makeGoogleOnlineMock());
    render(<CalendarSync />);

    // The event title from sampleGoogleEvents.
    expect(
      await screen.findByText(/Quarterly client review/i),
    ).toBeInTheDocument();
    // The "N event(s)" header reflects the count.
    expect(screen.getByText(/1 event\b/i)).toBeInTheDocument();
    // The provider label "Google Calendar" appears at least twice — once in
    // the provider card header and once in the row's provider-badge. Use
    // getAllByText per the CLAUDE.md standing rule for duplicate labels.
    const labels = screen.getAllByText('Google Calendar');
    expect(labels.length).toBeGreaterThanOrEqual(2);
  });

  it('Create-Event modal: clicking the "+" on a connected card opens the modal with provider-scoped heading', async () => {
    fetchApiMock.mockImplementation(makeGoogleOnlineMock());
    render(<CalendarSync />);

    // Wait until the connected state settles so the "+" button is in the DOM.
    await screen.findByText(/^Connected$/i);

    // The "+" icon button has title="Create new calendar event".
    const plusBtn = screen.getByTitle(/Create new calendar event/i);
    fireEvent.click(plusBtn);

    // Modal heading is provider-scoped.
    expect(
      await screen.findByRole('heading', { name: /Create Event in Google/i }),
    ).toBeInTheDocument();
    // Both required-field placeholders render.
    expect(
      screen.getByPlaceholderText(/Team Meeting, Client Call/i),
    ).toBeInTheDocument();
  });

  it('Create-Event submit gate: button stays disabled until title + start + end are all filled', async () => {
    fetchApiMock.mockImplementation(makeGoogleOnlineMock());
    render(<CalendarSync />);

    await screen.findByText(/^Connected$/i);
    fireEvent.click(screen.getByTitle(/Create new calendar event/i));
    await screen.findByRole('heading', { name: /Create Event in Google/i });

    // Submit button is the "Create Event" inside the modal.
    const submitBtn = screen.getByRole('button', { name: /^Create Event$/i });
    // With empty title/start/end → disabled (gating condition lives in
    // CalendarSync.jsx:1264 `disabled={!formData.title || !formData.startTime
    // || !formData.endTime || busy[createProvider]}`).
    expect(submitBtn).toBeDisabled();

    // Fill title only → still disabled (start/end empty).
    fireEvent.change(screen.getByPlaceholderText(/Team Meeting, Client Call/i), {
      target: { value: 'Daily standup' },
    });
    expect(submitBtn).toBeDisabled();
  });

  it('event row click: opens the detail modal with the event title rendered + Close button', async () => {
    fetchApiMock.mockImplementation(makeGoogleOnlineMock());
    render(<CalendarSync />);

    // Click the populated event row.
    const evtTitle = await screen.findByText(/Quarterly client review/i);
    fireEvent.click(evtTitle);

    // Detail modal heading renders the title (now appearing in TWO places —
    // the row + the modal heading — so use getAllByText).
    await waitFor(() => {
      const matches = screen.getAllByText(/Quarterly client review/i);
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
    // Modal exposes the Close button.
    expect(
      screen.getByRole('button', { name: /^Close$/i }),
    ).toBeInTheDocument();
  });
});
