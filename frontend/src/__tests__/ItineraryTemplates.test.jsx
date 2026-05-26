/**
 * ItineraryTemplates.test.jsx — vitest + RTL coverage for the Travel-vertical
 * Itinerary Template Library admin page
 * (frontend/src/pages/travel/ItineraryTemplates.jsx).
 *
 * #907 slice 7/N. Pins the page-surface invariants that consume the
 * ItineraryTemplate CRUD shipped in slice 6 (8972b8ca):
 *   GET    /api/travel/itinerary-templates?destinationName=&category=&subBrand=&isActive=&limit=&offset=
 *          → 200 { items, total, limit, offset }
 *   POST   /api/travel/itinerary-templates  body: { name(req), destinationName(req),
 *                                                    durationDays(req), ... }
 *   PATCH  /api/travel/itinerary-templates/:id
 *   DELETE /api/travel/itinerary-templates/:id  (soft-delete via isActive=false)
 *
 * Scope (10 cases):
 *   1. Page chrome: heading "Itinerary Template Library" + "Add template" CTA.
 *   2. GET on mount: hits /api/travel/itinerary-templates?... and renders one
 *      row per item.
 *   3. Empty list shows "No itinerary templates yet" empty state.
 *   4. Create flow: click "Add template" → fill required fields → submit
 *      "Create" → POST /api/travel/itinerary-templates called with payload →
 *      list re-fetched + notify.success surfaced.
 *   5. Validation: missing name → notify.error fired, NO POST.
 *   6. Validation: missing destinationName → notify.error fired, NO POST.
 *   7. Validation: missing durationDays → notify.error fired, NO POST.
 *   8. Edit flow: click Edit on a row → form populated → submit "Save changes"
 *      → PATCH /api/travel/itinerary-templates/:id called.
 *   9. Delete flow: click Delete → notify.confirm prompts → ack → DELETE
 *      /api/travel/itinerary-templates/:id → list re-fetched.
 *  10. Filter: change category → GET re-fires with ?category=… in the URL.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api.
 *   - useNotify stub at ../utils/notify (not ../hooks/useNotify — code reality
 *     per the verifying-gap-card-claims discipline; see SightseeingMaster.test
 *     for the precedent).
 *   - notifyObj is a STABLE module-level reference (Wave 11 cfb5789 / Wave 12
 *     f59e91d RTL standing rule — fresh per-call objects flap useCallback
 *     identity → infinite re-renders).
 *   - AuthContext consumed via real Provider. Default user role = ADMIN.
 *   - MemoryRouter wraps the SUT (the page renders a <Link to="/travel/
 *     sightseeing"> in the header copy).
 *   - All data-dependent assertions use await findBy / waitFor (per CLAUDE.md
 *     tick #108 cron-learning).
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
import ItineraryTemplates from '../pages/travel/ItineraryTemplates';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

function makeItem(overrides = {}) {
  return {
    id: 501,
    tenantId: 1,
    name: 'Makkah-Madinah 10-day Umrah',
    destinationName: 'Makkah + Madinah',
    durationDays: 10,
    description: 'Standard Umrah package with hotel + transfers.',
    thumbnailUrl: null,
    category: 'religious',
    subBrand: 'rfu',
    defaultMarkupPercent: 15,
    basePriceMinor: 12500000,
    currency: 'INR',
    templateJson: null,
    llmGeneratedBy: null,
    usageCount: 0,
    isActive: true,
    createdAt: '2026-05-26T10:00:00.000Z',
    updatedAt: '2026-05-26T10:00:00.000Z',
    ...overrides,
  };
}

const ITEMS_DEFAULT = [
  makeItem({
    id: 501,
    name: 'Makkah-Madinah 10-day Umrah',
    destinationName: 'Makkah + Madinah',
    durationDays: 10,
    category: 'religious',
    subBrand: 'rfu',
  }),
  makeItem({
    id: 502,
    name: 'Bali Family Holiday',
    destinationName: 'Bali',
    durationDays: 7,
    category: 'family',
    subBrand: 'travelstall',
    basePriceMinor: 9500000,
    defaultMarkupPercent: 12,
  }),
  makeItem({
    id: 503,
    name: 'Europe School Trip — 14 days',
    destinationName: 'London + Paris + Rome',
    durationDays: 14,
    category: 'school',
    subBrand: 'tmc',
    basePriceMinor: 25000000,
    defaultMarkupPercent: 8,
  }),
];

function installFetchMock({
  list = { items: ITEMS_DEFAULT, total: ITEMS_DEFAULT.length, limit: 20, offset: 0 },
  create = null,
  patch = null,
  del = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/travel/itinerary-templates?') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url === '/api/travel/itinerary-templates' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeItem({ id: 999 }));
    }
    if (/^\/api\/travel\/itinerary-templates\/\d+$/.test(url) && method === 'PATCH') {
      if (patch instanceof Error) return Promise.reject(patch);
      return Promise.resolve(patch || makeItem({ id: 501 }));
    }
    if (/^\/api\/travel\/itinerary-templates\/\d+$/.test(url) && method === 'DELETE') {
      if (del instanceof Error) return Promise.reject(del);
      return Promise.resolve(del || makeItem({ id: 501, isActive: false }));
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
        <ItineraryTemplates />
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

describe('<ItineraryTemplates /> — page chrome', () => {
  it('renders heading "Itinerary Template Library" + "Add template" CTA', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Itinerary Template Library/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Add template/i }),
    ).toBeInTheDocument();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([u]) =>
          typeof u === 'string' && u.startsWith('/api/travel/itinerary-templates'),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});

describe('<ItineraryTemplates /> — load + render lifecycle', () => {
  it('GETs /api/travel/itinerary-templates on mount and renders one row per item', async () => {
    renderPage();
    expect(await screen.findByText('Makkah-Madinah 10-day Umrah')).toBeInTheDocument();
    expect(screen.getByText('Bali Family Holiday')).toBeInTheDocument();
    expect(screen.getByText('Europe School Trip — 14 days')).toBeInTheDocument();
    const call = fetchApiMock.mock.calls.find(
      ([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/travel/itinerary-templates?')
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
      await screen.findByText(/No itinerary templates yet\. Add one above\./i),
    ).toBeInTheDocument();
  });
});

describe('<ItineraryTemplates /> — create flow', () => {
  it('clicking "Add template" reveals the form; filling required fields + Create POSTs payload', async () => {
    renderPage();
    await screen.findByText('Makkah-Madinah 10-day Umrah');
    expect(screen.queryByLabelText('name')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Add template/i }));

    fireEvent.change(screen.getByLabelText('name'), {
      target: { value: 'Goa Honeymoon — 5 nights' },
    });
    fireEvent.change(screen.getByLabelText('destinationName'), {
      target: { value: 'Goa' },
    });
    fireEvent.change(screen.getByLabelText('durationDays'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('basePriceMinor'), {
      target: { value: '4500000' },
    });
    fireEvent.change(screen.getByLabelText('defaultMarkupPercent'), {
      target: { value: '20' },
    });

    fetchApiMock.mockClear();
    installFetchMock();

    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/itinerary-templates' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.name).toBe('Goa Honeymoon — 5 nights');
      expect(body.destinationName).toBe('Goa');
      expect(body.durationDays).toBe(5);
      expect(body.basePriceMinor).toBe(4500000);
      expect(body.defaultMarkupPercent).toBe(20);
      expect(body.currency).toBe('INR');
    });
    expect(notifySuccess).toHaveBeenCalledWith('Itinerary template added');

    // List re-fetched after create.
    await waitFor(() => {
      const reList = fetchApiMock.mock.calls.filter(
        ([u, o]) =>
          typeof u === 'string'
          && u.startsWith('/api/travel/itinerary-templates?')
          && (!o?.method || o.method === 'GET'),
      );
      expect(reList.length).toBeGreaterThan(0);
    });
  });
});

describe('<ItineraryTemplates /> — create validation', () => {
  it('missing name surfaces notify.error and does NOT POST', async () => {
    renderPage();
    await screen.findByText('Makkah-Madinah 10-day Umrah');
    fireEvent.click(screen.getByRole('button', { name: /Add template/i }));
    fireEvent.change(screen.getByLabelText('destinationName'), {
      target: { value: 'Somewhere' },
    });
    fireEvent.change(screen.getByLabelText('durationDays'), { target: { value: '7' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/name is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/itinerary-templates' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('missing destinationName surfaces notify.error and does NOT POST', async () => {
    renderPage();
    await screen.findByText('Makkah-Madinah 10-day Umrah');
    fireEvent.click(screen.getByRole('button', { name: /Add template/i }));
    fireEvent.change(screen.getByLabelText('name'), {
      target: { value: 'Some Template' },
    });
    fireEvent.change(screen.getByLabelText('durationDays'), { target: { value: '7' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/destinationName is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/itinerary-templates' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('missing durationDays surfaces notify.error and does NOT POST', async () => {
    renderPage();
    await screen.findByText('Makkah-Madinah 10-day Umrah');
    fireEvent.click(screen.getByRole('button', { name: /Add template/i }));
    fireEvent.change(screen.getByLabelText('name'), {
      target: { value: 'Some Template' },
    });
    fireEvent.change(screen.getByLabelText('destinationName'), {
      target: { value: 'Somewhere' },
    });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/durationDays is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/itinerary-templates' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });
});

describe('<ItineraryTemplates /> — edit flow', () => {
  it('clicking Edit on a row populates the form; submit PATCHes /api/travel/itinerary-templates/:id', async () => {
    renderPage();
    const rowName = await screen.findByText('Makkah-Madinah 10-day Umrah');
    const tr = rowName.closest('tr');
    expect(tr).toBeTruthy();

    fireEvent.click(
      within(tr).getByRole('button', { name: /Edit Makkah-Madinah 10-day Umrah/i }),
    );

    // Form populated with row's values.
    const nameInput = screen.getByLabelText('name');
    expect(nameInput.value).toBe('Makkah-Madinah 10-day Umrah');
    const destInput = screen.getByLabelText('destinationName');
    expect(destInput.value).toBe('Makkah + Madinah');
    const durInput = screen.getByLabelText('durationDays');
    expect(durInput.value).toBe('10');

    // Edit name + submit "Save changes".
    fireEvent.change(nameInput, {
      target: { value: 'Makkah-Madinah 10-day Umrah (updated)' },
    });

    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          u === '/api/travel/itinerary-templates/501' && o?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch[1].body);
      expect(body.name).toBe('Makkah-Madinah 10-day Umrah (updated)');
      expect(body.destinationName).toBe('Makkah + Madinah');
      expect(body.durationDays).toBe(10);
    });
    expect(notifySuccess).toHaveBeenCalledWith('Itinerary template updated');
  });
});

describe('<ItineraryTemplates /> — delete flow', () => {
  it('clicking Delete on a row prompts notify.confirm + DELETEs /api/travel/itinerary-templates/:id', async () => {
    renderPage();
    const rowName = await screen.findByText('Makkah-Madinah 10-day Umrah');
    const tr = rowName.closest('tr');

    fetchApiMock.mockClear();
    installFetchMock();
    notifyConfirm.mockResolvedValueOnce(true);

    fireEvent.click(
      within(tr).getByRole('button', { name: /Delete Makkah-Madinah 10-day Umrah/i }),
    );

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          u === '/api/travel/itinerary-templates/501' && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith('Itinerary template removed');
  });
});

describe('<ItineraryTemplates /> — filter behaviour', () => {
  it('changing category filter re-fetches with ?category=… in the URL', async () => {
    renderPage();
    await screen.findByText('Makkah-Madinah 10-day Umrah');
    fetchApiMock.mockClear();
    installFetchMock({
      list: { items: [ITEMS_DEFAULT[0]], total: 1, limit: 20, offset: 0 },
    });

    fireEvent.change(screen.getByLabelText(/Category filter/i), {
      target: { value: 'religious' },
    });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          typeof u === 'string'
          && u.includes('category=religious')
          && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});
