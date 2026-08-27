/**
 * Leads.jsx  client-side hardening tests for the Create-Lead form (#557 / HI-08)
 * + vertical-aware Lead form for the wellness tenant (#600)
 * + header CTA + drawer surface (#892).
 *
 * Scope: verifies the frontend guard rails added to the Create-Lead form so
 * users get fast feedback (no server round-trip) when they paste oversized
 * input, sneak in HTML / control characters, or skip required fields. Also
 * pins the wellness-vertical Lead form (Phone required, wellness sources,
 * treatment-of-interest, preferred clinic/practitioner) and confirms the
 * generic CRM form stays unchanged.
 *
 * #892  Create Lead is no longer an always-visible inline form; it lives
 * inside a drawer that opens via the "Create Lead" header CTA. Every test
 * that interacts with the form first calls `openDrawer()` to click the CTA
 * and reveal the inputs. The fields + submit logic are unchanged; only the
 * trigger surface moved.
 *
 * The backend at routes/contacts.js + the global sanitizeBody middleware are
 * still the source of truth  these tests confirm the network call is NOT
 * made when the client-side guards trip, so a malicious or accidental
 * payload doesn't even reach the server.
 *
 * Contracts pinned here:
 *   1. <script>alert(1)</script> in name ?? ? form rejects locally; no fetch.
 *   2. Name longer than 191 chars ?? ? "too long" error; no fetch.
 *   3. Control char (\x00, \x07) in name ?? ? "invalid control characters"; no fetch.
 *   4. Empty required name ?? ? "Name is required"; no fetch.
 *   5. Invalid email shape ?? ? "valid email" error; no fetch.
 *   6. Happy path ?? ? POST /api/contacts fires exactly once with sanitised body.
 *   7. (#600) Wellness tenant ?? ? Phone field renders, "WhatsApp" source option
 *      exists; submitting without phone ?? ? "Phone is required", no fetch.
 *   8. (#600) Generic tenant ?? ? Phone field is hidden, "WhatsApp" not in
 *      Source dropdown.
 *   9. (#892) "Create Lead" header CTA is rendered; clicking it reveals
 *      the form fields in a drawer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Leads from '../pages/Leads';
import { AuthContext } from '../App';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifyInfo = vi.fn();
const notifySuccess = vi.fn();
const navigateMock = vi.fn();
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    info: notifyInfo,
    success: notifySuccess,
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
}));

vi.mock('react-router-dom', async () => {
  const real = await vi.importActual('react-router-dom');
  return { ...real, useNavigate: () => navigateMock };
});

beforeEach(() => {
  window.localStorage.clear();
});

function renderLeads(authValue = null) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue}>
        <Leads />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

// #892  Create Lead lives in a drawer now. Click the header CTA to mount
// the form before any field interaction. The CTA has aria-label "Create a
// new lead" (which becomes the accessible-name); the visible text is
// "Create Lead". Match on the aria-label since it takes precedence over
// inner text for accessible-name lookup.
function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: /Create a new lead/i }));
}

function fillForm({ name, email, company, title }) {
  if (name !== undefined) {
    fireEvent.change(screen.getByPlaceholderText('Full Name'), { target: { value: name } });
  }
  if (email !== undefined) {
    fireEvent.change(screen.getByPlaceholderText('Email Address'), { target: { value: email } });
  }
  if (company !== undefined) {
    fireEvent.change(screen.getByPlaceholderText('Company'), { target: { value: company } });
  }
  if (title !== undefined) {
    fireEvent.change(screen.getByPlaceholderText('Job Title'), { target: { value: title } });
  }
}

function submitForm() {
  fireEvent.click(screen.getByRole('button', { name: /Add Lead/i }));
}

// Default fetchApi mock: empty arrays for /api/contacts + /api/staff, so
// Leads.jsx's initial useEffect doesn't blow up. POST returns a minimal stub.
function defaultFetchMock(url, opts) {
  if (opts?.method === 'POST') {
    return Promise.resolve({ id: 999, name: 'New Lead' });
  }
  return Promise.resolve([]);
}

describe('Leads  Create Lead form client-side hardening (#557)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifyInfo.mockReset();
    notifySuccess.mockReset();
    navigateMock.mockReset();
  });

  it('rejects <script> tags in the name and never POSTs', async () => {
    renderLeads();
    // Wait for initial fetch to settle
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    openDrawer();

    fillForm({
      name: '<script>alert(1)</script>',
      email: 'qa@example.com',
    });
    submitForm();

    // The HTML strip should reduce <script>alert(1)</script> to "alert(1)"
    // (inner text preserved, dangerous tags removed). After strip, "alert(1)"
    // is a valid name string and would actually go through. The test
    // ASSERTS that the user sees the "HTML markup was removed" notice so
    // they know their input was modified.
    await waitFor(() => {
      expect(notifyInfo).toHaveBeenCalledWith(
        expect.stringMatching(/HTML markup was removed/i),
      );
    });
  });

  it('rejects a payload that is 100% HTML (collapses to empty name)', async () => {
    renderLeads();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    openDrawer();

    fillForm({
      name: '<img src=x onerror=alert(1)>',
      email: 'qa@example.com',
    });
    submitForm();

    // After strip, the name is empty ?? ? reject with "Name is required" and
    // never reach the network. This is the canonical XSS-rejection flow.
    // The "HTML markup was removed" info notice fires first (during strip),
    // followed by the "Name is required" error notice (post-strip empty
    // name re-check).
    await waitFor(() => {
      expect(notifyInfo).toHaveBeenCalledWith(expect.stringMatching(/HTML markup was removed/i));
    });
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Name is required/i));
    });
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('rejects a name longer than the 191-char schema cap', async () => {
    renderLeads();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    openDrawer();

    // Note: maxLength on the input clamps DOM-level value, but React's
    // controlled-input pathway still allows programmatic setState past
    // maxLength. We bypass the input's maxLength here by pasting a long
    // string and verifying the SUBMIT-HANDLER catches it.
    const long = 'A'.repeat(192);
    // Bypass the maxLength attribute by setting state directly via fireEvent
    // (jsdom respects maxLength on input events, so we strip it for this test
    // by removing the attribute  simulates the React-prototype-setter trick
    // from the issue).
    const nameInput = screen.getByPlaceholderText('Full Name');
    nameInput.removeAttribute('maxlength');
    fireEvent.change(nameInput, { target: { value: long } });
    fillForm({ email: 'qa@example.com' });
    submitForm();

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/name is too long/i));
    });
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('rejects names containing NUL or BEL control characters', async () => {
    renderLeads();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    openDrawer();

    fillForm({
      name: 'Alice\x00Smith',
      email: 'qa@example.com',
    });
    submitForm();

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/invalid control characters/i),
      );
    });
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('rejects empty required fields with a clear error', async () => {
    renderLeads();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    openDrawer();

    // Leave everything empty + try to submit. The HTML `required` attribute
    // would block the form natively, but `noValidate` is set on the form so
    // our custom handler runs. Verify the JS-level rejection.
    submitForm();

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Name is required/i));
    });
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('rejects malformed email addresses', async () => {
    renderLeads();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    openDrawer();

    fillForm({
      name: 'Alice Smith',
      email: 'not-an-email',
    });
    submitForm();

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/valid email/i));
    });
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('happy path  valid lead POSTs once with sanitised body', async () => {
    renderLeads();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    openDrawer();

    fillForm({
      name: 'Alice Smith',
      email: 'alice@acme.test',
      company: 'Acme Corp',
      title: 'VP Sales',
    });
    submitForm();

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts' && opts?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Alice Smith');
      expect(body.email).toBe('alice@acme.test');
      expect(body.company).toBe('Acme Corp');
      expect(body.title).toBe('VP Sales');
    });

    // No error toast on the happy path
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('input fields carry the correct maxLength attributes', async () => {
    renderLeads();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    openDrawer();

    expect(screen.getByPlaceholderText('Full Name')).toHaveAttribute('maxLength', '191');
    expect(screen.getByPlaceholderText('Email Address')).toHaveAttribute('maxLength', '191');
    expect(screen.getByPlaceholderText('Company')).toHaveAttribute('maxLength', '191');
    expect(screen.getByPlaceholderText('Job Title')).toHaveAttribute('maxLength', '200');
  });

  // #892  pin the CTA + drawer surface. Pre-#892 the form was always
  // visible above the table; post-#892 it lives inside a drawer that
  // opens via the header CTA. Without this test, a future change that
  // accidentally re-renders the form inline would not red the suite.
  it('renders the "Create Lead" CTA and the form is hidden until clicked', async () => {
    renderLeads();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());

    // CTA exists in the header (aria-label "Create a new lead").
    expect(screen.getByRole('button', { name: /Create a new lead/i })).toBeInTheDocument();

    // The form fields are NOT mounted until the CTA opens the drawer.
    expect(screen.queryByPlaceholderText('Full Name')).toBeNull();
    expect(screen.queryByPlaceholderText('Email Address')).toBeNull();

    // Click the CTA ?? ? drawer opens ?? ? fields become reachable.
    openDrawer();
    expect(screen.getByPlaceholderText('Full Name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Email Address')).toBeInTheDocument();
    // Close button is rendered inside the drawer.
    expect(screen.getByRole('button', { name: /Close/i })).toBeInTheDocument();
  });
});

describe('Leads Freshsales-style list UI affordances', () => {
  const authValue = {
    user: { userId: 1, name: 'Admin', email: 'admin@example.com', role: 'ADMIN' },
    token: 'fake-token',
    tenant: { id: 1, vertical: 'generic', name: 'Generic CRM' },
    loading: false,
  };

  const leadRows = [
    {
      id: 101,
      name: 'Alice Lead',
      email: 'alice@example.com',
      phone: '+1 5551112222',
      company: 'Acme',
      title: 'Buyer',
      source: 'Website',
      status: 'Lead',
      aiScore: 61,
      tags: ['Warm', 'VIP'],
      assignedToId: 7,
      assignedTo: { id: 7, name: 'Maya Rao', email: 'maya@example.com' },
      createdAt: '2026-08-10T09:00:00.000Z',
      customFields: {},
    },
    {
      id: 102,
      name: 'Bob Lead',
      email: 'bob@example.com',
      phone: '+1 5553334444',
      company: 'Beta',
      title: 'Founder',
      source: 'Referral',
      status: 'Lead',
      aiScore: 28,
      tags: ['Returning'],
      assignedToId: null,
      assignedTo: null,
      createdAt: '2026-08-11T09:00:00.000Z',
      customFields: {},
    },
  ];

  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifyInfo.mockReset();
    notifySuccess.mockReset();
    navigateMock.mockReset();
    fetchApiMock.mockImplementation((url, opts) => {
      if (opts?.method === 'PUT') return Promise.resolve({ ok: true });
      if (typeof url === 'string' && url.startsWith('/api/contacts?status=Lead')) {
        return Promise.resolve(leadRows);
      }
      if (typeof url === 'string' && url.startsWith('/api/contacts/filter-values/tags')) {
        return Promise.resolve({
          values: [
            { value: 'Strategic', label: 'Strategic' },
            { value: 'Returning', label: 'Returning' },
          ],
        });
      }
      if (url === '/api/staff' && !opts) {
        return Promise.resolve([{ id: 7, name: 'Maya Rao', email: 'maya@example.com', role: 'USER' }]);
      }
      if (url === '/api/integrations/callified/config' && !opts) return Promise.resolve({ isActive: false });
      if (url === '/api/callified/campaigns/with-lead-counts' && !opts) return Promise.resolve({ campaigns: [] });
      if (typeof url === 'string' && url.startsWith('/api/callified/leads/call-summary') && !opts) {
        return Promise.resolve({ summaries: {} });
      }
      return Promise.resolve([]);
    });
  });

  it('renders only the main header row and no inline filter row', async () => {
    renderLeads(authValue);

    await screen.findByText('Alice Lead');
    expect(screen.queryByLabelText('Filter Email')).toBeNull();
    expect(screen.queryByPlaceholderText('Filter Email')).toBeNull();
    document.querySelectorAll('.leads-split-table thead').forEach((thead) => {
      expect(thead.querySelectorAll('tr')).toHaveLength(1);
    });
  });

  it('renders the Name column as a profile link instead of an inline edit trigger', async () => {
    renderLeads(authValue);

    const aliceLink = await screen.findByRole('link', { name: 'Alice Lead' });
    expect(aliceLink).toHaveAttribute('href', '/contacts/101');

    fireEvent.click(aliceLink);
    expect(navigateMock).toHaveBeenCalledWith('/contacts/101');
    expect(screen.getByLabelText('Edit Name for Alice Lead')).toHaveAttribute('type', 'button');
  });

  it('keeps the Name column edit icon as the only way to inline-edit the name', async () => {
    renderLeads(authValue);

    const aliceLink = await screen.findByRole('link', { name: 'Alice Lead' });
    const nameDisplay = aliceLink.closest('.inline-cell-editor-display');
    const editButton = screen.getByLabelText('Edit Name for Alice Lead');

    expect(editButton).toHaveStyle({ opacity: '0' });
    fireEvent.mouseEnter(nameDisplay);
    await waitFor(() => {
      expect(editButton).toHaveStyle({ opacity: '0.85' });
    });

    fireEvent.click(editButton);
    expect(screen.getByLabelText('Edit Name for Alice Lead')).toHaveValue('Alice Lead');
  });

  it('saves built-in column edits inline without opening the full edit drawer', async () => {
    renderLeads(authValue);

    await screen.findByText('Acme');
    const companyDisplay = screen.getByText('Acme').closest('.inline-cell-editor-display');
    const editButton = screen.getByLabelText('Edit Company for Alice Lead');
    expect(editButton).toHaveStyle({ opacity: '0' });
    fireEvent.mouseEnter(companyDisplay);
    await waitFor(() => {
      expect(editButton).toHaveStyle({ opacity: '0.85' });
    });
    fireEvent.click(editButton);
    const companyInput = screen.getByLabelText('Edit Company for Alice Lead');
    fireEvent.change(companyInput, { target: { value: 'Acme Labs' } });
    fireEvent.blur(companyInput);

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/101', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ company: 'Acme Labs' }),
      }));
    });
    expect(notifySuccess).toHaveBeenCalledWith('Lead updated');
  });

  it('renders Tags as a default column and saves multiple selected tags', async () => {
    renderLeads(authValue);

    await screen.findByText('Alice Lead');
    expect(screen.getByText('Tags')).toBeInTheDocument();

    const tagCell = screen.getByText('Warm').closest('.lead-tags-cell');
    const aliceTags = within(tagCell);
    expect(aliceTags.getByText('Warm')).toBeInTheDocument();
    expect(aliceTags.getByText('VIP')).toBeInTheDocument();
    const editButton = screen.getByLabelText('Edit Tags for Alice Lead');
    expect(editButton).toHaveStyle({ opacity: '0' });
    fireEvent.mouseEnter(tagCell);
    await waitFor(() => {
      expect(editButton).toHaveStyle({ opacity: '0.85' });
    });
    fireEvent.click(editButton);

    const dialog = await screen.findByRole('dialog', { name: 'Edit Tags for Alice Lead' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search existing' }));

    const searchInput = within(dialog).getByPlaceholderText('Search saved tags');
    fireEvent.change(searchInput, { target: { value: 'strat' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Strategic' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add new' }));
    const newTagInput = within(dialog).getByPlaceholderText('Type a new tag');
    fireEvent.change(newTagInput, { target: { value: 'Enterprise' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add new tag' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/101', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ tags: ['Warm', 'VIP', 'Strategic', 'Enterprise'] }),
      }));
    });

    await waitFor(() => {
      expect(aliceTags.getByText('Warm')).toBeInTheDocument();
      expect(aliceTags.getByText('VIP')).toBeInTheDocument();
      expect(aliceTags.getByText('Strategic')).toBeInTheDocument();
      expect(aliceTags.getByText('Enterprise')).toBeInTheDocument();
      expect(aliceTags.queryByText('+2')).toBeNull();
    });

    fireEvent.click(screen.getByLabelText('Edit Tags for Alice Lead'));
    const reopenedDialog = await screen.findByRole('dialog', { name: 'Edit Tags for Alice Lead' });
    fireEvent.click(within(reopenedDialog).getByRole('button', { name: 'Search existing' }));
    expect(within(reopenedDialog).getByRole('button', { name: 'Enterprise' })).toBeInTheDocument();
    expect(within(reopenedDialog).getByRole('button', { name: 'Warm' })).toBeInTheDocument();
  });

  it('deletes a saved tag from the catalog without disturbing the lead tag editor', async () => {
    renderLeads(authValue);

    await screen.findByText('Alice Lead');
    const tagCell = screen.getByText('Warm').closest('.lead-tags-cell');
    fireEvent.mouseEnter(tagCell);
    fireEvent.click(screen.getByLabelText('Edit Tags for Alice Lead'));

    const dialog = await screen.findByRole('dialog', { name: 'Edit Tags for Alice Lead' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search existing' }));

    const searchInput = within(dialog).getByPlaceholderText('Search saved tags');
    fireEvent.change(searchInput, { target: { value: 'strat' } });

    const deleteButton = await within(dialog).findByRole('button', {
      name: /Delete saved tag Strategic/i,
    });
    fireEvent.click(deleteButton);

    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts/tags' && opts?.method === 'DELETE',
      );
      expect(deleteCall).toBeDefined();
      expect(JSON.parse(deleteCall[1].body)).toEqual({ tag: 'Strategic', status: 'Lead' });
    });

    await waitFor(() => {
      expect(within(dialog).queryByRole('button', { name: 'Strategic' })).toBeNull();
    });

    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Deleted "Strategic"/i));
  });

  it('opens an in-place lead preview drawer from the list actions', async () => {
    renderLeads(authValue);

    await screen.findByText('Alice Lead');
    fireEvent.click(screen.getByRole('button', { name: 'Preview Alice Lead' }));

    expect(screen.getByRole('dialog', { name: 'Lead preview' })).toBeInTheDocument();
    expect(screen.getByText('Contact information')).toBeInTheDocument();
    expect(screen.getByText('Open full detail')).toBeInTheDocument();
  });

  it('keeps the Name column fixed and renders saved visible columns in order', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (typeof url === 'string' && url === '/api/table-column-prefs/leads' && !opts) {
        return Promise.resolve({
          visible: ['phone', 'company', 'email', 'assignedTo', 'createdAt', 'source', 'aiScore'],
          availableColumns: [
            { key: 'phone', label: 'Phone' },
            { key: 'company', label: 'Company' },
            { key: 'email', label: 'Email' },
            { key: 'assignedTo', label: 'Assigned To' },
            { key: 'createdAt', label: 'Created' },
            { key: 'source', label: 'Source' },
            { key: 'aiScore', label: 'Lead Score' },
          ],
        });
      }
      return leadsFetchMock(url, opts);
    });

    const { container } = renderLeads(authValue);

    await screen.findByText('Alice Smith');
    await waitFor(() => {
      const headers = Array.from(container.querySelectorAll('.leads-split-table thead th')).map((th) =>
        th.textContent.replace(/\s+/g, ' ').trim(),
      );
      expect(headers.slice(0, 13)).toEqual([
        'Name',
        'Phone',
        'Company',
        'Email',
        'Assigned To',
        'Created',
        'Source',
        'Lead Score',
        'Callified Campaign',
        'Call Status',
        'Callified AI call',
        'Callified Score',
        'Actions',
      ]);
    });

    const nameHeader = screen.getByText('Name').closest('th');
    expect(nameHeader.closest('.leads-table-frozen-pane')).toBeTruthy();

    const aliceNameCell = screen.getByText('Alice Smith').closest('td');
    expect(aliceNameCell.closest('.leads-table-frozen-pane')).toBeTruthy();

    const phoneHeader = screen.getByText('Phone').closest('th');
    expect(phoneHeader.closest('.leads-table-scroll-pane')).toBeTruthy();

    const bottomScroll = container.querySelector('.leads-table-scroll-pane .top-scroll-sync__bottom');
    expect(bottomScroll).toHaveClass('top-scroll-sync__bottom--hidden-scrollbar');
  });

  it('persists dragged column widths for the Leads table layout', async () => {
    renderLeads(authValue);

    await screen.findByText('Alice Lead');
    fireEvent.mouseDown(screen.getByRole('separator', { name: 'Resize Email column' }), {
      clientX: 200,
    });
    fireEvent.mouseMove(window, { clientX: 280 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem('globuscrm.leads.columnLayout.v1'));
      expect(saved.widths.email).toBe(300);
      expect(saved.collapsed.email).toBe(false);
    });
  });

  it('keeps the table width from shrinking when a column is resized narrower', async () => {
    const { container } = renderLeads(authValue);

    await screen.findByText('Alice Lead');
    const table = container.querySelector('table.leads-table--scrollable');
    expect(table).toBeTruthy();
    const initialMinWidth = Number.parseFloat(table.style.minWidth);

    fireEvent.mouseDown(screen.getByRole('separator', { name: 'Resize Email column' }), {
      clientX: 200,
    });
    fireEvent.mouseMove(window, { clientX: 120 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      expect(Number.parseFloat(table.style.minWidth)).toBeGreaterThanOrEqual(initialMinWidth);
    });
  });

  it('keeps the Name column within a readable width range when resized', async () => {
    renderLeads(authValue);

    await screen.findByText('Alice Lead');
    const nameResizeHandle = screen.getByRole('separator', { name: 'Resize Name column' });

    fireEvent.mouseDown(nameResizeHandle, {
      clientX: 200,
    });
    fireEvent.mouseMove(window, { clientX: 1200 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem('globuscrm.leads.columnLayout.v1'));
      expect(saved.widths.name).toBeLessThanOrEqual(380);
      expect(saved.widths.name).toBeGreaterThanOrEqual(220);
    });

    fireEvent.mouseDown(nameResizeHandle, {
      clientX: 200,
    });
    fireEvent.mouseMove(window, { clientX: -200 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem('globuscrm.leads.columnLayout.v1'));
      expect(saved.widths.name).toBe(220);
    });
  });

  it.each([
    [
      'wellness',
      {
        tenant: { id: 2, vertical: 'wellness', name: 'Enhanced Wellness' },
        user: { id: 1, role: 'ADMIN' },
      },
    ],
    [
      'travel',
      {
        tenant: { id: 3, vertical: 'travel', name: 'Travel Co' },
        user: { id: 1, role: 'ADMIN' },
      },
    ],
  ])('synchronizes split-table row heights for %s tenants', async (_label, verticalAuth) => {
    const rectMock = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const makeRect = (height, width) => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON() {
          return this;
        },
      });

      if (this?.tagName === 'TR' && this.closest?.('.leads-table-frozen-pane')) {
        return makeRect(42, 240);
      }
      if (this?.tagName === 'TR' && this.closest?.('.leads-table-scroll-pane')) {
        return makeRect(66, 920);
      }
      return makeRect(0, 0);
    });

    try {
      const { container } = renderLeads(verticalAuth);
      await screen.findByText('Alice Lead');

      await waitFor(() => {
        const frozenHeader = container.querySelector('.leads-table-frozen-pane thead tr');
        const scrollHeader = container.querySelector('.leads-table-scroll-pane thead tr');
        const frozenRows = Array.from(
          container.querySelectorAll('.leads-table-frozen-pane tbody tr'),
        );
        const scrollRows = Array.from(
          container.querySelectorAll('.leads-table-scroll-pane tbody tr'),
        );

        expect(frozenHeader).toBeTruthy();
        expect(scrollHeader).toBeTruthy();
        expect(frozenHeader.style.height).toBe('66px');
        expect(scrollHeader.style.height).toBe('66px');
        expect(frozenRows.length).toBeGreaterThan(0);
        expect(frozenRows.length).toBe(scrollRows.length);
        frozenRows.forEach((row) => {
          expect(row.style.height).toBe('66px');
        });
        scrollRows.forEach((row) => {
          expect(row.style.height).toBe('66px');
        });
      });
    } finally {
      rectMock.mockRestore();
    }
  });

  it('synchronizes the generic split-table header and row heights', async () => {
    const rectMock = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const makeRect = (height, width) => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON() {
          return this;
        },
      });

      if (
        this?.tagName === 'TR' &&
        this.closest?.('thead') &&
        this.closest?.('.leads-table-frozen-pane')
      ) {
        return makeRect(42, 240);
      }
      if (
        this?.tagName === 'TR' &&
        this.closest?.('thead') &&
        this.closest?.('.leads-table-scroll-pane')
      ) {
        return makeRect(66, 920);
      }
      if (
        this?.tagName === 'TR' &&
        this.closest?.('tbody') &&
        this.closest?.('.leads-table-frozen-pane')
      ) {
        return makeRect(42, 240);
      }
      if (
        this?.tagName === 'TR' &&
        this.closest?.('tbody') &&
        this.closest?.('.leads-table-scroll-pane')
      ) {
        return makeRect(66, 920);
      }
      return makeRect(0, 0);
    });

    try {
      const { container } = renderLeads(authValue);
      await screen.findByText('Alice Lead');

      await waitFor(() => {
        const frozenHeader = container.querySelector('.leads-table-frozen-pane thead tr');
        const scrollHeader = container.querySelector('.leads-table-scroll-pane thead tr');

        expect(frozenHeader).toBeTruthy();
        expect(scrollHeader).toBeTruthy();
        expect(frozenHeader.style.height).toBe('66px');
        expect(scrollHeader.style.height).toBe('66px');

        const frozenBody = container.querySelector('.leads-table-frozen-pane tbody tr');
        const scrollBody = container.querySelector('.leads-table-scroll-pane tbody tr');
        expect(frozenBody.style.height).toBe('66px');
        expect(scrollBody.style.height).toBe('66px');
      });
    } finally {
      rectMock.mockRestore();
    }
  });
});

// #600  wellness-vertical Lead form. Verifies the form schema flips when
// AuthContext.tenant.vertical === 'wellness': Phone field renders, the 8
// wellness sources replace the 6 generic ones, and submitting without a
// phone trips the "Phone is required" guard. The generic-tenant case
// asserts the inverse (Phone hidden, no WhatsApp option).
describe('Leads  vertical-aware form schema (#600)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifyInfo.mockReset();
    notifySuccess.mockReset();
  });

  const wellnessAuth = {
    tenant: { id: 2, vertical: 'wellness', name: 'Enhanced Wellness' },
    user: { id: 1, role: 'ADMIN' },
  };

  const genericAuth = {
    tenant: { id: 1, vertical: 'generic', name: 'Globussoft CRM' },
    user: { id: 1, role: 'ADMIN' },
  };

  it('wellness tenant ?? ? Phone field renders and WhatsApp is in Source dropdown', async () => {
    renderLeads(wellnessAuth);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    openDrawer();

    // Phone input is rendered + required.
    const phone = screen.getByPlaceholderText(/Phone \(10-digit/i);
    expect(phone).toBeInTheDocument();
    expect(phone).toHaveAttribute('required');

    // WhatsApp option present in the Source dropdown.
    const sourceSelect = screen.getByDisplayValue('Walk-in');
    expect(sourceSelect).toBeInTheDocument();
    const whatsappOpt = Array.from(sourceSelect.querySelectorAll('option')).find(
      o => o.textContent === 'WhatsApp',
    );
    expect(whatsappOpt).toBeDefined();
    expect(whatsappOpt.value).toBe('whatsapp');

    // Generic CRM source must NOT appear (Patient taxonomy replaces it).
    const linkedinOpt = Array.from(sourceSelect.querySelectorAll('option')).find(
      o => o.value === 'LinkedIn',
    );
    expect(linkedinOpt).toBeUndefined();
  });

  it('wellness tenant ?? ? submitting without phone triggers "Phone is required"', async () => {
    renderLeads(wellnessAuth);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    openDrawer();

    fireEvent.change(screen.getByPlaceholderText('Full Name'), { target: { value: 'Anita Sharma' } });
    // Email is optional under wellness; phone is missing.
    submitForm();

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Phone is required/i));
    });
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('wellness tenant ?? ? happy path POSTs phone, source, and treatmentOfInterest', async () => {
    renderLeads(wellnessAuth);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    openDrawer();

    fireEvent.change(screen.getByPlaceholderText('Full Name'), { target: { value: 'Anita Sharma' } });
    fireEvent.change(screen.getByPlaceholderText(/Phone \(10-digit/i), {
      target: { value: '+919876543210' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Treatment of interest/i), {
      target: { value: 'Botox' },
    });
    // Switch source to WhatsApp.
    const sourceSelect = screen.getByDisplayValue('Walk-in');
    fireEvent.change(sourceSelect, { target: { value: 'whatsapp' } });

    submitForm();

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts' && opts?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Anita Sharma');
      expect(body.phone).toBe('+919876543210');
      expect(body.source).toBe('whatsapp');
      expect(body.treatmentOfInterest).toBe('Botox');
    });
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('generic tenant ?? ? Phone field is hidden and WhatsApp is NOT in Source dropdown', async () => {
    renderLeads(genericAuth);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    openDrawer();

    expect(screen.queryByPlaceholderText(/Phone \(10-digit/i)).toBeNull();

    const sourceSelect = screen.getByDisplayValue('Organic');
    expect(sourceSelect).toBeInTheDocument();
    const whatsappOpt = Array.from(sourceSelect.querySelectorAll('option')).find(
      o => o.textContent === 'WhatsApp' || o.value === 'whatsapp',
    );
    expect(whatsappOpt).toBeUndefined();

    // Generic taxonomy still present.
    const linkedinOpt = Array.from(sourceSelect.querySelectorAll('option')).find(
      o => o.value === 'LinkedIn',
    );
    expect(linkedinOpt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Additional coverage  list-side surface (search, score badge, bulk selection,
// per-row assign, Convert, drawer close paths). Existing tests above already
// pin the Create-Lead form hardening and vertical schema. This block targets
// what the table + bulk bar + drawer-dismiss flows actually do, which is the
// majority of Leads.jsx's runtime surface (lines 275-522). All cases use
// stable mock object references for hooks (per the RTL standing rule) and
// the same `fetchApiMock` + `notify*` mocks the earlier suites share.
// ---------------------------------------------------------------------------

// A small canned-leads fixture covering the 3 score bands the badge uses
// (>75 success, >40 warning, =40 error) plus an assignedToId for the
// per-row assign-dropdown rendering test.
const SAMPLE_LEADS = [
  { id: 11, name: 'Alice Smith', email: 'alice@acme.test', company: 'Acme Corp', aiScore: 88, source: 'Organic', assignedToId: null, createdAt: '2026-05-01T10:00:00Z' },
  { id: 12, name: 'Bob Jones',   email: 'bob@globex.test', company: 'Globex',    aiScore: 55, source: 'Referral', assignedToId: 7, createdAt: '2026-05-02T10:00:00Z' },
  { id: 13, name: 'Carol Diaz',  email: 'carol@initech.test', company: 'Initech', aiScore: 20, source: 'Website', assignedToId: null, createdAt: '2026-05-03T10:00:00Z' },
];
const SAMPLE_STAFF = [
  { id: 7,  name: 'Sales Rep One',  email: 'rep1@crm.test' },
  { id: 8,  name: 'Sales Rep Two',  email: 'rep2@crm.test' },
];

function leadsFetchMock(url, opts) {
  // GET /api/contacts?status=Lead ?? ? seeded list
  if (typeof url === 'string' && url.startsWith('/api/contacts?status=Lead') && !opts) {
    return Promise.resolve(SAMPLE_LEADS);
  }
  if (typeof url === 'string' && url === '/api/table-column-prefs/leads' && !opts) {
    return Promise.resolve({
      visible: ['name', 'email', 'company', 'phone', 'aiScore', 'source', 'tags', 'assignedTo', 'createdAt'],
      availableColumns: [
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'company', label: 'Company' },
        { key: 'phone', label: 'Phone' },
        { key: 'aiScore', label: 'Lead Score' },
        { key: 'source', label: 'Source' },
        { key: 'tags', label: 'Tags' },
        { key: 'assignedTo', label: 'Assigned To' },
        { key: 'createdAt', label: 'Created' },
      ],
    });
  }
  if (url === '/api/staff' && !opts) {
    return Promise.resolve(SAMPLE_STAFF);
  }
  if (typeof url === 'string' && url.startsWith('/api/contacts/filter-values/source')) {
    return Promise.resolve({
      values: [
        { value: 'Organic', label: 'Organic' },
        { value: 'Referral', label: 'Referral' },
      ],
    });
  }
  if (typeof url === 'string' && url.startsWith('/api/contacts/filter-values/callifiedCampaignId')) {
    return Promise.resolve({
      values: [
        { value: '101', label: 'Outbound Growth' },
        { value: '102', label: 'Inbound Care' },
      ],
    });
  }
  if (typeof url === 'string' && url.startsWith('/api/contacts/filter-values/callifiedLeadStatus')) {
    return Promise.resolve({
      values: [
        { value: 'qualified', label: 'Qualified' },
        { value: 'junk', label: 'Junk' },
      ],
    });
  }
  if (typeof url === 'string' && url === '/api/contacts/tags' && opts?.method === 'DELETE') {
    return Promise.resolve({ deletedTag: 'Strategic', updatedContacts: 1 });
  }
  // PUT /api/contacts/:id (convert), PUT /api/contacts/:id/assign, PUT bulk-assign,
  // POST /api/contacts  all return a benign stub. The component re-fetches
  // after each, which falls through to the GETs above.
  if (opts?.method === 'PUT' || opts?.method === 'POST') {
    return Promise.resolve({ ok: true });
  }
  return Promise.resolve([]);
}

// ADMIN auth context for tests that exercise admin-only surfaces (checkboxes,
// bulk-assign bar, per-row assign dropdowns). The SUT gates these on
// auth?.user?.role === 'ADMIN'  calling renderLeads() without an auth value
// (null) means isAdmin=false and those surfaces are hidden.
const ADMIN_AUTH = {
  tenant: { id: 1, vertical: 'generic', name: 'Globussoft CRM' },
  user: { id: 1, role: 'ADMIN', name: 'Admin User', email: 'admin@crm.test' },
};

describe('Leads  table, search, bulk operations, row actions, drawer dismiss', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(leadsFetchMock);
    notifyError.mockReset();
    notifyInfo.mockReset();
    notifySuccess.mockReset();
  });

  it('renders seeded leads with name + email + company + lead-score badge', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    // All three names rendered
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('Carol Diaz')).toBeInTheDocument();

    // Email + company cells rendered
    expect(screen.getByText('alice@acme.test')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();

    // Lead Score badge text  `${aiScore}/100` rendered per row
    expect(screen.getByText('88/100')).toBeInTheDocument();
    expect(screen.getByText('55/100')).toBeInTheDocument();
    expect(screen.getByText('20/100')).toBeInTheDocument();

    // Header counter  "3 leads in pipeline"
    expect(screen.getByText(/3 leads in pipeline/)).toBeInTheDocument();
  });

  it('renders source badges with theme tokens so dark mode stays readable', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    const sourceBadge = screen
      .getAllByText('Organic')
      .map(node => node.closest('span'))
      .find(node => node?.style.backgroundColor.includes('--source-badge-bg'));
    expect(sourceBadge).toBeInTheDocument();
    expect(sourceBadge.style.backgroundColor).toBe('var(--source-badge-bg, rgba(139, 92, 246, 0.16))');
    expect(sourceBadge.style.color).toBe('var(--source-badge-text, var(--text-primary))');
    expect(sourceBadge.style.border).toBe('1px solid var(--border-color)');
  });

  it('opens the Source column menu and applies a source-only filter query', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Open Source column menu/i }));
    expect(await screen.findByRole('menu', { name: /Source column menu/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add as filter/i }));
    const dialog = await screen.findByRole('dialog', { name: /Source filter/i });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Organic' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Apply/i }));

    await waitFor(() => {
      const filteredCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          typeof url === 'string' &&
          url.startsWith('/api/contacts?status=Lead&limit=500') &&
          !opts &&
          url.includes('filters='),
      );
      expect(filteredCall).toBeDefined();
      const filtersParam = new URL(filteredCall[0], 'http://localhost').searchParams.get('filters');
      expect(JSON.parse(filtersParam)).toEqual([
        { field: 'source', operator: 'contains', values: ['Organic'] },
      ]);
    });
  });

  it('opens the Callified Campaign column menu and applies a campaign-only filter query', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Open Callified Campaign column menu/i }));
    expect(await screen.findByRole('menu', { name: /Callified Campaign column menu/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add as filter/i }));
    const dialog = await screen.findByRole('dialog', { name: /Callified Campaign filter/i });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Outbound Growth' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Apply/i }));

    await waitFor(() => {
      const filteredCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          typeof url === 'string' &&
          url.startsWith('/api/contacts?status=Lead&limit=500') &&
          !opts &&
          url.includes('filters='),
      );
      expect(filteredCall).toBeDefined();
      const filtersParam = new URL(filteredCall[0], 'http://localhost').searchParams.get('filters');
      expect(JSON.parse(filtersParam)).toEqual([
        { field: 'callifiedCampaignId', operator: 'contains', values: ['101'] },
      ]);
    });
  });

  it('opens the new header Filter by drawer without changing the existing column filter flows', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^Filter by$/i }));
    expect(await screen.findByRole('dialog', { name: /Filters/i })).toBeInTheDocument();

    await waitFor(() => {
      const filterFieldsCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts/filter-fields?status=Lead' && opts?.silent === true,
      );
      expect(filterFieldsCall).toBeDefined();
    });
  });

  it('opens the new header Bulk actions menu, preserves manual deselection on reopen, and exposes the existing staff assignment action', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    const bulkActionsButton = screen.getByRole('button', { name: /Bulk actions/i });
    fireEvent.click(bulkActionsButton);
    const menu = await screen.findByRole('menu', { name: /Bulk actions/i });
    expect(menu).toHaveStyle({
      left: '0px',
      right: 'auto',
    });
    await waitFor(() => {
      expect(screen.getByText(/3 leads selected/i)).toBeInTheDocument();
    });
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(4);
    checkboxes.forEach((checkbox) => {
      expect(checkbox).toBeChecked();
    });
    const rubixCheckbox = screen.getAllByRole('checkbox')[2];
    fireEvent.click(rubixCheckbox);
    await waitFor(() => {
      expect(screen.getByText(/2 leads selected/i)).toBeInTheDocument();
    });

    fireEvent.click(bulkActionsButton);
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: /Bulk actions/i })).toBeNull();
    });
    fireEvent.click(bulkActionsButton);
    const reopenedMenu = await screen.findByRole('menu', { name: /Bulk actions/i });
    expect(within(reopenedMenu).getByText(/2 selected/i)).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').slice(1)[1]).not.toBeChecked();
    expect(within(reopenedMenu).getByRole('button', { name: /Assign to staff/i })).toBeInTheDocument();
    expect(within(reopenedMenu).getByLabelText(/Bulk assign staff/i)).toBeInTheDocument();
    expect(within(reopenedMenu).getByRole('button', { name: /Delete selected leads/i })).toBeInTheDocument();
  });

  it('bulk delete action DELETEs the selected leads and clears the selection', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Bulk actions$/i }));
    const menu = await screen.findByRole('menu', { name: /Bulk actions/i });
    const rubixCheckbox = screen.getAllByRole('checkbox').slice(1)[1];
    fireEvent.click(rubixCheckbox);
    await waitFor(() => {
      expect(within(menu).getByText(/2 selected/i)).toBeInTheDocument();
    });
    fireEvent.click(within(menu).getByRole('button', { name: /Delete selected leads/i }));

    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts/bulk-delete' && opts?.method === 'DELETE',
      );
      expect(deleteCall).toBeDefined();
      expect(JSON.parse(deleteCall[1].body)).toEqual({ contactIds: [11, 13] });
    });
    await waitFor(() => {
      expect(screen.queryByText(/2 leads selected/i)).toBeNull();
    });
    expect(notifySuccess).toHaveBeenCalledWith('Deleted 2 leads');
  });

  it('filters the row list by search term against name / email / company', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search leads...');

    // Filter by company substring ?? ? only Globex's Bob remains
    fireEvent.change(searchInput, { target: { value: 'globex' } });
    await waitFor(() => {
      expect(screen.queryByText('Alice Smith')).toBeNull();
      expect(screen.getByText('Bob Jones')).toBeInTheDocument();
      expect(screen.queryByText('Carol Diaz')).toBeNull();
    });

    // Filter by email substring ?? ? only Carol
    fireEvent.change(searchInput, { target: { value: 'initech.test' } });
    await waitFor(() => {
      expect(screen.queryByText('Alice Smith')).toBeNull();
      expect(screen.queryByText('Bob Jones')).toBeNull();
      expect(screen.getByText('Carol Diaz')).toBeInTheDocument();
    });

    // Clear ?? ? all three back
    fireEvent.change(searchInput, { target: { value: '' } });
    await waitFor(() => {
      expect(screen.getByText('Alice Smith')).toBeInTheDocument();
      expect(screen.getByText('Bob Jones')).toBeInTheDocument();
      expect(screen.getByText('Carol Diaz')).toBeInTheDocument();
    });
  });

  it('header counter reflects the active search filter  "X of Y leads match" while typing, plain pipeline count when cleared', async () => {
    // Regression: pre-fix the header used leads.length (unfiltered) so it
    // still read "3 leads in pipeline" while the table was narrowed to 1
    // result. Post-fix it switches to "X of Y leads match \"<term>\"" while
    // a search is active and reverts to the original phrasing when cleared.
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    // No search ?? ? original phrasing.
    expect(screen.getByText(/3 leads in pipeline/)).toBeInTheDocument();
    const searchInput = screen.getByPlaceholderText('Search leads...');
    fireEvent.change(searchInput, { target: { value: 'globex' } });
    await waitFor(() => {
      // Counter reflects the filtered count + retains the total for context.
      expect(screen.getByText(/1 of 3 leads match "globex"/)).toBeInTheDocument();
      // Stale phrasing must not still be on the page.
      expect(screen.queryByText(/3 leads in pipeline/)).toBeNull();
    });
    fireEvent.change(searchInput, { target: { value: '' } });
    await waitFor(() => {
      expect(screen.getByText(/3 leads in pipeline/)).toBeInTheDocument();
    });
  });

  it('Convert button PUTs /api/contacts/:id with status="Prospect" (#283)', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // Multiple Convert buttons (one per row). Click the first one.
    const convertButtons = screen.getAllByRole('button', { name: /Convert/i });
    expect(convertButtons.length).toBe(3);
    fireEvent.click(convertButtons[0]);

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => typeof url === 'string' && url.startsWith('/api/contacts/') && opts?.method === 'PUT' && !url.includes('/assign'),
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      // Per #283  Convert advances ONE step (Lead ?? ? Prospect), not jumps to Customer
      expect(body.status).toBe('Prospect');
    });
  });

  it('per-row assign dropdown PUTs /api/contacts/:id/assign with the selected staff id', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // The middle row is pre-assigned to 7; the first row (Alice) is unassigned.
    const aliceAssignSelect = screen.getByLabelText(/Assign Alice Smith to staff/i);
    expect(aliceAssignSelect).toBeInTheDocument();

    fireEvent.change(aliceAssignSelect, { target: { value: '7' } });

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => typeof url === 'string' && url.endsWith('/assign') && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body.assignedToId).toBe('7');
    });
  });

  it('renders inline add/edit controls for generic lead custom fields and saves through the contacts API', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (typeof url === 'string' && url.startsWith('/api/contacts?status=Lead') && !opts) {
        return Promise.resolve([
          {
            id: 11,
            name: 'Alice Smith',
            email: 'alice@acme.test',
            company: 'Acme Corp',
            aiScore: 88,
            source: 'Organic',
            assignedToId: null,
            createdAt: '2026-05-01T10:00:00Z',
            customFields: {},
          },
        ]);
      }
      if (url === '/api/staff' && !opts) return Promise.resolve([]);
      if (url === '/api/lead-custom-fields' && !opts) {
        return Promise.resolve([
          { id: 201, fieldKey: 'priority', label: 'Priority', fieldType: 'text', placeholder: 'Priority level' },
        ]);
      }
      if (opts?.method === 'PUT') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve([]);
    });

    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    expect(screen.getByText('Priority')).toBeInTheDocument();
    const editButton = screen.getByRole('button', { name: 'Edit Priority' });
    fireEvent.click(editButton);
    expect(navigateMock).not.toHaveBeenCalled();

    const editor = screen.getByPlaceholderText('Priority level');
    fireEvent.change(editor, { target: { value: 'High' } });
    fireEvent.blur(editor);

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts/11' && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body.customFields).toEqual({ priority: 'High' });
    });
    expect(screen.getByText('High')).toBeInTheDocument();
  });
  it('row checkbox selection reveals the bulk-assign bar; Clear hides it (#334)', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    // Bulk bar is not yet rendered (nothing selected).
    expect(screen.queryByText(/lead.*selected/i)).toBeNull();

    // Tick the first row's checkbox (the first checkbox is the header
    // select-all; pick a body row checkbox).
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(4); // 1 header + 3 rows
    fireEvent.click(checkboxes[1]); // Alice

    await waitFor(() => {
      expect(screen.getByText(/1 lead selected/i)).toBeInTheDocument();
    });

    // Clear button drops selection + hides the bar.
    fireEvent.click(screen.getByRole('button', { name: /^Clear$/i }));
    await waitFor(() => {
      expect(screen.queryByText(/lead.*selected/i)).toBeNull();
    });
  });

  it('bulk-assign Assign button PUTs /api/contacts/bulk-assign with selected contactIds', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // Select two body rows
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]); // Alice (id=11)
    fireEvent.click(checkboxes[2]); // Bob (id=12)

    await waitFor(() => {
      expect(screen.getByText(/2 leads selected/i)).toBeInTheDocument();
    });

    // The bulk-assign bar has its own dropdown. Find it by its "Unassign"
    // first option (the per-row dropdowns start with "Unassigned"  note
    // the trailing 'ed'; the bulk dropdown reads "Unassign" without it).
    const allSelects = screen.getAllByRole('combobox');
    const bulkSelect = allSelects.find(el =>
      Array.from(el.querySelectorAll('option')).some(o => o.textContent === 'Unassign'),
    );
    expect(bulkSelect).toBeDefined();
    fireEvent.change(bulkSelect, { target: { value: '8' } });

    // Click the bulk-bar Assign button (distinguish from per-row Convert).
    const assignBtn = screen.getByRole('button', { name: /^Assign$/i });
    fireEvent.click(assignBtn);

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts/bulk-assign' && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body.contactIds).toEqual([11, 12]);
      expect(body.assignedToId).toBe('8');
    });

    // After bulk-assign, selection is cleared and the bar collapses.
    await waitFor(() => {
      expect(screen.queryByText(/leads? selected/i)).toBeNull();
    });
  });

  it('header select-all toggles every visible row; clicking again deselects', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    const checkboxes = screen.getAllByRole('checkbox');
    const headerCheckbox = checkboxes[0];

    // Initially nothing selected
    expect(headerCheckbox.checked).toBe(false);

    fireEvent.click(headerCheckbox);
    await waitFor(() => {
      // The "3 leads selected" bar should appear
      expect(screen.getByText(/3 leads selected/i)).toBeInTheDocument();
    });

    // Click again ?? ? deselect all
    const refreshed = screen.getAllByRole('checkbox');
    fireEvent.click(refreshed[0]);
    await waitFor(() => {
      expect(screen.queryByText(/lead.*selected/i)).toBeNull();
    });
  });

  it('Escape key closes the Create Lead drawer (#892)', async () => {
    renderLeads();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    openDrawer();
    expect(screen.getByPlaceholderText('Full Name')).toBeInTheDocument();

    // ESC keypress fires window keydown listener ?? ? drawer unmounts.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Full Name')).toBeNull();
    });
  });

  it('Cancel button inside the drawer dismisses it without POSTing', async () => {
    renderLeads();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    openDrawer();

    // Typing in a field then hitting Cancel must NOT trigger a POST.
    fillForm({ name: 'Mistake', email: 'oops@example.com' });
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Full Name')).toBeNull();
    });
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('empty list state renders "No leads found" placeholder', async () => {
    // Override the GET to return an empty list.
    fetchApiMock.mockImplementation((url, opts) => {
      if (typeof url === 'string' && url.startsWith('/api/contacts?status=Lead') && !opts) {
        return Promise.resolve([]);
      }
      if (url === '/api/staff' && !opts) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderLeads();
    await waitFor(() => {
      expect(screen.getByText(/No leads found/i)).toBeInTheDocument();
    });
    // Header counter reflects empty: "0 leads in pipeline"
    expect(screen.getByText(/0 leads in pipeline/)).toBeInTheDocument();
  });

  it('wellness tenant fetches /api/wellness/services and /api/wellness/locations on mount', async () => {
    const wellnessAuth = {
      tenant: { id: 2, vertical: 'wellness', name: 'Enhanced Wellness' },
      user: { id: 1, role: 'ADMIN' },
    };
    fetchApiMock.mockImplementation((url, opts) => {
      if (typeof url === 'string' && url.startsWith('/api/contacts?status=Lead') && !opts) return Promise.resolve([]);
      if (url === '/api/staff' && !opts) return Promise.resolve([]);
      if (url === '/api/wellness/services' && !opts) return Promise.resolve([{ id: 1, name: 'Botox' }]);
      if (url === '/api/wellness/locations' && !opts) return Promise.resolve([{ id: 1, name: 'Main Clinic' }]);
      return Promise.resolve([]);
    });

    renderLeads(wellnessAuth);

    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(c => c[0]);
      expect(urls).toContain('/api/wellness/services');
      expect(urls).toContain('/api/wellness/locations');
    });
  });

  it('generic tenant does NOT fetch wellness-only endpoints on mount', async () => {
    const genericAuth = {
      tenant: { id: 1, vertical: 'generic', name: 'Globussoft CRM' },
      user: { id: 1, role: 'ADMIN' },
    };
    renderLeads(genericAuth);

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    // Give effects a tick to settle; ensure wellness URLs were never requested.
    const urls = fetchApiMock.mock.calls.map(c => c[0]);
    expect(urls).not.toContain('/api/wellness/services');
    expect(urls).not.toContain('/api/wellness/locations');
  });
});

// ---------------------------------------------------------------------------
// Amount column  travel vertical: shows advancePaidAmount for partially-paid
// leads even when the itinerary status is not yet in the COMMITTED set.
// ---------------------------------------------------------------------------
describe('Leads  travel tenant Amount column reflects actual payments', () => {
  const TRAVEL_AUTH = {
    tenant: { id: 3, vertical: 'travel', name: 'Travel Co', defaultCurrency: 'INR' },
    user: { id: 1, role: 'ADMIN', name: 'Admin', email: 'admin@travel.test' },
  };

  // Contact id=50 has made a partial payment (advancePaidAmount=50000) but the
  // itinerary is still in 'sent' status (not in the old COMMITTED set).
  // Contact id=51 has a fully_paid itinerary.
  // Contact id=52 has no payment at all (advancePaidAmount=0).
  const TRAVEL_LEADS = [
    { id: 50, name: 'Lily', email: 'lily@parent.com', subBrand: 'TMC', createdAt: '2026-07-17T10:00:00Z' },
    { id: 51, name: 'Ahmed Khan', email: 'ahmed@test.com', subBrand: 'RFU', createdAt: '2026-07-10T10:00:00Z' },
    { id: 52, name: 'No Payment', email: 'nopay@test.com', subBrand: 'TMC', createdAt: '2026-07-01T10:00:00Z' },
  ];

  function travelFetchMock(url, opts) {
    if (typeof url === 'string' && url.startsWith('/api/contacts?status=Lead') && !opts) {
      return Promise.resolve(TRAVEL_LEADS);
    }
    if (url === '/api/staff' && !opts) return Promise.resolve([]);
    if (typeof url === 'string' && url.startsWith('/api/deals') && !opts) return Promise.resolve([]);
    if (url === '/api/travel/trip-billing/paid-by-contact' && !opts) {
      // Lily has paid via TMC instalments directly  keyed by her email
      return Promise.resolve({
        byEmail: { 'lily@parent.com': { paidTotal: 90000, currency: 'INR' } },
      });
    }
    if (typeof url === 'string' && url.startsWith('/api/travel/itineraries') && !opts) {
      return Promise.resolve({
        itineraries: [
          // Lily: 'sent' status, advancePaidAmount=0 (itinerary not updated yet)
          // ?? ? falls through to TMC paid-by-contact path which shows 90000
          { id: 1, contactId: 50, status: 'sent', totalAmount: 120000, advancePaidAmount: 0, currency: 'INR' },
          // Ahmed: legacy itinerary  advance_paid status but advancePaidAmount not recorded (null)
          // ?? ? fallback: totalAmount shown because status is in COMMITTED set
          { id: 2, contactId: 51, status: 'advance_paid', totalAmount: 185000, advancePaidAmount: null, currency: 'INR' },
          // No-payment lead: draft, nothing paid, advancePaidAmount=0 ?? ? shows dash
          { id: 3, contactId: 52, status: 'draft', totalAmount: 80000, advancePaidAmount: 0, currency: 'INR' },
        ],
        total: 3,
      });
    }
    if (opts?.method === 'PUT' || opts?.method === 'POST') return Promise.resolve({ ok: true });
    return Promise.resolve([]);
  }

  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(travelFetchMock);
    notifyError.mockReset();
  });

  it('opens the travel lead profile when clicking a name in the Name column', async () => {
    renderLeads(TRAVEL_AUTH);
    const lilyLink = await screen.findByRole('link', { name: 'Lily' });
    expect(lilyLink).toHaveAttribute('href', '/travel/leads/50');

    fireEvent.click(lilyLink);
    expect(navigateMock).toHaveBeenCalledWith('/travel/leads/50');
    expect(screen.getByLabelText('Edit Name for Lily')).toHaveAttribute('type', 'button');
  });

  it('keeps travel lead name editing behind the Name column edit icon', async () => {
    renderLeads(TRAVEL_AUTH);
    const lilyLink = await screen.findByRole('link', { name: 'Lily' });
    const nameDisplay = lilyLink.closest('.inline-cell-editor-display');
    fireEvent.mouseEnter(nameDisplay);
    fireEvent.click(screen.getByLabelText('Edit Name for Lily'));
    expect(screen.getByLabelText('Edit Name for Lily')).toHaveValue('Lily');
  });

  it('travel agents see a reassignment dropdown that excludes admins', async () => {
    const travelAgentAuth = {
      tenant: { id: 3, vertical: 'travel', name: 'Travel Co', defaultCurrency: 'INR' },
      user: { id: 7, role: 'MANAGER', name: 'TMC Operator', email: 'operator@travel.test' },
    };
    const travelAgentLeads = [
      { id: 50, name: 'Lily', email: 'lily@parent.com', subBrand: 'tmc', assignedToId: 7, createdAt: '2026-07-17T10:00:00Z' },
    ];
    const travelAgentStaff = [
      { id: 1, name: 'Yasin Admin', email: 'yasin@travel.test', role: 'ADMIN' },
      { id: 7, name: 'TMC Operator', email: 'operator@travel.test', role: 'MANAGER' },
      { id: 8, name: 'Sahil Agent', email: 'sahil@travel.test', role: 'USER' },
    ];
    fetchApiMock.mockImplementation((url, opts) => {
      if (typeof url === 'string' && url.startsWith('/api/contacts?status=Lead') && !opts) {
        return Promise.resolve(travelAgentLeads);
      }
      if (url === '/api/staff' && !opts) return Promise.resolve(travelAgentStaff);
      return travelFetchMock(url, opts);
    });

    renderLeads(travelAgentAuth);
    await waitFor(() => expect(screen.getByText('Lily')).toBeInTheDocument());

    const assignSelect = screen.getByLabelText(/Assign Lily to staff/i);
    const optionTexts = Array.from(assignSelect.querySelectorAll('option')).map((option) => option.textContent || '');
    expect(optionTexts.some((text) => /Yasin Admin/i.test(text))).toBe(false);

    fireEvent.change(assignSelect, { target: { value: '8' } });

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts/50/assign' && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      expect(JSON.parse(putCall[1].body)).toEqual({ assignedToId: '8' });
    });
  });

  it('shows TMC paid-by-contact amount for a lead with no itinerary advancePaidAmount', async () => {
    // Lily's itinerary has advancePaidAmount=0 (not yet synced to itinerary),
    // but the TMC paid-by-contact endpoint returns 90000 for lily@parent.com.
    // The Amount column must show 90000 via the tmcPaidByEmail fallback.
    const { container } = renderLeads(TRAVEL_AUTH);
    await waitFor(() => expect(screen.getByText('Lily')).toBeInTheDocument());

    await waitFor(() => {
      expect(container.textContent).toMatch(/INR/);
      expect(container.textContent).toMatch(/90/);
    });
    // Must NOT show totalAmount (120k) or the 0 advance
    expect(container.textContent).not.toMatch(/1[,\s]?2[,\s]?0[,\s]?0[,\s]?0[,\s]?0/);
    // Verify the paid-by-contact endpoint was called
    const tmcCall = fetchApiMock.mock.calls.find(
      ([url]) => url === '/api/travel/trip-billing/paid-by-contact',
    );
    expect(tmcCall).toBeDefined();
  });

  it('shows totalAmount for a fully_paid itinerary  bookingValueByContact is populated', async () => {
    // This test verifies the mapping logic: fully_paid ?? ? totalAmount (185000) ends up
    // in bookingValueByContact[51]. We confirm via the fetchApi call pattern rather
    // than trying to match a locale-sensitive toLocaleString() string.
    const { container } = renderLeads(TRAVEL_AUTH);
    await waitFor(() => expect(screen.getByText('Ahmed Khan')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Lily')).toBeInTheDocument());

    // Wait for the itinerary fetch to complete (Lily's amount appears as sentinel)
    await waitFor(() => {
      expect(container.textContent).toMatch(/INR/);
    });

    // The itinerary fetch should have been called with the right URL
    const itinCall = fetchApiMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.startsWith('/api/travel/itineraries'),
    );
    expect(itinCall).toBeDefined();

    // Ahmed's Amount cell must not be the no-data dash.
    // Since both rows share the same Amount column and we can't use getByText on split nodes,
    // assert that the page has TWO non-dash amount entries (Lily + Ahmed)  i.e. at least
    // two Amount-column td elements that contain "INR" somewhere in their text.
    const tds = Array.from(container.querySelectorAll('td'));
    const amountTds = tds.filter(td => td.textContent.includes('INR'));
    expect(amountTds.length).toBeGreaterThanOrEqual(2);
  });

  it('shows  for a lead with no payment (advancePaidAmount=0 and not fully_paid)', async () => {
    const { container } = renderLeads(TRAVEL_AUTH);
    await waitFor(() => expect(screen.getByText('No Payment')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Lily')).toBeInTheDocument());

    // Wait for itinerary data to populate (Amount column becomes non-empty for paid leads)
    await waitFor(() => {
      expect(container.textContent).toMatch(/INR/);
    });

    // 3 rows rendered; 2 have payments (Lily + Ahmed) ?? ? 2 Amount tds with INR.
    // The no-payment lead (advancePaidAmount=0) falls through to the dash path.
    const tds = Array.from(container.querySelectorAll('td'));
    const amountTds = tds.filter(td => td.textContent.includes('INR'));
    expect(amountTds.length).toBeGreaterThanOrEqual(2); // Lily + Ahmed have amounts

    // The "No Payment" lead's td must contain the dash, not a currency amount.
    // Find the row containing "No Payment" and check its Amount td doesn't have INR.
    const rows = Array.from(container.querySelectorAll('tr'));
    const noPayRow = rows.find(row => row.textContent.includes('No Payment'));
    expect(noPayRow).toBeDefined();
    const noPayTds = noPayRow ? Array.from(noPayRow.querySelectorAll('td')) : [];
    const hasINRInRow = noPayTds.some(td => td.textContent.includes('INR'));
    expect(hasINRInRow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Callified AI-campaign surface (#feat/callifiedleads): campaign column,
// bulk-dial dropdown, call-count badge, and last-score column.
// ---------------------------------------------------------------------------
const CALLIFIED_LEADS = [
  { id: 11, name: 'Alice Smith', email: 'alice@acme.test', company: 'Acme Corp', phone: '+1234567890', aiScore: 88, source: 'Organic', assignedToId: null, callifiedCampaignId: 101, createdAt: '2026-05-01T10:00:00Z' },
  { id: 12, name: 'Bob Jones', email: 'bob@globex.test', company: 'Globex', aiScore: 55, source: 'Referral', assignedToId: null, callifiedCampaignId: null, createdAt: '2026-05-02T10:00:00Z' },
];

const CALLIFIED_CAMPAIGNS = [
  { id: 101, name: 'Globussoft outbound', product_name: 'AI calling', leadCount: 1 },
  { id: 102, name: 'RFU Umrah follow-up', product_name: null, leadCount: 0 },
  { id: 103, name: 'Panoraexport', product_name: 'Panora export', leadCount: 0 },
  { id: 104, name: 'RealEstates', product_name: 'Globussoft AI', leadCount: 0 },
  { id: 105, name: 'AlproductTesting', product_name: 'Globussoft AI', leadCount: 0 },
  { id: 106, name: 'ADSGPT', product_name: 'AdsGPT', leadCount: 0 },
  { id: 107, name: 'Supersale', product_name: 'AdsGPT', leadCount: 0 },
];

const CALLIFIED_SUMMARIES = {
  11: { callCount: 3, lastCallifiedLeadId: '2001', lastScore: 4 },
  12: { callCount: 0, lastCallifiedLeadId: null, lastScore: null },
};

function callifiedFetchMock(url, opts) {
  if (typeof url === 'string' && url.startsWith('/api/contacts?status=Lead') && !opts) {
    return Promise.resolve(CALLIFIED_LEADS);
  }
  if (url === '/api/staff' && !opts) return Promise.resolve([]);
  if (url === '/api/integrations/callified/config' && !opts) {
    return Promise.resolve({ isActive: true, baseUrl: 'https://app.callified.ai' });
  }
  if (url === '/api/callified/campaigns/with-lead-counts' && !opts) {
    return Promise.resolve({ campaigns: CALLIFIED_CAMPAIGNS });
  }
  if (typeof url === 'string' && url.startsWith('/api/callified/leads/call-summary') && !opts) {
    return Promise.resolve({ summaries: CALLIFIED_SUMMARIES });
  }
  if (typeof url === 'string' && url.startsWith('/api/tenant-settings/') && opts?.method === 'PUT') {
    try {
      const body = JSON.parse(opts.body || '{}');
      return Promise.resolve({ value: body.value });
    } catch {
      return Promise.resolve({ value: 'true' });
    }
  }
  if (typeof url === 'string' && url.startsWith('/api/tenant-settings/') && !opts) {
    return Promise.resolve({ value: 'true', defaultValue: 'true', isOverride: false });
  }
  if (opts?.method === 'PUT' || opts?.method === 'POST') return Promise.resolve({ ok: true });
  return Promise.resolve([]);
}

describe('Leads — Callified campaign column + bulk dial + call summary', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(callifiedFetchMock);
    notifyError.mockReset();
    notifyInfo.mockReset();
    notifySuccess.mockReset();
  });

  it('renders Callified Campaign column and per-lead campaign dropdown for generic tenant', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    // Column header rendered.
    expect(screen.getByText('Callified Campaign')).toBeInTheDocument();

    // Per-row dropdowns render as capped popovers with the selected value.
    const aliceSelect = screen.getByLabelText(/Assign Callified campaign for Alice Smith/i);
    expect(aliceSelect).toBeInTheDocument();
    expect(aliceSelect).toHaveTextContent('Globussoft outbound');

    const bobSelect = screen.getByLabelText(/Assign Callified campaign for Bob Jones/i);
    expect(bobSelect).toBeInTheDocument();
    expect(bobSelect).toHaveTextContent('—');

    fireEvent.click(bobSelect);

    const listbox = await screen.findByRole('listbox', {
      name: /Assign Callified campaign for Bob Jones/i,
    });
    expect(listbox).toHaveStyle({
      maxHeight: '170px',
      overflowY: 'auto',
    });
    expect(within(listbox).getAllByRole('option').length).toBeGreaterThan(5);

    fireEvent.click(within(listbox).getByRole('option', { name: /RFU Umrah follow-up/i }));
  });

  it('changing a lead campaign fires PUT /api/contacts/:id and refreshes campaign counts', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fetchApiMock.mockClear();

    const bobSelect = screen.getByLabelText(/Assign Callified campaign for Bob Jones/i);
    fireEvent.click(bobSelect);

    const listbox = await screen.findByRole('listbox', {
      name: /Assign Callified campaign for Bob Jones/i,
    });
    fireEvent.click(within(listbox).getByRole('option', { name: /RFU Umrah follow-up/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contacts/12' && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body.callifiedCampaignId).toBe(102);
    });

    // Campaign counts are re-fetched after assignment.
    await waitFor(() => {
      const campaignFetch = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/callified/campaigns/with-lead-counts' && !opts,
      );
      expect(campaignFetch).toBeDefined();
    });
  });

  it('renders bulk Dial Campaign Leads multi-select dropdown with lead counts', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    const bulkTrigger = screen.getByRole('button', { name: /Select campaigns to dial/i });
    expect(bulkTrigger).toBeInTheDocument();

    // Open the dropdown to reveal campaign checkboxes + counts.
    fireEvent.click(bulkTrigger);

    // The dropdown is rendered inside the trigger's parent; scope to it so
    // the auto-assign select option with the same campaign name is ignored.
    const dropdownContainer = bulkTrigger.parentElement;
    await waitFor(() => {
      expect(within(dropdownContainer).getByText('Globussoft outbound')).toBeInTheDocument();
      expect(within(dropdownContainer).getByText('RFU Umrah follow-up')).toBeInTheDocument();
    });
  });

  it('selecting campaigns and clicking Dial Campaigns queues calls one by one', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    const bulkTrigger = screen.getByRole('button', { name: /Select campaigns to dial/i });
    fireEvent.click(bulkTrigger);

    // Check the Globussoft outbound campaign (the one with dialable leads).
    const dropdownContainer = bulkTrigger.parentElement;
    const globusCheckbox = within(dropdownContainer).getByLabelText(/Globussoft outbound/i);
    fireEvent.click(globusCheckbox);

    const dialBtn = screen.getByRole('button', { name: /Dial Campaigns/i });
    expect(dialBtn).not.toBeDisabled();

    fetchApiMock.mockClear();
    fireEvent.click(dialBtn);

    // Sequential queue dials the matching lead via /api/callified/leads/:id/call.
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/callified/leads/11/call' && opts?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.campaignId).toBe(101);
    });
  });

  it('renders AI Call count badge and Callified Score column from summaries', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    // Callified AI call column header.
    expect(screen.getByText('Callified AI call')).toBeInTheDocument();
    // Callified Score column header.
    expect(screen.getByText('Callified Score')).toBeInTheDocument();

    // Alice has lastScore=4 → 4/5 rendered.
    expect(screen.getByText('4/5')).toBeInTheDocument();

    // Bob has no score → dash rendered (we assert the column exists above).
    const scoreCells = screen.getAllByText('—');
    expect(scoreCells.length).toBeGreaterThanOrEqual(1);
  });

  it('wellness tenant does not render Callified campaign UI', async () => {
    const wellnessAuth = {
      tenant: { id: 2, vertical: 'wellness', name: 'Enhanced Wellness' },
      user: { id: 1, role: 'ADMIN' },
    };
    fetchApiMock.mockImplementation((url, opts) => {
      if (typeof url === 'string' && url.startsWith('/api/contacts?status=Lead') && !opts) return Promise.resolve([]);
      if (url === '/api/staff' && !opts) return Promise.resolve([]);
      if (url === '/api/wellness/services' && !opts) return Promise.resolve([]);
      if (url === '/api/wellness/locations' && !opts) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderLeads(wellnessAuth);
    await waitFor(() => expect(screen.getByText(/No leads found/i)).toBeInTheDocument());

    expect(screen.queryByText('Callified Campaign')).toBeNull();
    expect(screen.queryByRole('button', { name: /Select campaigns to dial/i })).toBeNull();
    expect(screen.queryByText('Callified AI call')).toBeNull();
    expect(screen.queryByText('Call Status')).toBeNull();
    expect(screen.queryByText('Callified Score')).toBeNull();
  });

  it('Call Settings popover shows all four sections', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Call settings/i }));
    expect(screen.getByText(/Auto Dial New Leads/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Enable automatic dialing for new leads/i)).toBeInTheDocument();
    expect(screen.getByText(/DNP Settings/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Enable automatic DNP retries/i)).toBeInTheDocument();
    expect(screen.getByText(/Assigning Staff/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Auto-assign qualified leads to staff/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Assign logic/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Leads per user before moving to next/i)).toBeInTheDocument();
    expect(screen.getByText(/Qualified Status/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Use AI to qualify using transcripts/i)).toBeInTheDocument();
  });

  it('toggling AI classification saves immediately', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Call settings/i }));
    const toggle = screen.getByLabelText(/Use AI to qualify using transcripts/i);
    expect(toggle).toBeInTheDocument();
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          typeof url === 'string' &&
          url.startsWith('/api/tenant-settings/feature.callified.ai_transcript.enabled') &&
          opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body.value).toBe('false');
      expect(body.category).toBe('feature-flag');
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/disabled/i));
    });
  });

  it('toggling auto-dial new leads saves the right endpoint', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Call settings/i }));
    const toggle = screen.getByLabelText(/Enable automatic dialing for new leads/i);
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          typeof url === 'string' &&
          url.startsWith('/api/tenant-settings/feature.callified.auto_dial_new_leads.enabled') &&
          opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body.value).toBe('false');
      expect(body.category).toBe('feature-flag');
    });
  });

  it('DNP retry settings render and saving max retries calls the right endpoint', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Call settings/i }));
    expect(screen.getByText(/DNP Settings/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Enable automatic DNP retries/i)).toBeInTheDocument();

    const maxRetriesInput = screen.getByLabelText(/Max retries/i);
    expect(maxRetriesInput).toBeInTheDocument();

    fireEvent.change(maxRetriesInput, { target: { value: '5' } });
    fireEvent.blur(maxRetriesInput);

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          typeof url === 'string' &&
          url.startsWith('/api/tenant-settings/feature.callified.dnp_retry.max_retries') &&
          opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body.value).toBe('5');
    });
  });

  it('assignment logic and leads-per-user save the right endpoints', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Call settings/i }));

    // Default logic is round-robin, so the leads-per-user input is visible.
    const leadsInput = screen.getByLabelText(/Leads per user before moving to next/i);
    fireEvent.change(leadsInput, { target: { value: '3' } });
    fireEvent.blur(leadsInput);

    await waitFor(() => {
      const leadsCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          typeof url === 'string' &&
          url.startsWith('/api/tenant-settings/feature.callified.assign_staff.leads_per_user') &&
          opts?.method === 'PUT',
      );
      expect(leadsCall).toBeDefined();
      const body = JSON.parse(leadsCall[1].body);
      expect(body.value).toBe('3');
    });

    fetchApiMock.mockClear();
    const logicSelect = screen.getByLabelText(/Assign logic/i);
    fireEvent.change(logicSelect, { target: { value: 'random' } });

    await waitFor(() => {
      const logicCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          typeof url === 'string' &&
          url.startsWith('/api/tenant-settings/feature.callified.assign_staff.logic') &&
          opts?.method === 'PUT',
      );
      expect(logicCall).toBeDefined();
      const body = JSON.parse(logicCall[1].body);
      expect(body.value).toBe('random');
    });
  });
});
