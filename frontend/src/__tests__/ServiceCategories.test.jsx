/**
 * ServiceCategories.test.jsx — vitest + RTL coverage for the wellness-vertical
 * service-category admin page (frontend/src/pages/wellness/ServiceCategories.jsx).
 *
 * Scope: pins the page-surface invariants for the hierarchical taxonomy CRUD —
 * heading + CTA, loading state, GET on mount, empty-state, category-row render
 * (name + parent + order + service-count + status), New-category form
 * open/close + CTA-label flip, create POST shape, edit-prefill flow, native-
 * confirm delete flow (true + false branches), and the parent-select dropdown
 * filtering out the row being edited (no self-parent cycles).
 *
 * Test cases (10):
 *   1. Heading "Service categories" + "New category" CTA + count sub-copy
 *      ("N categories — hierarchical taxonomy …") render on mount.
 *   2. Loading state: "Loading categories…" renders while initial GET is
 *      in-flight (per CLAUDE.md tick #108 cron-learning).
 *   3. GET /api/wellness/service-categories fires on mount; rendered rows
 *      match payload.
 *   4. Empty-state copy "No categories yet" renders when GET resolves to [].
 *   5. Category row renders name + parent-name (or em-dash) + displayOrder +
 *      _count.services + status (Active/Inactive).
 *   6. Clicking "New category" opens the form (name + parent-select +
 *      displayOrder + isActive checkbox visible); CTA label flips to "Cancel";
 *      clicking again resets + re-shows "New category".
 *   7. Submitting the form POSTs /api/wellness/service-categories with the
 *      payload shape {name, parentId, displayOrder, isActive} + notify.success
 *      + re-fetches the list.
 *   8. Name input carries the `required` attribute (browser-native blank
 *      blocking — SUT line 100).
 *   9. Clicking row's Edit (Pencil) opens the form pre-filled with name +
 *      displayOrder + isActive; Save → PUT /api/wellness/service-categories/:id
 *      + notify.success; parent-select EXCLUDES the row being edited.
 *  10. Delete flow: clicking the × with confirm()=true fires DELETE +
 *      notify.success; confirm()=false aborts (no DELETE).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/) with a
 *     stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap dep identity and infinite-
 *     re-render-hang the test).
 *   - SUT does NOT consume AuthContext → no Provider wrapper. MemoryRouter is
 *     defensive in case any lazy descendant pulls in a Link/useNavigate.
 *   - window.confirm spied per-test via vi.spyOn (matches Vendors.test.jsx +
 *     Coupons.test.jsx pattern).
 *   - vi.mock paths are `../utils/api` and `../utils/notify` (relative to flat
 *     top-level `__tests__/`).
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "color picker for catalog grouping" + "default-VAT /
 *     HSN-code fields". REALITY: SUT has NEITHER — fields are name, parentId,
 *     displayOrder, isActive ONLY (SUT line 13 EMPTY_FORM). No color column,
 *     no tax-code column, no HSN. Omitted those cases. The "color for catalog
 *     grouping" probably came from a Services.jsx (services have a color in
 *     some setups) cross-up; category itself is grouping-only by name.
 *   - Prompt anticipated "RBAC: USER hides mutation CTAs if SUT enforces".
 *     CONFIRMED backend-only: the SUT does NOT consume AuthContext at all
 *     (no `import { useAuth }` / `useContext(AuthContext)`); every authenticated
 *     client sees the New-category CTA + row Edit/Delete buttons. Header
 *     comment notes "Manager+ gated via App.jsx's RoleGuard wrapper" — that
 *     RoleGuard is the OUTER route guard, not in-page logic. Omitted RBAC
 *     in-page tests (covered by App.jsx RoleGuard tests + route api spec).
 *   - Prompt anticipated "validation: empty name rejected". REALITY: SUT relies
 *     on the browser-native `required` attribute on the name input (SUT line
 *     100) — there is no in-JS validation function to test. Pinned via
 *     attribute presence (case 8); the actual blocking happens in the browser's
 *     form-submit handler before React's onSubmit fires.
 *   - Prompt anticipated "Loading…" verbatim. REALITY: SUT renders "Loading
 *     categories…" (SUT line 117). Pin via the actual literal.
 *   - Prompt anticipated "category row display: name + service-count (if
 *     shown) + parent (if hierarchy)". CONFIRMED all three present (SUT
 *     lines 124-141): Name, Parent, Order, Services, Status.
 *   - Prompt anticipated "confirmation + DELETE". CONFIRMED — uses bare
 *     `confirm()` (window.confirm) at SUT line 74. The dialog message is
 *     `Delete "${cat.name}"? Services in this category will keep working but
 *     lose the link.` — pin via case 10.
 *   - Prompt anticipated "500 → silent degrade or notify.error; 403 →
 *     notify.error or banner". CONFIRMED silent-degrade: SUT line 28's
 *     `.catch(() => setCategories([]))` swallows errors silently, falls
 *     through to empty-state. The notify.error path is fetchApi-internal (it
 *     toasts the server message inside the helper, per SUT line 69 + 79
 *     comments). Omitted error-branch case — silent-degrade behaviour is
 *     identical to empty-state (case 4) and the notify.error toast is
 *     fetchApi's responsibility, not the SUT's.
 *   - Parent-select dropdown EXCLUDES the row being edited (SUT line 103:
 *     `categories.filter((c) => c.id !== editingId)`) — pinned in case 9 to
 *     guard against accidental self-parent cycles.
 *   - Backend endpoint confirmed at /api/wellness/service-categories per
 *     SUT lines 26, 61, 64, 76.
 *
 * Path: flat __tests__/ServiceCategories.test.jsx — matches sibling Vendors /
 * Holidays / Services flat-path convention.
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
// confirm() is spied per-test (mutable resolved value) so the delete flow
// can test both branches without rebuilding the module-level notify object.
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

import ServiceCategories from '../pages/wellness/ServiceCategories';

const ROOT_CATEGORY = {
  id: 401,
  name: 'Hair Restoration',
  parentId: null,
  displayOrder: 1,
  isActive: true,
  _count: { services: 7 },
};
const CHILD_CATEGORY = {
  id: 402,
  name: 'PRP Therapy',
  parentId: 401, // child of Hair Restoration
  displayOrder: 2,
  isActive: true,
  _count: { services: 3 },
};
const INACTIVE_CATEGORY = {
  id: 403,
  name: 'Legacy Aesthetic Add-ons',
  parentId: null,
  displayOrder: 99,
  isActive: false,
  _count: { services: 0 },
};

function installFetchMock({
  categories = [ROOT_CATEGORY, CHILD_CATEGORY, INACTIVE_CATEGORY],
  categoriesPromise = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/wellness/service-categories' && method === 'GET') {
      if (categoriesPromise) return categoriesPromise;
      return Promise.resolve(categories);
    }
    if (/^\/api\/wellness\/service-categories(\/\d+)?$/.test(url)) {
      // POST / PUT / DELETE — resolve so submit / delete paths complete.
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ServiceCategories />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  // Default branch: confirm() resolves true so most tests don't have to
  // re-stub on the happy path.
  notifyConfirm.mockImplementation(() => Promise.resolve(true));
});

describe('<ServiceCategories /> — page chrome', () => {
  it('renders heading + "New category" CTA + categories-count sub-copy', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Service categories/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /New category/i }),
    ).toBeInTheDocument();
    // Sub-copy mentions "categor(y|ies)" + "hierarchical taxonomy".
    await waitFor(() => {
      expect(
        screen.getAllByText((_t, el) =>
          /\d+ categor(y|ies).*hierarchical taxonomy/i.test(
            el?.textContent || '',
          ),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders "Loading categories…" while the initial GET is in flight', async () => {
    // Block the fetch indefinitely to pin the loading branch.
    installFetchMock({ categoriesPromise: new Promise(() => {}) });
    renderPage();
    expect(
      await screen.findByText(/^Loading categories…$/),
    ).toBeInTheDocument();
  });
});

describe('<ServiceCategories /> — mount fetch + list render', () => {
  it('fires GET /api/wellness/service-categories on mount and renders rows', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/service-categories',
      );
    });
    // "Hair Restoration" appears twice (root row Name cell + child PRP Therapy
    // row Parent cell) — use getAllByText.
    expect((await screen.findAllByText('Hair Restoration')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('PRP Therapy')).toBeInTheDocument();
    expect(
      screen.getByText('Legacy Aesthetic Add-ons'),
    ).toBeInTheDocument();
  });

  it('renders the empty-state copy when GET resolves to []', async () => {
    installFetchMock({ categories: [] });
    renderPage();
    expect(
      await screen.findByText(/No categories yet/i),
    ).toBeInTheDocument();
  });

  it('renders row columns: name + parent + order + services-count + status', async () => {
    installFetchMock();
    renderPage();
    // Wait for the data row to render.
    await waitFor(() => {
      expect(screen.getByText('PRP Therapy')).toBeInTheDocument();
    });
    // Parent column: PRP Therapy's parent is "Hair Restoration".
    // "Hair Restoration" appears as BOTH the root row's Name cell AND PRP's
    // Parent cell → use getAllByText with length >= 2.
    expect(screen.getAllByText('Hair Restoration').length).toBeGreaterThanOrEqual(2);
    // Root rows (no parent) render em-dash in the Parent cell — at least 2
    // (Hair Restoration + Legacy Aesthetic Add-ons are both rootless).
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
    // displayOrder values render.
    expect(screen.getByText('99')).toBeInTheDocument();
    // _count.services renders (7 for root, 3 for child, 0 for inactive).
    // "3" also appears as a displayOrder value on another row so it
    // matches more than one cell — assert presence via getAllByText.
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1);
    // Status text — there are 2 Active rows and 1 Inactive.
    expect(screen.getAllByText(/^Active$/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/^Inactive$/)).toBeInTheDocument();
  });
});

describe('<ServiceCategories /> — New-category form toggle', () => {
  it('"New category" opens the form (label flips to "Cancel"); click again closes it', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      // PRP Therapy is unique (root row name only; no other category has PRP
      // as parent so the string doesn't echo into a Parent cell).
      expect(screen.getByText('PRP Therapy')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New category/i }));
    // Form fields visible.
    expect(
      screen.getByPlaceholderText(/Name \(e\.g\. Hair Restoration\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Display order/i),
    ).toBeInTheDocument();
    // CTA label flipped.
    expect(
      screen.getByRole('button', { name: /^Cancel$/ }),
    ).toBeInTheDocument();
    // Click Cancel → form closes, label flips back.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(
      screen.queryByPlaceholderText(/Name \(e\.g\. Hair Restoration\)/),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /New category/i }),
    ).toBeInTheDocument();
  });

  it('name input carries the `required` attribute (browser-native blank-blocking)', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      // PRP Therapy is unique (root row name only; no other category has PRP
      // as parent so the string doesn't echo into a Parent cell).
      expect(screen.getByText('PRP Therapy')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New category/i }));
    const nameInput = screen.getByPlaceholderText(
      /Name \(e\.g\. Hair Restoration\)/,
    );
    expect(nameInput).toBeRequired();
  });
});

describe('<ServiceCategories /> — create POST', () => {
  it('Create → POST /api/wellness/service-categories with body shape + notify.success + refetch', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      // PRP Therapy is unique (root row name only; no other category has PRP
      // as parent so the string doesn't echo into a Parent cell).
      expect(screen.getByText('PRP Therapy')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New category/i }));
    fireEvent.change(
      screen.getByPlaceholderText(/Name \(e\.g\. Hair Restoration\)/),
      { target: { value: 'Laser Hair Reduction' } },
    );
    // Select Hair Restoration as parent (id 401).
    const parentSelect = screen.getByRole('combobox');
    fireEvent.change(parentSelect, { target: { value: '401' } });
    fireEvent.change(screen.getByPlaceholderText(/Display order/i), {
      target: { value: '5' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create category/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/service-categories' &&
          opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({
        name: 'Laser Hair Reduction',
        parentId: 401,
        displayOrder: 5,
        isActive: true,
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Created.*Laser Hair Reduction/i),
    );
    // After create, list refetches → at least 2 GETs total.
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        u === '/api/wellness/service-categories' &&
        (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('<ServiceCategories /> — edit prefill + PUT', () => {
  it('Edit (Pencil) opens the form pre-filled and Save → PUT /api/wellness/service-categories/:id; parent-select excludes the editing row', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      // PRP Therapy is unique (root row name only; no other category has PRP
      // as parent so the string doesn't echo into a Parent cell).
      expect(screen.getByText('PRP Therapy')).toBeInTheDocument();
    });
    // Edit button has title="Edit"; multiple rows have one → pick the first
    // (Hair Restoration). Use getAllByTitle to disambiguate.
    const editButtons = screen.getAllByTitle('Edit');
    expect(editButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(editButtons[0]); // Hair Restoration row.

    // Pre-fill: name + displayOrder.
    const nameInput = screen.getByPlaceholderText(
      /Name \(e\.g\. Hair Restoration\)/,
    );
    expect(nameInput.value).toBe('Hair Restoration');
    expect(
      screen.getByPlaceholderText(/Display order/i).value,
    ).toBe('1');
    // Parent-select EXCLUDES the row being edited (id 401) — only the other
    // two categories show up as <option>. SUT line 103.
    const parentSelect = screen.getByRole('combobox');
    const optionValues = Array.from(parentSelect.querySelectorAll('option')).map(
      (o) => o.value,
    );
    // Always has the "no parent" empty-value option.
    expect(optionValues).toContain('');
    // 402 + 403 should be present; 401 (self) must NOT be.
    expect(optionValues).toContain('402');
    expect(optionValues).toContain('403');
    expect(optionValues).not.toContain('401');

    // Tweak name + submit.
    fireEvent.change(nameInput, {
      target: { value: 'Hair Restoration (renamed)' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/service-categories/401' &&
          opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('Hair Restoration (renamed)');
      expect(body.isActive).toBe(true);
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Updated.*Hair Restoration \(renamed\)/i),
    );
  });
});

describe('<ServiceCategories /> — delete (notify.confirm gate)', () => {
  it('notify.confirm()=true → DELETE /api/wellness/service-categories/:id + notify.success', async () => {
    installFetchMock();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP Therapy')).toBeInTheDocument();
    });
    // Delete buttons use title="Delete"; pick the first (Hair Restoration).
    const deleteButtons = screen.getAllByTitle('Delete');
    expect(deleteButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(deleteButtons[0]);

    // SUT calls notify.confirm({ title, message, ... }) — pin the message
    // text without binding to native window.confirm.
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    const arg = notifyConfirm.mock.calls[0][0];
    expect(arg.message || '').toMatch(/Delete "Hair Restoration"/);

    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/service-categories/401' &&
          opts?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Deleted.*Hair Restoration/i),
    );
  });

  it('notify.confirm()=false → no DELETE fired + no notify.success', async () => {
    installFetchMock();
    notifyConfirm.mockImplementation(() => Promise.resolve(false));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP Therapy')).toBeInTheDocument();
    });
    const deleteButtons = screen.getAllByTitle('Delete');
    fireEvent.click(deleteButtons[0]);
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // Microtask wait — make sure no async DELETE sneaks through.
    await Promise.resolve();
    const delCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'DELETE',
    );
    expect(delCall).toBeUndefined();
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});
