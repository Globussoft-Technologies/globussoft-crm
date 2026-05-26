/**
 * Tickets.test.jsx — vitest + RTL coverage for the Support Tickets page.
 *
 * Scope: pins the page-surface invariants for the service/support ticket
 * list + management page (frontend/src/pages/Tickets.jsx, 306 LOC). This
 * is the first test file for the page — no prior coverage existed.
 *
 *   1. Page renders heading "Support Tickets" + Create Ticket form panel
 *      + All Tickets table panel.
 *   2. Initial mount fires GET /api/tickets AND GET /api/auth/users in
 *      parallel (Promise.all) — the assignee dropdown's options come
 *      from /api/auth/users.
 *   3. Loading state: "Loading..." renders while the initial fetch is
 *      in-flight.
 *   4. Empty state: "No tickets found. Create one to get started."
 *      renders when /api/tickets returns [].
 *   5. Renders one row per ticket with #id, subject, status select,
 *      priority badge, assignee name (or "—" when unassigned),
 *      formatted createdAt, Delete button.
 *   6. Stats bar: when tickets exist, Open count + total count pills
 *      render; Urgent count pill only renders when ≥1 urgent + not-closed
 *      ticket exists.
 *   7. Submitting the Create Ticket form POSTs /api/tickets with subject,
 *      description (or null), priority, and an integer-parsed assigneeId
 *      when chosen.
 *   8. Empty description → POST body carries description: null (not "").
 *   9. Empty assignee → POST body omits assigneeId entirely.
 *  10. Changing a row's status <select> fires PUT /api/tickets/:id with
 *      { status: <new> } and refreshes the list.
 *  11. Clicking Delete → notify.confirm() prompts; on confirm, fires
 *      DELETE /api/tickets/:id and refreshes; on cancel, no DELETE.
 *  12. Create-form POST failure surfaces notify.error(...).
 *
 * Drift note: priority + status vocab is pinned by the page's
 * PRIORITY_CONFIG / STATUS_CONFIG constants (Low/Medium/High/Urgent and
 * Open/Pending/Resolved/Closed). The test mirrors those exactly. There
 * is no SLA timer surface or role gate in the current page — both were
 * mentioned in the brief but do not exist in the source as of this
 * file's authoring.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'fake-token',
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import Tickets from '../pages/Tickets';

const sampleUsers = [
  { id: 11, name: 'Anita Sharma', email: 'anita@globussoft.com' },
  { id: 12, name: 'Rohit Verma', email: 'rohit@globussoft.com' },
];

const sampleTickets = [
  {
    id: 101,
    subject: 'Login page not loading',
    description: 'Customer reports a blank screen on /login.',
    status: 'Open',
    priority: 'Urgent',
    assignee: { id: 11, name: 'Anita Sharma', email: 'anita@globussoft.com' },
    createdAt: '2026-04-10T09:00:00.000Z',
  },
  {
    id: 102,
    subject: 'Invoice PDF missing logo',
    description: 'Branding pack regression.',
    status: 'Pending',
    priority: 'Medium',
    assignee: null,
    createdAt: '2026-04-12T11:30:00.000Z',
  },
  {
    id: 103,
    subject: 'Reset password email never arrives',
    description: null,
    status: 'Closed',
    priority: 'High',
    assignee: { id: 12, name: 'Rohit Verma', email: 'rohit@globussoft.com' },
    createdAt: '2026-04-15T15:00:00.000Z',
  },
];

function defaultFetchMock(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (url === '/api/tickets' && method === 'GET') {
    return Promise.resolve(sampleTickets);
  }
  if (url === '/api/auth/users' && method === 'GET') {
    return Promise.resolve(sampleUsers);
  }
  // POST / PUT / DELETE default success.
  return Promise.resolve({});
}

function renderTickets() {
  return render(<Tickets />);
}

describe('<Tickets /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
  });

  it('renders the page heading + Create Ticket form + All Tickets panel', async () => {
    renderTickets();
    expect(
      screen.getByRole('heading', { name: /Support Tickets/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Create Ticket/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /All Tickets/i }),
    ).toBeInTheDocument();
    // Wait for fetch to settle so React doesn't warn on un-awaited state set.
    await waitFor(() =>
      expect(screen.getByText('Login page not loading')).toBeInTheDocument(),
    );
  });

  it('initial mount fires GET /api/tickets AND GET /api/auth/users in parallel', async () => {
    renderTickets();
    await waitFor(() => {
      const ticketsCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/tickets' && (!o || !o.method || o.method === 'GET'),
      );
      const usersCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/auth/users' && (!o || !o.method || o.method === 'GET'),
      );
      expect(ticketsCall).toBeTruthy();
      expect(usersCall).toBeTruthy();
    });
  });

  it('shows "Loading..." before the initial fetch resolves', async () => {
    let resolveTickets;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/tickets') {
        return new Promise((r) => { resolveTickets = r; });
      }
      if (url === '/api/auth/users') return Promise.resolve(sampleUsers);
      return Promise.resolve({});
    });
    renderTickets();
    // Pinned text from Tickets.jsx:214 "Loading...".
    expect(await screen.findByText(/Loading\.\.\./i)).toBeInTheDocument();
    // Resolve so the test cleanly tears down.
    resolveTickets([]);
  });

  it('renders empty-state message when /api/tickets returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/tickets') return Promise.resolve([]);
      if (url === '/api/auth/users') return Promise.resolve(sampleUsers);
      return Promise.resolve({});
    });
    renderTickets();
    expect(
      await screen.findByText(/No tickets found\. Create one to get started\./i),
    ).toBeInTheDocument();
  });

  it('renders one row per ticket with id, subject, priority badge, assignee, and Delete button', async () => {
    renderTickets();
    // Wait for the table to populate.
    await waitFor(() =>
      expect(screen.getByText('Login page not loading')).toBeInTheDocument(),
    );
    // #id cells render with the "#" prefix.
    expect(screen.getByText('#101')).toBeInTheDocument();
    expect(screen.getByText('#102')).toBeInTheDocument();
    expect(screen.getByText('#103')).toBeInTheDocument();
    // Subjects render.
    expect(screen.getByText('Invoice PDF missing logo')).toBeInTheDocument();
    expect(screen.getByText('Reset password email never arrives')).toBeInTheDocument();
    // Priority badges render with the literal level label — BUT each label
    // also appears as an <option> in the Create-form Priority dropdown
    // (Low/Medium/High/Urgent). Assert via getAllByText with length >= 2
    // (badge in cell + at least one option) to pin the cell render without
    // colliding with the dropdown vocab.
    expect(screen.getAllByText('Urgent').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Medium').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('High').length).toBeGreaterThanOrEqual(2);
    // Assignee cell: named for assigned rows, "—" for unassigned.
    expect(screen.getByText('Anita Sharma')).toBeInTheDocument();
    expect(screen.getByText('Rohit Verma')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    // Delete buttons render — three rows.
    const deleteButtons = screen.getAllByRole('button', { name: /Delete/i });
    expect(deleteButtons.length).toBeGreaterThanOrEqual(3);
  });

  it('stats bar renders Open + total counters; Urgent pill renders only when applicable', async () => {
    renderTickets();
    // With sampleTickets: 1 Open, 3 total, 1 Urgent (which is not Closed).
    expect(await screen.findByText(/1 Open/)).toBeInTheDocument();
    expect(screen.getByText(/3 total/)).toBeInTheDocument();
    expect(screen.getByText(/1 Urgent/)).toBeInTheDocument();
  });

  it('stats bar hides Urgent pill when no urgent-and-not-closed tickets exist', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/tickets') {
        return Promise.resolve([
          {
            id: 201,
            subject: 'Cosmetic CSS tweak',
            description: '',
            status: 'Open',
            priority: 'Low',
            assignee: null,
            createdAt: '2026-04-20T09:00:00.000Z',
          },
        ]);
      }
      if (url === '/api/auth/users') return Promise.resolve(sampleUsers);
      return Promise.resolve({});
    });
    renderTickets();
    expect(await screen.findByText(/1 Open/)).toBeInTheDocument();
    // No Urgent pill — assert via the "<N> Urgent" pill text shape so we
    // don't collide with the always-present `<option value="Urgent">Urgent`
    // in the Create-form Priority dropdown.
    expect(screen.queryByText(/\d+\s+Urgent/)).not.toBeInTheDocument();
  });

  it('submitting the Create form POSTs /api/tickets with subject, description, priority, and parsed assigneeId', async () => {
    renderTickets();
    await waitFor(() =>
      expect(screen.getByText('Login page not loading')).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByPlaceholderText(/Login page not loading/i), {
      target: { value: 'Webhook retries flooding logs' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe the issue\.\.\./i), {
      target: { value: 'Sentry shows 50k events/hour from /api/webhooks.' },
    });
    // Select Priority: High.
    const selects = screen.getAllByRole('combobox');
    // Priority is the first <select> in the create form (3 selects total in
    // the form: Priority, Assignee; the row selects belong to the table).
    // Use the displayed option-value pin: scan for a select whose current
    // value is the default 'Medium' (Priority) vs '' (Assignee).
    const prioritySelect = selects.find((s) => s.value === 'Medium');
    const assigneeSelect = selects.find((s) => s.value === '');
    expect(prioritySelect).toBeTruthy();
    expect(assigneeSelect).toBeTruthy();
    fireEvent.change(prioritySelect, { target: { value: 'High' } });
    fireEvent.change(assigneeSelect, { target: { value: '11' } });

    fetchApiMock.mockClear();
    // Restore the default mock impl since mockClear wipes implementation too.
    fetchApiMock.mockImplementation(defaultFetchMock);

    fireEvent.click(screen.getByRole('button', { name: /Submit Ticket/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/tickets' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.subject).toBe('Webhook retries flooding logs');
      expect(body.description).toBe('Sentry shows 50k events/hour from /api/webhooks.');
      expect(body.priority).toBe('High');
      // Pinned: assigneeId is parseInt'd — Number 11, not string "11".
      expect(body.assigneeId).toBe(11);
      expect(typeof body.assigneeId).toBe('number');
    });
  });

  it('empty description → POST body carries description: null (not ""), and omits assigneeId when none chosen', async () => {
    renderTickets();
    await waitFor(() =>
      expect(screen.getByText('Login page not loading')).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByPlaceholderText(/Login page not loading/i), {
      target: { value: 'Slow query in /api/reports' },
    });
    // Leave description blank, leave assignee unassigned.

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    fireEvent.click(screen.getByRole('button', { name: /Submit Ticket/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/tickets' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.subject).toBe('Slow query in /api/reports');
      // Pinned: empty string → null per `form.description || null`.
      expect(body.description).toBeNull();
      // Pinned: assigneeId is omitted entirely (not present, not undefined).
      expect('assigneeId' in body).toBe(false);
    });
  });

  it('changing a row\'s status select fires PUT /api/tickets/:id with { status }', async () => {
    renderTickets();
    await waitFor(() =>
      expect(screen.getByText('Login page not loading')).toBeInTheDocument(),
    );

    // The three row-status selects each have current value matching their
    // ticket — 'Open' / 'Pending' / 'Closed'. Find the 'Open' one.
    const selects = screen.getAllByRole('combobox');
    const openRowSelect = selects.find((s) => s.value === 'Open');
    expect(openRowSelect).toBeTruthy();

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    fireEvent.change(openRowSelect, { target: { value: 'Resolved' } });

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/tickets/101' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body).toEqual({ status: 'Resolved' });
    });
  });

  it('clicking Delete + confirming fires DELETE /api/tickets/:id', async () => {
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    renderTickets();
    await waitFor(() =>
      expect(screen.getByText('Login page not loading')).toBeInTheDocument(),
    );

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    // Click the first row's Delete button → ticket id 101.
    fireEvent.click(screen.getAllByRole('button', { name: /Delete/i })[0]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });

    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/tickets/101' && o?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it('clicking Delete + cancelling fires NO DELETE request', async () => {
    notifyConfirm.mockImplementation(() => Promise.resolve(false));
    renderTickets();
    await waitFor(() =>
      expect(screen.getByText('Login page not loading')).toBeInTheDocument(),
    );

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    fireEvent.click(screen.getAllByRole('button', { name: /Delete/i })[0]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });

    // Give the (suppressed) request a tick to NOT happen.
    await new Promise((r) => setTimeout(r, 20));
    const deleteCall = fetchApiMock.mock.calls.find(
      ([u, o]) => typeof u === 'string' && u.startsWith('/api/tickets/') && o?.method === 'DELETE',
    );
    expect(deleteCall).toBeUndefined();
  });

  it('create-form POST failure surfaces notify.error("Failed to create ticket.")', async () => {
    renderTickets();
    await waitFor(() =>
      expect(screen.getByText('Login page not loading')).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByPlaceholderText(/Login page not loading/i), {
      target: { value: 'Broken thing' },
    });

    // Override mock so the POST rejects, but GETs still succeed (so the
    // initial-mount fetches that already ran don't trip a re-render error).
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/tickets' && opts?.method === 'POST') {
        return Promise.reject(new Error('500 internal'));
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(screen.getByRole('button', { name: /Submit Ticket/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to create ticket/i),
      );
    });
  });
});
