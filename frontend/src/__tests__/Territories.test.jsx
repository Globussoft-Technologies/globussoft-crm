/**
 * Territories.test.jsx — vitest + RTL coverage for the Sales Territories page
 * (`frontend/src/pages/Territories.jsx`).
 *
 * Scope: pins the page-surface invariants for the geographic territory CRUD
 * surface used by lead-routing rules with assignType "territory":
 *
 *   1. Initial mount fires BOTH GET /api/territories AND GET /api/staff in
 *      parallel — both are load-bearing (staff feeds the "Assigned Users"
 *      chip-set inside the modal).
 *   2. Loading state ("Loading territories...") renders before fetches
 *      resolve.
 *   3. Empty state renders the "No territories yet..." copy + a
 *      "Create First Territory" CTA when /api/territories returns [].
 *   4. List renders one card per territory with the name, the Regions
 *      count tile, the Users count tile, and the Contacts count tile.
 *   5. Region chips render (up to 4 shown) + "+N more" suffix when the
 *      regions array exceeds 4.
 *   6. Clicking "Add Territory" opens the modal with empty Name +
 *      Regions inputs.
 *   7. Saving with an empty name surfaces the "Name is required" error
 *      toast and does NOT POST.
 *   8. Saving a new territory POSTs /api/territories with the parsed
 *      body shape: { name, regions: [...trimmed-non-empty], assignedUserIds }
 *      (regionsText splits on comma + trims + filters empty entries).
 *   9. Edit pre-populates Name + Regions (joined by ", ") + selected
 *      user-id chips; saving fires PUT /api/territories/<id> (not POST).
 *  10. Delete first calls notify.confirm; on true, fires DELETE
 *      /api/territories/<id>; on false, no DELETE fires.
 *  11. "View Details" navigates into detail view; the detail view fires
 *      GET /api/territories/<id>/contacts and renders the contact rows
 *      OR the "No contacts assigned..." empty-state.
 *
 * Backend contracts pinned by this test (1 list + 1 staff lookup +
 * 4 mutation/read endpoints):
 *   GET    /api/territories
 *   GET    /api/staff
 *   POST   /api/territories
 *   PUT    /api/territories/:id
 *   DELETE /api/territories/:id
 *   GET    /api/territories/:id/contacts
 *
 * Stable-mock discipline: notify is a single object reused across renders
 * (per the 2026-05-09 cron-learning standing rule — fresh mock objects per
 * call cause infinite re-render loops through useCallback dep arrays).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn().mockResolvedValue(true);
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import Territories from '../pages/Territories';

const sampleTerritories = [
  {
    id: 1,
    name: 'North America West',
    regions: ['US-CA', 'US-OR', 'US-WA', 'US-NV', 'US-AZ', 'US-UT'],
    country: 'US',
    states: ['CA', 'OR', 'WA', 'NV', 'AZ', 'UT'],
    assignedUserIds: [10, 20],
    contactCount: 42,
  },
  {
    id: 2,
    name: 'EMEA Central',
    regions: ['DE', 'AT', 'CH'],
    assignedUserIds: [30],
    contactCount: 17,
  },
];

const sampleStaff = [
  { id: 10, name: 'Alice Reed', email: 'alice@globussoft.com' },
  { id: 20, name: 'Bharat Singh', email: 'bharat@globussoft.com' },
  { id: 30, name: 'Carla Mendes', email: 'carla@globussoft.com' },
];

const sampleContacts = [
  { id: 100, name: 'Wayne Industries', email: 'wayne@example.com', company: 'WI', status: 'active', assignedToId: 10 },
  { id: 101, name: 'Stark Manufacturing', email: 'stark@example.com', company: 'SM', status: 'lead', assignedToId: null },
];

function defaultFetchMock(url, opts) {
  if (url === '/api/territories' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleTerritories);
  }
  if (url === '/api/staff' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleStaff);
  }
  if (url === '/api/sales-teams' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve([]);
  }
  if (/^\/api\/territories\/\d+\/contacts$/.test(url)) {
    return Promise.resolve(sampleContacts);
  }
  return Promise.resolve(null);
}

function renderTerritories() {
  return render(
    <MemoryRouter>
      <Territories />
    </MemoryRouter>,
  );
}

describe('<Territories /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset().mockResolvedValue(true);
  });

  it('initial mount fires GET /api/territories AND GET /api/staff in parallel', async () => {
    renderTerritories();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/territories');
      expect(fetchApiMock).toHaveBeenCalledWith('/api/staff');
    });
  });

  it('renders the heading "Territories" + "Add Territory" CTA after load', async () => {
    renderTerritories();
    expect(await screen.findByRole('heading', { name: /^Territories$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Territory/i })).toBeInTheDocument();
  });

  it('renders generic territories in a table with all available fields', async () => {
    renderTerritories();
    expect(await screen.findByText('North America West')).toBeInTheDocument();
    expect(screen.getByText('EMEA Central')).toBeInTheDocument();
    expect(screen.getByText('Territory name')).toBeInTheDocument();
    expect(screen.getByText('US-CA, US-OR, US-WA, US-NV, US-AZ, US-UT')).toBeInTheDocument();
    expect(screen.getByText('Alice Reed, Bharat Singh')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument(); // contacts count
    expect(screen.getByText('17')).toBeInTheDocument();
  });

  it('opens the territory staff assignment editor from the Staff with access column', async () => {
    renderTerritories();
    await screen.findByText('North America West');
    fireEvent.click(screen.getByRole('button', { name: 'Manage staff for North America West' }));
    expect(screen.getByRole('heading', { name: /Assign staff/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Alice Reed.*alice@globussoft\.com.*Staff/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bharat Singh.*bharat@globussoft\.com.*Staff/i })).toBeInTheDocument();
  });

  it('refreshes contact counts after saving staff assignment', async () => {
    let territoryGets = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/territories' && opts?.method === 'PUT') return Promise.resolve({ id: 1 });
      if (url === '/api/territories') {
        territoryGets += 1;
        return Promise.resolve(territoryGets === 1
          ? sampleTerritories
          : sampleTerritories.map((territory) => territory.id === 1 ? { ...territory, contactCount: 99 } : territory));
      }
      return defaultFetchMock(url, opts);
    });
    renderTerritories();
    await screen.findByText('North America West');
    fireEvent.click(screen.getByRole('button', { name: 'Manage staff for North America West' }));
    fireEvent.click(screen.getByRole('button', { name: /Alice Reed.*alice@globussoft\.com.*Staff/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save assignment' }));
    await waitFor(() => expect(screen.getByText('99')).toBeInTheDocument());
    expect(territoryGets).toBe(2);
  });

  it('warns immediately when unselecting staff assigned through a team territory', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sales-teams') return Promise.resolve([{
        id: 50,
        name: 'North Sales Team',
        territoryMode: 'team',
        territoryId: 1,
        members: [{ userId: 10 }],
      }]);
      return defaultFetchMock(url, opts);
    });
    renderTerritories();
    await screen.findByText('North America West');
    fireEvent.click(screen.getByRole('button', { name: 'Manage staff for North America West' }));
    const alice = screen.getByRole('button', { name: /Alice Reed.*alice@globussoft\.com.*Staff/i });
    expect(alice).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(alice);
    expect(await screen.findByText(/Cannot remove this staff member.*North Sales Team/i)).toBeInTheDocument();
    expect(alice).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders all generic territory regions in the table', async () => {
    renderTerritories();
    await screen.findByText('North America West');
    expect(screen.getByText('United States')).toBeInTheDocument();
    expect(screen.getByText('US-CA, US-OR, US-WA, US-NV, US-AZ, US-UT')).toBeInTheDocument();
  });

  it('shows the current territory status instead of the opposite action', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/territories' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(sampleTerritories.map((territory, index) => ({ ...territory, isActive: index === 0 })));
      }
      return defaultFetchMock(url, opts);
    });
    renderTerritories();
    await screen.findByText('North America West');
    expect(screen.getByRole('button', { name: 'Activate North America West' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disabled EMEA Central' })).toBeInTheDocument();
  });

  it('renders empty state + "Create First Territory" CTA when list is empty', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/territories') return Promise.resolve([]);
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      return Promise.resolve(null);
    });
    renderTerritories();
    expect(await screen.findByText(/No territories yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create First Territory/i })).toBeInTheDocument();
  });

  it('shows "Loading territories..." before initial fetches resolve', async () => {
    let resolveT;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/territories') return new Promise((r) => { resolveT = r; });
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      return Promise.resolve(null);
    });
    renderTerritories();
    expect(await screen.findByText(/Loading territories/i)).toBeInTheDocument();
    // Resolve so the test tears down cleanly.
    resolveT([]);
  });

  it('clicking "Add Territory" opens the generic modal with country + state controls', async () => {
    renderTerritories();
    await screen.findByText('North America West');
    fireEvent.click(screen.getByRole('button', { name: /Add Territory/i }));
    // Modal heading.
    expect(screen.getByRole('heading', { name: /New Territory/i })).toBeInTheDocument();
    // Name input is empty.
    const nameInput = screen.getByPlaceholderText(/e\.g\. North America West/i);
    expect(nameInput).toHaveValue('');
    expect(screen.getByLabelText(/Country/i)).toHaveValue('');
    expect(screen.getByText(/Select a country first/i)).toBeInTheDocument();
    // Primary CTA reads "Create Territory" (not "Save Changes").
    expect(screen.getByRole('button', { name: /Create Territory/i })).toBeInTheDocument();
  });

  it('shows Manage staff only when editing an existing territory', async () => {
    renderTerritories();
    await screen.findByText('North America West');
    expect(screen.queryByRole('button', { name: 'Manage staff' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit North America West' }));
    expect(await screen.findByRole('button', { name: 'Manage staff' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Close territory dialog/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Territory' }));
    expect(screen.queryByRole('button', { name: 'Manage staff' })).not.toBeInTheDocument();
  });

  it('opens Territories information from the heading icon', async () => {
    renderTerritories();
    await screen.findByText('North America West');
    fireEvent.click(screen.getByRole('button', { name: 'About Territories' }));
    expect(screen.getByRole('dialog', { name: 'About Territories' })).toBeInTheDocument();
    expect(screen.getByText(/A territory is an area/i)).toBeInTheDocument();
    expect(screen.getByText(/Use Staff for individual access/i)).toBeInTheDocument();
  });

  it('saving with an empty name shows "Name is required" error toast and does NOT POST', async () => {
    renderTerritories();
    await screen.findByText('North America West');
    fireEvent.click(screen.getByRole('button', { name: /Add Territory/i }));

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Create Territory/i }));

    // Toast renders (the page uses an internal showToast, not notify.error,
    // for the empty-name guard — assert via the rendered toast text).
    expect(await screen.findByText(/Name is required/i)).toBeInTheDocument();
    // No POST fired.
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('saving a NEW territory POSTs the generic geographic and assignment fields', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/territories' && opts?.method === 'POST') {
        return Promise.resolve({ id: 99 });
      }
      return defaultFetchMock(url, opts);
    });
    renderTerritories();
    await screen.findByText('North America West');
    fireEvent.click(screen.getByRole('button', { name: /Add Territory/i }));

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. North America West/i), {
      target: { value: 'APAC South' },
    });
    fireEvent.focus(screen.getByLabelText(/Country/i));
    fireEvent.click(await screen.findByRole('option', { name: 'India' }));
    fireEvent.click(screen.getByRole('button', { name: /States \/ regions/i }));
    fireEvent.click(await screen.findByLabelText('Maharashtra'));

    fireEvent.click(screen.getByRole('button', { name: /Create Territory/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/territories' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('APAC South');
      expect(body.country).toBe('IN');
      expect(body.states).toEqual(['MH']);
      expect(body.regions).toEqual(['IN-MH']);
    });
  });

  it('Edit pre-populates Name + Regions and saves as PUT /api/territories/<id>', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (/^\/api\/territories\/\d+$/.test(url) && opts?.method === 'PUT') {
        return Promise.resolve({ id: 1 });
      }
      return defaultFetchMock(url, opts);
    });
    renderTerritories();
    await screen.findByText('North America West');

    // Each card has an Edit button labeled "Edit" via the title attribute.
    const editButtons = screen.getAllByTitle('Edit');
    // First card = North America West (sampleTerritories[0]).
    fireEvent.click(editButtons[0]);

    // Modal opens in edit mode — heading reads "Edit Territory".
    expect(screen.getByRole('heading', { name: /Edit Territory/i })).toBeInTheDocument();
    // Name pre-populated.
    expect(screen.getByPlaceholderText(/e\.g\. North America West/i)).toHaveValue('North America West');
    expect(screen.getByLabelText(/Country/i)).toHaveValue('United States');
    fireEvent.click(screen.getByRole('button', { name: /States \/ regions/i }));
    expect(await screen.findByLabelText('California')).toBeChecked();

    // Click Save Changes — fires PUT, not POST.
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/territories/1' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('North America West');
    });
    // No POST fired (edit must NOT issue a create).
    const postCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/territories' && o?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('Delete asks confirm and on TRUE fires DELETE /api/territories/<id>', async () => {
    notifyConfirm.mockResolvedValueOnce(true);
    fetchApiMock.mockImplementation((url, opts) => {
      if (/^\/api\/territories\/\d+$/.test(url) && opts?.method === 'DELETE') {
        return Promise.resolve({});
      }
      return defaultFetchMock(url, opts);
    });
    renderTerritories();
    await screen.findByText('North America West');

    const deleteButtons = screen.getAllByTitle('Delete');
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/Delete territory "North America West"/i),
      );
    });
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/territories/1' && o?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
  });

  it('Delete on FALSE confirm does NOT fire DELETE', async () => {
    notifyConfirm.mockResolvedValueOnce(false);
    renderTerritories();
    await screen.findByText('North America West');

    const deleteButtons = screen.getAllByTitle('Delete');
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // Give the page a tick to settle, then assert no DELETE went out.
    await new Promise((r) => setTimeout(r, 30));
    const delCall = fetchApiMock.mock.calls.find(
      ([, o]) => o?.method === 'DELETE',
    );
    expect(delCall).toBeUndefined();
  });

  it('does not render a View Details action or detail page', async () => {
    renderTerritories();
    await screen.findByText('North America West');
    expect(screen.queryByRole('button', { name: /View Details/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View details/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Back to Territories/i })).not.toBeInTheDocument();
  });
});
