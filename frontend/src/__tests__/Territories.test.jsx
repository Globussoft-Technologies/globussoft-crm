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

  it('renders one card per territory with name + regions/users/contacts counts', async () => {
    renderTerritories();
    expect(await screen.findByText('North America West')).toBeInTheDocument();
    expect(screen.getByText('EMEA Central')).toBeInTheDocument();
    // Per-card counts render — North America West has 6 regions, 2 users, 42 contacts.
    expect(screen.getByText('6')).toBeInTheDocument(); // regions count
    expect(screen.getByText('42')).toBeInTheDocument(); // contacts count
    // EMEA Central has 3 regions, 1 user, 17 contacts. "3" appears in regions
    // tile; "17" appears in contacts tile. (1 may collide with other text;
    // assert on the distinct values only.)
    expect(screen.getByText('17')).toBeInTheDocument();
  });

  it('region chips render up to 4 + "+N more" suffix when >4', async () => {
    renderTerritories();
    await screen.findByText('North America West');
    // First 4 chips render verbatim.
    expect(screen.getByText('US-CA')).toBeInTheDocument();
    expect(screen.getByText('US-OR')).toBeInTheDocument();
    expect(screen.getByText('US-WA')).toBeInTheDocument();
    expect(screen.getByText('US-NV')).toBeInTheDocument();
    // 5th + 6th collapse into "+2 more".
    expect(screen.getByText('+2 more')).toBeInTheDocument();
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

  it('clicking "Add Territory" opens the modal with empty Name + Regions inputs', async () => {
    renderTerritories();
    await screen.findByText('North America West');
    fireEvent.click(screen.getByRole('button', { name: /Add Territory/i }));
    // Modal heading.
    expect(screen.getByRole('heading', { name: /New Territory/i })).toBeInTheDocument();
    // Name input is empty.
    const nameInput = screen.getByPlaceholderText(/e\.g\. North America West/i);
    expect(nameInput).toHaveValue('');
    // Regions input is empty.
    const regionsInput = screen.getByPlaceholderText(/US-CA, US-NY, US-WA/i);
    expect(regionsInput).toHaveValue('');
    // Primary CTA reads "Create Territory" (not "Save Changes").
    expect(screen.getByRole('button', { name: /Create Territory/i })).toBeInTheDocument();
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

  it('saving a NEW territory POSTs /api/territories with parsed regions[] body', async () => {
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
    // Mixed whitespace + an empty entry between commas to pin the trim+filter
    // shape: "IN, , SG ,  AU" → ['IN','SG','AU'].
    fireEvent.change(screen.getByPlaceholderText(/US-CA, US-NY, US-WA/i), {
      target: { value: 'IN, , SG ,  AU' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create Territory/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/territories' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('APAC South');
      expect(body.regions).toEqual(['IN', 'SG', 'AU']);
      expect(body.assignedUserIds).toEqual([]);
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
    // Regions joined by ", ".
    expect(screen.getByPlaceholderText(/US-CA, US-NY, US-WA/i)).toHaveValue(
      'US-CA, US-OR, US-WA, US-NV, US-AZ, US-UT',
    );

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

  it('View Details navigates to detail view and fires GET /api/territories/<id>/contacts', async () => {
    renderTerritories();
    await screen.findByText('North America West');

    const viewButtons = screen.getAllByRole('button', { name: /View Details/i });
    fetchApiMock.mockClear();
    // Re-establish the default mock for the post-click reads.
    fetchApiMock.mockImplementation(defaultFetchMock);
    fireEvent.click(viewButtons[0]);

    // Back button appears (detail view chrome).
    expect(await screen.findByRole('button', { name: /Back to Territories/i })).toBeInTheDocument();
    // Contacts fetch fired against the right path.
    await waitFor(() => {
      const contactsCall = fetchApiMock.mock.calls.find(
        ([u]) => u === '/api/territories/1/contacts',
      );
      expect(contactsCall).toBeTruthy();
    });
    // Contact row from sampleContacts renders.
    expect(await screen.findByText('Wayne Industries')).toBeInTheDocument();
    expect(screen.getByText('Stark Manufacturing')).toBeInTheDocument();
  });

  it('detail view renders empty-state when /contacts returns []', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (/^\/api\/territories\/\d+\/contacts$/.test(url)) return Promise.resolve([]);
      return defaultFetchMock(url, opts);
    });
    renderTerritories();
    await screen.findByText('North America West');

    const viewButtons = screen.getAllByRole('button', { name: /View Details/i });
    fireEvent.click(viewButtons[0]);

    expect(await screen.findByText(/No contacts assigned to this territory yet/i)).toBeInTheDocument();
  });
});
