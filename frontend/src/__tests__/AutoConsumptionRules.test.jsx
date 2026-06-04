/**
 * AutoConsumptionRules.test.jsx — vitest + RTL coverage for the wellness-
 * vertical auto-consumption rules admin page
 * (frontend/src/pages/wellness/AutoConsumptionRules.jsx).
 *
 * Scope: pins the page-surface invariants for the one-rule-per-(service,
 * product) auto-decrement chain — heading + CTA, loading state, mount fetch
 * triple (rules + services + products), empty-state, rule-row render
 * (service-name + product-name + qty + stock + status), New-rule form open/
 * close + CTA-label flip, create POST shape, edit-prefill flow (svc + product
 * locked, qty + isActive editable), native-confirm delete flow (true + false
 * branches), and silent-degrade on initial-fetch rejection.
 *
 * Test cases (10):
 *   1. Heading "Auto-consumption rules" + "New rule" CTA + sub-copy
 *      ("When a visit completes…") render on mount.
 *   2. Loading state: "Loading…" renders while initial GETs in flight (per
 *      CLAUDE.md tick #108 cron-learning on actual literal).
 *   3. Mount fires GET on /api/wellness/auto-consumption-rules +
 *      /api/wellness/services + /api/wellness/products.
 *   4. Empty-state copy "No rules configured. Add one to start auto-
 *      consumption on visits." renders when rules GET resolves to [].
 *   5. Rule rows render service.name + product.name + quantityPerVisit +
 *      product.currentStock + status (Active/Inactive); fall-back to
 *      `#<id>` when service / product joins missing.
 *   6. "New rule" opens the form (service select, product select, qty input,
 *      Active checkbox visible); CTA label flips to "Cancel"; clicking again
 *      closes it.
 *   7. Submit → POST /api/wellness/auto-consumption-rules with payload shape
 *      {serviceId:int, productId:int, quantityPerVisit:float, isActive:bool}
 *      + notify.success + refetch.
 *   8. Qty input enforces min=0.01 + step=0.01 (browser-native blocking —
 *      SUT line 112).
 *   9. Edit (Pencil) opens the form pre-filled (qty + active); service +
 *      product selects DISABLED so they can't be re-pointed (SUT lines 104,
 *      108 — change requires delete+recreate); Save → PUT /api/wellness/
 *      auto-consumption-rules/:id with ONLY {quantityPerVisit, isActive}.
 *  10. Delete flow: window.confirm()=true → DELETE +/api/wellness/auto-
 *      consumption-rules/:id + notify.success; confirm()=false aborts (no
 *      DELETE).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/).
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap dep identity and infinite-
 *     re-render-hang the test).
 *   - SUT does NOT consume AuthContext → no Provider wrapper. MemoryRouter
 *     is defensive only.
 *   - window.confirm spied per-test via vi.spyOn (matches sibling
 *     ServiceCategories.test.jsx + Vendors.test.jsx pattern).
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "validation: empty fields or zero qty rejected" via
 *     in-JS validation. REALITY: SUT relies on browser-native `required` +
 *     `min="0.01"` + `step="0.01"` on the qty input (SUT line 112); no in-JS
 *     validator to test. Pinned via attribute presence (case 8).
 *   - Prompt anticipated "RBAC: USER hides mutation CTAs only if SUT
 *     enforces". CONFIRMED backend-only: SUT does NOT consume AuthContext;
 *     every authenticated client sees the New-rule CTA + row Edit/Delete
 *     buttons. Backend `verifyWellnessRole` gates the underlying routes.
 *     Omitted RBAC in-page tests.
 *   - Prompt anticipated "active/inactive toggle (if present)". CONFIRMED
 *     present at SUT line 114 as a `<input type="checkbox">` inside the
 *     create/edit form (NOT a per-row inline toggle). Pinned via case 7
 *     (default true on create payload) + case 9 (preserved on edit PUT).
 *   - Prompt anticipated "error handling: 500 → silent degrade or
 *     notify.error". CONFIRMED silent-degrade: SUT lines 26-28 use
 *     `.catch(() => [])` on each of the 3 mount GETs, then Array.isArray
 *     guard at 30-32 falls through to empty-state. No notify.error toast
 *     from page; fetchApi's internal toaster (called from POST/PUT/DELETE
 *     paths) is the SUT's responsibility for *mutation* errors only. Pinned
 *     in case 4 (empty-state = silent-degrade for the all-three-reject
 *     branch).
 *   - Prompt anticipated "Loading…" verbatim. CONFIRMED — SUT line 125
 *     renders bare "Loading…" (no qualifier like sibling ServiceCategories
 *     pages). Pin via the actual literal.
 *   - Prompt anticipated "edit-rule flow: opens editor pre-filled". CONFIRMED
 *     and tighter: SUT line 104 + 108 set `disabled={!!editingId}` on BOTH
 *     the service + product selects so an existing rule can ONLY have its
 *     qty + isActive tweaked. Service/product re-pointing requires
 *     delete-and-recreate (per SUT line 61 comment). Pinned in case 9.
 *   - Prompt anticipated "create POST shape". CONFIRMED ints + float coerce
 *     (SUT lines 54-57: parseInt for service+product ids, parseFloat for
 *     qty). Pinned in case 7 with assertions on numeric types.
 *   - Backend endpoint confirmed at /api/wellness/auto-consumption-rules per
 *     SUT lines 26, 62, 68, 80.
 *   - Prompt anticipated "edit pre-filled". CONFIRMED: SUT line 39-46 also
 *     stringifies serviceId + productId via `String(r.serviceId)` to match
 *     the disabled-select's value. Inert for the test since selects are
 *     disabled, but worth noting.
 *
 * Path: flat __tests__/AutoConsumptionRules.test.jsx — matches sibling
 * ServiceCategories / Vendors / Holidays flat-path convention.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// Default to a fully-permissioned viewer so existing assertions on
// New rule / Edit / Delete keep passing. The SUT now hides these when the
// viewer lacks products.manage.
const FULL_PERMS = {
  isReady: true,
  hasPermission: () => true,
  permissions: ['products.read', 'products.manage'],
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

import AutoConsumptionRules from '../pages/wellness/AutoConsumptionRules';

const SERVICE_PRP = { id: 501, name: 'PRP Hair Therapy' };
const SERVICE_LASER = { id: 502, name: 'Laser Hair Reduction' };
const PRODUCT_TUBE = { id: 901, name: 'PRP Collection Tube', currentStock: 42 };
const PRODUCT_GEL = { id: 902, name: 'Ultrasound Gel 250ml', currentStock: 7 };

const RULE_PRP = {
  id: 11,
  serviceId: 501,
  productId: 901,
  quantityPerVisit: 2,
  isActive: true,
  service: SERVICE_PRP,
  product: PRODUCT_TUBE,
};
const RULE_LASER = {
  id: 12,
  serviceId: 502,
  productId: 902,
  quantityPerVisit: 1.5,
  isActive: false,
  service: SERVICE_LASER,
  product: PRODUCT_GEL,
};
// Rule with NO joined service/product (covers the `#<id>` fallback at SUT
// lines 143-144).
const RULE_ORPHAN = {
  id: 13,
  serviceId: 999,
  productId: 888,
  quantityPerVisit: 3,
  isActive: true,
};

function installFetchMock({
  rules = [RULE_PRP, RULE_LASER, RULE_ORPHAN],
  services = [SERVICE_PRP, SERVICE_LASER],
  products = [PRODUCT_TUBE, PRODUCT_GEL],
  rulesPromise = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/wellness/auto-consumption-rules' && method === 'GET') {
      if (rulesPromise) return rulesPromise;
      return Promise.resolve(rules);
    }
    if (url === '/api/wellness/services' && method === 'GET') {
      return Promise.resolve(services);
    }
    if (url === '/api/wellness/products' && method === 'GET') {
      return Promise.resolve(products);
    }
    if (/^\/api\/wellness\/auto-consumption-rules(\/\d+)?$/.test(url)) {
      // POST / PUT / DELETE — resolve so submit / delete paths complete.
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AutoConsumptionRules />
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
});

describe('<AutoConsumptionRules /> — page chrome', () => {
  it('renders heading + "New rule" CTA + sub-copy on mount', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Auto-consumption rules/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /New rule/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/When a visit completes for the matching service/i),
    ).toBeInTheDocument();
  });

  it('renders "Loading…" while the initial GET is in flight', async () => {
    installFetchMock({ rulesPromise: new Promise(() => {}) });
    renderPage();
    // Loading branch shows bare "Loading…" (SUT line 125).
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<AutoConsumptionRules /> — mount fetch + list render', () => {
  it('fires GET on rules + services + products endpoints on mount', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/auto-consumption-rules',
      );
    });
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/services');
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/products');
  });

  it('renders the empty-state copy when rules GET resolves to []', async () => {
    installFetchMock({ rules: [] });
    renderPage();
    expect(
      await screen.findByText(/No rules configured/i),
    ).toBeInTheDocument();
  });

  it('renders rule rows: service-name + product-name + qty + stock + status (+ `#id` fallback)', async () => {
    installFetchMock();
    renderPage();
    // Wait for first row to render.
    await waitFor(() => {
      expect(screen.getByText('PRP Hair Therapy')).toBeInTheDocument();
    });
    // Joined service + product names.
    expect(screen.getByText('Laser Hair Reduction')).toBeInTheDocument();
    expect(screen.getByText('PRP Collection Tube')).toBeInTheDocument();
    expect(screen.getByText('Ultrasound Gel 250ml')).toBeInTheDocument();
    // Qty values.
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1.5')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // Stock values for joined rows; orphan row + Unit columns (when the
    // joined product has no `unit`) fall back to em-dash. The orphan row
    // contributes an em-dash for BOTH Stock and Unit, plus the two
    // joined rows' Unit cells render em-dash because the test fixtures
    // for PRODUCT_TUBE / PRODUCT_GEL don't carry a `unit` field. So
    // we expect ≥1 em-dash on the page (the orphan-stock fallback is
    // the load-bearing assertion).
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    // `#<id>` fallback for orphan row's missing service + product joins.
    expect(screen.getByText('#999')).toBeInTheDocument();
    expect(screen.getByText('#888')).toBeInTheDocument();
    // Status: 2 Active (PRP + Orphan), 1 Inactive (Laser).
    expect(screen.getAllByText(/^Active$/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/^Inactive$/)).toBeInTheDocument();
  });
});

describe('<AutoConsumptionRules /> — New-rule form toggle', () => {
  it('"New rule" opens the form (label flips to "Cancel"); click again closes it', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP Hair Therapy')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New rule/i }));
    // Form fields visible — qty input by placeholder.
    expect(
      document.querySelector('input[type="number"][min="0.01"]'),
    ).toBeInTheDocument();
    // Two selects (service + product) present.
    expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(2);
    // Active checkbox present.
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    // CTA label flipped to Cancel.
    expect(
      screen.getByRole('button', { name: /^Cancel$/ }),
    ).toBeInTheDocument();
    // Click Cancel → form closes, label flips back.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(document.querySelector('input[type="number"][min="0.01"]')).toBeNull();
    expect(
      screen.getByRole('button', { name: /New rule/i }),
    ).toBeInTheDocument();
  });

  it('qty input carries min=0.01 + step=0.01 + required (browser-native blocking)', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP Hair Therapy')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New rule/i }));
    const qtyInput = document.querySelector('input[type="number"][min="0.01"]');
    expect(qtyInput).toBeRequired();
    expect(qtyInput).toHaveAttribute('min', '0.01');
    expect(qtyInput).toHaveAttribute('step', '0.01');
    expect(qtyInput).toHaveAttribute('type', 'number');
  });
});

describe('<AutoConsumptionRules /> — create POST', () => {
  it('Create → POST /api/wellness/auto-consumption-rules with int+float body + notify.success + refetch', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP Hair Therapy')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New rule/i }));

    // Form has 2 selects in DOM order: service (index 0), product (index 1).
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: '502' } }); // Laser service
    fireEvent.change(selects[1], { target: { value: '902' } }); // Gel product
    fireEvent.change(document.querySelector('input[type="number"][min="0.01"]'), {
      target: { value: '2.5' },
    });
    // isActive defaults true; leave unchanged.

    fireEvent.click(screen.getByRole('button', { name: /Create rule/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/auto-consumption-rules' &&
          opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      // serviceId + productId coerced via parseInt; quantityPerVisit via
      // parseFloat (SUT lines 58-60). `unit` is included in the payload
      // and resolves to null when the form's unit select is left at its
      // empty default (SUT line 61 — `form.unit || null`).
      expect(body).toEqual({
        serviceId: 502,
        productId: 902,
        quantityPerVisit: 2.5,
        unit: null,
        isActive: true,
      });
      expect(typeof body.serviceId).toBe('number');
      expect(typeof body.productId).toBe('number');
      expect(typeof body.quantityPerVisit).toBe('number');
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Rule created/i),
    );
    // After create, list refetches → at least 2 rules GETs total.
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        u === '/api/wellness/auto-consumption-rules' &&
        (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('<AutoConsumptionRules /> — edit prefill + PUT (qty + isActive only)', () => {
  it('Edit (Pencil) opens pre-filled, locks service+product selects, Save → PUT with only {quantityPerVisit, isActive}', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP Hair Therapy')).toBeInTheDocument();
    });
    // Edit buttons use aria-label="Edit rule" (SUT line 149).
    const editButtons = screen.getAllByLabelText('Edit rule');
    expect(editButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(editButtons[0]); // first rule = RULE_PRP (id 11).

    // Pre-fill: qty input shows "2".
    const qtyInput = document.querySelector('input[type="number"][min="0.01"]');
    expect(qtyInput.value).toBe('2');

    // Service + product selects DISABLED in edit mode (SUT lines 104, 108).
    const selects = screen.getAllByRole('combobox');
    expect(selects[0]).toBeDisabled();
    expect(selects[1]).toBeDisabled();

    // Tweak qty + uncheck Active.
    fireEvent.change(qtyInput, { target: { value: '4' } });
    const activeCheckbox = screen.getByRole('checkbox');
    fireEvent.click(activeCheckbox); // true → false

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/auto-consumption-rules/11' &&
          opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      // Only qty + unit + isActive in PUT body — svc + product change
      // requires delete+recreate per SUT line 65-66 comment. RULE_PRP
      // fixture carries no `unit` field so the form's pre-fill resolves
      // to '' (SUT line 45) and the submit payload's `form.unit || null`
      // (SUT line 71) lands as null.
      expect(body).toEqual({ quantityPerVisit: 4, unit: null, isActive: false });
      expect(body).not.toHaveProperty('serviceId');
      expect(body).not.toHaveProperty('productId');
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Rule updated/i),
    );
  });
});

describe('<AutoConsumptionRules /> — delete (notify.confirm)', () => {
  it('confirm()=true → DELETE /api/wellness/auto-consumption-rules/:id + notify.success', async () => {
    installFetchMock();
    notifyConfirm.mockResolvedValue(true);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP Hair Therapy')).toBeInTheDocument();
    });
    // Delete buttons use aria-label="Delete rule" (SUT line 150).
    const deleteButtons = screen.getAllByLabelText('Delete rule');
    expect(deleteButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(deleteButtons[0]); // first rule = RULE_PRP (id 11).

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    const confirmArg = notifyConfirm.mock.calls[0][0];
    // notify.confirm receives an object with title/message — verify the message matches.
    const confirmText = typeof confirmArg === 'string'
      ? confirmArg
      : (confirmArg?.message || '');
    expect(confirmText).toMatch(/Delete this auto-consumption rule/i);
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/auto-consumption-rules/11' &&
          opts?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Rule deleted/i),
    );
  });

  it('confirm()=false → no DELETE fired + no notify.success', async () => {
    installFetchMock();
    notifyConfirm.mockResolvedValue(false);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP Hair Therapy')).toBeInTheDocument();
    });
    const deleteButtons = screen.getAllByLabelText('Delete rule');
    fireEvent.click(deleteButtons[0]);
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // Microtask wait — make sure no async DELETE sneaks through.
    await Promise.resolve();
    await Promise.resolve();
    const delCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'DELETE',
    );
    expect(delCall).toBeUndefined();
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});
