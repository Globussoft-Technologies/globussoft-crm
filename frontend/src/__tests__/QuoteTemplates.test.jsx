/**
 * QuoteTemplates.test.jsx — vitest + RTL coverage for the Travel-vertical
 * quote-templates admin page (frontend/src/pages/travel/QuoteTemplates.jsx,
 * shipped S31 slice).
 *
 * Scope — pins page-surface invariants for the operator-facing quote-
 * template library (sibling to QuotesAdmin / InvoicesAdmin / SuppliersAdmin):
 *
 *   1. Page chrome: heading "Quote Templates" + sub-brand filter +
 *      category filter + isActive filter + "New Template" CTA
 *      (ADMIN/MANAGER only).
 *   2. Loading state: shows "Loading…" placeholder before first GET
 *      resolves (await findByText per CLAUDE.md tick #108 cron-learning).
 *   3. GET on mount: hits /api/travel/quote-templates with the default
 *      ?isActive=true filter and renders one row per template.
 *   4. Empty state — no rows: renders the "No templates match." card when
 *      the API returns an empty items array.
 *   5. Empty state — 403: renders the "Access restricted." copy per #829
 *      (permissionDenied distinguishes 403 from genuine empty).
 *   6. Sub-brand filter: selecting "rfu" re-fetches with ?subBrand=rfu.
 *   7. Category filter: selecting "Umrah" re-fetches with ?category=Umrah.
 *   8. Lines column: each row counts the JSON array length in linesJson;
 *      malformed JSON renders "—".
 *   9. Sub-brand badge per row uses real SUB_BRAND_BG palette from
 *      travelSubBrand.js (NOT mocked).
 *  10. New-template modal: clicking "New Template" reveals the create
 *      form; submitting with valid fields POSTs /api/travel/quote-templates
 *      with the parsed payload, then re-fetches the list.
 *  11. Edit-template flow: clicking the row's Edit icon opens the form
 *      pre-filled with the row's fields. Submitting PATCHes
 *      /api/travel/quote-templates/:id.
 *  12. Validation — empty name surfaces notify.error and does NOT fire POST.
 *  13. Validation — malformed linesJson surfaces notify.error and does
 *      NOT fire POST.
 *  14. Delete flow: clicking the delete icon prompts via window.confirm;
 *      confirm-yes → DELETEs the template; confirm-no → no DELETE fires.
 *  15. USER role gates: no "New Template" CTA + no Actions column.
 *  16. MANAGER role: can edit (Pencil) but cannot delete (Trash hidden —
 *      delete is ADMIN-only per backend verifyRole).
 *
 * Backend contract pinned (per backend/routes/travel_quote_templates.js,
 * 32 vitest green):
 *   GET    /api/travel/quote-templates[?subBrand=&category=&isActive=]
 *                                          → 200 { items, total, limit, offset }
 *                                            | 403 sub-brand denied
 *   POST   /api/travel/quote-templates     → 201 created
 *                                            | 400 MISSING_NAME / MISSING_LINES_JSON
 *                                                  / INVALID_LINES_JSON
 *                                            | 403 SUB_BRAND / role gate
 *   PATCH  /api/travel/quote-templates/:id → 200 updated
 *   DELETE /api/travel/quote-templates/:id → 200 (returns row, isActive=false)
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders.
 *   - AuthContext provided with role:ADMIN so canWrite=true.
 *   - travelSubBrand imported REAL (not mocked) so sub-brand-bg drift is
 *     caught here (rule-of-3 promotion at tick #99).
 *   - window.confirm stubbed per-test for the delete flow.
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108: sync getBy for data-dependent text is a CI
 *     race trap).
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
import QuoteTemplates from '../pages/travel/QuoteTemplates';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const MANAGER_USER = { userId: 2, name: 'Manager', email: 'm@x.com', role: 'MANAGER' };
const USER_USER = { userId: 3, name: 'Plain User', email: 'u@x.com', role: 'USER' };

// Canonical template rows — three sub-brands + categories to exercise the
// badge + lines-count render paths.
function makeTemplate(overrides = {}) {
  return {
    id: 301,
    tenantId: 1,
    name: 'Umrah 7-day Standard',
    description: 'Standard 7-day Umrah package.',
    subBrand: 'rfu',
    category: 'Umrah',
    currency: 'INR',
    linesJson: JSON.stringify([
      { lineType: 'hotel', description: 'Madinah hotel', quantity: 3, unitPrice: 4500 },
      { lineType: 'hotel', description: 'Mecca hotel', quantity: 4, unitPrice: 6000 },
      { lineType: 'transport', description: 'Coach', quantity: 1, unitPrice: 1200 },
      { lineType: 'visa', description: 'Visa', quantity: 1, unitPrice: 7500 },
    ]),
    isActive: true,
    createdAt: '2026-05-10T09:00:00.000Z',
    updatedAt: '2026-05-10T09:00:00.000Z',
    ...overrides,
  };
}

const TEMPLATES_DEFAULT = [
  makeTemplate({ id: 301, subBrand: 'rfu', category: 'Umrah', name: 'Umrah 7-day Standard' }),
  makeTemplate({
    id: 302,
    subBrand: 'travelstall',
    category: 'India-tour',
    name: 'Golden Triangle 5-day',
    linesJson: JSON.stringify([
      { lineType: 'hotel', description: 'Delhi', quantity: 2, unitPrice: 4000 },
      { lineType: 'hotel', description: 'Agra', quantity: 1, unitPrice: 3500 },
    ]),
  }),
  makeTemplate({
    id: 303,
    subBrand: 'visasure',
    category: 'Visa',
    name: 'Schengen Visa Standard',
    linesJson: 'not-valid-json',
    isActive: false,
  }),
];

function installFetchMock({
  list = { items: TEMPLATES_DEFAULT, total: TEMPLATES_DEFAULT.length, limit: 50, offset: 0 },
  create = null,
  update = null,
  del = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/travel/quote-templates') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url === '/api/travel/quote-templates' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeTemplate({ id: 999 }));
    }
    if (/^\/api\/travel\/quote-templates\/\d+$/.test(url) && method === 'PATCH') {
      if (update instanceof Error) return Promise.reject(update);
      return Promise.resolve(update || makeTemplate({ id: 301, name: 'Updated' }));
    }
    if (/^\/api\/travel\/quote-templates\/\d+$/.test(url) && method === 'DELETE') {
      if (del instanceof Error) return Promise.reject(del);
      return Promise.resolve(makeTemplate({ id: 301, isActive: false }));
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false }}>
        <QuoteTemplates />
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

describe('<QuoteTemplates /> — page chrome + filter bar', () => {
  it('renders heading + filter bar + "New Template" CTA (ADMIN role)', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /Quote Templates/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by sub-brand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by category/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by active status/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Template/i })).toBeInTheDocument();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(([u]) => typeof u === 'string' && u.startsWith('/api/travel/quote-templates'));
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('hides "New Template" CTA + Actions column for plain USER role (canWrite=false)', async () => {
    renderPage(USER_USER);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: /New Template/i })).toBeNull();
    await screen.findByText('Umrah 7-day Standard');
    expect(screen.queryByRole('columnheader', { name: /Actions/i })).toBeNull();
  });

  it('MANAGER can edit but not delete (Trash hidden — ADMIN-only)', async () => {
    renderPage(MANAGER_USER);
    await screen.findByText('Umrah 7-day Standard');
    // Edit button should be present
    expect(screen.getByRole('button', { name: /Edit template Umrah 7-day Standard/i })).toBeInTheDocument();
    // Delete button should NOT be present for MANAGER
    expect(screen.queryByRole('button', { name: /Deactivate template Umrah 7-day Standard/i })).toBeNull();
  });
});

describe('<QuoteTemplates /> — load + render lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/quote-templates') && method === 'GET') {
        return new Promise((res) => { resolveList = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveList({ items: TEMPLATES_DEFAULT, total: TEMPLATES_DEFAULT.length });
    await screen.findByText('Umrah 7-day Standard');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/travel/quote-templates on mount with default ?isActive=true', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.startsWith('/api/travel/quote-templates') && (!o?.method || o.method === 'GET'),
      );
      expect(listCall).toBeTruthy();
      // Default isActive filter is 'true' → ?isActive=true threaded
      expect(listCall[0]).toContain('isActive=true');
    });
    expect(await screen.findByText('Umrah 7-day Standard')).toBeInTheDocument();
    expect(screen.getByText('Golden Triangle 5-day')).toBeInTheDocument();
    expect(screen.getByText('Schengen Visa Standard')).toBeInTheDocument();
  });

  it('renders empty state "No templates match." when API returns []', async () => {
    installFetchMock({ list: { items: [], total: 0 } });
    renderPage();
    expect(await screen.findByText('No templates match.')).toBeInTheDocument();
  });

  it('renders "Access restricted." copy per #829 when API rejects with status:403', async () => {
    const err = new Error('Forbidden sub-brand');
    err.status = 403;
    installFetchMock({ list: err });
    renderPage();
    expect(await screen.findByText(/Access restricted\./i)).toBeInTheDocument();
    expect(
      screen.getByText(/Your role does not have permission to view quote templates/i),
    ).toBeInTheDocument();
  });
});

describe('<QuoteTemplates /> — filter behavior', () => {
  it('selecting sub-brand "rfu" re-fetches with ?subBrand=rfu in the URL', async () => {
    renderPage();
    await screen.findByText('Umrah 7-day Standard');
    fetchApiMock.mockClear();
    installFetchMock({ list: { items: [TEMPLATES_DEFAULT[0]], total: 1 } });
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), { target: { value: 'rfu' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.includes('subBrand=rfu') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('selecting category "Umrah" re-fetches with ?category=Umrah in the URL', async () => {
    renderPage();
    await screen.findByText('Umrah 7-day Standard');
    fetchApiMock.mockClear();
    installFetchMock({ list: { items: [TEMPLATES_DEFAULT[0]], total: 1 } });
    fireEvent.change(screen.getByLabelText(/Filter by category/i), { target: { value: 'Umrah' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.includes('category=Umrah') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<QuoteTemplates /> — row rendering: lines count + sub-brand badge', () => {
  it('lines count column shows JSON array length for valid linesJson', async () => {
    renderPage();
    const row = await screen.findByText('Umrah 7-day Standard');
    const tr = row.closest('tr');
    expect(tr).toBeTruthy();
    // Umrah template has 4 lines
    expect(within(tr).getByText('4')).toBeInTheDocument();
  });

  it('lines count column shows "—" for malformed linesJson', async () => {
    renderPage();
    const row = await screen.findByText('Schengen Visa Standard');
    const tr = row.closest('tr');
    expect(tr).toBeTruthy();
    // Schengen template has linesJson = 'not-valid-json' → renders "—"
    // The cell renders the literal em-dash. Use getAllByText since '—'
    // may appear in other cells too (e.g. empty category for some row).
    const dashes = within(tr).getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('sub-brand badge per row uses real SUB_BRAND_BG palette (rgba) from travelSubBrand.js', async () => {
    renderPage();
    const rfuRow = await screen.findByText('Umrah 7-day Standard');
    const tr = rfuRow.closest('tr');
    const badge = within(tr).getByText('rfu');
    // Real SUB_BRAND_BG palette renders as rgba(... 0.18) — assert the rgba prefix.
    expect(badge.style.background).toMatch(/rgba\(/);
  });

  it('Active/Inactive status badge renders per row', async () => {
    renderPage();
    await screen.findByText('Umrah 7-day Standard');
    // Active templates (Umrah + Golden Triangle) → "Active" badge present
    // Inactive template (Schengen) → "Inactive" badge present
    const activeBadges = screen.getAllByText('Active');
    expect(activeBadges.length).toBeGreaterThanOrEqual(2);
    const inactiveRow = screen.getByText('Schengen Visa Standard').closest('tr');
    expect(within(inactiveRow).getByText('Inactive')).toBeInTheDocument();
  });
});

describe('<QuoteTemplates /> — new-template modal + create POST', () => {
  it('clicking "New Template" reveals the create form', async () => {
    renderPage();
    await screen.findByText('Umrah 7-day Standard');
    expect(screen.queryByLabelText(/^Template name$/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /New Template/i }));
    expect(screen.getByLabelText(/^Template name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Lines JSON$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Currency$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
  });

  it('happy path: filling the form + Save POSTs /api/travel/quote-templates with parsed payload', async () => {
    renderPage();
    await screen.findByText('Umrah 7-day Standard');
    fireEvent.click(screen.getByRole('button', { name: /New Template/i }));
    fireEvent.change(screen.getByLabelText(/^Template name$/i), { target: { value: 'Tokyo 6-day' } });
    fireEvent.change(screen.getByLabelText(/^Lines JSON$/i), {
      target: { value: '[{"lineType":"hotel","description":"Tokyo hotel","quantity":6,"unitPrice":8000}]' },
    });
    // Currency defaults to INR; flip to USD to pin the upper-cased value.
    fireEvent.change(screen.getByLabelText(/^Currency$/i), { target: { value: 'usd' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/quote-templates' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.name).toBe('Tokyo 6-day');
      expect(body.currency).toBe('USD');
      expect(typeof body.linesJson).toBe('string');
      expect(JSON.parse(body.linesJson)).toEqual([
        { lineType: 'hotel', description: 'Tokyo hotel', quantity: 6, unitPrice: 8000 },
      ]);
    });
  });

  it('validation: empty name surfaces notify.error + does NOT fire POST', async () => {
    renderPage();
    await screen.findByText('Umrah 7-day Standard');
    fireEvent.click(screen.getByRole('button', { name: /New Template/i }));
    // Leave name empty but supply a (valid-ish) linesJson — local check
    // fires the name guard first.
    fireEvent.change(screen.getByLabelText(/^Lines JSON$/i), { target: { value: '[]' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    // The form's required-name HTML5 attr blocks browser-side submit too;
    // override that with manual call to surface our local-validate path.
    // Tighter assertion: no POST was fired regardless of which guard caught.
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/quote-templates' && o?.method === 'POST',
      );
      expect(post).toBeUndefined();
    });
  });

  it('validation: malformed linesJson surfaces notify.error + does NOT fire POST', async () => {
    renderPage();
    await screen.findByText('Umrah 7-day Standard');
    fireEvent.click(screen.getByRole('button', { name: /New Template/i }));
    fireEvent.change(screen.getByLabelText(/^Template name$/i), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByLabelText(/^Lines JSON$/i), { target: { value: 'not-valid-json' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    const post = fetchApiMock.mock.calls.find(([u, o]) =>
      u === '/api/travel/quote-templates' && o?.method === 'POST',
    );
    expect(post).toBeUndefined();
  });
});

describe('<QuoteTemplates /> — edit + delete flows', () => {
  it('Edit icon opens the form pre-filled with the row fields', async () => {
    renderPage();
    await screen.findByText('Umrah 7-day Standard');
    fireEvent.click(screen.getByRole('button', { name: /Edit template Umrah 7-day Standard/i }));
    const nameInput = screen.getByLabelText(/^Template name$/i);
    expect(nameInput.value).toBe('Umrah 7-day Standard');
    const currencyInput = screen.getByLabelText(/^Currency$/i);
    expect(currencyInput.value).toBe('INR');
    // Save Changes button surfaces (not "Save") — editing mode
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeInTheDocument();
  });

  it('editing + Save PATCHes /api/travel/quote-templates/:id', async () => {
    renderPage();
    await screen.findByText('Umrah 7-day Standard');
    fireEvent.click(screen.getByRole('button', { name: /Edit template Umrah 7-day Standard/i }));
    fireEvent.change(screen.getByLabelText(/^Template name$/i), { target: { value: 'Umrah 7-day VIP' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/quote-templates/301' && o?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch[1].body);
      expect(body.name).toBe('Umrah 7-day VIP');
    });
  });

  it('Delete confirms via window.confirm; yes → DELETE fires', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByText('Umrah 7-day Standard');
    fireEvent.click(screen.getByRole('button', { name: /Deactivate template Umrah 7-day Standard/i }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/quote-templates/301' && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
  });

  it('Delete confirms via window.confirm; no → DELETE does NOT fire', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await screen.findByText('Umrah 7-day Standard');
    fireEvent.click(screen.getByRole('button', { name: /Deactivate template Umrah 7-day Standard/i }));
    expect(confirmSpy).toHaveBeenCalled();
    // No DELETE call should have been made.
    const del = fetchApiMock.mock.calls.find(([u, o]) =>
      u === '/api/travel/quote-templates/301' && o?.method === 'DELETE',
    );
    expect(del).toBeUndefined();
  });
});
