/**
 * QuoteBuilder.test.jsx — vitest + RTL coverage for the Travel-vertical
 * operator-facing Quote Builder (frontend/src/pages/travel/QuoteBuilder.jsx).
 *
 * Slice history covered here:
 *   - Slice 2 (commit 92b1682c): scaffold + local-only lines + actions.
 *   - Slice 3 (commit f7203b8e): backend TravelQuoteLine model + line CRUD
 *     endpoints + per-line supplier picker query surface.
 *   - Slice 4 (commit 188d50c2): wire QuoteBuilder.jsx to the persistent
 *     line CRUD endpoints + per-line supplier picker.
 *   - Slice 6 (commit d2eff34c): "Send to customer" action button +
 *     confirm modal explaining the Q9 Wati WhatsApp credential
 *     dependency. STUB-mode delivery — confirming flips the status to
 *     "Sent" + surfaces a notify.info "Send queued" message. Test cases
 *     pin: button is rendered for Draft quotes / disabled in NEW mode /
 *     disabled when status is "Sent" / confirm modal opens with Q9 copy /
 *     cancel does NOT fire notify.info / accept fires notify.info + PUT
 *     /api/travel/quotes/:id { status: "Sent" }.
 *   - Slice 8 (THIS commit): "Calculate with markups" action button +
 *     dismissable preview panel that reads GET /api/travel/quotes/:id/
 *     pricing-preview (slice 5 endpoint at commit 91a7b931). The preview
 *     is informational — Save Draft still persists the pre-markup
 *     grandTotal. New test cases pin: button rendered in actions row /
 *     disabled in NEW mode / disabled when no lines / click fires GET /
 *     renders subtotal + markupApplied entries + total / empty
 *     markupApplied[] shows the "no rules apply" hint / 5xx fires
 *     notify.error / panel can be dismissed.
 *
 * Scope — pins the page-surface invariants for the line-items builder:
 *
 *   1. Page chrome: heading "Quote Builder" + header fields (Customer,
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
  // R-15 contact picker — Quote Builder mirrors InvoicesAdmin's customer
  // dropdown. Default: a small list covering the EDIT-mode + new-customer
  // selection scenarios used across these tests.
  if (url.startsWith('/api/contacts?fields=summary')) {
    return Promise.resolve([
      { id: 5050, name: 'Ahmed Khan', email: 'ahmed@example.com' },
      { id: 5051, name: 'Bharat Pilgrim', email: 'bharat@example.com' },
      { id: 5052, name: 'Cantonment School', email: 'school@example.com' },
    ]);
  }
  if (url.match(/^\/api\/contacts\/\d+$/) && method === 'GET') {
    return Promise.resolve({ id: 5050, name: 'Ahmed Khan', email: 'ahmed@example.com' });
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
    expect(screen.getByLabelText(/Customer/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Currency$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Sub-brand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Valid until/i)).toBeInTheDocument();
    // NEW mode shows ONLY Save Draft — the rest (Send/Duplicate/PDF/Convert/
    // Accept/Decline) act on a saved quote and appear once it's saved.
    expect(screen.getByRole('button', { name: /Save Draft/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send to customer/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Duplicate/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
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

  // R-15 — Quote Builder must mirror InvoicesAdmin's customer dropdown so
  // operators can't accidentally attach a quote to the wrong customer by
  // typing a wrong numeric id. Pre-fix the field was a raw <input type
  // ="number"> with placeholder "Contact ID *"; post-fix it's a <select>
  // populated from GET /api/contacts?fields=summary&limit=500.
  it('NEW mode: customer field is a <select> populated from /api/contacts', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });

    // The contacts endpoint fires on mount.
    await waitFor(() => {
      const contactsFetch = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.startsWith('/api/contacts?fields=summary'),
      );
      expect(contactsFetch).toBeTruthy();
    });

    const customerSelect = screen.getByLabelText(/Customer/i);
    expect(customerSelect.tagName).toBe('SELECT');
    // The default "Select customer *" placeholder + the 3 seeded contacts
    // from defaultFetchHandler.
    await waitFor(() => {
      expect(customerSelect.querySelectorAll('option').length).toBeGreaterThanOrEqual(4);
    });
    // Contact names + emails are visible in the dropdown options.
    expect(screen.getByRole('option', { name: /Ahmed Khan.*ahmed@example.com/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Bharat Pilgrim/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Select customer/i })).toBeInTheDocument();
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
    const contactInput = await screen.findByLabelText(/Customer/i);
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
      // R-15 customer picker — the dropdown must include id=5050 so the
      // fireEvent.change below can actually select it.
      if (url.startsWith('/api/contacts?fields=summary')) {
        return Promise.resolve([
          { id: 5050, name: 'Ahmed Khan', email: 'ahmed@example.com' },
        ]);
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    // Wait for the contacts list to land before changing the select.
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.find(([u]) =>
          typeof u === 'string' && u.startsWith('/api/contacts?fields=summary'),
        ),
      ).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/Customer/i), { target: { value: '5050' } });
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
        expect.stringMatching(/select a customer/i),
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
    // G017 — Duplicate now opens a modal first (clone-with-margin UX).
    // The toolbar button opens the modal; the "Clone" button inside fires
    // the POST. Leaving the markup input blank keeps the raw-clone path
    // (no marginPercent in body), which is what this 404 cascade test pins.
    fireEvent.click(screen.getByRole('button', { name: /Duplicate/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm duplicate/i }));
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
    expect(screen.queryByRole('button', { name: /Send to customer/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Duplicate/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add line/i })).toBeNull();
    // Header fields still render (USER can READ).
    expect(screen.getByLabelText(/Customer/i)).toBeInTheDocument();
  });
});

describe('<QuoteBuilder /> — Send to customer (slice 6, STUB pending Q9)', () => {
  // Helper: hydrate an EDIT-mode quote so the Send button is enabled.
  // Default status is Draft (button enabled); override for other statuses.
  function setupQuote(overrides = {}) {
    mockRouteId = '42';
    const quote = {
      id: 42,
      contactId: 5050,
      status: 'Draft',
      currency: 'INR',
      subBrand: 'tmc',
      ...overrides,
    };
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes/42' && method === 'GET') {
        return Promise.resolve(quote);
      }
      if (url === '/api/travel/quotes/42/lines' && method === 'GET') {
        return Promise.resolve({ lines: [], total: 0 });
      }
      if (url === '/api/travel/quotes/42' && method === 'PUT') {
        return Promise.resolve({ ...quote, status: 'Sent' });
      }
      if (url === '/api/travel/quotes/42/share' && method === 'POST') {
        return Promise.resolve({
          shareToken: 'tok-abc', shareUrl: 'http://localhost/p/quote/tok-abc',
          email: 'SENT', whatsapp: 'SENT', channel: 'email+whatsapp', status: 'Sent',
        });
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      return Promise.resolve(null);
    });
  }

  it('Send-to-customer button renders in the actions row for a Draft quote', async () => {
    setupQuote();
    renderPage();
    await screen.findByText(/#42/);
    const btn = screen.getByRole('button', { name: /Send to customer/i });
    expect(btn).toBeInTheDocument();
    expect(btn.disabled).toBe(false);
  });

  it('Send button is hidden in NEW mode (no saved quote id yet)', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    // In create mode only Save Draft shows — Send appears once the quote exists.
    expect(screen.queryByRole('button', { name: /Send to customer/i })).toBeNull();
  });

  it('Send stays enabled when status is "Sent" (re-send allowed)', async () => {
    setupQuote({ status: 'Sent' });
    renderPage();
    await screen.findByText(/#42/);
    const btn = screen.getByRole('button', { name: /Re-send/i });
    expect(btn.disabled).toBe(false);
  });

  it('Confirm modal explains the secure customer link + email/WhatsApp delivery', async () => {
    setupQuote();
    renderPage();
    await screen.findByText(/#42/);
    fireEvent.click(screen.getByRole('button', { name: /Send to customer/i }));
    const dialog = await screen.findByRole('dialog', { name: /Confirm send to customer/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/secure customer link/i)).toBeInTheDocument();
  });

  it('Confirm-Cancel closes the modal and does NOT fire notify.info', async () => {
    setupQuote();
    renderPage();
    await screen.findByText(/#42/);
    fireEvent.click(screen.getByRole('button', { name: /Send to customer/i }));
    await screen.findByRole('dialog', { name: /Confirm send to customer/i });
    // The send-confirm modal's Cancel button is the only ^Cancel$ button on
    // screen at this point (the delete modal isn't open).
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /Confirm send to customer/i }),
      ).toBeNull();
    });
    expect(notifyInfo).not.toHaveBeenCalledWith(
      expect.stringMatching(/Send queued/i),
    );
    // No PUT fired against /quotes/42 either.
    const puts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/quotes/42' && o?.method === 'PUT',
    );
    expect(puts.length).toBe(0);
  });

  it('Confirm-send POSTs /quotes/:id/share { channel: "auto" } and toasts the channel', async () => {
    setupQuote();
    renderPage();
    await screen.findByText(/#42/);
    fireEvent.click(screen.getByRole('button', { name: /Send to customer/i }));
    await screen.findByRole('dialog', { name: /Confirm send to customer/i });
    fireEvent.click(
      screen.getByRole('button', { name: /^Confirm send to customer$/i }),
    );
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes/42/share' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post[1].body)).toEqual({ channel: 'auto' });
    });
    expect(notifySuccess).toHaveBeenCalledWith('Quote sent to the customer via email + WhatsApp');
  });

  it('Confirm-send surfaces the customer share link', async () => {
    setupQuote();
    renderPage();
    await screen.findByText(/#42/);
    fireEvent.click(screen.getByRole('button', { name: /Send to customer/i }));
    await screen.findByRole('dialog', { name: /Confirm send to customer/i });
    fireEvent.click(
      screen.getByRole('button', { name: /^Confirm send to customer$/i }),
    );
    expect(await screen.findByText('http://localhost/p/quote/tok-abc')).toBeInTheDocument();
  });
});

describe('<QuoteBuilder /> — Calculate with markups (slice 8 pricing-preview)', () => {
  // Helper: hydrate an EDIT-mode quote that has ≥1 persisted line so the
  // "Calculate with markups" button is enabled. The supplier fetch is
  // empty by default (irrelevant to this surface).
  function setupQuoteWithLines(previewResponse) {
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
            id: 101, lineType: 'hotel', description: 'Hilton Mecca',
            quantity: 2, unitPrice: '5000.00', amount: '10000.00',
            supplierId: null, sortOrder: 0,
          }],
          total: 1,
        });
      }
      if (url === '/api/travel/quotes/42/pricing-preview' && method === 'GET') {
        if (previewResponse instanceof Error) return Promise.reject(previewResponse);
        return Promise.resolve(previewResponse);
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      return Promise.resolve(null);
    });
  }

  it('renders the "Calculate with markups" button in the actions row', async () => {
    setupQuoteWithLines({ subtotal: 0, markupApplied: [], total: 0, currency: 'INR', lines: [] });
    renderPage();
    await screen.findByText(/#42/);
    const btn = await screen.findByRole('button', { name: /Calculate with markups/i });
    expect(btn).toBeInTheDocument();
  });

  it('button is HIDDEN in NEW mode (no saved id)', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    // Create mode shows only Save Draft; Calculate appears on a saved quote.
    expect(screen.queryByRole('button', { name: /Calculate with markups/i })).toBeNull();
  });

  it('button is DISABLED when the quote has zero visible lines', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes/42' && method === 'GET') {
        return Promise.resolve({
          id: 42, contactId: 5050, status: 'Draft', currency: 'INR', subBrand: 'tmc',
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
    const btn = screen.getByRole('button', { name: /Calculate with markups/i });
    expect(btn.disabled).toBe(true);
  });

  it('clicking the button fires GET /api/travel/quotes/:id/pricing-preview', async () => {
    setupQuoteWithLines({
      subtotal: 10000,
      markupApplied: [],
      total: 10000,
      currency: 'INR',
      lines: [],
    });
    renderPage();
    await screen.findByDisplayValue('Hilton Mecca');
    const btn = screen.getByRole('button', { name: /Calculate with markups/i });
    fireEvent.click(btn);
    await waitFor(() => {
      const get = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          u === '/api/travel/quotes/42/pricing-preview' &&
          (!o || !o.method || o.method === 'GET'),
      );
      expect(get).toBeTruthy();
    });
  });

  it('renders subtotal + markupApplied entries + total from the response', async () => {
    setupQuoteWithLines({
      subtotal: 10000,
      markupApplied: [
        { ruleId: 1, ruleName: 'TMC Hotel Markup', percent: 12.5, amount: 1250 },
        { ruleId: 2, ruleName: 'Peak Season Surcharge', percent: 5, amount: 500 },
      ],
      total: 11750,
      currency: 'INR',
      lines: [
        { id: 101, lineType: 'hotel', description: 'Hilton Mecca', amount: 10000, amountWithMarkup: 11750 },
      ],
    });
    renderPage();
    await screen.findByDisplayValue('Hilton Mecca');
    fireEvent.click(screen.getByRole('button', { name: /Calculate with markups/i }));
    // Wait for the preview panel to appear.
    await screen.findByLabelText(/Pricing preview subtotal/i);
    // Subtotal (10,000.00).
    const subtotalEl = screen.getByLabelText(/Pricing preview subtotal/i);
    expect(subtotalEl.textContent).toMatch(/10,000\.00/);
    expect(subtotalEl.textContent).toMatch(/INR/);
    // Markup rules — both rule names + percentages render.
    expect(screen.getByText(/TMC Hotel Markup/)).toBeInTheDocument();
    expect(screen.getByText(/Peak Season Surcharge/)).toBeInTheDocument();
    // Combined percent + amount fragments render somewhere in the panel.
    const rulesList = screen.getByLabelText(/Markup rules applied/i);
    expect(rulesList.textContent).toMatch(/12\.5%/);
    expect(rulesList.textContent).toMatch(/1,250\.00/);
    expect(rulesList.textContent).toMatch(/5%/);
    expect(rulesList.textContent).toMatch(/500\.00/);
    // Total with markup (11,750.00).
    const totalEl = screen.getByLabelText(/Pricing preview total/i);
    expect(totalEl.textContent).toMatch(/11,750\.00/);
    expect(totalEl.textContent).toMatch(/INR/);
  });

  it('empty markupApplied[] renders the "no rules apply" hint', async () => {
    setupQuoteWithLines({
      subtotal: 10000,
      markupApplied: [],
      total: 10000,
      currency: 'INR',
      lines: [],
    });
    renderPage();
    await screen.findByDisplayValue('Hilton Mecca');
    fireEvent.click(screen.getByRole('button', { name: /Calculate with markups/i }));
    await screen.findByLabelText(/No markup rules apply/i);
    expect(
      screen.getByText(/No markup rules apply for this sub-brand/i),
    ).toBeInTheDocument();
    // Subtotal and total still render.
    expect(screen.getByLabelText(/Pricing preview subtotal/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Pricing preview total/i)).toBeInTheDocument();
  });

  it('5xx response fires notify.error and does NOT open the panel', async () => {
    const err = new Error('Internal Server Error');
    err.status = 500;
    err.data = { error: 'Failed to compute pricing preview' };
    setupQuoteWithLines(err);
    renderPage();
    await screen.findByDisplayValue('Hilton Mecca');
    fireEvent.click(screen.getByRole('button', { name: /Calculate with markups/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to compute pricing preview/i),
      );
    });
    // Panel did NOT render (the aria-labelled subtotal element is absent).
    expect(screen.queryByLabelText(/Pricing preview subtotal/i)).toBeNull();
  });

  it('panel can be dismissed via the close button', async () => {
    setupQuoteWithLines({
      subtotal: 10000,
      markupApplied: [],
      total: 10000,
      currency: 'INR',
      lines: [],
    });
    renderPage();
    await screen.findByDisplayValue('Hilton Mecca');
    fireEvent.click(screen.getByRole('button', { name: /Calculate with markups/i }));
    // Panel renders.
    await screen.findByLabelText(/Pricing preview subtotal/i);
    // Click the dismiss button.
    fireEvent.click(screen.getByRole('button', { name: /Dismiss pricing preview/i }));
    // Panel is gone.
    await waitFor(() => {
      expect(screen.queryByLabelText(/Pricing preview subtotal/i)).toBeNull();
    });
  });

  it('preview is informational only — Save Draft body still carries pre-markup total', async () => {
    // Verifies the standing contract that Save Draft does NOT use the
    // preview total. After computing a preview that returns a different
    // total than grandTotal, Save Draft's PUT body should still carry the
    // pre-markup grandTotal (which is 10,000 for one hotel line at 2×5000).
    setupQuoteWithLines({
      subtotal: 10000,
      markupApplied: [{ ruleId: 1, ruleName: 'TMC Hotel Markup', percent: 12.5, amount: 1250 }],
      total: 11250,
      currency: 'INR',
      lines: [],
    });
    renderPage();
    await screen.findByDisplayValue('Hilton Mecca');
    // Compute the preview.
    fireEvent.click(screen.getByRole('button', { name: /Calculate with markups/i }));
    await screen.findByLabelText(/Pricing preview total/i);
    // Now Save Draft.
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/i }));
    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes/42' && o?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(put[1].body);
      // Pre-markup total (10,000) — NOT the preview total (11,250).
      expect(body.totalAmount).toBe(10000);
    });
  });
});

// Slice 10 (PRD_TRAVEL_QUOTE_BUILDER FR-3.9 + AC-6.6 + AC-6.11) — convert
// the current quote to a Draft TravelInvoice via POST /:id/convert-to-
// invoice. UI pins: button rendered in action cluster, disabled in NEW
// mode, success path fires notify.success with the new invoice id, the
// idempotency path (server returns alreadyConverted=true) fires
// notify.info instead.
describe('<QuoteBuilder /> — Convert to invoice (slice 10)', () => {
  it('Convert-to-invoice button is HIDDEN in NEW mode (appears on a saved quote)', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    expect(screen.queryByRole('button', { name: /Convert to invoice/i })).toBeNull();
  });

  it('EDIT mode happy path: POSTs convert-to-invoice + notifies success with new invoice id', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/quotes/42' && (!opts || opts.method === undefined || opts.method === 'GET')) {
        return Promise.resolve({
          id: 42, contactId: 5001, status: 'Draft', currency: 'INR', subBrand: 'tmc',
        });
      }
      if (url === '/api/travel/quotes/42/lines') {
        return Promise.resolve({ lines: [], total: 0 });
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      if (
        url === '/api/travel/quotes/42/convert-to-invoice' &&
        opts?.method === 'POST'
      ) {
        return Promise.resolve({
          invoice: {
            id: 7777, quoteId: 42, invoiceNum: 'TINV-2026-0001',
            status: 'Draft', totalAmount: '12500.00', currency: 'INR',
          },
          linesCloned: 2,
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    // Wait for hydration so the button is enabled.
    await screen.findByRole('heading', { name: /Quote Builder/i });
    const btn = await screen.findByRole('button', { name: /Convert to invoice/i });
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes/42/convert-to-invoice' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Invoice #7777.*from quote #42/i),
      );
    });
  });

  it('EDIT mode idempotency: alreadyConverted=true → notify.info, NOT notify.success', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/quotes/42' && (!opts || opts.method === undefined || opts.method === 'GET')) {
        return Promise.resolve({
          id: 42, contactId: 5001, status: 'Draft', currency: 'INR', subBrand: 'tmc',
        });
      }
      if (url === '/api/travel/quotes/42/lines') {
        return Promise.resolve({ lines: [], total: 0 });
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      if (
        url === '/api/travel/quotes/42/convert-to-invoice' &&
        opts?.method === 'POST'
      ) {
        return Promise.resolve({
          invoice: {
            id: 7000, quoteId: 42, invoiceNum: 'TINV-2026-0042', status: 'Draft',
          },
          alreadyConverted: true,
          code: 'ALREADY_CONVERTED',
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    const btn = await screen.findByRole('button', { name: /Convert to invoice/i });
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => {
      expect(notifyInfo).toHaveBeenCalledWith(
        expect.stringMatching(/Already converted.*invoice #7000/i),
      );
    });
    // Success path NOT taken.
    expect(notifySuccess).not.toHaveBeenCalledWith(
      expect.stringMatching(/created from quote/i),
    );
  });
});

// Slice 11 (THIS commit): Accept + Decline workflow buttons + confirm
// modal. Backend ships dedicated POST /api/travel/quotes/:id/{accept,
// decline} endpoints with status-transition guards + audit action codes
// (TRAVEL_QUOTE_ACCEPTED / TRAVEL_QUOTE_DECLINED). Frontend adds two
// header buttons; Decline opens a confirm modal with an optional reason
// textarea (captured server-side in the audit details payload — schema
// has no rejectionReason column in this slice).
//
// What's pinned here:
//   - Both Accept + Decline buttons render in the action cluster (ADMIN).
//   - Both disabled in NEW mode (no quoteId).
//   - Both disabled when status is already Accepted / Rejected.
//   - Accept click fires POST /accept; notify.success on 200.
//   - Decline click opens the confirm modal; cancel closes without POST.
//   - Decline confirm fires POST /decline with the reason body.
//   - 409 INVALID_TRANSITION surfaces as notify.error.
//   - alreadyAccepted=true surfaces notify.info, NOT notify.success.
describe('<QuoteBuilder /> — slice 11 Accept / Decline workflow', () => {
  it('renders Accept + Decline buttons for a saved quote', async () => {
    mockRouteId = '42';
    renderPage();
    await screen.findByText(/#42/);
    expect(screen.getByRole('button', { name: /Accept quote/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Decline quote/i })).toBeInTheDocument();
  });

  it('NEW mode: Accept + Decline are hidden (no quoteId yet)', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    // Create mode shows only Save Draft; Accept/Decline act on a saved quote.
    expect(screen.queryByRole('button', { name: /Accept quote/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Decline quote/i })).toBeNull();
  });

  it('EDIT mode with Accepted status: Accept disabled, Decline disabled', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/travel/quotes/42') {
        return Promise.resolve({
          id: 42, contactId: 5001, status: 'Accepted', currency: 'INR', subBrand: 'tmc',
        });
      }
      if (url === '/api/travel/quotes/42/lines') {
        return Promise.resolve({ lines: [], total: 0 });
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText(/#42/);
    const acceptBtn = await screen.findByRole('button', { name: /Accept quote/i });
    const declineBtn = screen.getByRole('button', { name: /Decline quote/i });
    await waitFor(() => {
      expect(acceptBtn.disabled).toBe(true);
      expect(declineBtn.disabled).toBe(true);
    });
  });

  it('EDIT mode Draft: Accept click fires POST /accept and surfaces success', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes/42' && method === 'GET') {
        return Promise.resolve({
          id: 42, contactId: 5001, status: 'Draft', currency: 'INR', subBrand: 'tmc',
        });
      }
      if (url === '/api/travel/quotes/42/lines') {
        return Promise.resolve({ lines: [], total: 0 });
      }
      if (url.startsWith('/api/travel/suppliers')) {
        return Promise.resolve({ suppliers: [], total: 0 });
      }
      if (url === '/api/travel/quotes/42/accept' && method === 'POST') {
        return Promise.resolve({
          quote: { id: 42, status: 'Accepted', subBrand: 'tmc', contactId: 5001 },
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText(/#42/);
    const acceptBtn = await screen.findByRole('button', { name: /Accept quote/i });
    await waitFor(() => expect(acceptBtn.disabled).toBe(false));
    fireEvent.click(acceptBtn);
    await waitFor(() => {
      const acceptCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes/42/accept' && o?.method === 'POST',
      );
      expect(acceptCall).toBeTruthy();
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Quote #42 accepted/i),
      );
    });
  });

  it('Accept idempotency: alreadyAccepted=true → notify.info not notify.success', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes/42' && method === 'GET') {
        return Promise.resolve({
          id: 42, contactId: 5001, status: 'Draft', currency: 'INR', subBrand: 'tmc',
        });
      }
      if (url === '/api/travel/quotes/42/lines') return Promise.resolve({ lines: [], total: 0 });
      if (url.startsWith('/api/travel/suppliers')) return Promise.resolve({ suppliers: [], total: 0 });
      if (url === '/api/travel/quotes/42/accept' && method === 'POST') {
        return Promise.resolve({
          quote: { id: 42, status: 'Accepted', subBrand: 'tmc', contactId: 5001 },
          alreadyAccepted: true,
          code: 'ALREADY_ACCEPTED',
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText(/#42/);
    const acceptBtn = await screen.findByRole('button', { name: /Accept quote/i });
    await waitFor(() => expect(acceptBtn.disabled).toBe(false));
    fireEvent.click(acceptBtn);
    await waitFor(() => {
      expect(notifyInfo).toHaveBeenCalledWith(
        expect.stringMatching(/Quote #42 was already accepted/i),
      );
    });
    expect(notifySuccess).not.toHaveBeenCalledWith(
      expect.stringMatching(/Quote #42 accepted$/i),
    );
  });

  it('Decline button opens a confirm modal with a reason textarea; cancel does not POST', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/travel/quotes/42') {
        return Promise.resolve({
          id: 42, contactId: 5001, status: 'Draft', currency: 'INR', subBrand: 'tmc',
        });
      }
      if (url === '/api/travel/quotes/42/lines') return Promise.resolve({ lines: [], total: 0 });
      if (url.startsWith('/api/travel/suppliers')) return Promise.resolve({ suppliers: [], total: 0 });
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText(/#42/);
    const declineBtn = await screen.findByRole('button', { name: /Decline quote/i });
    await waitFor(() => expect(declineBtn.disabled).toBe(false));
    fireEvent.click(declineBtn);
    // Modal renders.
    expect(await screen.findByRole('dialog', { name: /Confirm decline quote/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Decline reason/i)).toBeInTheDocument();
    // Cancel → modal closes; no POST to /decline.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Confirm decline quote/i })).toBeNull();
    });
    const declineCalls = fetchApiMock.mock.calls.filter(
      ([u]) => typeof u === 'string' && u.includes('/decline'),
    );
    expect(declineCalls.length).toBe(0);
  });

  it('Decline confirm with reason fires POST /decline with the reason body', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes/42' && method === 'GET') {
        return Promise.resolve({
          id: 42, contactId: 5001, status: 'Sent', currency: 'INR', subBrand: 'tmc',
        });
      }
      if (url === '/api/travel/quotes/42/lines') return Promise.resolve({ lines: [], total: 0 });
      if (url.startsWith('/api/travel/suppliers')) return Promise.resolve({ suppliers: [], total: 0 });
      if (url === '/api/travel/quotes/42/decline' && method === 'POST') {
        return Promise.resolve({
          quote: { id: 42, status: 'Rejected', subBrand: 'tmc', contactId: 5001 },
          reason: 'Budget too high',
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText(/#42/);
    const declineBtn = await screen.findByRole('button', { name: /Decline quote/i });
    await waitFor(() => expect(declineBtn.disabled).toBe(false));
    fireEvent.click(declineBtn);
    const textarea = await screen.findByLabelText(/Decline reason/i);
    fireEvent.change(textarea, { target: { value: 'Budget too high' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm decline quote/i }));
    await waitFor(() => {
      const declineCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes/42/decline' && o?.method === 'POST',
      );
      expect(declineCall).toBeTruthy();
      const body = JSON.parse(declineCall[1].body);
      expect(body.reason).toBe('Budget too high');
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Quote #42 declined/i),
      );
    });
  });

  it('Accept 409 INVALID_TRANSITION → notify.error using server message', async () => {
    mockRouteId = '42';
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes/42' && method === 'GET') {
        return Promise.resolve({
          id: 42, contactId: 5001, status: 'Draft', currency: 'INR', subBrand: 'tmc',
        });
      }
      if (url === '/api/travel/quotes/42/lines') return Promise.resolve({ lines: [], total: 0 });
      if (url.startsWith('/api/travel/suppliers')) return Promise.resolve({ suppliers: [], total: 0 });
      if (url === '/api/travel/quotes/42/accept' && method === 'POST') {
        const err = new Error('Cannot accept a quote in status "Rejected"');
        err.status = 409;
        err.data = { error: 'Cannot accept a quote in status "Rejected"', code: 'INVALID_TRANSITION' };
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText(/#42/);
    const acceptBtn = await screen.findByRole('button', { name: /Accept quote/i });
    await waitFor(() => expect(acceptBtn.disabled).toBe(false));
    fireEvent.click(acceptBtn);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Cannot accept a quote in status "Rejected"/),
      );
    });
  });
});

describe('<QuoteBuilder /> — TBO flight/hotel search', () => {
  it('searches flights (accepts city names) and adds a result as a draft line', async () => {
    mockRouteId = undefined; // NEW quote
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/search/flights' && opts?.method === 'POST') {
        return Promise.resolve({
          provider: 'stub', currency: 'INR', stub: true,
          resolved: { from: { input: 'Delhi', iata: 'DEL' }, to: { input: 'Jeddah', iata: 'JED' } },
          options: [{ airline: 'AI', airlineName: 'Air India', flightNumber: 'AI-302', from: 'DEL', to: 'JED', fare: 50000, fareClass: 'Economy', stops: 0, baggage: '30kg' }],
        });
      }
      return defaultFetchHandler(url, opts);
    });
    renderPage();
    fireEvent.change(screen.getByLabelText('Flight from'), { target: { value: 'Delhi' } });
    fireEvent.change(screen.getByLabelText('Flight to'), { target: { value: 'Jeddah' } });
    fireEvent.change(screen.getByLabelText('Flight date'), { target: { value: '2026-08-02' } });
    fireEvent.click(screen.getByRole('button', { name: /Search flights/i }));

    // Result row appears (with the resolved city→IATA echo).
    await screen.findByText(/Air India · AI-302 DEL→JED/);
    // Add → a draft flight line shows up in the line-items table.
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByDisplayValue('Air India AI-302 DEL → JED (Economy)')).toBeInTheDocument();
    // The fare lands as the line unit price.
    expect(screen.getByDisplayValue('50000')).toBeInTheDocument();
  });

  it('searches hotels and adds a result as a draft line', async () => {
    mockRouteId = undefined;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/search/hotels' && opts?.method === 'POST') {
        return Promise.resolve({
          provider: 'stub', currency: 'INR', stub: true,
          hotels: [{ name: 'Jeddah Grand Hotel', city: 'Jeddah', starRating: 5, roomType: 'Deluxe Room', board: 'Breakfast', totalRate: 18000, ratePerNight: 9000, refundable: true }],
        });
      }
      return defaultFetchHandler(url, opts);
    });
    renderPage();
    fireEvent.change(screen.getByLabelText('Hotel city'), { target: { value: 'Jeddah' } });
    fireEvent.change(screen.getByLabelText('Check-in'), { target: { value: '2026-08-02' } });
    fireEvent.change(screen.getByLabelText('Check-out'), { target: { value: '2026-08-04' } });
    fireEvent.click(screen.getByRole('button', { name: /Search hotels/i }));

    await screen.findByText(/Jeddah Grand Hotel/);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByDisplayValue('Jeddah Grand Hotel, Jeddah — Deluxe Room')).toBeInTheDocument();
    // 2-night stay (08-02 → 08-04) multiplies: unit = ₹9,000/night, qty = 2.
    expect(screen.getByDisplayValue('9000')).toBeInTheDocument();
  });

  it('1-click Suggest auto-fills round-trip flights + a hotel per city as draft lines', async () => {
    mockRouteId = undefined;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/search/flights' && opts?.method === 'POST') {
        const b = JSON.parse(opts.body);
        return Promise.resolve({
          provider: 'stub', currency: 'INR', stub: true,
          options: [{ airline: 'AI', airlineName: 'Air India', flightNumber: 'AI-1', from: b.from, to: b.to, fare: 40000, fareClass: 'Economy', stops: 0 }],
        });
      }
      if (url === '/api/travel/search/hotels' && opts?.method === 'POST') {
        const b = JSON.parse(opts.body);
        return Promise.resolve({
          provider: 'stub', currency: 'INR', stub: true,
          hotels: [{ name: `${b.city} Hotel`, city: b.city, starRating: 4, roomType: 'Deluxe', board: 'Room Only', totalRate: 12000, ratePerNight: 6000 }],
        });
      }
      return defaultFetchHandler(url, opts);
    });
    renderPage();
    fireEvent.change(screen.getByLabelText('Leaving from'), { target: { value: 'Bangalore' } });
    fireEvent.change(screen.getByLabelText('Trip start date'), { target: { value: '2026-08-02' } });
    fireEvent.change(screen.getByLabelText('Destination city 1'), { target: { value: 'Makkah' } });
    fireEvent.click(screen.getByRole('button', { name: /Suggest flights & hotels/i }));

    // Outbound + return flights (full city names) and the Makkah hotel all land.
    await screen.findByDisplayValue('Air India AI-1 Bangalore → Makkah (Economy)');
    expect(screen.getByDisplayValue('Air India AI-1 Makkah → Bangalore (Economy)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Makkah Hotel, Makkah — Deluxe')).toBeInTheDocument();
  });
});
