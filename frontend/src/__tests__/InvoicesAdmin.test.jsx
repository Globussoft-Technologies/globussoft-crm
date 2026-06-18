/**
 * InvoicesAdmin.test.jsx — vitest + RTL coverage for the Travel-vertical
 * invoices admin page (frontend/src/pages/travel/InvoicesAdmin.jsx, shipped
 * tick #98 commit c156df4).
 *
 * Scope — pins page-surface invariants for the Travel invoices CRUD page:
 *   1. Page chrome — heading "Travel Invoices" + filter bar + "New Invoice"
 *      CTA (CTA gated on ADMIN/MANAGER via AuthContext.user.role).
 *   2. Loading state — pre-first-fetch the table region renders "Loading…"
 *      copy; once GET resolves the table replaces it.
 *   3. GET on mount — fires GET /api/travel/invoices with NO querystring when
 *      no filters set; row contents render from the response shape
 *      `{ invoices: [...], total: N }`.
 *   4. Empty-state — zero invoices, `permissionDenied=false` → "No invoices
 *      match." copy renders.
 *   5. Permission-denied empty-state (#829) — 403 from the GET → "Access
 *      restricted." copy renders instead of the no-rows surface.
 *   6. Sub-brand filter — changing the sub-brand <select> appends
 *      `?subBrand=<value>` to the GET URL.
 *   7. Status filter — changing the status <select> appends `?status=<value>`
 *      (read from the literal enum: Draft / Issued / Partial / Paid / Voided).
 *   8. Money formatting — table cell renders the row's totalAmount through
 *      formatMoney with the row's currency (e.g. "₹50,000" for INR).
 *   9. Invoice number display — TINV-YYYY-NNNN format renders verbatim from
 *      the backend response. The serial is BACKEND-assigned (race-safe per
 *      backend/routes/travel_invoices.js tick #97); the test mocks the
 *      formatted string and asserts a verbatim render — does NOT generate
 *      the serial in the test.
 *  10. Sub-brand badge per row — real `travelSubBrand.SUB_BRAND_BG` palette
 *      is consumed (not mocked) so any drift in the canonical sub-brand id
 *      set or palette is caught here.
 *  11. New-invoice modal — clicking "New Invoice" opens the form; submitting
 *      with a valid contactId + totalAmount + currency + dueDate fires
 *      POST /api/travel/invoices with the form payload (status defaults to
 *      Draft; subBrand defaults to "tmc"; quoteId omitted when blank).
 *  12. Delete enforcement — the page-rule "only Draft invoices may be
 *      deleted" is reflected in the UI: Draft rows expose an enabled Trash2
 *      button; Issued/Partial/Paid/Voided rows have it disabled with the
 *      audit-trail tooltip. (Backend is the source of truth — 422
 *      INVOICE_DELETE_FORBIDDEN — but the UI affordance must match.)
 *  13. Per-row PDF download (#901 slice 3, this tick) — every visible row
 *      exposes a "Download PDF for invoice <num>" button. Click fires raw
 *      fetch (NOT fetchApi — the helper JSON-parses; PDFs are binary so we
 *      need the Response object's .blob()) at
 *      GET /api/travel/invoices/:id/pdf with the Bearer auth header,
 *      blobs the response, anchors the result with download=`invoice-:id.pdf`,
 *      then revokes the object URL. Failed responses (4xx / 5xx) fire
 *      notify.error('Failed to download PDF'). Loading state flips the button
 *      to "Downloading…" while in flight + disables the button so a double-
 *      click can't trigger two browser saves of the same blob.
 *
 * Backend contract pinned (per backend/routes/travel_invoices.js, 913 LOC,
 * 10 vitest cases tick #97):
 *   GET    /api/travel/invoices[?subBrand|status|contactId|quoteId]
 *          → 200 { invoices: TravelInvoice[], total: number }
 *          | 403 (USER role on tenants where Travel is locked)
 *   POST   /api/travel/invoices            → 201 { invoice: TravelInvoice }
 *                                            (ADMIN+MANAGER); invoiceNum
 *                                            server-assigned TINV-YYYY-NNNN
 *   PUT    /api/travel/invoices/:id        → 200 { invoice: TravelInvoice }
 *                                            (forward-only status matrix
 *                                            enforced)
 *   DELETE /api/travel/invoices/:id        → 204 (Draft only) | 422
 *                                            INVOICE_DELETE_FORBIDDEN
 *   Status enum (forward-only matrix):
 *     Draft   → Issued | Voided
 *     Issued  → Partial | Paid | Voided
 *     Partial → Paid | Voided
 *     Paid    → Voided
 *     Voided  → (terminal)
 *
 * Drift pinned around (prompt vs. actual code):
 *   - Prompt mentioned "payment-recording flow" — the SUT has NO payment-
 *     recording UI; payments are tracked via PUT status transitions (Issued
 *     → Partial / Paid) NOT a separate amount-paid input. Tests omit any
 *     payment-recording assertions.
 *   - Prompt referenced "status enum draft/sent/paid/etc"; actual enum is
 *     Pascal-case ("Draft" / "Issued" / "Partial" / "Paid" / "Voided") and
 *     uses "Issued" not "sent". Tests pin the real labels.
 *   - SUT's empty-state copy is "No invoices match." (period), NOT "No
 *     invoices found" — pinned verbatim.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dependency, NOT global
 *     fetch).
 *   - useNotify returns a STABLE notifyObj reference for the whole file
 *     (RTL standing rule: fresh per-call objects flap useCallback identity
 *     and cause infinite-render loops).
 *   - travelSubBrand imported REAL (not mocked) so sub-brand-id drift is
 *     caught.
 *   - AuthContext is consumed from the real App module via Provider in the
 *     render wrapper (the SUT reads `user.role` to gate the New/Edit/Delete
 *     buttons). Default user role = ADMIN so canWrite=true; one test mounts
 *     with role=USER to assert the CTA + actions column are hidden.
 *   - Data-dependent assertions use await findBy / waitFor (per CLAUDE.md
 *     tick #108 cron-learning — sync getBy for data-dependent text is a CI
 *     race trap).
 *
 * Path: flat __tests__/ — DO NOT add a __tests__/travel/ subdir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). The SUT closes over notify inside handleSubmit + handleDelete,
// so a fresh object per render would flap state across re-renders.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// Import AuthContext from the real App module + the SUT.
import { AuthContext } from '../App';
import InvoicesAdmin from '../pages/travel/InvoicesAdmin';

// Canonical invoice row (TINV-2026-0001 serial format, Issued status, INR).
function makeInvoice(overrides = {}) {
  return {
    id: 101,
    invoiceNum: 'TINV-2026-0001',
    contactId: 42,
    quoteId: null,
    totalAmount: 50000,
    currency: 'INR',
    status: 'Issued',
    subBrand: 'tmc',
    dueDate: '2026-07-01T00:00:00.000Z',
    paidAt: null,
    createdAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
    ...overrides,
  };
}

// Install a fetchApi mock that routes by URL prefix + method. The /invoices
// GET defaults to a single Issued row; tests opt-in to other surfaces.
// `detail` covers the slice-22 GET /:id?include=lines surface — when an
// editor opens an Issued/Paid invoice the page fetches its lines to
// compute TDS withholding client-side.
function installFetchMock({
  list = { invoices: [makeInvoice()], total: 1 },
  create = { invoice: makeInvoice({ id: 102, invoiceNum: 'TINV-2026-0002', status: 'Draft' }) },
  update = { invoice: makeInvoice() },
  remove = null,
  detail = null,
  // S56 — cancel-preview + void surfaces. Default `preview` = an OK
  // response with a 50% TMC Default tier; tests opt-in to NO_POLICY_RESOLVED
  // or Error to exercise the warning + error branches.
  preview = {
    invoiceId: 101,
    status: 'Issued',
    policyApplied: { policyId: 7, policyName: 'TMC Default', tier: 0, refundPercent: 50 },
    refundAmount: 25000,
    refundPercent: 50,
    daysBeforeServiceStart: 14,
    serviceStartDate: '2026-07-15T00:00:00.000Z',
    reason: 'OK',
  },
  voidResp = {
    id: 101,
    invoiceNum: 'TINV-2026-0001',
    status: 'Voided',
    creditNote: null,
    policyApplied: null,
  },
  // Default contact book for the customer <select> in the create/edit modal.
  // Intentionally does NOT include id 42 so the list-row fallback test still
  // sees the raw "#42" placeholder while create-modal tests can opt-in a
  // matching contact when they need to submit the form.
  contacts = [{ id: 7, name: 'Seven', email: 'seven@example.com' }],
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    // Slice 22 — match the include=lines detail GET first so it takes
    // precedence over the list-GET prefix match (both URLs start with
    // /api/travel/invoices but the detail GET has ?include=lines).
    if (url.includes('?include=lines') && method === 'GET') {
      if (detail instanceof Error) return Promise.reject(detail);
      return Promise.resolve(detail);
    }
    // S56 — cancel-preview GET (fires when void modal opens).
    if (url.includes('/cancel-preview') && method === 'GET') {
      if (preview instanceof Error) return Promise.reject(preview);
      return Promise.resolve(preview);
    }
    // S56 — POST /:id/void (fires on Confirm).
    if (/\/api\/travel\/invoices\/\d+\/void$/.test(url) && method === 'POST') {
      if (voidResp instanceof Error) return Promise.reject(voidResp);
      return Promise.resolve(voidResp);
    }
    // Customer dropdown + contact-name resolution (#1051).
    if (url === '/api/contacts?fields=summary&limit=500' && method === 'GET') {
      return Promise.resolve(contacts);
    }
    if (/^\/api\/contacts\/\d+$/.test(url) && method === 'GET') {
      const id = Number(url.split('/').pop());
      const contact = contacts.find((c) => c.id === id);
      return Promise.resolve(contact || { id, name: null, email: null });
    }
    if (url.startsWith('/api/travel/invoices') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url === '/api/travel/invoices' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create);
    }
    if (url.startsWith('/api/travel/invoices/') && method === 'PUT') {
      if (update instanceof Error) return Promise.reject(update);
      return Promise.resolve(update);
    }
    if (url.startsWith('/api/travel/invoices/') && method === 'DELETE') {
      if (remove instanceof Error) return Promise.reject(remove);
      return Promise.resolve(remove);
    }
    return Promise.resolve(null);
  });
}

function renderPage({ role = 'ADMIN' } = {}) {
  const value = { user: { role, userId: 1, name: 'Tester' } };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={value}>
        <InvoicesAdmin />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  // Default tenant in localStorage so formatMoney resolves to a stable
  // locale/currency baseline. Per-test currency assertions then pass the
  // row's currency explicitly.
  try {
    localStorage.setItem('tenant', JSON.stringify({ defaultCurrency: 'INR', locale: 'en-IN' }));
  } catch {
    /* jsdom always has localStorage; guard for completeness */
  }
  installFetchMock();
});

