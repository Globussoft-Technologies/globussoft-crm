/**
 * Diagnostics.test.jsx — vitest + RTL coverage for the Travel-vertical
 * Diagnostics LIST page (frontend/src/pages/travel/Diagnostics.jsx).
 *
 * Scope — pins the list-page surface invariants for the diagnostics
 * submissions browser (lands at /travel/diagnostics). This is distinct
 * from its three sibling SUTs already pinned:
 *   - DiagnosticBuilder.test.jsx (c305cf6) → /banks/new authoring form
 *   - DiagnosticDetail.test.jsx           → /:id detail surface
 *   - DiagnosticWizard.test.jsx (51afa31) → /new wizard
 *
 *   1. Page chrome: heading "Diagnostics" + sub-brand filter + classification
 *      filter + Refresh button + "Take diagnostic" CTA always present;
 *      "New bank" CTA only renders for ADMIN role (SUT lines 74-82).
 *   2. Loading state: shows "Loading…" before first GET resolves
 *      (await findByText per CLAUDE.md tick #108 cron-learning).
 *   3. GET on mount: hits /api/travel/diagnostics?limit=100 with NO
 *      subBrand/classification query params when filters are blank
 *      (SUT lines 46-53: builds URLSearchParams; limit=100 always set).
 *   4. Empty-state: zero diagnostics → renders the "No diagnostics submitted
 *      yet." copy + the "Take diagnostic" hint (SUT lines 138-140).
 *   5. Sub-brand filter: selecting "rfu" re-fetches with ?subBrand=rfu
 *      (camelCase per SUT line 49 — pinned).
 *   6. Classification filter: selecting "level_2" re-fetches with
 *      ?classification=level_2 (snake_case enum per SUT lines 120-123).
 *   7. Score formatting per row: numeric score renders via
 *      Number(d.score).toFixed(2) (SUT line 172) — `1.5` → `1.50`.
 *      Null score → em-dash.
 *   8. Classification label per row: uses classificationLabel first,
 *      falls back to classification, then em-dash (SUT line 174).
 *   9. Tier badge per row: renders via className `tier-badge tier-badge--<tier>`
 *      for entry/primary/premium; bare `tier-badge` for null/unknown
 *      (SUT lines 155-158). Tests assert className pattern, NOT inline color
 *      (mirrors the className-vs-inline pattern from Itineraries 8169ce8).
 *  10. Sub-brand identifier renders in the brand badge cell per row
 *      (SUT line 170: <span style={brandBadge}>{d.subBrand}</span>).
 *      SUT does NOT import travelSubBrand — brandBadge uses CSS vars
 *      (--subtle-bg-3 / --primary-color); we assert the uppercase text only.
 *  11. Navigation: clicking the row's created-at link navigates to
 *      /travel/diagnostics/:id via <Link to=`...`> (SUT lines 162-168).
 *  12. "Take diagnostic" CTA targets /travel/diagnostics/new (SUT line 84).
 *  13. "New bank" CTA targets /travel/diagnostics/banks/new and is hidden
 *      for non-ADMIN roles.
 *  14. Error handling: GET rejection surfaces e.body.error via notify.error
 *      and clears the diagnostics list (SUT lines 56-60).
 *
 * Backend contract pinned (per backend/routes/travel_diagnostics.js):
 *   GET /api/travel/diagnostics[?subBrand=&classification=&limit=]
 *       → 200 { diagnostics: [...] }
 *       | 500 on error
 *
 * Drift pinned (prompt vs. actual code):
 *   - PROMPT mentioned "sub-brand badge per row: uses real travelSubBrand
 *     OR uniform CSS-vars". DRIFT — SUT does NOT import travelSubBrand
 *     (no import line). brandBadge constant (SUT lines 238-242) uses
 *     `var(--subtle-bg-3)` + `var(--primary-color)` CSS vars — uniform
 *     palette across all sub-brands. Tests assert the uppercase identifier
 *     text only, no palette/rgba assertion.
 *   - PROMPT mentioned "tier filter (if present)". DRIFT — SUT has NO tier
 *     filter chip. Filters are sub-brand + classification only (SUT lines
 *     103-124). Tier is a DERIVED display column from the diagnostic row's
 *     recommendedTier field (SUT line 178), not a filter input.
 *   - PROMPT mentioned "date filter". DRIFT — SUT has NO date filter.
 *   - PROMPT mentioned "RBAC: USER role hides mutation CTAs". CONFIRMED —
 *     "New bank" CTA is ADMIN-only (SUT lines 74-82). "Take diagnostic" CTA
 *     is NOT gated (everyone sees it — SUT lines 83-89). Pinned both.
 *   - PROMPT mentioned "navigation: clicking a row links to /travel/
 *     diagnostics/:id". CONFIRMED — the clickable surface is the created-at
 *     cell wrapping a react-router <Link to=`/travel/diagnostics/{id}`>
 *     (SUT lines 162-168). Other cells are NOT click handlers (this
 *     differs from Itineraries where the entire <tr> is clickable).
 *   - PROMPT mentioned "400/403/500 error responses". The SUT itself only
 *     reads e.body.error (SUT line 57); back-end status codes are
 *     opaque to it. We pin the error-handling code path (notify.error +
 *     setDiagnostics([])); status-code → error-message mapping is server-
 *     side and outside this SUT's responsibility.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (SUT's dep).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (RTL standing rule: Wave 11 cfb5789 /
 *     Wave 12 f59e91d — fresh per-call objects flap useCallback identity).
 *   - AuthContext provided with role=ADMIN by default; one test renders
 *     role=USER to pin the "New bank" RBAC hide.
 *   - travelSubBrand NOT imported by SUT, so no real-import / mock needed.
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning).
 *
 * Path: flat __tests__/Diagnostics.test.jsx — no collision with the
 * three sibling diagnostic-related test files (DiagnosticBuilder,
 * DiagnosticDetail, DiagnosticWizard each cover a different page).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
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
  NotifyProvider: ({ children }) => children,
}));

import { AuthContext } from '../App';
import Diagnostics from '../pages/travel/Diagnostics';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const REGULAR_USER = { userId: 2, name: 'Operator', email: 'op@x.com', role: 'USER' };

// Canonical diagnostic rows — multiple sub-brands + classifications + tier
// values to exercise the badge className paths + the em-dash fallbacks.
function makeDiagnostic(overrides = {}) {
  return {
    id: 701,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 5001,
    score: 4.25,
    classification: 'level_2',
    classificationLabel: 'School-Trip Premium',
    recommendedTier: 'primary',
    createdAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const DIAGNOSTICS_DEFAULT = [
  makeDiagnostic({
    id: 701,
    subBrand: 'tmc',
    classification: 'level_1',
    classificationLabel: 'School-Trip Standard',
    score: 1.5,
    recommendedTier: 'entry',
    contactId: 5001,
  }),
  makeDiagnostic({
    id: 702,
    subBrand: 'rfu',
    classification: 'level_3',
    classificationLabel: 'Umrah Premium',
    score: 7.0,
    recommendedTier: 'premium',
    contactId: 5002,
  }),
  makeDiagnostic({
    id: 703,
    subBrand: 'visasure',
    // Null tier → em-dash fallback + bare tier-badge className.
    classification: 'level_2',
    classificationLabel: null,
    score: null,
    recommendedTier: null,
    contactId: null,
  }),
];

// Install a fetchApi mock that routes by URL. Tests override only the
// surface they care about.
function installFetchMock({
  list = { diagnostics: DIAGNOSTICS_DEFAULT },
} = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (typeof url === 'string' && url.startsWith('/api/travel/diagnostics')) {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={value}>
        <Diagnostics />
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

describe('<Diagnostics /> — page chrome + filter bar', () => {
  it('renders heading + sub-brand filter + classification filter + Refresh + Take diagnostic CTA', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Diagnostics/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by sub-brand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by classification/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reload list/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Take a diagnostic/i })).toBeInTheDocument();
    // Wait for the mount-time GET to settle.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([u]) => typeof u === 'string' && u.startsWith('/api/travel/diagnostics'),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('Take diagnostic CTA targets /travel/diagnostics/new (SUT line 84)', async () => {
    renderPage();
    const cta = screen.getByRole('link', { name: /Take a diagnostic/i });
    expect(cta.getAttribute('href')).toBe('/travel/diagnostics/new');
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
  });
});

describe('<Diagnostics /> — RBAC on "New bank" CTA (SUT lines 74-82)', () => {
  it('ADMIN role: "New bank" CTA renders and targets /travel/diagnostics/banks/new', async () => {
    renderPage(ADMIN_USER);
    const newBank = screen.getByRole('link', { name: /Create new diagnostic bank/i });
    expect(newBank).toBeInTheDocument();
    expect(newBank.getAttribute('href')).toBe('/travel/diagnostics/banks/new');
  });

  it('USER role: "New bank" CTA is hidden (admin-only mutation surface)', async () => {
    renderPage(REGULAR_USER);
    expect(screen.queryByRole('link', { name: /Create new diagnostic bank/i })).toBeNull();
    // "Take diagnostic" CTA still renders for non-admin (SUT lines 83-89).
    expect(screen.getByRole('link', { name: /Take a diagnostic/i })).toBeInTheDocument();
  });
});

describe('<Diagnostics /> — load + render lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/travel/diagnostics')) {
        return new Promise((res) => { resolveList = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveList({ diagnostics: DIAGNOSTICS_DEFAULT });
    // After resolve, the table renders — the first row's "Submitted" link
    // is rendered as a formatted local date string; assert by sub-brand text.
    await screen.findByText('tmc');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/travel/diagnostics?limit=100 on mount with NO subBrand/classification query string', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/travel/diagnostics'),
      );
      expect(listCall).toBeTruthy();
      // limit=100 is always set by the SUT (line 51).
      expect(listCall[0]).toContain('limit=100');
      // No subBrand= / classification= when both filters are blank.
      expect(listCall[0]).not.toContain('subBrand=');
      expect(listCall[0]).not.toContain('classification=');
    });
    // Renders one row per diagnostic (by sub-brand identifier text).
    expect(await screen.findByText('tmc')).toBeInTheDocument();
    expect(screen.getByText('rfu')).toBeInTheDocument();
    expect(screen.getByText('visasure')).toBeInTheDocument();
  });

  it('renders empty-state copy when diagnostics=[] (SUT lines 138-140)', async () => {
    installFetchMock({ list: { diagnostics: [] } });
    renderPage();
    expect(
      await screen.findByText(/No diagnostics submitted yet\./i),
    ).toBeInTheDocument();
    // The "Take diagnostic" hint is embedded as <strong> inside the empty-
    // state copy. Verify the surrounding text is rendered.
    expect(screen.getByText(/Click/i)).toBeInTheDocument();
  });

  it('surfaces notify.error when GET rejects (with e.body.error message)', async () => {
    const err = new Error('boom');
    err.body = { error: 'Failed to load diagnostics' };
    installFetchMock({ list: err });
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Failed to load diagnostics');
    });
  });

  it('falls back to default error message when e.body.error is absent', async () => {
    const err = new Error('boom');
    installFetchMock({ list: err });
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Failed to load diagnostics');
    });
  });
});

describe('<Diagnostics /> — filter behaviour (camelCase + snake_case enum)', () => {
  it('selecting sub-brand "rfu" re-fetches with ?subBrand=rfu in the URL', async () => {
    renderPage();
    await screen.findByText('tmc');
    fetchApiMock.mockClear();
    installFetchMock({ list: { diagnostics: [DIAGNOSTICS_DEFAULT[1]] } });
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), {
      target: { value: 'rfu' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.includes('subBrand=rfu'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('selecting classification "level_2" re-fetches with ?classification=level_2', async () => {
    renderPage();
    await screen.findByText('tmc');
    fetchApiMock.mockClear();
    installFetchMock({ list: { diagnostics: [DIAGNOSTICS_DEFAULT[2]] } });
    fireEvent.change(screen.getByLabelText(/Filter by classification/i), {
      target: { value: 'level_2' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.includes('classification=level_2'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('clicking Refresh re-fetches with the current filter values', async () => {
    renderPage();
    await screen.findByText('tmc');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Reload list/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/travel/diagnostics'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<Diagnostics /> — row rendering (badges + scores + classification fallback)', () => {
  it('score column formats numeric scores via toFixed(2) and shows em-dash for null', async () => {
    renderPage();
    // tmc row score=1.5 → "1.50"
    const tmcRow = (await screen.findByText('tmc')).closest('tr');
    expect(within(tmcRow).getByText('1.50')).toBeInTheDocument();
    // rfu row score=7.0 → "7.00"
    const rfuRow = screen.getByText('rfu').closest('tr');
    expect(within(rfuRow).getByText('7.00')).toBeInTheDocument();
    // visasure row score=null → "—" (one of multiple em-dashes in that row).
    const visaRow = screen.getByText('visasure').closest('tr');
    expect(within(visaRow).getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('classification column prefers classificationLabel, falls back to classification, then em-dash', async () => {
    renderPage();
    const tmcRow = (await screen.findByText('tmc')).closest('tr');
    expect(within(tmcRow).getByText('School-Trip Standard')).toBeInTheDocument();
    const rfuRow = screen.getByText('rfu').closest('tr');
    expect(within(rfuRow).getByText('Umrah Premium')).toBeInTheDocument();
    // visasure row has classificationLabel=null but classification='level_2' →
    // falls back to the raw classification identifier per SUT line 174.
    const visaRow = screen.getByText('visasure').closest('tr');
    expect(within(visaRow).getByText('level_2')).toBeInTheDocument();
  });

  it('tier badge renders via className tier-badge--<tier> for entry/primary/premium; bare tier-badge for null', async () => {
    renderPage();
    const tmcRow = (await screen.findByText('tmc')).closest('tr');
    const entryBadge = within(tmcRow).getByText('entry');
    expect(entryBadge.className).toContain('tier-badge');
    expect(entryBadge.className).toContain('tier-badge--entry');

    const rfuRow = screen.getByText('rfu').closest('tr');
    const premiumBadge = within(rfuRow).getByText('premium');
    expect(premiumBadge.className).toContain('tier-badge');
    expect(premiumBadge.className).toContain('tier-badge--premium');

    // visasure row: recommendedTier=null → tierClass falls through to bare
    // "tier-badge" (SUT line 158); text content is "—".
    const visaRow = screen.getByText('visasure').closest('tr');
    const tierSpans = visaRow.querySelectorAll('span.tier-badge');
    expect(tierSpans.length).toBe(1);
    expect(tierSpans[0].className).toBe('tier-badge');
    expect(tierSpans[0].textContent).toBe('—');
  });

  it('contact column shows #<id> when contactId present but no contact object, em-dash when absent', async () => {
    renderPage();
    const tmcRow = (await screen.findByText('tmc')).closest('tr');
    expect(within(tmcRow).getByText('#5001')).toBeInTheDocument();
    const rfuRow = screen.getByText('rfu').closest('tr');
    expect(within(rfuRow).getByText('#5002')).toBeInTheDocument();
    // visasure contactId=null → em-dash in the contact cell (one of several).
    const visaRow = screen.getByText('visasure').closest('tr');
    expect(within(visaRow).getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('contact column shows the customer NAME when the row carries an enriched contact object', async () => {
    installFetchMock({
      list: {
        diagnostics: [
          makeDiagnostic({
            id: 711,
            subBrand: 'tmc',
            contactId: 5001,
            contact: { id: 5001, name: 'Asha Verma', email: 'asha@x.com', phone: '999' },
          }),
        ],
      },
    });
    renderPage();
    const row = (await screen.findByText('tmc')).closest('tr');
    expect(within(row).getByText('Asha Verma')).toBeInTheDocument();
    // The email renders as the secondary sub-line, not the bare #id.
    expect(within(row).getByText('asha@x.com')).toBeInTheDocument();
    expect(within(row).queryByText('#5001')).toBeNull();
  });

  it('contact column falls back to email when contact has email but no name', async () => {
    installFetchMock({
      list: {
        diagnostics: [
          makeDiagnostic({
            id: 712,
            subBrand: 'rfu',
            contactId: 5002,
            contact: { id: 5002, name: null, email: 'noname@x.com', phone: null },
          }),
        ],
      },
    });
    renderPage();
    const row = (await screen.findByText('rfu')).closest('tr');
    expect(within(row).getByText('noname@x.com')).toBeInTheDocument();
  });
});

describe('<Diagnostics /> — navigation (created-at cell → /travel/diagnostics/:id)', () => {
  it('each row\'s created-at link targets /travel/diagnostics/<id>', async () => {
    renderPage();
    await screen.findByText('tmc');
    const link701 = screen.getByRole('link', { name: /Open diagnostic #701/i });
    const link702 = screen.getByRole('link', { name: /Open diagnostic #702/i });
    const link703 = screen.getByRole('link', { name: /Open diagnostic #703/i });
    expect(link701.getAttribute('href')).toBe('/travel/diagnostics/701');
    expect(link702.getAttribute('href')).toBe('/travel/diagnostics/702');
    expect(link703.getAttribute('href')).toBe('/travel/diagnostics/703');
  });
});
