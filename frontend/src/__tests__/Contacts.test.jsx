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
    fireEvent.change(screen.getByPlaceholderText('Company'), { target: { value: 'Kapoor Foods' } });

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

  it('Import CSV modal opens, parses a pasted file, and POSTs to /api/contacts/import-csv on Import', async () => {
    renderContacts();
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Import CSV/i }));
    // "Import CSV" appears in BOTH the toolbar button label AND the modal h3 —
    // standing rule: use getAllByText for chrome+label collisions.
    expect(screen.getAllByText(/Import CSV/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Click to select a .csv file/i)).toBeInTheDocument();

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
    fireEvent.change(screen.getByPlaceholderText('Company'), { target: { value: 'Verma Group' } });

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
});