describe('<InvoicesAdmin /> — page chrome', () => {
  it('renders heading + filter bar + "New Invoice" CTA when role=ADMIN', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Travel Invoices/i }),
    ).toBeInTheDocument();
    // CTA visible for ADMIN.
    expect(
      screen.getByRole('button', { name: /New Invoice/i }),
    ).toBeInTheDocument();
    // Filter chrome present.
    expect(
      screen.getByLabelText(/Filter by sub-brand/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Filter by status/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Filter by contact ID/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Filter by quote ID/i),
    ).toBeInTheDocument();
    // Wait for mount GET so the dangling promise doesn't leak.
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(([url]) => url.startsWith('/api/travel/invoices')),
      ).toBe(true);
    });
  });

  it('hides "New Invoice" CTA + actions column when role=USER', async () => {
    renderPage({ role: 'USER' });
    expect(screen.queryByRole('button', { name: /New Invoice/i })).toBeNull();
    // Wait for the row to render so we can assert there's no Edit/Delete cell.
    await screen.findByText(/TINV-2026-0001/);
    expect(screen.queryByRole('button', { name: /Edit invoice/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete invoice/i })).toBeNull();
  });
});

describe('<InvoicesAdmin /> — list fetch + filter chrome', () => {
  it('GETs /api/travel/invoices on mount (no querystring) + renders invoice rows', async () => {
    renderPage();
    // Row renders the verbatim TINV-YYYY-NNNN backend-assigned serial.
    expect(await screen.findByText('TINV-2026-0001')).toBeInTheDocument();
    // #1051 — CONTACT column falls back to "#<id>" when the /api/contacts/:id
    // lookup returns null (default mock); when it returns a Contact row the
    // cell renders `contact.name` instead. See the "#1051 — contact name
    // resolution" describe block below for the success path.
    expect(screen.getByText('#42')).toBeInTheDocument();
    // No-querystring GET fired exactly once.
    const gets = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        url === '/api/travel/invoices' && (!opts || !opts.method || opts.method === 'GET'),
    );
    expect(gets.length).toBe(1);
  });

  it('loading state shows "Loading…" before the first GET resolves', async () => {
    // Never-resolving promise so the initial loading branch stays mounted.
    let releaseList;
    const slowList = new Promise((resolve) => { releaseList = resolve; });
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/invoices') && method === 'GET') return slowList;
      return Promise.resolve(null);
    });
    renderPage();
    // Loading copy renders pre-resolution.
    expect(await screen.findByText(/Loading/i)).toBeInTheDocument();
    // Release the pending GET so the test doesn't leak the promise.
    releaseList({ invoices: [], total: 0 });
    await waitFor(() => {
      expect(screen.queryByText(/Loading/i)).toBeNull();
    });
  });

  it('empty-state: zero invoices → "No invoices match." copy renders', async () => {
    installFetchMock({ list: { invoices: [], total: 0 } });
    renderPage();
    expect(await screen.findByText(/No invoices match/i)).toBeInTheDocument();
    // The Access-restricted copy is NOT shown on a benign empty.
    expect(screen.queryByText(/Access restricted/i)).toBeNull();
  });

  it('permission-denied empty-state (#829): 403 from list GET → "Access restricted." copy', async () => {
    const err = new Error('Forbidden');
    err.status = 403;
    installFetchMock({ list: err });
    renderPage();
    expect(await screen.findByText(/Access restricted/i)).toBeInTheDocument();
    // The no-rows copy is NOT shown on permission denial.
    expect(screen.queryByText(/No invoices match/i)).toBeNull();
  });

  it('sub-brand filter: selecting "rfu" appends ?subBrand=rfu to the GET URL', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), {
      target: { value: 'rfu' },
    });
    await waitFor(() => {
      const filtered = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url.includes('subBrand=rfu') && (!opts || !opts.method || opts.method === 'GET'),
      );
      expect(filtered).toBeTruthy();
      expect(filtered[0]).toBe('/api/travel/invoices?subBrand=rfu');
    });
  });

  it('status filter: selecting "Paid" appends ?status=Paid to the GET URL (Pascal-case enum)', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by status/i), {
      target: { value: 'Paid' },
    });
    await waitFor(() => {
      const filtered = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url.includes('status=Paid') && (!opts || !opts.method || opts.method === 'GET'),
      );
      expect(filtered).toBeTruthy();
      expect(filtered[0]).toBe('/api/travel/invoices?status=Paid');
    });
  });
});

