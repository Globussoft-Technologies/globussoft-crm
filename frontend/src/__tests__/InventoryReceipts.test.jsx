/**
 * InventoryReceipts.test.jsx — vitest + RTL coverage for the wellness-vertical
 * inventory-receipts admin page (frontend/src/pages/wellness/InventoryReceipts.jsx).
 *
 * Scope: pins the page-surface invariants for the receipts ledger CRUD —
 * heading + total-cost sub-copy + "Record receipt" CTA, three parallel mount
 * fetches (receipts + products + vendors), client-side free-text search, the
 * shared <DateRangePicker> integration (defaults to 'today' preset so the URL
 * carries ?from=YYYY-MM-DD&to=YYYY-MM-DD on first GET), receipt-row layout
 * (receipt # + product + vendor + qty + unit-cost + total + received date),
 * form open/close + CTA-label flip, and create POST shape (parseInt /
 * parseFloat / null coercions + notify.success + refetch).
 *
 * Test cases (9):
 *   1. Heading "Inventory receipts" + ArrowDownToLine icon + "Record receipt"
 *      CTA + sub-copy ("0 receipts in window — total cost ₹0") render on
 *      mount; total-cost is INR formatted.
 *   2. Loading state: "Loading…" renders while the in-flight GETs are blocked
 *      (per CLAUDE.md tick #108 cron-learning — pin the actual literal).
 *   3. All three GETs fire on mount (receipts ?from=today&to=today / products /
 *      active-only vendors) and rows render: receipt # + product name + vendor
 *      name + qty + currency-formatted unit-cost + total + received date.
 *   4. Empty-state copy "No receipts in window." renders when receipts GET
 *      resolves to []; switches to "No receipts match your search." once the
 *      operator types a search term that has no matches.
 *   5. Inactive vendors are filtered out of the dropdown (SUT line 81 —
 *      vens.filter((v) => v.isActive)).
 *   6. Free-text search narrows the visible rows client-side (matches receipt
 *      #, vendor name, product name, SKU, batch, notes — case-insensitive).
 *   7. Clicking "Record receipt" opens the form; the CTA label flips to
 *      "Cancel"; clicking Cancel resets + re-shows "Record receipt".
 *   8. Form productId + quantity + unit-cost inputs carry the `required`
 *      attribute (browser-native blank-blocking).
 *   9. Submitting → POST /api/wellness/inventory/receipts with coerced body
 *      (productId/vendorId parseInt, quantity/unitCost parseFloat, null
 *      fallbacks for blank batchNumber/expiryDate/notes) + notify.success
 *      (with returned receiptNumber) + refetches the receipts list.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/) with a
 *     stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap useEffect dep identity and
 *     infinite-re-render-hang the test).
 *   - SUT does NOT consume AuthContext (no useAuth import) → no Provider
 *     wrapper. MemoryRouter is defensive in case a lazy descendant pulls in
 *     react-router. (Drift: the SUT itself does not import react-router.)
 *   - Effective date range derives via the shared <DateRangePicker>'s
 *     `effectiveRangeFor` helper — the test fires GETs whose URL embeds
 *     today's ISO date. Match the receipts URL via a regex (?from=YYYY-MM-DD
 *     &to=YYYY-MM-DD) to avoid hard-pinning the local-clock date (avoids
 *     midnight-boundary flake per the 2026-05-07 wave-9 cron-learning).
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "expiry-date display: future / expired visual
 *     treatment". REALITY: SUT does NOT render an expiry column at all —
 *     expiryDate is captured in the form (SUT line 199) but never displayed
 *     in the receipts table (SUT lines 215-240). Table columns are: Receipt #
 *     / Product / Vendor / Qty / Unit cost / Total / Received. Omitted that
 *     case.
 *   - Prompt anticipated "Money formatting: unit-cost + total render in
 *     tenant currency". REALITY: SUT hard-codes the rupee symbol (`₹${r.unitCost}`
 *     / `₹${r.totalCost}` at SUT lines 234-235) — NO `formatMoney()` helper,
 *     NO tenant currency lookup. Pin the literal `₹` prefix instead of a
 *     tenant-currency call.
 *   - Prompt anticipated "vendor/product/date filter narrows query". REALITY:
 *     SUT has NO vendor/product filter dropdowns. Only the date-range picker
 *     + the free-text search bar narrow the list (date range hits the server
 *     via ?from&to; search is client-side). Case 6 covers the search; the
 *     date filter is implicitly exercised by case 3's URL pattern.
 *   - Prompt anticipated "validation: empty vendor/product, zero qty, negative
 *     unit-cost rejected". REALITY: SUT uses HTML5 native validation —
 *     `required` on productId/quantity/unitCost + `min="0.01"` on quantity +
 *     `min="0"` on unitCost. No JS validation path. Vendor is OPTIONAL in the
 *     SUT (line 192-195 — first option "No vendor"). Pinned via attribute
 *     presence in case 8.
 *   - Prompt anticipated "RBAC: USER hides New-Receipt CTA only if SUT
 *     enforces (likely backend-only)". CONFIRMED backend-only — SUT does NOT
 *     consume AuthContext; the New-Receipt CTA + form render for every
 *     authenticated client. The `adminGate` middleware on inventory.js gates
 *     the write endpoints. Omitted in-page RBAC tests (covered by route api
 *     spec).
 *   - Prompt anticipated "error handling: 500 → silent degrade or
 *     notify.error". CONFIRMED silent-degrade: each load() catches and
 *     defaults to []/[] (SUT lines 75-77 `.catch(() => [])`); submit() has a
 *     bare `catch (_err)` (SUT line 107) with a "toasted" inline comment
 *     since fetchApi internally toasts the server message. No explicit
 *     notify.error call site to assert. Omitted.
 *   - SHELL-vs-real: SUT is REAL CRUD with full receipts ledger + form +
 *     mount fetch + create POST + refetch. NOT a placeholder.
 *
 * Path: flat __tests__/InventoryReceipts.test.jsx — matches sibling
 * Vendors/Drugs/Inventory flat-path convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789, Wave 12 f59e91d).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import InventoryReceipts from '../pages/wellness/InventoryReceipts';

const RECEIPT_DERMA = {
  id: 1101,
  receiptNumber: 'RCP-2026-00042',
  productId: 501,
  vendorId: 301,
  product: { id: 501, name: 'Derma Filler 1ml', sku: 'DF-1ML' },
  vendor: { id: 301, name: 'Sterile Supplies Pvt Ltd' },
  quantity: 10,
  unitCost: 4500,
  totalCost: 45000,
  batchNumber: 'B-2026-0517',
  receivedAt: '2026-05-17T10:00:00.000Z',
  notes: null,
};
const RECEIPT_NEEDLES = {
  id: 1102,
  receiptNumber: 'RCP-2026-00043',
  productId: 502,
  vendorId: null,
  product: { id: 502, name: '30G Hypodermic Needles', sku: 'NDL-30G' },
  vendor: null,
  quantity: 200,
  unitCost: 7.5,
  totalCost: 1500,
  batchNumber: null,
  receivedAt: '2026-05-18T09:30:00.000Z',
  notes: 'Restock for hub',
};

const ACTIVE_VENDOR = { id: 301, name: 'Sterile Supplies Pvt Ltd', isActive: true };
const INACTIVE_VENDOR = { id: 999, name: 'Legacy Pharma Distributors', isActive: false };

const PRODUCT_FILLER = { id: 501, name: 'Derma Filler 1ml', sku: 'DF-1ML' };
const PRODUCT_NEEDLE = { id: 502, name: '30G Hypodermic Needles', sku: 'NDL-30G' };

function installFetchMock({
  receipts = [RECEIPT_DERMA, RECEIPT_NEEDLES],
  products = [PRODUCT_FILLER, PRODUCT_NEEDLE],
  vendors = [ACTIVE_VENDOR, INACTIVE_VENDOR],
  receiptsPromise = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/wellness/inventory/receipts') && method === 'GET') {
      if (receiptsPromise) return receiptsPromise;
      return Promise.resolve(receipts);
    }
    if (url === '/api/wellness/products' && method === 'GET') {
      return Promise.resolve(products);
    }
    if (url === '/api/wellness/vendors' && method === 'GET') {
      return Promise.resolve(vendors);
    }
    if (url === '/api/wellness/inventory/receipts' && method === 'POST') {
      return Promise.resolve({ id: 1199, receiptNumber: 'RCP-2026-00099' });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <InventoryReceipts />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
});

describe('<InventoryReceipts /> — page chrome', () => {
  it('renders heading "Inventory receipts" + "Record receipt" CTA + total-cost sub-copy', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Inventory receipts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Record receipt/i }),
    ).toBeInTheDocument();
    // Sub-copy: "N receipts in window — total cost ₹<sum>". Use getAllByText
    // textContent matcher since the <p> textContent is intermixed with the
    // toLocaleString result (₹46,500 once the rows resolve).
    await waitFor(() => {
      expect(
        screen.getAllByText((_t, el) =>
          /\d+ receipts? in window.*total cost ₹/i.test(el?.textContent || ''),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders "Loading…" while the initial receipts GET is in flight', async () => {
    // Block the receipts fetch indefinitely to pin the loading branch.
    installFetchMock({ receiptsPromise: new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<InventoryReceipts /> — mount fetch + list render', () => {
  it('fires three parallel GETs on mount and renders receipt rows', async () => {
    installFetchMock();
    renderPage();
    // Receipts URL embeds today's ISO date via the DateRangePicker's
    // 'today' default preset → ?from=YYYY-MM-DD&to=YYYY-MM-DD. Use a
    // regex match so the test doesn't pin against the local-clock date.
    await waitFor(() => {
      const receiptsCall = fetchApiMock.mock.calls.find(
        ([u]) =>
          typeof u === 'string' &&
          /^\/api\/wellness\/inventory\/receipts\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/.test(u),
      );
      expect(receiptsCall).toBeTruthy();
    });
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/products');
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/vendors');

    // Receipt rows render.
    expect(await screen.findByText('RCP-2026-00042')).toBeInTheDocument();
    expect(screen.getByText('RCP-2026-00043')).toBeInTheDocument();
    // Product names rendered in the Product column.
    expect(screen.getAllByText('Derma Filler 1ml').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('30G Hypodermic Needles').length).toBeGreaterThanOrEqual(1);
    // Vendor column — first row has vendor, second renders em-dash fallback.
    expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    // Quantities + currency-prefixed unit cost + total render verbatim.
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.getByText('₹4500')).toBeInTheDocument();
    expect(screen.getByText('₹45000')).toBeInTheDocument();
    expect(screen.getByText('₹7.5')).toBeInTheDocument();
    expect(screen.getByText('₹1500')).toBeInTheDocument();
  });

  it('renders "No receipts in window." when receipts GET resolves to []; flips to "No receipts match your search." when a search term has no hits', async () => {
    installFetchMock({ receipts: [] });
    renderPage();
    expect(
      await screen.findByText(/^No receipts in window\.$/),
    ).toBeInTheDocument();
    // Re-run with non-empty receipts but type a non-matching search term —
    // the SUT swaps the empty-state copy to the search-specific variant.
    // cleanup() unmounts the first render so getByPlaceholderText below
    // sees exactly one search input (otherwise both pages co-exist in the
    // DOM and the matcher throws "found multiple elements").
    cleanup();
    fetchApiMock.mockReset();
    installFetchMock(); // populated again
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('RCP-2026-00042').length).toBeGreaterThanOrEqual(1);
    });
    const searchBox = screen.getByPlaceholderText(
      /Search by invoice #, supplier, product, batch…/,
    );
    fireEvent.change(searchBox, { target: { value: 'nonexistent-term-xyz' } });
    expect(
      await screen.findByText(/^No receipts match your search\.$/),
    ).toBeInTheDocument();
  });

  it('filters inactive vendors out of the form dropdown (SUT line 81)', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('RCP-2026-00042')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Record receipt/i }));
    // The vendor <select> only renders ACTIVE vendors; the INACTIVE one
    // is filtered out before the .map render (SUT line 81).
    const options = Array.from(document.querySelectorAll('select option')).map(
      (o) => o.textContent,
    );
    expect(options).toContain('Sterile Supplies Pvt Ltd');
    expect(options).not.toContain('Legacy Pharma Distributors');
  });
});

describe('<InventoryReceipts /> — free-text search', () => {
  it('narrows visible receipt rows client-side (case-insensitive across receipt # / supplier / product / batch / notes)', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('RCP-2026-00042')).toBeInTheDocument();
    });
    expect(screen.getByText('RCP-2026-00043')).toBeInTheDocument();

    const searchBox = screen.getByPlaceholderText(
      /Search by invoice #, supplier, product, batch…/,
    );
    // Search for "needles" — should keep only the second row (matches
    // product name "30G Hypodermic Needles") and hide the first.
    fireEvent.change(searchBox, { target: { value: 'NEEDLES' } });
    await waitFor(() => {
      expect(screen.queryByText('RCP-2026-00042')).toBeNull();
    });
    expect(screen.getByText('RCP-2026-00043')).toBeInTheDocument();

    // Search by batch number — should keep only the first row.
    fireEvent.change(searchBox, { target: { value: 'B-2026-0517' } });
    await waitFor(() => {
      expect(screen.getByText('RCP-2026-00042')).toBeInTheDocument();
    });
    expect(screen.queryByText('RCP-2026-00043')).toBeNull();
  });
});

describe('<InventoryReceipts /> — form open/close + required fields', () => {
  it('"Record receipt" opens the form (label flips to "Cancel"); click again resets + re-shows "Record receipt"', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('RCP-2026-00042')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Record receipt/i }));
    // Form is visible — quantity placeholder is unique to the form.
    expect(screen.getByPlaceholderText(/^Quantity$/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/^Unit cost$/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/^Batch number$/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Cancel$/ }),
    ).toBeInTheDocument();
    // Click Cancel → form closes.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(screen.queryByPlaceholderText(/^Quantity$/)).toBeNull();
    expect(
      screen.getByRole('button', { name: /Record receipt/i }),
    ).toBeInTheDocument();
  });

  it('productId / quantity / unit-cost inputs carry the `required` attribute', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('RCP-2026-00042')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Record receipt/i }));
    // Product <select> — the only required select in the form.
    const productSelects = document.querySelectorAll('select[required]');
    expect(productSelects.length).toBe(1);
    expect(screen.getByPlaceholderText(/^Quantity$/)).toBeRequired();
    expect(screen.getByPlaceholderText(/^Unit cost$/)).toBeRequired();
    // Batch number / notes / expiry are NOT required.
    expect(screen.getByPlaceholderText(/^Batch number$/)).not.toBeRequired();
    expect(screen.getByPlaceholderText(/^Notes$/)).not.toBeRequired();
  });
});

describe('<InventoryReceipts /> — create POST', () => {
  it('Submit → POST /api/wellness/inventory/receipts with coerced body + notify.success + refetch', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('RCP-2026-00042')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Record receipt/i }));

    // Set productId via the <select> change event — pick the Derma Filler.
    const productSelect = document.querySelector('select[required]');
    fireEvent.change(productSelect, { target: { value: '501' } });

    // Set quantity + unit-cost + batch (numerics get parseFloat'd; batch stays string).
    fireEvent.change(screen.getByPlaceholderText(/^Quantity$/), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Unit cost$/), {
      target: { value: '4500.50' },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Batch number$/), {
      target: { value: 'B-NEW-001' },
    });

    fireEvent.click(
      screen.getByRole('button', { name: /Record receipt \+ update stock/i }),
    );

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/inventory/receipts' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      // SUT coerces productId via parseInt; vendorId via parseInt or null;
      // quantity + unitCost via parseFloat; blank batch/expiry/notes → null.
      expect(body).toMatchObject({
        productId: 501,
        vendorId: null, // form left vendor blank
        quantity: 5,
        unitCost: 4500.5,
        batchNumber: 'B-NEW-001',
        expiryDate: null,
        notes: null,
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Recorded.*RCP-2026-00099.*stock updated\./i),
    );
    // After create, list refetches → at least 2 receipts GETs total.
    const receiptsGets = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        typeof u === 'string' &&
        u.startsWith('/api/wellness/inventory/receipts') &&
        (opts?.method || 'GET') === 'GET',
    );
    expect(receiptsGets.length).toBeGreaterThanOrEqual(2);
  });
});
