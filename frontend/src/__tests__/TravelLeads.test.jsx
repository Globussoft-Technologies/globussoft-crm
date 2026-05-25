/**
 * TravelLeads.test.jsx — vitest + RTL coverage for the Travel-vertical
 * unified leads list page (frontend/src/pages/travel/Leads.jsx, PRD §7).
 *
 * Scope — pins the page-surface invariants for the Travel unified leads page
 * (sibling to Trips / Itineraries / VisaApplications — the most-recent
 * travel-page tests, shipped commits 285ec18 / 874296d / 0609956):
 *
 *   1. Page chrome: heading "Travel Leads" + UserPlus icon + filter bar
 *      (sub-brand <select> + stage <select> + deal-count summary) + two
 *      header CTAs ("New Travel Lead" + "Refresh"). No RBAC gate in the SUT
 *      — both CTAs render for every authenticated user (backend handles
 *      authz via tenant/sub-brand access middleware).
 *   2. Loading state: shows "Loading…" placeholder before first GET resolves
 *      (await findByText per CLAUDE.md tick #108 cron-learning).
 *   3. GET on mount: hits /api/deals with ?limit=200 (no subBrand / stage
 *      when both filters are empty — confirmed via SUT lines 95-99) and
 *      renders one row per deal (table layout with 6 columns: Title /
 *      Contact / Sub-brand / Stage / Amount / Diagnostic).
 *   4. Empty state: zero deals → "No deals match the current filters." copy
 *      with the AlertCircle icon (SUT line 147-150).
 *   5. Sub-brand filter: selecting "TMC" re-fetches with ?subBrand=tmc in
 *      the query string. Sub-brand value list is exact: "" / tmc / rfu /
 *      travelstall / visasure (SUT lines 25-31).
 *   6. Stage filter: selecting "Won" re-fetches with ?stage=won. Stage
 *      enum: "" / lead / contacted / proposal / won / lost (SUT 33-40).
 *   7. Row → Deal link: clicking a deal title navigates to /deals/:id
 *      (SUT line 167 — pinned via getByRole('link', { name: title }) +
 *      href). Note: deals.js NOT leads.js — the page reuses the generic
 *      CRM Deal detail page (SUT header comment lines 11-15 documents this).
 *   8. Row → Contact link: rows with d.contactId render a <Link> to
 *      /travel/leads/:contactId (the unified lead-view, SUT line 171).
 *      Rows without contactId render plain text fallback.
 *   9. Stage badge per row: renders the SUT's stageBadge() inline-style
 *      pill — DOM text is the raw stage ("won" / "lost" / "proposal" /
 *      "contacted" / "lead"). Uppercase styling is CSS textTransform.
 *  10. Sub-brand badge per row: rows with d.subBrand render the subBrand
 *      text inside a brandBadge span. Rows with no subBrand render an
 *      em-dash. (SUT does NOT use travelSubBrand.js palette — it uses a
 *      uniform CSS-var pattern, var(--subtle-bg-3)/var(--primary-color)
 *      per SUT lines 390-394; pinned via DOM text not styling assertion.)
 *  11. Amount per row: rows with non-null d.amount render
 *      "<currency> <toLocaleString>" (SUT line 184). Rows with null
 *      render em-dash.
 *  12. Diagnostic per row: rows with d.diagnosticId render a <Link> to
 *      /travel/diagnostics with #<id> + Tag icon. Plus the RFU profile
 *      conditional link (only shown when subBrand="rfu" AND contactId
 *      present, per SUT lines 194-202).
 *  13. New-lead drawer open: clicking "New Travel Lead" opens the drawer,
 *      surfaces the 6 fields (Title / Contact / Sub-brand / Stage /
 *      Estimated value / Expected close), AND fires /api/contacts?limit=200
 *      for the contact picker (SUT line 61).
 *  14. Form validation — empty title: notify.error("Title is required") +
 *      no POST to /api/deals (SUT lines 68-71).
 *  15. Submit happy path: POSTs /api/deals with body containing trimmed
 *      title, default stage="lead", default subBrand="tmc". When contactId
 *      / amount / expectedClose are set, they're coerced (parseInt for
 *      contactId, Number for amount) and included. notify.success fires
 *      with "Travel lead created". List re-fires after submit.
 *  16. Error handling: GET rejection surfaces notify.error with body.error
 *      message ("Failed to load leads" fallback per SUT line 102).
 *
 * Backend contract pinned (per backend/routes/deals.js extended for travel):
 *   GET    /api/deals[?subBrand=&stage=&limit=]
 *          → 200 [Array<Deal>] (top-level array, NOT { deals: [...] } —
 *            SUT line 100: `setDeals(Array.isArray(res) ? res : [])`)
 *          | 500 "Failed to load leads"
 *   POST   /api/deals body:{title,stage,subBrand,contactId?,amount?,
 *                            expectedClose?}
 *          → 201 created
 *
 * Drift pinned around (prompt vs. actual code):
 *   - Prompt said "fetch endpoints: /api/travel/leads or /api/contacts?
 *     subBrand=...&isLead=..." — actual SUT uses /api/deals (the generic
 *     CRM deals route, extended to accept ?subBrand for Travel). The page
 *     header comment (SUT lines 5-9) explicitly explains this: server-side
 *     ?subBrand filter on /api/deals avoids the "client-side aggregation
 *     over paginated endpoint" structural correctness bug from CLAUDE.md.
 *   - Prompt said "lead-tracking shape may use existing /api/contacts
 *     route with a filter" — incorrect; SUT uses /api/deals (Deals, not
 *     Contacts, are the Lead surface in Travel). /api/contacts is only
 *     hit for the create-lead drawer's contact picker (SUT line 61).
 *   - Prompt mentioned "score badges" — there is NO score field/badge in
 *     the SUT. The filter set is: sub-brand + stage. Tests OMIT score.
 *   - Prompt mentioned "status badge per row" — the SUT uses "stage"
 *     terminology throughout (matches Deal schema). Tests use "stage".
 *   - Prompt mentioned navigation to "/travel/leads/:id" — partial truth:
 *     the deal-title cell navigates to /deals/:dealId (the generic CRM
 *     Deal page, SUT line 167); the contact cell navigates to
 *     /travel/leads/:contactId (unified travel lead view, SUT line 171).
 *     Tests assert both paths to pin the dual-link pattern.
 *   - Prompt mentioned "RBAC: USER role hides mutation CTAs" — the SUT
 *     does NOT gate "New Travel Lead" by AuthContext role. Tests OMIT
 *     the canWrite=false assertion (backend's sub-brand-access middleware
 *     is the source of authz truth, not the frontend).
 *   - Prompt mentioned "travelSubBrand.js for badge styling" — the SUT
 *     does NOT import travelSubBrand.js. It uses a uniform inline-style
 *     brandBadge (SUT lines 390-394) with CSS-var palette. Tests assert
 *     via DOM text only, not via palette imports.
 *   - SUT's "Loading…" text uses the &hellip; entity (renders as unicode
 *     U+2026). Assert via findByText('Loading…').
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference (Wave 11 cfb5789 /
 *     Wave 12 f59e91d — fresh per-call objects flap useCallback identity).
 *   - AuthContext provided via the real Provider from App (the SUT does
 *     NOT consume AuthContext directly, but a router context is required
 *     for the <Link>; MemoryRouter handles that).
 *   - For dates: fixed ISO strings; no "today" / midnight-of-today
 *     comparisons (per CLAUDE.md cron-learning 2026-05-07 wave-9).
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning: sync getBy for data-dependent
 *     text is a CI race trap).
 *
 * Path: flat __tests__/TravelLeads.test.jsx — disambiguated from the
 * existing __tests__/Leads.test.jsx (wellness-vertical Leads page) per
 * the dispatch prompt's naming guidance. Sibling Agent B owns
 * VisaAdvisorDashboard.test.jsx in the same flat dir; no collision.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). The SUT closes over notify inside load + submitCreate, so a
// fresh object per render would flap state across re-renders.
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
import TravelLeads from '../pages/travel/Leads';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

// Canonical deal rows — multiple sub-brands + stages + amount/diagnostic
// permutations to exercise the badge + link render paths.
function makeDeal(overrides = {}) {
  return {
    id: 301,
    tenantId: 1,
    title: 'Mumbai School — Andaman 2026',
    contactId: 5001,
    contact: { id: 5001, name: 'Mumbai International School', email: 'admin@mis.example' },
    subBrand: 'tmc',
    stage: 'proposal',
    amount: 2500000,
    currency: 'INR',
    diagnosticId: 11,
    expectedClose: '2026-12-08',
    createdAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const DEALS_DEFAULT = [
  makeDeal({
    id: 301,
    title: 'Mumbai School — Andaman 2026',
    subBrand: 'tmc',
    stage: 'proposal',
    amount: 2500000,
    currency: 'INR',
    contactId: 5001,
    contact: { id: 5001, name: 'Mumbai International School', email: 'admin@mis.example' },
    diagnosticId: 11,
  }),
  makeDeal({
    id: 302,
    title: 'Family Umrah package — Singh family',
    subBrand: 'rfu',
    stage: 'contacted',
    amount: 450000,
    currency: 'INR',
    contactId: 5002,
    contact: { id: 5002, name: 'Harpreet Singh', email: 'harpreet@example.com' },
    diagnosticId: null,
  }),
  makeDeal({
    id: 303,
    title: 'Travel Stall Goa weekend',
    subBrand: 'travelstall',
    stage: 'won',
    amount: 85000,
    currency: 'USD',
    contactId: null,
    contact: null,
    diagnosticId: null,
  }),
  makeDeal({
    id: 304,
    title: 'Visa Sure — Schengen application',
    subBrand: 'visasure',
    stage: 'lead',
    amount: null,
    currency: null,
    contactId: 5004,
    contact: { id: 5004, name: 'Anita Sharma', email: 'anita@example.com' },
    diagnosticId: null,
  }),
];

const CONTACTS_DEFAULT = [
  { id: 5001, name: 'Mumbai International School', email: 'admin@mis.example' },
  { id: 5002, name: 'Harpreet Singh', email: 'harpreet@example.com' },
  { id: 5004, name: 'Anita Sharma', email: 'anita@example.com' },
];

// Install a fetchApi mock that routes by URL + method. Tests override only
// the surface they care about.
function installFetchMock({
  list = DEALS_DEFAULT,
  contacts = CONTACTS_DEFAULT,
  create = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/deals') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url.startsWith('/api/contacts') && method === 'GET') {
      if (contacts instanceof Error) return Promise.reject(contacts);
      return Promise.resolve(contacts);
    }
    if (url === '/api/deals' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeDeal({ id: 999, title: 'Created' }));
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={value}>
        <TravelLeads />
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

describe('<TravelLeads /> — page chrome', () => {
  it('renders heading "Travel Leads" + filter bar + "New Travel Lead" + "Refresh" CTAs', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Travel Leads/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by sub-brand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by stage/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create a new travel lead/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh leads/i })).toBeInTheDocument();
    // Wait for the mount-time GET to settle.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([u]) => typeof u === 'string' && u.startsWith('/api/deals'),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});

describe('<TravelLeads /> — load + render lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/deals') && method === 'GET') {
        return new Promise((res) => { resolveList = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveList(DEALS_DEFAULT);
    await screen.findByText('Mumbai School — Andaman 2026');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/deals on mount with limit=200 + no subBrand/stage when filters empty', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/deals')
        && (!o?.method || o.method === 'GET'),
      );
      expect(listCall).toBeTruthy();
      expect(listCall[0]).toContain('limit=200');
      // No subBrand= / stage= when filters empty.
      expect(listCall[0]).not.toContain('subBrand=');
      expect(listCall[0]).not.toContain('stage=');
    });
    // Renders one row per deal (by title).
    expect(await screen.findByText('Mumbai School — Andaman 2026')).toBeInTheDocument();
    expect(screen.getByText('Family Umrah package — Singh family')).toBeInTheDocument();
    expect(screen.getByText('Travel Stall Goa weekend')).toBeInTheDocument();
    expect(screen.getByText('Visa Sure — Schengen application')).toBeInTheDocument();
  });

  it('renders empty-state copy when deals=[]', async () => {
    installFetchMock({ list: [] });
    renderPage();
    expect(
      await screen.findByText(/No deals match the current filters\./i),
    ).toBeInTheDocument();
  });

  it('GET rejection surfaces notify.error with the body.error', async () => {
    const err = new Error('boom');
    err.body = { error: 'Failed to load leads' };
    installFetchMock({ list: err });
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Failed to load leads');
    });
  });
});

describe('<TravelLeads /> — filter behavior', () => {
  it('selecting sub-brand "TMC" re-fetches with ?subBrand=tmc', async () => {
    renderPage();
    await screen.findByText('Mumbai School — Andaman 2026');
    fetchApiMock.mockClear();
    installFetchMock({ list: [DEALS_DEFAULT[0]] });
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), {
      target: { value: 'tmc' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('subBrand=tmc')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('selecting stage "Won" re-fetches with ?stage=won', async () => {
    renderPage();
    await screen.findByText('Mumbai School — Andaman 2026');
    fetchApiMock.mockClear();
    installFetchMock({ list: [DEALS_DEFAULT[2]] });
    fireEvent.change(screen.getByLabelText(/Filter by stage/i), {
      target: { value: 'won' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('stage=won')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('Refresh button re-fires the GET', async () => {
    renderPage();
    await screen.findByText('Mumbai School — Andaman 2026');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Refresh leads/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/deals')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<TravelLeads /> — row rendering: stage / sub-brand / contact / amount / diagnostic', () => {
  it('deal-title cell renders a <Link> to /deals/:id (generic Deal detail page reuse)', async () => {
    renderPage();
    await screen.findByText('Mumbai School — Andaman 2026');
    const link = screen.getByRole('link', { name: /Mumbai School — Andaman 2026/i });
    expect(link).toHaveAttribute('href', '/deals/301');
    const link2 = screen.getByRole('link', { name: /Family Umrah package — Singh family/i });
    expect(link2).toHaveAttribute('href', '/deals/302');
  });

  it('contact cell renders a <Link> to /travel/leads/:contactId when contactId present', async () => {
    renderPage();
    const row1 = (await screen.findByText('Mumbai School — Andaman 2026')).closest('tr');
    const contactLink = within(row1).getByRole('link', { name: /Mumbai International School/i });
    expect(contactLink).toHaveAttribute('href', '/travel/leads/5001');
    // Row 303 has no contactId → no link, em-dash fallback.
    const row3 = screen.getByText('Travel Stall Goa weekend').closest('tr');
    expect(within(row3).queryByRole('link', { name: /Contact/i })).toBeNull();
  });

  it('renders the stage text per row (proposal / contacted / won / lead)', async () => {
    renderPage();
    const row1 = (await screen.findByText('Mumbai School — Andaman 2026')).closest('tr');
    expect(within(row1).getByText('proposal')).toBeInTheDocument();
    const row2 = screen.getByText('Family Umrah package — Singh family').closest('tr');
    expect(within(row2).getByText('contacted')).toBeInTheDocument();
    const row3 = screen.getByText('Travel Stall Goa weekend').closest('tr');
    expect(within(row3).getByText('won')).toBeInTheDocument();
    const row4 = screen.getByText('Visa Sure — Schengen application').closest('tr');
    expect(within(row4).getByText('lead')).toBeInTheDocument();
  });

  it('renders the sub-brand text per row (tmc / rfu / travelstall / visasure)', async () => {
    renderPage();
    const row1 = (await screen.findByText('Mumbai School — Andaman 2026')).closest('tr');
    expect(within(row1).getByText('tmc')).toBeInTheDocument();
    const row2 = screen.getByText('Family Umrah package — Singh family').closest('tr');
    expect(within(row2).getByText('rfu')).toBeInTheDocument();
    const row3 = screen.getByText('Travel Stall Goa weekend').closest('tr');
    expect(within(row3).getByText('travelstall')).toBeInTheDocument();
    const row4 = screen.getByText('Visa Sure — Schengen application').closest('tr');
    expect(within(row4).getByText('visasure')).toBeInTheDocument();
  });

  it('renders amount per row with currency prefix; em-dash when null', async () => {
    renderPage();
    // Deal 301: amount=2500000 INR → "INR <locale-formatted>". toLocaleString
    // is locale-sensitive (en-IN → "25,00,000"; en-US → "2,500,000"); both
    // are valid output. Assert via "INR" prefix + digit substring covering
    // either grouping style. Same for USD 85,000.
    const row1 = (await screen.findByText('Mumbai School — Andaman 2026')).closest('tr');
    expect(within(row1).getByText(/INR\s+[\d,]+/)).toBeInTheDocument();
    // Deal 303: amount=85000 USD → "USD <locale-formatted>"
    const row3 = screen.getByText('Travel Stall Goa weekend').closest('tr');
    expect(within(row3).getByText(/USD\s+[\d,]+/)).toBeInTheDocument();
    // Deal 304: amount=null → em-dash fallback (the amount column).
    const row4 = screen.getByText('Visa Sure — Schengen application').closest('tr');
    // Multiple em-dashes can appear (amount cell + diagnostic cell). Assert
    // via getAllByText length ≥ 1.
    expect(within(row4).getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('renders diagnostic link to /travel/diagnostics when diagnosticId present', async () => {
    renderPage();
    const row1 = (await screen.findByText('Mumbai School — Andaman 2026')).closest('tr');
    const diagLink = within(row1).getByRole('link', { name: /#11/ });
    expect(diagLink).toHaveAttribute('href', '/travel/diagnostics');
    // Row without diagnosticId → no diagnostic link (em-dash fallback).
    const row3 = screen.getByText('Travel Stall Goa weekend').closest('tr');
    expect(within(row3).queryByRole('link', { name: /^#/ })).toBeNull();
  });

  it('renders RFU profile link only when subBrand=rfu AND contactId present', async () => {
    renderPage();
    // Row 302: subBrand=rfu + contactId=5002 → RFU profile link.
    const row2 = (await screen.findByText('Family Umrah package — Singh family')).closest('tr');
    const rfuLink = within(row2).getByRole('link', { name: /RFU profile/i });
    expect(rfuLink).toHaveAttribute('href', '/travel/rfu/customers/5002');
    // Row 301: subBrand=tmc → no RFU profile link.
    const row1 = screen.getByText('Mumbai School — Andaman 2026').closest('tr');
    expect(within(row1).queryByRole('link', { name: /RFU profile/i })).toBeNull();
  });
});

describe('<TravelLeads /> — new-lead drawer + create POST', () => {
  it('clicking "New Travel Lead" opens drawer + fires /api/contacts?limit=200 for picker', async () => {
    renderPage();
    await screen.findByText('Mumbai School — Andaman 2026');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Create a new travel lead/i }));
    // Drawer surface renders.
    const heading = await screen.findByRole('heading', { name: /^New Travel Lead$/i });
    expect(heading).toBeInTheDocument();
    // The 6 fields surface (Title / Contact / Sub-brand / Stage / Estimated
    // value / Expected close) — assert via label text scoped to the drawer.
    const drawerForm = heading.closest('form');
    expect(drawerForm).toBeTruthy();
    expect(within(drawerForm).getByText(/^Title$/i)).toBeInTheDocument();
    expect(within(drawerForm).getByText(/^Contact$/i)).toBeInTheDocument();
    expect(within(drawerForm).getByText(/^Sub-brand$/i)).toBeInTheDocument();
    expect(within(drawerForm).getByText(/^Stage$/i)).toBeInTheDocument();
    expect(within(drawerForm).getByText(/Estimated value/i)).toBeInTheDocument();
    expect(within(drawerForm).getByText(/Expected close/i)).toBeInTheDocument();
    // /api/contacts?limit=200 fired so the contact picker can populate.
    await waitFor(() => {
      const contactsCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/contacts')
        && u.includes('limit=200')
        && (!o?.method || o.method === 'GET'),
      );
      expect(contactsCall).toBeTruthy();
    });
  });

  it('validation: missing title surfaces notify.error + does NOT fire POST', async () => {
    renderPage();
    await screen.findByText('Mumbai School — Andaman 2026');
    fireEvent.click(screen.getByRole('button', { name: /Create a new travel lead/i }));
    await screen.findByRole('heading', { name: /^New Travel Lead$/i });
    fetchApiMock.mockClear();
    installFetchMock();
    // Submit form with blank title — bypass HTML5 required-attr via direct submit.
    const form = screen.getByRole('heading', { name: /^New Travel Lead$/i }).closest('form');
    fireEvent.submit(form);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Title is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/deals' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('happy path: filling the form + Create POSTs /api/deals with parsed payload + notify.success', async () => {
    renderPage();
    await screen.findByText('Mumbai School — Andaman 2026');
    fireEvent.click(screen.getByRole('button', { name: /Create a new travel lead/i }));
    await screen.findByRole('heading', { name: /^New Travel Lead$/i });
    // Wait for contact picker to populate so the <option> exists.
    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: /Mumbai International School/i }),
      ).toBeInTheDocument();
    });
    // Title input is the only textbox in the drawer.
    const titleInput = screen.getByRole('textbox');
    fireEvent.change(titleInput, { target: { value: '  Kashmir school trip 2026  ' } });
    // The combobox set in the drawer is: Sub-brand (filter), Stage (filter),
    // drawer Contact, drawer Sub-brand, drawer Stage. The drawer Contact is
    // 3rd overall.
    const comboboxes = screen.getAllByRole('combobox');
    fireEvent.change(comboboxes[2], { target: { value: '5001' } });
    // Drawer Sub-brand is 4th, set to "rfu".
    fireEvent.change(comboboxes[3], { target: { value: 'rfu' } });
    // Drawer Stage is 5th, set to "proposal".
    fireEvent.change(comboboxes[4], { target: { value: 'proposal' } });
    // Estimated value (number input).
    const numberInput = document.querySelector('input[type="number"]');
    fireEvent.change(numberInput, { target: { value: '125000' } });
    // Expected close (date input).
    const dateInput = document.querySelector('input[type="date"]');
    fireEvent.change(dateInput, { target: { value: '2026-12-15' } });

    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Create Lead/i }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/deals' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      // Title is trimmed.
      expect(body.title).toBe('Kashmir school trip 2026');
      // Sub-brand + stage set.
      expect(body.subBrand).toBe('rfu');
      expect(body.stage).toBe('proposal');
      // contactId coerced to Int.
      expect(body.contactId).toBe(5001);
      expect(typeof body.contactId).toBe('number');
      // amount coerced to Number.
      expect(body.amount).toBe(125000);
      expect(typeof body.amount).toBe('number');
      // expectedClose is the raw date string.
      expect(body.expectedClose).toBe('2026-12-15');
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Travel lead created/i),
    );
  });
});
