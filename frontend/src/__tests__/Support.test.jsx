/**
 * Support.test.jsx — vitest + RTL coverage for the Customer Support helpdesk page.
 *
 * Scope: pins the page-surface invariants for the read-only support-ticket
 * list page (frontend/src/pages/Support.jsx, 70 LOC). This is the first
 * test file for the page — no prior coverage existed.
 *
 * Pinned contract (read straight from SUT, not the prompt's framing):
 *   1. Page renders header "Customer Support" + subtitle + "New Ticket"
 *      button + a 4-column table (Subject / Requester / Status / Priority).
 *   2. Initial mount fires fetchApi('/api/support') — no auth-users call,
 *      no Promise.all. The page is a flat read-only list, not the full
 *      Tickets CRUD surface.
 *   3. Loading state: "Loading tickets..." row renders in tbody while the
 *      fetch is in-flight (colSpan=4 single cell).
 *   4. Loaded state: renders one row per ticket with subject, lastUpdated,
 *      requester, status pill, and priority.
 *   5. Non-array response (the catch-all path) → tickets state stays
 *      empty; the table renders headers but no body rows.
 *   6. fetchApi rejection → tickets stays empty; loading clears. No
 *      uncaught promise.
 *   7. Status pill text is the literal ticket.status string ("Open",
 *      "Resolved", etc.) — the colour fork in the source is inline-style
 *      driven so we pin text, not colour.
 *
 * Drift note: the page has NO create / edit / delete / status-change /
 * notify wiring — the "New Ticket" button is non-functional in the
 * current source. Only the read surface is testable. If a future change
 * wires the button, extend this file to cover the click handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'fake-token',
}));

import Support from '../pages/Support';

const sampleTickets = [
  {
    id: 501,
    subject: 'Cannot reset password',
    requester: 'Priya Menon',
    status: 'Open',
    priority: 'High',
    lastUpdated: '2 hours ago',
  },
  {
    id: 502,
    subject: 'Invoice PDF rendering issue',
    requester: 'Rohit Verma',
    status: 'Resolved',
    priority: 'Medium',
    lastUpdated: 'yesterday',
  },
];

beforeEach(() => {
  fetchApiMock.mockReset();
});

describe('<Support /> — read-only helpdesk list page', () => {
  it('renders header, subtitle, and New Ticket button on initial mount', async () => {
    // Never-resolving promise keeps the page in loading state — the chrome
    // (header / button) should still render.
    fetchApiMock.mockReturnValue(new Promise(() => {}));
    render(<Support />);

    expect(screen.getByRole('heading', { name: /customer support/i })).toBeInTheDocument();
    expect(screen.getByText(/manage helpdesk tickets and customer issues/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new ticket/i })).toBeInTheDocument();
  });

  it('renders the 4-column table header (Subject / Requester / Status / Priority)', () => {
    fetchApiMock.mockReturnValue(new Promise(() => {}));
    render(<Support />);

    expect(screen.getByRole('columnheader', { name: /subject/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /requester/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /priority/i })).toBeInTheDocument();
  });

  it('fires GET /api/support exactly once on mount', async () => {
    fetchApiMock.mockResolvedValue([]);
    render(<Support />);

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    expect(fetchApiMock).toHaveBeenCalledWith('/api/support');
    expect(fetchApiMock).toHaveBeenCalledTimes(1);
  });

  it('shows "Loading tickets..." row while the fetch is in-flight', () => {
    fetchApiMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<Support />);

    expect(screen.getByText(/loading tickets\.\.\./i)).toBeInTheDocument();
  });

  it('renders one row per ticket with subject, requester, status, and priority', async () => {
    fetchApiMock.mockResolvedValue(sampleTickets);
    render(<Support />);

    await waitFor(() => expect(screen.getByText('Cannot reset password')).toBeInTheDocument());

    // Row 1
    expect(screen.getByText('Cannot reset password')).toBeInTheDocument();
    expect(screen.getByText('Priya Menon')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('2 hours ago')).toBeInTheDocument();

    // Row 2
    expect(screen.getByText('Invoice PDF rendering issue')).toBeInTheDocument();
    expect(screen.getByText('Rohit Verma')).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();

    // Loading row cleared after fetch resolved.
    expect(screen.queryByText(/loading tickets\.\.\./i)).not.toBeInTheDocument();
  });

  it('renders empty body (no ticket rows) when the API returns []', async () => {
    fetchApiMock.mockResolvedValue([]);
    render(<Support />);

    await waitFor(() => expect(screen.queryByText(/loading tickets\.\.\./i)).not.toBeInTheDocument());

    // Header row present, but no data rows.
    const table = screen.getByRole('table');
    const bodyRows = within(table).queryAllByRole('row');
    // Exactly 1 row — the <thead> row. Loading row is gone; no ticket rows added.
    expect(bodyRows.length).toBe(1);
  });

  it('falls back to an empty list when the API returns a non-array payload', async () => {
    // Non-array response — the source coerces via Array.isArray check.
    fetchApiMock.mockResolvedValue({ error: 'unauthorized' });
    render(<Support />);

    await waitFor(() => expect(screen.queryByText(/loading tickets\.\.\./i)).not.toBeInTheDocument());

    const table = screen.getByRole('table');
    const bodyRows = within(table).queryAllByRole('row');
    expect(bodyRows.length).toBe(1); // thead only
  });

  it('handles fetchApi rejection gracefully (loading clears, no rows, no throw)', async () => {
    fetchApiMock.mockRejectedValue(new Error('network down'));
    render(<Support />);

    await waitFor(() => expect(screen.queryByText(/loading tickets\.\.\./i)).not.toBeInTheDocument());

    const table = screen.getByRole('table');
    const bodyRows = within(table).queryAllByRole('row');
    expect(bodyRows.length).toBe(1); // thead only — catch path kept tickets at []
    // Chrome still rendered.
    expect(screen.getByRole('heading', { name: /customer support/i })).toBeInTheDocument();
  });
});
