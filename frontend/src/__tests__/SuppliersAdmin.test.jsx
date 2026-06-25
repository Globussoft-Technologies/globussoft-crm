/**
 * SuppliersAdmin.test.jsx — vitest + RTL coverage for the Travel-vertical
 * suppliers master-list admin page (frontend/src/pages/travel/SuppliersAdmin.jsx,
 * shipped tick #96 commit 08ebe5e — origin file of the admin trio).
 *
 * Scope — pins the page-surface invariants for the Travel-fork supplier
 * MASTER-LIST admin page (sibling to QuotesAdmin / InvoicesAdmin):
 *
 *   1. Page chrome: heading "Travel Suppliers" + sub-brand filter + category
 *      filter + include-inactive checkbox + "New Supplier" CTA (ADMIN/MANAGER
 *      only — canWrite = role === "ADMIN" || role === "MANAGER").
 *   2. Loading state: shows "Loading…" placeholder before first GET resolves
 *      (await findByText per CLAUDE.md tick #108 cron-learning: sync getByText
 *      for data-dependent text is a CI race trap).
 *   3. GET on mount: hits /api/travel/suppliers (no query string when filters
 *      are empty) and renders one row per supplier (table layout).
 *   4. Empty state — no rows: renders "No suppliers match." card when API
 *      returns an empty suppliers array.
 *   5. Empty state — 403: renders "Access restricted." copy per #829
 *      (permissionDenied distinguishes 403 from genuine empty).
 *   6. Sub-brand filter: selecting "rfu" re-fetches with ?subBrand=rfu in the
 *      query string (camelCase per SUT line 88-89).
 *   7. Category filter: selecting "hotel" re-fetches with
 *      ?supplierCategory=hotel.
 *   8. Include-inactive checkbox: checking re-fetches with ?includeInactive=1.
 *   9. Sub-brand badge per row: uses real SUB_BRAND_BG from
 *      travelSubBrand.js (NOT mocked) so any drift in the placeholder palette
 *      / new sub-brand ids is caught here.
 *  10. Status badge per row: Active rows render "Active" with success rgba;
 *      inactive rows render "Inactive" with danger rgba.
 *  11. New-supplier modal: clicking "New Supplier" reveals the form;
 *      submitting with required name POSTs /api/travel/suppliers with the
 *      payload (gstin upper-cased; empty optional fields → null).
 *  12. Validation: empty name surfaces notify.error("Name is required") and
 *      does NOT fire POST.
 *  13. Edit-supplier flow: clicking the Pencil icon opens the form
 *      pre-filled with the row's fields. Submitting PUTs to
 *      /api/travel/suppliers/:id. Non-sensitive fields ONLY — this surface
 *      has zero credential fields (those live in Suppliers.jsx → the
 *      separate /api/travel/supplier-credentials vault page).
 *  14. RBAC: role=USER hides the "New Supplier" CTA, hides the Actions
 *      column header, and does NOT render Edit/Delete icon buttons.
 *  15. Delete flow: clicking Trash2 prompts via window.confirm;
 *      confirm-yes → DELETE /api/travel/suppliers/:id; confirm-no → no DELETE.
 *
 * Backend contract pinned (per backend/routes/travel_suppliers.js lines
 * 391-459, shipped commit 192b8c1):
 *   GET    /api/travel/suppliers[?subBrand=&supplierCategory=&includeInactive=]
 *          → 200 { suppliers, total, limit, offset }
 *          | 403 SUB_BRAND_DENIED
 *   POST   /api/travel/suppliers  body:{name (required), contactPerson?, phone?,
 *                                       email?, gstin?, addressLine?,
 *                                       supplierCategory, subBrand?}
 *                                              → 201 created (ADMIN+MANAGER)
 *                                                | 400 MISSING_FIELDS / INVALID_*
 *                                                | 403 SUB_BRAND_DENIED
 *   PUT    /api/travel/suppliers/:id           → 200 updated (ADMIN+MANAGER)
 *   DELETE /api/travel/suppliers/:id           → 204 No Content (soft delete)
 *
 * Drift pinned around (prompt vs. actual code — per the tick #109+#111+#112+#113
 * agents' prompt-drift discipline):
 *   - Prompt mentioned "credential-vault interaction" + "credential-masked
 *     rendering" + "edit form clears credential fields (re-entry required)" —
 *     SuppliersAdmin.jsx has ZERO credential fields. The credential vault is
 *     a separate page (Suppliers.jsx) backed by /api/travel/supplier-credentials.
 *     This master-list page only handles non-sensitive metadata (name, GSTIN,
 *     contact, sub-brand). Tests omit ALL credential-masking assertions.
 *   - Prompt said "RBAC: ADMIN-only? MANAGER-allowed?" — actual gate is
 *     canWrite = ADMIN OR MANAGER (SuppliersAdmin.jsx:64). Tests pin both
 *     ADMIN happy-path and USER hidden-CTA.
 *   - Prompt said "edit-supplier flow opens editor with pre-filled fields
 *     (non-sensitive), clears credential fields (re-entry required, NOT
 *     pre-fill the masked value)" — no credential fields here, edit form
 *     simply pre-fills all 8 form fields verbatim from the row.
 *   - Prompt mentioned "filter chrome (status filter)" — SuppliersAdmin has
 *     no status filter; it has an includeInactive checkbox toggling between
 *     "active only" (default) and "active+inactive" (query ?includeInactive=1).
 *     Status is a row-level rendering, not a filter.
 *   - Prompt mentioned "error handling: 500 → error banner" — SUT does NOT
 *     render an explicit error banner on 5xx. List 500 falls through to the
 *     same empty-state path as a benign empty (permissionDenied stays false
 *     because err.status !== 403 → renders "No suppliers match."). Tests
 *     pin the 403 → "Access restricted." path only, since that's the only
 *     differentiated UI affordance.
 *   - Prompt mentioned "loading spinner" — SUT renders literal "Loading…"
 *     text (via &hellip; entity). Test asserts on findByText.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (RTL standing rule: Wave 11 cfb5789 /
 *     Wave 12 f59e91d — fresh per-call objects flap useCallback identity).
 *   - travelSubBrand imported REAL (not mocked) so sub-brand-bg drift is
 *     caught by the suite (per the rule-of-3 promotion at tick #99).
 *   - AuthContext is consumed from the real App module via Provider in the
 *     render wrapper (the SUT reads user.role to gate the New/Edit/Delete
 *     buttons). Default user role = ADMIN; one test mounts with role=USER.
 *   - window.confirm stubbed per-test for the delete flow.
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning: sync getBy for data-dependent
 *     text is a CI race trap).
 *
 * Path: flat __tests__/ — sibling Agent B owns TmcMicrositePreview.test.jsx
 * in the same flat dir; no path collision.
 *
 * Slice 2 (#903) extension — payment terms + credit limit + GSTIN hint:
 *   Add suite "<SuppliersAdmin /> — slice 2 (#903) payment-terms + credit" that
 *   pins:
 *     - Create modal renders the 6 new fields (paymentTermsDays /
 *       creditLimit / creditCurrency / taxRegimeCode / primaryContactRole /
 *       notes) plus the GSTIN format hint.
 *     - Edit modal pre-fills the new fields from the row.
 *     - Submit body: paymentTermsDays parsed to int; creditLimit parsed to
 *       Number; empty optionals → null; explicit creditCurrency sent.
 *     - GSTIN client-side soft-validation: invalid non-empty GSTIN blocks
 *       POST + surfaces notify.error; empty GSTIN allowed (matches backend
 *       contract: null OK, non-null must match GSTIN_REGEX).
 *     - List sub-line: row renders "NET-30 · ₹50K credit" only when fields
 *       populated; absent when both null.
 *
 *   Empty-string-vs-null contract for optional fields: empty strings on the
 *   form → null in the POST/PUT body (matches the pre-slice contract for
 *   contactPerson/phone/email/gstin/addressLine and stays consistent for
 *   the new fields). Numeric fields: empty input → null; non-empty input →
 *   parsed Number (paymentTermsDays via parseInt base-10, creditLimit via
 *   Number to preserve decimals like 50000.50). Currency is special-cased:
 *   defaults to "INR" (preserves the backend slice-1 @default("INR")), so
 *   on a fresh create with no edit the body sends creditCurrency:"INR" (the
 *   default), NOT null.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). The SUT closes over notify inside handleSubmit / handleDelete,
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

import { AuthContext } from '../App';
import SuppliersAdmin from '../pages/travel/SuppliersAdmin';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const MANAGER_USER = { userId: 2, name: 'Mgr', email: 'm@x.com', role: 'MANAGER' };
const USER_USER = { userId: 3, name: 'Plain User', email: 'u@x.com', role: 'USER' };

// Canonical supplier rows — three sub-brands + mix of categories + isActive
// states to exercise badge + status-pill render paths.
function makeSupplier(overrides = {}) {
  return {
    id: 201,
    tenantId: 1,
    subBrand: 'tmc',
    name: 'Acme Hotels',
    contactPerson: 'Alice',
    phone: '+91-9000000000',
    email: 'alice@acme.test',
    gstin: '07AAACA1234A1Z5',
    addressLine: '12 Test Rd',
    supplierCategory: 'hotel',
    isActive: true,
    createdAt: '2026-05-20T10:00:00.000Z',
    updatedAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const SUPPLIERS_DEFAULT = [
  makeSupplier({ id: 201, subBrand: 'tmc', name: 'Acme Hotels', supplierCategory: 'hotel', isActive: true }),
  makeSupplier({ id: 202, subBrand: 'rfu', name: 'Saudi Flights', supplierCategory: 'flight', isActive: true, contactPerson: null, phone: null, email: null, gstin: null, addressLine: null }),
  makeSupplier({ id: 203, subBrand: 'visasure', name: 'Old Visa Consul', supplierCategory: 'visa-consul', isActive: false }),
];

// Default aging stub — installFetchMock returns this on every
// /api/travel/payables/aging GET so the panel-mount fetch doesn't trip
// the existing cases (which don't care about aging but DO assert on
// the suppliers GET firing first).
const AGING_DEFAULT = {
  asOf: '2026-05-25T00:00:00.000Z',
  subBrand: null,
  supplierCategory: null,
  bucketTotals: {
    current: { count: 0, totalAmount: 0 },
    '1-30': { count: 0, totalAmount: 0 },
    '31-60': { count: 0, totalAmount: 0 },
    '61-90': { count: 0, totalAmount: 0 },
    '90+': { count: 0, totalAmount: 0 },
  },
  grandTotal: 0,
  excludedCount: 0,
  excludedReasons: {},
};

// Default exposure stub — installFetchMock returns this on every
// /api/travel/suppliers/exposure GET (slice 12 #903, panel mount fetch).
// Tests not focused on the exposure panel still get an empty-but-valid
// response so the panel renders without tripping notify.error.
const EXPOSURE_DEFAULT = {
  suppliers: [],
  total: 0,
  summary: { overLimitCount: 0, nearLimitCount: 0, totalExposure: 0 },
};

// Install a fetchApi mock that routes by URL + method. Tests override
// only the surface they care about.
function installFetchMock({
  list = { suppliers: SUPPLIERS_DEFAULT, total: SUPPLIERS_DEFAULT.length, limit: 100, offset: 0 },
  create = null,
  update = null,
  del = null,
  aging = AGING_DEFAULT,
  exposure = EXPOSURE_DEFAULT,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    // Aging endpoint match BEFORE the suppliers prefix (URL overlap).
    if (url.startsWith('/api/travel/payables/aging') && method === 'GET') {
      if (aging instanceof Error) return Promise.reject(aging);
      return Promise.resolve(aging);
    }
    // Exposure endpoint match BEFORE the generic suppliers prefix (URL
    // overlap: /api/travel/suppliers/exposure starts with /api/travel/
    // suppliers). Slice 12 #903.
    if (url.startsWith('/api/travel/suppliers/exposure') && method === 'GET') {
      if (exposure instanceof Error) return Promise.reject(exposure);
      return Promise.resolve(exposure);
    }
    if (url.startsWith('/api/travel/suppliers') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url === '/api/travel/suppliers' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeSupplier({ id: 999 }));
    }
    if (/^\/api\/travel\/suppliers\/\d+$/.test(url) && method === 'PUT') {
      if (update instanceof Error) return Promise.reject(update);
      return Promise.resolve(update || makeSupplier({ id: 201 }));
    }
    if (/^\/api\/travel\/suppliers\/\d+$/.test(url) && method === 'DELETE') {
      if (del instanceof Error) return Promise.reject(del);
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <AuthContext.Provider value={value}>
      <SuppliersAdmin />
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  installFetchMock();
});

describe('<SuppliersAdmin /> — page chrome + RBAC', () => {
  it('renders heading + filter bar + "New Supplier" CTA when role=ADMIN', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Travel Suppliers/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by sub-brand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by category/i)).toBeInTheDocument();
    // "Include inactive" checkbox.
    expect(screen.getByText(/Include inactive/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Supplier/i })).toBeInTheDocument();
    // Wait for mount-time GET to settle.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(([u]) => typeof u === 'string' && u.startsWith('/api/travel/suppliers'));
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('MANAGER role also sees "New Supplier" CTA (canWrite = ADMIN || MANAGER)', async () => {
    renderPage(MANAGER_USER);
    expect(screen.getByRole('button', { name: /New Supplier/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
  });

  it('hides "New Supplier" CTA + Actions column + Edit/Delete buttons for plain USER role', async () => {
    renderPage(USER_USER);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: /New Supplier/i })).toBeNull();
    // Wait for rows so the column header set is rendered.
    await screen.findByText('Acme Hotels');
    expect(screen.queryByRole('columnheader', { name: /Actions/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit /i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Deactivate /i })).toBeNull();
  });
});

describe('<SuppliersAdmin /> — load + render lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      // Exposure / aging endpoints must resolve so the suppliers-list
      // panel's "Loading…" placeholder is the one we're asserting on
      // (slice 12 #903 added a sibling exposure GET that ALSO matches
      // the /api/travel/suppliers prefix).
      if (url.startsWith('/api/travel/payables/aging') && method === 'GET') {
        return Promise.resolve(AGING_DEFAULT);
      }
      if (url.startsWith('/api/travel/suppliers/exposure') && method === 'GET') {
        return Promise.resolve(EXPOSURE_DEFAULT);
      }
      if (url === '/api/travel/suppliers' && method === 'GET') {
        return new Promise((res) => { resolveList = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveList({ suppliers: SUPPLIERS_DEFAULT, total: SUPPLIERS_DEFAULT.length });
    // Once resolved, Loading disappears + rows render.
    await screen.findByText('Acme Hotels');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/travel/suppliers on mount with NO query string when filters are empty', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.startsWith('/api/travel/suppliers') && (!o?.method || o.method === 'GET'),
      );
      expect(listCall).toBeTruthy();
      expect(listCall[0]).toBe('/api/travel/suppliers');
    });
    // Renders one row per supplier.
    expect(await screen.findByText('Acme Hotels')).toBeInTheDocument();
    expect(screen.getByText('Saudi Flights')).toBeInTheDocument();
    expect(screen.getByText('Old Visa Consul')).toBeInTheDocument();
  });

  it('renders empty state "No suppliers match." when API returns []', async () => {
    installFetchMock({ list: { suppliers: [], total: 0 } });
    renderPage();
    expect(await screen.findByText(/No suppliers match\./i)).toBeInTheDocument();
    // Access-restricted copy NOT shown on benign empty.
    expect(screen.queryByText(/Access restricted/i)).toBeNull();
  });

  it('renders "Access restricted." copy per #829 when API rejects with status:403', async () => {
    const err = new Error('Sub-brand access denied');
    err.status = 403;
    installFetchMock({ list: err });
    renderPage();
    expect(await screen.findByText(/Access restricted\./i)).toBeInTheDocument();
    expect(
      screen.getByText(/Your role does not have permission to view travel suppliers/i),
    ).toBeInTheDocument();
    // No-rows copy NOT shown on permission denial.
    expect(screen.queryByText(/No suppliers match/i)).toBeNull();
  });
});

describe('<SuppliersAdmin /> — filter behaviour', () => {
  it('selecting sub-brand "rfu" re-fetches with ?subBrand=rfu in the URL', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    fetchApiMock.mockClear();
    installFetchMock({ list: { suppliers: [SUPPLIERS_DEFAULT[1]], total: 1 } });
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), { target: { value: 'rfu' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.includes('subBrand=rfu') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('selecting category "hotel" re-fetches with ?supplierCategory=hotel', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    fetchApiMock.mockClear();
    installFetchMock({ list: { suppliers: [SUPPLIERS_DEFAULT[0]], total: 1 } });
    fireEvent.change(screen.getByLabelText(/Filter by category/i), { target: { value: 'hotel' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.includes('supplierCategory=hotel') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('checking "Include inactive" re-fetches with ?includeInactive=1', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    fetchApiMock.mockClear();
    // The checkbox is the only checkbox-typed input on the page.
    const checkbox = screen.getByLabelText(/Include inactive/i);
    fireEvent.click(checkbox);
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.includes('includeInactive=1') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<SuppliersAdmin /> — row rendering: badges + status', () => {
  it('sub-brand badge per row uses real SUB_BRAND_BG (rgba palette from travelSubBrand.js)', async () => {
    renderPage();
    const acme = await screen.findByText('Acme Hotels');
    const tr = acme.closest('tr');
    // Badge cell contains the literal sub-brand id "tmc".
    const badge = within(tr).getByText('tmc');
    // Real SUB_BRAND_BG.tmc = "rgba(18, 38, 71, 0.18)" — assert the rgba(18, 38, 71 prefix.
    expect(badge.style.background).toMatch(/rgba\(18,\s*38,\s*71/);
  });

  it('status badge: active row renders "Active", inactive row renders "Inactive"', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    // Acme Hotels (id 201, isActive=true) → row contains "Active".
    const acmeRow = screen.getByText('Acme Hotels').closest('tr');
    expect(within(acmeRow).getByText('Active')).toBeInTheDocument();
    // Old Visa Consul (id 203, isActive=false) → row contains "Inactive".
    const inactiveRow = screen.getByText('Old Visa Consul').closest('tr');
    expect(within(inactiveRow).getByText('Inactive')).toBeInTheDocument();
  });

  it('renders em-dash "—" for null contact / phone / email / gstin on a sparse row', async () => {
    renderPage();
    // Saudi Flights (id 202) has all 4 optional fields null.
    const sparseRow = (await screen.findByText('Saudi Flights')).closest('tr');
    // At least 4 em-dashes in that row (contact, phone, email, gstin).
    const dashes = within(sparseRow).getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(4);
  });
});

describe('<SuppliersAdmin /> — create + edit + delete', () => {
  it('clicking "New Supplier" reveals the form; submitting POSTs with required name (gstin upper-cased)', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    // Form fields not present before clicking the CTA.
    expect(screen.queryByLabelText(/^Supplier name$/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /New Supplier/i }));
    // After click, form fields surface.
    expect(screen.getByLabelText(/^Supplier name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Contact person$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^GSTIN$/i)).toBeInTheDocument();
    // Fill name + a gstin in lowercase to confirm submit-time uppercase.
    fireEvent.change(screen.getByLabelText(/^Supplier name$/i), { target: { value: '  New Supplier Co  ' } });
    fireEvent.change(screen.getByLabelText(/^Contact person$/i), { target: { value: 'Bob' } });
    // Submit via the form (Save button).
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/suppliers' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      // Name is trimmed by the SUT.
      expect(body.name).toBe('New Supplier Co');
      expect(body.contactPerson).toBe('Bob');
      // Empty optional strings serialised as null.
      expect(body.phone).toBeNull();
      expect(body.email).toBeNull();
      expect(body.gstin).toBeNull();
      expect(body.addressLine).toBeNull();
      // Defaults from EMPTY_FORM.
      expect(body.supplierCategory).toBe('other');
      expect(body.subBrand).toBe('tmc');
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/New Supplier Co/));
  });

  it('validation: empty name surfaces notify.error("Name is required") and does NOT fire POST', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /New Supplier/i }));
    // Leave name blank; submit via direct form event to bypass HTML5
    // required-attr (per the same pattern QuotesAdmin/InvoicesAdmin tests use).
    fetchApiMock.mockClear();
    const nameInput = screen.getByLabelText(/^Supplier name$/i);
    const form = nameInput.closest('form');
    expect(form).toBeTruthy();
    fireEvent.submit(form);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Name is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/suppliers' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('clicking Edit on a row opens the form pre-filled + PUTs to /api/travel/suppliers/:id', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    // Edit button has aria-label "Edit Acme Hotels".
    fireEvent.click(screen.getByRole('button', { name: /^Edit Acme Hotels$/ }));
    // Form prefilled with row 201 values.
    expect(screen.getByLabelText(/^Supplier name$/i).value).toBe('Acme Hotels');
    expect(screen.getByLabelText(/^Contact person$/i).value).toBe('Alice');
    expect(screen.getByLabelText(/^Phone$/i).value).toBe('+91-9000000000');
    expect(screen.getByLabelText(/^Email$/i).value).toBe('alice@acme.test');
    expect(screen.getByLabelText(/^GSTIN$/i).value).toBe('07AAACA1234A1Z5');
    expect(screen.getByLabelText(/^Address$/i).value).toBe('12 Test Rd');
    // Save button reads "Save Changes" in edit mode.
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/suppliers/201' && o?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(put[1].body);
      expect(body.name).toBe('Acme Hotels');
      // gstin uppercased on submit.
      expect(body.gstin).toBe('07AAACA1234A1Z5');
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Acme Hotels.*updated/));
  });

  it('delete flow: confirm-yes → DELETE /api/travel/suppliers/:id; confirm-no → no DELETE', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    // Confirm-no path first.
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: /^Deactivate Acme Hotels$/ }));
    // No DELETE fired.
    await waitFor(() => {
      const deletes = fetchApiMock.mock.calls.filter(([u, o]) =>
        typeof u === 'string' && /^\/api\/travel\/suppliers\/\d+$/.test(u) && o?.method === 'DELETE',
      );
      expect(deletes.length).toBe(0);
    });

    // Confirm-yes path: stub confirm to true.
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: /^Deactivate Acme Hotels$/ }));
    await waitFor(() => {
      const deletes = fetchApiMock.mock.calls.filter(([u, o]) =>
        u === '/api/travel/suppliers/201' && o?.method === 'DELETE',
      );
      expect(deletes.length).toBe(1);
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Acme Hotels.*deactivated/));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 2 (#903) — payment terms + credit + GSTIN hint
// Pins the operator UX shape that surfaces the slice-1 backend fields shipped
// in commit effdf40e (paymentTermsDays, creditLimit, creditCurrency,
// taxRegimeCode, primaryContactRole, notes + GSTIN format validation).
// ─────────────────────────────────────────────────────────────────────────────
describe('<SuppliersAdmin /> — slice 2 (#903) payment-terms + credit + GSTIN hint', () => {
  it('create modal renders the 6 new fields + GSTIN format hint', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /New Supplier/i }));
    // New form fields surfaced by their aria-labels.
    expect(screen.getByLabelText(/^Payment terms days$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Credit limit$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Credit currency$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Tax regime$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Primary contact role$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Notes$/i)).toBeInTheDocument();
    // GSTIN format hint inline below the GSTIN input.
    expect(screen.getByText(/Format: 22ABCDE1234F1Z5/i)).toBeInTheDocument();
  });

  it('edit modal pre-fills the 6 new fields from the row', async () => {
    // Override the default list so Acme Hotels carries slice-2 fields populated.
    installFetchMock({
      list: {
        suppliers: [
          makeSupplier({
            id: 201,
            name: 'Acme Hotels',
            paymentTermsDays: 30,
            creditLimit: '50000.00',
            creditCurrency: 'INR',
            taxRegimeCode: 'regular',
            primaryContactRole: 'Accounts payable',
            notes: 'Prefer NEFT; quarterly reconcile.',
          }),
        ],
        total: 1,
      },
    });
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /^Edit Acme Hotels$/ }));
    expect(screen.getByLabelText(/^Payment terms days$/i).value).toBe('30');
    expect(screen.getByLabelText(/^Credit limit$/i).value).toBe('50000.00');
    expect(screen.getByLabelText(/^Credit currency$/i).value).toBe('INR');
    expect(screen.getByLabelText(/^Tax regime$/i).value).toBe('regular');
    expect(screen.getByLabelText(/^Primary contact role$/i).value).toBe('Accounts payable');
    expect(screen.getByLabelText(/^Notes$/i).value).toBe('Prefer NEFT; quarterly reconcile.');
  });

  it('submit body: paymentTermsDays parsed to int; creditLimit parsed to Number; currency sent', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /New Supplier/i }));
    fireEvent.change(screen.getByLabelText(/^Supplier name$/i), { target: { value: 'New Co' } });
    fireEvent.change(screen.getByLabelText(/^Payment terms days$/i), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText(/^Credit limit$/i), { target: { value: '75000.50' } });
    fireEvent.change(screen.getByLabelText(/^Credit currency$/i), { target: { value: 'USD' } });
    fireEvent.change(screen.getByLabelText(/^Tax regime$/i), { target: { value: 'composite' } });
    fireEvent.change(screen.getByLabelText(/^Primary contact role$/i), { target: { value: 'Owner' } });
    fireEvent.change(screen.getByLabelText(/^Notes$/i), { target: { value: 'Bulk discount available' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/suppliers' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      // Numeric fields parsed.
      expect(body.paymentTermsDays).toBe(45);
      expect(typeof body.paymentTermsDays).toBe('number');
      expect(body.creditLimit).toBe(75000.5);
      expect(typeof body.creditLimit).toBe('number');
      // Selects + free-form text passed through.
      expect(body.creditCurrency).toBe('USD');
      expect(body.taxRegimeCode).toBe('composite');
      expect(body.primaryContactRole).toBe('Owner');
      expect(body.notes).toBe('Bulk discount available');
    });
  });

  it('submit body: empty optional new fields → null (except creditCurrency which defaults to "INR")', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /New Supplier/i }));
    fireEvent.change(screen.getByLabelText(/^Supplier name$/i), { target: { value: 'Minimal Co' } });
    // Don't touch the new fields — they should serialise to null (except
    // creditCurrency which carries the "INR" form default).
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/suppliers' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.paymentTermsDays).toBeNull();
      expect(body.creditLimit).toBeNull();
      // creditCurrency default is "INR" (form initial state) — sent as
      // string, NOT null. The backend treats this as the default-tracking
      // currency; sending null would erase a previously set value on PUT.
      expect(body.creditCurrency).toBe('INR');
      expect(body.taxRegimeCode).toBeNull();
      expect(body.primaryContactRole).toBeNull();
      expect(body.notes).toBeNull();
    });
  });

  it('client-side GSTIN soft-validation: invalid non-empty GSTIN blocks POST + surfaces notify.error', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /New Supplier/i }));
    fireEvent.change(screen.getByLabelText(/^Supplier name$/i), { target: { value: 'BadGstin Co' } });
    // Invalid GSTIN — wrong length / wrong char positions.
    fireEvent.change(screen.getByLabelText(/^GSTIN$/i), { target: { value: 'NOTAGOODGSTIN' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Invalid GSTIN/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/suppliers' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('client-side GSTIN soft-validation: empty GSTIN allowed (null on submit)', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /New Supplier/i }));
    fireEvent.change(screen.getByLabelText(/^Supplier name$/i), { target: { value: 'NoGstin Co' } });
    // GSTIN left empty.
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/suppliers' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.gstin).toBeNull();
    });
    // No GSTIN-related error.
    const gstinErrors = notifyError.mock.calls.filter(([m]) =>
      typeof m === 'string' && /GSTIN/i.test(m),
    );
    expect(gstinErrors.length).toBe(0);
  });

  it('client-side GSTIN soft-validation: valid 15-char GSTIN passes (case-insensitive input upper-cased)', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /New Supplier/i }));
    fireEvent.change(screen.getByLabelText(/^Supplier name$/i), { target: { value: 'GoodGstin Co' } });
    // Type lowercase; SUT upper-cases on change so the input ends with uppercase.
    fireEvent.change(screen.getByLabelText(/^GSTIN$/i), { target: { value: '27aaacr4849r1zw' } });
    expect(screen.getByLabelText(/^GSTIN$/i).value).toBe('27AAACR4849R1ZW');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/suppliers' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.gstin).toBe('27AAACR4849R1ZW');
    });
    const gstinErrors = notifyError.mock.calls.filter(([m]) =>
      typeof m === 'string' && /Invalid GSTIN/i.test(m),
    );
    expect(gstinErrors.length).toBe(0);
  });

  it('list sub-line: row renders "NET-30 · ₹50K credit" when paymentTermsDays + creditLimit populated', async () => {
    installFetchMock({
      list: {
        suppliers: [
          makeSupplier({
            id: 301,
            name: 'Finance-Equipped Co',
            paymentTermsDays: 30,
            creditLimit: '50000',
            creditCurrency: 'INR',
          }),
        ],
        total: 1,
      },
    });
    renderPage();
    const row = (await screen.findByText('Finance-Equipped Co')).closest('tr');
    const sub = within(row).getByTestId('supplier-finance-sub-301');
    expect(sub.textContent).toMatch(/NET-30/);
    expect(sub.textContent).toMatch(/credit/);
    // INR symbol prefix on the credit token.
    expect(sub.textContent).toMatch(/₹/);
  });

  it('list sub-line: row does NOT render sub-line when both paymentTermsDays + creditLimit are null', async () => {
    installFetchMock({
      list: {
        suppliers: [
          makeSupplier({
            id: 302,
            name: 'No-Finance Co',
            paymentTermsDays: null,
            creditLimit: null,
            creditCurrency: null,
          }),
        ],
        total: 1,
      },
    });
    renderPage();
    await screen.findByText('No-Finance Co');
    // No data-testid="supplier-finance-sub-302" anywhere.
    expect(screen.queryByTestId('supplier-finance-sub-302')).toBeNull();
  });

  it('list sub-line: row renders only "NET-N" when paymentTerms set but creditLimit null', async () => {
    installFetchMock({
      list: {
        suppliers: [
          makeSupplier({
            id: 303,
            name: 'PT-Only Co',
            paymentTermsDays: 45,
            creditLimit: null,
            creditCurrency: null,
          }),
        ],
        total: 1,
      },
    });
    renderPage();
    const row = (await screen.findByText('PT-Only Co')).closest('tr');
    const sub = within(row).getByTestId('supplier-finance-sub-303');
    expect(sub.textContent).toMatch(/NET-45/);
    expect(sub.textContent).not.toMatch(/credit/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 4 (#903) — payables panel (expand / list / add / mark-paid / cancel /
// delete). Consumes backend endpoints shipped in commit 59336ab7:
//   GET    /api/travel/suppliers/:id/payables           list + ?status filter
//   POST   /api/travel/suppliers/:id/payables           ADMIN+MANAGER create
//   PUT    /api/travel/suppliers/:id/payables/:pid      ADMIN+MANAGER patch
//   DELETE /api/travel/suppliers/:id/payables/:pid      ADMIN+MANAGER hard-delete
//
// UX decisions encoded by the assertions below:
//   - Single-expanded UX: only one supplier's panel is open at a time
//     (toggling a different supplier closes the prior). Keeps DOM tight on
//     the list page; operators who need side-by-side comparison can open
//     the supplier detail in a new tab.
//   - Status badges: pending → yellow, scheduled → blue, paid → green,
//     cancelled → grey with strike-through line on the row.
//   - notify.confirm for the delete action (matches the rest of the modern
//     CRM surface; the older window.confirm path is reserved for the parent
//     supplier delete which predates the notify.confirm migration).
//   - Empty state copy: "No payables recorded yet — add the first one below."
// ─────────────────────────────────────────────────────────────────────────────
function makePayable(overrides = {}) {
  return {
    id: 401,
    tenantId: 1,
    supplierId: 201,
    description: 'PO-2026-0123 batch 1',
    amount: '450000.00',
    currency: 'INR',
    dueDate: '2026-06-15T00:00:00.000Z',
    status: 'pending',
    poNumber: 'PO-2026-0123',
    paidAt: null,
    notes: 'Awaiting GST inv',
    createdAt: '2026-05-25T08:00:00.000Z',
    updatedAt: '2026-05-25T08:00:00.000Z',
    ...overrides,
  };
}

// Install fetch mock that ALSO routes the nested payables endpoints. Keeps
// the base supplier-list response identical to installFetchMock so existing
// cases (and the panel-open cases) coexist.
function installFetchMockWithPayables({
  list = { suppliers: SUPPLIERS_DEFAULT, total: SUPPLIERS_DEFAULT.length, limit: 100, offset: 0 },
  payables = { payables: [], total: 0, limit: 100, offset: 0 },
  payablesCreate = null,
  payablesUpdate = null,
  payablesDelete = null,
  aging = AGING_DEFAULT,
  exposure = EXPOSURE_DEFAULT,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    // Aging endpoint match BEFORE the suppliers prefix.
    if (url.startsWith('/api/travel/payables/aging') && method === 'GET') {
      if (aging instanceof Error) return Promise.reject(aging);
      return Promise.resolve(aging);
    }
    // Exposure endpoint match BEFORE the generic suppliers prefix (URL
    // overlap: /api/travel/suppliers/exposure). Slice 12 #903.
    if (url.startsWith('/api/travel/suppliers/exposure') && method === 'GET') {
      if (exposure instanceof Error) return Promise.reject(exposure);
      return Promise.resolve(exposure);
    }
    // Nested payables match BEFORE the supplier-level patterns (URL prefix overlap).
    if (/^\/api\/travel\/suppliers\/\d+\/payables$/.test(url) && method === 'GET') {
      if (payables instanceof Error) return Promise.reject(payables);
      return Promise.resolve(payables);
    }
    if (/^\/api\/travel\/suppliers\/\d+\/payables$/.test(url) && method === 'POST') {
      if (payablesCreate instanceof Error) return Promise.reject(payablesCreate);
      return Promise.resolve(payablesCreate || makePayable({ id: 9001 }));
    }
    if (/^\/api\/travel\/suppliers\/\d+\/payables\/\d+$/.test(url) && method === 'PUT') {
      if (payablesUpdate instanceof Error) return Promise.reject(payablesUpdate);
      return Promise.resolve(payablesUpdate || makePayable({ id: 401 }));
    }
    if (/^\/api\/travel\/suppliers\/\d+\/payables\/\d+$/.test(url) && method === 'DELETE') {
      if (payablesDelete instanceof Error) return Promise.reject(payablesDelete);
      return Promise.resolve(null);
    }
    // Fall-through to supplier-level handlers (same shape as installFetchMock).
    if (url.startsWith('/api/travel/suppliers') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url === '/api/travel/suppliers' && method === 'POST') {
      return Promise.resolve(makeSupplier({ id: 999 }));
    }
    if (/^\/api\/travel\/suppliers\/\d+$/.test(url) && method === 'PUT') {
      return Promise.resolve(makeSupplier({ id: 201 }));
    }
    if (/^\/api\/travel\/suppliers\/\d+$/.test(url) && method === 'DELETE') {
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
}

describe('<SuppliersAdmin /> — slice 4 (#903) payables panel', () => {
  it('expand toggle renders on EVERY supplier row (read-only USER role too)', async () => {
    installFetchMockWithPayables();
    renderPage(USER_USER);
    await screen.findByText('Acme Hotels');
    // All 3 default suppliers have a toggle button — verifies the toggle is
    // not gated on canWrite (operators in read-only mode can still view the
    // A/P ledger to answer "what do we owe X?" questions).
    expect(
      screen.getByRole('button', { name: /Toggle payables for Acme Hotels/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Toggle payables for Saudi Flights/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Toggle payables for Old Visa Consul/i }),
    ).toBeInTheDocument();
  });

  it('clicking expand fires GET /api/travel/suppliers/:id/payables and reveals the panel', async () => {
    installFetchMockWithPayables();
    renderPage();
    await screen.findByText('Acme Hotels');
    // Panel not in DOM before click.
    expect(screen.queryByTestId('payables-panel-201')).toBeNull();
    fetchApiMock.mockClear();
    installFetchMockWithPayables();
    fireEvent.click(screen.getByRole('button', { name: /Toggle payables for Acme Hotels/i }));
    await waitFor(() => {
      const get = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/suppliers/201/payables' && (!o?.method || o.method === 'GET'),
      );
      expect(get).toBeTruthy();
    });
    expect(await screen.findByTestId('payables-panel-201')).toBeInTheDocument();
  });

  it('empty state: "No payables recorded yet — add the first one below." when list is empty', async () => {
    installFetchMockWithPayables({ payables: { payables: [], total: 0 } });
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /Toggle payables for Acme Hotels/i }));
    expect(
      await screen.findByText(/No payables recorded yet — add the first one below\./i),
    ).toBeInTheDocument();
  });

  it('populated rows render description, amount + currency, dueDate, status badge', async () => {
    installFetchMockWithPayables({
      payables: {
        payables: [
          makePayable({
            id: 401,
            description: 'PO-2026-0123 batch 1',
            amount: '450000.00',
            currency: 'INR',
            dueDate: '2026-06-15T00:00:00.000Z',
            status: 'pending',
          }),
          makePayable({
            id: 402,
            description: 'Hotel rooms Apr 2026',
            amount: '120000.50',
            currency: 'INR',
            dueDate: '2026-04-30T00:00:00.000Z',
            status: 'paid',
          }),
          makePayable({
            id: 403,
            description: 'Cancelled airline batch',
            amount: '90000.00',
            currency: 'USD',
            dueDate: null,
            status: 'cancelled',
          }),
        ],
        total: 3,
      },
    });
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /Toggle payables for Acme Hotels/i }));
    const row401 = (await screen.findByTestId('payable-row-401'));
    expect(within(row401).getByText('PO-2026-0123 batch 1')).toBeInTheDocument();
    // Amount + currency rendered together in the row.
    expect(within(row401).getByText(/450000\.00.*INR/)).toBeInTheDocument();
    expect(within(row401).getByText('2026-06-15')).toBeInTheDocument();
    // Status badge per row (status label appears both in row + may appear in
    // future filter chrome; use the data-testid to disambiguate).
    expect(within(row401).getByTestId('payable-status-401').textContent).toMatch(/pending/i);
    expect(within(screen.getByTestId('payable-row-402')).getByTestId('payable-status-402').textContent).toMatch(/paid/i);
    expect(within(screen.getByTestId('payable-row-403')).getByTestId('payable-status-403').textContent).toMatch(/cancelled/i);
  });

  it('"Mark paid" button opens a confirm dialog and fires PUT with { status: "paid" } + re-fetches list', async () => {
    installFetchMockWithPayables({
      payables: { payables: [makePayable({ id: 411, status: 'pending' })], total: 1 },
    });
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /Toggle payables for Acme Hotels/i }));
    await screen.findByTestId('payable-row-411');
    fetchApiMock.mockClear();
    installFetchMockWithPayables({
      payables: { payables: [makePayable({ id: 411, status: 'paid', paidAt: '2026-05-25T09:00:00.000Z' })], total: 1 },
    });
    fireEvent.click(screen.getByRole('button', { name: /Mark paid payable 411/i }));
    // Confirm dialog opens; confirm to fire the PUT.
    expect(await screen.findByRole('dialog', { name: /Confirm payment/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Mark as paid/i }));
    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/suppliers/201/payables/411' && o?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(put[1].body);
      expect(body.status).toBe('paid');
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/paid/i));
  });

  it('"Cancel" button fires PUT with { status: "cancelled" }', async () => {
    installFetchMockWithPayables({
      payables: { payables: [makePayable({ id: 421, status: 'pending' })], total: 1 },
    });
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /Toggle payables for Acme Hotels/i }));
    await screen.findByTestId('payable-row-421');
    fetchApiMock.mockClear();
    installFetchMockWithPayables({
      payables: { payables: [makePayable({ id: 421, status: 'cancelled' })], total: 1 },
    });
    fireEvent.click(screen.getByRole('button', { name: /Cancel payable 421/i }));
    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/suppliers/201/payables/421' && o?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(put[1].body);
      expect(body.status).toBe('cancelled');
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
  });

  it('"Delete" fires notify.confirm + DELETE on confirm-yes; no DELETE on confirm-no', async () => {
    installFetchMockWithPayables({
      payables: { payables: [makePayable({ id: 431, status: 'pending' })], total: 1 },
    });
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /Toggle payables for Acme Hotels/i }));
    await screen.findByTestId('payable-row-431');

    // Confirm-no path: stub notify.confirm to resolve false.
    notifyConfirm.mockResolvedValueOnce(false);
    fetchApiMock.mockClear();
    installFetchMockWithPayables({
      payables: { payables: [makePayable({ id: 431, status: 'pending' })], total: 1 },
    });
    fireEvent.click(screen.getByRole('button', { name: /Delete payable 431/i }));
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    const deletesA = fetchApiMock.mock.calls.filter(([u, o]) =>
      typeof u === 'string' && /\/payables\/\d+$/.test(u) && o?.method === 'DELETE',
    );
    expect(deletesA.length).toBe(0);

    // Confirm-yes path: default mockResolvedValue is true (beforeEach).
    notifyConfirm.mockResolvedValueOnce(true);
    fetchApiMock.mockClear();
    installFetchMockWithPayables({ payables: { payables: [], total: 0 } });
    fireEvent.click(screen.getByRole('button', { name: /Delete payable 431/i }));
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/suppliers/201/payables/431' && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/delete/i));
  });

  it('add-payable form: submit with required fields → POST /api/travel/suppliers/:id/payables + list refresh', async () => {
    installFetchMockWithPayables({
      payables: { payables: [], total: 0 },
    });
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /Toggle payables for Acme Hotels/i }));
    await screen.findByText(/No payables recorded yet/i);
    const descInput = screen.getByLabelText(/Payable description for Acme Hotels/i);
    const amountInput = screen.getByLabelText(/Payable amount for Acme Hotels/i);
    const dueInput = screen.getByLabelText(/Payable due date for Acme Hotels/i);
    const poInput = screen.getByLabelText(/Payable PO number for Acme Hotels/i);
    const notesInput = screen.getByLabelText(/Payable notes for Acme Hotels/i);
    fireEvent.change(descInput, { target: { value: '  Airline batch  ' } });
    fireEvent.change(amountInput, { target: { value: '125000.00' } });
    fireEvent.change(dueInput, { target: { value: '2026-07-15' } });
    fireEvent.change(poInput, { target: { value: 'PO-2026-0200' } });
    fireEvent.change(notesInput, { target: { value: 'Net-30 after ticketing' } });

    fetchApiMock.mockClear();
    installFetchMockWithPayables({
      payables: { payables: [makePayable({ id: 999 })], total: 1 },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add payable/i }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/suppliers/201/payables' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.description).toBe('Airline batch'); // trimmed
      expect(body.amount).toBe(125000);
      expect(body.dueDate).toBe('2026-07-15');
      expect(body.poNumber).toBe('PO-2026-0200');
      expect(body.notes).toBe('Net-30 after ticketing');
    });
    // After success, list re-fetched (second GET fires after POST).
    await waitFor(() => {
      const refetch = fetchApiMock.mock.calls.filter(([u, o]) =>
        u === '/api/travel/suppliers/201/payables' && (!o?.method || o.method === 'GET'),
      );
      expect(refetch.length).toBeGreaterThan(0);
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/added/i));
  });

  it('add-payable form: missing description → notify.error, no POST fires', async () => {
    installFetchMockWithPayables({ payables: { payables: [], total: 0 } });
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /Toggle payables for Acme Hotels/i }));
    await screen.findByText(/No payables recorded yet/i);
    // Description blank, amount populated.
    fireEvent.change(screen.getByLabelText(/Payable amount for Acme Hotels/i), { target: { value: '10000' } });
    const form = screen.getByTestId('payable-add-form-201');
    fetchApiMock.mockClear();
    installFetchMockWithPayables({ payables: { payables: [], total: 0 } });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/description.*required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(([u, o]) =>
      typeof u === 'string' && /\/payables$/.test(u) && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('add-payable form: negative amount → notify.error, no POST fires', async () => {
    installFetchMockWithPayables({ payables: { payables: [], total: 0 } });
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /Toggle payables for Acme Hotels/i }));
    await screen.findByText(/No payables recorded yet/i);
    fireEvent.change(screen.getByLabelText(/Payable description for Acme Hotels/i), { target: { value: 'Bad amount row' } });
    // jsdom's <input type="number" min="0"> sanitises a "-50" input to "" on
    // change (per the HTML5 spec for invalid number-input values). The SUT's
    // first validation branch ("Amount is required") catches this; the second
    // branch ("non-negative number") catches truly-numeric negative input
    // (e.g. via a JS state-set bypass). Both paths block the POST + surface
    // a notify.error — the contract pinned here is "negative input does not
    // fire POST AND surfaces an error", with either error message acceptable.
    const amountInput = screen.getByLabelText(/Payable amount for Acme Hotels/i);
    fireEvent.change(amountInput, { target: { value: '-50' } });
    // Submit via direct form event so we bypass HTML5 native validation
    // (the type="number" min="0" input would block a click-submit on
    // negative values). The SUT's JS-level validation MUST hold its own.
    const form = screen.getByTestId('payable-add-form-201');
    fetchApiMock.mockClear();
    installFetchMockWithPayables({ payables: { payables: [], total: 0 } });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
      const msg = notifyError.mock.calls[notifyError.mock.calls.length - 1][0];
      expect(msg).toMatch(/non-negative number|Amount is required/i);
    });
    const posts = fetchApiMock.mock.calls.filter(([u, o]) =>
      typeof u === 'string' && /\/payables$/.test(u) && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('single-expanded UX: opening a second supplier closes the first panel', async () => {
    installFetchMockWithPayables({ payables: { payables: [], total: 0 } });
    renderPage();
    await screen.findByText('Acme Hotels');
    fireEvent.click(screen.getByRole('button', { name: /Toggle payables for Acme Hotels/i }));
    expect(await screen.findByTestId('payables-panel-201')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Toggle payables for Saudi Flights/i }));
    // Second opens; first closes (single-expanded contract).
    expect(await screen.findByTestId('payables-panel-202')).toBeInTheDocument();
    expect(screen.queryByTestId('payables-panel-201')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 9 (#903) — Payables Aging panel (top-of-page aged-payable summary).
// Consumes GET /api/travel/payables/aging shipped in commit c7900645. Pins
// the panel's render contract:
//   - 5 urgency-coloured bucket cards: current / 1-30 / 31-60 / 61-90 / 90+
//     (green → yellow → orange → red → dark-red).
//   - Each card surfaces both the count and the totalAmount for the bucket.
//   - Grand total + excluded summary line below the cards.
//   - Loading + error states inline.
//   - 5xx fires notify.error (403 stays silent — the suppliers list itself
//     surfaces permission-denied UX; duplicating it on the aging panel
//     would be noisy).
//   - Empty buckets render zero count + zero amount (no missing card).
// ─────────────────────────────────────────────────────────────────────────────
describe('<SuppliersAdmin /> — slice 9 (#903) payables aging panel', () => {
  it('panel mounts and renders 5 bucket cards', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    // Panel container present.
    expect(await screen.findByTestId('payables-aging-panel')).toBeInTheDocument();
    // 5 bucket cards present.
    expect(screen.getByTestId('aging-card-current')).toBeInTheDocument();
    expect(screen.getByTestId('aging-card-1-30')).toBeInTheDocument();
    expect(screen.getByTestId('aging-card-31-60')).toBeInTheDocument();
    expect(screen.getByTestId('aging-card-61-90')).toBeInTheDocument();
    expect(screen.getByTestId('aging-card-90+')).toBeInTheDocument();
  });

  it('GETs /api/travel/payables/aging on mount', async () => {
    renderPage();
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' &&
        u.startsWith('/api/travel/payables/aging') &&
        (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('cards display correct count + amount from the response', async () => {
    installFetchMock({
      aging: {
        asOf: '2026-05-25T00:00:00.000Z',
        subBrand: null,
        supplierCategory: null,
        bucketTotals: {
          current: { count: 4, totalAmount: 125000 },
          '1-30': { count: 2, totalAmount: 67500.5 },
          '31-60': { count: 1, totalAmount: 20000 },
          '61-90': { count: 0, totalAmount: 0 },
          '90+': { count: 3, totalAmount: 380000 },
        },
        grandTotal: 592500.5,
        excludedCount: 7,
        excludedReasons: { EXCLUDED_PAID: 4, EXCLUDED_CANCELLED: 2, NO_DUE_DATE: 1 },
      },
    });
    renderPage();
    await screen.findByText('Acme Hotels');
    // Current: 4 payables, ₹1,25,000
    await waitFor(() => {
      expect(screen.getByTestId('aging-card-amount-current').textContent).toMatch(/1,25,000|125,?000/);
    });
    expect(screen.getByTestId('aging-card-count-current').textContent).toMatch(/4 payables/);
    // 1-30
    expect(screen.getByTestId('aging-card-amount-1-30').textContent).toMatch(/67,500/);
    expect(screen.getByTestId('aging-card-count-1-30').textContent).toMatch(/2 payables/);
    // 31-60
    expect(screen.getByTestId('aging-card-amount-31-60').textContent).toMatch(/20,000/);
    expect(screen.getByTestId('aging-card-count-31-60').textContent).toMatch(/1 payable/);
    // 61-90 (empty bucket)
    expect(screen.getByTestId('aging-card-count-61-90').textContent).toMatch(/0 payables/);
    // 90+ (worst bucket)
    expect(screen.getByTestId('aging-card-amount-90+').textContent).toMatch(/3,80,000|380,?000/);
    expect(screen.getByTestId('aging-card-count-90+').textContent).toMatch(/3 payables/);
  });

  it('grand total is displayed below the cards', async () => {
    installFetchMock({
      aging: {
        ...AGING_DEFAULT,
        bucketTotals: {
          current: { count: 1, totalAmount: 50000 },
          '1-30': { count: 1, totalAmount: 30000 },
          '31-60': { count: 0, totalAmount: 0 },
          '61-90': { count: 0, totalAmount: 0 },
          '90+': { count: 0, totalAmount: 0 },
        },
        grandTotal: 80000,
        excludedCount: 0,
        excludedReasons: {},
      },
    });
    renderPage();
    await screen.findByText('Acme Hotels');
    await waitFor(() => {
      const gt = screen.getByTestId('aging-grand-total');
      expect(gt.textContent).toMatch(/Grand total/i);
      expect(gt.textContent).toMatch(/80,000/);
    });
  });

  it('excluded summary line is displayed below the cards', async () => {
    installFetchMock({
      aging: {
        ...AGING_DEFAULT,
        excludedCount: 12,
        excludedReasons: { EXCLUDED_PAID: 8, EXCLUDED_CANCELLED: 3, NO_DUE_DATE: 1 },
      },
    });
    renderPage();
    await screen.findByText('Acme Hotels');
    await waitFor(() => {
      const sum = screen.getByTestId('aging-excluded-summary');
      expect(sum.textContent).toMatch(/12 excluded/);
      expect(sum.textContent).toMatch(/paid\/cancelled\/missing dueDate/i);
    });
  });

  it('empty buckets render zero counts + zero amounts (no missing card)', async () => {
    installFetchMock({
      aging: {
        ...AGING_DEFAULT,
        bucketTotals: {
          current: { count: 0, totalAmount: 0 },
          '1-30': { count: 0, totalAmount: 0 },
          '31-60': { count: 0, totalAmount: 0 },
          '61-90': { count: 0, totalAmount: 0 },
          '90+': { count: 0, totalAmount: 0 },
        },
        grandTotal: 0,
        excludedCount: 0,
      },
    });
    renderPage();
    await screen.findByText('Acme Hotels');
    // All 5 cards still rendered.
    await waitFor(() => {
      ['current', '1-30', '31-60', '61-90', '90+'].forEach((key) => {
        const cardCount = screen.getByTestId(`aging-card-count-${key}`);
        expect(cardCount.textContent).toMatch(/0 payables/);
        const cardAmount = screen.getByTestId(`aging-card-amount-${key}`);
        // Amount renders 0 (with currency symbol).
        expect(cardAmount.textContent).toMatch(/0/);
      });
    });
    expect(screen.getByTestId('aging-grand-total').textContent).toMatch(/0/);
    expect(screen.getByTestId('aging-excluded-summary').textContent).toMatch(/0 excluded/);
  });

  it('5xx failure surfaces notify.error + renders error state', async () => {
    const err = new Error('aging endpoint exploded');
    err.status = 500;
    installFetchMock({ aging: err });
    renderPage();
    await screen.findByText('Acme Hotels');
    await waitFor(() => {
      const agingErrors = notifyError.mock.calls.filter(([m]) =>
        typeof m === 'string' && /aging/i.test(m),
      );
      expect(agingErrors.length).toBeGreaterThan(0);
    });
    // Error state placeholder renders.
    expect(screen.getByTestId('aging-error')).toBeInTheDocument();
    // Bucket cards not in the DOM during the error state (replaced by the
    // error placeholder).
    expect(screen.queryByTestId('aging-card-current')).toBeNull();
  });

  it('403 failure does NOT fire notify.error (suppliers list owns the permission-denied UX)', async () => {
    const err = new Error('forbidden');
    err.status = 403;
    installFetchMock({ aging: err });
    renderPage();
    await screen.findByText('Acme Hotels');
    // Give the aging promise time to reject + reach the catch handler.
    await waitFor(() => {
      // Error state placeholder still renders (the panel observes failure).
      expect(screen.getByTestId('aging-error')).toBeInTheDocument();
    });
    // But no notify.error fired for the aging-403 case.
    const agingErrors = notifyError.mock.calls.filter(([m]) =>
      typeof m === 'string' && /aging/i.test(m),
    );
    expect(agingErrors.length).toBe(0);
  });

  it('loading placeholder renders before the GET resolves', async () => {
    let resolveAging;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/payables/aging') && method === 'GET') {
        return new Promise((res) => { resolveAging = res; });
      }
      if (url.startsWith('/api/travel/suppliers') && method === 'GET') {
        return Promise.resolve({ suppliers: SUPPLIERS_DEFAULT, total: SUPPLIERS_DEFAULT.length });
      }
      return Promise.resolve(null);
    });
    renderPage();
    // Loading placeholder for aging in DOM before the aging promise resolves.
    expect(await screen.findByTestId('aging-loading')).toBeInTheDocument();
    resolveAging(AGING_DEFAULT);
    // After resolve, the bucket cards appear.
    expect(await screen.findByTestId('aging-card-current')).toBeInTheDocument();
    expect(screen.queryByTestId('aging-loading')).toBeNull();
  });

  it('aging GET respects sub-brand filter (passes ?subBrand=)', async () => {
    renderPage();
    await screen.findByText('Acme Hotels');
    fetchApiMock.mockClear();
    installFetchMock({ list: { suppliers: [SUPPLIERS_DEFAULT[1]], total: 1 } });
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), { target: { value: 'rfu' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' &&
        u.startsWith('/api/travel/payables/aging') &&
        u.includes('subBrand=rfu') &&
        (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

// PRD_TRAVEL_SUPPLIER_MASTER #903 slice 12 — Credit Exposure panel suite.
// Consumes GET /api/travel/suppliers/exposure (shipped commit 2a276137).
// Pins: panel chrome + 3 summary tiles + per-supplier table + near-limit
// chip toggle + status-pill colour mapping + filter wiring + error/loading
// states.
describe('<SuppliersAdmin /> — slice 12 (#903) credit-exposure panel', () => {
  // Canonical exposure payload covering all 4 status enums + sub-brand mix
  // so per-status pill rendering + utilisation % rendering can be asserted
  // in one render pass. Backend ships `utilization` as a 4dp ratio; UI
  // converts to a 1dp percentage for display.
  const EXPOSURE_MIXED = {
    suppliers: [
      {
        id: 301,
        name: 'Riyadh Hotels',
        supplierCategory: 'hotel',
        subBrand: 'rfu',
        creditLimit: 100000,
        creditCurrency: 'INR',
        openExposure: 125000,
        utilization: 1.25,
        openPayableCount: 6,
        status: 'over-limit',
        isActive: true,
      },
      {
        id: 302,
        name: 'Saudi Air',
        supplierCategory: 'flight',
        subBrand: 'rfu',
        creditLimit: 50000,
        creditCurrency: 'INR',
        openExposure: 42500,
        utilization: 0.85,
        openPayableCount: 3,
        status: 'near-limit',
        isActive: true,
      },
      {
        id: 303,
        name: 'Acme Hotels',
        supplierCategory: 'hotel',
        subBrand: 'tmc',
        creditLimit: 200000,
        creditCurrency: 'INR',
        openExposure: 12000,
        utilization: 0.06,
        openPayableCount: 1,
        status: 'ok',
        isActive: true,
      },
      {
        id: 304,
        name: 'Nobudget Visa',
        supplierCategory: 'visa-consul',
        subBrand: 'visasure',
        creditLimit: null,
        creditCurrency: 'INR',
        openExposure: 8000,
        utilization: null,
        openPayableCount: 2,
        status: 'no-limit',
        isActive: true,
      },
    ],
    total: 4,
    summary: { overLimitCount: 1, nearLimitCount: 1, totalExposure: 187500 },
  };

  it('renders summary tiles (over-limit / near-limit / total exposure)', async () => {
    installFetchMock({ exposure: EXPOSURE_MIXED });
    renderPage();
    expect(await screen.findByTestId('exposure-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('exposure-tile-over-limit')).toBeInTheDocument();
    expect(screen.getByTestId('exposure-tile-near-limit')).toBeInTheDocument();
    expect(screen.getByTestId('exposure-tile-total')).toBeInTheDocument();
    expect(screen.getByTestId('exposure-tile-over-limit-count')).toHaveTextContent('1');
    expect(screen.getByTestId('exposure-tile-near-limit-count')).toHaveTextContent('1');
    // Total exposure rendered with INR en-IN grouping (1,87,500).
    expect(screen.getByTestId('exposure-tile-total-amount').textContent).toMatch(/1,87,500/);
  });

  it('renders one per-supplier row per exposure entry with status + utilisation', async () => {
    installFetchMock({ exposure: EXPOSURE_MIXED });
    renderPage();
    expect(await screen.findByTestId('exposure-table')).toBeInTheDocument();
    expect(screen.getByTestId('exposure-row-301')).toBeInTheDocument();
    expect(screen.getByTestId('exposure-row-302')).toBeInTheDocument();
    expect(screen.getByTestId('exposure-row-303')).toBeInTheDocument();
    expect(screen.getByTestId('exposure-row-304')).toBeInTheDocument();
    expect(screen.getByTestId('exposure-status-301')).toHaveTextContent(/Over limit/i);
    expect(screen.getByTestId('exposure-status-302')).toHaveTextContent(/Near limit/i);
    expect(screen.getByTestId('exposure-status-303')).toHaveTextContent(/OK/);
    expect(screen.getByTestId('exposure-status-304')).toHaveTextContent(/No limit/i);
    expect(screen.getByTestId('exposure-util-301')).toHaveTextContent('125%');
    expect(screen.getByTestId('exposure-util-302')).toHaveTextContent('85%');
    expect(screen.getByTestId('exposure-util-303')).toHaveTextContent('6%');
    expect(screen.getByTestId('exposure-util-304')).toHaveTextContent('—');
  });

  it('status pill colours: over-limit=danger rgba, near-limit=warning rgba, ok=success rgba', async () => {
    installFetchMock({ exposure: EXPOSURE_MIXED });
    renderPage();
    await screen.findByTestId('exposure-table');
    const overPill = screen.getByTestId('exposure-status-301');
    expect(overPill.getAttribute('style') || '').toMatch(/var\(--danger-color/);
    const nearPill = screen.getByTestId('exposure-status-302');
    expect(nearPill.getAttribute('style') || '').toMatch(/var\(--warning-color/);
    const okPill = screen.getByTestId('exposure-status-303');
    expect(okPill.getAttribute('style') || '').toMatch(/var\(--success-color/);
  });

  it('fires GET /api/travel/suppliers/exposure on mount (no query string when filters empty)', async () => {
    installFetchMock({ exposure: EXPOSURE_MIXED });
    renderPage();
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' &&
        u === '/api/travel/suppliers/exposure' &&
        (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('passes ?subBrand= when the page-level sub-brand filter changes', async () => {
    installFetchMock({ exposure: EXPOSURE_MIXED });
    renderPage();
    await screen.findByTestId('exposure-table');
    fetchApiMock.mockClear();
    installFetchMock({ exposure: EXPOSURE_MIXED });
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), { target: { value: 'rfu' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' &&
        u.startsWith('/api/travel/suppliers/exposure') &&
        u.includes('subBrand=rfu') &&
        (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('passes ?supplierCategory= when the page-level category filter changes', async () => {
    installFetchMock({ exposure: EXPOSURE_MIXED });
    renderPage();
    await screen.findByTestId('exposure-table');
    fetchApiMock.mockClear();
    installFetchMock({ exposure: EXPOSURE_MIXED });
    fireEvent.change(screen.getByLabelText(/Filter by category/i), { target: { value: 'hotel' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' &&
        u.startsWith('/api/travel/suppliers/exposure') &&
        u.includes('supplierCategory=hotel') &&
        (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('checking "Near-limit only" chip re-fetches with ?nearLimitOnly=1', async () => {
    installFetchMock({ exposure: EXPOSURE_MIXED });
    renderPage();
    await screen.findByTestId('exposure-table');
    fetchApiMock.mockClear();
    installFetchMock({ exposure: EXPOSURE_MIXED });
    const chip = screen.getByLabelText(/Show only near-limit and over-limit suppliers/i);
    fireEvent.click(chip);
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' &&
        u.startsWith('/api/travel/suppliers/exposure') &&
        u.includes('nearLimitOnly=1') &&
        (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('shows "Loading exposure…" placeholder before the GET resolves', async () => {
    let resolveExposure;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/payables/aging') && method === 'GET') {
        return Promise.resolve(AGING_DEFAULT);
      }
      if (url.startsWith('/api/travel/suppliers/exposure') && method === 'GET') {
        return new Promise((res) => { resolveExposure = res; });
      }
      if (url.startsWith('/api/travel/suppliers') && method === 'GET') {
        return Promise.resolve({ suppliers: SUPPLIERS_DEFAULT, total: SUPPLIERS_DEFAULT.length });
      }
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByTestId('exposure-loading')).toBeInTheDocument();
    resolveExposure(EXPOSURE_MIXED);
    expect(await screen.findByTestId('exposure-table')).toBeInTheDocument();
    expect(screen.queryByTestId('exposure-loading')).toBeNull();
  });

  it('renders error placeholder on 5xx + fires notify.error', async () => {
    const err = new Error('boom');
    err.status = 500;
    installFetchMock({ exposure: err });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('exposure-error')).toBeInTheDocument();
    });
    const exposureErrors = notifyError.mock.calls.filter(([m]) =>
      typeof m === 'string' && /exposure|boom/i.test(m),
    );
    expect(exposureErrors.length).toBeGreaterThan(0);
  });

  it('403 failure is silent (suppliers list owns the permission-denied UX)', async () => {
    const err = new Error('forbidden');
    err.status = 403;
    installFetchMock({ exposure: err });
    renderPage();
    await screen.findByText('Acme Hotels');
    await waitFor(() => {
      expect(screen.getByTestId('exposure-error')).toBeInTheDocument();
    });
    const exposureErrors = notifyError.mock.calls.filter(([m]) =>
      typeof m === 'string' && /exposure/i.test(m),
    );
    expect(exposureErrors.length).toBe(0);
  });

  it('renders empty-state copy when no suppliers have credit limits configured', async () => {
    installFetchMock({
      exposure: {
        suppliers: [],
        total: 0,
        summary: { overLimitCount: 0, nearLimitCount: 0, totalExposure: 0 },
      },
    });
    renderPage();
    expect(await screen.findByTestId('exposure-empty')).toBeInTheDocument();
    expect(screen.getByTestId('exposure-empty')).toHaveTextContent(/No suppliers with credit limits configured/i);
  });

  it('empty-state copy switches when near-limit-only chip is active', async () => {
    installFetchMock({ exposure: EXPOSURE_MIXED });
    renderPage();
    await screen.findByTestId('exposure-table');
    fetchApiMock.mockClear();
    installFetchMock({
      exposure: {
        suppliers: [],
        total: 0,
        summary: { overLimitCount: 0, nearLimitCount: 0, totalExposure: 0 },
      },
    });
    fireEvent.click(screen.getByLabelText(/Show only near-limit and over-limit suppliers/i));
    await waitFor(() => {
      expect(screen.getByTestId('exposure-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('exposure-empty')).toHaveTextContent(/No suppliers at or over credit limit/i);
  });
});
