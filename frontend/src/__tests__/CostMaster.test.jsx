/**
 * CostMaster.test.jsx — vitest + RTL coverage for the Travel-vertical
 * supplier-rate-book admin page (frontend/src/pages/travel/CostMaster.jsx).
 *
 * Lands at /travel/cost-master. Full operator surface:
 *   read + add (all sub-brands) + inline-edit + delete + toggle-active +
 *   CSV import/export.
 *
 * Scope (15 cases):
 *   1.  Page chrome: heading + filter bar + Pricing-rules link + action buttons.
 *   2.  Loading state.
 *   3.  GET on mount: ?limit=200 + renders rows.
 *   4.  Empty state.
 *   5.  Sub-brand filter re-fetches with ?subBrand=rfu.
 *   6.  Category filter re-fetches with ?category=hotel.
 *   7.  Money formatting: ₹X,YYY.
 *   8.  Add-rate subBrand dropdown shows ALL accessible brands with full labels
 *       (not just RFU — regression pin for the "RFU-only" bug).
 *   9.  Add-rate form POST with correct fields.
 *   10. Add-rate validation.
 *   11. Toggle-active PATCHes isActive:!current.
 *   12. Edit: pencil → inline row → PATCH.
 *   13. Edit cancel: no PATCH.
 *   14. Delete: confirm → DELETE → row removed.
 *   15. Delete cancel: no DELETE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = { error: notifyError, info: notifyInfo, success: notifySuccess, confirm: notifyConfirm };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import { AuthContext } from '../App';
import CostMaster from '../pages/travel/CostMaster';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

function makeRate(overrides = {}) {
  return {
    id: 301, tenantId: 1, subBrand: 'rfu', category: 'hotel',
    routeOrSku: 'Makkah:Hilton:Deluxe', baseRate: 5000, currency: 'INR',
    isActive: true, createdAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const RATES_DEFAULT = [
  makeRate({ id: 301, subBrand: 'rfu', category: 'hotel', routeOrSku: 'Makkah:Hilton:Deluxe', baseRate: 5000, isActive: true }),
  makeRate({ id: 302, subBrand: 'tmc', category: 'flight', routeOrSku: 'DEL-BLR:Indigo:Econ', baseRate: 4500, isActive: true }),
  makeRate({ id: 303, subBrand: 'visasure', category: 'visa', routeOrSku: 'UAE:Tourist:30d', baseRate: 8000, isActive: false }),
];

function installFetchMock({ list = { rates: RATES_DEFAULT }, create = null, patch = null, del = null } = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/travel/cost-master?') && method === 'GET') {
      return list instanceof Error ? Promise.reject(list) : Promise.resolve(list);
    }
    if (url === '/api/travel/cost-master' && method === 'POST') {
      return create instanceof Error ? Promise.reject(create) : Promise.resolve(create || makeRate({ id: 999 }));
    }
    if (/^\/api\/travel\/cost-master\/\d+$/.test(url) && method === 'PATCH') {
      return patch instanceof Error ? Promise.reject(patch) : Promise.resolve(patch || makeRate({ id: 301 }));
    }
    if (/^\/api\/travel\/cost-master\/\d+$/.test(url) && method === 'DELETE') {
      return del instanceof Error ? Promise.reject(del) : Promise.resolve(del || { deleted: true, id: 301 });
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false }}>
        <CostMaster />
      </AuthContext.Provider>
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
  installFetchMock();
});

afterEach(() => { vi.restoreAllMocks(); });

// ── 1. Page chrome ────────────────────────────────────────────────────────────
describe('<CostMaster /> — page chrome', () => {
  it('renders heading + filter bar + Pricing-rules link + action buttons', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Cost Master/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Sub-brand$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Category$/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Pricing rules/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export CSV/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import CSV/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add rate/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchApiMock.mock.calls.some(([u]) => u && u.startsWith('/api/travel/cost-master'))).toBe(true);
    });
  });
});

// ── 2-4. Load + render lifecycle ──────────────────────────────────────────────
describe('<CostMaster /> — load + render lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url, opts) => {
      if ((opts?.method || 'GET') === 'GET' && url.startsWith('/api/travel/cost-master?'))
        return new Promise((res) => { resolveList = res; });
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveList({ rates: RATES_DEFAULT });
    await screen.findByText('Makkah:Hilton:Deluxe');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs ?limit=200 on mount with no filter params when filters are empty', async () => {
    renderPage();
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        u && u.startsWith('/api/travel/cost-master?') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
      expect(call[0]).toMatch(/limit=200/);
      expect(call[0]).not.toMatch(/subBrand=/);
      expect(call[0]).not.toMatch(/category=/);
    });
    expect(await screen.findByText('Makkah:Hilton:Deluxe')).toBeInTheDocument();
    expect(screen.getByText('DEL-BLR:Indigo:Econ')).toBeInTheDocument();
  });

  it('renders empty state when API returns rates:[]', async () => {
    installFetchMock({ list: { rates: [] } });
    renderPage();
    expect(await screen.findByText(/No rates yet/i)).toBeInTheDocument();
  });
});

// ── 5-6. Filters ─────────────────────────────────────────────────────────────
describe('<CostMaster /> — filter behaviour', () => {
  it('selecting sub-brand "rfu" re-fetches with ?subBrand=rfu', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fetchApiMock.mockClear();
    installFetchMock({ list: { rates: [RATES_DEFAULT[0]] } });
    fireEvent.change(screen.getByLabelText(/^Sub-brand$/i), { target: { value: 'rfu' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        u && u.includes('subBrand=rfu') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('selecting category "hotel" re-fetches with ?category=hotel', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fetchApiMock.mockClear();
    installFetchMock({ list: { rates: [RATES_DEFAULT[0]] } });
    fireEvent.change(screen.getByLabelText(/^Category$/i), { target: { value: 'hotel' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        u && u.includes('category=hotel') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

// ── 7. Money + badge ──────────────────────────────────────────────────────────
describe('<CostMaster /> — row rendering', () => {
  it('row baseRate renders as "₹5,000" and sub-brand badge shows "rfu"', async () => {
    renderPage();
    const cell = await screen.findByText('Makkah:Hilton:Deluxe');
    const tr = cell.closest('tr');
    expect(within(tr).getByText(/₹5,000/)).toBeInTheDocument();
    expect(within(tr).getByText('rfu')).toBeInTheDocument();
  });
});

// ── 8. Add-rate subBrand dropdown shows all brands ────────────────────────────
describe('<CostMaster /> — add-rate subBrand dropdown', () => {
  it('dropdown shows full labels for all accessible brands (not just RFU)', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fireEvent.click(screen.getByRole('button', { name: /Add rate/i }));
    // Find the sub-brand select by scanning all comboboxes for the one
    // that has all 4 brand options (ADMIN user → full access).
    const allSelects = screen.getAllByRole('combobox');
    const brandSelect = allSelects.find((sel) => {
      const opts = Array.from(sel.options || []).map((o) => o.text);
      return opts.some((t) => t.includes('TMC')) && opts.some((t) => t.includes('RFU'));
    });
    expect(brandSelect).toBeTruthy();
    const optTexts = Array.from(brandSelect.options).map((o) => o.text);
    // Must include full readable labels for all 4 brands, not just "RFU".
    expect(optTexts.some((t) => /TMC/i.test(t))).toBe(true);
    expect(optTexts.some((t) => /RFU/i.test(t))).toBe(true);
    expect(optTexts.some((t) => /Travel Stall/i.test(t))).toBe(true);
    expect(optTexts.some((t) => /Visa Sure/i.test(t))).toBe(true);
  });
});

// ── 9-10. Add-rate form ───────────────────────────────────────────────────────
describe('<CostMaster /> — add-rate form', () => {
  it('fills and submits → POST with correct fields + notify.success("Rate added")', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fireEvent.click(screen.getByRole('button', { name: /Add rate/i }));
    const routeInput = screen.getByPlaceholderText(/BLR-DPS-Economy/i);
    const baseInput = screen.getByPlaceholderText(/22000/i);
    fireEvent.change(routeInput, { target: { value: 'Madinah:Pullman:Suite' } });
    fireEvent.change(baseInput, { target: { value: '12500' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) => u === '/api/travel/cost-master' && o?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.baseRate).toBe(12500);
      expect(body.routeOrSku).toBe('Madinah:Pullman:Suite');
      expect(body.currency).toBe('INR');
    });
    expect(notifySuccess).toHaveBeenCalledWith('Rate added');
  });

  it('validation: empty routeOrSku surfaces notify.error, no POST', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fireEvent.click(screen.getByRole('button', { name: /Add rate/i }));
    fireEvent.change(screen.getByPlaceholderText(/22000/i), { target: { value: '1000' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/routeOrSku and baseRate required/i));
    });
    expect(fetchApiMock.mock.calls.filter(([u, o]) => u === '/api/travel/cost-master' && o?.method === 'POST')).toHaveLength(0);
  });
});

// ── 11. Toggle-active ─────────────────────────────────────────────────────────
describe('<CostMaster /> — toggle-active', () => {
  it('clicking pill toggle PATCHes /:id with { isActive: false } when row was active', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Toggle active for Makkah:Hilton:Deluxe/i }));
    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(([u, o]) => u === '/api/travel/cost-master/301' && o?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch[1].body).isActive).toBe(false);
    });
  });
});

// ── 12-13. Inline edit ────────────────────────────────────────────────────────
describe('<CostMaster /> — inline edit', () => {
  it('pencil → edit row pre-filled → save PATCHes with updated values', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fireEvent.click(screen.getByRole('button', { name: /Edit rate Makkah:Hilton:Deluxe/i }));
    const routeInput = screen.getByLabelText(/Edit route or SKU/i);
    expect(routeInput.value).toBe('Makkah:Hilton:Deluxe');
    fireEvent.change(routeInput, { target: { value: 'Makkah:Hilton:Suite' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Save changes for Makkah:Hilton:Deluxe/i }));
    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(([u, o]) => u === '/api/travel/cost-master/301' && o?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch[1].body).routeOrSku).toBe('Makkah:Hilton:Suite');
    });
    expect(notifySuccess).toHaveBeenCalledWith('Rate updated');
  });

  it('cancel edit → read row restored, no PATCH', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fireEvent.click(screen.getByRole('button', { name: /Edit rate Makkah:Hilton:Deluxe/i }));
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Cancel edit/i }));
    expect(screen.queryByLabelText(/Edit route or SKU/i)).toBeNull();
    expect(screen.getByText('Makkah:Hilton:Deluxe')).toBeInTheDocument();
    expect(fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'PATCH')).toHaveLength(0);
  });
});

// ── 14-15. Delete ─────────────────────────────────────────────────────────────
describe('<CostMaster /> — delete', () => {
  it('trash → confirm → DELETE → row removed from DOM', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fetchApiMock.mockClear();
    installFetchMock({ list: { rates: [RATES_DEFAULT[1], RATES_DEFAULT[2]] } });
    fireEvent.click(screen.getByRole('button', { name: /Delete rate Makkah:Hilton:Deluxe/i }));
    await waitFor(() => expect(notifyConfirm).toHaveBeenCalledWith(expect.stringContaining('Makkah:Hilton:Deluxe')));
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(([u, o]) => u === '/api/travel/cost-master/301' && o?.method === 'DELETE');
      expect(del).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith('Rate deleted');
    await waitFor(() => expect(screen.queryByText('Makkah:Hilton:Deluxe')).toBeNull());
  });

  it('delete: confirm=false → no DELETE, row stays', async () => {
    notifyConfirm.mockResolvedValue(false);
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Delete rate Makkah:Hilton:Deluxe/i }));
    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    expect(fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'DELETE')).toHaveLength(0);
    expect(screen.getByText('Makkah:Hilton:Deluxe')).toBeInTheDocument();
  });
});