describe('<InvoicesAdmin /> — row rendering', () => {
  it('money formatting: INR totalAmount renders via formatMoney with row currency', async () => {
    renderPage();
    // formatMoney(50000, { currency: 'INR' }) under en-IN → "₹50,000".
    // We assert the digit grouping + ₹ rather than verbatim to remain
    // resilient to Intl whitespace variants across ICU builds (per CLAUDE.md
    // cron-learning 2026-05-07 wave-6 on ICU portability).
    await screen.findByText('TINV-2026-0001');
    const cells = screen.getAllByRole('cell');
    const totalCell = cells.find((c) => /50,000/.test(c.textContent) && /₹/.test(c.textContent));
    expect(totalCell).toBeTruthy();
  });

  it('invoice number renders verbatim from backend response (TINV-YYYY-NNNN format)', async () => {
    installFetchMock({
      list: {
        invoices: [
          makeInvoice({ invoiceNum: 'TINV-2026-0007', id: 107 }),
          makeInvoice({ invoiceNum: 'TINV-2026-0042', id: 142 }),
        ],
        total: 2,
      },
    });
    renderPage();
    // Both verbatim serial strings render — the test does NOT generate the
    // serial (race-safe assignment is BACKEND-side per tick #97).
    expect(await screen.findByText('TINV-2026-0007')).toBeInTheDocument();
    expect(screen.getByText('TINV-2026-0042')).toBeInTheDocument();
  });

  it('#1051 — CONTACT column renders the contact name (with link to /contacts/:id) once the lookup resolves', async () => {
    installFetchMock({
      list: {
        invoices: [
          makeInvoice({ id: 401, invoiceNum: 'TINV-2026-0401', contactId: 37207 }),
          makeInvoice({ id: 402, invoiceNum: 'TINV-2026-0402', contactId: 24566 }),
        ],
        total: 2,
      },
    });
    // Layer a contact-resolution branch on top of the default list/PDF mock.
    const baseImpl = fetchApiMock.getMockImplementation();
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/contacts/37207' && method === 'GET') {
        return Promise.resolve({ id: 37207, name: 'Aarav Sharma', email: 'aarav@example.com' });
      }
      if (url === '/api/contacts/24566' && method === 'GET') {
        return Promise.resolve({ id: 24566, name: 'Sneha Patel', email: 'sneha@example.com' });
      }
      return baseImpl(url, opts);
    });
    renderPage();
    // Names resolve and replace the raw ID once the per-row GETs land.
    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument();
    expect(screen.getByText('Sneha Patel')).toBeInTheDocument();
    // The raw "#37207" / "#24566" placeholders are gone.
    expect(screen.queryByText('#37207')).toBeNull();
    expect(screen.queryByText('#24566')).toBeNull();
    // Each name is a link to the contact detail page (tooltip via title).
    const aaravLink = screen.getByRole('link', { name: 'Aarav Sharma' });
    expect(aaravLink.getAttribute('href')).toBe('/contacts/37207');
    expect(aaravLink.getAttribute('title')).toMatch(/#37207/);
    expect(aaravLink.getAttribute('title')).toMatch(/aarav@example\.com/);
  });

  it('sub-brand badge uses real travelSubBrand palette (SUB_BRAND_BG resolves "rfu" + "visasure")', async () => {
    installFetchMock({
      list: {
        invoices: [
          makeInvoice({ id: 201, invoiceNum: 'TINV-2026-0201', subBrand: 'rfu' }),
          makeInvoice({ id: 202, invoiceNum: 'TINV-2026-0202', subBrand: 'visasure' }),
        ],
        total: 2,
      },
    });
    renderPage();
    await screen.findByText('TINV-2026-0201');
    // Sub-brand identifiers render as the badge text (verbatim — the SUT
    // prints inv.subBrand directly, the palette is applied via style only).
    const rfuBadge = screen.getByText('rfu');
    expect(rfuBadge).toBeInTheDocument();
    // Style.background comes from the real SUB_BRAND_BG['rfu'].
    expect(rfuBadge.getAttribute('style')).toMatch(/rgba\(38,\s*88,\s*85/);
    const visaBadge = screen.getByText('visasure');
    expect(visaBadge.getAttribute('style')).toMatch(/rgba\(99,\s*102,\s*241/);
  });

  it('delete button: enabled on Draft rows, disabled (with audit-trail tooltip) on non-Draft', async () => {
    installFetchMock({
      list: {
        invoices: [
          makeInvoice({ id: 301, invoiceNum: 'TINV-2026-0301', status: 'Draft' }),
          makeInvoice({ id: 302, invoiceNum: 'TINV-2026-0302', status: 'Issued' }),
          makeInvoice({ id: 303, invoiceNum: 'TINV-2026-0303', status: 'Voided' }),
        ],
        total: 3,
      },
    });
    renderPage();
    await screen.findByText('TINV-2026-0301');
    // Draft row → Delete enabled with the standard label.
    const draftDel = screen.getByRole('button', { name: /Delete invoice TINV-2026-0301/i });
    expect(draftDel).not.toBeDisabled();
    // Issued row → Delete disabled with the audit-trail-aware aria-label
    // ("Delete disabled for Issued invoice").
    const issuedDel = screen.getByRole('button', { name: /Delete disabled for Issued invoice/i });
    expect(issuedDel).toBeDisabled();
    // Voided row → likewise disabled.
    const voidedDel = screen.getByRole('button', { name: /Delete disabled for Voided invoice/i });
    expect(voidedDel).toBeDisabled();
  });
});

