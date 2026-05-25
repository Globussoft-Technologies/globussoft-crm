/**
 * CommissionProfilesAdmin.test.jsx — vitest + RTL coverage for the
 * Travel-vertical commission-profiles admin page
 * (frontend/src/pages/travel/CommissionProfilesAdmin.jsx,
 * PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 3).
 *
 * Consumes the slice-2 backend (commit b5042743). The 4 profile-type form
 * shapes are flat_percent / tiered / per_pax_flat / hybrid; the page
 * builds {profileType-specific} JSON at submit time and stringifies it
 * into the profileJson field before POSTing.
 *
 * Coverage scope (12 cases):
 *   1. Page chrome — heading + filter bar + "New Profile" CTA.
 *   2. Initial GET fires /api/travel/commission-profiles on mount.
 *   3. Loaded list renders rows with profile-type + sub-brand badges.
 *   4. Empty list ([]) → "No commission profiles yet — …" copy.
 *   5. Sub-brand filter "rfu" re-fetches with ?subBrand=rfu.
 *   6. "+ New Profile" opens the modal form.
 *   7. flat_percent submission: builds {percent} + POSTs with stringified profileJson.
 *   8. tiered submission: 2 tiers built correctly into profileJson.tiers.
 *   9. Validation: empty name → notify.error + NO POST.
 *  10. Validation: profileType=flat_percent percent=0 is ALLOWED (operator may want 0% profile).
 *  11. Edit pre-fills form from row's profileJson (parse-back round-trip).
 *  12. Delete fires notify.confirm + DELETE on confirm-yes.
 *  13. (slice 8) Preview button opens the preview-calculator panel for a row.
 *  14. (slice 8) Preview submit POSTs to /:id/preview with saleAmount + paxCount
 *      and renders the returned commission + breakdown.
 *  15. (slice 8) Preview validation: empty saleAmount → notify.error + no POST.
 *  16. (slice 10) Ledger button opens the ledger panel + GETs /:id/ledger;
 *      summary tile + entries table render correctly with computed commission.
 *  17. (slice 10) "Won deals only" toggle re-fetches with ?stage=won.
 *  18. (slice 10) Empty entries[] yields the slice-10 empty-state copy.
 *  19. (slice 10) GET /:id/ledger error surfaces in the inline error region.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (Wave 11 cfb5789 / Wave 12 f59e91d).
 *   - AuthContext provided via the real App module's Provider; default
 *     user role = ADMIN.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (no fresh-per-render refs).
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
import CommissionProfilesAdmin from '../pages/travel/CommissionProfilesAdmin';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

function makeProfile(overrides = {}) {
  return {
    id: 901,
    tenantId: 1,
    name: 'Flat 5% TMC',
    subBrand: 'tmc',
    profileType: 'flat_percent',
    profileJson: JSON.stringify({ percent: 5 }),
    isActive: true,
    notes: null,
    createdAt: '2026-05-25T10:00:00.000Z',
    updatedAt: '2026-05-25T10:00:00.000Z',
    ...overrides,
  };
}

const PROFILES_DEFAULT = [
  makeProfile({ id: 901, name: 'Flat 5% TMC', subBrand: 'tmc', profileType: 'flat_percent', profileJson: JSON.stringify({ percent: 5 }) }),
  makeProfile({
    id: 902,
    name: 'RFU Tiered Ladder',
    subBrand: 'rfu',
    profileType: 'tiered',
    profileJson: JSON.stringify({ tiers: [
      { uptoCents: 500000, percent: 3 },
      { uptoCents: 2000000, percent: 5 },
    ] }),
  }),
  makeProfile({
    id: 903,
    name: 'Travel Stall Per-Pax',
    subBrand: 'travelstall',
    profileType: 'per_pax_flat',
    profileJson: JSON.stringify({ amountPerPax: 1500 }),
  }),
  makeProfile({
    id: 904,
    name: 'Visa Sure Hybrid',
    subBrand: 'visasure',
    profileType: 'hybrid',
    profileJson: JSON.stringify({ baseAmount: 500, thresholdAmount: 10000, overagePercent: 10 }),
  }),
];

function installFetchMock({
  list = { profiles: PROFILES_DEFAULT, total: PROFILES_DEFAULT.length },
  create = null,
  update = null,
  del = null,
  preview = null,
  ledger = null,
  ledgerWon = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (typeof url === 'string' && url.startsWith('/api/travel/commission-profiles')) {
      // /preview suffix routes first (POST /:id/preview)
      if (method === 'POST' && /\/\d+\/preview$/.test(url)) {
        if (preview instanceof Error) return Promise.reject(preview);
        return Promise.resolve(
          preview || {
            profileId: 901,
            profileName: 'Flat 5% TMC',
            profileType: 'flat_percent',
            saleAmount: 100000,
            paxCount: 1,
            commission: 5000,
            breakdown: 'flat_percent 5% of 100000 = 5000',
          },
        );
      }
      // /ledger suffix routes (GET /:id/ledger?stage=won)
      if (method === 'GET' && /\/\d+\/ledger(\?|$)/.test(url)) {
        const wantsWon = /[?&]stage=won/.test(url);
        const picked = wantsWon ? ledgerWon : ledger;
        if (picked instanceof Error) return Promise.reject(picked);
        return Promise.resolve(
          picked || {
            profileId: 901,
            profileName: 'Flat 5% TMC',
            profileType: 'flat_percent',
            entries: [
              {
                dealId: 4001,
                dealTitle: 'TMC School Dubai Trip',
                dealStage: 'won',
                dealAmount: 100000,
                dealCurrency: 'INR',
                contactId: 7001,
                contactName: 'Aisha Banerjee',
                commission: 5000,
                breakdown: 'flat_percent 5% of 100000 = 5000',
                createdAt: '2026-05-20T10:00:00.000Z',
              },
              {
                dealId: 4002,
                dealTitle: 'TMC College Bali Trip',
                dealStage: 'qualified',
                dealAmount: 250000,
                dealCurrency: 'INR',
                contactId: 7002,
                contactName: 'Rohan Mehta',
                commission: 12500,
                breakdown: 'flat_percent 5% of 250000 = 12500',
                createdAt: '2026-05-15T10:00:00.000Z',
              },
            ],
            totalEntries: 2,
            totalCommission: 17500,
            limit: 50,
            offset: 0,
          },
        );
      }
      if (method === 'GET') {
        if (list instanceof Error) return Promise.reject(list);
        return Promise.resolve(list);
      }
      if (method === 'POST') {
        if (create instanceof Error) return Promise.reject(create);
        return Promise.resolve(create || makeProfile({ id: 999 }));
      }
      if (method === 'PUT' && /\/\d+$/.test(url)) {
        if (update instanceof Error) return Promise.reject(update);
        return Promise.resolve(update || makeProfile({ id: 901 }));
      }
      if (method === 'DELETE' && /\/\d+$/.test(url)) {
        if (del instanceof Error) return Promise.reject(del);
        return Promise.resolve(null);
      }
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={value}>
        <CommissionProfilesAdmin />
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

describe('<CommissionProfilesAdmin /> — page chrome + initial fetch', () => {
  it('renders heading + filter bar + "New Profile" CTA (ADMIN)', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Commission Profiles/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by sub-brand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Active profiles only/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New profile/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
  });

  it('GETs /api/travel/commission-profiles on mount (active-only default → ?isActive=true)', async () => {
    renderPage();
    await waitFor(() => {
      const get = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
          && u.startsWith('/api/travel/commission-profiles')
          && (!o?.method || o.method === 'GET'),
      );
      expect(get).toBeTruthy();
      // activeOnly defaults to true, so the initial GET carries ?isActive=true.
      expect(get[0]).toContain('isActive=true');
    });
  });
});

describe('<CommissionProfilesAdmin /> — rendering', () => {
  it('renders one row per profile with profile-type badge + sub-brand badge', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    expect(screen.getByText('RFU Tiered Ladder')).toBeInTheDocument();
    expect(screen.getByText('Travel Stall Per-Pax')).toBeInTheDocument();
    expect(screen.getByText('Visa Sure Hybrid')).toBeInTheDocument();

    const row901 = screen.getByTestId('commission-profile-row-901');
    expect(within(row901).getByTestId('commission-profile-type-901')).toHaveTextContent(/Flat %/i);
    expect(within(row901).getByText('tmc')).toBeInTheDocument();

    const row902 = screen.getByTestId('commission-profile-row-902');
    expect(within(row902).getByTestId('commission-profile-type-902')).toHaveTextContent(/Tiered/i);
    expect(within(row902).getByText('rfu')).toBeInTheDocument();

    const row903 = screen.getByTestId('commission-profile-row-903');
    expect(within(row903).getByTestId('commission-profile-type-903')).toHaveTextContent(/Per-pax flat/i);

    const row904 = screen.getByTestId('commission-profile-row-904');
    expect(within(row904).getByTestId('commission-profile-type-904')).toHaveTextContent(/Hybrid/i);
  });

  it('renders empty-state copy when list is []', async () => {
    installFetchMock({ list: { profiles: [], total: 0 } });
    renderPage();
    expect(
      await screen.findByText(/No commission profiles yet — create one to define agent payouts/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Access restricted/i)).toBeNull();
  });
});

describe('<CommissionProfilesAdmin /> — filter', () => {
  it('selecting sub-brand "rfu" re-fetches with ?subBrand=rfu', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    fetchApiMock.mockClear();
    installFetchMock({ list: { profiles: [PROFILES_DEFAULT[1]], total: 1 } });
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), {
      target: { value: 'rfu' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
          && u.includes('subBrand=rfu')
          && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<CommissionProfilesAdmin /> — create modal', () => {
  it('clicking "+ New Profile" reveals the form', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    expect(screen.queryByTestId('commission-profile-form')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /New profile/i }));
    expect(screen.getByTestId('commission-profile-form')).toBeInTheDocument();
    expect(screen.getByLabelText(/Profile name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Profile type$/i)).toBeInTheDocument();
  });

  it('flat_percent submission builds {percent} + POSTs with stringified profileJson', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    fireEvent.click(screen.getByRole('button', { name: /New profile/i }));
    fireEvent.change(screen.getByLabelText(/Profile name/i), { target: { value: '  Flat 7.5% RFU  ' } });
    fireEvent.change(screen.getByLabelText(/^Sub-brand$/i), { target: { value: 'rfu' } });
    // profileType defaults to flat_percent already.
    fireEvent.change(screen.getByLabelText(/Commission percent/i), { target: { value: '7.5' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/commission-profiles' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.name).toBe('Flat 7.5% RFU'); // trimmed
      expect(body.subBrand).toBe('rfu');
      expect(body.profileType).toBe('flat_percent');
      // profileJson is the STRINGIFIED inner object (column is @db.Text)
      expect(typeof body.profileJson).toBe('string');
      expect(JSON.parse(body.profileJson)).toEqual({ percent: 7.5 });
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Flat 7\.5% RFU.*created/i));
  });

  it('tiered submission builds 2 tiers correctly into profileJson.tiers', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    fireEvent.click(screen.getByRole('button', { name: /New profile/i }));
    fireEvent.change(screen.getByLabelText(/Profile name/i), { target: { value: 'Tiered TMC Ladder' } });
    fireEvent.change(screen.getByLabelText(/^Profile type$/i), { target: { value: 'tiered' } });

    // Tier editor surfaces by data-testid="tier-editor"; row 0 is pre-seeded.
    expect(screen.getByTestId('tier-editor')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Tier 1 upto/i), { target: { value: '500000' } });
    fireEvent.change(screen.getByLabelText(/Tier 1 percent/i), { target: { value: '3' } });

    // Add a second tier.
    fireEvent.click(screen.getByRole('button', { name: /Add tier/i }));
    fireEvent.change(screen.getByLabelText(/Tier 2 upto/i), { target: { value: '2000000' } });
    fireEvent.change(screen.getByLabelText(/Tier 2 percent/i), { target: { value: '5' } });

    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/commission-profiles' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.profileType).toBe('tiered');
      const inner = JSON.parse(body.profileJson);
      expect(inner).toEqual({
        tiers: [
          { uptoCents: 500000, percent: 3 },
          { uptoCents: 2000000, percent: 5 },
        ],
      });
    });
  });

  it('validation: empty name → notify.error + NO POST fires', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    fireEvent.click(screen.getByRole('button', { name: /New profile/i }));
    // Fill in the percent so name is the only invalid field.
    fireEvent.change(screen.getByLabelText(/Commission percent/i), { target: { value: '5' } });
    fetchApiMock.mockClear();
    // Submit via direct form event so HTML5 required attribute doesn't block.
    fireEvent.submit(screen.getByTestId('commission-profile-form'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Name is required/i));
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/commission-profiles' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('validation: flat_percent with percent=0 is ALLOWED (operator may want 0% profile)', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    fireEvent.click(screen.getByRole('button', { name: /New profile/i }));
    fireEvent.change(screen.getByLabelText(/Profile name/i), { target: { value: 'Zero Commission Holdback' } });
    fireEvent.change(screen.getByLabelText(/Commission percent/i), { target: { value: '0' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/commission-profiles' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(JSON.parse(body.profileJson)).toEqual({ percent: 0 });
    });
    expect(notifyError).not.toHaveBeenCalled();
  });
});

describe('<CommissionProfilesAdmin /> — edit + delete', () => {
  it('clicking "Edit" on a tiered row pre-fills the form from the row\'s profileJson', async () => {
    renderPage();
    await screen.findByText('RFU Tiered Ladder');
    fireEvent.click(screen.getByRole('button', { name: /^Edit RFU Tiered Ladder$/ }));

    // Name + sub-brand + type pre-filled.
    expect(screen.getByLabelText(/Profile name/i).value).toBe('RFU Tiered Ladder');
    expect(screen.getByLabelText(/^Sub-brand$/i).value).toBe('rfu');
    expect(screen.getByLabelText(/^Profile type$/i).value).toBe('tiered');

    // Tier rows hydrated from the stringified profileJson.
    expect(screen.getByLabelText(/Tier 1 upto/i).value).toBe('500000');
    expect(screen.getByLabelText(/Tier 1 percent/i).value).toBe('3');
    expect(screen.getByLabelText(/Tier 2 upto/i).value).toBe('2000000');
    expect(screen.getByLabelText(/Tier 2 percent/i).value).toBe('5');
  });

  it('Delete fires notify.confirm + DELETE /api/travel/commission-profiles/:id on confirm-yes', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    notifyConfirm.mockResolvedValueOnce(true);
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Delete Flat 5% TMC$/ }));
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/commission-profiles/901' && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/deleted/i));
  });
});

describe('<CommissionProfilesAdmin /> — preview calculator (slice 8)', () => {
  it('clicking the Preview icon opens the preview-calculator panel for that row', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    expect(screen.queryByTestId('commission-profile-preview-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('commission-profile-preview-901'));
    const panel = screen.getByTestId('commission-profile-preview-panel');
    expect(panel).toBeInTheDocument();
    // Panel surfaces the profile name + type so the operator knows what
    // they're previewing. Use within() to disambiguate from the row-strong.
    expect(within(panel).getByText(/Flat 5% TMC/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Sale amount$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Pax count$/i)).toBeInTheDocument();
  });

  it('Calculate POSTs to /:id/preview and renders the returned commission + breakdown', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    fireEvent.click(screen.getByTestId('commission-profile-preview-901'));
    fireEvent.change(screen.getByLabelText(/^Sale amount$/i), { target: { value: '100000' } });
    fireEvent.change(screen.getByLabelText(/^Pax count$/i), { target: { value: '3' } });
    fetchApiMock.mockClear();
    installFetchMock({
      preview: {
        profileId: 901,
        profileName: 'Flat 5% TMC',
        profileType: 'flat_percent',
        saleAmount: 100000,
        paxCount: 3,
        commission: 5000,
        breakdown: 'flat_percent 5% of 100000 = 5000',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Calculate$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/commission-profiles/901/preview' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.saleAmount).toBe(100000);
      expect(body.paxCount).toBe(3);
    });
    // Result panel surfaces with commission + breakdown.
    const result = await screen.findByTestId('commission-profile-preview-result');
    expect(within(result).getByTestId('commission-profile-preview-amount')).toHaveTextContent(/5,000\.00/);
    expect(within(result).getByTestId('commission-profile-preview-breakdown'))
      .toHaveTextContent(/flat_percent 5% of 100000 = 5000/);
  });

  it('validation: empty saleAmount → notify.error + NO preview POST fires', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    fireEvent.click(screen.getByTestId('commission-profile-preview-901'));
    fetchApiMock.mockClear();
    // Click Calculate with saleAmount left blank — handlePreview's Number("")
    // → NaN check fires notify.error and short-circuits before POST.
    fireEvent.click(screen.getByRole('button', { name: /^Calculate$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Sale amount must be/i));
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => /\/preview$/.test(u) && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });
});

describe('<CommissionProfilesAdmin /> — ledger panel (slice 10)', () => {
  it('clicking the ledger icon GETs /:id/ledger and renders summary + entries', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    expect(screen.queryByTestId('commission-profile-ledger-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('commission-profile-ledger-901'));

    // Panel surfaces immediately; the GET fires under the effect.
    expect(screen.getByTestId('commission-profile-ledger-panel')).toBeInTheDocument();
    await waitFor(() => {
      const get = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
          && /\/api\/travel\/commission-profiles\/901\/ledger/.test(u)
          && (!o?.method || o.method === 'GET'),
      );
      expect(get).toBeTruthy();
      // No stage filter on initial open — default un-toggled chip.
      expect(get[0]).not.toContain('stage=');
    });

    // Summary tile + computed total surface after the GET resolves.
    const total = await screen.findByTestId('commission-profile-ledger-total');
    expect(total).toHaveTextContent(/17,500\.00/);

    // Both entries render with their commission columns populated.
    const row4001 = await screen.findByTestId('commission-profile-ledger-row-4001');
    expect(within(row4001).getByText('Aisha Banerjee')).toBeInTheDocument();
    expect(within(row4001).getByText('won')).toBeInTheDocument();
    expect(screen.getByTestId('commission-profile-ledger-commission-4001'))
      .toHaveTextContent(/5,000\.00/);
    expect(screen.getByTestId('commission-profile-ledger-commission-4002'))
      .toHaveTextContent(/12,500\.00/);
  });

  it('toggling "Won deals only" re-fetches with ?stage=won', async () => {
    renderPage();
    await screen.findByText('Flat 5% TMC');
    fireEvent.click(screen.getByTestId('commission-profile-ledger-901'));
    await screen.findByTestId('commission-profile-ledger-total');

    fetchApiMock.mockClear();
    installFetchMock({
      ledgerWon: {
        profileId: 901,
        profileName: 'Flat 5% TMC',
        profileType: 'flat_percent',
        entries: [
          {
            dealId: 4001,
            dealTitle: 'TMC School Dubai Trip',
            dealStage: 'won',
            dealAmount: 100000,
            dealCurrency: 'INR',
            contactId: 7001,
            contactName: 'Aisha Banerjee',
            commission: 5000,
            breakdown: 'flat_percent 5% of 100000 = 5000',
            createdAt: '2026-05-20T10:00:00.000Z',
          },
        ],
        totalEntries: 1,
        totalCommission: 5000,
        limit: 50,
        offset: 0,
      },
    });

    fireEvent.click(screen.getByTestId('commission-profile-ledger-won-toggle'));

    await waitFor(() => {
      const get = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
          && /\/api\/travel\/commission-profiles\/901\/ledger/.test(u)
          && /[?&]stage=won/.test(u)
          && (!o?.method || o.method === 'GET'),
      );
      expect(get).toBeTruthy();
    });

    // Refetched total now reflects the won-only filter.
    await waitFor(() => {
      expect(screen.getByTestId('commission-profile-ledger-total'))
        .toHaveTextContent(/5,000\.00/);
    });
  });

  it('empty entries → slice-10 empty-state copy', async () => {
    installFetchMock({
      ledger: {
        profileId: 901,
        profileName: 'Flat 5% TMC',
        profileType: 'flat_percent',
        entries: [],
        totalEntries: 0,
        totalCommission: 0,
        limit: 50,
        offset: 0,
      },
    });
    renderPage();
    await screen.findByText('Flat 5% TMC');
    fireEvent.click(screen.getByTestId('commission-profile-ledger-901'));
    expect(
      await screen.findByTestId('commission-profile-ledger-empty'),
    ).toHaveTextContent(/No deals yet under this profile/i);
    // Entries table should NOT render in the empty state.
    expect(screen.queryByTestId('commission-profile-ledger-table')).toBeNull();
  });

  it('GET error surfaces in the inline error region (no notify toast)', async () => {
    const err = Object.assign(new Error('Failed to load commission ledger'), {
      status: 500,
      body: { error: 'Failed to load commission ledger' },
    });
    installFetchMock({ ledger: err });
    renderPage();
    await screen.findByText('Flat 5% TMC');
    fireEvent.click(screen.getByTestId('commission-profile-ledger-901'));

    const errBox = await screen.findByTestId('commission-profile-ledger-error');
    expect(errBox).toHaveTextContent(/Failed to load commission ledger/);
    // Slice-10 intentionally does NOT fire notify.error for ledger fetch
    // failures — the inline region is the operator's focus already.
    expect(notifyError).not.toHaveBeenCalled();
    // Table + summary tile must NOT render on error.
    expect(screen.queryByTestId('commission-profile-ledger-table')).toBeNull();
    expect(screen.queryByTestId('commission-profile-ledger-summary')).toBeNull();
  });
});
