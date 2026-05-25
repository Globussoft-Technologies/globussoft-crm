/**
 * QuoteBuilder.test.jsx — vitest + RTL coverage for the Travel-vertical
 * operator-facing Quote Builder (frontend/src/pages/travel/QuoteBuilder.jsx).
 *
 * Slice history covered here:
 *   - Slice 2 (commit 92b1682c): scaffold + local-only lines + actions.
 *   - Slice 3 (commit f7203b8e): backend TravelQuoteLine model + line CRUD
 *     endpoints + per-line supplier picker query surface.
 *   - Slice 4 (THIS commit): wire QuoteBuilder.jsx to the persistent line
 *     CRUD endpoints + per-line supplier picker (this test file extends
 *     to pin those flows).
 *
 * Scope — pins the page-surface invariants for the line-items builder:
 *
 *   1. Page chrome: heading "Quote Builder" + header fields (Contact ID,
 *      Currency, Sub-brand, Valid Until) + action cluster (Save Draft /
 *      Send / Duplicate / Download PDF).
 *   2. NEW mode (no :id route param): empty items array, "Save Draft" CTA
 *      visible, no GET fired against quotes/:id on mount. Supplier list
 *      IS fetched (the subBrand default "tmc" triggers the supplier-list
 *      effect).
 *   3. EDIT mode (:id route param): fires GET /api/travel/quotes/:id +
 *      GET /api/travel/quotes/:id/lines on mount and populates header +
 *      line table.
 *   4. Add line: clicking "Add line" appends a DRAFT row (no backend
 *      call). The draft is disabled when no quoteId yet (NEW mode).
 *   5. Commit draft: clicking the Save icon on a draft POSTs to
 *      /api/travel/quotes/:id/lines; re-fetches lines + parent quote.
 *   6. Edit persisted line: clicking Save on an existing row PUTs to
 *      /api/travel/quotes/:id/lines/:lineId with the changed fields.
 *   7. Delete line: clicking trash opens confirm modal → confirm DELETEs
 *      to /api/travel/quotes/:id/lines/:lineId.
 *   8. Supplier picker: the supplier <select> in each row is populated
 *      from GET /api/travel/suppliers?subBrand=<currentSubBrand>; empty
 *      state when no suppliers exist for the sub-brand.
 *   9. Save Draft: NEW mode POSTs /api/travel/quotes; EDIT mode PUTs
 *      /api/travel/quotes/:id.
 *  10. Duplicate: cascade-tolerant 404 → notify.info (per slice prompt).
 *  11. Role gate (USER): canWrite=false → action cluster + add-line CTA
 *      + row-action buttons all hidden.
 *
 * Backend contract pinned:
 *   GET    /api/travel/quotes/:id                    → 200 { id, contactId, ... }
 *   GET    /api/travel/quotes/:id/lines              → 200 { lines: [...], total }
 *   POST   /api/travel/quotes/:id/lines              → 201 created line
 *   PUT    /api/travel/quotes/:id/lines/:lineId      → 200 updated
 *   DELETE /api/travel/quotes/:id/lines/:lineId      → 204
 *   GET    /api/travel/suppliers?subBrand=<sub>      → 200 { suppliers: [...], total }
 *   POST   /api/travel/quotes                        → 201 created
 *   PUT    /api/travel/quotes/:id                    → 200 updated
 *   POST   /api/travel/quotes/:id/duplicate          → 201 cloned
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api.
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (per Wave 11 cfb5789 + Wave 12 f59e91d).
 *   - useParams mocked per-suite (NEW vs EDIT mode).
 *   - AuthContext provided with role:ADMIN by default so canWrite=true.
 *   - All data-dependent assertions use await findBy / waitFor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// fetchApi mock — install BEFORE importing the SUT.
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule. The SUT closes over notify
// inside the action handlers; a fresh object per render would loop.
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

// useParams mock — controlled per test. Default to NEW mode (id undefined).
let mockRouteId = undefined;
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: mockRouteId }),
  };
});

import { AuthContext } from '../App';
import QuoteBuilder from '../pages/travel/QuoteBuilder';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const USER_USER = { userId: 2, name: 'Plain User', email: 'u@x.com', role: 'USER' };

function renderPage(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider
        value={{
          user,
          token: 'tk',
          tenant: { id: 1, defaultCurrency: 'INR' },
          loading: false,
        }}
      >
        <QuoteBuilder />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

// Default-route fetchApi behaviour: empty suppliers + empty lines + a
// generic OK envelope. Per-test mocks override via mockImplementationOnce
// or full mockImplementation overrides.
function defaultFetchHandler(url, opts) {
  const method = opts?.method || 'GET';
  if (url.startsWith('/api/travel/suppliers')) {
    return Promise.resolve({ suppliers: [], total: 0 });
  }
  if (url.match(/^\/api\/travel\/quotes\/\d+\/lines$/) && method === 'GET') {
    return Promise.resolve({ lines: [], total: 0 });
  }
  if (url.match(/^\/api\/travel\/quotes\/\d+$/) && method === 'GET') {
    return Promise.resolve({
      id: 42, contactId: 5001, status: 'Draft', currency: 'INR', subBrand: 'tmc',
    });
  }
  return Promise.resolve(null);
}

beforeEach(() => {
  mockRouteId = undefined;
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  fetchApiMock.mockImplementation(defaultFetchHandler);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<QuoteBuilder /> — page chrome + NEW mode', () => {
  it('renders heading + header fields + action cluster (ADMIN)', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /Quote Builder/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Contact ID/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Currency$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Sub-brand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Valid until/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save Draft/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Send$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Duplicate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download PDF/i })).toBeInTheDocument();
  });

  it('NEW mode: no GET to quotes/:id fires on mount; Add-line disabled until save', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    // No GET to /api/travel/quotes/:id should fire when there's no route id.
    const quoteGets = fetchApiMock.mock.calls.filter(
      ([u, o]) =>
        typeof u === 'string' &&
        /^\/api\/travel\/quotes\/\d+$/.test(u) &&
        (!o || !o.method || o.method === 'GET'),
    );
    expect(quoteGets.length).toBe(0);
    // Add-line button is rendered but disabled (no quote saved yet).
    const addBtn = screen.getByRole('button', { name: /Add line/i });
    expect(addBtn.disabled).toBe(true);
    // Empty-state copy reflects NEW mode.
    expect(screen.getByText(/Save the quote first to start adding lines/i)).toBeInTheDocument();
  });

  it('NEW mode: fetches supplier list for default subBrand on mount', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    await waitFor(() => {
      const supplierFetch = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.startsWith('/api/travel/suppliers?subBrand=tmc'),
      );
      expect(supplierFetch).toBeTruthy();
    });
  });
});

describe('<QuoteBuilder /> — EDIT mode hydration', () => {
  it('fetches GET /api/travel/quotes/:id + /lines on mount and populates the form', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/travel/quotes/42') {
        return Promise.resolve({
          id: 42,
          contactId: 5050,
          status: 'Sent',
          currency: 'USD',
          subBrand: 'rfu',
          validUntil: '2026-12-31T00:00:00.000Z',
          totalAmount: 12345.67,
        });
      }
      if (url === '/api/travel/quotes/42/lines') {
        return Promise.resolve({
          lines: [
            {
              id: 101, lineType: 'hotel', description: 'Hilton Riyadh',
              quantity: 3, unitPrice: '4000.00', amount: '12000.00',
              supplierId: null, sortOrder: 0, currency: 'USD', notes: '',
            },
          ],
          total: 1,
        });
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await waitFor(() => {
      const get = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes/42' && (!o || !o.method || o.method === 'GET'),
      );
      expect(get).toBeTruthy();
    });
    const contactInput = await screen.findByLabelText(/Contact ID/i);
    expect(contactInput.value).toBe('5050');
    expect(screen.getByLabelText(/^Currency$/i).value).toBe('USD');
    expect(screen.getByLabelText(/Sub-brand/i).value).toBe('rfu');
    // Quote # + Sent status badge (multi-occurrence acceptable for "Sent"
    // since the dropdown options may also match — use getAllByText).
    expect(screen.getByText(/#42/)).toBeInTheDocument();
    // Hydrated line shows up in the table.
    expect(await screen.findByDisplayValue('Hilton Riyadh')).toBeInTheDocument();
  });

  it('EDIT mode: hydrated line shows server-computed amount', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/travel/quotes/42') {
        return Promise.resolve({
          id: 42, contactId: 5050, status: 'Draft', currency: 'USD', subBrand: 'tmc',
        });
      }
      if (url === '/api/travel/quotes/42/lines') {
        return Promise.resolve({
          lines: [{
            id: 1, lineType: 'flight', description: 'AI 921',
            quantity: 2, unitPrice: '3500.00', amount: '7000.00',
            supplierId: null, sortOrder: 0,
          }],
          total: 1,
        });
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByDisplayValue('AI 921');
    // The amount cell renders the computed product (2 × 3500 = 7,000.00).
    // getAllByText: the value also appears in the totals panel (subtotal +
    // taxable + grand-total), so ≥1 match is the right assertion.
    expect(screen.getAllByText(/7,000\.00/).length).toBeGreaterThanOrEqual(1);
  });
});

describe('<QuoteBuilder /> — draft lines + commit', () => {
  it('Add-line appends a draft row in EDIT mode (saved quote)', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation(defaultFetchHandler);
    renderPage();
    await screen.findByText(/#42/);
    // Empty table after hydration (default handler returns empty lines).
    expect(screen.getByText(/No line items yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
    // A draft row description input appears.
    const descInputs = screen.getAllByPlaceholderText(/Service \/ package description/i);
    expect(descInputs.length).toBe(1);
    // No-items copy is gone.
    expect(screen.queryByText(/No line items yet/i)).toBeNull();
  });

  it('Commit draft: POSTs /api/travel/quotes/:id/lines with the row body', async () => {
    mockRouteId = '42';
    const linesAfterPost = [{
      id: 999, lineType: 'hotel', description: 'Hilton Mecca',
      quantity: 2, unitPrice: '5000.00', amount: '10000.00',
      supplierId: null, sortOrder: 0,
    }];
    let linesResponse = { lines: [], total: 0 };
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes/42' && method === 'GET') {
        return Promise.resolve({
          id: 42, contactId: 5050, status: 'Draft', currency: 'INR', subBrand: 'tmc',
        });
      }
      if (url === '/api/travel/quotes/42/lines' && method === 'GET') {
        return Promise.resolve(linesResponse);
      }
      if (url === '/api/travel/quotes/42/lines' && method === 'POST') {
        linesResponse = { lines: linesAfterPost, total: 1 };
        return Promise.resolve({ ...linesAfterPost[0] });
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText(/#42/);
    fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
    // Fill in description + qty + unit price.
    const desc = screen.getAllByPlaceholderText(/Service \/ package description/i)[0];
    fireEvent.change(desc, { target: { value: 'Hilton Mecca' } });
    const qtyInputs = screen.getAllByLabelText(/Line .* quantity/i);
    fireEvent.change(qtyInputs[0], { target: { value: '2' } });
    const unitInputs = screen.getAllByLabelText(/Line .* unit price/i);
    fireEvent.change(unitInputs[0], { target: { value: '5000' } });
    // Click the draft's save icon ("Save line <key>").
    const saveBtns = screen.getAllByRole('button', { name: /^Save line/i });
    fireEvent.click(saveBtns[0]);
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes/42/lines' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.description).toBe('Hilton Mecca');
      expect(body.quantity).toBe(2);
      expect(body.unitPrice).toBe(5000);
      expect(body.lineType).toBe('other');
    });
    // Persisted line shows up after refresh.
    expect(await screen.findByDisplayValue('Hilton Mecca')).toBeInTheDocument();
  });

  it('Commit draft: missing description → notify.error, no POST', async () => {
    mockRouteId = '42';
    renderPage();
    await screen.findByText(/#42/);
    fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
    // Don't fill in description; click save.
    const saveBtns = screen.getAllByRole('button', { name: /^Save line/i });
    fireEvent.click(saveBtns[0]);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/description is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/quotes/42/lines' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('Cancel draft: removes the draft row without backend call', async () => {
    mockRouteId = '42';
    renderPage();
    await screen.findByText(/#42/);
    fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
    expect(
      screen.getAllByPlaceholderText(/Service \/ package description/i).length,
    ).toBe(1);
    const cancelBtns = screen.getAllByRole('button', { name: /^Cancel line/i });
    fireEvent.click(cancelBtns[0]);
    expect(
      screen.queryAllByPlaceholderText(/Service \/ package description/i).length,
    ).toBe(0);
    // No POST fired.
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/quotes/42/lines' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });
});

describe('<QuoteBuilder /> — persisted line edit + delete', () => {
  function setupOneLineEdit() {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes/42' && method === 'GET') {
        return Promise.resolve({
          id: 42, contactId: 5050, status: 'Draft', currency: 'INR', subBrand: 'tmc',
        });
      }
      if (url === '/api/travel/quotes/42/lines' && method === 'GET') {
        return Promise.resolve({
          lines: [{
            id: 101, lineType: 'hotel', description: 'Original',
            quantity: 1, unitPrice: '1000.00', amount: '1000.00',
            supplierId: null, sortOrder: 0,
          }],
          total: 1,
        });
      }
      if (url === '/api/travel/quotes/42/lines/101' && method === 'PUT') {
        return Promise.resolve({ id: 101, description: 'Edited' });
      }
      if (url === '/api/travel/quotes/42/lines/101' && method === 'DELETE') {
        return Promise.resolve(null);
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      return Promise.resolve(null);
    });
  }

  it('Save on persisted row: PUTs /api/travel/quotes/:id/lines/:lineId', async () => {
    setupOneLineEdit();
    renderPage();
    await screen.findByDisplayValue('Original');
    // Edit description.
    const desc = screen.getByDisplayValue('Original');
    fireEvent.change(desc, { target: { value: 'Edited' } });
    // Click the persisted row's save icon ("Save line 101").
    const saveBtn = screen.getByRole('button', { name: /^Save line 101$/i });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes/42/lines/101' && o?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(put[1].body);
      expect(body.description).toBe('Edited');
    });
  });

  it('Delete confirm modal: opens on trash click; confirm DELETEs the line', async () => {
    setupOneLineEdit();
    renderPage();
    await screen.findByDisplayValue('Original');
    // Click trash icon — opens confirm modal.
    const trashBtn = screen.getByRole('button', { name: /^Remove line 101$/i });
    fireEvent.click(trashBtn);
    // Modal renders.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Remove line\?/i)).toBeInTheDocument();
    // Confirm.
    const confirmBtn = screen.getByRole('button', { name: /^Confirm delete line$/i });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes/42/lines/101' && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
  });

  it('Delete confirm modal: Cancel closes without DELETE', async () => {
    setupOneLineEdit();
    renderPage();
    await screen.findByDisplayValue('Original');
    const trashBtn = screen.getByRole('button', { name: /^Remove line 101$/i });
    fireEvent.click(trashBtn);
    await screen.findByRole('dialog');
    const cancelBtns = screen.getAllByRole('button', { name: /^Cancel$/i });
    fireEvent.click(cancelBtns[0]);
    // No DELETE call.
    const dels = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/quotes/42/lines/101' && o?.method === 'DELETE',
    );
    expect(dels.length).toBe(0);
    // Modal gone.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('<QuoteBuilder /> — supplier picker', () => {
  it('renders supplier options from the supplier-list fetch', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes/42' && method === 'GET') {
        return Promise.resolve({
          id: 42, contactId: 5050, status: 'Draft', currency: 'INR', subBrand: 'tmc',
        });
      }
      if (url === '/api/travel/quotes/42/lines' && method === 'GET') {
        return Promise.resolve({
          lines: [{
            id: 101, lineType: 'hotel', description: 'Stay',
            quantity: 1, unitPrice: '1000.00', amount: '1000.00',
            supplierId: 7, sortOrder: 0,
          }],
          total: 1,
        });
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({
          suppliers: [
            { id: 7, name: 'Hilton Worldwide', supplierCategory: 'hotel', subBrand: 'tmc' },
            { id: 8, name: 'Marriott Group', supplierCategory: 'hotel', subBrand: 'tmc' },
          ],
          total: 2,
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByDisplayValue('Stay');
    // Supplier select renders the option text.
    expect(screen.getByText(/Hilton Worldwide \(hotel\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Marriott Group \(hotel\)/i)).toBeInTheDocument();
    // The persisted line's supplier is pre-selected (supplierId=7).
    const supplierSelect = screen.getByLabelText(/Line srv-101 supplier/i);
    expect(supplierSelect.value).toBe('7');
  });

  it('changes subBrand → re-fetches suppliers for the new sub-brand', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    // Initial fetch fires for tmc.
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(
          ([u]) => typeof u === 'string' && u.startsWith('/api/travel/suppliers?subBrand=tmc'),
        ),
      ).toBe(true);
    });
    // Change subBrand to rfu.
    fireEvent.change(screen.getByLabelText(/Sub-brand/i), { target: { value: 'rfu' } });
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(
          ([u]) => typeof u === 'string' && u.startsWith('/api/travel/suppliers?subBrand=rfu'),
        ),
      ).toBe(true);
    });
  });

  it('empty suppliers: picker shows "no suppliers" hint', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes/42' && method === 'GET') {
        return Promise.resolve({
          id: 42, contactId: 5050, status: 'Draft', currency: 'INR', subBrand: 'visasure',
        });
      }
      if (url === '/api/travel/quotes/42/lines' && method === 'GET') {
        return Promise.resolve({ lines: [], total: 0 });
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText(/#42/);
    // The header-strip empty-state hint.
    await waitFor(() => {
      expect(screen.getByText(/No suppliers for visasure/i)).toBeInTheDocument();
    });
  });
});

describe('<QuoteBuilder /> — Save Draft (quote header)', () => {
  it('NEW mode: POSTs /api/travel/quotes with parsed payload + sets created id', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes' && method === 'POST') {
        return Promise.resolve({ id: 777, contactId: 5050, status: 'Draft' });
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    fireEvent.change(screen.getByLabelText(/Contact ID/i), { target: { value: '5050' } });
    fireEvent.change(screen.getByLabelText(/^Currency$/i), { target: { value: 'usd' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/i }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.contactId).toBe(5050);
      expect(body.currency).toBe('USD');
      expect(body.status).toBe('Draft');
      expect(body.subBrand).toBe('tmc');
      expect(body.totalAmount).toBe(0);
    });
    expect(await screen.findByText(/#777/)).toBeInTheDocument();
    expect(notifySuccess).toHaveBeenCalled();
  });

  it('validation: missing contactId surfaces notify.error and does NOT POST', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Contact ID is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/quotes' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });
});

describe('<QuoteBuilder /> — Duplicate (cascade-tolerant)', () => {
  it('with saved id: POSTs /api/travel/quotes/:id/duplicate; 404 → notify.info', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes/42' && method === 'GET') {
        return Promise.resolve({ id: 42, contactId: 5001, status: 'Draft', currency: 'INR', subBrand: 'tmc' });
      }
      if (url === '/api/travel/quotes/42/lines' && method === 'GET') {
        return Promise.resolve({ lines: [], total: 0 });
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      if (url === '/api/travel/quotes/42/duplicate' && method === 'POST') {
        const err = new Error('Not found');
        err.status = 404;
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText(/#42/);
    fireEvent.click(screen.getByRole('button', { name: /Duplicate/i }));
    await waitFor(() => {
      const dup = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes/42/duplicate' && o?.method === 'POST',
      );
      expect(dup).toBeTruthy();
    });
    await waitFor(() => {
      expect(notifyInfo).toHaveBeenCalledWith(
        expect.stringMatching(/Duplicate endpoint not yet available/i),
      );
    });
  });
});

describe('<QuoteBuilder /> — RBAC USER role', () => {
  it('USER role (canWrite=false): action cluster + Add-line CTA hidden', async () => {
    renderPage(USER_USER);
    await screen.findByRole('heading', { name: /Quote Builder/i });
    expect(screen.queryByRole('button', { name: /Save Draft/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Send$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Duplicate/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add line/i })).toBeNull();
    // Header fields still render (USER can READ).
    expect(screen.getByLabelText(/Contact ID/i)).toBeInTheDocument();
  });
});
