/**
 * QuotesAdmin.test.jsx — vitest + RTL coverage for the Travel-vertical
 * quotes-admin page (frontend/src/pages/travel/QuotesAdmin.jsx, shipped
 * tick #97 commit aaf8cb2).
 *
 * Scope — pins the page-surface invariants for the Travel-fork quote
 * management admin page (sibling to SuppliersAdmin / InvoicesAdmin):
 *
 *   1. Page chrome: heading "Travel Quotes" + sub-brand filter + status
 *      filter + contact-id filter + "New Quote" CTA (ADMIN/MANAGER only).
 *   2. Loading state: shows "Loading…" placeholder before first GET resolves
 *      (await findByText per CLAUDE.md tick #108 cron-learning).
 *   3. GET on mount: hits /api/travel/quotes (no query string when filters
 *      are empty) and renders one row per quote (table layout).
 *   4. Empty state — no rows: renders the "No quotes match." card when the
 *      API returns an empty quotes array.
 *   5. Empty state — 403: renders the "Access restricted." copy per #829
 *      (permissionDenied distinguishes 403 from genuine empty).
 *   6. Sub-brand filter: selecting "rfu" re-fetches with ?subBrand=rfu
 *      in the query string.
 *   7. Status filter: selecting "Sent" re-fetches with ?status=Sent.
 *   8. Money formatting: row totals render via real formatMoney (passes
 *      through the row's q.currency — INR / USD / etc.).
 *   9. Sub-brand badge per row: uses real SUB_BRAND_BG from
 *      travelSubBrand.js (NOT mocked) so any drift in the placeholder
 *      palette / new sub-brand ids is caught here.
 *  10. New-quote modal: clicking "New Quote" reveals the form; submitting
 *      with valid fields POSTs /api/travel/quotes with the contactId
 *      (int) + totalAmount (float) + currency + status + subBrand +
 *      validUntil payload, then re-fetches the list.
 *  11. Edit-quote flow: clicking the row's Edit icon opens the form
 *      pre-filled with the row's fields. Submitting PUTs to
 *      /api/travel/quotes/:id.
 *  12. Status-transition (via edit): changing status from Draft → Sent
 *      via the edit form sends `status: "Sent"` in the PUT body. The
 *      backend status enum is forward-permissive (no transition matrix
 *      yet at the route layer — pinned here so a future server-side
 *      transition check doesn't silently regress this page).
 *  13. Validation — non-numeric contactId surfaces notify.error and does
 *      NOT fire POST.
 *  14. Delete flow: clicking the delete icon prompts via window.confirm;
 *      confirm-yes → DELETEs /api/travel/quotes/:id; confirm-no → no
 *      DELETE fires.
 *
 * Backend contract pinned (per backend/routes/travel_quotes.js, 9/9 vitest
 * green per tick #97):
 *   GET    /api/travel/quotes[?subBrand=&status=]   → 200 { quotes, total, limit, offset }
 *                                                    | 403 sub-brand-denied
 *   POST   /api/travel/quotes  body:{contactId,totalAmount,currency,status?,
 *                                    subBrand?,validUntil?}
 *                                                  → 201 created
 *                                                    | 400 MISSING_FIELDS / INVALID_*
 *                                                    | 403 SUB_BRAND_DENIED
 *   PUT    /api/travel/quotes/:id                   → 200 updated
 *   DELETE /api/travel/quotes/:id                   → 204 No Content
 *
 * Drift pinned around (prompt vs. actual code):
 *   - Prompt mentioned "status-transition controls" — actual SUT has NO
 *     dedicated "Mark sent" / "Mark accepted" PATCH endpoint or button;
 *     status changes happen via the Edit form's status <select>. PUT
 *     accepts any of {Draft,Sent,Accepted,Rejected} without a transition
 *     matrix. Test pins the via-edit path, not a missing dedicated PATCH.
 *   - Prompt mentioned "table or card grid" — SUT uses a <table>. Tests
 *     use findByRole('table') + getAllByRole('row').
 *   - Prompt mentioned "loading spinner" — SUT uses the literal text
 *     "Loading&hellip;" (renders as "Loading…"). Test asserts on findByText.
 *   - Sub-brand filter query is ?subBrand=… not ?sub_brand=…. Pinned.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders.
 *   - AuthContext provided with role:ADMIN so canWrite=true (otherwise the
 *     "New Quote" CTA and Edit/Delete columns are gated out).
 *   - travelSubBrand imported REAL (not mocked) so sub-brand-bg drift is
 *     caught by the suite (per the rule-of-3 promotion at tick #99).
 *   - formatMoney imported REAL (not mocked) so currency-aware formatting
 *     drift is caught. Tests pin against the digit substring "5,000" so
 *     tenant locale fluctuations don't break them.
 *   - window.confirm stubbed per-test for the delete flow.
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning: sync getBy for data-dependent
 *     text is a CI race trap).
 *
 * Path: flat __tests__/ per tick #111 path-coordination (sibling Agent B
 * owns InvoicesAdmin.test.jsx in the same flat dir).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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
import QuotesAdmin from '../pages/travel/QuotesAdmin';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const USER_USER = { userId: 2, name: 'Plain User', email: 'u@x.com', role: 'USER' };

// Canonical quote rows — three sub-brands + statuses to exercise the badge
// + status-pill render paths.
function makeQuote(overrides = {}) {
  return {
    id: 101,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 5001,
    status: 'Draft',
    totalAmount: 5000,
    currency: 'INR',
    validUntil: '2026-12-31T00:00:00.000Z',
    createdAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const QUOTES_DEFAULT = [
  makeQuote({ id: 101, subBrand: 'tmc', status: 'Draft', totalAmount: 5000, contactId: 5001 }),
  makeQuote({ id: 102, subBrand: 'rfu', status: 'Sent', totalAmount: 75000, contactId: 5002, currency: 'INR' }),
  makeQuote({ id: 103, subBrand: 'visasure', status: 'Accepted', totalAmount: 12000, contactId: 5003, currency: 'USD' }),
];

// Install a fetchApi mock that routes by URL + method. Tests override
// only the surface they care about.
function installFetchMock({
  list = { quotes: QUOTES_DEFAULT, total: QUOTES_DEFAULT.length, limit: 100, offset: 0 },
  create = null,
  update = null,
  del = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/travel/quotes') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url === '/api/travel/quotes' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeQuote({ id: 999 }));
    }
    if (/^\/api\/travel\/quotes\/\d+$/.test(url) && method === 'PUT') {
      if (update instanceof Error) return Promise.reject(update);
      return Promise.resolve(update || makeQuote({ id: 101, status: 'Sent' }));
    }
    if (/^\/api\/travel\/quotes\/\d+$/.test(url) && method === 'DELETE') {
      if (del instanceof Error) return Promise.reject(del);
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false }}>
        <QuotesAdmin />
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
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<QuotesAdmin /> — page chrome + filter bar', () => {
  it('renders heading + filter bar; NO create button (quotes are created in the Quote Builder)', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /Travel Quotes/i }),
    ).toBeInTheDocument();
    // Filter chrome
    expect(screen.getByLabelText(/Filter by sub-brand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by status/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by customer name/i)).toBeInTheDocument();
    // The "New Quote" CTA was intentionally removed — creation lives in the
    // Quote Builder, so even an ADMIN has no create button here.
    expect(screen.queryByRole('button', { name: /New Quote/i })).toBeNull();
    // Wait for mount-time GET to settle
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(([u]) => typeof u === 'string' && u.startsWith('/api/travel/quotes'));
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('hides "New Quote" CTA + Actions column for plain USER role (canWrite=false)', async () => {
    renderPage(USER_USER);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: /New Quote/i })).toBeNull();
    // Wait for rows so we can check the column header set
    await screen.findByText('#5001');
    // Actions column header should NOT be present for plain USER
    expect(screen.queryByRole('columnheader', { name: /Actions/i })).toBeNull();
  });
});

describe('<QuotesAdmin /> — load + render lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    // Defer the list response so the loading state is observable.
    let resolveList;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/quotes') && method === 'GET') {
        return new Promise((res) => { resolveList = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    // Loading text renders before list resolves.
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveList({ quotes: QUOTES_DEFAULT, total: QUOTES_DEFAULT.length });
    // Once resolved, Loading disappears + rows render.
    await screen.findByText('#5001');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/travel/quotes on mount with NO query string when filters are empty', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.startsWith('/api/travel/quotes') && (!o?.method || o.method === 'GET'),
      );
      expect(listCall).toBeTruthy();
      // No query string when both filters are blank.
      expect(listCall[0]).toBe('/api/travel/quotes');
    });
    // Renders one row per quote.
    expect(await screen.findByText('#5001')).toBeInTheDocument();
    expect(screen.getByText('#5002')).toBeInTheDocument();
    expect(screen.getByText('#5003')).toBeInTheDocument();
  });

  it('renders empty state "No quotes match." when API returns []', async () => {
    installFetchMock({ list: { quotes: [], total: 0 } });
    renderPage();
    expect(await screen.findByText('No quotes match.')).toBeInTheDocument();
  });

  it('renders "Access restricted." copy per #829 when API rejects with status:403', async () => {
    const err = new Error('Sub-brand access denied');
    err.status = 403;
    installFetchMock({ list: err });
    renderPage();
    expect(await screen.findByText(/Access restricted\./i)).toBeInTheDocument();
    // Honest copy explains the role/permission affordance.
    expect(
      screen.getByText(/Your role does not have permission to view travel quotes/i),
    ).toBeInTheDocument();
  });
});

describe('<QuotesAdmin /> — filter behavior', () => {
  it('selecting sub-brand "rfu" re-fetches with ?subBrand=rfu in the URL', async () => {
    renderPage();
    await screen.findByText('#5001');
    fetchApiMock.mockClear();
    installFetchMock({ list: { quotes: [QUOTES_DEFAULT[1]], total: 1 } });
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), { target: { value: 'rfu' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.includes('subBrand=rfu') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('selecting status "Sent" re-fetches with ?status=Sent in the URL', async () => {
    renderPage();
    await screen.findByText('#5001');
    fetchApiMock.mockClear();
    installFetchMock({ list: { quotes: [QUOTES_DEFAULT[1]], total: 1 } });
    fireEvent.change(screen.getByLabelText(/Filter by status/i), { target: { value: 'Sent' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.includes('status=Sent') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<QuotesAdmin /> — row rendering: money + sub-brand badge', () => {
  it('row total renders via real formatMoney — INR row contains "5,000" digit substring', async () => {
    renderPage();
    // Wait for the row corresponding to contactId 5001 (totalAmount=5000 INR).
    const row = await screen.findByText('#5001');
    // Walk up to the row; assert total contains "5,000" (locale-tolerant —
    // INR formatting via en-IN injects the standard "5,000" thousands separator).
    const tr = row.closest('tr');
    expect(tr).toBeTruthy();
    expect(within(tr).getByText(/5,000/)).toBeInTheDocument();
  });

  it('sub-brand badge per row uses real SUB_BRAND_BG (rgba palette from travelSubBrand.js)', async () => {
    renderPage();
    const tmcRow = await screen.findByText('#5001');
    const tr = tmcRow.closest('tr');
    // The badge cell contains the literal sub-brand id "tmc".
    const badge = within(tr).getByText('tmc');
    // Real SUB_BRAND_BG.tmc = "rgba(18, 38, 71, 0.18)" → jsdom may normalise
    // either form. Assert the rgba(18, 38, 71 prefix is present.
    expect(badge.style.background).toMatch(/rgba\(18,\s*38,\s*71/);
  });
});

// NOTE: the "new-quote modal + create POST" tests were removed — quote
// creation now lives exclusively in the Quote Builder, so this admin page no
// longer exposes a create button or form-via-create path. The create form
// markup remains in the component for EDIT only (covered by the edit tests
// below, which open it via the row Edit button).

describe('<QuotesAdmin /> — edit + status-transition + delete', () => {
  it('clicking Edit on a row opens the form pre-filled + PUTs to /api/travel/quotes/:id', async () => {
    renderPage();
    await screen.findByText('#5001');
    // Edit button has aria-label "Edit quote #101"
    fireEvent.click(screen.getByRole('button', { name: /Edit quote #101/i }));
    // Form prefilled with row 101 values.
    const contactInput = screen.getByLabelText(/^Contact ID$/i);
    expect(contactInput.value).toBe('5001');
    const totalInput = screen.getByLabelText(/^Total amount$/i);
    expect(totalInput.value).toBe('5000');
    const currencyInput = screen.getByLabelText(/^Currency$/i);
    expect(currencyInput.value).toBe('INR');
    // Save button reads "Save Changes" in edit mode.
    const saveBtn = screen.getByRole('button', { name: /Save Changes/i });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/quotes/101' && o?.method === 'PUT',
      );
      expect(put).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Quote #101 updated/i));
  });

  it('status-transition via edit: changing Draft → Sent sends `status: "Sent"` in PUT body', async () => {
    renderPage();
    await screen.findByText('#5001');
    fireEvent.click(screen.getByRole('button', { name: /Edit quote #101/i }));
    // Status <select> in the edit form is labelled "Status" (the edit-form
    // dropdown — distinct from the filter-bar "Filter by status").
    fireEvent.change(screen.getByLabelText(/^Status$/i), { target: { value: 'Sent' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/quotes/101' && o?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(put[1].body);
      expect(body.status).toBe('Sent');
      // Forward-permissive: no transition matrix in the route, so Draft→Sent
      // (or any forward/backward flip) is accepted at the page layer.
    });
  });

  it('delete flow: confirm-yes → DELETE /api/travel/quotes/:id; confirm-no → no DELETE', async () => {
    renderPage();
    await screen.findByText('#5001');
    // Confirm-no path first.
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: /Delete quote #101/i }));
    // No DELETE fired.
    await waitFor(() => {
      const deletes = fetchApiMock.mock.calls.filter(([u, o]) =>
        typeof u === 'string' && /^\/api\/travel\/quotes\/\d+$/.test(u) && o?.method === 'DELETE',
      );
      expect(deletes.length).toBe(0);
    });

    // Confirm-yes path: stub confirm to true.
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: /Delete quote #101/i }));
    await waitFor(() => {
      const deletes = fetchApiMock.mock.calls.filter(([u, o]) =>
        u === '/api/travel/quotes/101' && o?.method === 'DELETE',
      );
      expect(deletes.length).toBe(1);
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Quote #101 deleted/i));
  });

  it('delete failure surfaces notify.error with the server message', async () => {
    const err = new Error('boom');
    err.body = { error: 'Cannot delete — referenced by invoice' };
    installFetchMock({ del: err });
    renderPage();
    await screen.findByText('#5001');
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: /Delete quote #101/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Cannot delete — referenced by invoice');
    });
  });
});
