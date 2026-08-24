/**
 * TmcCatalogueAdmin.test.jsx — vitest + RTL coverage for the TMC catalogue
 * admin page (frontend/src/pages/travel/TmcCatalogueAdmin.jsx).
 *
 * PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md §10 row T16. Pins the page's
 * surface contract against backend/routes/travel_tmc_catalogue.js (T5):
 *
 *   GET    /api/travel-tmc-catalogue?status=active|archived&limit=&offset= → list
 *   POST   /api/travel-tmc-catalogue            → create (always lands archived)
 *   PATCH  /api/travel-tmc-catalogue/:id        → update
 *   DELETE /api/travel-tmc-catalogue/:id        → soft-archive
 *   POST   /api/travel-tmc-catalogue/:id/promote-to-active (ADMIN-only)
 *
 * Scope:
 *   1. Initial render hits Active tab and renders one card per row.
 *   2. Switching to Archived tab → GET re-fires with ?status=archived.
 *   3. Empty state copy differs between Active and Archived.
 *   4. Promote-to-active button visible only on ARCHIVED rows for ADMIN.
 *   5. Promote-to-active hidden / replaced with "ADMIN-only" copy for MANAGER.
 *   6. Promote click → POST fires; row drops from the list locally.
 *   7. Promote rejection → notify.error fires; row stays.
 *   8. Create button opens modal.
 *   9. Create submit → POST fires + notify.info surfaces the human-verify gate
 *      + page switches to Archived tab.
 *  10. Edit button opens modal pre-populated; submit → PATCH fires.
 *  11. Delete button → confirm dialog → DELETE fires (soft-archive).
 *  12. Theme awareness — body[data-vertical="travel"] does not break render.
 *  13. Required-field validation: empty tripId surfaces notify.error + no POST.
 *  14. MANAGER cannot see "Add catalogue entry" CTA.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep).
 *   - useNotify stub at ../utils/notify — STABLE module-level reference per
 *     2026-05-09 RTL standing rule (fresh per-call objects flap useCallback
 *     identity → infinite re-renders).
 *   - AuthContext consumed via real Provider; per-test default = ADMIN.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
const rawFetchMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

vi.stubGlobal('fetch', (...args) => rawFetchMock(...args));

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
import TmcCatalogueAdmin from '../pages/travel/TmcCatalogueAdmin';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'admin@x.com', role: 'ADMIN' };
const MANAGER_USER = { userId: 2, name: 'Mgr', email: 'mgr@x.com', role: 'MANAGER' };
const REGULAR_USER = { userId: 3, name: 'User', email: 'user@x.com', role: 'USER' };
const OWNER_USER = { userId: 4, name: 'Owner', email: 'owner@x.com', role: 'OWNER' };

function makeRow(overrides = {}) {
  return {
    id: 101,
    tenantId: 1,
    tripId: 'golden-triangle',
    title: 'Golden Triangle Heritage Trail',
    tagline: 'A 6-day immersion across Delhi-Agra-Jaipur',
    tier: 'domestic',
    region: 'North India',
    durationDays: 6,
    durationNights: 5,
    minGradeBand: 'grade-6',
    maxGradeBand: 'grade-10',
    boardsSupportedJson: '["CBSE","ICSE","IGCSE"]',
    minGroupSize: 20,
    priceBand: 'mid',
    indicativePricePerStudent: 35000,
    primaryOutcomesJson: '["global_awareness","leadership"]',
    skillsDevelopedJson: '["communication"]',
    subjectsTouchedJson: '["History","Civics"]',
    anchorExperiencesJson: '[{"name":"Taj Mahal sunrise"}]',
    curriculumHooksJson: '[{"board":"CBSE","topic":"Mughal Empire"}]',
    reportSkillBlurb: 'Builds historical empathy + cross-cultural fluency.',
    summaryForBrief: 'A flagship North India heritage trip.',
    imageUrl: null,
    status: 'active',
    createdAt: '2026-06-08T10:00:00.000Z',
    updatedAt: '2026-06-08T10:00:00.000Z',
    ...overrides,
  };
}

const ACTIVE_ROWS = [
  makeRow({ id: 101, tripId: 'golden-triangle', title: 'Golden Triangle Heritage Trail', status: 'active' }),
  makeRow({ id: 102, tripId: 'madhya-pradesh', title: 'Madhya Pradesh Wildlife Trail', tier: 'domestic', region: 'Central India', status: 'active' }),
];
const ARCHIVED_ROWS = [
  makeRow({ id: 201, tripId: 'usa-stem', title: 'USA STEM Immersion', tier: 'international', region: 'USA', status: 'archived' }),
  makeRow({ id: 202, tripId: 'europe-heritage', title: 'Europe Heritage Loop', tier: 'international', region: 'Europe', status: 'archived' }),
];

function installFetchMock({
  active = { catalogue: ACTIVE_ROWS, total: ACTIVE_ROWS.length, limit: 10, offset: 0 },
  archived = { catalogue: ARCHIVED_ROWS, total: ARCHIVED_ROWS.length, limit: 10, offset: 0 },
  create = null,
  patch = null,
  del = null,
  promote = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    const parsed = new URL(String(url), 'http://localhost');
    if (parsed.pathname === '/api/travel-tmc-catalogue' && method === 'GET' && parsed.searchParams.get('status') === 'active') {
      if (active instanceof Error) return Promise.reject(active);
      return Promise.resolve(active);
    }
    if (parsed.pathname === '/api/travel-tmc-catalogue' && method === 'GET' && parsed.searchParams.get('status') === 'archived') {
      if (archived instanceof Error) return Promise.reject(archived);
      return Promise.resolve(archived);
    }
    if (url === '/api/travel-tmc-catalogue' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeRow({ id: 999, status: 'archived' }));
    }
    if (/^\/api\/travel-tmc-catalogue\/\d+$/.test(url) && method === 'PATCH') {
      if (patch instanceof Error) return Promise.reject(patch);
      return Promise.resolve(patch || makeRow({ id: 101 }));
    }
    if (/^\/api\/travel-tmc-catalogue\/\d+$/.test(url) && method === 'DELETE') {
      if (del instanceof Error) return Promise.reject(del);
      return Promise.resolve(del || makeRow({ id: 101, status: 'archived' }));
    }
    if (/^\/api\/travel-tmc-catalogue\/\d+\/promote-to-active$/.test(url) && method === 'POST') {
      if (promote instanceof Error) return Promise.reject(promote);
      return Promise.resolve(promote || makeRow({ id: 201, status: 'active' }));
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
          tenant: { id: 1, defaultCurrency: 'INR', vertical: 'travel' },
          loading: false,
        }}
      >
        <TmcCatalogueAdmin />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  rawFetchMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  if (typeof window !== 'undefined' && window.URL) {
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:mock'),
    });
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  }
  installFetchMock();
  vi.stubGlobal('fetch', (...args) => rawFetchMock(...args));
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reset body data-vertical between tests so the theme-awareness test
  // can't bleed into siblings.
  if (typeof document !== 'undefined' && document.body) {
    delete document.body.dataset.vertical;
  }
});

describe('<TmcCatalogueAdmin /> — page chrome + initial load', () => {
  it('renders heading + GET hits Active tab + renders one card per active row', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /TMC Trip Catalogue/i }),
    ).toBeInTheDocument();
    expect(screen.getByTitle(/catalogue items/i)).toBeInTheDocument();

    expect(await screen.findByText('Golden Triangle Heritage Trail')).toBeInTheDocument();
    expect(screen.getByText('Madhya Pradesh Wildlife Trail')).toBeInTheDocument();

    const call = fetchApiMock.mock.calls.find(
      ([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/travel-tmc-catalogue?status=active&limit=10&offset=0')
        && (!o?.method || o.method === 'GET'),
    );
    expect(call).toBeTruthy();
  });
});

describe('<TmcCatalogueAdmin /> — tab switching', () => {
  it('clicking the Archived tab re-fires GET with ?status=archived', async () => {
    renderPage();
    await screen.findByText('Golden Triangle Heritage Trail');

    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('tab', { name: /Archived/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u]) =>
          typeof u === 'string'
          && u.startsWith('/api/travel-tmc-catalogue?status=archived&limit=10&offset=0'),
      );
      expect(call).toBeTruthy();
    });
    expect(await screen.findByText('USA STEM Immersion')).toBeInTheDocument();
    expect(screen.getByText('Europe Heritage Loop')).toBeInTheDocument();
  });
});

describe('<TmcCatalogueAdmin /> — empty states', () => {
  it('Active tab renders empty-state copy when API returns []', async () => {
    installFetchMock({ active: { catalogue: [], total: 0, limit: 10, offset: 0 } });
    renderPage();
    expect(
      await screen.findByText(/No active catalogue entries/i),
    ).toBeInTheDocument();
  });

  it('Archived tab renders empty-state copy when API returns []', async () => {
    installFetchMock({ archived: { catalogue: [], total: 0, limit: 10, offset: 0 } });
    renderPage();
    await screen.findByText('Golden Triangle Heritage Trail');
    fireEvent.click(screen.getByRole('tab', { name: /Archived/i }));
    expect(
      await screen.findByText(/No archived catalogue entries/i),
    ).toBeInTheDocument();
  });
});

describe('<TmcCatalogueAdmin /> — infinite scroll', () => {
  it('requests the next slice when the list container scrolls to the bottom', async () => {
    const activePage1 = Array.from({ length: 10 }, (_, idx) =>
      makeRow({
        id: 100 + idx,
        tripId: `active-trip-${idx + 1}`,
        title: `Active Trip ${idx + 1}`,
        status: 'active',
      }),
    );
    const activePage2 = [
      makeRow({
        id: 200,
        tripId: 'active-trip-11',
        title: 'Active Trip 11',
        status: 'active',
      }),
      makeRow({
        id: 201,
        tripId: 'active-trip-12',
        title: 'Active Trip 12',
        status: 'active',
      }),
    ];

    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      const parsed = new URL(String(url), 'http://localhost');
      if (parsed.pathname === '/api/travel-tmc-catalogue' && method === 'GET' && parsed.searchParams.get('status') === 'active') {
        const offset = Number(parsed.searchParams.get('offset') || 0);
        if (offset === 10) {
          return Promise.resolve({
            catalogue: activePage2,
            total: 12,
            limit: 10,
            offset: 10,
          });
        }
        return Promise.resolve({
          catalogue: activePage1,
          total: 12,
          limit: 10,
          offset: 0,
        });
      }
      if (parsed.pathname === '/api/travel-tmc-catalogue' && method === 'GET' && parsed.searchParams.get('status') === 'archived') {
        return Promise.resolve({
          catalogue: ARCHIVED_ROWS,
          total: ARCHIVED_ROWS.length,
          limit: 10,
          offset: 0,
        });
      }
      return Promise.resolve(null);
    });

    renderPage();
    expect(await screen.findByText('Active Trip 1')).toBeInTheDocument();

    const list = screen.getByRole('list', { name: /active catalogue entries/i });
    Object.defineProperties(list, {
      scrollTop: { value: 1000, writable: true, configurable: true },
      clientHeight: { value: 500, writable: true, configurable: true },
      scrollHeight: { value: 1400, writable: true, configurable: true },
    });
    fireEvent.scroll(list);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('status=active&limit=10&offset=10'),
      );
      expect(call).toBeTruthy();
    });
    expect(await screen.findByText('Active Trip 11')).toBeInTheDocument();
    expect(screen.getByText('Active Trip 12')).toBeInTheDocument();
  });
});

describe('<TmcCatalogueAdmin /> — promote-to-active visibility', () => {
  it('Promote-to-active button visible on archived rows for ADMIN', async () => {
    renderPage();
    await screen.findByText('Golden Triangle Heritage Trail');
    // Promote button NOT visible on Active tab.
    expect(
      screen.queryByRole('button', {
        name: /Promote Golden Triangle Heritage Trail to active/i,
      }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Archived/i }));
    expect(
      await screen.findByRole('button', { name: /Promote USA STEM Immersion to active/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Promote Europe Heritage Loop to active/i }),
    ).toBeInTheDocument();
  });

  it('Promote-to-active button visible on archived rows for OWNER', async () => {
    renderPage(OWNER_USER);
    await screen.findByText('Golden Triangle Heritage Trail');
    fireEvent.click(screen.getByRole('tab', { name: /Archived/i }));
    expect(
      await screen.findByRole('button', { name: /Promote USA STEM Immersion to active/i }),
    ).toBeInTheDocument();
  });

  it('Promote-to-active hidden for MANAGER; "ADMIN-only" copy surfaces instead', async () => {
    renderPage(MANAGER_USER);
    await screen.findByText('Golden Triangle Heritage Trail');
    fireEvent.click(screen.getByRole('tab', { name: /Archived/i }));
    await screen.findByText('USA STEM Immersion');

    expect(
      screen.queryByRole('button', { name: /Promote USA STEM Immersion to active/i }),
    ).toBeNull();
    // "ADMIN-only" placeholder appears for archived rows.
    const adminOnlyCopies = screen.getAllByText(/Promote-to-active is ADMIN-only/i);
    expect(adminOnlyCopies.length).toBeGreaterThanOrEqual(1);
  });
});

describe('<TmcCatalogueAdmin /> — promote-to-active behaviour', () => {
  it('clicking Promote fires POST /:id/promote-to-active + row drops from view', async () => {
    renderPage();
    await screen.findByText('Golden Triangle Heritage Trail');
    fireEvent.click(screen.getByRole('tab', { name: /Archived/i }));
    await screen.findByText('USA STEM Immersion');

    fetchApiMock.mockClear();
    installFetchMock();

    fireEvent.click(
      screen.getByRole('button', { name: /Promote USA STEM Immersion to active/i }),
    );

    await waitFor(() => {
      const promote = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          u === '/api/travel-tmc-catalogue/201/promote-to-active'
          && o?.method === 'POST',
      );
      expect(promote).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Promoted "USA STEM Immersion" to active/i),
    );
    // Row removed from list locally (the page slices it out so the user
    // can flip tabs to Active to see its new home).
    await waitFor(() => {
      expect(screen.queryByText('USA STEM Immersion')).toBeNull();
    });
  });

  it('promote rejection surfaces notify.error + row stays', async () => {
    const err = Object.assign(new Error('forbidden'), { body: { error: 'RBAC_DENIED' } });
    installFetchMock({ promote: err });
    renderPage();
    await screen.findByText('Golden Triangle Heritage Trail');
    fireEvent.click(screen.getByRole('tab', { name: /Archived/i }));
    await screen.findByText('USA STEM Immersion');

    fireEvent.click(
      screen.getByRole('button', { name: /Promote USA STEM Immersion to active/i }),
    );

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('RBAC_DENIED');
    });
    // Row still present.
    expect(screen.getByText('USA STEM Immersion')).toBeInTheDocument();
  });
});

describe('<TmcCatalogueAdmin /> — create flow', () => {
  it('clicking "Add catalogue entry" reveals modal; submit POSTs payload + surfaces human-verify gate copy', async () => {
    renderPage();
    await screen.findByText('Golden Triangle Heritage Trail');
    expect(screen.queryByLabelText('tripId')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Add catalogue entry/i }));

    fireEvent.change(screen.getByLabelText('tripId'), { target: { value: 'ladakh-leadership' } });
    fireEvent.change(screen.getByLabelText('title'), { target: { value: 'Ladakh Leadership Trek' } });
    fireEvent.change(screen.getByLabelText('tier'), { target: { value: 'domestic' } });
    fireEvent.change(screen.getByLabelText('durationDays'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('minGradeBand'), { target: { value: 'grade-9' } });
    fireEvent.change(screen.getByLabelText('maxGradeBand'), { target: { value: 'grade-12' } });
    fireEvent.change(screen.getByLabelText('minGroupSize'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('priceBand'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('boardsSupportedJson'), {
      target: { value: 'CBSE, IB' },
    });
    fireEvent.change(screen.getByLabelText('reportSkillBlurb'), {
      target: { value: 'Outdoor leadership + self-direction.' },
    });
    fireEvent.change(screen.getByLabelText('summaryForBrief'), {
      target: { value: 'High-altitude trek for senior students.' },
    });

    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel-tmc-catalogue' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.tripId).toBe('ladakh-leadership');
      expect(body.title).toBe('Ladakh Leadership Trek');
      expect(body.durationDays).toBe(7);
      expect(body.minGroupSize).toBe(15);
      // Comma-separated list field flattened to JSON array.
      expect(body.boardsSupportedJson).toEqual(['CBSE', 'IB']);
    });
    // Human-verify-gate copy is shown via notify.info.
    expect(notifyInfo).toHaveBeenCalledWith(
      expect.stringMatching(/human-verify gate.*Archived/i),
    );
  });
});

describe('<TmcCatalogueAdmin /> — required-field validation', () => {
  it('empty tripId surfaces notify.error + does NOT POST', async () => {
    renderPage();
    await screen.findByText('Golden Triangle Heritage Trail');
    fireEvent.click(screen.getByRole('button', { name: /Add catalogue entry/i }));
    // Fill everything EXCEPT tripId.
    fireEvent.change(screen.getByLabelText('title'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('tier'), { target: { value: 'domestic' } });
    fireEvent.change(screen.getByLabelText('durationDays'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('minGradeBand'), { target: { value: 'grade-6' } });
    fireEvent.change(screen.getByLabelText('maxGradeBand'), { target: { value: 'grade-10' } });
    fireEvent.change(screen.getByLabelText('minGroupSize'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('priceBand'), { target: { value: 'mid' } });
    fireEvent.change(screen.getByLabelText('reportSkillBlurb'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('summaryForBrief'), { target: { value: 'Y' } });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/tripId is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel-tmc-catalogue' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });
});

describe('<TmcCatalogueAdmin /> — edit flow', () => {
  it('Edit on a row pre-populates the form; submit PATCHes /:id', async () => {
    renderPage();
    await screen.findByText('Golden Triangle Heritage Trail');

    fireEvent.click(
      screen.getByRole('button', { name: /Edit Golden Triangle Heritage Trail/i }),
    );

    const titleInput = screen.getByLabelText('title');
    expect(titleInput.value).toBe('Golden Triangle Heritage Trail');
    const tripIdInput = screen.getByLabelText('tripId');
    expect(tripIdInput.value).toBe('golden-triangle');
    // The boardsSupportedJson stored as JSON-stringified array should be
    // re-rendered as a comma-separated authoring string.
    const boardsInput = screen.getByLabelText('boardsSupportedJson');
    expect(boardsInput.value).toMatch(/CBSE/);
    expect(boardsInput.value).toMatch(/ICSE/);

    fireEvent.change(titleInput, {
      target: { value: 'Golden Triangle Heritage Trail (revised)' },
    });

    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          u === '/api/travel-tmc-catalogue/101' && o?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch[1].body);
      expect(body.title).toBe('Golden Triangle Heritage Trail (revised)');
    });
    expect(notifySuccess).toHaveBeenCalledWith('Catalogue entry updated');
  });
});

describe('<TmcCatalogueAdmin /> — delete (soft-archive) flow', () => {
  it('Archive button on an Active row prompts confirm + DELETEs /:id', async () => {
    renderPage();
    await screen.findByText('Golden Triangle Heritage Trail');

    notifyConfirm.mockResolvedValueOnce(true);
    fetchApiMock.mockClear();
    installFetchMock();

    fireEvent.click(
      screen.getByRole('button', { name: /Archive Golden Triangle Heritage Trail/i }),
    );

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          u === '/api/travel-tmc-catalogue/101' && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith('Catalogue entry archived');
  });
});

describe('<TmcCatalogueAdmin /> — theme + role gating', () => {
  it('renders correctly under body[data-vertical="travel"] (no hardcoded blue)', async () => {
    if (typeof document !== 'undefined' && document.body) {
      document.body.dataset.vertical = 'travel';
    }
    renderPage();
    await screen.findByText('Golden Triangle Heritage Trail');
    // Heading exists; theme variables are inert in jsdom but assert no
    // crash + the body attribute round-trips.
    expect(document.body.dataset.vertical).toBe('travel');
    expect(
      screen.getByRole('heading', { name: /TMC Trip Catalogue/i }),
    ).toBeInTheDocument();
  });

  it('USER (read-only role) does NOT see "Add catalogue entry" CTA + cannot Edit / Archive', async () => {
    renderPage(REGULAR_USER);
    await screen.findByText('Golden Triangle Heritage Trail');
    expect(
      screen.queryByRole('button', { name: /Add catalogue entry/i }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Edit Golden Triangle Heritage Trail/i }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Archive Golden Triangle Heritage Trail/i }),
    ).toBeNull();
  });

  it('MANAGER sees the Add + Edit + Archive CTAs (backend allows CRUD) but NOT Promote-to-active on archived rows', async () => {
    renderPage(MANAGER_USER);
    await screen.findByText('Golden Triangle Heritage Trail');
    // CRUD CTAs present for MANAGER.
    expect(
      screen.getByRole('button', { name: /Add catalogue entry/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Edit Golden Triangle Heritage Trail/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Archive Golden Triangle Heritage Trail/i }),
    ).toBeInTheDocument();
    // Promote-to-active blocked for MANAGER on Archived tab.
    fireEvent.click(screen.getByRole('tab', { name: /Archived/i }));
    await screen.findByText('USA STEM Immersion');
    expect(
      screen.queryByRole('button', { name: /Promote USA STEM Immersion to active/i }),
    ).toBeNull();
  });

  it('OWNER sees admin catalogue controls that manage the recommendation set', async () => {
    renderPage(OWNER_USER);
    await screen.findByText('Golden Triangle Heritage Trail');

    expect(
      screen.getByRole('button', { name: /Add catalogue entry/i }),
    ).toBeInTheDocument();
    // TMC configuration panel is deliberately commented out in the SUT per
    // UI cleanup request (see TmcCatalogueAdmin.jsx ~line 657) — no longer
    // rendered for any role, so this assertion doesn't apply.
    expect(screen.getByTestId('tmc-catalogue-bulk-import')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Download CSV template/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Download XLSX template/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import file/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Edit Golden Triangle Heritage Trail/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Archive Golden Triangle Heritage Trail/i }),
    ).toBeInTheDocument();
  });
});


describe('<TmcCatalogueAdmin /> - bulk import template + ingest flow', () => {
  it('downloads the CSV template with bearer auth and triggers a file download', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    rawFetchMock.mockImplementation(async (url) => {
      if (String(url).includes('/api/travel-tmc-catalogue/import-template?format=csv')) {
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob(['tripId,title'], { type: 'text/csv' }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderPage();
    await screen.findByText('Golden Triangle Heritage Trail');

    fireEvent.click(screen.getByRole('button', { name: /Download CSV template/i }));

    await waitFor(() => {
      expect(rawFetchMock).toHaveBeenCalled();
    });

    const [url, opts] = rawFetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/travel-tmc-catalogue/import-template?format=csv');
    expect(opts?.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(clickSpy).toHaveBeenCalled();
    expect(window.URL.createObjectURL).toHaveBeenCalled();
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Downloaded CSV template/i));
  });

  it('opens the modal, uploads a spreadsheet, shows the ingest summary, and marks imported rows as pending review', async () => {
    installFetchMock({
      archived: {
        catalogue: [
          ...ARCHIVED_ROWS,
          makeRow({
            id: 303,
            tripId: 'andaman-sea-explorer',
            title: 'Andaman Sea Explorer',
            status: 'archived',
          }),
        ],
        total: ARCHIVED_ROWS.length + 1,
        limit: 10,
        offset: 0,
      },
    });

    rawFetchMock.mockImplementation(async (url, opts) => {
      if (String(url) === '/api/travel-tmc-catalogue/import') {
        const body = opts?.body;
        const entries = body ? Array.from(body.entries()) : [];
        return {
          ok: true,
          status: 200,
          json: async () => ({
            imported: 1,
            updated: 1,
            skipped: 0,
            total: 2,
            reviewLabel: 'AI-classified, pending review',
            createdTripIds: ['andaman-sea-explorer'],
            updatedTripIds: ['golden-triangle'],
            errors: [],
            _entries: entries,
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderPage();
    await screen.findByText('Golden Triangle Heritage Trail');
    expect(screen.queryByLabelText('Bulk import file')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Import file/i }));
    expect(await screen.findByTestId('tmc-catalogue-import-modal')).toBeInTheDocument();

    const file = new File(['tripId,title'], 'tmc-catalogue.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Bulk import file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm import/i }));

    await waitFor(() => {
      expect(rawFetchMock).toHaveBeenCalledWith(
        '/api/travel-tmc-catalogue/import',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const importCall = rawFetchMock.mock.calls.find(([url]) => String(url) === '/api/travel-tmc-catalogue/import');
    expect(importCall).toBeTruthy();
    const [, importOpts] = importCall;
    expect(importOpts?.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    const formEntries = Array.from(importOpts.body.entries());
    expect(formEntries[0][0]).toBe('file');
    expect(formEntries[0][1]).toBe(file);

    expect(await screen.findByTestId('tmc-catalogue-bulk-import-result')).toBeInTheDocument();
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/AI-classified, pending review: 1 new, 1 updated/i),
    );

    fireEvent.click(screen.getByRole('tab', { name: /Archived/i }));
    expect(await screen.findByText('Andaman Sea Explorer')).toBeInTheDocument();
    expect(
      screen.getByTestId('tmc-pending-review-andaman-sea-explorer'),
    ).toHaveTextContent(/AI-classified, pending review/i);
  });
});
