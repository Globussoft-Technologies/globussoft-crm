/**
 * Recommendations.test.jsx — vitest + RTL coverage for the wellness-vertical
 * orchestrator-engine recommendation cards admin page
 * (frontend/src/pages/wellness/Recommendations.jsx).
 *
 * Scope: pins the page-surface invariants for the per-tenant AgentRecommendation
 * queue — heading + "Run now" CTA, loading state, GET on mount with status
 * filter, dual-fetch (filtered list + status=all for counter chips), empty-
 * state copy, recommendation-card render (priority chip + typeLabel + goal +
 * createdAt + title + body + expectedImpact panel), filter-chip click changes
 * filter + refetches, action buttons appear only on pending rows (status=
 * approved/rejected rows render "Status: <s>" text instead), approve flow
 * (POST /api/wellness/recommendations/:id/approve + notify.success with
 * dispatcher detail string from result._actionResult, then refetch), reject
 * flow gated by destructive confirm dialog (rejected aborts → no POST;
 * accepted → POST + notify.success), high-stakes approve gated by extra
 * confirm dialog for type ∈ {send_sms_blast, mark_leads_for_callback,
 * lead_followup}, "Run now" button triggers POST /api/wellness/orchestrator/run
 * + dispatches success/info copy based on result.created count.
 *
 * Test cases (11):
 *   1. Heading "Agent Recommendations" + sub-copy + "Run now" CTA render.
 *   2. Loading state: "Loading…" renders while the initial GET is in flight.
 *   3. Mount: dual GET fires — one with status=pending (default filter), one
 *      with status=all (for counter chips); cards render from filtered list.
 *   4. Filter chips: pending / approved / rejected / all render with per-stage
 *      count parenthetical drawn from the status=all fetch.
 *   5. Empty-state: filtered list resolves to [] → "No recommendations in this
 *      stage yet — new suggestions are generated daily." renders.
 *   6. Card render: pending row shows priority chip + typeLabel + goal +
 *      title + body + expectedImpact panel + Approve/Reject CTAs.
 *   7. Non-pending row: approved row renders "Status: approved" text instead
 *      of Approve/Reject buttons.
 *   8. Approve flow: clicking Approve on a low-stakes type (occupancy_alert)
 *      POSTs /api/wellness/recommendations/:id/approve immediately (no
 *      confirm), notify.success uses dispatcher detail from
 *      result._actionResult.action=task_created → " — task created", refetch
 *      fires.
 *   9. Reject flow: Reject CTA fires notify.confirm({destructive:true});
 *      cancel → no POST; confirm → POST /api/wellness/recommendations/:id/
 *      reject + notify.success("Recommendation rejected").
 *  10. High-stakes approve: type=send_sms_blast triggers an extra confirm
 *      dialog citing SMS fanout copy; cancel → no POST.
 *  11. "Run now" CTA: POST /api/wellness/orchestrator/run; result.created>0
 *      → notify.success("Generated N new recommendation(s)."); created=0
 *      → notify.info("Orchestrator ran — no new recommendations…"); refetch.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/) with a
 *     stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap useCallback dep identity).
 *   - notifyObj.confirm() is a per-test override (vi.fn() resolving
 *     true/false) so the gated reject + high-stakes approve branches can be
 *     pinned both ways.
 *   - SUT does NOT consume AuthContext → no Provider wrapper. MemoryRouter is
 *     defensive (none of SUT's imports use react-router but its sibling
 *     pages do).
 *   - vi.mock paths are `../utils/api` and `../utils/notify` relative to the
 *     flat top-level `__tests__/` directory.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "snooze flow (if present)". REALITY: SUT has NO
 *     snooze capability — only approve / reject. AgentRecommendation status
 *     transitions are pending → approved | rejected (terminal). Omitted.
 *   - Prompt anticipated "accept flow". REALITY: SUT calls it "approve"
 *     (button label "Approve", action="approve", endpoint /:id/approve).
 *     Renamed to "approve" throughout.
 *   - Prompt anticipated "PATCH to right endpoint" for action mutations.
 *     REALITY: SUT uses POST /api/wellness/recommendations/:id/approve and
 *     POST /api/wellness/recommendations/:id/reject (SUT line 116). Pinned
 *     POST verbatim.
 *   - Prompt anticipated "card disappears or fades on dismiss". REALITY:
 *     after the action POST resolves, SUT calls load() which re-fetches the
 *     filtered list — the row only disappears if the new filtered list
 *     doesn't include it. The test mock controls this directly via the next
 *     resolved list; we assert the POST + the load() refetch instead of DOM
 *     animation.
 *   - Prompt anticipated "priority filter (high/med/low)". REALITY: SUT only
 *     exposes a STATUS filter (pending/approved/rejected/all). Priority is
 *     rendered as a chip on each card but is NOT a filter axis. Omitted
 *     priority-filter case.
 *   - Prompt anticipated "agent type filter". REALITY: SUT does NOT filter by
 *     type. typeLabel is rendered on each card but is NOT a filter axis.
 *     Omitted.
 *   - Prompt anticipated "sort order: cards ordered by priority/created-at".
 *     REALITY: SUT renders items in the order returned by the API (no
 *     client-side sort — SUT line 207 `items.map`). Sort order is a backend
 *     contract, covered by recommendations-api.spec.js. Omitted in-page test.
 *   - Prompt anticipated "RBAC: USER hides mutation CTAs only if SUT
 *     enforces". CONFIRMED backend-only: the SUT does NOT consume AuthContext
 *     and does NOT branch on role. Every authenticated client sees Approve /
 *     Reject / Run now CTAs. SUT lines 42 + 144 handle the 403 from the
 *     backend with `notify.info('… requires admin or manager.')`. Omitted
 *     in-page RBAC test (the 403-toast path is exercised in api spec).
 *   - Prompt anticipated "Loading…" verbatim. CONFIRMED — SUT line 189
 *     renders "Loading…" exactly. Pin via /^Loading…$/.
 *   - Prompt anticipated "error handling: 500 → silent degrade or
 *     notify.error". CONFIRMED silent-degrade: SUT line 52
 *     `.catch(() => setItems([]))` swallows errors silently → empty-state
 *     surfaces. Behaviour is identical to case 5 (empty-state). Omitted
 *     error-branch case as it's structurally indistinguishable from
 *     empty-state.
 *   - Backend endpoint confirmed at /api/wellness/recommendations (SUT lines
 *     50, 56) + /api/wellness/recommendations/:id/{approve,reject} (line 116)
 *     + /api/wellness/orchestrator/run (line 33).
 *
 * Path: flat __tests__/Recommendations.test.jsx — matches sibling
 * Locations / Drugs / OwnerDashboard flat-path convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789, Wave 12 f59e91d).
// confirm is a vi.fn so individual tests can flip resolved-value to true/false
// for the reject + high-stakes-approve dialog branches.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import Recommendations from '../pages/wellness/Recommendations';

// Fixture: 3 pending + 1 approved + 1 rejected so counter chips have data.
const PENDING_OCCUPANCY = {
  id: 4101,
  type: 'occupancy_alert',
  title: 'Friday afternoon under-booked at Ranchi',
  body: 'Only 35% of 2pm-6pm Friday slots are booked next week. Push a same-day promo SMS to last-month walk-ins.',
  priority: 'medium',
  status: 'pending',
  goalContext: 'Lift weekday afternoon utilisation to 65%',
  expectedImpact: '~14 additional bookings this Friday',
  createdAt: '2026-05-24T01:00:00Z',
};
const PENDING_SMS_BLAST = {
  id: 4102,
  type: 'send_sms_blast',
  title: 'SMS the 187 lead-status contacts about the Diwali offer',
  body: 'Lead-status contacts older than 14d with no follow-up. Send the active 15%-off Diwali campaign SMS.',
  priority: 'high',
  status: 'pending',
  createdAt: '2026-05-24T00:30:00Z',
};
const PENDING_CAMPAIGN = {
  id: 4103,
  type: 'campaign_boost',
  title: 'Boost the hair-restoration ad spend by 25%',
  body: 'CTR rose to 4.2% this week — bump the daily budget on the Diwali hair-restoration creative.',
  priority: 'low',
  status: 'pending',
  createdAt: '2026-05-23T18:00:00Z',
};
const APPROVED_REC = {
  id: 4090,
  type: 'lead_followup',
  title: 'Follow up with last week\'s no-shows',
  body: '5 patients booked but did not show. Telecaller outreach today.',
  priority: 'medium',
  status: 'approved',
  createdAt: '2026-05-22T10:00:00Z',
  resolvedAt: '2026-05-22T11:30:00Z',
};
const REJECTED_REC = {
  id: 4080,
  type: 'schedule_gap',
  title: 'Add a Sunday slot for Dr Sharma',
  body: 'Sunday morning has 3 inbound enquiries with no available slot.',
  priority: 'low',
  status: 'rejected',
  createdAt: '2026-05-20T08:00:00Z',
  resolvedAt: '2026-05-20T09:15:00Z',
};

const ALL_FIXTURE = [PENDING_OCCUPANCY, PENDING_SMS_BLAST, PENDING_CAMPAIGN, APPROVED_REC, REJECTED_REC];
const PENDING_ONLY = [PENDING_OCCUPANCY, PENDING_SMS_BLAST, PENDING_CAMPAIGN];
const APPROVED_ONLY = [APPROVED_REC];

function installFetchMock({
  filteredList = PENDING_ONLY,
  filteredPromise = null,
  allList = ALL_FIXTURE,
  approveResult = { ok: true, _actionResult: { ok: true, action: 'task_created' } },
  rejectResult = { ok: true },
  runResult = { ok: true, created: 2 },
} = {}) {
  fetchApiMock.mockImplementation((url, opts = {}) => {
    const method = opts.method || 'GET';
    // GET /api/wellness/recommendations?status=<filter>
    if (url.startsWith('/api/wellness/recommendations?') && method === 'GET') {
      const isAll = /status=all/.test(url);
      if (isAll) return Promise.resolve(allList);
      if (filteredPromise) return filteredPromise;
      return Promise.resolve(filteredList);
    }
    // POST /api/wellness/recommendations/:id/approve
    if (/^\/api\/wellness\/recommendations\/\d+\/approve$/.test(url) && method === 'POST') {
      return Promise.resolve(approveResult);
    }
    // POST /api/wellness/recommendations/:id/reject
    if (/^\/api\/wellness\/recommendations\/\d+\/reject$/.test(url) && method === 'POST') {
      return Promise.resolve(rejectResult);
    }
    // POST /api/wellness/orchestrator/run
    if (url === '/api/wellness/orchestrator/run' && method === 'POST') {
      return Promise.resolve(runResult);
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Recommendations />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  // Default: confirm resolves true (proceed). Per-test override flips this.
  notifyConfirm.mockImplementation(() => Promise.resolve(true));
});

describe('<Recommendations /> — page chrome', () => {
  it('renders heading "Agent Recommendations" + sub-copy + "Run now" CTA', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Agent Recommendations/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Proposals from the orchestration agent/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Run now/i }),
    ).toBeInTheDocument();
  });

  it('renders "Loading…" while the initial GET is in flight', async () => {
    // Block the filtered fetch indefinitely to pin the loading branch.
    installFetchMock({ filteredPromise: new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<Recommendations /> — mount fetch + card render', () => {
  it('fires dual GET on mount (status=pending + status=all) and renders cards', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(calls).toContain('/api/wellness/recommendations?status=pending');
      expect(calls).toContain('/api/wellness/recommendations?status=all');
    });
    // Cards from the filtered list render — pin via title text.
    expect(
      await screen.findByRole('heading', {
        level: 3,
        name: /Friday afternoon under-booked at Ranchi/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: /SMS the 187 lead-status contacts/i,
      }),
    ).toBeInTheDocument();
  });

  it('renders the 4 filter chips with per-stage count from the status=all fetch', async () => {
    installFetchMock();
    renderPage();
    // Wait until the status=all fetch has resolved + counters populate.
    await waitFor(() => {
      // pending=3, approved=1, rejected=1, all=5 per fixture.
      const pendingChip = screen.getByRole('button', { name: /^pending \(3\)$/i });
      expect(pendingChip).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: /^approved \(1\)$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^rejected \(1\)$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^all \(5\)$/i }),
    ).toBeInTheDocument();
  });

  it('renders empty-state copy when the filtered list resolves to []', async () => {
    installFetchMock({ filteredList: [], allList: [] });
    renderPage();
    expect(
      await screen.findByText(
        /No recommendations in this stage yet — new suggestions are generated daily\./i,
      ),
    ).toBeInTheDocument();
  });

  it('pending card renders priority chip + typeLabel + goal + title + body + expectedImpact + Approve/Reject CTAs', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: /Friday afternoon under-booked at Ranchi/i,
        }),
      ).toBeInTheDocument();
    });
    // priority chip — typeLabel for occupancy_alert is "Occupancy" (SUT line 9).
    expect(screen.getAllByText(/^medium$/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Occupancy')).toBeInTheDocument();
    // goalContext rendered with "• Goal:" prefix. The matcher resolves on
    // both the wrapping span and ancestor div (the chip-row container) →
    // getAllByText with >=1.
    expect(
      screen.getAllByText((_t, el) =>
        /Goal: Lift weekday afternoon utilisation to 65%/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // body text.
    expect(
      screen.getByText(/Only 35% of 2pm-6pm Friday slots are booked next week/i),
    ).toBeInTheDocument();
    // expectedImpact panel — the matcher resolves on both the wrapping
    // div and its inner content node → getAllByText with >=1.
    expect(
      screen.getAllByText((_t, el) =>
        /Expected impact:.*14 additional bookings this Friday/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // Approve + Reject CTAs visible on a pending card.
    expect(
      screen.getAllByRole('button', { name: /Approve/i }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByRole('button', { name: /Reject/i }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('non-pending row renders "Status: <s>" text instead of Approve/Reject buttons', async () => {
    installFetchMock({ filteredList: APPROVED_ONLY });
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: /Follow up with last week's no-shows/i,
        }),
      ).toBeInTheDocument();
    });
    // "Status: approved" rendered for non-pending rows (SUT line 256). The
    // matcher resolves on both the inner span and ancestor div → getAllByText
    // with >=1.
    expect(
      screen.getAllByText((_t, el) =>
        /Status:\s*approved/i.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // Approve/Reject CTAs absent for this row's panel. The page-level chip
    // bar still has an "approved" chip, but the role=button for /Approve\b/
    // is only attached to action CTAs.
    expect(
      screen.queryByRole('button', { name: /^Approve$/i }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /^Reject$/i }),
    ).toBeNull();
  });
});

describe('<Recommendations /> — approve action', () => {
  it('low-stakes approve → POST /:id/approve immediately + notify.success with dispatcher detail + refetch', async () => {
    installFetchMock({
      approveResult: { ok: true, _actionResult: { ok: true, action: 'task_created' } },
    });
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: /Friday afternoon under-booked at Ranchi/i,
        }),
      ).toBeInTheDocument();
    });
    // PENDING_OCCUPANCY is the first card (id=4101). Approve is the first
    // Approve button. Type=occupancy_alert is NOT high-stakes, so no extra
    // confirm dialog fires (SUT lines 96-110 only confirm for send_sms_blast
    // / mark_leads_for_callback / lead_followup types).
    const approveButtons = screen.getAllByRole('button', { name: /^Approve$/i });
    fireEvent.click(approveButtons[0]);
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/recommendations/4101/approve' &&
          opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
    });
    // No confirm dialog fired (low-stakes type).
    expect(notifyConfirm).not.toHaveBeenCalled();
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Approved.*task created/i),
    );
    // refetch fired after success → expect at least 4 GETs total (2 on mount +
    // 2 on refetch — filtered + all).
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        u.startsWith('/api/wellness/recommendations?') &&
        (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(4);
  });
});

describe('<Recommendations /> — reject action (gated by destructive confirm)', () => {
  it('Reject cancelled in confirm dialog → no POST fires', async () => {
    installFetchMock();
    notifyConfirm.mockImplementationOnce(() => Promise.resolve(false));
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: /Friday afternoon under-booked at Ranchi/i,
        }),
      ).toBeInTheDocument();
    });
    const rejectButtons = screen.getAllByRole('button', { name: /^Reject$/i });
    fireEvent.click(rejectButtons[0]);
    // confirm dialog must have been invoked with destructive:true (SUT line 84).
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ destructive: true }),
      );
    });
    // No POST to reject endpoint — user cancelled.
    const rejectPost = fetchApiMock.mock.calls.find(
      ([u, opts]) =>
        /\/reject$/.test(u) && opts?.method === 'POST',
    );
    expect(rejectPost).toBeUndefined();
    expect(notifySuccess).not.toHaveBeenCalled();
  });

  it('Reject confirmed → POST /:id/reject + notify.success("Recommendation rejected")', async () => {
    installFetchMock();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: /Friday afternoon under-booked at Ranchi/i,
        }),
      ).toBeInTheDocument();
    });
    const rejectButtons = screen.getAllByRole('button', { name: /^Reject$/i });
    fireEvent.click(rejectButtons[0]);
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/recommendations/4101/reject' &&
          opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith('Recommendation rejected');
  });
});

describe('<Recommendations /> — high-stakes approve (gated by confirm)', () => {
  it('send_sms_blast approve cancelled in confirm dialog → no POST fires', async () => {
    installFetchMock();
    notifyConfirm.mockImplementationOnce(() => Promise.resolve(false));
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: /SMS the 187 lead-status contacts/i,
        }),
      ).toBeInTheDocument();
    });
    // PENDING_SMS_BLAST is the second card (id=4102). Its Approve button is
    // index 1 in the Approve-button list.
    const approveButtons = screen.getAllByRole('button', { name: /^Approve$/i });
    fireEvent.click(approveButtons[1]);
    // confirm must have fired with the SMS-fanout copy (SUT lines 98-105).
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/queue SMS messages/i),
        }),
      );
    });
    const approvePost = fetchApiMock.mock.calls.find(
      ([u, opts]) =>
        u === '/api/wellness/recommendations/4102/approve' &&
        opts?.method === 'POST',
    );
    expect(approvePost).toBeUndefined();
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});

describe('<Recommendations /> — "Run now" orchestrator trigger', () => {
  it('Run now → POST /api/wellness/orchestrator/run + notify.success on created>0 + refetch', async () => {
    installFetchMock({ runResult: { ok: true, created: 3 } });
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: /Friday afternoon under-booked at Ranchi/i,
        }),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Run now/i }));
    await waitFor(() => {
      const runCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/orchestrator/run' && opts?.method === 'POST',
      );
      expect(runCall).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Generated 3 new recommendations/i),
    );
  });

  it('Run now with created=0 → notify.info("Orchestrator ran — no new recommendations…")', async () => {
    installFetchMock({ runResult: { ok: true, created: 0 } });
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: /Friday afternoon under-booked at Ranchi/i,
        }),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Run now/i }));
    await waitFor(() => {
      expect(notifyInfo).toHaveBeenCalledWith(
        expect.stringMatching(/no new recommendations/i),
      );
    });
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});
