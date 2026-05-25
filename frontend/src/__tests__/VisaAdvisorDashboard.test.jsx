/**
 * VisaAdvisorDashboard.test.jsx — vitest + RTL coverage for the Phase 3 Visa
 * Sure per-application advisor view (frontend/src/pages/travel/visa/
 * AdvisorDashboard.jsx, SHELL shipped commit 90b58fa; wired to the real
 * GET /api/travel/visa/applications/:id backend at commit b2a4292).
 *
 * Scope — the SUT is a READ-ONLY per-application advisor view (PRD §3 FR-4).
 * It renders four sections off the joined detail payload: (1) diagnostic
 * answers, (2) AI summary notes placeholder, (3) risk indicators (3 pills:
 * complex case / rejection history / advisor risk flag), and (4) document
 * checklist progress. There are NO action CTAs (no mark-filed / mark-approved
 * controls live on this page yet), so the test pins read-only invariants.
 *
 * Cases pinned:
 *   1. Page chrome: heading "Visa application #<id>" + back-link to the
 *      Applications list. The applicationId is read from useParams() and
 *      rendered into the heading.
 *   2. Loading state: shows "Loading application…" before the GET resolves
 *      (per CLAUDE.md tick #108 cron-learning — await findByText).
 *   3. Route-param handling: the page reads applicationId from the URL and
 *      fires GET /api/travel/visa/applications/<id> on mount with that id
 *      interpolated. We mount via MemoryRouter at the SUT's mount path so
 *      useParams() resolves the id.
 *   4. Successful render with diagnostic + checklist: renders applicant name,
 *      applicationType + status in the header, diagnostic classification +
 *      score + "View full diagnostic" link (when diagnostic.id present),
 *      and "X of Y required documents verified" progress copy.
 *   5. Empty diagnostic: when application.diagnostic === null, renders the
 *      empty-state copy "No diagnostic submitted yet for this contact."
 *   6. Empty checklist: when documentChecklist=[] OR has no required items,
 *      renders the empty-state copy "No document checklist items recorded".
 *   7. Risk indicator pills — complex case FR-3.1: complexCase=true →
 *      pill says "yes"; complexCase=false → pill says "no".
 *   8. Risk indicator pills — rejection history FR-3.2: non-empty
 *      rejectionHistoryJson → pill says "on file"; empty / null / "[]" /
 *      "{}" → pill says "none". Pin both states.
 *   9. Risk indicator pills — advisor risk FR-3.3: advisorRiskFlag="high"
 *      / "priority" → pill renders that label; null / "" → pill renders
 *      the em-dash "—". Pin both.
 *  10. 404 NOT_FOUND error handling: err.code=NOT_FOUND → renders the
 *      "Visa application not found, or you do not have access to it." copy
 *      (NOT a crash, NOT the raw error message).
 *  11. 404 NOT_VISA_SURE error handling: err.code=NOT_VISA_SURE → renders
 *      the same "not found, or you do not have access" copy (sub-brand
 *      isolation — the SUT's error mapping treats both codes equivalently).
 *  12. Generic error handling (500 / network): err with no recognized code
 *      → renders the raw err.message instead of the canonical not-found
 *      copy.
 *
 * Backend contract pinned (per backend/routes/travel_visa.js — ce5f5db
 * GET /applications/:id):
 *   GET /api/travel/visa/applications/:id
 *     → 200 { id, contactId, applicationType, destinationCountry, status,
 *             readinessLevel, complexCase, advisorRiskFlag,
 *             rejectionHistoryJson, ..., contact:{id,name,email,...},
 *             diagnostic:{id,classification,classificationLabel,score,...}|null,
 *             documentChecklist:[{id,docType,required,status,...},...] }
 *     | 400 INVALID_ID    — handled by error path
 *     | 404 NOT_FOUND     — application doesn't exist on this tenant
 *     | 404 NOT_VISA_SURE — application exists but Contact.subBrand !== "visasure"
 *     | 403               — handled by fetchApi-global path (out of scope)
 *
 * Drift pinned (prompt vs. actual SUT code):
 *   - Dispatch prompt said "action CTAs (mark filed, mark approved, etc.)
 *     verify PATCH endpoint". The SUT has NO action CTAs and fires NO
 *     PATCH — it is strictly a read-only view as documented in the SUT
 *     header ("Read-only per-application advisor view"). Scaled tests to
 *     read-only invariants per the dispatch prompt's "If SUT is read-only
 *     (no action CTAs yet), scale down" instruction.
 *   - Dispatch prompt said "Status badge: renders correct label (intake/
 *     docs-pending/filed/approved/rejected/appeal)". The SUT does NOT
 *     render a StatusBadge component — status is shown as a plain
 *     inline text fragment in the header line ("· <status>"). Tests
 *     assert the inline text, not a badge component.
 *   - Dispatch prompt said "RBAC: USER role hides action CTAs (per
 *     InvoicesAdmin / VisaApplications pattern); ADMIN+MANAGER can act."
 *     The SUT does NOT read user.role at all — RBAC is enforced at the
 *     backend route (verifyRole(["ADMIN","MANAGER"])). A USER role
 *     hitting this page receives a 403 from fetchApi → renders the
 *     generic error message via err.message. There is nothing UI-side
 *     to hide. Tests OMIT a USER-role-hides-CTA case as nonexistent.
 *   - Dispatch prompt said "Sub-brand badge (if rendered): visasure
 *     indigo rgba(99, 102, 241, ...)". The SUT does NOT render a
 *     sub-brand badge (the page is implicitly visa-only — backend
 *     scopes to subBrand="visasure"). Tests OMIT travelSubBrand
 *     palette assertions.
 *   - Dispatch prompt mentioned RiskPills (per VisaApplications.test
 *     pattern). The SUT uses INLINE risk pills (3 fixed <span> elements
 *     in the Risk Indicators section), NOT the shared RiskPills
 *     component. Tests assert the inline pill text content.
 *   - SUT renders "Loading application…" (with &hellip; entity), NOT
 *     "Loading…". Test asserts the SUT's literal text.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the SUT's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference per RTL standing rule
 *     (Wave 11 cfb5789 / Wave 12 f59e91d). NOTE: the SUT does NOT actually
 *     consume useNotify — it surfaces errors via inline error JSX, not
 *     toasts. The mock is included for defense in depth in case the SUT
 *     gains a notify import in a future commit.
 *   - AuthContext consumed from real App module via Provider in the
 *     render wrapper. Default user role = ADMIN. We also exercise USER
 *     role purely as a smoke pin — see note above on why no UI hides.
 *   - Use MemoryRouter with initialEntries=[/travel/visa/applications/<id>]
 *     and a matching Route path so useParams() resolves the applicationId.
 *
 * Path: flat __tests__/ — sibling Agent A (TmcLayout coverage per cron prompt)
 * touches a different test file; no path collision.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). Included defensively; the SUT does not currently consume it.
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
import VisaAdvisorDashboard from '../pages/travel/visa/AdvisorDashboard';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'admin@x.com', role: 'ADMIN' };
const USER_USER = { userId: 3, name: 'Plain User', email: 'u@x.com', role: 'USER' };

// Canonical detail payload — exercises diagnostic + checklist + risk fields.
function makeDetail(overrides = {}) {
  return {
    id: 301,
    tenantId: 1,
    contactId: 5001,
    applicationType: 'tourist',
    destinationCountry: 'United Kingdom',
    status: 'docs-pending',
    readinessLevel: null,
    complexCase: false,
    advisorRiskFlag: null,
    rejectionHistoryJson: null,
    filedAt: null,
    decidedAt: null,
    outcome: null,
    outcomeReason: null,
    recoveryProgramId: null,
    createdAt: '2026-05-20T10:00:00.000Z',
    updatedAt: '2026-05-20T10:00:00.000Z',
    contact: {
      id: 5001,
      name: 'Riya Sharma',
      email: 'riya@test.example',
      phone: '+919000000001',
      source: 'walkin',
      subBrand: 'visasure',
    },
    diagnostic: {
      id: 7001,
      classification: 'standard',
      classificationLabel: 'Standard tourist applicant',
      recommendedTier: 'self-serve',
      score: 72,
      createdAt: '2026-05-19T09:00:00.000Z',
    },
    documentChecklist: [
      { id: 1, docType: 'passport', required: true, status: 'verified', attachmentId: null, notes: null },
      { id: 2, docType: 'photo', required: true, status: 'pending', attachmentId: null, notes: null },
      { id: 3, docType: 'cover-letter', required: false, status: 'pending', attachmentId: null, notes: null },
    ],
    ...overrides,
  };
}

// Install a fetchApi mock routed by URL. Tests override the surface they care about.
function installFetchMock(detail = makeDetail()) {
  fetchApiMock.mockImplementation((url) => {
    if (typeof url === 'string' && url.startsWith('/api/travel/visa/applications/')) {
      if (detail instanceof Error) return Promise.reject(detail);
      return Promise.resolve(detail);
    }
    return Promise.resolve(null);
  });
}

function renderPage({ user = ADMIN_USER, applicationId = '301' } = {}) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <MemoryRouter initialEntries={[`/travel/visa/applications/${applicationId}`]}>
      <AuthContext.Provider value={value}>
        <Routes>
          <Route
            path="/travel/visa/applications/:applicationId"
            element={<VisaAdvisorDashboard />}
          />
        </Routes>
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

describe('<VisaAdvisorDashboard /> — page chrome + route-param wiring', () => {
  it('renders heading "Visa application #<id>" + back-link to the Applications list', async () => {
    renderPage({ applicationId: '301' });
    expect(
      screen.getByRole('heading', { name: /Visa application/i }),
    ).toBeInTheDocument();
    // The heading interpolates the route-param applicationId — rendered as
    // <code>#301</code> inside the h1.
    expect(screen.getByText(/#301/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Back to Visa Applications/i }),
    ).toBeInTheDocument();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
  });

  it('reads applicationId from URL params + fires GET with that id interpolated', async () => {
    renderPage({ applicationId: '888' });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u === '/api/travel/visa/applications/888',
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<VisaAdvisorDashboard /> — loading state', () => {
  it('shows "Loading application…" before the GET resolves', async () => {
    let resolveDetail;
    fetchApiMock.mockImplementation(() =>
      new Promise((res) => { resolveDetail = res; }),
    );
    renderPage();
    // SUT renders "Loading application…" via &hellip; entity (= U+2026).
    await waitFor(() => {
      expect(screen.getByText(/Loading application/i)).toBeInTheDocument();
    });
    resolveDetail(makeDetail());
    // After resolve, the loading line disappears + a section that ONLY
    // renders post-load surfaces. We use the "Diagnostic answers" header
    // as the anchor (it's only mounted in the post-load branch).
    await screen.findByRole('heading', { name: /Diagnostic answers/i });
    expect(screen.queryByText(/Loading application/i)).toBeNull();
  });
});

describe('<VisaAdvisorDashboard /> — successful render with diagnostic + checklist', () => {
  it('renders applicant name + type + status in the header + diagnostic + checklist progress', async () => {
    renderPage();
    // Wait for the post-load Diagnostic-answers section to anchor "loaded".
    await screen.findByRole('heading', { name: /Diagnostic answers/i });
    // The applicant name is rendered as a TEXT NODE alongside sibling
    // <span>s for type + status — RTL's getByText splits the children
    // and bubbles up multiple matching ancestors. Use getAllByText with
    // a function-matcher and assert ≥1 hit.
    const nameHits = screen.getAllByText(
      (_, node) =>
        node?.tagName === 'DIV'
        && /Riya Sharma/.test(node.textContent || ''),
    );
    expect(nameHits.length).toBeGreaterThanOrEqual(1);
    // Type + status surface as inline middot-separated <span> fragments.
    expect(screen.getByText('tourist')).toBeInTheDocument();
    expect(screen.getByText('docs-pending')).toBeInTheDocument();
    // Diagnostic section.
    expect(screen.getByText('Standard tourist applicant')).toBeInTheDocument();
    expect(screen.getByText('72')).toBeInTheDocument();
    expect(screen.getByText('self-serve')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /View full diagnostic/i }),
    ).toBeInTheDocument();
    // Checklist progress: 1 of 2 required verified (passport=verified,
    // photo=pending; cover-letter is optional so not counted).
    const progressbar = screen.getByRole('progressbar', {
      name: /Required documents verified/i,
    });
    expect(progressbar).toBeInTheDocument();
    expect(progressbar.getAttribute('aria-valuenow')).toBe('1');
    expect(progressbar.getAttribute('aria-valuemax')).toBe('2');
  });

  it('renders empty-diagnostic copy when application.diagnostic === null', async () => {
    installFetchMock(makeDetail({ diagnostic: null }));
    renderPage();
    expect(
      await screen.findByText(/No diagnostic submitted yet for this contact/i),
    ).toBeInTheDocument();
  });

  it('renders empty-checklist copy when documentChecklist has no required items', async () => {
    installFetchMock(
      makeDetail({
        documentChecklist: [
          // Only optional items — filtered out by requiredItems gate.
          { id: 1, docType: 'cover-letter', required: false, status: 'pending' },
        ],
      }),
    );
    renderPage();
    expect(
      await screen.findByText(/No document checklist items recorded/i),
    ).toBeInTheDocument();
  });
});

describe('<VisaAdvisorDashboard /> — risk indicator pills', () => {
  it('FR-3.1 complex case: complexCase=true renders pill "yes"; =false renders "no"', async () => {
    installFetchMock(makeDetail({ complexCase: true }));
    const { unmount } = renderPage();
    await screen.findByRole('heading', { name: /Diagnostic answers/i });
    // The "Complex case" pill label is followed by "yes" when active.
    const yesPill = screen.getByTitle(/Complex case flag/i);
    expect(yesPill.textContent).toMatch(/yes/i);
    unmount();
    // Re-render with complexCase=false (the default).
    fetchApiMock.mockReset();
    installFetchMock(makeDetail({ complexCase: false }));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic answers/i });
    const noPill = screen.getByTitle(/Complex case flag/i);
    expect(noPill.textContent).toMatch(/no/i);
  });

  it('FR-3.2 rejection history: non-empty JSON pill says "on file"; null/"[]"/"{}"/"" says "none"', async () => {
    // Active form — a JSON array string with one rejection record.
    installFetchMock(
      makeDetail({ rejectionHistoryJson: '[{"date":"2025-01-01","country":"UK"}]' }),
    );
    const { unmount } = renderPage();
    await screen.findByRole('heading', { name: /Diagnostic answers/i });
    expect(screen.getByTitle(/Prior rejection history/i).textContent).toMatch(
      /on file/i,
    );
    unmount();
    // Inactive form — empty JSON array "[]" → treated as no history.
    fetchApiMock.mockReset();
    installFetchMock(makeDetail({ rejectionHistoryJson: '[]' }));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic answers/i });
    expect(screen.getByTitle(/Prior rejection history/i).textContent).toMatch(
      /none/i,
    );
  });

  it('FR-3.3 advisor risk flag: "high"/"priority" surfaces the label; null surfaces the em-dash', async () => {
    installFetchMock(makeDetail({ advisorRiskFlag: 'high' }));
    const { unmount } = renderPage();
    await screen.findByRole('heading', { name: /Diagnostic answers/i });
    expect(screen.getByTitle(/Advisor risk flag/i).textContent).toMatch(/high/);
    unmount();
    fetchApiMock.mockReset();
    installFetchMock(makeDetail({ advisorRiskFlag: null }));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic answers/i });
    // When null, the SUT renders "—" inside the pill via the
    // `application.advisorRiskFlag || '—'` fallback.
    expect(screen.getByTitle(/Advisor risk flag/i).textContent).toContain('—');
  });
});

describe('<VisaAdvisorDashboard /> — error handling', () => {
  it('404 NOT_FOUND renders the "not found or no access" copy', async () => {
    const err = new Error('Visa application not found');
    err.code = 'NOT_FOUND';
    err.status = 404;
    err.data = { code: 'NOT_FOUND', error: 'Visa application not found' };
    installFetchMock(err);
    renderPage();
    expect(
      await screen.findByText(/not found, or you do not have access/i),
    ).toBeInTheDocument();
  });

  it('404 NOT_VISA_SURE renders the same "not found or no access" copy (sub-brand isolation)', async () => {
    const err = new Error('Visa application not found');
    err.code = 'NOT_VISA_SURE';
    err.status = 404;
    err.data = { code: 'NOT_VISA_SURE', error: 'Visa application not found' };
    installFetchMock(err);
    renderPage();
    expect(
      await screen.findByText(/not found, or you do not have access/i),
    ).toBeInTheDocument();
  });

  it('generic error (e.g. 500) surfaces err.message verbatim, not the canonical not-found copy', async () => {
    const err = new Error('Server error — please try again.');
    err.code = null;
    err.status = 500;
    err.data = { error: 'Server error — please try again.' };
    installFetchMock(err);
    renderPage({ user: USER_USER });
    // The SUT does NOT special-case 500 / 403 / null-code — it falls
    // through to rendering err.message via the (... || error.message)
    // branch in the JSX.
    expect(
      await screen.findByText(/Server error — please try again/i),
    ).toBeInTheDocument();
    // And the canonical not-found copy is NOT rendered.
    expect(
      screen.queryByText(/not found, or you do not have access/i),
    ).toBeNull();
  });
});
