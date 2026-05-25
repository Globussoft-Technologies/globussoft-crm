/**
 * Clients.jsx — vitest + RTL coverage for the converted-clients list page.
 *
 * Clients.jsx is the daily-use surface for the "Customer" status slice of
 * the Contact table — a separate page from Contacts / Leads / ConvertedLeads.
 * It renders a single-table view scoped to /api/contacts?status=Customer and
 * supports a client-side text filter across name / email / company. Row name
 * is a Link to /contacts/<id> (it deep-links into the shared ContactDetail
 * page, NOT a clients-specific detail surface).
 *
 * Contracts pinned here (all read out of frontend/src/pages/Clients.jsx as
 * of this commit; pin behavior, not prose):
 *
 *   1. Page renders the "Clients" heading + counter ("N active client(s)")
 *      + the Search input.
 *   2. Initial mount fires fetchApi('/api/contacts?status=Customer') — the
 *      status filter is load-bearing (without it the page would show every
 *      contact). Pins the URL verbatim.
 *   3. Counter pluralizes correctly: 0/2 clients → "active clients";
 *      1 client → "active client" (singular).
 *   4. Each row renders name (as a Link), email, company, title, score
 *      badge ("/100" suffix), and the formatted createdAt.
 *   5. Row name link href is `/contacts/<id>` (deep-link into the shared
 *      ContactDetail page).
 *   6. Loading state: "Loading clients..." renders before the initial fetch
 *      resolves.
 *   7. Empty state: "No clients found" renders when the API returns [].
 *   8. Empty-via-filter: when search term doesn't match any client, the
 *      same "No clients found" row renders (no rows pass the filter).
 *   9. Typing in the search box filters rows client-side across name,
 *      email, and company (case-insensitive, substring match).
 *  10. fetchApi rejection: the .catch() clears the loading state — the
 *      empty "No clients found" row renders (not the spinner forever).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable mock for the date helper so row date assertions are deterministic
// across ICU builds (see the 2026-05-07 cron-learning entry: 'zzz' TZ-label
// tokens differ between local-dev Node and CI Node). Render a verbatim
// `YYYY-MM-DD` slice so we don't bind to Intl.DateTimeFormat output.
vi.mock('../utils/date', () => ({
  formatDateMedium: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import Clients from '../pages/Clients';

const sampleClients = [
  {
    id: 1,
    name: 'Aarav Sharma',
    email: 'aarav@acme.example',
    company: 'Acme Corp',
    title: 'VP Engineering',
    aiScore: 82,
    createdAt: '2026-01-15T10:00:00.000Z',
    status: 'Customer',
  },
  {
    id: 2,
    name: 'Sneha Iyer',
    email: 'sneha@wellness.example',
    company: 'Wellness Co',
    title: 'Founder',
    aiScore: 55,
    createdAt: '2026-02-20T10:00:00.000Z',
    status: 'Customer',
  },
  {
    id: 3,
    name: 'Rohit Verma',
    email: 'rohit@startup.example',
    company: 'Startup Labs',
    title: 'CTO',
    aiScore: 25,
    createdAt: '2026-03-10T10:00:00.000Z',
    status: 'Customer',
  },
];

function defaultFetchMock(url) {
  if (url === '/api/contacts?status=Customer') {
    return Promise.resolve(sampleClients);
  }
  return Promise.resolve(null);
}

function renderClients() {
  return render(
    <MemoryRouter>
      <Clients />
    </MemoryRouter>,
  );
}

describe('<Clients /> — converted-clients list page', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
  });

  it('renders the heading + counter + Search input', async () => {
    renderClients();
    expect(screen.getByRole('heading', { name: /Clients/i })).toBeInTheDocument();
    // Counter populated after fetch resolves — use findByText (CI-shard-safe).
    expect(await screen.findByText(/3 active clients/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search clients/i)).toBeInTheDocument();
  });

  it('initial mount fetches /api/contacts?status=Customer (status filter is load-bearing)', async () => {
    renderClients();
    await waitFor(() => {
      const customerCall = fetchApiMock.mock.calls.find(
        ([u]) => u === '/api/contacts?status=Customer',
      );
      expect(customerCall).toBeTruthy();
    });
  });

  it('counter pluralizes: 0 → "active clients", 1 → "active client", 2 → "active clients"', async () => {
    // 0 clients
    fetchApiMock.mockImplementation(() => Promise.resolve([]));
    const { unmount } = renderClients();
    expect(await screen.findByText(/0 active clients/i)).toBeInTheDocument();
    unmount();

    // 1 client (singular)
    fetchApiMock.mockImplementation(() => Promise.resolve([sampleClients[0]]));
    const { unmount: unmount1 } = renderClients();
    // Match singular but reject the plural: assert the literal "client" that
    // is NOT followed by "s ".
    expect(await screen.findByText(/^1 active client$/i)).toBeInTheDocument();
    unmount1();

    // 2 clients (plural)
    fetchApiMock.mockImplementation(() => Promise.resolve(sampleClients.slice(0, 2)));
    renderClients();
    expect(await screen.findByText(/2 active clients/i)).toBeInTheDocument();
  });

  it('renders one row per client with name (link), email, company, title, score badge, and date', async () => {
    renderClients();
    // Wait for at least one row to land.
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    // All three names present.
    expect(screen.getByText('Sneha Iyer')).toBeInTheDocument();
    expect(screen.getByText('Rohit Verma')).toBeInTheDocument();

    // Email + company + title columns render their cell values.
    expect(screen.getByText('aarav@acme.example')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('VP Engineering')).toBeInTheDocument();

    // Score badge renders as "<score>/100".
    expect(screen.getByText('82/100')).toBeInTheDocument();
    expect(screen.getByText('55/100')).toBeInTheDocument();
    expect(screen.getByText('25/100')).toBeInTheDocument();

    // Date rendered through the mocked formatDateMedium (ISO YYYY-MM-DD slice).
    expect(screen.getByText('2026-01-15')).toBeInTheDocument();
  });

  it('row name link deep-links to /contacts/<id> (shared ContactDetail page)', async () => {
    renderClients();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    const aaravLink = screen.getByRole('link', { name: 'Aarav Sharma' });
    expect(aaravLink.getAttribute('href')).toBe('/contacts/1');

    const snehaLink = screen.getByRole('link', { name: 'Sneha Iyer' });
    expect(snehaLink.getAttribute('href')).toBe('/contacts/2');
  });

  it('shows "Loading clients..." before the initial fetch resolves', async () => {
    let resolveFetch;
    fetchApiMock.mockImplementation(() => new Promise((r) => { resolveFetch = r; }));
    renderClients();
    // While the fetch is in-flight the loading row renders.
    expect(await screen.findByText(/Loading clients/i)).toBeInTheDocument();
    // Resolve cleanly so React tear-down doesn't warn.
    resolveFetch([]);
  });

  it('renders "No clients found" when the API returns an empty list', async () => {
    fetchApiMock.mockImplementation(() => Promise.resolve([]));
    renderClients();
    expect(await screen.findByText(/No clients found/i)).toBeInTheDocument();
  });

  it('search filters rows across name / email / company (case-insensitive substring)', async () => {
    renderClients();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/Search clients/i);

    // Filter by name fragment (case-insensitive).
    fireEvent.change(search, { target: { value: 'AARAV' } });
    expect(screen.getByText('Aarav Sharma')).toBeInTheDocument();
    expect(screen.queryByText('Sneha Iyer')).not.toBeInTheDocument();
    expect(screen.queryByText('Rohit Verma')).not.toBeInTheDocument();

    // Filter by company fragment.
    fireEvent.change(search, { target: { value: 'wellness' } });
    expect(screen.queryByText('Aarav Sharma')).not.toBeInTheDocument();
    expect(screen.getByText('Sneha Iyer')).toBeInTheDocument();
    expect(screen.queryByText('Rohit Verma')).not.toBeInTheDocument();

    // Filter by email fragment.
    fireEvent.change(search, { target: { value: 'startup.example' } });
    expect(screen.queryByText('Aarav Sharma')).not.toBeInTheDocument();
    expect(screen.queryByText('Sneha Iyer')).not.toBeInTheDocument();
    expect(screen.getByText('Rohit Verma')).toBeInTheDocument();
  });

  it('renders "No clients found" when search term matches no clients', async () => {
    renderClients();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/Search clients/i), {
      target: { value: 'zzzz-no-such-client-xyz' },
    });

    expect(screen.getByText(/No clients found/i)).toBeInTheDocument();
    expect(screen.queryByText('Aarav Sharma')).not.toBeInTheDocument();
  });

  it('fetchApi rejection clears the loading state (falls through to the empty-state row)', async () => {
    // The page's .catch() handler only does setLoading(false) — clients
    // state stays []. So the rendered output is the "No clients found" row,
    // NOT "Loading clients..." indefinitely.
    fetchApiMock.mockImplementation(() => Promise.reject(new Error('Network error')));
    renderClients();
    expect(await screen.findByText(/No clients found/i)).toBeInTheDocument();
    expect(screen.queryByText(/Loading clients/i)).not.toBeInTheDocument();
  });
});
