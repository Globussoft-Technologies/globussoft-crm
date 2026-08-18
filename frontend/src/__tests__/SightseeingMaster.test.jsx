/**
 * SightseeingMaster.test.jsx â€” vitest + RTL coverage for the Travel-vertical
 * Sightseeing-master admin page (frontend/src/pages/travel/SightseeingMaster.jsx).
 *
 * #907 slice 3/N. Pins the page-surface invariants that consume the
 * TravelSightseeing CRUD shipped in slice 2 (a8715895):
 *   GET    /api/travel/sightseeing?destinationName=&category=&isActive=&limit=&offset=
 *          â†’ 200 { items, total, limit, offset }
 *   POST   /api/travel/sightseeing  body: { destinationName(req), name(req), ... }
 *   PATCH  /api/travel/sightseeing/:id
 *   DELETE /api/travel/sightseeing/:id  (soft-delete)
 *
 * Scope (10 cases):
 *   1. Page chrome: heading "Sightseeing Master" + "Add sightseeing" CTA.
 *   2. GET on mount: hits /api/travel/sightseeing?... and renders one row
 *      per item.
 *   3. Empty list shows "No sightseeing entries yet" empty state.
 *   4. Create flow: click "Add sightseeing" â†’ fill destinationName + name â†’
 *      submit "Create" â†’ POST /api/travel/sightseeing called with payload â†’
 *      list re-fetched + notify.success surfaced.
 *   5. Validation: missing destinationName â†’ notify.error fired, NO POST.
 *   6. Validation: missing name â†’ notify.error fired, NO POST.
 *   7. Edit flow: click Edit on a row â†’ form populated with that row's
 *      values â†’ submit â†’ PATCH /api/travel/sightseeing/:id called.
 *   8. Delete flow: click Delete on a row â†’ notify.confirm prompts â†’ ack â†’
 *      DELETE /api/travel/sightseeing/:id â†’ list re-fetched.
 *   9. Filter: change destination filter â†’ GET re-fires with
 *      ?destinationName=â€¦ in the URL.
 *  10. Filter: untick "Active only" â†’ GET re-fires with ?isActive=false.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - useNotify stub at ../utils/notify â€” CostMaster.jsx imports notify from
 *     ../utils/notify, NOT ../hooks/useNotify (the slice-3 prompt's
 *     reference was drift; mirroring code reality per the
 *     verifying-gap-card-claims discipline).
 *   - notifyObj is a STABLE module-level reference (Wave 11 cfb5789 / Wave
 *     12 f59e91d RTL standing rule â€” fresh per-call objects flap useCallback
 *     identity â†’ infinite re-renders).
 *   - AuthContext consumed via real Provider. Default user role = ADMIN.
 *   - MemoryRouter wraps the SUT (the page renders a <Link to="/travel/
 *     cost-master"> in the header copy).
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
  getActiveTenantId: () => 1,
}));

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

import { AuthContext } from '../App';
import SightseeingMaster from '../pages/travel/SightseeingMaster';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

function makeItem(overrides = {}) {
  return {
    id: 401,
    tenantId: 1,
    destinationName: 'Makkah',
    name: 'Masjid al-Haram',
    description: 'The holiest mosque in Islam.',
    imageUrl: null,
    durationMinutes: 120,
    priceReferenceMinor: null,
    currency: null,
    category: 'religious',
    subBrand: 'rfu',
    notes: null,
    isActive: true,
    createdAt: '2026-05-20T10:00:00.000Z',
    updatedAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const ITEMS_DEFAULT = [
  makeItem({ id: 401, destinationName: 'Makkah', name: 'Masjid al-Haram', category: 'religious' }),
  makeItem({ id: 402, destinationName: 'Madinah', name: 'Masjid an-Nabawi', category: 'religious', priceReferenceMinor: 0, currency: 'SAR' }),
  makeItem({ id: 403, destinationName: 'Agra', name: 'Taj Mahal', category: 'monument', subBrand: 'travelstall', priceReferenceMinor: 110000, currency: 'INR', durationMinutes: 180 }),
];

function installFetchMock({
  list = { items: ITEMS_DEFAULT, total: ITEMS_DEFAULT.length, limit: 20, offset: 0 },
  create = null,
  patch = null,
  del = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/travel/sightseeing?') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url === '/api/travel/sightseeing' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeItem({ id: 999 }));
    }
    if (/^\/api\/travel\/sightseeing\/\d+$/.test(url) && method === 'PATCH') {
      if (patch instanceof Error) return Promise.reject(patch);
      return Promise.resolve(patch || makeItem({ id: 401 }));
    }
    if (/^\/api\/travel\/sightseeing\/\d+$/.test(url) && method === 'DELETE') {
      if (del instanceof Error) return Promise.reject(del);
      return Promise.resolve(del || makeItem({ id: 401, isActive: false }));
    }
    return Promise.resolve(null);
  });
}

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
        <SightseeingMaster />
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<SightseeingMaster /> â€” page chrome', () => {
  it('renders heading "Sightseeing Master" + "Add sightseeing" CTA', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Sightseeing Master/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Add sightseeing/i }),
    ).toBeInTheDocument();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([u]) => typeof u === 'string' && u.startsWith('/api/travel/sightseeing'),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});

describe('<SightseeingMaster /> â€” load + render lifecycle', () => {
  it('GETs /api/travel/sightseeing on mount and renders one row per item', async () => {
    renderPage();
    expect(await screen.findByText('Masjid al-Haram')).toBeInTheDocument();
    expect(screen.getByText('Masjid an-Nabawi')).toBeInTheDocument();
    expect(screen.getByText('Taj Mahal')).toBeInTheDocument();
    const call = fetchApiMock.mock.calls.find(
      ([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/travel/sightseeing?')
        && (!o?.method || o.method === 'GET'),
    );
    expect(call).toBeTruthy();
    expect(call[0]).toMatch(/limit=20/);
    expect(call[0]).toMatch(/offset=0/);
  });

  it('renders empty state when API returns items:[]', async () => {
    installFetchMock({ list: { items: [], total: 0, limit: 20, offset: 0 } });
    renderPage();
    expect(
      await screen.findByText(/No sightseeing entries yet\. Add one above\./i),
    ).toBeInTheDocument();
  });
});

describe('<SightseeingMaster /> â€” create flow', () => {
  it('clicking "Add sightseeing" reveals the form; filling required fields + Create POSTs payload', async () => {
    renderPage();
    await screen.findByText('Masjid al-Haram');
    expect(screen.queryByLabelText('destinationName')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Add sightseeing/i }));

    const destInput = screen.getByLabelText('destinationName');
    const nameInput = screen.getByLabelText('name');
    fireEvent.change(destInput, { target: { value: 'Jeddah' } });
    fireEvent.change(nameInput, { target: { value: 'Al-Balad' } });
    fireEvent.change(screen.getByLabelText('durationMinutes'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('priceReferenceMinor'), { target: { value: '250' } });

    fetchApiMock.mockClear();
    installFetchMock();

    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/sightseeing' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.destinationName).toBe('Jeddah');
      expect(body.name).toBe('Al-Balad');
      expect(body.durationMinutes).toBe(90);
      expect(body.priceReferenceMinor).toBe(25000);
      expect(body.currency).toBe('INR');
    });
    expect(notifySuccess).toHaveBeenCalledWith('Sightseeing entry added');

    // List re-fetched after create.
    await waitFor(() => {
      const reList = fetchApiMock.mock.calls.filter(
        ([u, o]) =>
          typeof u === 'string'
          && u.startsWith('/api/travel/sightseeing?')
          && (!o?.method || o.method === 'GET'),
      );
      expect(reList.length).toBeGreaterThan(0);
    });
  });
});

describe('<SightseeingMaster /> â€” create validation', () => {
  it('missing destinationName surfaces notify.error and does NOT POST', async () => {
    renderPage();
    await screen.findByText('Masjid al-Haram');
    fireEvent.click(screen.getByRole('button', { name: /Add sightseeing/i }));
    // Only fill name.
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Some POI' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/destinationName is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/sightseeing' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('missing name surfaces notify.error and does NOT POST', async () => {
    renderPage();
    await screen.findByText('Masjid al-Haram');
    fireEvent.click(screen.getByRole('button', { name: /Add sightseeing/i }));
    fireEvent.change(screen.getByLabelText('destinationName'), {
      target: { value: 'Somewhere' },
    });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/name is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/sightseeing' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });
});

describe('<SightseeingMaster /> â€” edit flow', () => {
  it('clicking Edit on a row populates the form; submit PATCHes /api/travel/sightseeing/:id', async () => {
    renderPage();
    const rowName = await screen.findByText('Masjid al-Haram');
    const tr = rowName.closest('tr');
    expect(tr).toBeTruthy();

    fireEvent.click(within(tr).getByRole('button', { name: /Edit Masjid al-Haram/i }));

    // Form populated with row's destinationName.
    const destInput = screen.getByLabelText('destinationName');
    expect(destInput.value).toBe('Makkah');
    const nameInput = screen.getByLabelText('name');
    expect(nameInput.value).toBe('Masjid al-Haram');

    // Edit name + submit "Save changes".
    fireEvent.change(nameInput, { target: { value: 'Masjid al-Haram (updated)' } });

    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          u === '/api/travel/sightseeing/401' && o?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch[1].body);
      expect(body.name).toBe('Masjid al-Haram (updated)');
      expect(body.destinationName).toBe('Makkah');
    });
    expect(notifySuccess).toHaveBeenCalledWith('Sightseeing entry updated');
  });
});

describe('<SightseeingMaster /> â€” delete flow', () => {
  it('clicking Delete on a row prompts notify.confirm + DELETEs /api/travel/sightseeing/:id', async () => {
    renderPage();
    const rowName = await screen.findByText('Masjid al-Haram');
    const tr = rowName.closest('tr');

    fetchApiMock.mockClear();
    installFetchMock();
    notifyConfirm.mockResolvedValueOnce(true);

    fireEvent.click(within(tr).getByRole('button', { name: /Delete Masjid al-Haram/i }));

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          u === '/api/travel/sightseeing/401' && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith('Sightseeing entry removed');
  });
});

describe('<SightseeingMaster /> â€” filter behaviour', () => {
  it('typing in destination filter re-fetches with ?destinationName=â€¦ in the URL', async () => {
    renderPage();
    await screen.findByText('Masjid al-Haram');
    fetchApiMock.mockClear();
    installFetchMock({ list: { items: [ITEMS_DEFAULT[0]], total: 1, limit: 20, offset: 0 } });

    fireEvent.change(screen.getByLabelText(/Destination filter/i), {
      target: { value: 'Makkah' },
    });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          typeof u === 'string'
          && u.includes('destinationName=Makkah')
          && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('unticking "Active only" re-fetches with ?isActive=false', async () => {
    renderPage();
    await screen.findByText('Masjid al-Haram');
    fetchApiMock.mockClear();
    installFetchMock({ list: { items: [], total: 0, limit: 20, offset: 0 } });

    const activeToggle = screen.getByLabelText(/Active only/i);
    fireEvent.click(activeToggle); // un-check

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          typeof u === 'string'
          && u.includes('isActive=false')
          && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('changing category filter re-fetches with ?category=monument', async () => {
    renderPage();
    await screen.findByText('Masjid al-Haram');
    fetchApiMock.mockClear();
    installFetchMock({ list: { items: [ITEMS_DEFAULT[2]], total: 1, limit: 20, offset: 0 } });

    fireEvent.change(screen.getByLabelText(/Category filter/i), {
      target: { value: 'monument' },
    });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          typeof u === 'string'
          && u.includes('category=monument')
          && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<SightseeingMaster /> â€” currency & duration formatting', () => {
  it('formats INR price as ₹ + locale-grouped major units (priceReferenceMinor / 100)', async () => {
    installFetchMock({
      list: {
        items: [
          makeItem({
            id: 501,
            destinationName: 'Agra',
            name: 'Taj Mahal',
            priceReferenceMinor: 110000, // ₹1,100
            currency: 'INR',
          }),
        ],
        total: 1,
        limit: 20,
        offset: 0,
      },
    });
    renderPage();
    const row = (await screen.findByText('Taj Mahal')).closest('tr');
    expect(row).toBeTruthy();
    // ₹1,100 — assert ₹ + the locale-grouped 1,100 substring (don't bind to NBSP / Indian-grouping).
    expect(within(row).getByText(/₹.*1[,.]?100/)).toBeInTheDocument();
  });

  it('formats USD ($), EUR (€), and unknown 3-letter currency (prefix + space)', async () => {
    installFetchMock({
      list: {
        items: [
          makeItem({ id: 601, destinationName: 'NYC', name: 'Statue of Liberty', priceReferenceMinor: 2500, currency: 'USD' }),
          makeItem({ id: 602, destinationName: 'Paris', name: 'Eiffel Tower', priceReferenceMinor: 1700, currency: 'EUR' }),
          makeItem({ id: 603, destinationName: 'Riyadh', name: 'Kingdom Tower', priceReferenceMinor: 8000, currency: 'SAR' }),
        ],
        total: 3,
        limit: 20,
        offset: 0,
      },
    });
    renderPage();
    const usdRow = (await screen.findByText('Statue of Liberty')).closest('tr');
    expect(within(usdRow).getByText(/\$25/)).toBeInTheDocument();
    const eurRow = screen.getByText('Eiffel Tower').closest('tr');
    expect(within(eurRow).getByText(/€17/)).toBeInTheDocument();
    // Unknown currency renders as "<CUR> <amount>".
    const sarRow = screen.getByText('Kingdom Tower').closest('tr');
    expect(within(sarRow).getByText(/SAR\s?80/)).toBeInTheDocument();
  });

  it('renders em-dash for null priceReferenceMinor (price absent)', async () => {
    installFetchMock({
      list: {
        items: [
          makeItem({
            id: 701,
            destinationName: 'Petra',
            name: 'Treasury',
            priceReferenceMinor: null,
            currency: null,
            durationMinutes: 120,
          }),
        ],
        total: 1,
        limit: 20,
        offset: 0,
      },
    });
    renderPage();
    const row = (await screen.findByText('Treasury')).closest('tr');
    // Price-ref cell is the 5th td (index 4): Destination | POI name | Category | Duration | Price ref. | â€¦
    const tds = within(row).getAllByRole('cell');
    expect(tds[4].textContent.trim()).toBe('—');
  });

  it('formats duration: < 60min as "Xm", exact hours as "Xh", mixed as "Xh Ym"; null → "—"', async () => {
    installFetchMock({
      list: {
        items: [
          makeItem({ id: 801, destinationName: 'D1', name: 'Quickie', durationMinutes: 30, priceReferenceMinor: null, currency: null }),
          makeItem({ id: 802, destinationName: 'D2', name: 'TwoHourTour', durationMinutes: 120, priceReferenceMinor: null, currency: null }),
          makeItem({ id: 803, destinationName: 'D3', name: 'MixedTour', durationMinutes: 195, priceReferenceMinor: null, currency: null }),
          makeItem({ id: 804, destinationName: 'D4', name: 'UnknownDur', durationMinutes: null, priceReferenceMinor: null, currency: null }),
        ],
        total: 4,
        limit: 20,
        offset: 0,
      },
    });
    renderPage();
    const r1 = (await screen.findByText('Quickie')).closest('tr');
    expect(within(r1).getByText('30m')).toBeInTheDocument();
    const r2 = screen.getByText('TwoHourTour').closest('tr');
    expect(within(r2).getByText('2h')).toBeInTheDocument();
    const r3 = screen.getByText('MixedTour').closest('tr');
    expect(within(r3).getByText('3h 15m')).toBeInTheDocument();
    const r4 = screen.getByText('UnknownDur').closest('tr');
    // Duration cell is the 4th td (index 3).
    const r4Tds = within(r4).getAllByRole('cell');
    expect(r4Tds[3].textContent.trim()).toBe('—');
  });
});

describe('<SightseeingMaster /> â€” sub-brand badge + description', () => {
  it('renders the subBrand as a badge when set; renders "tenant" placeholder when null', async () => {
    installFetchMock({
      list: {
        items: [
          makeItem({ id: 901, destinationName: 'D1', name: 'BrandedPOI', subBrand: 'rfu' }),
          makeItem({ id: 902, destinationName: 'D2', name: 'TenantPOI', subBrand: null }),
        ],
        total: 2,
        limit: 20,
        offset: 0,
      },
    });
    renderPage();
    const branded = (await screen.findByText('BrandedPOI')).closest('tr');
    // Badge uppercases via CSS (`textTransform: 'uppercase'`); DOM text retains the raw lowercase value.
    expect(within(branded).getByText('rfu')).toBeInTheDocument();
    const tenantRow = screen.getByText('TenantPOI').closest('tr');
    expect(within(tenantRow).getByText('tenant')).toBeInTheDocument();
  });

  it('renders the description blurb under the POI name when present (truncated via CSS)', async () => {
    const longDesc = 'A very long blurb describing this point of interest in marketing copy.';
    installFetchMock({
      list: {
        items: [makeItem({ id: 1001, name: 'BlurbPOI', description: longDesc })],
        total: 1,
        limit: 20,
        offset: 0,
      },
    });
    renderPage();
    expect(await screen.findByText('BlurbPOI')).toBeInTheDocument();
    // Description text is in the DOM (CSS handles the ellipsis truncation).
    expect(screen.getByText(longDesc)).toBeInTheDocument();
  });
});

describe('<SightseeingMaster /> â€” pagination edge cases', () => {
  it('shows "No results" range copy when total=0', async () => {
    installFetchMock({ list: { items: [], total: 0, limit: 20, offset: 0 } });
    renderPage();
    expect(
      await screen.findByText(/No sightseeing entries yet\. Add one above\./i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Previous page/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Next page/i })).toBeNull();
  });

  it('shows loaded-count range copy when total is within the first page', async () => {
    installFetchMock({
      list: { items: ITEMS_DEFAULT, total: ITEMS_DEFAULT.length, limit: 20, offset: 0 },
    });
    renderPage();
    await screen.findByText('Masjid al-Haram');
    expect(document.body.textContent).toContain('of 3 sightseeing entries');
    expect(screen.getByRole('button', { name: /Previous page/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Next page/i })).toBeDisabled();
  });

  it('clicking Next loads the next page', async () => {
    // 25 items total, first page has 20, second page has 5.
    const page1 = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: 2000 + i, destinationName: `D${i}`, name: `POI${i}`, durationMinutes: 30, priceReferenceMinor: null, currency: null }),
    );
    const page2 = Array.from({ length: 5 }, (_, i) =>
      makeItem({ id: 3000 + i, destinationName: `D${20 + i}`, name: `POI${20 + i}`, durationMinutes: 30, priceReferenceMinor: null, currency: null }),
    );
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/sightseeing?') && method === 'GET') {
        return Promise.resolve(url.includes('offset=20')
          ? { items: page2, total: 25, limit: 20, offset: 20 }
          : { items: page1, total: 25, limit: 20, offset: 0 });
      }
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('POI0')).toBeInTheDocument();
    expect(document.body.textContent).toContain('of 25 sightseeing entries');

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Next page/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          typeof u === 'string'
          && u.startsWith('/api/travel/sightseeing?')
          && u.includes('offset=20')
          && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
    expect(await screen.findByText('POI24')).toBeInTheDocument();
    expect(document.body.textContent).toContain('21');
    expect(document.body.textContent).toContain('25');
    expect(document.body.textContent).toContain('sightseeing entries');
  });
});

describe('<SightseeingMaster /> â€” form interaction & error surfaces', () => {
  it('Cancel button closes the form (destinationName label no longer rendered)', async () => {
    renderPage();
    await screen.findByText('Masjid al-Haram');
    fireEvent.click(screen.getByRole('button', { name: /Add sightseeing/i }));
    // Form open: label exists.
    expect(screen.getByLabelText('destinationName')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    // Form closed.
    expect(screen.queryByLabelText('destinationName')).toBeNull();
  });

  it('Currency input is forced to uppercase on each change', async () => {
    renderPage();
    await screen.findByText('Masjid al-Haram');
    fireEvent.click(screen.getByRole('button', { name: /Add sightseeing/i }));
    const cur = screen.getByLabelText('currency');
    expect(cur.value).toBe('INR'); // default
    fireEvent.change(cur, { target: { value: 'usd' } });
    expect(cur.value).toBe('USD');
    fireEvent.change(cur, { target: { value: 'EuR' } });
    expect(cur.value).toBe('EUR');
  });

  it('list-fetch rejection surfaces notify.error and renders empty state', async () => {
    const err = Object.assign(new Error('boom'), { body: { error: 'Listing blew up' } });
    installFetchMock({ list: err });
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Listing blew up');
    });
    // Items reset to [] â†’ empty-state copy renders.
    expect(
      await screen.findByText(/No sightseeing entries yet\. Add one above\./i),
    ).toBeInTheDocument();
  });

  it('create-POST rejection surfaces notify.error with the server body.error message', async () => {
    renderPage();
    await screen.findByText('Masjid al-Haram');
    fireEvent.click(screen.getByRole('button', { name: /Add sightseeing/i }));
    fireEvent.change(screen.getByLabelText('destinationName'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Y' } });

    fetchApiMock.mockClear();
    const err = Object.assign(new Error('400'), { body: { error: 'INVALID_CURRENCY' } });
    installFetchMock({ create: err });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('INVALID_CURRENCY');
    });
    // Form stays open on error (editingId still null, but form not reset).
    expect(screen.getByLabelText('destinationName')).toBeInTheDocument();
  });
});

describe('<SightseeingMaster /> — template + import actions', () => {
  it('renders CSV/Excel template actions and import control in the header', async () => {
    renderPage();
    await screen.findByText('Masjid al-Haram');
    expect(screen.getByRole('button', { name: /CSV template/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Excel template/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import CSV\/Excel/i })).toBeInTheDocument();
  });

  it('uploading a CSV file POSTs to /api/travel/sightseeing/import.csv and shows the summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total: 1, imported: 1, updated: 0, skipped: 0, errors: [] }),
    });
    const prevFetch = global.fetch;
    global.fetch = fetchMock;
    try {
      renderPage();
      await screen.findByText('Masjid al-Haram');
      const fileInput = screen.getByLabelText(/Upload sightseeing CSV or Excel file/i);
      const file = new File(['destinationName,name\nMakkah,Masjid al-Haram'], 'sightseeing.csv', { type: 'text/csv' });
      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/travel/sightseeing/import.csv',
          expect.objectContaining({ method: 'POST' }),
        );
      });
      expect(notifySuccess).toHaveBeenCalledWith('Imported 1, updated 0, skipped 0');
      expect(await screen.findByText(/Imported 1, updated 0, skipped 0 of 1 rows\./i)).toBeInTheDocument();
    } finally {
      global.fetch = prevFetch;
    }
  });
});
