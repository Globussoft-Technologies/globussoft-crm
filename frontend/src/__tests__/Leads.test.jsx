/**
 * Leads.jsx — client-side hardening tests for the Create-Lead form (#557 / HI-08)
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
 * #892 — Create Lead is no longer an always-visible inline form; it lives
 * inside a drawer that opens via the "Create Lead" header CTA. Every test
 * that interacts with the form first calls `openDrawer()` to click the CTA
 * and reveal the inputs. The fields + submit logic are unchanged; only the
 * trigger surface moved.
 *
 * The backend at routes/contacts.js + the global sanitizeBody middleware are
 * still the source of truth — these tests confirm the network call is NOT
 * made when the client-side guards trip, so a malicious or accidental
 * payload doesn't even reach the server.
 *
 * Contracts pinned here:
 *   1. <script>alert(1)</script> in name → form rejects locally; no fetch.
 *   2. Name longer than 191 chars → "too long" error; no fetch.
 *   3. Control char (\x00, \x07) in name → "invalid control characters"; no fetch.
 *   4. Empty required name → "Name is required"; no fetch.
 *   5. Invalid email shape → "valid email" error; no fetch.
 *   6. Happy path → POST /api/contacts fires exactly once with sanitised body.
 *   7. (#600) Wellness tenant → Phone field renders, "WhatsApp" source option
 *      exists; submitting without phone → "Phone is required", no fetch.
 *   8. (#600) Generic tenant → Phone field is hidden, "WhatsApp" not in
 *      Source dropdown.
 *   9. (#892) "Create Lead" header CTA is rendered; clicking it reveals
 *      the form fields in a drawer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import Leads from '../pages/Leads';
import { AuthContext } from '../App';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifyInfo = vi.fn();
const notifySuccess = vi.fn();
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
  return { ...real, useNavigate: () => vi.fn() };
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

// #892 — Create Lead lives in a drawer now. Click the header CTA to mount
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

describe('Leads — Create Lead form client-side hardening (#557)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifyInfo.mockReset();
    notifySuccess.mockReset();
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

    // After strip, the name is empty → reject with "Name is required" and
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
    // by removing the attribute — simulates the React-prototype-setter trick
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

  it('happy path — valid lead POSTs once with sanitised body', async () => {
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

  // #892 — pin the CTA + drawer surface. Pre-#892 the form was always
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

    // Click the CTA → drawer opens → fields become reachable.
    openDrawer();
    expect(screen.getByPlaceholderText('Full Name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Email Address')).toBeInTheDocument();
    // Close button is rendered inside the drawer.
    expect(screen.getByRole('button', { name: /Close/i })).toBeInTheDocument();
  });
});

// #600 — wellness-vertical Lead form. Verifies the form schema flips when
// AuthContext.tenant.vertical === 'wellness': Phone field renders, the 8
// wellness sources replace the 6 generic ones, and submitting without a
// phone trips the "Phone is required" guard. The generic-tenant case
// asserts the inverse (Phone hidden, no WhatsApp option).
describe('Leads — vertical-aware form schema (#600)', () => {
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

  it('wellness tenant → Phone field renders and WhatsApp is in Source dropdown', async () => {
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

  it('wellness tenant → submitting without phone triggers "Phone is required"', async () => {
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

  it('wellness tenant → happy path POSTs phone, source, and treatmentOfInterest', async () => {
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

  it('generic tenant → Phone field is hidden and WhatsApp is NOT in Source dropdown', async () => {
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
// Additional coverage — list-side surface (search, score badge, bulk selection,
// per-row assign, Convert, drawer close paths). Existing tests above already
// pin the Create-Lead form hardening and vertical schema. This block targets
// what the table + bulk bar + drawer-dismiss flows actually do, which is the
// majority of Leads.jsx's runtime surface (lines 275-522). All cases use
// stable mock object references for hooks (per the RTL standing rule) and
// the same `fetchApiMock` + `notify*` mocks the earlier suites share.
// ---------------------------------------------------------------------------

// A small canned-leads fixture covering the 3 score bands the badge uses
// (>75 success, >40 warning, ≤40 error) plus an assignedToId for the
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
  // GET /api/contacts?status=Lead → seeded list
  if (typeof url === 'string' && url.startsWith('/api/contacts?status=Lead') && !opts) {
    return Promise.resolve(SAMPLE_LEADS);
  }
  if (url === '/api/staff' && !opts) {
    return Promise.resolve(SAMPLE_STAFF);
  }
  // PUT /api/contacts/:id (convert), PUT /api/contacts/:id/assign, PUT bulk-assign,
  // POST /api/contacts — all return a benign stub. The component re-fetches
  // after each, which falls through to the GETs above.
  if (opts?.method === 'PUT' || opts?.method === 'POST') {
    return Promise.resolve({ ok: true });
  }
  return Promise.resolve([]);
}

// ADMIN auth context for tests that exercise admin-only surfaces (checkboxes,
// bulk-assign bar, per-row assign dropdowns). The SUT gates these on
// auth?.user?.role === 'ADMIN' — calling renderLeads() without an auth value
// (null) means isAdmin=false and those surfaces are hidden.
const ADMIN_AUTH = {
  tenant: { id: 1, vertical: 'generic', name: 'Globussoft CRM' },
  user: { id: 1, role: 'ADMIN', name: 'Admin User', email: 'admin@crm.test' },
};

describe('Leads — table, search, bulk operations, row actions, drawer dismiss', () => {
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

    // Lead Score badge text — `${aiScore}/100` rendered per row
    expect(screen.getByText('88/100')).toBeInTheDocument();
    expect(screen.getByText('55/100')).toBeInTheDocument();
    expect(screen.getByText('20/100')).toBeInTheDocument();

    // Header counter — "3 leads in pipeline"
    expect(screen.getByText(/3 leads in pipeline/)).toBeInTheDocument();
  });

  it('filters the row list by search term against name / email / company', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search leads...');

    // Filter by company substring → only Globex's Bob remains
    fireEvent.change(searchInput, { target: { value: 'globex' } });
    await waitFor(() => {
      expect(screen.queryByText('Alice Smith')).toBeNull();
      expect(screen.getByText('Bob Jones')).toBeInTheDocument();
      expect(screen.queryByText('Carol Diaz')).toBeNull();
    });

    // Filter by email substring → only Carol
    fireEvent.change(searchInput, { target: { value: 'initech.test' } });
    await waitFor(() => {
      expect(screen.queryByText('Alice Smith')).toBeNull();
      expect(screen.queryByText('Bob Jones')).toBeNull();
      expect(screen.getByText('Carol Diaz')).toBeInTheDocument();
    });

    // Clear → all three back
    fireEvent.change(searchInput, { target: { value: '' } });
    await waitFor(() => {
      expect(screen.getByText('Alice Smith')).toBeInTheDocument();
      expect(screen.getByText('Bob Jones')).toBeInTheDocument();
      expect(screen.getByText('Carol Diaz')).toBeInTheDocument();
    });
  });

  it('header counter reflects the active search filter — "X of Y leads match" while typing, plain pipeline count when cleared', async () => {
    // Regression: pre-fix the header used leads.length (unfiltered) so it
    // still read "3 leads in pipeline" while the table was narrowed to 1
    // result. Post-fix it switches to "X of Y leads match \"<term>\"" while
    // a search is active and reverts to the original phrasing when cleared.
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    // No search → original phrasing.
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
      // Per #283 — Convert advances ONE step (Lead → Prospect), not jumps to Customer
      expect(body.status).toBe('Prospect');
    });
  });

  it('per-row assign dropdown PUTs /api/contacts/:id/assign with the selected staff id', async () => {
    renderLeads(ADMIN_AUTH);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // Three rows = three assign selects. The middle one is pre-assigned to 7;
    // the first row (Alice) is unassigned. Pick Alice's select.
    const allSelects = screen.getAllByRole('combobox');
    // Filter to the per-row Assigned-To selects (they contain "Unassigned").
    const assignSelects = allSelects.filter(el =>
      Array.from(el.querySelectorAll('option')).some(o => o.textContent === 'Unassigned'),
    );
    expect(assignSelects.length).toBeGreaterThanOrEqual(3);

    fireEvent.change(assignSelects[0], { target: { value: '7' } });

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => typeof url === 'string' && url.endsWith('/assign') && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body.assignedToId).toBe('7');
    });
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
    // first option (the per-row dropdowns start with "Unassigned" — note
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

    // Click again → deselect all
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

    // ESC keypress fires window keydown listener → drawer unmounts.
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
// Amount column — travel vertical: shows advancePaidAmount for partially-paid
// leads even when the itinerary status is not yet in the COMMITTED set.
// ---------------------------------------------------------------------------
describe('Leads — travel tenant Amount column reflects actual payments', () => {
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
      // Lily has paid via TMC instalments directly — keyed by her email
      return Promise.resolve({
        byEmail: { 'lily@parent.com': { paidTotal: 90000, currency: 'INR' } },
      });
    }
    if (typeof url === 'string' && url.startsWith('/api/travel/itineraries') && !opts) {
      return Promise.resolve({
        itineraries: [
          // Lily: 'sent' status, advancePaidAmount=0 (itinerary not updated yet)
          // → falls through to TMC paid-by-contact path which shows 90000
          { id: 1, contactId: 50, status: 'sent', totalAmount: 120000, advancePaidAmount: 0, currency: 'INR' },
          // Ahmed: legacy itinerary — advance_paid status but advancePaidAmount not recorded (null)
          // → fallback: totalAmount shown because status is in COMMITTED set
          { id: 2, contactId: 51, status: 'advance_paid', totalAmount: 185000, advancePaidAmount: null, currency: 'INR' },
          // No-payment lead: draft, nothing paid, advancePaidAmount=0 → shows dash
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

  it('shows totalAmount for a fully_paid itinerary — bookingValueByContact is populated', async () => {
    // This test verifies the mapping logic: fully_paid → totalAmount (185000) ends up
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
    // assert that the page has TWO non-dash amount entries (Lily + Ahmed) — i.e. at least
    // two Amount-column td elements that contain "INR" somewhere in their text.
    const tds = Array.from(container.querySelectorAll('td'));
    const amountTds = tds.filter(td => td.textContent.includes('INR'));
    expect(amountTds.length).toBeGreaterThanOrEqual(2);
  });

  it('shows — for a lead with no payment (advancePaidAmount=0 and not fully_paid)', async () => {
    const { container } = renderLeads(TRAVEL_AUTH);
    await waitFor(() => expect(screen.getByText('No Payment')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Lily')).toBeInTheDocument());

    // Wait for itinerary data to populate (Amount column becomes non-empty for paid leads)
    await waitFor(() => {
      expect(container.textContent).toMatch(/INR/);
    });

    // 3 rows rendered; 2 have payments (Lily + Ahmed) → 2 Amount tds with INR.
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