describe('<InvoicesAdmin /> — new-invoice modal', () => {
  it('clicking "New Invoice" opens the form and submitting POSTs the payload', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /New Invoice/i }));
    // Form fields surface (modal opened).
    const contactInput = await screen.findByLabelText(/^Customer$/i);
    const totalInput = screen.getByLabelText(/^Total amount$/i);
    const dueInput = screen.getByLabelText(/^Due date$/i);
    fireEvent.change(contactInput, { target: { value: '7' } });
    fireEvent.change(totalInput, { target: { value: '12500.50' } });
    // Pin a fixed-string future dueDate per CLAUDE.md cron-learning
    // 2026-05-07 wave-9 (TZ-window flake-class avoidance).
    fireEvent.change(dueInput, { target: { value: '2026-12-31' } });
    fetchApiMock.mockClear();
    // The submit button is the green "Save" button inside the form.
    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/travel/invoices' && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.contactId).toBe(7);
      expect(body.totalAmount).toBe(12500.50);
      expect(body.currency).toBe('INR');
      expect(body.status).toBe('Draft');
      expect(body.subBrand).toBe('tmc');
      expect(body.dueDate).toBe('2026-12-31');
      // quoteId omitted (blank input → key not on payload).
      expect(body.quoteId).toBeUndefined();
    });
    // notify.success fired referencing the contact id.
    expect(notifySuccess).toHaveBeenCalled();
    expect(notifySuccess.mock.calls[0][0]).toMatch(/contact 7/);
  });

  it('submitting with missing contactId triggers notify.error and does NOT POST', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /New Invoice/i }));
    // Drive the form via aria-labels (the modal is rendered inline below the
    // header on opens). Skip contactId; provide totalAmount + dueDate so HTML5
    // form validation doesn't block the submit before our JS validator runs.
    const totalInput = await screen.findByLabelText(/^Total amount$/i);
    const dueInput = screen.getByLabelText(/^Due date$/i);
    fireEvent.change(totalInput, { target: { value: '100' } });
    fireEvent.change(dueInput, { target: { value: '2026-12-31' } });
    // Bypass HTML5 required-attr by submitting via the form's onSubmit
    // directly — fire a submit event on the form so the SUT's handler runs.
    fetchApiMock.mockClear();
    const form = totalInput.closest('form');
    expect(form).toBeTruthy();
    fireEvent.submit(form);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    expect(notifyError.mock.calls[0][0]).toMatch(/Please select a customer/i);
    // No POST fired.
    const posts = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/travel/invoices' && opts?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  // #996 — 409 DUPLICATE_DRAFT_INVOICE hard-block behavior (no force-retry).
  it('on 409 DUPLICATE_DRAFT_INVOICE: fires a single POST, surfaces notify.info naming the existing draft, does NOT auto-retry', async () => {
    const dupeErr = Object.assign(new Error('An identical Draft invoice (TINV-2026-0002) was created in the last 5 minutes for this contact.'), {
      status: 409,
      code: 'DUPLICATE_DRAFT_INVOICE',
      data: {
        code: 'DUPLICATE_DRAFT_INVOICE',
        error: 'An identical Draft invoice (TINV-2026-0002) was created in the last 5 minutes for this contact.',
        existing: { id: 102, invoiceNum: 'TINV-2026-0002', createdAt: '2026-05-20T00:00:01.000Z' },
      },
    });
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/contacts?fields=summary&limit=500' && method === 'GET') {
        return Promise.resolve([{ id: 888, name: 'Duplicate Contact', email: 'dupe@example.com' }]);
      }
      if (url.startsWith('/api/travel/invoices') && method === 'GET') {
        return Promise.resolve({ invoices: [makeInvoice()], total: 1 });
      }
      if (url === '/api/travel/invoices' && method === 'POST') {
        return Promise.reject(dupeErr);
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /New Invoice/i }));
    fireEvent.change(await screen.findByLabelText(/^Customer$/i), { target: { value: '888' } });
    fireEvent.change(screen.getByLabelText(/^Total amount$/i), { target: { value: '120000' } });
    fireEvent.change(screen.getByLabelText(/^Due date$/i), { target: { value: '2026-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(notifyInfo).toHaveBeenCalled();
    });
    // Info toast names the existing draft so the operator knows the keeper.
    expect(notifyInfo.mock.calls[0][0]).toMatch(/TINV-2026-0002/);
    // Exactly one POST — the silent first attempt. NO force-true retry.
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/invoices' && o?.method === 'POST',
    );
    expect(posts.length).toBe(1);
    expect(posts[0][1].silent).toBe(true);
    const body = JSON.parse(posts[0][1].body);
    expect(body.force).toBeUndefined();
    // No success toast (nothing was created) and no error toast (the info
    // toast carried the explanation; we don't double-up).
    expect(notifySuccess).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
  });

  // #996 — synchronous re-entry guard prevents the double-fire race.
  it('rapid double-submit fires exactly ONE POST (re-entry guard short-circuits the second call)', async () => {
    // Slow POST so the second submit overlaps the first's in-flight phase.
    let resolveFirst;
    const firstPromise = new Promise((resolve) => { resolveFirst = resolve; });
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/contacts?fields=summary&limit=500' && method === 'GET') {
        return Promise.resolve([{ id: 888, name: 'Double Contact', email: 'double@example.com' }]);
      }
      if (url.startsWith('/api/travel/invoices') && method === 'GET') {
        return Promise.resolve({ invoices: [makeInvoice()], total: 1 });
      }
      if (url === '/api/travel/invoices' && method === 'POST') {
        return firstPromise;
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /New Invoice/i }));
    fireEvent.change(await screen.findByLabelText(/^Customer$/i), { target: { value: '888' } });
    fireEvent.change(screen.getByLabelText(/^Total amount$/i), { target: { value: '120000' } });
    fireEvent.change(screen.getByLabelText(/^Due date$/i), { target: { value: '2026-12-31' } });
    const form = screen.getByLabelText(/^Total amount$/i).closest('form');
    // Fire submit TWICE synchronously — simulating a fast double-click before
    // setSaving(true) has rendered the disabled button.
    fireEvent.submit(form);
    fireEvent.submit(form);
    // Resolve the first POST so the handler can finish.
    resolveFirst(makeInvoice({ id: 999, invoiceNum: 'TINV-2026-0999' }));
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalled();
    });
    // Exactly ONE POST despite TWO submits — the re-entry guard fired.
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/invoices' && o?.method === 'POST',
    );
    expect(posts.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #901 slice 3 — per-row PDF download tests
// ---------------------------------------------------------------------------
//
// The SUT routes PDF downloads through raw global `fetch` (NOT the shared
// fetchApi helper) because fetchApi JSON-parses every 2xx body — a binary
// PDF blob has to flow through the Response object directly so we can call
// .blob() on it. The test mocks:
//   - global fetch (for the PDF endpoint) — returns a Response-shaped object
//     with { ok, status, blob() }.
//   - URL.createObjectURL + URL.revokeObjectURL — vitest spies on the
//     globalThis.URL namespace.
//   - HTMLAnchorElement.prototype.click — vitest spy that swallows the click
//     so jsdom doesn't actually attempt a navigation.
// fetchApi stays mocked for the list GET; the PDF call deliberately bypasses
// it so we can pin the auth header + Response.blob() pattern explicitly.
describe('<InvoicesAdmin /> — per-row PDF download (#901 slice 3)', () => {
  let originalFetch;
  let originalCreateObjectURL;
  let originalRevokeObjectURL;
  let originalAnchorClick;
  let fetchSpy;
  let createObjectURLSpy;
  let revokeObjectURLSpy;
  let anchorClickSpy;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalCreateObjectURL = globalThis.URL.createObjectURL;
    originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
    originalAnchorClick = HTMLAnchorElement.prototype.click;
    fetchSpy = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob(['%PDF-1.4 mock'], { type: 'application/pdf' })),
    }));
    createObjectURLSpy = vi.fn(() => 'blob:mock-invoice-url');
    revokeObjectURLSpy = vi.fn();
    anchorClickSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    globalThis.URL.createObjectURL = createObjectURLSpy;
    globalThis.URL.revokeObjectURL = revokeObjectURLSpy;
    HTMLAnchorElement.prototype.click = anchorClickSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
    HTMLAnchorElement.prototype.click = originalAnchorClick;
  });

  it('renders a "Download PDF for invoice <num>" button on each row', async () => {
    installFetchMock({
      list: {
        invoices: [
          makeInvoice({ id: 401, invoiceNum: 'TINV-2026-0401' }),
          makeInvoice({ id: 402, invoiceNum: 'TINV-2026-0402' }),
        ],
        total: 2,
      },
    });
    renderPage();
    await screen.findByText('TINV-2026-0401');
    expect(
      screen.getByRole('button', { name: /Download PDF for invoice TINV-2026-0401/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Download PDF for invoice TINV-2026-0402/i }),
    ).toBeInTheDocument();
  });

  it('clicking PDF fires GET /api/travel/invoices/:id/pdf with the Bearer auth header', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    const pdfBtn = screen.getByRole('button', { name: /Download PDF for invoice TINV-2026-0001/i });
    fireEvent.click(pdfBtn);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/api\/travel\/invoices\/101\/pdf$/);
    expect(opts?.headers?.Authorization).toBe('Bearer test-token');
  });

  it('on a successful response, calls URL.createObjectURL(blob) + anchor.click() + URL.revokeObjectURL()', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /Download PDF for invoice TINV-2026-0001/i }));
    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalled();
    });
    // The blob handed to createObjectURL must be a Blob with the PDF mime
    // type — pinning the type catches the day someone "optimises" the SUT
    // by passing the raw Response (which createObjectURL won't accept).
    const blobArg = createObjectURLSpy.mock.calls[0][0];
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toBe('application/pdf');
    // Anchor click fired exactly once for the single download path.
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    // Cleanup ran with the same object URL we created.
    await waitFor(() => {
      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-invoice-url');
    });
  });

  it('uses download="invoice-<id>.pdf" filename on the anchor (per backend Content-Disposition contract)', async () => {
    // Spy on createElement('a') so we can inspect the anchor's .download attr
    // before the SUT triggers the click.
    const realCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      return realCreate(tag);
    });
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /Download PDF for invoice TINV-2026-0001/i }));
    await waitFor(() => {
      expect(anchorClickSpy).toHaveBeenCalled();
    });
    // Find the anchor element that was created for the download flow.
    const anchorCalls = createSpy.mock.results.filter(
      (r, i) => createSpy.mock.calls[i][0] === 'a',
    );
    expect(anchorCalls.length).toBeGreaterThan(0);
    const downloadAnchor = anchorCalls.find((r) => r.value?.download === 'invoice-101.pdf');
    expect(downloadAnchor).toBeTruthy();
    createSpy.mockRestore();
  });

  it('failed response (4xx / 5xx) fires notify.error("Failed to download PDF") and does NOT createObjectURL', async () => {
    fetchSpy.mockImplementationOnce(() => Promise.resolve({
      ok: false,
      status: 500,
      blob: () => Promise.resolve(new Blob([], { type: 'application/json' })),
    }));
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /Download PDF for invoice TINV-2026-0001/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Failed to download PDF');
    });
    // No download surface created on failure — guard against partial-success
    // states like creating an orphan blob URL.
    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(anchorClickSpy).not.toHaveBeenCalled();
  });

  it('404 response surfaces the same generic error (no leaking of backend INVOICE_NOT_FOUND code)', async () => {
    fetchSpy.mockImplementationOnce(() => Promise.resolve({
      ok: false,
      status: 404,
      blob: () => Promise.resolve(new Blob([], { type: 'application/json' })),
    }));
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /Download PDF for invoice TINV-2026-0001/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Failed to download PDF');
    });
  });

  it('button shows "Downloading…" + is disabled while the in-flight fetch is pending', async () => {
    let releasePdf;
    const pending = new Promise((resolve) => { releasePdf = resolve; });
    fetchSpy.mockImplementationOnce(() => pending);
    renderPage();
    await screen.findByText('TINV-2026-0001');
    const pdfBtn = screen.getByRole('button', { name: /Download PDF for invoice TINV-2026-0001/i });
    fireEvent.click(pdfBtn);
    // Mid-flight: copy + disabled.
    expect(await screen.findByText(/Downloading/i)).toBeInTheDocument();
    expect(pdfBtn).toBeDisabled();
    // Release the fetch so the test doesn't leak the promise.
    releasePdf({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob(['%PDF-1.4 mock'], { type: 'application/pdf' })),
    });
    await waitFor(() => {
      expect(pdfBtn).not.toBeDisabled();
    });
  });

  it('hidden when role=USER (PDF download is gated on canWrite alongside Edit/Delete)', async () => {
    renderPage({ role: 'USER' });
    await screen.findByText('TINV-2026-0001');
    // Same actions-column gate as Edit/Delete — no PDF button surface for USER.
    expect(screen.queryByRole('button', { name: /Download PDF for invoice/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #901 slice 22 — TDS withholding tiles in the edit modal
// ---------------------------------------------------------------------------
//
// Slice 21 (12b9c752) shipped TDS math: POST /:id/issue now adds
// `totalTds` + `payableAfterTds` to the response envelope. Slice 22
// surfaces those figures on the InvoicesAdmin edit-modal panel — when the
// invoice being edited has status ∈ {Issued, Paid} AND the lazy-fetched
// detail (GET /:id?include=lines) contains lineType==='tds' rows summing
// to >0. The two tiles render:
//   - "Total TDS Withheld" → formatMoney(totalTds, currency)
//   - "Net Payable (After TDS)" → formatMoney(totalAmount - totalTds, currency)
//
// Visibility matrix:
//   Status=Draft   → tiles never rendered (no detail fetch fires)
//   Status=Issued  → detail fetched; tiles render only if totalTds > 0
//   Status=Paid    → detail fetched; tiles render only if totalTds > 0
//   Status=Partial → tiles never rendered (payable-after-TDS goes stale
//                    once any payment is received — see comments in SUT)
//   Status=Voided  → tiles never rendered (terminal state)
describe('<InvoicesAdmin /> — TDS withholding tiles (#901 slice 22)', () => {
  it('renders both tiles when editing an Issued invoice with TDS lines (totalTds > 0)', async () => {
    installFetchMock({
      list: {
        invoices: [
          makeInvoice({ id: 501, invoiceNum: 'TINV-2026-0501', status: 'Issued', totalAmount: 100000 }),
        ],
        total: 1,
      },
      detail: {
        id: 501,
        invoiceNum: 'TINV-2026-0501',
        status: 'Issued',
        totalAmount: 100000,
        currency: 'INR',
        lines: [
          { id: 1, lineType: 'per_pax', amount: 100000 },
          { id: 2, lineType: 'tds', amount: 5000 },
        ],
      },
    });
    renderPage();
    await screen.findByText('TINV-2026-0501');
    fireEvent.click(screen.getByRole('button', { name: /Edit invoice TINV-2026-0501/i }));
    // Tiles surface — wait for the lazy fetch to resolve.
    expect(await screen.findByText(/Total TDS Withheld/i)).toBeInTheDocument();
    expect(screen.getByText(/Net Payable \(After TDS\)/i)).toBeInTheDocument();
    // The tile region (data-testid lock to avoid coupling to glass class).
    const tiles = screen.getByTestId('tds-tiles');
    // Total TDS rendered through formatMoney with INR currency — assert
    // digit grouping + ₹ rather than verbatim per ICU-portability standing
    // rule (CLAUDE.md 2026-05-07 wave-6).
    expect(tiles.textContent).toMatch(/₹/);
    expect(tiles.textContent).toMatch(/5,000/);
    // Net Payable = 100000 - 5000 = 95000.
    expect(tiles.textContent).toMatch(/95,000/);
    // The detail GET fired with ?include=lines.
    const detailGet = fetchApiMock.mock.calls.find(
      ([url]) => /\/api\/travel\/invoices\/501\?include=lines/.test(url),
    );
    expect(detailGet).toBeTruthy();
  });

  it('hides tiles when editing an Issued invoice with no TDS lines (totalTds === 0)', async () => {
    installFetchMock({
      list: {
        invoices: [
          makeInvoice({ id: 502, invoiceNum: 'TINV-2026-0502', status: 'Issued', totalAmount: 100000 }),
        ],
        total: 1,
      },
      detail: {
        id: 502,
        invoiceNum: 'TINV-2026-0502',
        status: 'Issued',
        totalAmount: 100000,
        currency: 'INR',
        lines: [
          { id: 1, lineType: 'per_pax', amount: 100000 },
          { id: 2, lineType: 'tax', amount: 18000 },
        ],
      },
    });
    renderPage();
    await screen.findByText('TINV-2026-0502');
    fireEvent.click(screen.getByRole('button', { name: /Edit invoice TINV-2026-0502/i }));
    // Wait for the form to appear (modal opened) so we know the lazy
    // detail fetch has had a chance to settle.
    await screen.findByLabelText(/^Customer$/i);
    // Give the microtask queue a tick to flush the detail GET resolution.
    await waitFor(() => {
      const detailCall = fetchApiMock.mock.calls.find(
        ([url]) => /\?include=lines/.test(url),
      );
      expect(detailCall).toBeTruthy();
    });
    // Tiles NOT in the DOM — no TDS line means no withholding surface.
    expect(screen.queryByTestId('tds-tiles')).toBeNull();
    expect(screen.queryByText(/Total TDS Withheld/i)).toBeNull();
  });

  it('hides tiles AND does NOT fire the detail GET when editing a Draft invoice', async () => {
    installFetchMock({
      list: {
        invoices: [
          makeInvoice({ id: 503, invoiceNum: 'TINV-2026-0503', status: 'Draft', totalAmount: 50000 }),
        ],
        total: 1,
      },
    });
    renderPage();
    await screen.findByText('TINV-2026-0503');
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Edit invoice TINV-2026-0503/i }));
    // Modal opens for the Draft row.
    await screen.findByLabelText(/^Customer$/i);
    // No detail GET fired (Draft invoices skip the slice-22 fetch entirely).
    const detailCall = fetchApiMock.mock.calls.find(
      ([url]) => /\?include=lines/.test(url),
    );
    expect(detailCall).toBeFalsy();
    // Tiles absent.
    expect(screen.queryByTestId('tds-tiles')).toBeNull();
  });

  it('renders tiles for a Paid invoice with TDS lines (Paid is the other visible status)', async () => {
    installFetchMock({
      list: {
        invoices: [
          makeInvoice({ id: 504, invoiceNum: 'TINV-2026-0504', status: 'Paid', totalAmount: 200000 }),
        ],
        total: 1,
      },
      detail: {
        id: 504,
        invoiceNum: 'TINV-2026-0504',
        status: 'Paid',
        totalAmount: 200000,
        currency: 'INR',
        lines: [
          { id: 1, lineType: 'per_pax', amount: 200000 },
          { id: 2, lineType: 'tds', amount: 10000 },
        ],
      },
    });
    renderPage();
    await screen.findByText('TINV-2026-0504');
    fireEvent.click(screen.getByRole('button', { name: /Edit invoice TINV-2026-0504/i }));
    expect(await screen.findByText(/Total TDS Withheld/i)).toBeInTheDocument();
    const tiles = screen.getByTestId('tds-tiles');
    // 10,000 TDS rendered.
    expect(tiles.textContent).toMatch(/10,000/);
    // Net payable = 200,000 - 10,000 = 190,000.
    expect(tiles.textContent).toMatch(/1,90,000|190,000/);
  });
});

// ---------------------------------------------------------------------------
// S56 (#920) — void-confirmation modal with cancel-preview surface
// ---------------------------------------------------------------------------
//
// Per the S33 follow-up #4 backlog item: operators clicking the dedicated
// Void icon button see a confirmation modal that includes the refund
// preview BEFORE committing the void. The preview is fetched from
// GET /api/travel/invoices/:id/cancel-preview (S58, commit c634af14)
// and rendered based on `reason`:
//
//   reason: 'OK'                  → "Refund: ₹X per <policyName> (Y% — Zd before service)"
//   reason: 'NO_POLICY_RESOLVED'  → "No matching cancellation policy. Voiding
//                                    will NOT auto-issue a credit note."
//   preview-fetch failure         → "Could not load refund preview — review
//                                    the policy before confirming."
//
// The reason text input is REQUIRED by the backend (5..500 chars,
// INVALID_VOID_REASON) and remains in place — the preview is purely
// informational. Confirm fires POST /:id/void with { reason }.
//
// Discriminator key: `preview.reason` (NOT `refundAmount === null`) since
// `refundAmount: 0` is a valid no-refund-but-policy-matched state (the 0%
// tier surfaces the policy without auto-issuing a credit note).
describe('<InvoicesAdmin /> — void-confirmation modal (S56)', () => {
  it('clicking the Void icon button opens the modal AND fires the cancel-preview GET', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fetchApiMock.mockClear();
    // Re-install so the cleared mock still routes the post-click traffic.
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Void invoice TINV-2026-0001/i }));
    // Modal renders.
    expect(await screen.findByTestId('void-modal')).toBeInTheDocument();
    // Cancel-preview GET fired against the row's id.
    await waitFor(() => {
      const previewGet = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === '/api/travel/invoices/101/cancel-preview' &&
          (!opts || !opts.method || opts.method === 'GET'),
      );
      expect(previewGet).toBeTruthy();
    });
  });

  it('renders the OK refund line when preview.reason === "OK"', async () => {
    // Default mock ships an OK preview with 50% TMC Default + 14d.
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /Void invoice TINV-2026-0001/i }));
    // Wait for the preview to land.
    const panel = await screen.findByTestId('void-preview-panel');
    // Refund line: ₹25,000 + TMC Default + 50% + 14d.
    // Asserting on substrings to tolerate the en-IN locale digit-grouping
    // variants per CLAUDE.md cron-learning 2026-05-07 wave-6.
    await waitFor(() => {
      expect(panel.textContent).toMatch(/Refund:/);
    });
    expect(panel.textContent).toMatch(/25,000/);
    expect(panel.textContent).toMatch(/TMC Default/);
    expect(panel.textContent).toMatch(/50%/);
    expect(panel.textContent).toMatch(/14d before service/);
  });

  it('renders the NO_POLICY_RESOLVED warning line when no policy matches', async () => {
    installFetchMock({
      preview: {
        invoiceId: 101,
        status: 'Issued',
        policyApplied: null,
        refundAmount: null,
        refundPercent: null,
        daysBeforeServiceStart: null,
        serviceStartDate: null,
        reason: 'NO_POLICY_RESOLVED',
      },
    });
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /Void invoice TINV-2026-0001/i }));
    const panel = await screen.findByTestId('void-preview-panel');
    await waitFor(() => {
      expect(panel.textContent).toMatch(/No matching cancellation policy/);
    });
    expect(panel.textContent).toMatch(/will NOT auto-issue a credit note/i);
    // Refund line MUST NOT render on no-policy.
    expect(panel.textContent).not.toMatch(/Refund:/);
  });

  it('renders the soft-error line when the preview fetch fails (network / 404 / 409)', async () => {
    const err = new Error('Forbidden');
    err.status = 409;
    installFetchMock({ preview: err });
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /Void invoice TINV-2026-0001/i }));
    const panel = await screen.findByTestId('void-preview-panel');
    await waitFor(() => {
      expect(panel.textContent).toMatch(/Could not load refund preview/);
    });
    expect(panel.textContent).toMatch(/review the policy before confirming/);
    // Confirm button MUST remain available even after preview failure —
    // the preview is informational, not a hard gate.
    const confirmBtn = screen.getByRole('button', { name: /Confirm void of invoice TINV-2026-0001/i });
    expect(confirmBtn).not.toBeDisabled();
  });

  it('the reason textarea is present + Confirm fires POST /:id/void with { reason } after preview load', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /Void invoice TINV-2026-0001/i }));
    // Preview lands.
    const panel = await screen.findByTestId('void-preview-panel');
    await waitFor(() => {
      expect(panel.textContent).toMatch(/Refund:/);
    });
    // Reason textarea is rendered + accepts input.
    const reasonInput = screen.getByLabelText(/Void reason/i);
    expect(reasonInput).toBeInTheDocument();
    fireEvent.change(reasonInput, {
      target: { value: 'Customer cancelled trip — refunded via card.' },
    });
    // Clear so we can isolate the POST call.
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(
      screen.getByRole('button', { name: /Confirm void of invoice TINV-2026-0001/i }),
    );
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          /\/api\/travel\/invoices\/101\/void$/.test(url) && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.reason).toBe('Customer cancelled trip — refunded via card.');
    });
    // Success toast fires + modal closes.
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalled();
    });
  });

  it('Confirm with reason shorter than 5 chars triggers notify.error and does NOT POST', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /Void invoice TINV-2026-0001/i }));
    await screen.findByTestId('void-preview-panel');
    const reasonInput = screen.getByLabelText(/Void reason/i);
    fireEvent.change(reasonInput, { target: { value: 'foo' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(
      screen.getByRole('button', { name: /Confirm void of invoice TINV-2026-0001/i }),
    );
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    expect(notifyError.mock.calls[0][0]).toMatch(/5\.\.500/);
    const posts = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        /\/api\/travel\/invoices\/\d+\/void$/.test(url) && opts?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('the Void icon button is hidden on already-Voided rows (terminal state)', async () => {
    installFetchMock({
      list: {
        invoices: [
          makeInvoice({ id: 601, invoiceNum: 'TINV-2026-0601', status: 'Issued' }),
          makeInvoice({ id: 602, invoiceNum: 'TINV-2026-0602', status: 'Voided' }),
        ],
        total: 2,
      },
    });
    renderPage();
    await screen.findByText('TINV-2026-0601');
    // Issued row → Void button surfaces.
    expect(
      screen.getByRole('button', { name: /Void invoice TINV-2026-0601/i }),
    ).toBeInTheDocument();
    // Voided row → no Void button (already-Voided is terminal).
    expect(
      screen.queryByRole('button', { name: /Void invoice TINV-2026-0602/i }),
    ).toBeNull();
  });

  it('Cancel button closes the modal without firing the void POST', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /Void invoice TINV-2026-0001/i }));
    await screen.findByTestId('void-preview-panel');
    fetchApiMock.mockClear();
    installFetchMock();
    // Click the Cancel button inside the modal (NOT the page's filter "Cancel").
    const modal = screen.getByTestId('void-modal');
    const cancelBtn = Array.from(modal.querySelectorAll('button')).find(
      (b) => /^Cancel$/.test(b.textContent.trim()),
    );
    expect(cancelBtn).toBeTruthy();
    fireEvent.click(cancelBtn);
    // Modal unmounts.
    await waitFor(() => {
      expect(screen.queryByTestId('void-modal')).toBeNull();
    });
    // No POST fired.
    const posts = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        /\/api\/travel\/invoices\/\d+\/void$/.test(url) && opts?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('on successful void with auto-issued credit note, the success toast names the policy', async () => {
    installFetchMock({
      voidResp: {
        id: 101,
        invoiceNum: 'TINV-2026-0001',
        status: 'Voided',
        creditNote: { id: 999, invoiceNum: 'CN-TINV-2026-0001', totalAmount: -25000 },
        policyApplied: { policyId: 7, policyName: 'TMC Default', tier: 0, refundPercent: 50 },
      },
    });
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /Void invoice TINV-2026-0001/i }));
    await screen.findByTestId('void-preview-panel');
    fireEvent.change(screen.getByLabelText(/Void reason/i), {
      target: { value: 'Customer cancelled trip — refunded via card.' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Confirm void of invoice TINV-2026-0001/i }),
    );
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalled();
    });
    // The contextual success message names the policy.
    expect(notifySuccess.mock.calls[0][0]).toMatch(/TMC Default/);
    expect(notifySuccess.mock.calls[0][0]).toMatch(/credit note auto-issued/i);
  });
});
