/**
 * FlyerTemplates.test.jsx — vitest + RTL coverage for the Travel-vertical
 * flyer-templates list page (frontend/src/pages/travel/FlyerTemplates.jsx,
 * shipped #908 slice 2).
 *
 * Scope — pins the page-surface invariants for the list + lifecycle UX
 * around saved flyer templates. The live composer (palette + layout block
 * editor) lives in MarketingFlyerStudio.jsx and is OUT OF SCOPE here.
 *
 *   1. Page chrome: heading "Flyer Templates" + sub-head + sub-brand
 *      filter + search input + "+ New Template" CTA (canWrite gated).
 *   2. Initial GET fires /api/travel/flyer-templates on mount.
 *   3. Loaded list renders one card per template with the template name,
 *      sub-brand badge, and 5 palette swatches (one per palette key:
 *      primaryHex / secondaryHex / accentHex / textHex / bgHex).
 *   4. Empty list (API returns []): "No templates yet — create one to get
 *      started." copy renders.
 *   5. Sub-brand filter: selecting "rfu" re-fetches with ?subBrand=rfu.
 *   6. Search input: typing filters cards CLIENT-SIDE (no extra fetch).
 *   7. "+ New Template" reveals the modal form (name + sub-brand inputs).
 *   8. Modal validation: empty name → notify.error("Name is required") +
 *      NO POST fires.
 *   9. Modal submit: POSTs /api/travel/flyer-templates with the trimmed
 *      name + sub-brand body.
 *  10. "Edit" on a card opens the modal pre-filled + PUTs to
 *      /api/travel/flyer-templates/:id.
 *  11. "Delete" fires notify.confirm → DELETE on confirm-yes, NO DELETE
 *      on confirm-no.
 *  12. "Use as starting point" navigates to /travel/marketing/flyer-studio
 *      with ?template=<id> query param.
 *  13. (slice 7) "Duplicate" button: ADMIN/MANAGER sees the button; USER
 *      does not. Click POSTs /api/travel/flyer-templates/:id/duplicate
 *      with empty body; success adds the returned template to the list
 *      and fires notify.success; 5xx fires notify.error; concurrent
 *      clicks while in-flight are suppressed via the disabled state.
 *
 * STUB-mode (slice 2): the GET endpoint at /api/travel/flyer-templates
 * does NOT exist on the backend yet — slice 3 (route + Prisma model)
 * follows. The tests use a mocked fetchApi so this works either way, but
 * the SUT passes `silent: true` on the initial GET so a real 404 won't
 * spam notify.error in production.
 *
 * Backend contract pinned (deferred to slice 3):
 *   GET    /api/travel/flyer-templates[?subBrand=]   → 200 { templates, total }
 *   POST   /api/travel/flyer-templates  body:{name, subBrand}
 *                                                    → 201 created
 *   PUT    /api/travel/flyer-templates/:id           → 200 updated
 *   DELETE /api/travel/flyer-templates/:id           → 204 No Content
 *
 * Template shape consumed (per slice-1 flyerTemplateValidator):
 *   { id, name, subBrand, palette: { primaryHex, secondaryHex, accentHex?,
 *     textHex, bgHex }, layout: [...], assets: {...} }
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (Wave 11 cfb5789 / Wave 12 f59e91d).
 *   - useNavigate mock via vi.mock('react-router-dom', ...) returns a
 *     STABLE mockNavigate fn so the SUT's onClick handler identity stays
 *     stable.
 *   - AuthContext provided via the real App module's Provider; default
 *     user role = ADMIN. One case mounts USER to pin the canWrite gate.
 *   - All data-dependent assertions use findBy / waitFor (per CLAUDE.md
 *     tick #108 cron-learning).
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

// Stable notify object — RTL standing rule.
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

// Stable useNavigate mock — the SUT calls navigate('/travel/marketing-...')
// from the "Use as starting point" button.
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

import { AuthContext } from '../App';
import FlyerTemplates from '../pages/travel/FlyerTemplates';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const USER_USER = { userId: 2, name: 'Plain User', email: 'u@x.com', role: 'USER' };

function makeTemplate(overrides = {}) {
  return {
    id: 501,
    tenantId: 1,
    subBrand: 'tmc',
    name: 'TMC Summer Europe Flyer',
    palette: {
      primaryHex: '#122647',
      secondaryHex: '#265855',
      accentHex: '#C89A4E',
      textHex: '#222222',
      bgHex: '#FFFDF7',
    },
    layout: [],
    assets: {},
    createdAt: '2026-05-25T10:00:00.000Z',
    updatedAt: '2026-05-25T10:00:00.000Z',
    ...overrides,
  };
}

const TEMPLATES_DEFAULT = [
  makeTemplate({ id: 501, subBrand: 'tmc', name: 'TMC Summer Europe Flyer' }),
  makeTemplate({
    id: 502,
    subBrand: 'rfu',
    name: 'RFU Ramadan Umrah Flyer',
    palette: {
      primaryHex: '#265855',
      secondaryHex: '#CD9481',
      accentHex: '#C89A4E',
      textHex: '#111111',
      bgHex: '#FFFFFF',
    },
  }),
  makeTemplate({
    id: 503,
    subBrand: 'visasure',
    name: 'Visa Sure UK Flyer',
    palette: {
      primaryHex: '#6366f1',
      secondaryHex: '#8b5cf6',
      // No accentHex — exercises the optional-key skip in the swatches render.
      textHex: '#0f172a',
      bgHex: '#f8fafc',
    },
  }),
];

function installFetchMock({
  list = { templates: TEMPLATES_DEFAULT, total: TEMPLATES_DEFAULT.length },
  create = null,
  update = null,
  del = null,
  duplicate = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/travel/flyer-templates') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url === '/api/travel/flyer-templates' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeTemplate({ id: 999 }));
    }
    if (/^\/api\/travel\/flyer-templates\/\d+\/duplicate$/.test(url) && method === 'POST') {
      if (duplicate instanceof Error) return Promise.reject(duplicate);
      if (typeof duplicate === 'function') return Promise.resolve(duplicate(url));
      return Promise.resolve(
        duplicate || makeTemplate({ id: 901, name: 'TMC Summer Europe Flyer (copy)' }),
      );
    }
    if (/^\/api\/travel\/flyer-templates\/\d+$/.test(url) && method === 'PUT') {
      if (update instanceof Error) return Promise.reject(update);
      return Promise.resolve(update || makeTemplate({ id: 501 }));
    }
    if (/^\/api\/travel\/flyer-templates\/\d+$/.test(url) && method === 'DELETE') {
      if (del instanceof Error) return Promise.reject(del);
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={value}>
        <FlyerTemplates />
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
  mockNavigate.mockReset();
  installFetchMock();
});

describe('<FlyerTemplates /> — page chrome + initial fetch', () => {
  it('renders heading + sub-head + filter bar + "New Template" CTA (ADMIN)', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Flyer Templates/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Reusable flyer designs for marketing campaigns/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by sub-brand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Search templates/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Template/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
  });

  it('hides "New Template" CTA + Edit/Delete/Duplicate on each card for plain USER role', async () => {
    renderPage(USER_USER);
    await screen.findByText('TMC Summer Europe Flyer');
    expect(screen.queryByRole('button', { name: /New Template/i })).toBeNull();
    // No Edit / Delete / Duplicate buttons exist for any row.
    expect(screen.queryByRole('button', { name: /^Edit TMC Summer Europe Flyer$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete TMC Summer Europe Flyer$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Duplicate TMC Summer Europe Flyer$/ })).toBeNull();
    // The non-write "Use as starting point" CTA still shows.
    expect(
      screen.getByRole('button', { name: /Use TMC Summer Europe Flyer as starting point/i }),
    ).toBeInTheDocument();
  });

  it('GETs /api/travel/flyer-templates on mount with NO query string when filter is empty', async () => {
    renderPage();
    await waitFor(() => {
      const get = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.startsWith('/api/travel/flyer-templates') && (!o?.method || o.method === 'GET'),
      );
      expect(get).toBeTruthy();
      expect(get[0]).toBe('/api/travel/flyer-templates');
    });
  });
});

describe('<FlyerTemplates /> — card rendering', () => {
  it('renders one card per template with name, sub-brand badge, and palette swatches', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    expect(screen.getByText('RFU Ramadan Umrah Flyer')).toBeInTheDocument();
    expect(screen.getByText('Visa Sure UK Flyer')).toBeInTheDocument();

    // Card 501 has all 5 palette swatches (full palette).
    const card501 = screen.getByTestId('flyer-template-card-501');
    expect(within(card501).getByTestId('swatch-501-primaryHex')).toBeInTheDocument();
    expect(within(card501).getByTestId('swatch-501-secondaryHex')).toBeInTheDocument();
    expect(within(card501).getByTestId('swatch-501-accentHex')).toBeInTheDocument();
    expect(within(card501).getByTestId('swatch-501-textHex')).toBeInTheDocument();
    expect(within(card501).getByTestId('swatch-501-bgHex')).toBeInTheDocument();

    // Card 503 omits accentHex (optional per slice-1 validator) — so its
    // swatch should NOT render, but the other 4 still should.
    const card503 = screen.getByTestId('flyer-template-card-503');
    expect(within(card503).queryByTestId('swatch-503-accentHex')).toBeNull();
    expect(within(card503).getByTestId('swatch-503-primaryHex')).toBeInTheDocument();
    expect(within(card503).getByTestId('swatch-503-bgHex')).toBeInTheDocument();

    // Sub-brand badge on each card.
    expect(within(card501).getByText('tmc')).toBeInTheDocument();
    expect(within(screen.getByTestId('flyer-template-card-502')).getByText('rfu')).toBeInTheDocument();
    expect(within(card503).getByText('visasure')).toBeInTheDocument();
  });

  it('renders empty state "No templates yet — create one to get started." when list is []', async () => {
    installFetchMock({ list: { templates: [], total: 0 } });
    renderPage();
    expect(
      await screen.findByText(/No templates yet — create one to get started/i),
    ).toBeInTheDocument();
    // Permission-denied copy NOT shown on benign empty.
    expect(screen.queryByText(/Access restricted/i)).toBeNull();
  });
});

describe('<FlyerTemplates /> — filter + search', () => {
  it('selecting sub-brand "rfu" re-fetches with ?subBrand=rfu', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fetchApiMock.mockClear();
    installFetchMock({ list: { templates: [TEMPLATES_DEFAULT[1]], total: 1 } });
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), { target: { value: 'rfu' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.includes('subBrand=rfu') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('search filters cards client-side WITHOUT firing a new GET', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    expect(screen.getByText('RFU Ramadan Umrah Flyer')).toBeInTheDocument();
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Search templates/i), { target: { value: 'umrah' } });
    // Only RFU card remains; TMC + Visa cards are filtered out.
    await waitFor(() => {
      expect(screen.queryByText('TMC Summer Europe Flyer')).toBeNull();
      expect(screen.queryByText('Visa Sure UK Flyer')).toBeNull();
      expect(screen.getByText('RFU Ramadan Umrah Flyer')).toBeInTheDocument();
    });
    // No new GET fired by the search input.
    const getCalls = fetchApiMock.mock.calls.filter(([u, o]) =>
      typeof u === 'string' && u.startsWith('/api/travel/flyer-templates') && (!o?.method || o.method === 'GET'),
    );
    expect(getCalls.length).toBe(0);
  });
});

describe('<FlyerTemplates /> — create / edit / delete', () => {
  it('clicking "+ New Template" reveals the modal form', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    expect(screen.queryByTestId('flyer-template-form')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /New Template/i }));
    expect(screen.getByTestId('flyer-template-form')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Template name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Sub-brand$/i)).toBeInTheDocument();
  });

  it('validation: empty name → notify.error("Name is required") + NO POST', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /New Template/i }));
    fetchApiMock.mockClear();
    // Submit via direct form event (bypasses HTML5 required attr).
    const form = screen.getByTestId('flyer-template-form');
    fireEvent.submit(form);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Name is required/i));
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/flyer-templates' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('submit POSTs /api/travel/flyer-templates with trimmed name + sub-brand', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /New Template/i }));
    fireEvent.change(screen.getByLabelText(/^Template name$/i), { target: { value: '  Goa Family Flyer  ' } });
    fireEvent.change(screen.getByLabelText(/^Sub-brand$/i), { target: { value: 'travelstall' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/flyer-templates' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.name).toBe('Goa Family Flyer'); // trimmed
      expect(body.subBrand).toBe('travelstall');
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Goa Family Flyer.*created/));
  });

  it('clicking "Edit" on a card opens the form pre-filled + PUTs to :id', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Edit TMC Summer Europe Flyer$/ }));
    expect(screen.getByLabelText(/^Template name$/i).value).toBe('TMC Summer Europe Flyer');
    expect(screen.getByLabelText(/^Sub-brand$/i).value).toBe('tmc');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/flyer-templates/501' && o?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(put[1].body);
      expect(body.name).toBe('TMC Summer Europe Flyer');
      expect(body.subBrand).toBe('tmc');
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/updated/i));
  });

  it('"Delete" fires notify.confirm → DELETE on confirm-yes; NO DELETE on confirm-no', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');

    // Confirm-no path.
    notifyConfirm.mockResolvedValueOnce(false);
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Delete TMC Summer Europe Flyer$/ }));
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    const deletesA = fetchApiMock.mock.calls.filter(([u, o]) =>
      typeof u === 'string' && /^\/api\/travel\/flyer-templates\/\d+$/.test(u) && o?.method === 'DELETE',
    );
    expect(deletesA.length).toBe(0);

    // Confirm-yes path.
    notifyConfirm.mockResolvedValueOnce(true);
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Delete TMC Summer Europe Flyer$/ }));
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/flyer-templates/501' && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/deleted/i));
  });
});

describe('<FlyerTemplates /> — "Use as starting point" navigation', () => {
  it('navigates to /travel/marketing/flyer-studio?template=<id> on click', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(
      screen.getByRole('button', { name: /Use TMC Summer Europe Flyer as starting point/i }),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/travel/marketing/flyer-studio?template=501');
  });
});

describe('<FlyerTemplates /> — Duplicate action (slice 7, consumes 6bbad574)', () => {
  it('renders the Duplicate button on each card for ADMIN', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    expect(
      screen.getByRole('button', { name: /^Duplicate TMC Summer Europe Flyer$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Duplicate RFU Ramadan Umrah Flyer$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Duplicate Visa Sure UK Flyer$/ }),
    ).toBeInTheDocument();
  });

  it('renders the Duplicate button for MANAGER role', async () => {
    const MANAGER_USER = { userId: 3, name: 'Mgr', email: 'm@x.com', role: 'MANAGER' };
    renderPage(MANAGER_USER);
    await screen.findByText('TMC Summer Europe Flyer');
    expect(
      screen.getByRole('button', { name: /^Duplicate TMC Summer Europe Flyer$/ }),
    ).toBeInTheDocument();
  });

  it('clicking Duplicate POSTs /api/travel/flyer-templates/:id/duplicate with empty body', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(
      screen.getByRole('button', { name: /^Duplicate TMC Summer Europe Flyer$/ }),
    );
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/flyer-templates/501/duplicate' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      // Empty body lets the backend defaults apply: name = "<source> (copy)",
      // subBrand inherits from source. The slice-6 contract pin.
      expect(JSON.parse(post[1].body)).toEqual({});
    });
  });

  it('successful duplicate adds the new template to the list state', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    // Sanity: the (copy) row isn't there yet.
    expect(screen.queryByText('TMC Summer Europe Flyer (copy)')).toBeNull();
    installFetchMock({
      duplicate: makeTemplate({ id: 901, name: 'TMC Summer Europe Flyer (copy)', subBrand: 'tmc' }),
    });
    fireEvent.click(
      screen.getByRole('button', { name: /^Duplicate TMC Summer Europe Flyer$/ }),
    );
    expect(
      await screen.findByText('TMC Summer Europe Flyer (copy)'),
    ).toBeInTheDocument();
  });

  it('successful duplicate fires notify.success with the source name', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(
      screen.getByRole('button', { name: /^Duplicate TMC Summer Europe Flyer$/ }),
    );
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/TMC Summer Europe Flyer.*duplicated/i),
      );
    });
  });

  it('5xx server error surfaces notify.error and does NOT add a row', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    const before = screen.getAllByTestId(/^flyer-template-card-\d+$/).length;
    installFetchMock({ duplicate: Object.assign(new Error('Server error'), { status: 500 }) });
    fireEvent.click(
      screen.getByRole('button', { name: /^Duplicate TMC Summer Europe Flyer$/ }),
    );
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Server error|Duplicate failed/i));
    });
    const after = screen.getAllByTestId(/^flyer-template-card-\d+$/).length;
    expect(after).toBe(before);
  });

  it('concurrent Duplicate clicks on the same card do NOT double-fire (disabled while in-flight)', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fetchApiMock.mockClear();
    // Hold the duplicate response open until we release it manually so we
    // can observe the disabled state mid-flight.
    let resolveDup;
    const dupPromise = new Promise((res) => { resolveDup = res; });
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/flyer-templates') && method === 'GET') {
        return Promise.resolve({ templates: TEMPLATES_DEFAULT, total: TEMPLATES_DEFAULT.length });
      }
      if (/^\/api\/travel\/flyer-templates\/\d+\/duplicate$/.test(url) && method === 'POST') {
        return dupPromise;
      }
      return Promise.resolve(null);
    });
    const btn = screen.getByRole('button', { name: /^Duplicate TMC Summer Europe Flyer$/ });
    fireEvent.click(btn);
    // While in-flight: button is disabled.
    await waitFor(() => {
      expect(btn).toBeDisabled();
    });
    // Fire 3 more clicks — they should be suppressed.
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    // Release the duplicate fetch.
    resolveDup(makeTemplate({ id: 902, name: 'TMC Summer Europe Flyer (copy)' }));
    await waitFor(() => {
      const dupPosts = fetchApiMock.mock.calls.filter(([u, o]) =>
        u === '/api/travel/flyer-templates/501/duplicate' && o?.method === 'POST',
      );
      expect(dupPosts.length).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Slice S77 — Download dropdown (Wave 17)
//
// Scope: each template card grows a "Download" button + chevron that opens
// a menu of 5 render-format items. Selecting an item fires
//   POST /api/travel/flyer-templates/:id/render  body:{ format }
// (the slice S17 backend route) using RAW global.fetch (NOT fetchApi),
// because fetchApi calls response.json() and would corrupt the binary
// buffer the route streams back. The blob → createObjectURL → <a download>
// → revokeObjectURL flow is the canonical browser "save buffer as file"
// trick.
//
// These tests pin:
//   - Per-row trigger present + accessible (aria-haspopup / aria-expanded)
//   - All 5 format items render
//   - Menu open/close: trigger toggles, Esc closes, click-outside closes
//   - Each item fires fetch with the correct format payload
//   - Success path: blob() called, createObjectURL called, <a download>
//     clicked with the operator-friendly filename, revokeObjectURL called
//   - Failure path: notify.error fired with the server's error string;
//     when the response body isn't JSON, a generic fallback fires
//   - Loading state: items disabled while the fetch is mid-flight
//   - Filename derivation: name + format + ext.
// ---------------------------------------------------------------------------
describe('<FlyerTemplates /> — Download dropdown (slice S77 / FR-3.4 / FR-3.5)', () => {
  let fetchSpy;
  let createObjectURLSpy;
  let revokeObjectURLSpy;
  let clickSpy;
  let createdAnchors;

  // Install JSDOM doesn't have URL.createObjectURL by default; install a no-op
  // before mounting so the SUT can call it. Same for revokeObjectURL.
  beforeEach(() => {
    if (!('createObjectURL' in URL)) {
      // eslint-disable-next-line no-undef
      Object.defineProperty(URL, 'createObjectURL', { writable: true, value: () => 'blob:url' });
    }
    if (!('revokeObjectURL' in URL)) {
      // eslint-disable-next-line no-undef
      Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: () => {} });
    }
    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    // Capture the <a download> click + the synthesized element.
    createdAnchors = [];
    clickSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        el.click = clickSpy;
        createdAnchors.push(el);
      }
      return el;
    });

    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      blob: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'application/pdf' })),
      json: vi.fn().mockResolvedValue({}),
    });
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    createObjectURLSpy?.mockRestore();
    revokeObjectURLSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it('renders a Download trigger button per template card (ADMIN)', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    expect(
      screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Download RFU Ramadan Umrah Flyer$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Download Visa Sure UK Flyer$/ }),
    ).toBeInTheDocument();
  });

  it('Download trigger exposes aria-haspopup=menu and aria-expanded toggle', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    const trigger = screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('clicking Download opens a menu with all 5 format items', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    const menu = screen.getByTestId('flyer-download-menu-501');
    expect(within(menu).getByRole('menuitem', { name: /PDF — A4/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /PDF — A5/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Square PNG/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Instagram Story/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Facebook Cover/ })).toBeInTheDocument();
    // 5 menuitems total inside this card's menu.
    expect(within(menu).getAllByRole('menuitem').length).toBe(5);
  });

  it('Esc key closes the open dropdown', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    expect(screen.getByTestId('flyer-download-menu-501')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('flyer-download-menu-501')).toBeNull();
    });
  });

  it('mousedown outside the dropdown closes it (click-outside semantics)', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    expect(screen.getByTestId('flyer-download-menu-501')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    await waitFor(() => {
      expect(screen.queryByTestId('flyer-download-menu-501')).toBeNull();
    });
  });

  it('clicking "PDF — A4" fires POST /:id/render with format=pdf-a4', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    fireEvent.click(screen.getByTestId('flyer-download-item-501-pdf-a4'));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/travel/flyer-templates/501/render');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ format: 'pdf-a4' });
    expect(opts.headers.Authorization).toBe('Bearer test-token');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('clicking "PDF — A5" fires POST with format=pdf-a5', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    fireEvent.click(screen.getByTestId('flyer-download-item-501-pdf-a5'));
    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) => u === '/api/travel/flyer-templates/501/render');
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ format: 'pdf-a5' });
    });
  });

  it('clicking "Square PNG" fires POST with format=png-square', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    fireEvent.click(screen.getByTestId('flyer-download-item-501-png-square'));
    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) => u === '/api/travel/flyer-templates/501/render');
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ format: 'png-square' });
    });
  });

  it('clicking "Instagram Story" fires POST with format=png-portrait-ig', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    fireEvent.click(screen.getByTestId('flyer-download-item-501-png-portrait-ig'));
    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) => u === '/api/travel/flyer-templates/501/render');
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ format: 'png-portrait-ig' });
    });
  });

  it('clicking "Facebook Cover" fires POST with format=png-landscape-fb', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    fireEvent.click(screen.getByTestId('flyer-download-item-501-png-landscape-fb'));
    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) => u === '/api/travel/flyer-templates/501/render');
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ format: 'png-landscape-fb' });
    });
  });

  it('success path: blob() called, createObjectURL called, anchor clicked with derived filename, revokeObjectURL called', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    fireEvent.click(screen.getByTestId('flyer-download-item-501-pdf-a4'));
    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalled();
    });
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-url');
    // Filename derivation pin: template.name + format + ext
    const anchor = createdAnchors[createdAnchors.length - 1];
    expect(anchor.download).toBe('TMC Summer Europe Flyer-pdf-a4.pdf');
    expect(anchor.href).toContain('blob:mock-url');
  });

  it('filename for PNG format uses .png extension', async () => {
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    fireEvent.click(screen.getByTestId('flyer-download-item-501-png-square'));
    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalled();
    });
    const anchor = createdAnchors[createdAnchors.length - 1];
    expect(anchor.download).toBe('TMC Summer Europe Flyer-png-square.png');
  });

  it('failure path: 5xx surfaces notify.error with server error string', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      blob: vi.fn(),
      json: vi.fn().mockResolvedValue({ error: 'Failed to render flyer' }),
    });
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    fireEvent.click(screen.getByTestId('flyer-download-item-501-pdf-a4'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Failed to render flyer');
    });
    // No anchor/click on failure path.
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('failure path: 400 INVALID_FORMAT-style error surfaces server error string', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      blob: vi.fn(),
      json: vi.fn().mockResolvedValue({ error: 'format must be one of: pdf-a4, pdf-a5, png-square, png-portrait-ig, png-landscape-fb', code: 'INVALID_FORMAT' }),
    });
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    fireEvent.click(screen.getByTestId('flyer-download-item-501-pdf-a4'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringContaining('format must be one of'));
    });
  });

  it('failure path: non-JSON error response surfaces a generic fallback message', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      blob: vi.fn(),
      json: vi.fn().mockRejectedValue(new Error('not json')),
    });
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    fireEvent.click(screen.getByTestId('flyer-download-item-501-pdf-a4'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Render failed \(503\)\./));
    });
  });

  it('loading state: items disabled while the render fetch is mid-flight', async () => {
    // Hold the fetch open until we manually resolve.
    let resolveFetch;
    fetchSpy.mockImplementationOnce(() => new Promise((res) => { resolveFetch = res; }));
    renderPage();
    await screen.findByText('TMC Summer Europe Flyer');
    fireEvent.click(screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ }));
    const item = screen.getByTestId('flyer-download-item-501-pdf-a4');
    fireEvent.click(item);
    // Items are disabled while loading.
    await waitFor(() => {
      // The whole menu is in-flight: every item is disabled.
      const a4 = screen.queryByTestId('flyer-download-item-501-pdf-a4');
      // Menu may still be open in loading state OR have collapsed — both
      // are acceptable. What we MUST observe is that the trigger button
      // is disabled mid-flight.
      const trigger = screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ });
      expect(trigger).toBeDisabled();
      // Either menu still open (items disabled) or menu closed.
      if (a4) expect(a4).toBeDisabled();
    });
    // Release the fetch.
    resolveFetch({
      ok: true,
      status: 200,
      blob: vi.fn().mockResolvedValue(new Blob(['x'])),
      json: vi.fn(),
    });
    await waitFor(() => {
      const trigger = screen.getByRole('button', { name: /^Download TMC Summer Europe Flyer$/ });
      expect(trigger).not.toBeDisabled();
    });
  });

  it('falls back to "flyer" filename prefix when template.name is empty', async () => {
    installFetchMock({
      list: { templates: [makeTemplate({ id: 777, name: '' })], total: 1 },
    });
    renderPage();
    await screen.findByTestId('flyer-template-card-777');
    fireEvent.click(screen.getByRole('button', { name: /^Download flyer$/ }));
    fireEvent.click(screen.getByTestId('flyer-download-item-777-pdf-a4'));
    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalled();
    });
    const anchor = createdAnchors[createdAnchors.length - 1];
    expect(anchor.download).toBe('flyer-pdf-a4.pdf');
  });
});
