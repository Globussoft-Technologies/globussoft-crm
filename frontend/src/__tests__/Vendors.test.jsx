/**
 * Vendors.test.jsx — vitest + RTL coverage for the wellness-vertical inventory
 * vendor admin page (frontend/src/pages/wellness/Vendors.jsx).
 *
 * Scope: pins the page-surface invariants for the inventory supplier master —
 * heading + CTA, loading state, GET on mount, empty-state, vendor row render
 * (name + contact + phone + GSTIN + status), New-vendor form open/close,
 * create POST shape, edit-prefill flow, native-confirm delete flow (true +
 * false branches), and toggle-button label change (New vendor ↔ Cancel).
 *
 * Test cases (10):
 *   1. Heading "Vendors" + "New vendor" CTA + supplier-count sub-copy render.
 *   2. Loading state: "Loading…" renders while initial fetch is in-flight
 *      (per CLAUDE.md tick #108 cron-learning — loading branch must be pinned).
 *   3. GET /api/wellness/vendors fires on mount; rendered rows match payload.
 *   4. Empty-state copy "No vendors yet." renders when GET resolves to [].
 *   5. Vendor row renders name + contactPerson + phone + GSTIN + status
 *      (Active/Inactive); missing optional fields render as em-dash.
 *   6. Clicking "New vendor" opens the form; the CTA label flips to "Cancel";
 *      clicking again resets the form and re-shows "New vendor".
 *   7. Submitting the form POSTs /api/wellness/vendors with the form body
 *      JSON-stringified + notify.success + re-fetches the list.
 *   8. Name input has the `required` attribute (browser-native validation
 *      prevents POST when blank — pinned via attribute presence).
 *   9. Clicking the row's Edit (Pencil) button opens the form pre-filled with
 *      the row's name + GSTIN; Save → PUT /api/wellness/vendors/:id.
 *  10. Delete flow: clicking Trash with confirm()=true fires DELETE +
 *      notify.success; confirm()=false aborts (no DELETE).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/) with a
 *     stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap useCallback / useEffect dep
 *     identity, causing infinite re-render hangs).
 *   - SUT does NOT consume AuthContext, so no Provider wrapper is needed
 *     (drift item — see "Drift pinned" below).
 *   - window.confirm spied per-test via vi.spyOn (matches the Coupons.test.jsx
 *     pattern at frontend/src/__tests__/Coupons.test.jsx:405).
 *   - vi.mock path is `../utils/api` and `../utils/notify` relative to the
 *     flat top-level `__tests__/` directory.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "filter chrome (category / status filter narrows
 *     query)". REALITY: there is NO filter bar. The page renders the entire
 *     vendor list returned by GET /api/wellness/vendors; filtering happens
 *     server-side or not at all. No category filter, no status toggle, no
 *     search input. Omitted that case.
 *   - Prompt anticipated "category + tax-id" columns. REALITY: schema has no
 *     `category` field on Vendor (the SUT EMPTY initial state has no category
 *     key); only GSTIN is a tax-id-shaped column. Columns rendered are: Name,
 *     Contact (contactPerson), Phone, GSTIN, Status, action buttons. No
 *     category column.
 *   - Prompt anticipated "addressLine + email + address" form fields.
 *     REALITY: form HAS all three (name, contactPerson, phone, email, GSTIN,
 *     addressLine, isActive). Tests pin name + GSTIN + isActive as the
 *     load-bearing fields; the others are exercised implicitly through the
 *     create POST body shape.
 *   - Prompt anticipated "RBAC: USER hides mutation CTAs if SUT enforces
 *     (likely backend-only per wellness pattern)". CONFIRMED backend-only:
 *     the SUT does NOT consume AuthContext at all and renders the New-vendor
 *     CTA + row Edit/Delete buttons for every authenticated client. Backend
 *     `adminGate` middleware on inventory.js:285+ is the actual gate. Omitted
 *     RBAC tests (covered by route-level api spec).
 *   - Prompt anticipated "loading state via `await findByText` for 'Loading…'".
 *     CONFIRMED: SUT renders "Loading…" verbatim inside the glass panel
 *     during the in-flight GET. Pinned via blocked promise.
 *   - Prompt anticipated "sub-vendor link / purchase orders flow". REALITY:
 *     SUT has neither — purchase orders live in a separate (inventory
 *     receipts) module. The supplier-count sub-copy mentions "inventory
 *     receipts" but there's no link / drill-down. Omitted.
 *   - Backend endpoint confirmed via grep on backend/routes/inventory.js:285
 *     (router.get("/vendors", adminGate, ...)) — inventory router mounts at
 *     /api/wellness so the SUT's /api/wellness/vendors path is correct.
 *
 * Path: flat __tests__/Vendors.test.jsx — distinct from any wellness/ subdir
 * convention; matches the tick #127 prompt path mandate.
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

import Vendors from '../pages/wellness/Vendors';

const ACTIVE_VENDOR = {
  id: 301,
  name: 'Sterile Supplies Pvt Ltd',
  contactPerson: 'Anita Mehra',
  phone: '+919812345678',
  email: 'orders@sterile-supplies.in',
  gstin: '27AAPCS1234A1Z5',
  addressLine: '21 MG Road, Pune 411001',
  isActive: true,
};
const INACTIVE_VENDOR = {
  id: 302,
  name: 'Legacy Pharma Distributors',
  contactPerson: null,
  phone: null,
  email: null,
  gstin: null,
  addressLine: null,
  isActive: false,
};

function installFetchMock({
  vendors = [ACTIVE_VENDOR, INACTIVE_VENDOR],
  vendorsPromise = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/wellness/vendors' && method === 'GET') {
      if (vendorsPromise) return vendorsPromise;
      return Promise.resolve(vendors);
    }
    if (/^\/api\/wellness\/vendors(\/\d+)?$/.test(url)) {
      // POST / PUT / DELETE — resolve so submit / delete paths complete.
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Vendors />
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

describe('<Vendors /> — page chrome', () => {
  it('renders heading + "New vendor" CTA + supplier-count sub-copy', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Vendors/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /New vendor/i }),
    ).toBeInTheDocument();
    // Sub-copy uses count + "supplier(s)" + "inventory receipts" phrasing.
    // Use getAllByText — both the <p> and its parent <div> textContent match.
    await waitFor(() => {
      expect(
        screen.getAllByText((_t, el) =>
          /\d+ supplier.*inventory receipts/i.test(el?.textContent || ''),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders "Loading…" while the initial GET is in flight', async () => {
    // Block the fetch indefinitely to pin the loading branch.
    installFetchMock({ vendorsPromise: new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<Vendors /> — mount fetch + list render', () => {
  it('fires GET /api/wellness/vendors on mount and renders vendor rows', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/vendors');
    });
    expect(
      await screen.findByText('Sterile Supplies Pvt Ltd'),
    ).toBeInTheDocument();
    expect(screen.getByText('Legacy Pharma Distributors')).toBeInTheDocument();
  });

  it('renders the empty-state copy when GET resolves to []', async () => {
    installFetchMock({ vendors: [] });
    renderPage();
    expect(await screen.findByText(/No vendors yet\./i)).toBeInTheDocument();
  });

  it('renders vendor-row columns: name + contact + phone + GSTIN + status; missing optionals as em-dash', async () => {
    installFetchMock();
    renderPage();
    // Active row — populated columns.
    await waitFor(() => {
      expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    });
    expect(screen.getByText('Anita Mehra')).toBeInTheDocument();
    expect(screen.getByText('+919812345678')).toBeInTheDocument();
    expect(screen.getByText('27AAPCS1234A1Z5')).toBeInTheDocument();
    expect(screen.getByText(/^Active$/)).toBeInTheDocument();
    // Inactive row — every optional is null, so 4 em-dashes render in that
    // row (contactPerson + phone + gstin + email-not-shown; SUT uses '—'
    // fallback). Assert at least one em-dash is present.
    expect(
      screen.getAllByText('—').length,
    ).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/^Inactive$/)).toBeInTheDocument();
  });
});

describe('<Vendors /> — New-vendor form toggle', () => {
  it('"New vendor" opens the form (label flips to "Cancel"); click again closes it', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New vendor/i }));
    // Form fields are visible.
    expect(
      screen.getByPlaceholderText(/Name — e\.g\. Sterile Supplies Pvt Ltd/),
    ).toBeInTheDocument();
    // CTA label flipped.
    expect(
      screen.getByRole('button', { name: /^Cancel$/ }),
    ).toBeInTheDocument();
    // Click Cancel → form closes, label flips back.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(
      screen.queryByPlaceholderText(/Name — e\.g\. Sterile Supplies Pvt Ltd/),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /New vendor/i }),
    ).toBeInTheDocument();
  });

  it('name input carries the `required` attribute (browser-native blank-blocking)', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New vendor/i }));
    const nameInput = screen.getByPlaceholderText(
      /Name — e\.g\. Sterile Supplies Pvt Ltd/,
    );
    expect(nameInput).toBeRequired();
  });
});

describe('<Vendors /> — create POST', () => {
  it('Create vendor → POST /api/wellness/vendors with body shape + notify.success + refetch', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New vendor/i }));
    fireEvent.change(
      screen.getByPlaceholderText(/Name — e\.g\. Sterile Supplies Pvt Ltd/),
      { target: { value: 'Aurora Aesthetics Supply' } },
    );
    fireEvent.change(screen.getByPlaceholderText(/^Contact person$/), {
      target: { value: 'Vikram Rao' },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Phone$/), {
      target: { value: '+919999912345' },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Email$/), {
      target: { value: 'sales@aurora-aesthetics.in' },
    });
    fireEvent.change(screen.getByPlaceholderText(/GSTIN \(15 chars\)/), {
      target: { value: '29aapca9999b1z7' }, // SUT uppercases on change.
    });

    fireEvent.click(screen.getByRole('button', { name: /Create vendor/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/vendors' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({
        name: 'Aurora Aesthetics Supply',
        contactPerson: 'Vikram Rao',
        phone: '+919999912345',
        email: 'sales@aurora-aesthetics.in',
        gstin: '29AAPCA9999B1Z7',
        isActive: true,
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Created.*Aurora Aesthetics Supply/i),
    );
    // After create, list refetches → at least 2 GETs total (initial + refetch).
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        u === '/api/wellness/vendors' && (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('<Vendors /> — edit prefill + PUT', () => {
  it('Edit (Pencil) opens the form pre-filled and Save → PUT /api/wellness/vendors/:id', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    });
    // Edit button uses aria-label `Edit ${name}`.
    fireEvent.click(
      screen.getByRole('button', {
        name: /Edit Sterile Supplies Pvt Ltd/i,
      }),
    );
    // Pre-fill: name input displays the row's name.
    const nameInput = screen.getByPlaceholderText(
      /Name — e\.g\. Sterile Supplies Pvt Ltd/,
    );
    expect(nameInput.value).toBe('Sterile Supplies Pvt Ltd');
    expect(screen.getByPlaceholderText(/GSTIN \(15 chars\)/).value).toBe(
      '27AAPCS1234A1Z5',
    );
    // Tweak the name and submit.
    fireEvent.change(nameInput, {
      target: { value: 'Sterile Supplies Pvt Ltd (renamed)' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/vendors/301' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('Sterile Supplies Pvt Ltd (renamed)');
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Updated.*Sterile Supplies Pvt Ltd \(renamed\)/i),
    );
  });
});

describe('<Vendors /> — delete (native window.confirm)', () => {
  it('confirm()=true → DELETE /api/wellness/vendors/:id + notify.success', async () => {
    installFetchMock();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Delete Sterile Supplies Pvt Ltd/i,
      }),
    );
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Delete vendor "Sterile Supplies Pvt Ltd"/),
    );
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/vendors/301' && opts?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Removed.*Sterile Supplies Pvt Ltd/i),
    );
  });

  it('confirm()=false → no DELETE fired + no notify.success', async () => {
    installFetchMock();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Delete Sterile Supplies Pvt Ltd/i,
      }),
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
