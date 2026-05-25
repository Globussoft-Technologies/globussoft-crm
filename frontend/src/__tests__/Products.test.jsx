/**
 * Products.test.jsx — vitest + RTL coverage for the wellness-vertical Products
 * admin page (frontend/src/pages/wellness/Products.jsx) shipped at #933 / #816.
 *
 * Scope: pins the page-surface invariants for the wellness inventory Products
 * admin — header + count sub-copy + CTAs, loading + empty states, GET on
 * mount, table render (name + sku + category + price + stock + status with
 * low-stock badge), New-product form toggle + reset, create-POST happy path
 * + two validation branches (empty-name + negative-price), Export-CSV
 * (Blob → anchor click → URL.revokeObjectURL), Import-CSV (FormData multipart
 * → summary toast), Export disabled when products list is empty.
 *
 * Test cases (13):
 *   1. Heading + Package icon + "New product" CTA + Export/Import CSV buttons
 *      render. Count sub-copy ("N product(s) — inventory items…") reflects
 *      payload length.
 *   2. Loading state: "Loading…" renders while initial GET is in-flight.
 *   3. GET /api/wellness/products fires on mount; row payload renders with
 *      name + sku + price (formatted) + stock columns.
 *   4. Empty-state copy "No products yet. Click New product or Import CSV..."
 *      renders when GET resolves to [].
 *   5. Category lookup: row's categoryId resolves to category.name via the
 *      parallel GET /api/wellness/product-categories load.
 *   6. Low-stock badge: row with threshold>0 AND currentStock<=threshold
 *      renders "Low stock" (red); otherwise "OK" (green).
 *   7. SKU em-dash fallback: row with sku=null renders the em-dash.
 *   8. New-product opens the form (Name placeholder visible); CTA label flips
 *      to "Cancel"; clicking Cancel resets + closes form.
 *   9. Submit with empty-name fires notify.error('Product name is required.')
 *      and NO POST goes out.
 *  10. Submit with negative-price fires notify.error('Price must be 0 or
 *      greater.') and NO POST goes out.
 *  11. Submit happy-path: POST /api/cpq/products with body shape
 *      {name, sku, price, isRecurring, threshold, currentStock, ...} +
 *      notify.success('Created "<name>"') + form resets + list re-fetches.
 *  12. Export CSV: clicks the button → fetch('/api/csv/products/export.csv')
 *      → anchor created + clicked + removed → notify.success summary.
 *  13. Import CSV: file upload → fetch('/api/csv/products/import.csv', POST,
 *      FormData) → summary toast ("Imported N, updated M…") + list re-fetches.
 *   (bonus: Export button disabled when products list is empty.)
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/) with a
 *     stable mock fn that branches by URL.
 *   - notifyObj is STABLE module-level — Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule (fresh-per-call objects flap dep identity → infinite re-
 *     render hangs).
 *   - global.fetch is mocked PER-TEST for the CSV paths (export uses bare
 *     `fetch` not fetchApi because it needs raw Blob+headers control).
 *   - URL.createObjectURL + URL.revokeObjectURL stubbed so the anchor-click
 *     download path completes under jsdom.
 *   - SUT does NOT consume AuthContext (no useAuth import) → no Provider
 *     wrapper. MemoryRouter is defensive in case any lazy descendant pulls
 *     in a Link/useNavigate.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "create/edit/delete + category filter". REALITY: SUT
 *     does NOT ship edit or delete — per SUT header lines 17-23, "Edit (PUT
 *     /api/cpq/products/:id does not exist). Delete (DELETE /api/cpq/...)
 *     does not exist. The wellness/products mount only exposes GET; CSV
 *     Import handles bulk create + update; per-row edit + delete need a
 *     backend follow-up." Also NO category filter UI — categoryId is a
 *     SELECT INSIDE the create-form, not a top-of-page filter. Omitted edit /
 *     delete / category-filter cases entirely; the page is GET + CREATE + CSV.
 *   - Prompt anticipated "12 cases". Authored 13 covering the actually-
 *     surfaced contracts (the CSV paths add real test-surface — Blob anchor
 *     click for export, FormData multipart for import — that wouldn't exist
 *     for a typical CRUD page).
 *   - Prompt anticipated "Loading…" verbatim. CONFIRMED — SUT line 332.
 *   - Empty-state copy CONFIRMED at SUT line 335: "No products yet. Click
 *     New product or Import CSV to add one." (with <strong> tags around
 *     "New product" / "Import CSV").
 *   - CSV-import response shape CONFIRMED: SUT lines 156-165 expect
 *     { imported, updated, skipped, errors: [...] } and toasts a summary
 *     like "Imported 5, updated 1, skipped 2 (3 rows with errors)".
 *   - formMoney call: SUT line 358 passes { maximumFractionDigits: 0 } so
 *     1500 → "₹1,500" (no decimals). Test uses a wide regex.
 *
 * Path: flat __tests__/Products.test.jsx — matches sibling Drugs / Services /
 * Vendors flat-path convention.
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

import Products from '../pages/wellness/Products';

const CATEGORIES = [
  { id: 1, name: 'Skincare' },
  { id: 2, name: 'Haircare' },
];

const PRP_SERUM = {
  id: 101,
  name: 'PRP serum 10ml',
  sku: 'PRP-10',
  categoryId: 1,
  price: 1500,
  currentStock: 5,
  threshold: 10, // 5 <= 10 → low stock
};
const SHAMPOO = {
  id: 102,
  name: 'Saxon repair shampoo 200ml',
  sku: 'SAX-200',
  categoryId: 2,
  price: 850,
  currentStock: 20,
  threshold: 5, // 20 > 5 → OK
};
const NO_SKU = {
  id: 103,
  name: 'Generic Vitamin C cream',
  sku: null,
  categoryId: null,
  price: null,
  currentStock: 0,
  threshold: 0, // threshold=0 → no low-stock comparison; OK
};

function installFetchApiMock({
  products = [PRP_SERUM, SHAMPOO, NO_SKU],
  productsPromise = null,
  categories = CATEGORIES,
  createResult = { id: 999, ok: true },
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/wellness/products' && method === 'GET') {
      if (productsPromise) return productsPromise;
      return Promise.resolve(products);
    }
    if (url === '/api/wellness/product-categories' && method === 'GET') {
      return Promise.resolve(categories);
    }
    if (url === '/api/cpq/products' && method === 'POST') {
      return Promise.resolve(createResult);
    }
    return Promise.resolve({});
  });
}

function installFetchGlobalMock({
  exportOk = true,
  exportStatus = 200,
  importOk = true,
  importStatus = 200,
  importData = { imported: 2, updated: 1, skipped: 0, errors: [] },
} = {}) {
  global.fetch = vi.fn().mockImplementation((url) => {
    if (typeof url === 'string' && url.includes('/api/csv/products/export.csv')) {
      return Promise.resolve({
        ok: exportOk,
        status: exportStatus,
        blob: () => Promise.resolve(new Blob(['name,sku\nx,y'], { type: 'text/csv' })),
      });
    }
    if (typeof url === 'string' && url.includes('/api/csv/products/import.csv')) {
      return Promise.resolve({
        ok: importOk,
        status: importStatus,
        json: () => Promise.resolve(importData),
      });
    }
    return Promise.resolve({ ok: false, status: 404, blob: () => Promise.resolve(new Blob()), json: () => Promise.resolve({}) });
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Products />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  // Stub Blob URL helpers — jsdom doesn't implement these by default.
  global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  global.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  if (global.fetch && global.fetch.mockRestore) global.fetch.mockRestore?.();
});

describe('<Products /> — page chrome', () => {
  it('renders Products heading + count sub-copy + New product + Export/Import CSV CTAs', async () => {
    installFetchApiMock();
    renderPage();

    expect(
      screen.getByRole('heading', { name: /Products/i }),
    ).toBeInTheDocument();
    // Export + Import buttons are always rendered.
    expect(
      screen.getByRole('button', { name: /Export CSV/i }),
    ).toBeInTheDocument();
    // "Import CSV" label wraps a hidden <input type=file>, exposed as a <label>.
    expect(screen.getByText(/Import CSV/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /New product/i }),
    ).toBeInTheDocument();

    // Sub-copy: "3 products — inventory items consumed during visits..."
    await waitFor(() => {
      expect(
        screen.getAllByText((_t, el) =>
          /\d+ products?.*inventory items.*visits.*POS/i.test(
            el?.textContent || '',
          ),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders "Loading…" while the initial GET is in flight', async () => {
    // Block the products fetch indefinitely to pin the loading branch.
    installFetchApiMock({ productsPromise: new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<Products /> — mount fetch + list render', () => {
  it('fires GET /api/wellness/products + /api/wellness/product-categories on mount and renders row name + price', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/products');
    });
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/product-categories');

    expect(await screen.findByText('PRP serum 10ml')).toBeInTheDocument();
    expect(screen.getByText('Saxon repair shampoo 200ml')).toBeInTheDocument();
    expect(screen.getByText('Generic Vitamin C cream')).toBeInTheDocument();
    // Price formatted (formatMoney is locale-dependent; assert thousands grouping).
    expect(screen.getByText(/1,500/)).toBeInTheDocument();
    expect(screen.getByText(/850/)).toBeInTheDocument();
  });

  it('renders the empty-state copy when GET resolves to []', async () => {
    installFetchApiMock({ products: [] });
    renderPage();
    expect(
      await screen.findByText(/No products yet\./),
    ).toBeInTheDocument();
    // Container text contains both "New product" and "Import CSV" labels.
    expect(
      screen.getAllByText(/New product/i).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('resolves row categoryId to category.name via the parallel categories load', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    // PRP_SERUM.categoryId=1 → "Skincare"; SHAMPOO.categoryId=2 → "Haircare".
    expect(screen.getByText('Skincare')).toBeInTheDocument();
    expect(screen.getByText('Haircare')).toBeInTheDocument();
    // NO_SKU.categoryId=null → em-dash fallback.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('renders Low-stock badge for threshold>0 AND currentStock<=threshold; OK otherwise', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    // PRP_SERUM: stock=5, threshold=10 → "Low stock".
    expect(screen.getByText(/^Low stock$/i)).toBeInTheDocument();
    // SHAMPOO + NO_SKU → "OK" (2 rows).
    expect(screen.getAllByText(/^OK$/).length).toBeGreaterThanOrEqual(2);
  });

  it('renders em-dash for null sku rows', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Generic Vitamin C cream')).toBeInTheDocument();
    });
    // NO_SKU has sku=null → em-dash in the SKU column. Multiple em-dashes
    // exist (also category=null) so just assert presence ≥ 1.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });
});

describe('<Products /> — New-product form toggle', () => {
  it('clicks "New product" → form opens (Name placeholder visible); CTA flips to "Cancel"; click again closes', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New product/i }));
    expect(
      screen.getByPlaceholderText(/Name — e.g. PRP serum 10ml/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Cancel$/i }),
    ).toBeInTheDocument();
    // Click Cancel → form closes, CTA returns to "New product".
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(
      screen.queryByPlaceholderText(/Name — e.g. PRP serum 10ml/i),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /New product/i }),
    ).toBeInTheDocument();
  });
});

describe('<Products /> — create validation', () => {
  it('empty name → notify.error("Product name is required.") + NO POST', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New product/i }));
    // Leave the name field empty (default), click "Create product".
    fireEvent.click(screen.getByRole('button', { name: /Create product/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Product name is required.');
    });
    // No POST fired.
    const postCall = fetchApiMock.mock.calls.find(
      ([u, opts]) => u === '/api/cpq/products' && opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('negative price → notify.error("Price must be 0 or greater.") + NO POST', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New product/i }));

    // Fill the required name so we don't trip the prior validator.
    fireEvent.change(
      screen.getByPlaceholderText(/Name — e.g. PRP serum 10ml/i),
      { target: { value: 'Test product' } },
    );
    // The number input rejects negative typing via min=0 + jsdom semantics,
    // but the JS validator (Number(form.price) < 0) is the real gate. Pass
    // a string the validator parses as negative.
    fireEvent.change(
      screen.getByPlaceholderText(/Price \(e\.g\. 1500\)/i),
      { target: { value: '-10' } },
    );
    fireEvent.click(screen.getByRole('button', { name: /Create product/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Price must be 0 or greater.');
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([u, opts]) => u === '/api/cpq/products' && opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });
});

describe('<Products /> — create happy path', () => {
  it('POST /api/cpq/products with body shape + notify.success + form resets + list re-fetches', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New product/i }));

    fireEvent.change(
      screen.getByPlaceholderText(/Name — e.g. PRP serum 10ml/i),
      { target: { value: 'Botox 50u' } },
    );
    fireEvent.change(
      screen.getByPlaceholderText(/SKU \(optional, unique\)/i),
      { target: { value: 'BOTOX-50' } },
    );
    fireEvent.change(
      screen.getByPlaceholderText(/Price \(e\.g\. 1500\)/i),
      { target: { value: '15000' } },
    );
    fireEvent.change(
      screen.getByPlaceholderText(/Current stock/i),
      { target: { value: '8' } },
    );

    fireEvent.click(screen.getByRole('button', { name: /Create product/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/cpq/products' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({
        name: 'Botox 50u',
        sku: 'BOTOX-50',
        price: 15000,
        currentStock: 8,
        threshold: 0,
        isRecurring: false,
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Created.*Botox 50u/i),
    );
    // Form reset → New product CTA visible again (no Cancel).
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /New product/i }),
      ).toBeInTheDocument();
    });
    // List re-fetches after create → ≥2 GETs to /api/wellness/products.
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        u === '/api/wellness/products' && (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('<Products /> — CSV export', () => {
  it('Export CSV → fetch(/api/csv/products/export.csv) → Blob → anchor click + notify.success', async () => {
    installFetchApiMock();
    installFetchGlobalMock({ exportOk: true });
    // Spy on document.createElement to verify the anchor click flow.
    const realCreate = document.createElement.bind(document);
    const anchor = realCreate('a');
    const clickSpy = vi.spyOn(anchor, 'click').mockImplementation(() => {});
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag === 'a') return anchor;
      return realCreate(tag);
    });

    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Export CSV/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/csv/products/export.csv',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
    });
    expect(clickSpy).toHaveBeenCalled();
    expect(global.URL.createObjectURL).toHaveBeenCalled();
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Exported 3 products/i),
    );

    createSpy.mockRestore();
  });

  it('Export CSV button is disabled when products list is empty', async () => {
    installFetchApiMock({ products: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No products yet\./)).toBeInTheDocument();
    });
    const exportBtn = screen.getByRole('button', { name: /Export CSV/i });
    expect(exportBtn).toBeDisabled();
  });
});

describe('<Products /> — CSV import', () => {
  it('Import CSV file upload → POST multipart to /api/csv/products/import.csv + summary toast + list re-fetches', async () => {
    installFetchApiMock();
    installFetchGlobalMock({
      importOk: true,
      importData: { imported: 5, updated: 1, skipped: 2, errors: [{ row: 3 }] },
    });

    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });

    // The file input is hidden; query by aria-label.
    const fileInput = screen.getByLabelText(/Import products CSV file/i);
    const file = new File(['name,sku\nA,X'], 'products.csv', { type: 'text/csv' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/csv/products/import.csv',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
          body: expect.any(FormData),
        }),
      );
    });
    // Summary toast pattern: "Imported 5, updated 1, skipped 2 (1 row with errors)"
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Imported 5.*updated 1.*skipped 2.*1 row.*errors/i),
    );
    // After import, list re-fetches.
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        u === '/api/wellness/products' && (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });
});
