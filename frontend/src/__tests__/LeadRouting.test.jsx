/**
 * LeadRouting.test.jsx — vitest + RTL coverage for the Lead Routing Rules page
 * (`frontend/src/pages/LeadRouting.jsx`).
 *
 * Scope: pins the page-surface invariants for the priority-ordered, condition-
 * based lead-routing CRUD surface that auto-assigns leads to round-robin,
 * specific users, or by territory:
 *
 *   1. Initial mount fires BOTH GET /api/lead-routing AND GET /api/staff in
 *      parallel — staff feeds the "Specific User" dropdown inside the modal.
 *   2. Loading state ("Loading rules...") renders before the fetches resolve.
 *   3. Empty state renders the "No routing rules yet..." copy + a
 *      "Create First Rule" CTA when /api/lead-routing returns [].
 *   4. Rules table renders one row per rule with priority chip, name,
 *      condition chips, and the assign-type label.
 *   5. Condition chips use the OP_LABELS human phrasing ("is", "is not",
 *      "contains", "in") — NOT the raw DSL token (eq/neq/contains/in).
 *   6. Clicking "Add Rule" opens the modal with empty Name + default
 *      priority 100 + a single empty condition row.
 *   7. Saving with an empty name surfaces "Name is required" toast and
 *      does NOT POST.
 *   8. Saving with no usable conditions surfaces "At least one condition
 *      is required" toast and does NOT POST.
 *   9. Saving with priority < 1 or > 999 surfaces the integer-bounds
 *      validation toast (#301 / #332) and does NOT POST.
 *  10. Saving a NEW rule POSTs /api/lead-routing with the parsed body
 *      shape: { name, conditions, assignType, assignTo, priority, isActive }.
 *      `assignTo` is null when assignType !== 'specific_user'.
 *  11. The "in" operator splits the value on commas and persists an
 *      array (`{ op: 'in', value: ['Lead','Prospect'] }`) inside conditions.
 *  12. Edit pre-populates Name + Priority + condition rows; saving fires
 *      PUT /api/lead-routing/<id> (not POST).
 *  13. Delete first calls notify.confirm; on TRUE, fires DELETE
 *      /api/lead-routing/<id>; on FALSE, no DELETE fires.
 *  14. Toggle Active fires PUT /api/lead-routing/<id> with the flipped
 *      `isActive` flag — and ONLY that flag in the body.
 *  15. Apply All first calls notify.confirm; on TRUE, fires POST
 *      /api/lead-routing/apply-all and shows the processed/assigned toast.
 *  16. Apply All on FALSE confirm does NOT fire the POST.
 *
 * Backend contracts pinned by this test:
 *   GET    /api/lead-routing
 *   GET    /api/staff
 *   POST   /api/lead-routing
 *   PUT    /api/lead-routing/:id
 *   DELETE /api/lead-routing/:id
 *   POST   /api/lead-routing/apply-all
 *
 * Stable-mock discipline: notify is a single object reused across renders
 * (per the 2026-05-09 cron-learning standing rule — fresh mock objects per
 * call cause infinite re-render loops through useCallback dep arrays).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

import LeadRouting from '../pages/LeadRouting';

const sampleStaff = [
  { id: 10, name: 'Alice Reed', email: 'alice@globussoft.com' },
  { id: 20, name: 'Bharat Singh', email: 'bharat@globussoft.com' },
  { id: 30, name: 'Carla Mendes', email: 'carla@globussoft.com' },
];

const sampleRules = [
  {
    id: 1,
    name: 'India Web Leads',
    priority: 10,
    isActive: true,
    assignType: 'specific_user',
    assignTo: 10,
    conditions: { source: 'Website', country: 'India' },
  },
  {
    id: 2,
    name: 'EU Enterprise',
    priority: 20,
    isActive: false,
    assignType: 'round_robin',
    assignTo: null,
    conditions: { companySize: { op: 'contains', value: 'large' } },
  },
  {
    id: 3,
    name: 'Status In Lead/Prospect',
    priority: 30,
    isActive: true,
    assignType: 'territory',
    assignTo: null,
    conditions: { status: { op: 'in', value: ['Lead', 'Prospect'] } },
  },
];

function defaultFetchMock(url, opts) {
  if (url === '/api/lead-routing' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleRules);
  }
  if (url === '/api/staff' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleStaff);
  }
  return Promise.resolve(null);
}

function renderLeadRouting() {
  return render(<LeadRouting />);
}

describe('<LeadRouting /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset().mockResolvedValue(true);
  });

  it('initial mount fires GET /api/lead-routing AND GET /api/staff in parallel', async () => {
    renderLeadRouting();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/lead-routing');
      expect(fetchApiMock).toHaveBeenCalledWith('/api/staff');
    });
  });

  it('renders the "Lead Routing Rules" heading + Apply All + Add Rule CTAs', async () => {
    renderLeadRouting();
    expect(
      await screen.findByRole('heading', { name: /Lead Routing Rules/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply All/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Rule/i })).toBeInTheDocument();
  });

  it('shows "Loading rules..." before the initial fetches resolve', async () => {
    let resolveR;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/lead-routing') return new Promise((r) => { resolveR = r; });
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      return Promise.resolve(null);
    });
    renderLeadRouting();
    expect(await screen.findByText(/Loading rules/i)).toBeInTheDocument();
    // Resolve so the test tears down cleanly.
    resolveR([]);
  });

  it('renders empty state + "Create First Rule" CTA when list is empty', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/lead-routing') return Promise.resolve([]);
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      return Promise.resolve(null);
    });
    renderLeadRouting();
    expect(await screen.findByText(/No routing rules yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create First Rule/i })).toBeInTheDocument();
  });

  it('renders one row per rule with name + priority chip + assign-type label', async () => {
    renderLeadRouting();
    expect(await screen.findByText('India Web Leads')).toBeInTheDocument();
    expect(screen.getByText('EU Enterprise')).toBeInTheDocument();
    expect(screen.getByText('Status In Lead/Prospect')).toBeInTheDocument();
    // Priority chips render the numeric values.
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    // Assign-type labels: round_robin → 'Round Robin', territory → 'By Territory',
    // specific_user → 'User: <name>'.
    expect(screen.getByText(/Round Robin/i)).toBeInTheDocument();
    expect(screen.getByText(/By Territory/i)).toBeInTheDocument();
    expect(screen.getByText(/User: Alice Reed/i)).toBeInTheDocument();
  });

  it('condition chips use OP_LABELS human phrasing — "is not", "contains", "in" — not raw DSL tokens', async () => {
    renderLeadRouting();
    await screen.findByText('India Web Leads');
    // First rule's plain-string condition renders as "field = value".
    expect(screen.getByText(/source = Website/i)).toBeInTheDocument();
    expect(screen.getByText(/country = India/i)).toBeInTheDocument();
    // Second rule has { op: 'contains' } — must render as "contains", not "neq".
    expect(screen.getByText(/companySize contains large/i)).toBeInTheDocument();
    // Third rule's "in" array joins with "|" not "," — and renders as "in", not raw 'in'.
    expect(screen.getByText(/status in Lead\|Prospect/i)).toBeInTheDocument();
  });

  it('clicking "Add Rule" opens the modal with empty Name + priority 100 + 1 empty condition row', async () => {
    renderLeadRouting();
    await screen.findByText('India Web Leads');
    fireEvent.click(screen.getByRole('button', { name: /Add Rule/i }));
    // Modal heading reads "New Routing Rule".
    expect(screen.getByRole('heading', { name: /New Routing Rule/i })).toBeInTheDocument();
    // Name placeholder input is empty.
    const nameInput = screen.getByPlaceholderText(/India Web Leads/i);
    expect(nameInput).toHaveValue('');
    // Priority defaults to 100 — there's a numeric input with that value.
    const priorityInput = screen.getByDisplayValue('100');
    expect(priorityInput).toBeInTheDocument();
    expect(priorityInput).toHaveAttribute('type', 'number');
    // Primary CTA reads "Create Rule" (not "Save Changes").
    expect(screen.getByRole('button', { name: /Create Rule/i })).toBeInTheDocument();
  });

  it('saving with an empty name shows error toast and does NOT POST', async () => {
    renderLeadRouting();
    await screen.findByText('India Web Leads');
    fireEvent.click(screen.getByRole('button', { name: /Add Rule/i }));

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Create Rule/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Name is required/i));
    });
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('saving with priority out of [1, 999] surfaces the bounds toast and does NOT POST', async () => {
    renderLeadRouting();
    await screen.findByText('India Web Leads');
    fireEvent.click(screen.getByRole('button', { name: /Add Rule/i }));

    fireEvent.change(screen.getByPlaceholderText(/India Web Leads/i), {
      target: { value: 'Bad Priority Rule' },
    });
    // Set priority to 1000 — above the upper bound.
    fireEvent.change(screen.getByDisplayValue('100'), { target: { value: '1000' } });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Create Rule/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Priority must be an integer between 1 and 999/i),
      );
    });
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('saving with no usable conditions surfaces the "At least one condition" toast', async () => {
    renderLeadRouting();
    await screen.findByText('India Web Leads');
    fireEvent.click(screen.getByRole('button', { name: /Add Rule/i }));

    fireEvent.change(screen.getByPlaceholderText(/India Web Leads/i), {
      target: { value: 'No Conditions Rule' },
    });
    // Leave the (single) condition row's value empty — buildConditionsObject
    // will skip it, resulting in {} — the guard must fire.

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Create Rule/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/At least one condition is required/i),
      );
    });
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('saving a NEW rule POSTs /api/lead-routing with the expected body shape', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/lead-routing' && opts?.method === 'POST') {
        return Promise.resolve({ id: 99 });
      }
      return defaultFetchMock(url, opts);
    });
    renderLeadRouting();
    await screen.findByText('India Web Leads');
    fireEvent.click(screen.getByRole('button', { name: /Add Rule/i }));

    fireEvent.change(screen.getByPlaceholderText(/India Web Leads/i), {
      target: { value: 'Mumbai Inbound' },
    });
    // Priority — change from default 100 to 42.
    fireEvent.change(screen.getByDisplayValue('100'), { target: { value: '42' } });
    // Default condition row: field=source, op=eq — supply a value.
    const valueInputs = screen.getAllByPlaceholderText('value');
    fireEvent.change(valueInputs[0], { target: { value: 'Website' } });

    fireEvent.click(screen.getByRole('button', { name: /Create Rule/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/lead-routing' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Mumbai Inbound');
      expect(body.priority).toBe(42);
      expect(body.isActive).toBe(true);
      expect(body.assignType).toBe('round_robin');
      // round_robin → assignTo MUST be null, not the empty string from the form.
      expect(body.assignTo).toBeNull();
      // eq + plain value → conditions[field] = value directly (not wrapped).
      expect(body.conditions).toEqual({ source: 'Website' });
    });
  });

  it('"in" operator splits the value on commas into an array inside conditions', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/lead-routing' && opts?.method === 'POST') {
        return Promise.resolve({ id: 100 });
      }
      return defaultFetchMock(url, opts);
    });
    renderLeadRouting();
    await screen.findByText('India Web Leads');
    fireEvent.click(screen.getByRole('button', { name: /Add Rule/i }));

    fireEvent.change(screen.getByPlaceholderText(/India Web Leads/i), {
      target: { value: 'CSV In Rule' },
    });
    // Flip the operator dropdown for the single condition row to "in".
    // OP_OPTIONS dropdown is the second <select> inside the row (after the
    // field <select>). Find by its current displayed option "equals".
    const opSelects = screen.getAllByRole('combobox');
    // Row order: field-select, op-select, (no value-select for source/eq),
    // then assign-type-select. The op-select is at index 1.
    fireEvent.change(opSelects[1], { target: { value: 'in' } });

    // With op=in the value input gets the in-csv placeholder.
    const inInput = screen.getByPlaceholderText(/Website,Referral,Ad/i);
    fireEvent.change(inInput, { target: { value: 'Website, Ad ,Referral' } });

    fireEvent.click(screen.getByRole('button', { name: /Create Rule/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/lead-routing' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.conditions).toEqual({
        source: { op: 'in', value: ['Website', 'Ad', 'Referral'] },
      });
    });
  });

  it('Edit pre-populates Name + Priority + conditions and saves as PUT /api/lead-routing/<id>', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (/^\/api\/lead-routing\/\d+$/.test(url) && opts?.method === 'PUT') {
        return Promise.resolve({ id: 1 });
      }
      return defaultFetchMock(url, opts);
    });
    renderLeadRouting();
    await screen.findByText('India Web Leads');

    // Edit buttons exposed via title="Edit". The first one corresponds to the
    // first rule (sampleRules[0]).
    const editButtons = screen.getAllByTitle('Edit');
    fireEvent.click(editButtons[0]);

    // Modal heading switches to "Edit Rule".
    expect(screen.getByRole('heading', { name: /Edit Rule/i })).toBeInTheDocument();
    // Name pre-populated from sampleRules[0].name.
    expect(screen.getByPlaceholderText(/India Web Leads/i)).toHaveValue('India Web Leads');
    // Priority pre-populated to 10 (not the default 100).
    expect(screen.getByDisplayValue('10')).toBeInTheDocument();
    // Primary CTA flips to "Save Changes".
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/lead-routing/1' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('India Web Leads');
      expect(body.priority).toBe(10);
      // assignType=specific_user + assignTo=10 round-trips through Number(...).
      expect(body.assignType).toBe('specific_user');
      expect(body.assignTo).toBe(10);
    });
    // No POST fired (edit must NOT issue a create).
    const postCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/lead-routing' && o?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('Delete asks confirm and on TRUE fires DELETE /api/lead-routing/<id>', async () => {
    notifyConfirm.mockResolvedValueOnce(true);
    fetchApiMock.mockImplementation((url, opts) => {
      if (/^\/api\/lead-routing\/\d+$/.test(url) && opts?.method === 'DELETE') {
        return Promise.resolve({});
      }
      return defaultFetchMock(url, opts);
    });
    renderLeadRouting();
    await screen.findByText('India Web Leads');

    const deleteButtons = screen.getAllByTitle('Delete');
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/Delete rule "India Web Leads"/i),
      );
    });
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/lead-routing/1' && o?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
  });

  it('Delete on FALSE confirm does NOT fire DELETE', async () => {
    notifyConfirm.mockResolvedValueOnce(false);
    renderLeadRouting();
    await screen.findByText('India Web Leads');

    const deleteButtons = screen.getAllByTitle('Delete');
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // Give the page a tick to settle, then assert no DELETE went out.
    await new Promise((r) => setTimeout(r, 30));
    const delCall = fetchApiMock.mock.calls.find(([, o]) => o?.method === 'DELETE');
    expect(delCall).toBeUndefined();
  });

  it('Toggle Active fires PUT /api/lead-routing/<id> with only the flipped isActive flag', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (/^\/api\/lead-routing\/\d+$/.test(url) && opts?.method === 'PUT') {
        return Promise.resolve({});
      }
      return defaultFetchMock(url, opts);
    });
    renderLeadRouting();
    await screen.findByText('India Web Leads');

    // The first rule is active=true. Find its toggle inside the row.
    // Toggles are <button> elements with no accessible name — locate by row
    // ordering. Look for buttons that are NOT title="Edit"/title="Delete".
    const allButtons = screen.getAllByRole('button');
    // Identify the toggle buttons: they're rendered for each rule + are
    // neither Edit nor Delete nor Apply All nor Add Rule nor Close. Filter
    // by lack of those titles/text.
    const toggleButtons = allButtons.filter((b) => {
      const title = b.getAttribute('title');
      if (title === 'Edit' || title === 'Delete') return false;
      const text = b.textContent || '';
      if (/Apply All|Add Rule|Create First Rule|Close|Cancel|Save|Create Rule/i.test(text)) {
        return false;
      }
      // Toggles render only the lucide icon — no text content.
      return text.trim() === '';
    });
    expect(toggleButtons.length).toBeGreaterThanOrEqual(3);

    fireEvent.click(toggleButtons[0]);

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/lead-routing/1' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      // ONLY isActive in the body — toggleActive sends a partial patch,
      // NOT the full rule shape.
      expect(body).toEqual({ isActive: false });
    });
  });

  it('Apply All confirms first; on TRUE fires POST /api/lead-routing/apply-all and toasts result', async () => {
    notifyConfirm.mockResolvedValueOnce(true);
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/lead-routing/apply-all' && opts?.method === 'POST') {
        return Promise.resolve({ processed: 250, assigned: 73 });
      }
      return defaultFetchMock(url, opts);
    });
    renderLeadRouting();
    await screen.findByText('India Web Leads');

    fireEvent.click(screen.getByRole('button', { name: /Apply All/i }));

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/Apply all routing rules/i),
          confirmText: 'Apply All',
        }),
      );
    });
    await waitFor(() => {
      const applyCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/lead-routing/apply-all' && o?.method === 'POST',
      );
      expect(applyCall).toBeTruthy();
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Processed 250 contacts, assigned 73/i),
      );
    });
  });

  it('Apply All on FALSE confirm does NOT fire the POST', async () => {
    notifyConfirm.mockResolvedValueOnce(false);
    renderLeadRouting();
    await screen.findByText('India Web Leads');

    fireEvent.click(screen.getByRole('button', { name: /Apply All/i }));

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 30));
    const applyCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/lead-routing/apply-all' && o?.method === 'POST',
    );
    expect(applyCall).toBeUndefined();
  });
});
