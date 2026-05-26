/**
 * SightseeingMaster.test.jsx — vitest + RTL coverage for the Travel-vertical
 * Sightseeing-master admin page (frontend/src/pages/travel/SightseeingMaster.jsx).
 *
 * #907 slice 3/N. Pins the page-surface invariants that consume the
 * TravelSightseeing CRUD shipped in slice 2 (a8715895):
 *   GET    /api/travel/sightseeing?destinationName=&category=&isActive=&limit=&offset=
 *          → 200 { items, total, limit, offset }
 *   POST   /api/travel/sightseeing  body: { destinationName(req), name(req), ... }
 *   PATCH  /api/travel/sightseeing/:id
 *   DELETE /api/travel/sightseeing/:id  (soft-delete)
 *
 * Scope (10 cases):
 *   1. Page chrome: heading "Sightseeing Master" + "Add sightseeing" CTA.
 *   2. GET on mount: hits /api/travel/sightseeing?... and renders one row
 *      per item.
 *   3. Empty list shows "No sightseeing entries yet" empty state.
 *   4. Create flow: click "Add sightseeing" → fill destinationName + name →
 *      submit "Create" → POST /api/travel/sightseeing called with payload →
 *      list re-fetched + notify.success surfaced.
 *   5. Validation: missing destinationName → notify.error fired, NO POST.
 *   6. Validation: missing name → notify.error fired, NO POST.
 *   7. Edit flow: click Edit on a row → form populated with that row's
 *      values → submit → PATCH /api/travel/sightseeing/:id called.
 *   8. Delete flow: click Delete on a row → notify.confirm prompts → ack →
 *      DELETE /api/travel/sightseeing/:id → list re-fetched.
 *   9. Filter: change destination filter → GET re-fires with
 *      ?destinationName=… in the URL.
 *  10. Filter: untick "Active only" → GET re-fires with ?isActive=false.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - useNotify stub at ../utils/notify — CostMaster.jsx imports notify from
 *     ../utils/notify, NOT ../hooks/useNotify (the slice-3 prompt's
 *     reference was drift; mirroring code reality per the
 *     verifying-gap-card-claims discipline).
 *   - notifyObj is a STABLE module-level reference (Wave 11 cfb5789 / Wave
 *     12 f59e91d RTL standing rule — fresh per-call objects flap useCallback
 *     identity → infinite re-renders).
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

describe('<SightseeingMaster /> — page chrome', () => {
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

describe('<SightseeingMaster /> — load + render lifecycle', () => {
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

describe('<SightseeingMaster /> — create flow', () => {
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
    fireEvent.change(screen.getByLabelText('priceReferenceMinor'), { target: { value: '25000' } });

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

describe('<SightseeingMaster /> — create validation', () => {
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

describe('<SightseeingMaster /> — edit flow', () => {
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

describe('<SightseeingMaster /> — delete flow', () => {
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

describe('<SightseeingMaster /> — filter behaviour', () => {
  it('typing in destination filter re-fetches with ?destinationName=… in the URL', async () => {
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
});
