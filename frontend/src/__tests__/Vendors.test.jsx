/**
 * Vendors.test.jsx — vitest + RTL coverage for the wellness-vertical inventory
 * vendor admin page (frontend/src/pages/wellness/Vendors.jsx).
 *
 * Drift pinned (test re-aligned to actual SUT 2026-05-27):
 *   - SUT's default statusFilter is 'active' → rows where isActive===false are
 *     hidden by default. Inactive-row assertions use the 'all' filter pill.
 *   - SUT uses notify.confirm({...}) (resolving Promise), NOT window.confirm.
 *     Delete + Archive flows are gated by notify.confirm — switch its return
 *     between Promise.resolve(true) / false to exercise both branches.
 *   - SUT renders the inactive badge as "Archived", not "Inactive".
 *   - Sub-copy is "N active[, M archived] — used when recording inventory
 *     receipts.", not "supplier(s) … inventory receipts".
 *   - SUT does not render an Email column in the row table (only Name, Contact,
 *     Phone, GSTIN, Status, actions).
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

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockImplementation(() => Promise.resolve(true));
});
afterEach(() => {});

describe('<Vendors /> — page chrome', () => {
  it('renders heading + "New vendor" CTA + active-count sub-copy', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Vendors/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /New vendor/i }),
    ).toBeInTheDocument();
    // Sub-copy: "1 active, 1 archived — used when recording inventory receipts."
    await waitFor(() => {
      expect(
        screen.getAllByText((_t, el) =>
          /\d+ active.*inventory receipts/i.test(el?.textContent || ''),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders "Loading…" while the initial GET is in flight', async () => {
    installFetchMock({ vendorsPromise: new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<Vendors /> — mount fetch + list render', () => {
  it('fires GET /api/wellness/vendors on mount and renders the active row', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/vendors');
    });
    // Default 'active' filter → only the active vendor renders.
    expect(
      await screen.findByText('Sterile Supplies Pvt Ltd'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Legacy Pharma Distributors')).toBeNull();
  });

  it('renders the empty-state copy when GET resolves to []', async () => {
    installFetchMock({ vendors: [] });
    renderPage();
    expect(await screen.findByText(/No vendors yet\./i)).toBeInTheDocument();
  });

  it('renders vendor-row columns: name + contact + phone + GSTIN + Active badge', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    });
    expect(screen.getByText('Anita Mehra')).toBeInTheDocument();
    expect(screen.getByText('+919812345678')).toBeInTheDocument();
    expect(screen.getByText('27AAPCS1234A1Z5')).toBeInTheDocument();
    // "Active" also appears as a filter-pill label, so use getAllByText.
    expect(screen.getAllByText(/^Active$/).length).toBeGreaterThanOrEqual(1);
  });

  it('switching to "All" filter pill reveals the archived vendor with Archived badge', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    });
    // Click the "All" filter pill.
    fireEvent.click(screen.getByRole('tab', { name: /^All/i }));
    expect(
      await screen.findByText('Legacy Pharma Distributors'),
    ).toBeInTheDocument();
    // "Archived" also appears as a filter-pill label, so use getAllByText.
    expect(screen.getAllByText(/^Archived$/).length).toBeGreaterThanOrEqual(1);
    // Both rows visible → em-dash fallbacks for inactive row's null optionals.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });
});

describe('<Vendors /> — New-vendor form toggle', () => {
  it('"New vendor" opens the form (label flips to "Cancel"); click again closes', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New vendor/i }));
    expect(
      screen.getByPlaceholderText(/Name — e\.g\. Sterile Supplies Pvt Ltd/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Cancel$/ }),
    ).toBeInTheDocument();
    // Click the same toggle button (now "Cancel") to close.
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
    fireEvent.change(screen.getByPlaceholderText(/^Phone/i), {
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
    fireEvent.click(
      screen.getByRole('button', {
        name: /Edit Sterile Supplies Pvt Ltd/i,
      }),
    );
    const nameInput = screen.getByPlaceholderText(
      /Name — e\.g\. Sterile Supplies Pvt Ltd/,
    );
    expect(nameInput.value).toBe('Sterile Supplies Pvt Ltd');
    expect(screen.getByPlaceholderText(/GSTIN \(15 chars\)/).value).toBe(
      '27AAPCS1234A1Z5',
    );
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

describe('<Vendors /> — delete (notify.confirm)', () => {
  it('confirm()=true → DELETE /api/wellness/vendors/:id + notify.success', async () => {
    installFetchMock();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Delete Sterile Supplies Pvt Ltd/i,
      }),
    );
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Delete vendor',
          message: expect.stringMatching(/Delete vendor "Sterile Supplies Pvt Ltd"/),
        }),
      );
    });
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
    notifyConfirm.mockImplementation(() => Promise.resolve(false));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Delete Sterile Supplies Pvt Ltd/i,
      }),
    );
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    await Promise.resolve();
    const delCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'DELETE',
    );
    expect(delCall).toBeUndefined();
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});
