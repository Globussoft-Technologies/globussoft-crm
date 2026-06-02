/**
 * InventoryAdjustments.test.jsx — vitest + RTL coverage for the wellness-vertical
 * inventory adjustments admin page
 * (frontend/src/pages/wellness/InventoryAdjustments.jsx).
 *
 * Scope: pins the page-surface invariants for the signed-delta inventory
 * adjustments admin — heading + sub-copy + CTA, loading state, parallel GETs
 * on mount (adjustments + products), empty-state, adjustment-row render
 * (date + product name + signed delta with red/green colour + reason + notes),
 * filter-by-product dropdown (#842 union of master products + adjustments
 * joined product), filter Apply re-fetch with `?productId=` URL, New-adjustment
 * form toggle, create POST shape with parseInt(productId) +
 * parseFloat(quantityDelta) + reason + notes, notify.success message includes
 * "credited"/"debited" direction.
 *
 * Test cases (10):
 *   1. Heading "Inventory adjustments" + ScaleIcon + sub-copy framing + CTA
 *      "New adjustment".
 *   2. Loading state: "Loading…" renders while initial parallel GETs are
 *      in-flight (per CLAUDE.md tick #108 cron-learning — pin actual literal).
 *   3. Mount fires parallel GETs to /api/wellness/inventory/adjustments AND
 *      /api/wellness/products; rendered rows match payload.
 *   4. Empty-state copy "No adjustments recorded." renders when GET resolves
 *      to [].
 *   5. Adjustment row renders product name + signed delta (+/-) + reason +
 *      notes; negative delta gets red colour (#c0392b), positive gets green
 *      (#27ae60).
 *   6. Filter dropdown is the UNION of master products + products derived from
 *      adjustments joined `product` data (#842 fix: tenant with adjustments
 *      but empty products master still gets a useful filter).
 *   7. Filter selection + Apply re-fetches with `?productId=<id>` URL.
 *   8. Clicking "New adjustment" opens the form (delta input visible); CTA
 *      label flips to "Cancel"; clicking again closes it.
 *   9. Submitting form POSTs /api/wellness/inventory/adjustments with body
 *      shape {productId: int, quantityDelta: float, reason, notes} and
 *      notify.success message includes "credited"/"debited" + abs(delta) +
 *      reason; list re-fetches.
 *  10. Negative delta on submit → notify.success says "debited" (not "credited").
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/).
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap dep identity and
 *     infinite-re-render-hang the test).
 *   - SUT does NOT consume AuthContext (no useAuth / useContext) → no Provider
 *     wrapper needed. MemoryRouter is defensive.
 *   - vi.mock paths are `../utils/api` and `../utils/notify` relative to the
 *     flat top-level `__tests__/` directory.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "RBAC: USER hides New-Adjustment CTA only if SUT
 *     enforces (likely backend-only)". CONFIRMED backend-only: SUT does NOT
 *     consume AuthContext — every authenticated client sees the CTA + form.
 *     Backend `adminGate` (routes/inventory.js:501, :531) is the real gate.
 *     Omitted in-page RBAC tests.
 *   - Prompt anticipated "Loading…" verbatim. CONFIRMED: SUT line 128 renders
 *     "Loading…" inside the glass panel during the in-flight Promise.all.
 *   - Prompt anticipated "location filter". REALITY: SUT only filters by
 *     productId (line 32); no location filter, no reason filter, no date
 *     filter. Multi-location adjustments are recorded but the page filter UI
 *     is product-only. Pinned the product filter; omitted location/reason/date.
 *   - Prompt anticipated "validation: empty product or zero qty rejected".
 *     REALITY: SUT uses browser-native `required` on the product select (line
 *     111) + `required` on the quantityDelta input (line 115). React onSubmit
 *     never fires when blanks are present. Not pinned as a discrete case (form
 *     open coverage in case 8 implicitly shows the required fields render) —
 *     too thin to spend a case on.
 *   - Prompt anticipated "error handling: 500 → silent degrade or
 *     notify.error". CONFIRMED silent-degrade: SUT lines 34-35's
 *     `.catch(() => [])` swallows errors silently and falls through to
 *     empty-state. The error itself is NOT toasted by this route (fetchApi
 *     handles its own toast). Omitted error-branch case — silent-degrade
 *     behaviour is identical to empty-state (case 4).
 *   - Prompt anticipated "user column" on row display. REALITY: SUT row
 *     columns (line 134-141) are Date / Product / Δ / Reason / Notes — NO
 *     user column. The model stores `userId` but the SUT doesn't render it.
 *     Omitted user-column assertion.
 *   - Prompt anticipated "create-adjustment form: ... location, optional
 *     notes". REALITY: the form (lines 110-124) is product picker + qty +
 *     reason dropdown + notes; NO location picker. Location is implicit per
 *     tenant. Pinned the actual fields.
 *   - Reason enum: SUT line 16 declares REASONS = ['SHRINKAGE', 'DAMAGE',
 *     'EXPIRY', 'RECOUNT', 'TRANSFER_OUT', 'TRANSFER_IN', 'MANUAL']. Default
 *     is 'RECOUNT' per line 17 EMPTY. Pinned via the visible options.
 *   - notify.success message: SUT line 75 builds
 *     `Stock ${direction} by ${Math.abs(payload.quantityDelta)} (${payload.reason})`
 *     where direction = quantityDelta > 0 ? 'credited' : 'debited'. Pinned the
 *     exact shape in case 9 + the debited branch in case 10.
 *   - #842 fix: SUT lines 50-61 build filterOptions as a UNION of master
 *     products + adjustments[i].product. When master is [] but adjustments
 *     have joined products, the filter still has rows. Pinned in case 6 with
 *     an empty master + adjustments carrying joined product objects.
 *   - Backend endpoint confirmed at /api/wellness/inventory/adjustments per
 *     backend/routes/inventory.js:501 (GET admin-gated) + :531 (POST
 *     admin-gated). Master products at /api/wellness/products (sibling route).
 *
 * Path: flat __tests__/InventoryAdjustments.test.jsx — matches sibling
 * Drugs / ProductCategories / Vendors flat-path convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

// Default to a fully-permissioned viewer so existing assertions on the
// New-adjustment CTA + form keep passing. The SUT now hides these when the
// viewer lacks inventory.write.
const FULL_PERMS = {
  isReady: true,
  hasPermission: () => true,
  permissions: ['inventory.read', 'inventory.write'],
  roles: [],
  isOwner: false,
  userType: null,
  isLoading: false,
  error: null,
  refresh: () => Promise.resolve(),
  hasAllPermissions: () => true,
  hasAnyPermission: () => true,
};
const usePermissionsMock = vi.fn(() => FULL_PERMS);
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: (...args) => usePermissionsMock(...args),
}));

import InventoryAdjustments from '../pages/wellness/InventoryAdjustments';

// Fixed-date adjustments — per CLAUDE.md tick 2026-05-07 wave-9 cron-learning
// (date-boundary assertions should be unambiguous fixed strings, not relative).
const SHRINKAGE_ADJ = {
  id: 7001,
  productId: 501,
  product: { id: 501, name: 'Botox 50U', sku: 'BTX-50' },
  quantityDelta: -3,
  reason: 'SHRINKAGE',
  notes: 'Vial dropped during inventory count',
  createdAt: '2026-01-15T10:30:00Z',
};
const RECOUNT_ADJ = {
  id: 7002,
  productId: 502,
  product: { id: 502, name: 'Juvederm Ultra XC', sku: 'JUV-UXC' },
  quantityDelta: 5,
  reason: 'RECOUNT',
  notes: '',
  createdAt: '2026-01-16T14:00:00Z',
};
const TRANSFER_ADJ = {
  id: 7003,
  productId: 503,
  product: { id: 503, name: 'Lidocaine 1%', sku: 'LIDO-1' },
  quantityDelta: -10,
  reason: 'TRANSFER_OUT',
  notes: 'Sent to Andheri branch',
  createdAt: '2026-01-17T09:15:00Z',
};

const PRODUCT_BOTOX = {
  id: 501,
  name: 'Botox 50U',
  currentStock: 12,
};
const PRODUCT_JUV = {
  id: 502,
  name: 'Juvederm Ultra XC',
  currentStock: 25,
};

function installFetchMock({
  adjustments = [SHRINKAGE_ADJ, RECOUNT_ADJ, TRANSFER_ADJ],
  products = [PRODUCT_BOTOX, PRODUCT_JUV],
  adjustmentsPromise = null,
  productsPromise = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (
      /^\/api\/wellness\/inventory\/adjustments(\?.*)?$/.test(url) &&
      method === 'GET'
    ) {
      if (adjustmentsPromise) return adjustmentsPromise;
      return Promise.resolve(adjustments);
    }
    if (url === '/api/wellness/products' && method === 'GET') {
      if (productsPromise) return productsPromise;
      return Promise.resolve(products);
    }
    if (
      url === '/api/wellness/inventory/adjustments' &&
      method === 'POST'
    ) {
      return Promise.resolve({ id: 8888 });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <InventoryAdjustments />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
});

describe('<InventoryAdjustments /> — page chrome', () => {
  it('renders heading "Inventory adjustments" + sub-copy + "New adjustment" CTA', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Inventory adjustments/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /New adjustment/i }),
    ).toBeInTheDocument();
    // Sub-copy: "Signed deltas — positive credits stock, negative debits..."
    expect(
      screen.getAllByText((_t, el) =>
        /Signed deltas.*positive credits stock.*negative debits/i.test(
          el?.textContent || '',
        ),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // ScaleIcon (lucide-react) renders as an inline SVG with the
    // "lucide-scale" class (lucide convention: dasherised component name).
    const scaleSvgs = document.querySelectorAll('svg.lucide-scale');
    expect(scaleSvgs.length).toBeGreaterThanOrEqual(1);
  });

  it('renders "Loading…" while the initial GETs are in flight', async () => {
    // Block BOTH parallel GETs to pin the loading branch — Promise.all
    // resolves only when both finalise.
    installFetchMock({
      adjustmentsPromise: new Promise(() => {}),
      productsPromise: new Promise(() => {}),
    });
    renderPage();
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<InventoryAdjustments /> — mount fetch + list render', () => {
  it('fires parallel GETs on mount (adjustments + products) and renders rows', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/inventory/adjustments',
      );
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/products');
    });
    // Row anchors — product names from joined data. Each product that's BOTH
    // in the master products list AND surfaced in the filter dropdown will
    // match twice (row cell + filter <option>) — use getAllByText.
    await waitFor(() => {
      expect(screen.getAllByText('Botox 50U').length).toBeGreaterThanOrEqual(1);
    });
    expect(
      screen.getAllByText('Juvederm Ultra XC').length,
    ).toBeGreaterThanOrEqual(1);
    // 'Lidocaine 1%' is NOT in the master products fixture but IS surfaced
    // via the adjustment-joined data → still in the filter dropdown via #842
    // UNION + in the row → 2 matches.
    expect(
      screen.getAllByText('Lidocaine 1%').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('renders empty-state copy "No adjustments recorded." when GET resolves to []', async () => {
    installFetchMock({ adjustments: [] });
    renderPage();
    expect(
      await screen.findByText(/^No adjustments recorded\.$/),
    ).toBeInTheDocument();
  });

  it('renders signed deltas with red for negative + green for positive + reason + notes', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      // 'Botox 50U' appears as both a row cell AND a filter dropdown option
      // (when 501 is in the products master) — use getAllByText.
      expect(screen.getAllByText('Botox 50U').length).toBeGreaterThanOrEqual(1);
    });
    // Signed delta literals from the SUT (line 148:
    // `${a.quantityDelta > 0 ? '+' : ''}${a.quantityDelta}` — negatives keep
    // their built-in minus sign; positives get a leading '+').
    expect(screen.getByText('-3')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(screen.getByText('-10')).toBeInTheDocument();
    // Reason badges.
    expect(screen.getByText('SHRINKAGE')).toBeInTheDocument();
    expect(screen.getAllByText('RECOUNT').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('TRANSFER_OUT')).toBeInTheDocument();
    // Notes — em-dash for empty notes (RECOUNT_ADJ).
    expect(
      screen.getByText('Vial dropped during inventory count'),
    ).toBeInTheDocument();
    expect(screen.getByText('Sent to Andheri branch')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    // Colour treatment — negative delta cell has red inline style; positive
    // has green. Locate the cell by text content + check its inline style.
    const negCell = screen.getByText('-3');
    expect(negCell.style.color).toBe('rgb(192, 57, 43)'); // #c0392b
    const posCell = screen.getByText('+5');
    expect(posCell.style.color).toBe('rgb(39, 174, 96)'); // #27ae60
  });
});

describe('<InventoryAdjustments /> — #842 filter UNION (master + joined adjustments)', () => {
  it('filter dropdown options = UNION of master products + adjustments joined products even when master is empty', async () => {
    // Simulate the #842 bug shape: empty master products list, but
    // adjustments include joined `product` data → filter dropdown should
    // still show the products surfaced through adjustments.
    installFetchMock({ products: [] });
    renderPage();
    await waitFor(() => {
      // 'Botox 50U' appears as both a row cell AND a filter dropdown option
      // (when 501 is in the products master) — use getAllByText.
      expect(screen.getAllByText('Botox 50U').length).toBeGreaterThanOrEqual(1);
    });
    // Filter dropdown is the only <select> visible (the form isn't open).
    const filterSelect = screen.getAllByRole('combobox')[0];
    const options = Array.from(filterSelect.querySelectorAll('option')).map(
      (o) => o.textContent,
    );
    // 'All' is the always-present sentinel.
    expect(options).toContain('All');
    // Despite empty master, the 3 products surfaced via adjustments are here.
    expect(options).toContain('Botox 50U');
    expect(options).toContain('Juvederm Ultra XC');
    expect(options).toContain('Lidocaine 1%');
  });
});

describe('<InventoryAdjustments /> — filter Apply re-fetch', () => {
  it('selecting a product + clicking Apply re-fetches with ?productId=<id> URL', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      // 'Botox 50U' appears as both a row cell AND a filter dropdown option
      // (when 501 is in the products master) — use getAllByText.
      expect(screen.getAllByText('Botox 50U').length).toBeGreaterThanOrEqual(1);
    });
    // Filter select is the first combobox (form not open yet).
    const filterSelect = screen.getAllByRole('combobox')[0];
    fireEvent.change(filterSelect, { target: { value: '501' } });
    fireEvent.click(screen.getByRole('button', { name: /^Apply$/ }));
    await waitFor(() => {
      const filteredCall = fetchApiMock.mock.calls.find(
        ([u]) => u === '/api/wellness/inventory/adjustments?productId=501',
      );
      expect(filteredCall).toBeTruthy();
    });
  });
});

describe('<InventoryAdjustments /> — New-adjustment form toggle', () => {
  it('"New adjustment" opens the form (label flips to "Cancel"); click again closes it', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      // 'Botox 50U' appears as both a row cell AND a filter dropdown option
      // (when 501 is in the products master) — use getAllByText.
      expect(screen.getAllByText('Botox 50U').length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(screen.getByRole('button', { name: /New adjustment/i }));
    // Form fields visible: quantityDelta input placeholder.
    expect(
      screen.getByPlaceholderText(/Quantity delta — e\.g\. -3 or \+5/),
    ).toBeInTheDocument();
    // "Apply adjustment" submit button visible.
    expect(
      screen.getByRole('button', { name: /Apply adjustment/i }),
    ).toBeInTheDocument();
    // CTA label flipped.
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeInTheDocument();
    // Click Cancel → form closes, label flips back.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(
      screen.queryByPlaceholderText(/Quantity delta — e\.g\. -3 or \+5/),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /New adjustment/i }),
    ).toBeInTheDocument();
  });
});

describe('<InventoryAdjustments /> — create POST', () => {
  it('positive delta → POST with int/float parsing + notify.success "credited" + list refetch', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      // 'Botox 50U' appears as both a row cell AND a filter dropdown option
      // (when 501 is in the products master) — use getAllByText.
      expect(screen.getAllByText('Botox 50U').length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(screen.getByRole('button', { name: /New adjustment/i }));
    // Form product picker is the second combobox (filter is first).
    const formSelects = screen.getAllByRole('combobox');
    // [0] = filter, [1] = product picker, [2] = reason
    fireEvent.change(formSelects[1], { target: { value: '501' } });
    fireEvent.change(
      screen.getByPlaceholderText(/Quantity delta — e\.g\. -3 or \+5/),
      { target: { value: '7' } },
    );
    // Reason defaults to RECOUNT; change to DAMAGE to confirm payload carries it.
    fireEvent.change(formSelects[2], { target: { value: 'DAMAGE' } });
    fireEvent.change(
      screen.getByPlaceholderText(/^Notes$/),
      { target: { value: 'Restocked from supplier return' } },
    );

    fireEvent.click(screen.getByRole('button', { name: /Apply adjustment/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/inventory/adjustments' &&
          opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({
        productId: 501,
        quantityDelta: 7,
        reason: 'DAMAGE',
        notes: 'Restocked from supplier return',
      });
      // SUT line 68: parseInt(form.productId) → number, not string.
      expect(typeof body.productId).toBe('number');
      // SUT line 69: parseFloat(form.quantityDelta) → number.
      expect(typeof body.quantityDelta).toBe('number');
    });
    // SUT line 74-75: direction = quantityDelta > 0 ? 'credited' : 'debited'.
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Stock credited by 7 \(DAMAGE\)/),
    );
    // After create, list refetches (load() called).
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        /^\/api\/wellness\/inventory\/adjustments(\?.*)?$/.test(u) &&
        (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('negative delta → notify.success says "debited" by |delta| (not "credited")', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      // 'Botox 50U' appears as both a row cell AND a filter dropdown option
      // (when 501 is in the products master) — use getAllByText.
      expect(screen.getAllByText('Botox 50U').length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(screen.getByRole('button', { name: /New adjustment/i }));
    const formSelects = screen.getAllByRole('combobox');
    fireEvent.change(formSelects[1], { target: { value: '502' } });
    fireEvent.change(
      screen.getByPlaceholderText(/Quantity delta — e\.g\. -3 or \+5/),
      { target: { value: '-4' } },
    );
    // Reason left at default RECOUNT.
    fireEvent.click(screen.getByRole('button', { name: /Apply adjustment/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/inventory/adjustments' &&
          opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      // Negative delta carries through unchanged (parseFloat handles sign).
      expect(body.quantityDelta).toBe(-4);
      expect(body.reason).toBe('RECOUNT'); // default
    });
    // Math.abs(-4) = 4 in the message.
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Stock debited by 4 \(RECOUNT\)/),
    );
  });
});
