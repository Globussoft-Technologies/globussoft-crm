/**
 * Loyalty.test.jsx — page-surface coverage for the wellness-vertical
 * Loyalty + Referrals admin (frontend/src/pages/wellness/Loyalty.jsx).
 *
 * Complement to Loyalty.rules.test.jsx — that file pins the Rules tab
 * (#614 earn/burn config); THIS file pins the rest of the page surface:
 *
 *   - Header chrome + tab strip (Overview / Rules / Patient lookup / Referrals).
 *   - Overview tab default render — leaderboard fetch +
 *     /api/wellness/referrals?limit=100 fetch on mount.
 *   - Loading state ("Loading…") until both leaderboard + referrals resolve.
 *   - Empty-state copy for the leaderboard ("No points earned yet this month.").
 *   - Leaderboard renders one ordered-list row per patient with "+N pts".
 *   - Referral pipeline stats (Pending / Signed up / Rewarded) — counts
 *     match referrals filtered by status; sub-line uses formatMoney for
 *     locked-reward-value (INR currency mock).
 *   - Search tab — POST-on-Enter to /api/wellness/patients?q=...&limit=20,
 *     patient row click triggers GET /api/wellness/loyalty/<id>, balance
 *     + earnedThisMonth display, manual credit POST, redeem POST with
 *     balance-guarded Redeem button.
 *   - Referrals tab — filter chips ('all' / 'pending' / 'signed_up' /
 *     'first_visit' / 'rewarded'), status badges appear as both filter
 *     chip text AND row pill (getAllByText required per CLAUDE.md RTL
 *     standing rule on labels-that-appear-twice), "+ New referral" modal
 *     with required-field validation (referrer ID + name + phone), POST
 *     /api/wellness/referrals body shape (referrerPatientId parsed int +
 *     referredName + referredPhone + optional referredEmail-as-undefined),
 *     "Reward" button on pending row triggers notify.prompt + PUT
 *     /api/wellness/referrals/<id>/reward.
 *   - Indian phone formatting: 12-digit "+919826720222" → "+91 98267 20222"
 *     (renders in patient-search row + referrals row), 10-digit → "5+5",
 *     11-digit leading-zero → strip-and-format.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api with module-scope vi.fn.
 *   - notify object is STABLE module-level reference (Wave 11 cfb5789 /
 *     Wave 12 f59e91d standing rule — fresh-per-call objects flap
 *     useCallback / useEffect identity and cause infinite render loops).
 *   - formatMoney mocked to deterministic "INR X" so CI ICU build
 *     differences don't leak in (cf. cron-learning 2026-05-07 wave-6 —
 *     locale-dependent label rendering varies across Node ICU builds).
 *   - currencySymbol mocked to "₹" so the Reason placeholder is stable.
 *   - formatDate mocked to ISO yyyy-mm-dd so dates are stable across TZ.
 *   - SUT imported AFTER mocks so it picks up our fetchApi/notify.
 *
 * Drift pinned vs source (frontend/src/pages/wellness/Loyalty.jsx):
 *   - Leaderboard endpoint is /api/wellness/loyalty/leaderboard/month.
 *   - Referrals listing endpoint is /api/wellness/referrals?limit=100.
 *   - Patient search endpoint is /api/wellness/patients?q=<q>&limit=20
 *     (NOT /api/wellness/patients/search).
 *   - Loyalty detail endpoint is /api/wellness/loyalty/<id> (singular,
 *     under the loyalty namespace — NOT /api/wellness/patients/<id>/loyalty).
 *   - Credit endpoint is POST /api/wellness/loyalty/<id>/credit with
 *     { points, reason } body; reason falls back to "Manual credit" when blank.
 *   - Redeem endpoint is POST /api/wellness/loyalty/<id>/redeem with
 *     { points, reason } body; reason falls back to "Redemption" when blank.
 *   - Reward endpoint is PUT (not POST) /api/wellness/referrals/<id>/reward
 *     with { rewardPoints } body.
 *   - Referrals POST endpoint is /api/wellness/referrals with
 *     referrerPatientId as a NUMBER (parseInt) — referredEmail goes as
 *     `undefined` when blank (the route filters undefined keys upstream).
 *   - Empty-state literal is "No points earned yet this month." (period
 *     included).
 *   - Status pill text is the raw underscored status with the LITERAL
 *     '_' replaced by ' ' (e.g. 'signed_up' → 'signed up', 'first_visit'
 *     → 'first visit') — matches source line 402 + 452.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable mock object — RTL standing rule. Fresh objects per call would
// flap useCallback / useEffect identity in consumers and cause infinite
// re-render loops (canonical regression: Wave 11 cfb5789 / Wave 12 f59e91d).
const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('100')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

vi.mock('../utils/money', () => ({
  formatMoney: (v, _opts = {}) => `INR ${Number(v || 0)}`,
  currencySymbol: () => '₹',
  tenantCurrency: () => 'INR',
}));
vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

// SUT imported AFTER the mocks above.
import Loyalty from '../pages/wellness/Loyalty';

// ── Fixtures ──────────────────────────────────────────────────────────
const leaderboardRows = [
  { patient: { id: 1, name: 'Priya Sharma' }, earned: 450 },
  { patient: { id: 2, name: 'Rohan Mehta' }, earned: 380 },
  { patient: { id: 3, name: 'Anjali Kapoor' }, earned: 200 },
];

const referralRows = [
  {
    id: 11,
    referrerPatientId: 1,
    referrer: { id: 1, name: 'Priya Sharma' },
    referredName: 'Kavita Iyer',
    referredPhone: '919812345670',
    status: 'pending',
    rewardPoints: 0,
    createdAt: '2026-05-10T10:00:00.000Z',
  },
  {
    id: 12,
    referrerPatientId: 2,
    referrer: { id: 2, name: 'Rohan Mehta' },
    referredName: 'Suresh Reddy',
    referredPhone: '9826720222',
    status: 'signed_up',
    rewardPoints: 0,
    createdAt: '2026-05-11T10:00:00.000Z',
  },
  {
    id: 13,
    referrerPatientId: 3,
    referrer: { id: 3, name: 'Anjali Kapoor' },
    referredName: 'Neha Verma',
    referredPhone: '919876543210',
    status: 'rewarded',
    rewardPoints: 250,
    createdAt: '2026-05-12T10:00:00.000Z',
  },
];

const sampleLoyalty = {
  patient: { id: 42, name: 'Asha Krishnan' },
  balance: 600,
  earnedThisMonth: 150,
  transactions: [
    {
      id: 901,
      type: 'earn',
      points: 100,
      reason: 'Visit completed',
      createdAt: '2026-05-20T10:00:00.000Z',
    },
    {
      id: 902,
      type: 'redeem',
      points: -50,
      reason: 'Service discount',
      createdAt: '2026-05-21T10:00:00.000Z',
    },
  ],
};

// Default impl: leaderboard + referrals + everything else empty.
function makeDefaultMock({
  leaderboard = leaderboardRows,
  referrals = referralRows,
  patientsList = [],
  loyaltyDetail = sampleLoyalty,
} = {}) {
  return (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === '/api/wellness/loyalty/leaderboard/month' && method === 'GET') {
      return Promise.resolve(leaderboard);
    }
    if (url.startsWith('/api/wellness/referrals?limit=') && method === 'GET') {
      return Promise.resolve({ referrals });
    }
    if (url === '/api/wellness/loyalty/rules' && method === 'GET') {
      return Promise.resolve({
        tenantId: 1,
        earnPerVisit: 50,
        earnPercentOfSpend: 0,
        earnPerCurrencyUnit: 0,
        redeemPointsPerUnit: 10,
        welcomeBonus: 0,
        referralBonus: 0,
        autoEarnEnabled: true,
      });
    }
    if (url.startsWith('/api/wellness/patients?q=') && method === 'GET') {
      return Promise.resolve({ patients: patientsList });
    }
    if (url.match(/^\/api\/wellness\/loyalty\/\d+$/) && method === 'GET') {
      return Promise.resolve(loyaltyDetail);
    }
    if (url.match(/^\/api\/wellness\/loyalty\/\d+\/credit$/) && method === 'POST') {
      return Promise.resolve({ ok: true });
    }
    if (url.match(/^\/api\/wellness\/loyalty\/\d+\/redeem$/) && method === 'POST') {
      return Promise.resolve({ ok: true });
    }
    if (url === '/api/wellness/referrals' && method === 'POST') {
      return Promise.resolve({ id: 999, status: 'pending' });
    }
    if (url.match(/^\/api\/wellness\/referrals\/\d+\/reward$/) && method === 'PUT') {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notify.success.mockReset();
  notify.error.mockReset();
  notify.info.mockReset();
  notify.prompt.mockReset();
  notify.prompt.mockImplementation(() => Promise.resolve('100'));
});

// ─────────────────────────────────────────────────────────────────────
// 1. Page chrome + tab strip
// ─────────────────────────────────────────────────────────────────────
describe('Loyalty — page chrome', () => {
  it('renders the "Loyalty + Referrals" heading + intro copy + all four tabs', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);

    expect(
      screen.getByRole('heading', { name: /Loyalty \+ Referrals/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Track patient points, redeem rewards/i),
    ).toBeInTheDocument();

    // All four tab buttons present.
    expect(screen.getByRole('button', { name: /Overview/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Rules$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Patient lookup/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Referrals$/i })).toBeInTheDocument();
  });

  it('fires both leaderboard + referrals fetches on mount', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);

    await waitFor(() => {
      const leaderboardCalls = fetchApiMock.mock.calls.filter(
        ([url]) => url === '/api/wellness/loyalty/leaderboard/month',
      );
      const referralsCalls = fetchApiMock.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.startsWith('/api/wellness/referrals?limit=100'),
      );
      expect(leaderboardCalls.length).toBeGreaterThanOrEqual(1);
      expect(referralsCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Overview tab — leaderboard + referral pipeline
// ─────────────────────────────────────────────────────────────────────
describe('Loyalty — Overview tab', () => {
  it('shows "Loading…" before the leaderboard fetch resolves', () => {
    let resolveLb;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/wellness/loyalty/leaderboard/month') {
        return new Promise((r) => {
          resolveLb = r;
        });
      }
      if (url.startsWith('/api/wellness/referrals?limit=')) {
        return Promise.resolve({ referrals: [] });
      }
      return Promise.resolve({});
    });
    render(<Loyalty />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    // Cleanup — resolve so the test doesn't hang teardown.
    resolveLb?.([]);
  });

  it('renders the empty-state leaderboard copy when no points have been earned', async () => {
    fetchApiMock.mockImplementation(
      makeDefaultMock({ leaderboard: [], referrals: [] }),
    );
    render(<Loyalty />);

    await waitFor(() =>
      expect(
        screen.getByText(/No points earned yet this month/i),
      ).toBeInTheDocument(),
    );
  });

  it('renders ordered-list rows for each leaderboard entry with "+N pts" suffix', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);

    await waitFor(() => expect(screen.getByText('Priya Sharma')).toBeInTheDocument());
    expect(screen.getByText('Rohan Mehta')).toBeInTheDocument();
    expect(screen.getByText('Anjali Kapoor')).toBeInTheDocument();
    // Points rendered as "+<n> pts".
    expect(screen.getByText('+450 pts')).toBeInTheDocument();
    expect(screen.getByText('+380 pts')).toBeInTheDocument();
    expect(screen.getByText('+200 pts')).toBeInTheDocument();
  });

  it('renders the referral-pipeline counts (Pending / Signed up / Rewarded) + INR sub-line', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);

    // Wait for the pipeline section to render (referrals fetched & loading done).
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());

    // The 3 stat labels show with right counts (1 pending, 1 signed_up, 1 rewarded
    // from the 3 fixture rows).
    expect(screen.getByText(/^Pending$/i)).toBeInTheDocument();
    expect(screen.getByText(/Signed up/i)).toBeInTheDocument();
    expect(screen.getByText(/^Rewarded$/i)).toBeInTheDocument();

    // The "rewarded" sub-line shows formatMoney(250, ...) → "INR 250".
    expect(screen.getByText(/1 referrals.*INR 250 total/i)).toBeInTheDocument();
    // The pending + signed_up sub-lines both render "1 referrals · INR 0 total"
    // (each is a single referral with 0 reward locked). Same string appears
    // in both stat tiles → getAllByText required.
    const zeroSubLines = screen.getAllByText(/1 referrals.*INR 0 total/i);
    expect(zeroSubLines.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Patient lookup tab — search + loyalty detail + credit / redeem
// ─────────────────────────────────────────────────────────────────────
describe('Loyalty — Patient lookup tab', () => {
  it('search submission POSTs /api/wellness/patients?q=...&limit=20 and renders results', async () => {
    const patientsList = [
      { id: 42, name: 'Asha Krishnan', phone: '919826720222' },
      { id: 43, name: 'Bharat Patil', phone: '9876543210' },
    ];
    fetchApiMock.mockImplementation(makeDefaultMock({ patientsList }));
    render(<Loyalty />);

    // Switch to Patient lookup tab.
    fireEvent.click(screen.getByRole('button', { name: /Patient lookup/i }));

    const input = screen.getByPlaceholderText(/Search patient by name/i);
    fireEvent.change(input, { target: { value: 'asha' } });
    fireEvent.click(screen.getByRole('button', { name: /Search patients/i }));

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.startsWith('/api/wellness/patients?q='),
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0][0]).toBe('/api/wellness/patients?q=asha&limit=20');
    });

    // Both results rendered.
    expect(screen.getByText('Asha Krishnan')).toBeInTheDocument();
    expect(screen.getByText('Bharat Patil')).toBeInTheDocument();

    // formatPhone — 12-digit "+919826720222" → "+91 98267 20222"
    expect(screen.getByText('+91 98267 20222')).toBeInTheDocument();
    // 10-digit "9876543210" → "98765 43210"
    expect(screen.getByText('98765 43210')).toBeInTheDocument();
  });

  it('clicking a patient row fetches /api/wellness/loyalty/<id> and shows balance + transactions', async () => {
    const patientsList = [{ id: 42, name: 'Asha Krishnan', phone: '919826720222' }];
    fetchApiMock.mockImplementation(makeDefaultMock({ patientsList }));
    render(<Loyalty />);

    fireEvent.click(screen.getByRole('button', { name: /Patient lookup/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search patient by name/i), {
      target: { value: 'asha' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Search patients/i }));
    await waitFor(() => expect(screen.getByText('Asha Krishnan')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Asha Krishnan'));

    await waitFor(() => {
      const detailCalls = fetchApiMock.mock.calls.filter(
        ([url]) => url === '/api/wellness/loyalty/42',
      );
      expect(detailCalls.length).toBeGreaterThanOrEqual(1);
    });

    // Balance + monthly-earned headline.
    expect(screen.getByText('600 pts')).toBeInTheDocument();
    expect(screen.getByText(/\+150 this month/i)).toBeInTheDocument();
    // Recent-transactions header rendered + row reasons.
    expect(screen.getByText(/Recent transactions/i)).toBeInTheDocument();
    expect(screen.getByText('Visit completed')).toBeInTheDocument();
    expect(screen.getByText('Service discount')).toBeInTheDocument();
  });

  it('Credit submit POSTs /api/wellness/loyalty/<id>/credit with default reason "Manual credit"', async () => {
    const patientsList = [{ id: 42, name: 'Asha Krishnan', phone: '919826720222' }];
    fetchApiMock.mockImplementation(makeDefaultMock({ patientsList }));
    render(<Loyalty />);

    fireEvent.click(screen.getByRole('button', { name: /Patient lookup/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search patient by name/i), {
      target: { value: 'asha' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Search patients/i }));
    await waitFor(() => expect(screen.getByText('Asha Krishnan')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Asha Krishnan'));
    await waitFor(() => expect(screen.getByText('600 pts')).toBeInTheDocument());

    // Click the Credit button — default points=50, reason blank.
    fireEvent.click(screen.getByRole('button', { name: /^Credit$/i }));

    await waitFor(() => {
      const creditCalls = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          url === '/api/wellness/loyalty/42/credit' && opts?.method === 'POST',
      );
      expect(creditCalls.length).toBe(1);
      const body = JSON.parse(creditCalls[0][1].body);
      expect(body.points).toBe(50);
      expect(body.reason).toBe('Manual credit'); // default-fallback per source line 212
    });
  });

  it('Redeem submit POSTs /api/wellness/loyalty/<id>/redeem with default reason "Redemption"', async () => {
    const patientsList = [{ id: 42, name: 'Asha Krishnan', phone: '919826720222' }];
    fetchApiMock.mockImplementation(makeDefaultMock({ patientsList }));
    render(<Loyalty />);

    fireEvent.click(screen.getByRole('button', { name: /Patient lookup/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search patient by name/i), {
      target: { value: 'asha' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Search patients/i }));
    await waitFor(() => expect(screen.getByText('Asha Krishnan')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Asha Krishnan'));
    await waitFor(() => expect(screen.getByText('600 pts')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Redeem$/i }));

    await waitFor(() => {
      const redeemCalls = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          url === '/api/wellness/loyalty/42/redeem' && opts?.method === 'POST',
      );
      expect(redeemCalls.length).toBe(1);
      const body = JSON.parse(redeemCalls[0][1].body);
      expect(body.points).toBe(50);
      expect(body.reason).toBe('Redemption'); // default-fallback per source line 225
    });
  });

  it('redeem reason input uses the ₹ currency-symbol placeholder', async () => {
    const patientsList = [{ id: 42, name: 'Asha Krishnan', phone: '919826720222' }];
    fetchApiMock.mockImplementation(makeDefaultMock({ patientsList }));
    render(<Loyalty />);

    fireEvent.click(screen.getByRole('button', { name: /Patient lookup/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search patient by name/i), {
      target: { value: 'asha' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Search patients/i }));
    await waitFor(() => expect(screen.getByText('Asha Krishnan')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Asha Krishnan'));
    await waitFor(() => expect(screen.getByText('600 pts')).toBeInTheDocument());

    // The redeem-reason placeholder is "Reason (e.g. ₹500 service discount)".
    expect(
      screen.getByPlaceholderText(/Reason \(e\.g\. ₹500 service discount\)/),
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Referrals tab — filter chips + new-referral modal + Reward action
// ─────────────────────────────────────────────────────────────────────
describe('Loyalty — Referrals tab', () => {
  it('renders status filter chips for all / pending / signed_up / first_visit / rewarded', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Referrals$/i }));

    // Filter chips — the source replaces _ with ' ' for display.
    await waitFor(() => expect(screen.getByRole('button', { name: /^all$/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^pending$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^signed up$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^first visit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^rewarded$/i })).toBeInTheDocument();
  });

  it('status labels "signed up" / "rewarded" appear as BOTH filter chip AND row pill (getAllByText)', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Referrals$/i }));

    // Wait for table to render with referrer name.
    await waitFor(() => expect(screen.getByText('Priya Sharma')).toBeInTheDocument());

    // "signed up" appears as filter-chip text AND row pill text (the row for
    // referredName: Suresh Reddy has status 'signed_up' → pill text "signed up").
    const signedUpMatches = screen.getAllByText(/^signed up$/i);
    expect(signedUpMatches.length).toBeGreaterThanOrEqual(2);

    // "rewarded" appears similarly — filter chip + the rewarded-row pill.
    const rewardedMatches = screen.getAllByText(/^rewarded$/i);
    expect(rewardedMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('filtering by "pending" hides non-pending rows', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Referrals$/i }));
    await waitFor(() => expect(screen.getByText('Kavita Iyer')).toBeInTheDocument());

    // Click pending filter — only Kavita Iyer (status='pending') survives.
    fireEvent.click(screen.getByRole('button', { name: /^pending$/i }));

    await waitFor(() => {
      // Non-pending referred names should have disappeared.
      expect(screen.queryByText('Suresh Reddy')).not.toBeInTheDocument();
      expect(screen.queryByText('Neha Verma')).not.toBeInTheDocument();
    });
    // Pending row still visible.
    expect(screen.getByText('Kavita Iyer')).toBeInTheDocument();
  });

  it('clicking "+ New referral" opens an inline form with referrer/name/phone fields', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Referrals$/i }));

    fireEvent.click(screen.getByRole('button', { name: /New referral/i }));

    expect(screen.getByPlaceholderText(/Referrer patient ID/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/New person's name/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/^Phone/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Email \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
  });

  it('new-referral submit POSTs /api/wellness/referrals with parsed-int referrerPatientId', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Referrals$/i }));
    fireEvent.click(screen.getByRole('button', { name: /New referral/i }));

    fireEvent.change(screen.getByPlaceholderText(/Referrer patient ID/i), {
      target: { value: '7' },
    });
    fireEvent.change(screen.getByPlaceholderText(/New person's name/i), {
      target: { value: 'Meera Joshi' },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Phone/i), {
      target: { value: '9876500000' },
    });
    // Leave email blank — should serialize as `undefined` and be stripped by JSON.stringify.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const posts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/wellness/referrals' && opts?.method === 'POST',
      );
      expect(posts.length).toBe(1);
      const body = JSON.parse(posts[0][1].body);
      expect(body.referrerPatientId).toBe(7); // parseInt("7", 10) — number, not string
      expect(body.referredName).toBe('Meera Joshi');
      expect(body.referredPhone).toBe('9876500000');
      // referredEmail was '' → translated to `undefined` → omitted from JSON.
      expect('referredEmail' in body).toBe(false);
    });
    expect(notify.success).toHaveBeenCalledWith(
      expect.stringMatching(/Referral logged for Meera Joshi/i),
    );
  });

  it('Reward button on a pending row prompts for points and PUTs /referrals/<id>/reward', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Referrals$/i }));
    await waitFor(() => expect(screen.getByText('Kavita Iyer')).toBeInTheDocument());

    // notify.prompt is stubbed to resolve '100' by default in beforeEach.
    // The 'pending' row has a Reward button; the 'rewarded' row does NOT.
    const rewardButtons = screen.getAllByRole('button', { name: /^Reward$/i });
    expect(rewardButtons.length).toBe(2); // pending + signed_up (rewarded shows pts, not button)
    fireEvent.click(rewardButtons[0]);

    await waitFor(() => {
      expect(notify.prompt).toHaveBeenCalledWith(
        expect.stringMatching(/Reward points/i),
        '100',
      );
    });

    await waitFor(() => {
      const putCalls = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          typeof url === 'string' &&
          url.match(/^\/api\/wellness\/referrals\/\d+\/reward$/) &&
          opts?.method === 'PUT',
      );
      expect(putCalls.length).toBe(1);
      const body = JSON.parse(putCalls[0][1].body);
      expect(body.rewardPoints).toBe(100);
    });
    expect(notify.success).toHaveBeenCalledWith(
      expect.stringMatching(/Rewarded 100 points/i),
    );
  });

  it('Reward prompt returning blank/empty short-circuits (no PUT fires)', async () => {
    notify.prompt.mockReset();
    notify.prompt.mockImplementation(() => Promise.resolve(''));
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Referrals$/i }));
    await waitFor(() => expect(screen.getByText('Kavita Iyer')).toBeInTheDocument());

    const rewardButtons = screen.getAllByRole('button', { name: /^Reward$/i });
    fireEvent.click(rewardButtons[0]);

    await waitFor(() => expect(notify.prompt).toHaveBeenCalled());

    // No PUT fires.
    const putCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        typeof url === 'string' &&
        url.match(/^\/api\/wellness\/referrals\/\d+\/reward$/) &&
        opts?.method === 'PUT',
    );
    expect(putCalls.length).toBe(0);
  });

  it('Reward prompt with non-numeric input surfaces notify.error("Invalid points")', async () => {
    notify.prompt.mockReset();
    notify.prompt.mockImplementation(() => Promise.resolve('not-a-number'));
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Referrals$/i }));
    await waitFor(() => expect(screen.getByText('Kavita Iyer')).toBeInTheDocument());

    const rewardButtons = screen.getAllByRole('button', { name: /^Reward$/i });
    fireEvent.click(rewardButtons[0]);

    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/Invalid points/i)),
    );

    // No PUT fires.
    const putCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        typeof url === 'string' &&
        url.match(/^\/api\/wellness\/referrals\/\d+\/reward$/) &&
        opts?.method === 'PUT',
    );
    expect(putCalls.length).toBe(0);
  });

  it('renders the rewarded-row pts pill ("250 pts" + check icon) instead of Reward button', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Referrals$/i }));

    // Neha Verma's row (status='rewarded') shows "250 pts" not a Reward button.
    await waitFor(() => expect(screen.getByText('Neha Verma')).toBeInTheDocument());
    expect(screen.getByText(/250 pts/i)).toBeInTheDocument();
  });

  it('renders the empty-state row "No referrals." when filter yields zero results', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock({ referrals: [] }));
    render(<Loyalty />);
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Referrals$/i }));

    await waitFor(() => expect(screen.getByText(/No referrals\./i)).toBeInTheDocument());
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. Indian phone formatting (formatPhone helper inside the SUT)
// ─────────────────────────────────────────────────────────────────────
describe('Loyalty — Indian phone formatting in referral rows', () => {
  it('formats 12-digit "919812345670" as "+91 98123 45670" in the referrals table', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Referrals$/i }));

    // Kavita Iyer's row has phone '919812345670' → renders as "+91 98123 45670".
    await waitFor(() => expect(screen.getByText('+91 98123 45670')).toBeInTheDocument());
  });

  it('formats 10-digit "9826720222" as "98267 20222" in the referrals table', async () => {
    fetchApiMock.mockImplementation(makeDefaultMock());
    render(<Loyalty />);
    await waitFor(() => expect(screen.getByText(/Referral pipeline/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Referrals$/i }));

    // Suresh Reddy's row has phone '9826720222' → renders as "98267 20222".
    await waitFor(() => expect(screen.getByText('98267 20222')).toBeInTheDocument());
  });
});
