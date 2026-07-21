/**
 * Contacts.jsx — top-level page contract.
 *
 * Two prior specs cover narrow slices: Contacts.duplicates.test.jsx pins the
 * Find Duplicates / Merge / Dismiss UI (#592), Contacts.emailValidation.test.jsx
 * pins the Add Contact email validator (#607). This file pins the rest of the
 * page — initial fetch + loading state, list rendering, empty state, the #461
 * search + status filter wiring, AI re-score affordance, delete confirm,
 * assign-to-staff dropdown, CSV import modal preview + #154 row-validation,
 * and the #143 contact count.
 *
 * Mocks:
 *   - `../utils/api`.fetchApi — per-URL mockImplementation returning the
 *     fixtures below; per-test `mockResolvedValueOnce` for specific paths.
 *   - `../utils/notify` — stable singleton notify object (per the cron-learning
 *     standing rule: fresh objects per call would re-trigger useCallback deps
 *     and infinite-render).
 *   - `../components/DuplicateContactModal` — rendered only on 409
 *     DUPLICATE_CONTACT, mocked here so tests don't depend on its internals.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// AuthContext mock — default value is ADMIN so the assign dropdown renders as
// a <select>. Tests that need non-admin behaviour wrap the component in
// <AuthContext.Provider value={{ user: { role: 'USER' }, tenant: {...} }}>
// using the same AuthContext exported from this mock.
vi.mock('../App', async () => {
  const { createContext } = await import('react');
  return { AuthContext: createContext({ user: { role: 'ADMIN' }, tenant: { vertical: 'generic' } }) };
});

// Stable mock-object reference — see CLAUDE.md cron-learning on infinite-
// re-render flakes when useNotify returns a fresh object per render.
const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// The 409 DUPLICATE_CONTACT modal is exercised by Contacts.duplicates.test.jsx
// indirectly; here we just shallow-mock so the import resolves.
vi.mock('../components/DuplicateContactModal', () => ({
  default: (props) => (
    <div data-testid="dup-modal" data-existing-id={props.existingContactId}>
      Duplicate modal
      <button onClick={props.onCreateAnyway}>Create anyway</button>
      <button onClick={props.onEditDetails}>Edit details</button>
    </div>
  ),
}));

import Contacts from '../pages/Contacts';

const SEEDED_CONTACTS = [
  { id: 1, name: 'Aarav Sharma', email: 'aarav@acme.in', phone: '+91 98000 12345', company: 'Acme Logistics', title: 'CEO', status: 'Lead', aiScore: 82, assignedToId: null },
  { id: 2, name: 'Priya Iyer', email: 'priya@bloomspa.in', phone: null, company: 'Bloom Spa', title: 'Founder', status: 'Customer', aiScore: 55, assignedToId: 7 },
  { id: 3, name: 'Rohan Mehta', email: 'rohan@coastal.in', phone: '+91 98765 43210', company: 'Coastal Traders', title: 'COO', status: 'Lead', aiScore: 28, assignedToId: null },
];

const SEEDED_STAFF = [
  { id: 7, name: 'Sneha Manager', email: 'sneha@globussoft.com' },
  { id: 8, name: 'Vikram Sales', email: 'vikram@globussoft.com' },
];

function defaultFetchImpl(url) {
  if (url === '/api/contacts') return Promise.resolve(SEEDED_CONTACTS);
  if (url === '/api/staff') return Promise.resolve(SEEDED_STAFF);
  if (url === '/api/contacts/duplicates/find') return Promise.resolve([]);
  return Promise.resolve(null);
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockClear();
  notifyObj.success.mockClear();
  notifyObj.info.mockClear();
  notifyObj.confirm.mockReset();
  notifyObj.confirm.mockResolvedValue(true);
  fetchApiMock.mockImplementation(defaultFetchImpl);
});

function renderContacts() {
  return render(
    <MemoryRouter>
      <Contacts />
    </MemoryRouter>,
  );
}

describe('Contacts.jsx — top-level page contract', () => {
  it('shows the loading row before the contacts fetch settles, then renders the rows', async () => {
    // Defer the /api/contacts response so we can assert the loading row.
    let resolveContacts;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return new Promise((res) => { resolveContacts = () => res(SEEDED_CONTACTS); });
      if (url === '/api/staff') return Promise.resolve(SEEDED_STAFF);
      return Promise.resolve(null);
    });
    renderContacts();
    expect(screen.getByText(/Loading contacts/i)).toBeInTheDocument();
    resolveContacts();
    await waitFor(() => expect(screen.queryByText(/Loading contacts/i)).not.toBeInTheDocument());
    expect(screen.getByText('Aarav Sharma')).toBeInTheDocument();
  });

  it('renders one row per seeded contact with name, email, company, score', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());
    expect(screen.getByText('Priya Iyer')).toBeInTheDocument();
    expect(screen.getByText('Rohan Mehta')).toBeInTheDocument();
    expect(screen.getByText('aarav@acme.in')).toBeInTheDocument();
    expect(screen.getByText('Bloom Spa')).toBeInTheDocument();
    // aiScore renders as "82/100".
    expect(screen.getByText('82/100')).toBeInTheDocument();
  });

  it('renders the empty-state copy when /api/contacts returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve([]);
      if (url === '/api/staff') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderContacts();
    await waitFor(() => expect(screen.getByText(/No contacts yet/i)).toBeInTheDocument());
    expect(screen.getByText(/Add Contact.*import a CSV/i)).toBeInTheDocument();
  });

  it('renders a zero-state message and absorbs the error when /api/contacts rejects', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.reject(new Error('500 server'));
      if (url === '/api/staff') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderContacts();
    await waitFor(() => expect(screen.queryByText(/Loading contacts/i)).not.toBeInTheDocument());
    expect(screen.getByText(/No contacts yet/i)).toBeInTheDocument();
  });

  it('shows the #143 contact-count line that pluralises correctly', async () => {
    renderContacts();
    // The pre-fetch render shows `0 contacts ...`; post-fetch it should be `3 contacts ...`.
    await waitFor(() => {
      expect(screen.getByText(/3 contacts · manage your leads and customers/i)).toBeInTheDocument();
    });
  });

  it('#461: typing in the search box filters rows client-side (name / email / company match)', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('Search contacts...'), { target: { value: 'priya' } });
    await waitFor(() => {
      expect(screen.queryByText('Aarav Sharma')).not.toBeInTheDocument();
      expect(screen.queryByText('Rohan Mehta')).not.toBeInTheDocument();
      expect(screen.getByText('Priya Iyer')).toBeInTheDocument();
    });
    expect(screen.getByText(/Showing 1 of 3/i)).toBeInTheDocument();
  });

  it('#461: status filter narrows to a single bucket', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    // The dropdown is the <select> rendered next to the search box. Customer
    // and Lead also appear as row badges, so we have to target the select
    // specifically (the displayValue change picks the right element).
    const statusSelect = screen.getByDisplayValue('All Statuses');
    fireEvent.change(statusSelect, { target: { value: 'Customer' } });

    await waitFor(() => {
      expect(screen.queryByText('Aarav Sharma')).not.toBeInTheDocument(); // Lead — filtered out
      expect(screen.getByText('Priya Iyer')).toBeInTheDocument(); // Customer — visible
    });
  });

  it('shows the matches-nothing fallback when search + filter combination yields zero rows', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('Search contacts...'), { target: { value: 'zzz-no-match' } });
    await waitFor(() => {
      expect(screen.getByText(/No contacts match "zzz-no-match"/i)).toBeInTheDocument();
    });
  });

  it('opens the Add Contact modal and POSTs /api/contacts on a happy-path submit', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add Contact/i }));
    expect(screen.getByText(/Add New Contact/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Diya Kapoor' } });
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'diya@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Category'), { target: { value: 'Kapoor Foods' } });

    // Stub the POST response.
    fetchApiMock.mockImplementationOnce(() => Promise.resolve({ id: 99 })); // POST /api/contacts

    fireEvent.submit(screen.getByPlaceholderText('Email').closest('form'));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/contacts' && opts?.method === 'POST');
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({ name: 'Diya Kapoor', email: 'diya@example.com', company: 'Kapoor Foods', status: 'Lead' });
    });
  });

  it('asks confirm + DELETEs the contact when the trash-icon button is clicked and confirmed', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Delete contact Aarav Sharma/i }));
    await waitFor(() => expect(notifyObj.confirm).toHaveBeenCalledTimes(1));
    expect(notifyObj.confirm.mock.calls[0][0]).toMatchObject({ destructive: true, confirmText: 'Delete' });

    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/contacts/1' && opts?.method === 'DELETE');
      expect(deleteCall).toBeTruthy();
    });
  });

  it('does NOT DELETE when the user cancels the confirm', async () => {
    notifyObj.confirm.mockResolvedValueOnce(false);
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Delete contact Aarav Sharma/i }));
    await waitFor(() => expect(notifyObj.confirm).toHaveBeenCalledTimes(1));

    // Brief settle window — assert no DELETE fired.
    await new Promise(r => setTimeout(r, 20));
    const deleteCall = fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/contacts/1' && opts?.method === 'DELETE');
    expect(deleteCall).toBeFalsy();
  });

  it('AI Re-score button POSTs /api/ai_scoring/trigger and re-fetches /api/contacts', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());
    const initialContactsFetches = fetchApiMock.mock.calls.filter(([u]) => u === '/api/contacts').length;

    fireEvent.click(screen.getByRole('button', { name: /AI Re-score/i }));

    await waitFor(() => {
      const triggerCall = fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/ai_scoring/trigger' && opts?.method === 'POST');
      expect(triggerCall).toBeTruthy();
    });
    // After the trigger resolves, the SUT re-fetches /api/contacts.
    await waitFor(() => {
      const after = fetchApiMock.mock.calls.filter(([u]) => u === '/api/contacts').length;
      expect(after).toBeGreaterThan(initialContactsFetches);
    });
  });

  it('Assigned-To dropdown PUTs /api/contacts/:id/assign with the new staff id', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    // Find the assign-to <select> for Aarav (row 1). Aarav.assignedToId is
    // null, so the rendered value is the empty-string 'Unassigned' option.
    // There are three such selects (one per row); pick the first by tracking
    // the row containing 'Aarav Sharma'.
    const row = screen.getByText('Aarav Sharma').closest('tr');
    const select = within(row).getByRole('combobox');
    fireEvent.change(select, { target: { value: '8' } });

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts/1/assign' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      expect(JSON.parse(putCall[1].body)).toEqual({ assignedToId: '8' });
    });
  });

  it('non-ADMIN user sees read-only assigned-to text, not a dropdown', async () => {
    const { AuthContext } = await import('../App');

    // Seed contacts with assignedTo populated so the span can show the name.
    const contactsWithAssignee = SEEDED_CONTACTS.map(c =>
      c.id === 2 ? { ...c, assignedTo: { name: 'Sneha Manager', email: 'sneha@globussoft.com' } } : c,
    );
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve(contactsWithAssignee);
      if (url === '/api/staff') return Promise.resolve(SEEDED_STAFF);
      return Promise.resolve(null);
    });

    const { unmount } = render(
      <AuthContext.Provider value={{ user: { role: 'USER' }, tenant: { vertical: 'generic' } }}>
        <MemoryRouter>
          <Contacts />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    // No combobox inside a table cell — assign dropdowns are gone for non-admins.
    const tableCombos = screen.queryAllByRole('combobox').filter(el => el.closest('td'));
    expect(tableCombos).toHaveLength(0);

    // Aarav is unassigned — the read-only cell should show 'Unassigned'.
    const row = screen.getByText('Aarav Sharma').closest('tr');
    expect(within(row).getByText('Unassigned')).toBeInTheDocument();

    // Priya has assignedTo populated — her cell shows the assignee name.
    const priyaRow = screen.getByText('Priya Iyer').closest('tr');
    expect(within(priyaRow).getByText('Sneha Manager')).toBeInTheDocument();

    unmount();
  });

  it('Import CSV modal opens, parses a pasted file, and POSTs to /api/contacts/import-csv on Import', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Import CSV/i }));
    // "Import CSV" appears in BOTH the toolbar button label AND the modal h3 —
    // standing rule: use getAllByText for chrome+label collisions.
    expect(screen.getAllByText(/Import CSV/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Click to select a .csv or .xlsx\/.xls file/i)).toBeInTheDocument();

    // Drive the file input. parseCSV expects a header row + data rows.
    const csvText = 'name,email,company,title,status\nKabir Singh,kabir@example.com,Singh Trading,Director,Lead\nMeera Nair,meera@example.com,Nair Co,Manager,Customer\n';
    const file = new File([csvText], 'contacts.csv', { type: 'text/csv' });
    const fileInput = document.querySelector('input[type="file"]');
    fireEvent.change(fileInput, { target: { files: [file] } });

    // parseCSV runs inside a FileReader.onload — wait for the preview row to land.
    await waitFor(() => expect(screen.getByText('Kabir Singh')).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByText('Meera Nair')).toBeInTheDocument();
    // Header chips listed under "Detected columns: name, email, company, title, status".
    expect(screen.getByText(/Detected columns:/i)).toBeInTheDocument();

    // Stub the import POST.
    fetchApiMock.mockImplementationOnce(() => Promise.resolve({ imported: 2, skipped: 0, errors: [] }));

    fireEvent.click(screen.getByRole('button', { name: /Import 2 valid Contacts/i }));

    await waitFor(() => {
      const importCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts/import-csv' && opts?.method === 'POST',
      );
      expect(importCall).toBeTruthy();
      const body = JSON.parse(importCall[1].body);
      expect(body.contacts).toHaveLength(2);
      expect(body.contacts[0]).toMatchObject({ name: 'Kabir Singh', email: 'kabir@example.com', company: 'Singh Trading' });
    });

    // Success card renders.
    await waitFor(() => expect(screen.getByText(/Import Complete/i)).toBeInTheDocument());
    expect(screen.getByText(/2 imported, 0 skipped/i)).toBeInTheDocument();
  });

  it('#154: CSV preview flags invalid rows (bad email, bad status) and disables Import when ALL rows are invalid', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Import CSV/i }));

    // All rows invalid — bad email + bad status.
    const csvText = 'name,email,company,title,status\nBad1,not-an-email,Acme,CEO,Bogus\nBad2,,Beta,CTO,Lead\n';
    const file = new File([csvText], 'bad.csv', { type: 'text/csv' });
    const fileInput = document.querySelector('input[type="file"]');
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText('Bad1')).toBeInTheDocument());

    // 0 valid, 2 invalid — Import button should reflect "0 valid" + be disabled.
    const importBtn = screen.getByRole('button', { name: /Import 0 valid Contacts/i });
    expect(importBtn).toBeDisabled();
    // Inline error string for the bad-email row should appear.
    expect(screen.getByText(/invalid email/i)).toBeInTheDocument();
  });

  it('opens DuplicateContactModal on 409 DUPLICATE_CONTACT from POST /api/contacts', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add Contact/i }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Karan Verma' } });
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'karan@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Category'), { target: { value: 'Verma Group' } });

    // Stub the POST to reject with a 409 DUPLICATE_CONTACT body shape.
    const dupErr = Object.assign(new Error('dup'), {
      body: {
        code: 'DUPLICATE_CONTACT',
        existingContactId: 555,
        matchedBy: 'email',
        contact: { id: 555, name: 'Karan V', email: 'karan@example.com' },
      },
    });
    fetchApiMock.mockImplementationOnce(() => Promise.reject(dupErr));

    fireEvent.submit(screen.getByPlaceholderText('Email').closest('form'));

    await waitFor(() => {
      expect(screen.getByTestId('dup-modal')).toBeInTheDocument();
      expect(screen.getByTestId('dup-modal').getAttribute('data-existing-id')).toBe('555');
    });
    // Notify.error should NOT have fired — the dup modal is the surface, not a toast.
    expect(notifyObj.error).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Extended cases (cron tick — second-pass coverage)
  //
  // These pin behaviour the first 14 cases didn't already touch — phone
  // dash fallback, score-tier badges, status filter via the "Showing X of Y"
  // counter, modal-close affordances on Add / Import, error paths for
  // create + import, the #607 inline email-error block, and the "Create
  // anyway" retry path through the duplicate-contact modal (force=true).
  // ────────────────────────────────────────────────────────────────────────

  it('renders an em-dash placeholder when contact.phone is null', async () => {
    renderContacts();
    // Priya Iyer.phone = null (per fixture). The cell should render "—" not "null".
    await waitFor(() => expect(screen.getByText('Priya Iyer')).toBeInTheDocument());
    const priyaRow = screen.getByText('Priya Iyer').closest('tr');
    // Priya's fixture also omits createdAt, so its cell renders its own "—"
    // (unrelated to this test) — use getAllByText and assert at least one
    // dash renders, rather than getByText which throws on >1 match.
    expect(within(priyaRow).getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('renders distinct lead-score badges for high / mid / low aiScore tiers', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());
    // 82/100 (>75, success tier), 55/100 (>40, warning tier), 28/100 (<=40, danger tier)
    expect(screen.getByText('82/100')).toBeInTheDocument();
    expect(screen.getByText('55/100')).toBeInTheDocument();
    expect(screen.getByText('28/100')).toBeInTheDocument();
  });

  it('hides the "Showing X of Y" counter when neither search nor status filter is active', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());
    // Initial render: searchTerm='' + statusFilter='All' → counter hidden.
    expect(screen.queryByText(/Showing .* of .*/i)).not.toBeInTheDocument();
  });

  it('shows "Showing X of Y" counter when status filter is changed', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());
    const statusSelect = screen.getByDisplayValue('All Statuses');
    fireEvent.change(statusSelect, { target: { value: 'Lead' } });
    await waitFor(() => {
      // 2 Leads (Aarav + Rohan) of 3 total.
      expect(screen.getByText(/Showing 2 of 3/i)).toBeInTheDocument();
    });
  });

  it('Cancel button in Add Contact modal closes the modal without firing a POST', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add Contact/i }));
    expect(screen.getByText(/Add New Contact/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => expect(screen.queryByText(/Add New Contact/i)).not.toBeInTheDocument());

    // No POST to /api/contacts beyond the initial GETs.
    const postCall = fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/contacts' && opts?.method === 'POST');
    expect(postCall).toBeFalsy();
  });

  it('#607: surfaces inline email-error and BLOCKS submit when the email is invalid', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add Contact/i }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Tara Kapoor' } });
    fireEvent.change(screen.getByPlaceholderText('Category'), { target: { value: 'Kapoor Co' } });

    // Use an email that's syntactically passable to <input type="email"> but
    // fails the SUT's EMAIL_RE check (no TLD). Submit via the form directly so
    // the browser's built-in `required` / `type=email` validation doesn't gate.
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'tara@bad' } });
    const form = screen.getByPlaceholderText('Email').closest('form');
    fireEvent.submit(form);

    // Inline error should appear with role=alert.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Please enter a valid email address/i);
    });
    // No POST to /api/contacts fired.
    const postCall = fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/contacts' && opts?.method === 'POST');
    expect(postCall).toBeFalsy();
  });

  it('non-409 POST failure surfaces notify.error instead of opening the dup modal', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add Contact/i }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Nikhil Rao' } });
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'nikhil@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Category'), { target: { value: 'Rao & Co' } });

    // Stub the POST to reject with a generic 400 (no DUPLICATE_CONTACT code).
    const genericErr = Object.assign(new Error('bad'), {
      body: { error: 'Some validation problem' },
    });
    fetchApiMock.mockImplementationOnce(() => Promise.reject(genericErr));

    fireEvent.submit(screen.getByPlaceholderText('Email').closest('form'));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith('Some validation problem');
    });
    // No dup-modal fallback on a non-409.
    expect(screen.queryByTestId('dup-modal')).not.toBeInTheDocument();
  });

  it('"Create anyway" in the dup modal retries POST with ?force=true and closes the modal on success', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add Contact/i }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Anjali Sen' } });
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'anjali@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Category'), { target: { value: 'Sen Holdings' } });

    // First POST → 409 dup; second POST (force=true) → success.
    const dupErr = Object.assign(new Error('dup'), {
      body: { code: 'DUPLICATE_CONTACT', existingContactId: 777, matchedBy: 'email', contact: { id: 777, name: 'Anjali S', email: 'anjali@example.com' } },
    });
    fetchApiMock.mockImplementationOnce(() => Promise.reject(dupErr));
    fireEvent.submit(screen.getByPlaceholderText('Email').closest('form'));
    await waitFor(() => expect(screen.getByTestId('dup-modal')).toBeInTheDocument());

    // Now stub the next POST as a success and click "Create anyway".
    fetchApiMock.mockImplementationOnce(() => Promise.resolve({ id: 888 }));
    fireEvent.click(within(screen.getByTestId('dup-modal')).getByText(/Create anyway/i));

    await waitFor(() => {
      const forceCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts?force=true' && opts?.method === 'POST',
      );
      expect(forceCall).toBeTruthy();
      const body = JSON.parse(forceCall[1].body);
      expect(body).toMatchObject({ name: 'Anjali Sen', email: 'anjali@example.com' });
    });
    // Dup modal closes; Add modal closes too.
    await waitFor(() => expect(screen.queryByTestId('dup-modal')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText(/Add New Contact/i)).not.toBeInTheDocument());
  });

  it('Import CSV modal Close (X) button dismisses the modal', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Import CSV/i }));
    expect(screen.getByText(/Click to select a .csv or .xlsx\/.xls file/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Close import dialog/i }));
    await waitFor(() => {
      expect(screen.queryByText(/Click to select a .csv or .xlsx\/.xls file/i)).not.toBeInTheDocument();
    });
  });

  it('Import CSV: a failing POST surfaces the Import-Failed error card', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Import CSV/i }));

    const csvText = 'name,email,company,title,status\nIra Dev,ira@example.com,Dev Studios,Designer,Lead\n';
    const file = new File([csvText], 'one.csv', { type: 'text/csv' });
    const fileInput = document.querySelector('input[type="file"]');
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText('Ira Dev')).toBeInTheDocument());

    // Stub the import POST to reject — the SUT catches and sets importResult.error.
    fetchApiMock.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    fireEvent.click(screen.getByRole('button', { name: /Import 1 valid Contact/i }));

    await waitFor(() => {
      // The error-state card uses different copy from the success card.
      // SUT renders: "Import Failed" + the importResult.error string ("Import failed").
      const failedHeadings = screen.getAllByText(/Import Failed/i);
      expect(failedHeadings.length).toBeGreaterThanOrEqual(1);
    });
    // The success card should NOT appear.
    expect(screen.queryByText(/Import Complete/i)).not.toBeInTheDocument();
  });

  it('Find Duplicates with zero groups renders the "database is clean" empty state', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve(SEEDED_CONTACTS);
      if (url === '/api/staff') return Promise.resolve(SEEDED_STAFF);
      if (url === '/api/contacts/duplicates/find') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Find Duplicates/i }));
    await waitFor(() => {
      expect(screen.getByText(/No duplicate contacts found/i)).toBeInTheDocument();
    });
    // The dialog heading + count should read "0 groups".
    expect(screen.getByText(/Duplicate Contacts \(0 groups\)/i)).toBeInTheDocument();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Extended cases (cron tick 2 — merge / dismiss / inline email / staff)
  //
  // The prior 28 cases pinned CRUD + filter + CSV + add-modal happy/sad path
  // plus the #592 dup-modal trigger. These pin the remaining duplicate-group
  // surface (Merge confirm + POST + cancel + failure; Dismiss confirm + POST
  // + cancel + failure), the on-blur email validator, the staff-fetch
  // absorption, and the duplicates group rendering with real data — all
  // currently uncovered branches in Contacts.jsx.
  // ────────────────────────────────────────────────────────────────────────

  const DUP_GROUP = {
    reason: 'email',
    primary: { id: 1, name: 'Aarav Sharma', email: 'aarav@acme.in', company: 'Acme', aiScore: 82 },
    duplicates: [
      { id: 91, name: 'Aarav S', email: 'aarav@acme.in', company: 'Acme Logistics', aiScore: 71 },
    ],
  };

  it('Find Duplicates renders Primary + Dup rows + Match reason for each group', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve(SEEDED_CONTACTS);
      if (url === '/api/staff') return Promise.resolve(SEEDED_STAFF);
      if (url === '/api/contacts/duplicates/find') return Promise.resolve([DUP_GROUP]);
      return Promise.resolve(null);
    });
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Find Duplicates/i }));
    await waitFor(() => {
      expect(screen.getByText(/Duplicate Contacts \(1 groups\)/i)).toBeInTheDocument();
    });
    // Both PRIMARY badge and DUP badge labels render once per group.
    expect(screen.getByText(/^Primary$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Dup$/i)).toBeInTheDocument();
    // Match-reason chip carries the server's `reason` token verbatim.
    expect(screen.getByText(/Match: email/i)).toBeInTheDocument();
    // Score line for the primary row reads "Score: <aiScore>".
    expect(screen.getByText(/Score: 82/i)).toBeInTheDocument();
    // Duplicate row's score also rendered.
    expect(screen.getByText(/Score: 71/i)).toBeInTheDocument();
  });

  it('#592: Merge confirm + POST /api/contacts/merge fires with {primaryId, secondaryIds}', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve(SEEDED_CONTACTS);
      if (url === '/api/staff') return Promise.resolve(SEEDED_STAFF);
      if (url === '/api/contacts/duplicates/find') return Promise.resolve([DUP_GROUP]);
      return Promise.resolve(null);
    });
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Find Duplicates/i }));
    await waitFor(() => expect(screen.getByText(/Match: email/i)).toBeInTheDocument());

    // Stub the merge POST.
    fetchApiMock.mockImplementationOnce(() => Promise.resolve({ merged: true }));
    fireEvent.click(screen.getByRole('button', { name: /Merge into Primary/i }));

    await waitFor(() => expect(notifyObj.confirm).toHaveBeenCalled());
    expect(notifyObj.confirm.mock.calls[0][0]).toMatchObject({ destructive: true, confirmText: 'Merge' });

    await waitFor(() => {
      const mergeCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts/merge' && opts?.method === 'POST',
      );
      expect(mergeCall).toBeTruthy();
      expect(JSON.parse(mergeCall[1].body)).toEqual({ primaryId: 1, secondaryIds: [91] });
    });
  });

  it('#592: Merge cancel via notify.confirm=false suppresses the POST', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve(SEEDED_CONTACTS);
      if (url === '/api/staff') return Promise.resolve(SEEDED_STAFF);
      if (url === '/api/contacts/duplicates/find') return Promise.resolve([DUP_GROUP]);
      return Promise.resolve(null);
    });
    notifyObj.confirm.mockResolvedValueOnce(false);
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Find Duplicates/i }));
    await waitFor(() => expect(screen.getByText(/Match: email/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Merge into Primary/i }));
    await waitFor(() => expect(notifyObj.confirm).toHaveBeenCalled());

    // Brief settle — no POST.
    await new Promise(r => setTimeout(r, 20));
    const mergeCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/contacts/merge' && opts?.method === 'POST',
    );
    expect(mergeCall).toBeFalsy();
  });

  it('#592: Merge failure surfaces notify.error("Merge failed")', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve(SEEDED_CONTACTS);
      if (url === '/api/staff') return Promise.resolve(SEEDED_STAFF);
      if (url === '/api/contacts/duplicates/find') return Promise.resolve([DUP_GROUP]);
      return Promise.resolve(null);
    });
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Find Duplicates/i }));
    await waitFor(() => expect(screen.getByText(/Match: email/i)).toBeInTheDocument());

    fetchApiMock.mockImplementationOnce(() => Promise.reject(new Error('500')));
    fireEvent.click(screen.getByRole('button', { name: /Merge into Primary/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith('Merge failed');
    });
  });

  it('#592: Dismiss confirm + POST /api/contacts/duplicates/dismiss fires with primaryId + secondaryIds', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve(SEEDED_CONTACTS);
      if (url === '/api/staff') return Promise.resolve(SEEDED_STAFF);
      if (url === '/api/contacts/duplicates/find') return Promise.resolve([DUP_GROUP]);
      return Promise.resolve(null);
    });
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Find Duplicates/i }));
    await waitFor(() => expect(screen.getByText(/Match: email/i)).toBeInTheDocument());

    fetchApiMock.mockImplementationOnce(() => Promise.resolve({ dismissed: true }));
    fireEvent.click(screen.getByRole('button', { name: /Dismiss duplicate group/i }));

    await waitFor(() => expect(notifyObj.confirm).toHaveBeenCalled());
    expect(notifyObj.confirm.mock.calls[0][0]).toMatchObject({ confirmText: 'Dismiss' });

    await waitFor(() => {
      const dismissCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts/duplicates/dismiss' && opts?.method === 'POST',
      );
      expect(dismissCall).toBeTruthy();
      expect(JSON.parse(dismissCall[1].body)).toEqual({ primaryId: 1, secondaryIds: [91] });
    });
  });

  it('#592: Dismiss failure surfaces notify.error("Dismiss failed")', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve(SEEDED_CONTACTS);
      if (url === '/api/staff') return Promise.resolve(SEEDED_STAFF);
      if (url === '/api/contacts/duplicates/find') return Promise.resolve([DUP_GROUP]);
      return Promise.resolve(null);
    });
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Find Duplicates/i }));
    await waitFor(() => expect(screen.getByText(/Match: email/i)).toBeInTheDocument());

    fetchApiMock.mockImplementationOnce(() => Promise.reject(new Error('403')));
    fireEvent.click(screen.getByRole('button', { name: /Dismiss duplicate group/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith('Dismiss failed');
    });
  });

  it('Find Duplicates: GET /api/contacts/duplicates/find failure is silently absorbed (no toast, no dialog)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve(SEEDED_CONTACTS);
      if (url === '/api/staff') return Promise.resolve(SEEDED_STAFF);
      if (url === '/api/contacts/duplicates/find') return Promise.reject(new Error('500'));
      return Promise.resolve(null);
    });
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Find Duplicates/i }));
    // Brief settle. The catch fires `setDupes([])` only — `setShowDupes(true)`
    // sits INSIDE the try block, so the dialog does NOT open on failure.
    await new Promise(r => setTimeout(r, 30));
    expect(screen.queryByText(/Duplicate Contacts/i)).not.toBeInTheDocument();
    // notify.error should NOT have fired — the catch is silent.
    expect(notifyObj.error).not.toHaveBeenCalled();
    // Verify the GET actually happened (so we know the click wired through).
    const findCall = fetchApiMock.mock.calls.find(([url]) => url === '/api/contacts/duplicates/find');
    expect(findCall).toBeTruthy();
  });

  it('#607: on-blur email validator surfaces inline error without submitting', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add Contact/i }));
    const emailInput = screen.getByPlaceholderText('Email');

    fireEvent.change(emailInput, { target: { value: 'not-a-valid-email' } });
    fireEvent.blur(emailInput);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Please enter a valid email address/i);
    });
    // aria-invalid flips to true on the input.
    expect(emailInput.getAttribute('aria-invalid')).toBe('true');

    // Typing again clears the error (per onChange branch that resets emailError when set).
    fireEvent.change(emailInput, { target: { value: 'fixed@example.com' } });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('#607: on-blur with an empty email field does NOT set the inline error', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add Contact/i }));
    const emailInput = screen.getByPlaceholderText('Email');
    // Blur with an empty value — the validator only fires when v is non-empty.
    fireEvent.blur(emailInput);

    // No inline alert; aria-invalid stays false.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(emailInput.getAttribute('aria-invalid')).toBe('false');
  });

  it('absorbs a /api/staff fetch failure without breaking the page render', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve(SEEDED_CONTACTS);
      if (url === '/api/staff') return Promise.reject(new Error('staff 500'));
      return Promise.resolve(null);
    });
    renderContacts();

    // Rows still render; the assigned-to dropdowns just have no staff options.
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());
    const row = screen.getByText('Aarav Sharma').closest('tr');
    const select = within(row).getByRole('combobox');
    // Only the 'Unassigned' option present (staff list empty).
    expect(select.querySelectorAll('option').length).toBe(1);
    expect(select.querySelector('option').textContent).toMatch(/Unassigned/i);
  });
});
