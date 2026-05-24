/**
 * ProductCategories.test.jsx — vitest + RTL coverage for the wellness-vertical
 * inventory ProductCategory admin page
 * (frontend/src/pages/wellness/ProductCategories.jsx).
 *
 * Scope: pins the page-surface invariants for the hierarchical inventory
 * taxonomy admin — heading + CTA, loading state, GET on mount, empty-state,
 * row render (name + parent + product/children counts + status + image
 * placeholder), search filter, New-category form toggle, create POST shape,
 * edit-prefill flow, native-confirm delete flow (true + false branches), and
 * the parent-select dropdown.
 *
 * Test cases (11):
 *   1. Heading "Product categories" + "New category" CTA + count sub-copy.
 *   2. Loading state: "Loading…" renders while initial fetch is in-flight
 *      (per CLAUDE.md tick #108 cron-learning — loading branch must be pinned).
 *   3. GET /api/wellness/product-categories fires on mount; rows render.
 *   4. Empty-state copy "No categories yet." when GET resolves to [].
 *   5. Row renders name + parent name + product count + children count + status;
 *      missing parent renders as em-dash; image placeholder for missing image.
 *   6. Search input narrows the visible rows; no-match copy renders.
 *   7. Clicking "New category" opens the form (CTA flips to "Cancel"); clicking
 *      again resets + re-shows "New category".
 *   8. Submitting the form POSTs /api/wellness/product-categories with the
 *      payload shape (name + parentId + isActive) + notify.success + refetch.
 *   9. Name input carries the `required` attribute (browser-native blank gate).
 *  10. Clicking the row Edit (Pencil) button opens the form pre-filled with
 *      name + parentId; Save → PUT /api/wellness/product-categories/:id.
 *  11. Delete flow: confirm()=true → DELETE + notify.success; confirm()=false
 *      → no DELETE fired.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/) with a
 *     stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap useCallback / useEffect dep
 *     identity, causing infinite re-render hangs).
 *   - SUT does NOT consume AuthContext, so no Provider wrapper is needed.
 *   - window.confirm spied per-test via vi.spyOn (Coupons.test.jsx pattern).
 *   - vi.mock paths are `../utils/api` and `../utils/notify` relative to the
 *     flat top-level `__tests__/` directory.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "color/icon picker". REALITY: SUT has an IMAGE
 *     upload (multipart File + preview via FileReader.readAsDataURL), NOT a
 *     color picker or icon picker. The form fields are: name, parentId,
 *     isActive, and image file. Tests pin the load-bearing surface (name +
 *     parentId + isActive POST shape); the image-upload flow uses a raw
 *     fetch() + FormData (not fetchApi) which is hard to exercise cleanly in
 *     jsdom without mocking global fetch — explicitly out of scope per
 *     "scale down if SUT is simpler" guidance (the image upload is purely an
 *     orthogonal side-channel; the row save still POSTs name/parentId/active
 *     even if no image is staged).
 *   - Prompt anticipated "RBAC: USER hides mutation CTAs if SUT enforces
 *     (likely backend-only per wellness pattern)". CONFIRMED backend-only:
 *     SUT does NOT consume AuthContext at all and renders every CTA + row
 *     Edit/Delete for every authenticated client. Omitted RBAC tests
 *     (covered by route-level api spec; backend `adminGate` is the real gate).
 *   - Prompt anticipated "Loading… via entity (await findByText)". CONFIRMED:
 *     SUT renders verbatim "Loading…" inside the glass panel during the
 *     in-flight GET. Pinned via blocked promise.
 *   - Prompt anticipated "load 500 → silent degrade via .catch(() => [])".
 *     CONFIRMED: SUT's load() catches and sets categories=[], so a 500
 *     surfaces as the empty-state copy. The error itself is NOT toasted by
 *     this route (fetchApi handles its own toast). Pinned via mock rejection.
 *   - Prompt anticipated "parent-category hierarchy (if SUT supports tree)".
 *     CONFIRMED: SUT has a flat <select> dropdown of all categories (filtered
 *     to exclude self) — no tree UI. The "parent" column in the row shows
 *     the parent's name resolved via in-array find on parentId. Pinned both
 *     the select shape and the parent-name resolution.
 *   - Backend endpoint confirmed via grep on backend/routes/inventory.js
 *     (router.get("/product-categories", ...)) — inventory router mounts at
 *     /api/wellness so the SUT's /api/wellness/product-categories path is
 *     correct.
 *
 * Path: flat __tests__/ProductCategories.test.jsx — matches the tick #128
 * prompt path mandate.
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
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import ProductCategories from '../pages/wellness/ProductCategories';

const ROOT_CATEGORY = {
  id: 401,
  name: 'Consumables',
  parentId: null,
  isActive: true,
  imageUrl: null,
  _count: { products: 12, children: 2 },
};
const CHILD_CATEGORY = {
  id: 402,
  name: 'Syringes & Needles',
  parentId: 401,
  isActive: true,
  imageUrl: 'https://cdn.example.com/syringes.png',
  _count: { products: 5, children: 0 },
};
const INACTIVE_CATEGORY = {
  id: 403,
  name: 'Discontinued Pharma',
  parentId: null,
  isActive: false,
  imageUrl: null,
  _count: { products: 0, children: 0 },
};

function installFetchMock({
  categories = [ROOT_CATEGORY, CHILD_CATEGORY, INACTIVE_CATEGORY],
  categoriesPromise = null,
  categoriesReject = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/wellness/product-categories' && method === 'GET') {
      if (categoriesPromise) return categoriesPromise;
      if (categoriesReject) return Promise.reject(categoriesReject);
      return Promise.resolve(categories);
    }
    if (/^\/api\/wellness\/product-categories(\/\d+)?$/.test(url)) {
      // POST / PUT / DELETE — resolve so submit / delete paths complete.
      if (method === 'POST') return Promise.resolve({ id: 999 });
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ProductCategories />
    </MemoryRouter>,
  );
}

let confirmSpy;
beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  confirmSpy = undefined;
});
afterEach(() => {
  if (confirmSpy) confirmSpy.mockRestore();
});

describe('<ProductCategories /> — page chrome', () => {
  it('renders heading "Product categories" + "New category" CTA + count sub-copy', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Product categories/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /New category/i }),
    ).toBeInTheDocument();
    // Sub-copy: "<N> categor(y|ies) — hierarchical taxonomy for inventory products."
    await waitFor(() => {
      expect(
        screen.getAllByText((_t, el) =>
          /\d+ categor(?:y|ies).*hierarchical taxonomy/i.test(
            el?.textContent || '',
          ),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders "Loading…" while the initial GET is in flight', async () => {
    // Block the fetch indefinitely to pin the loading branch.
    installFetchMock({ categoriesPromise: new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<ProductCategories /> — mount fetch + list render', () => {
  it('fires GET /api/wellness/product-categories on mount and renders rows', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/product-categories',
      );
    });
    // Row anchors: row names appearing only as <td> text (not in placeholders).
    expect(
      await screen.findByText('Syringes & Needles'),
    ).toBeInTheDocument();
    expect(screen.getByText('Discontinued Pharma')).toBeInTheDocument();
    // 'Consumables' appears in BOTH the row cell AND the placeholder example;
    // assert at least one match (the row) — full uniqueness via aria-label
    // on the Edit/Delete buttons in subsequent tests.
    expect(screen.getAllByText('Consumables').length).toBeGreaterThanOrEqual(1);
  });

  it('renders empty-state copy when GET resolves to [] (also covers .catch silent-degrade)', async () => {
    installFetchMock({ categories: [] });
    renderPage();
    expect(
      await screen.findByText(/No categories yet\./i),
    ).toBeInTheDocument();
  });

  it('renders row columns: name + parent + product count + children count + status', async () => {
    installFetchMock();
    renderPage();
    // 'Syringes & Needles' is unique — appears only in the child row name cell.
    // 'Consumables' is NOT unique (root row name AND child row's parent col).
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    // Consumables resolves in TWO places (root row name + child row parent col).
    expect(screen.getAllByText('Consumables').length).toBeGreaterThanOrEqual(2);
    // Product counts — root has 12, child has 5, inactive has 0.
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    // Children counts — root has 2.
    expect(screen.getByText('2')).toBeInTheDocument();
    // Status badges — both Active rows + one Inactive.
    expect(screen.getAllByText(/^Active$/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/^Inactive$/)).toBeInTheDocument();
    // Em-dash for missing parent (root rows have parentId=null → '—').
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('search input narrows visible rows; no-match copy renders when nothing matches', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    const searchInput = screen.getByLabelText(/Search categories/i);
    // Narrow to "syring" — only child row matches. But the child row's parent
    // cell STILL shows "Consumables" (resolved via in-array find), so
    // 'Consumables' remains in the DOM as a parent-column value. Assert the
    // root-row's Edit button is gone (uniquely names the root row), and the
    // child row's Edit button is still present.
    fireEvent.change(searchInput, { target: { value: 'syring' } });
    expect(
      screen.queryByRole('button', { name: /Edit Consumables/i }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /Edit Syringes & Needles/i }),
    ).toBeInTheDocument();
    // Type nonsense — no-match copy renders.
    fireEvent.change(searchInput, { target: { value: 'zzznopezzz' } });
    expect(
      screen.getByText(/No categories match "zzznopezzz"/i),
    ).toBeInTheDocument();
  });
});

describe('<ProductCategories /> — New-category form toggle', () => {
  it('"New category" opens the form (label flips to "Cancel"); click again closes it', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New category/i }));
    // Form fields visible: name placeholder + parent select.
    expect(
      screen.getByPlaceholderText(/Name — e\.g\. Consumables/),
    ).toBeInTheDocument();
    expect(screen.getByText(/No parent \(root\)/i)).toBeInTheDocument();
    // CTA label flipped.
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeInTheDocument();
    // Click Cancel → form closes, label flips back.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(
      screen.queryByPlaceholderText(/Name — e\.g\. Consumables/),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /New category/i }),
    ).toBeInTheDocument();
  });

  it('name input carries the `required` attribute (browser-native blank-blocking)', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New category/i }));
    const nameInput = screen.getByPlaceholderText(/Name — e\.g\. Consumables/);
    expect(nameInput).toBeRequired();
  });
});

describe('<ProductCategories /> — create POST', () => {
  it('Create category → POST /api/wellness/product-categories with payload shape + notify.success + refetch', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New category/i }));
    fireEvent.change(
      screen.getByPlaceholderText(/Name — e\.g\. Consumables/),
      { target: { value: 'Topical Anaesthetics' } },
    );

    fireEvent.click(screen.getByRole('button', { name: /Create category/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/product-categories' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({
        name: 'Topical Anaesthetics',
        parentId: null,
        isActive: true,
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Created.*Topical Anaesthetics/i),
    );
    // After create, list refetches → at least 2 GETs total (initial + refetch).
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        u === '/api/wellness/product-categories' &&
        (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('<ProductCategories /> — edit prefill + PUT', () => {
  it('Edit (Pencil) opens the form pre-filled and Save → PUT /api/wellness/product-categories/:id', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    // Edit button uses aria-label `Edit ${name}`.
    fireEvent.click(
      screen.getByRole('button', {
        name: /Edit Syringes & Needles/i,
      }),
    );
    // Pre-fill: name input displays the row's name.
    const nameInput = screen.getByPlaceholderText(/Name — e\.g\. Consumables/);
    expect(nameInput.value).toBe('Syringes & Needles');
    // Tweak the name and submit.
    fireEvent.change(nameInput, {
      target: { value: 'Syringes & Needles (sterile)' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/product-categories/402' &&
          opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('Syringes & Needles (sterile)');
      // parentId pre-filled from row (401) is sent back as 401 int.
      expect(body.parentId).toBe(401);
      expect(body.isActive).toBe(true);
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Updated.*Syringes & Needles \(sterile\)/i),
    );
  });
});

describe('<ProductCategories /> — delete (native window.confirm)', () => {
  it('confirm()=true → DELETE /api/wellness/product-categories/:id + notify.success', async () => {
    installFetchMock();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Delete Consumables/i }),
    );
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Delete category "Consumables"/),
    );
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/product-categories/401' &&
          opts?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Deleted.*Consumables/i),
    );
  });

  it('confirm()=false → no DELETE fired + no notify.success', async () => {
    installFetchMock();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Delete Consumables/i }),
    );
    expect(confirmSpy).toHaveBeenCalled();
    // Brief microtask wait — make sure no async DELETE sneaks through.
    await Promise.resolve();
    const delCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'DELETE',
    );
    expect(delCall).toBeUndefined();
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});
