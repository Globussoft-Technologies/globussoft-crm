/**
 * ConvertedLeads.jsx — vitest + RTL coverage for the multi-status converted
 * lead/prospect/customer/churned page (frontend/src/pages/ConvertedLeads.jsx,
 * 354 LOC).
 *
 * ConvertedLeads.jsx is the daily-use surface for navigating contacts by
 * lifecycle status (Lead / Prospect / Customer / Churned / Junk). It is
 * adjacent to but distinct from Clients.jsx (single-status Customer slice
 * only) and Leads.jsx (Lead-creation form). The page hits the
 * /api/contacts/by-status?status=<X> endpoint per chip click + a parallel
 * burst at mount to populate the chip-count labels. Includes per-row
 * assign / bulk-assign / revert-to-lead actions plus a free-text client
 * filter across name / email / company.
 *
 * Contracts pinned here (all read out of frontend/src/pages/ConvertedLeads.jsx
 * as of this commit; pin behavior, not prose):
 *
 *   1. Page renders the "Converted Leads" heading + counter ("N lead(s) in
 *      <status>") + the Search input + the Status filter chips.
 *   2. Default selected status is "Prospect" — initial mount fetches
 *      /api/contacts/by-status?status=Prospect, plus /api/staff, plus the
 *      5-status chip-count burst.
 *   3. Status chips show count suffix "<Status> (N)" for each of the 5
 *      lifecycle statuses (Lead / Prospect / Customer / Churned / Junk).
 *   4. Defensive response-shape normalisation (#251): the page accepts
 *      raw arrays, {data:[]}, {data:{data:[]}}, and {contacts:[]}.
 *   5. Empty state: "No leads found" renders when the API returns [].
 *   6. Loading state: "Loading leads..." renders before the initial fetch
 *      resolves.
 *   7. Each row renders name, email, company, source pill (defaults to
 *      "Organic" when null), aiScore badge ("<n>/100"), formatted createdAt.
 *   8. Clicking a different status chip refetches with the new status in
 *      the URL.
 *   9. Search filters rows client-side across name / email / company
 *      (case-insensitive substring match).
 *  10. Per-row Revert button triggers notify.confirm — cancelling does
 *      NOT issue the PATCH; confirming PATCHes status:'Lead'.
 *  11. Bulk-assign bar appears only when ≥1 row checkbox is selected, and
 *      counter pluralises correctly ("1 lead selected" vs "2 leads selected").
 *
 * Notes:
 *   - useNotify mock returns a STABLE object reference (avoids the
 *     useCallback dependency churn pattern documented in CLAUDE.md
 *     standing rules — `notifyObj` defined once outside the mock factory).
 *   - formatDateMedium is stubbed to render the ISO YYYY-MM-DD slice so
 *     row-date assertions stay deterministic across ICU builds (CI vs
 *     local Node binaries render Intl tokens differently).
 *   - Labels like "Lead" appear in BOTH the chip column AND row source
 *     badges; tests use getAllByText / scoped queries where ambiguity
 *     exists.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable mock object reference (see CLAUDE.md standing rule on RTL stable
// hook returns). Fresh object per render would invalidate useCallback deps
// and risk re-render loops in pages that depend on the notify identity.
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: notifyConfirm,
  prompt: vi.fn(() => Promise.resolve('')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// Deterministic date rendering across ICU builds.
vi.mock('../utils/date', () => ({
  formatDateMedium: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import ConvertedLeads from '../pages/ConvertedLeads';

// Sample fixtures use realistic Indian names (per the user's standing
// preference for realistic test data, not "E2E Test User" style).
const sampleProspects = [
  {
    id: 101,
    name: 'Rohan Kapoor',
    email: 'rohan@northstar.example',
    company: 'NorthStar Logistics',
    aiScore: 82,
    source: 'LinkedIn',
    assignedToId: 1,
    createdAt: '2026-01-12T10:00:00.000Z',
    status: 'Prospect',
  },
  {
    id: 102,
    name: 'Meera Pillai',
    email: 'meera@bluepeak.example',
    company: 'BluePeak Analytics',
    aiScore: 55,
    source: 'Referral',
    assignedToId: null,
    createdAt: '2026-02-04T10:00:00.000Z',
    status: 'Prospect',
  },
  {
    id: 103,
    name: 'Arjun Nair',
    email: 'arjun@vertexfit.example',
    company: 'VertexFit Wellness',
    aiScore: 28,
    source: null, // exercises the "Organic" default-pill rendering
    assignedToId: null,
    createdAt: '2026-03-22T10:00:00.000Z',
    status: 'Prospect',
  },
];

const sampleStaff = [
  { id: 1, name: 'Priya Menon', email: 'priya@globussoft.example' },
  { id: 2, name: 'Vikram Joshi', email: 'vikram@globussoft.example' },
];

// Default fetch handler: respond to all the endpoints the page hits at
// mount + on chip clicks. The chip-count burst calls /by-status for each
// of the 5 lifecycle statuses; default to non-empty Prospect, empty others.
function defaultFetchMock(url, opts) {
  if (typeof url === 'string') {
    if (url.startsWith('/api/contacts/by-status?status=Prospect')) {
      return Promise.resolve({ success: true, count: sampleProspects.length, data: sampleProspects });
    }
    if (url.startsWith('/api/contacts/by-status?status=')) {
      // Empty for Lead / Customer / Churned / Junk.
      return Promise.resolve({ success: true, count: 0, data: [] });
    }
    if (url === '/api/staff') {
      return Promise.resolve(sampleStaff);
    }
    if (url.startsWith('/api/contacts/') && opts?.method === 'PATCH') {
      return Promise.resolve({ id: 101, status: 'Lead' });
    }
    if (url.includes('/assign') && opts?.method === 'PUT') {
      return Promise.resolve({ ok: true });
    }
  }
  return Promise.resolve(null);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ConvertedLeads />
    </MemoryRouter>,
  );
}

describe('<ConvertedLeads /> — multi-status contact lifecycle page', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyObj.error.mockReset();
    notifyObj.info.mockReset();
    notifyObj.success.mockReset();
    notifyObj.confirm.mockReset();
    notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
  });

  it('renders the heading, status filter, and search input', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Converted Leads/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search leads/i)).toBeInTheDocument();
    // "Status" filter header is rendered as <h3>; use heading role to scope.
    expect(screen.getByRole('heading', { name: /^Status$/i })).toBeInTheDocument();
    // Wait for fetch settle so the post-load counter populates.
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
  });

  it('default status is Prospect — initial mount fetches /by-status?status=Prospect and /api/staff', async () => {
    renderPage();
    await waitFor(() => {
      const prospectCall = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u === '/api/contacts/by-status?status=Prospect',
      );
      expect(prospectCall).toBeTruthy();
    });
    const staffCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/staff');
    expect(staffCall).toBeTruthy();
    // Header counter reflects "<n> leads in Prospect".
    expect(await screen.findByText(/3 leads in Prospect/i)).toBeInTheDocument();
  });

  it('renders all 5 lifecycle status chips with count suffix "<Status> (N)"', async () => {
    renderPage();
    // Wait for the parallel-burst chip-count fetches to all resolve.
    await waitFor(() => {
      // Prospect chip shows the count of sample rows (3).
      expect(screen.getByRole('button', { name: /^Prospect \(3\)$/ })).toBeInTheDocument();
    });
    // All 5 statuses present with their chip buttons; default empties resolve to 0.
    expect(screen.getByRole('button', { name: /^Lead \(0\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Customer \(0\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Churned \(0\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Junk \(0\)$/ })).toBeInTheDocument();
  });

  it('accepts {success, count, data:[]} envelope AND raw arrays AND {contacts:[]} shape (#251)', async () => {
    // Render once with raw-array shape — page must still populate rows.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/by-status?status=Prospect') {
        return Promise.resolve(sampleProspects); // raw array
      }
      if (url.startsWith('/api/contacts/by-status?status=')) {
        return Promise.resolve([]);
      }
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      return Promise.resolve(null);
    });
    const { unmount } = renderPage();
    expect(await screen.findByText('Rohan Kapoor')).toBeInTheDocument();
    unmount();

    // Now with {contacts:[]} envelope.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/by-status?status=Prospect') {
        return Promise.resolve({ contacts: sampleProspects });
      }
      if (url.startsWith('/api/contacts/by-status?status=')) {
        return Promise.resolve({ contacts: [] });
      }
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Rohan Kapoor')).toBeInTheDocument();
  });

  it('renders "Loading leads..." before the initial fetch resolves', async () => {
    let resolveFetch;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/by-status?status=Prospect') {
        return new Promise((r) => { resolveFetch = r; });
      }
      if (url.startsWith('/api/contacts/by-status?status=')) {
        return Promise.resolve({ success: true, count: 0, data: [] });
      }
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText(/Loading leads/i)).toBeInTheDocument();
    // Resolve cleanly so React teardown doesn't warn about lingering state.
    resolveFetch({ success: true, count: 0, data: [] });
  });

  it('renders "No leads found" when the API returns an empty list', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/contacts/by-status?status=')) {
        return Promise.resolve({ success: true, count: 0, data: [] });
      }
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText(/No leads found/i)).toBeInTheDocument();
  });

  it('renders one row per contact with name, email, company, score, source pill, and formatted date', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rohan Kapoor')).toBeInTheDocument());

    // All three rows render.
    expect(screen.getByText('Meera Pillai')).toBeInTheDocument();
    expect(screen.getByText('Arjun Nair')).toBeInTheDocument();

    // Email + company cells.
    expect(screen.getByText('rohan@northstar.example')).toBeInTheDocument();
    expect(screen.getByText('NorthStar Logistics')).toBeInTheDocument();

    // Score badge renders as "<n>/100".
    expect(screen.getByText('82/100')).toBeInTheDocument();
    expect(screen.getByText('55/100')).toBeInTheDocument();
    expect(screen.getByText('28/100')).toBeInTheDocument();

    // Source pills — Rohan has 'LinkedIn', Arjun has null → defaults to "Organic".
    // "LinkedIn" appears in the row source pill only (not the status chip set).
    expect(screen.getByText('LinkedIn')).toBeInTheDocument();
    expect(screen.getByText('Referral')).toBeInTheDocument();
    // Default fallback when source is null.
    expect(screen.getByText('Organic')).toBeInTheDocument();

    // Date rendered through the mocked formatDateMedium.
    expect(screen.getByText('2026-01-12')).toBeInTheDocument();
  });

  it('clicking a different status chip refetches /by-status with the new status', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rohan Kapoor')).toBeInTheDocument());

    fetchApiMock.mockClear();
    // Click the "Customer" chip — must trigger a refetch with status=Customer.
    fireEvent.click(screen.getByRole('button', { name: /^Customer \(0\)$/ }));

    await waitFor(() => {
      const customerCall = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u === '/api/contacts/by-status?status=Customer',
      );
      expect(customerCall).toBeTruthy();
    });
    // Header counter reflects the new selected status label.
    expect(await screen.findByText(/0 leads in Customer/i)).toBeInTheDocument();
  });

  it('search filters rows across name / email / company (case-insensitive substring)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rohan Kapoor')).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/Search leads/i);

    // Filter by name (case-insensitive).
    fireEvent.change(search, { target: { value: 'ROHAN' } });
    expect(screen.getByText('Rohan Kapoor')).toBeInTheDocument();
    expect(screen.queryByText('Meera Pillai')).not.toBeInTheDocument();
    expect(screen.queryByText('Arjun Nair')).not.toBeInTheDocument();

    // Filter by company fragment.
    fireEvent.change(search, { target: { value: 'bluepeak' } });
    expect(screen.queryByText('Rohan Kapoor')).not.toBeInTheDocument();
    expect(screen.getByText('Meera Pillai')).toBeInTheDocument();
    expect(screen.queryByText('Arjun Nair')).not.toBeInTheDocument();

    // Filter by email fragment.
    fireEvent.change(search, { target: { value: 'vertexfit' } });
    expect(screen.queryByText('Rohan Kapoor')).not.toBeInTheDocument();
    expect(screen.queryByText('Meera Pillai')).not.toBeInTheDocument();
    expect(screen.getByText('Arjun Nair')).toBeInTheDocument();

    // No-match → "No leads found" appears.
    fireEvent.change(search, { target: { value: 'no-such-contact-zzz' } });
    expect(screen.getByText(/No leads found/i)).toBeInTheDocument();
  });

  it('per-row Revert button triggers notify.confirm; cancelling does NOT issue the PATCH', async () => {
    notifyObj.confirm.mockImplementation(() => Promise.resolve(false));
    renderPage();
    await waitFor(() => expect(screen.getByText('Rohan Kapoor')).toBeInTheDocument());

    fetchApiMock.mockClear();
    // Click the first Revert button (multiple — one per row).
    const revertButtons = screen.getAllByRole('button', { name: /Revert/i });
    expect(revertButtons.length).toBe(sampleProspects.length);
    fireEvent.click(revertButtons[0]);

    await waitFor(() => expect(notifyObj.confirm).toHaveBeenCalledTimes(1));
    // Confirm prompt body mentions the row's name + the target route.
    const confirmArg = notifyObj.confirm.mock.calls[0][0];
    expect(confirmArg.title).toMatch(/Revert to Lead/i);
    expect(confirmArg.message).toMatch(/Rohan Kapoor/);

    // User cancelled → no PATCH issued, no refetch storm.
    const patchCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'PATCH',
    );
    expect(patchCall).toBeUndefined();
  });

  it('confirming Revert PATCHes the contact with status:"Lead" and fires success toast', async () => {
    notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
    renderPage();
    await waitFor(() => expect(screen.getByText('Rohan Kapoor')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: /Revert/i })[0]);

    await waitFor(() => {
      const patchCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => typeof url === 'string'
          && url.startsWith('/api/contacts/')
          && opts?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      // The URL contains the row's id.
      expect(patchCall[0]).toBe('/api/contacts/101');
      const body = JSON.parse(patchCall[1].body);
      expect(body.status).toBe('Lead');
    });
    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalledWith(expect.stringMatching(/Reverted to Lead/i));
    });
  });

  it('bulk-assign bar appears when ≥1 row is selected and counter pluralises correctly', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rohan Kapoor')).toBeInTheDocument());

    // No bulk bar before selection.
    expect(screen.queryByText(/lead selected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/leads selected/i)).not.toBeInTheDocument();

    // Row checkboxes — 1 select-all + N row checkboxes. Skip the first (header).
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]); // first row
    expect(await screen.findByText(/^1 lead selected$/i)).toBeInTheDocument();

    // Select second row — counter goes plural.
    fireEvent.click(checkboxes[2]);
    expect(await screen.findByText(/^2 leads selected$/i)).toBeInTheDocument();

    // Clear button collapses the bar.
    fireEvent.click(screen.getByRole('button', { name: /^Clear$/i }));
    await waitFor(() => {
      expect(screen.queryByText(/leads selected/i)).not.toBeInTheDocument();
    });
  });
});
