/**
 * CallifiedCalls.test.jsx — vitest + RTL coverage for the Callified.ai
 * AI-outbound-calling admin page (frontend/src/pages/admin/CallifiedCalls.jsx,
 * shipped tick #105 commit 7c7b88b, retrofitted tick #107 commit 93acf61 to
 * use shared CapBanners components).
 *
 * Scope — pins the page-surface invariants for the cap-consumer call UI.
 * Callified is the MOST COMPLEX of the four cap-consumer admin pages (vs.
 * AdsGPTReports / RateHawkSearch / BookingExpediaSearch) because of the
 * DC-7 per-tenant feature-flag full-page disabled state branched on mount:
 *
 *   1. Feature-flag DISABLED branch (CRITICAL): when GET /api/callified/enabled
 *      returns { enabled: false }, the page renders a FULL-PAGE disabled
 *      state — a card with the PhoneOff icon + RouterLink to
 *      /admin/tenant-settings — NOT the call-initiate form. This is the
 *      load-bearing DC-7 surface; regressing to "always render the form"
 *      would silently bill calls against a disabled tenant.
 *   2. Feature-flag ENABLED branch: when { enabled: true }, the call form
 *      renders + cap-pill loads after its own GET resolves.
 *   3. Page chrome: heading "Callified AI Calls" + initiate-form fields
 *      (toPhone, sub-brand, lead id, intent, persona) + cap-pill placement
 *      render in the enabled branch.
 *   4. enabledLoading null-state: page renders the call-form scaffold while
 *      the /enabled GET is pending (the SUT's null `enabled` state falls
 *      through to the form). Asserted indirectly via fetch-call sequencing.
 *   5. cap-status pill lifecycle: ADMIN-only on backend; renders the pill
 *      from the within-cap-OK shape after the GET resolves.
 *   6. cap-status 403 (MANAGER role): silently swallowed — no pill renders,
 *      no error toast fires.
 *   7. cap-status 402 (already over cap): synthesises percent:1 +
 *      withinCap:false from err.body → red pill renders.
 *   8. Stub-mode banner: surfaces ONLY after initiate response carries
 *      stub:true (NOT on mount — the SUT guards on lastCall?.stub or
 *      lastResult?.stub). Provider name "Callified.ai" + Q1 cred copy visible.
 *   9. Form validation — empty toPhone: clicking Initiate with toPhone="" surfaces
 *      notify.error("Destination phone (E.164) is required") and does NOT fire
 *      POST /api/callified/calls/initiate.
 *  10. Form validation — non-E.164 toPhone: typing "12345" (no leading +)
 *      surfaces notify.error matching /E.164 format/ and no POST fires.
 *  11. Initiate happy path: filling a valid E.164 phone + sub-brand + clicking
 *      Initiate fires POST with the form payload, transitions to "call
 *      summary" card via setLastCall, fires notify.success.
 *  12. Result-fetch flow: after a successful initiate, clicking the "Fetch
 *      result" button fires GET /api/callified/calls/:callId/result and
 *      renders the result card with recording link + summary + transcript.
 *  13. Cap-exceeded on initiate (402 AI_CALLING_BUDGET_EXCEEDED): renders
 *      CapExceededBanner with provider "AI calling" + the spent/cap dollar
 *      pair from err.body; does NOT render the call-summary card.
 *  14. Feature-disabled on initiate (403 AI_CALLING_DISABLED): re-fetches
 *      /api/callified/enabled — when that re-fetch returns { enabled: false },
 *      the page re-renders into the full-page disabled state. Pins the
 *      DC-7 "flag flipped mid-session" recovery path.
 *  15. Generic 500 on initiate: notify.error fires with the server-supplied
 *      message; no call-summary card; no cap-exceeded banner.
 *  16. Empty-state UI: before any initiate, the "No calls initiated yet."
 *      card renders with the sub-brand-aware persona copy.
 *
 * Backend contract pinned (per backend/routes/callified.js):
 *   GET  /api/callified/enabled                      → 200 { enabled: boolean }
 *   GET  /api/callified/cap-status                   → 200 { spentCents, capCents, percent, withinCap, alertThreshold }
 *                                                      | 402 { error, code: "AI_CALLING_BUDGET_EXCEEDED", spentCents, capCents }
 *                                                      | 403 (MANAGER — swallowed)
 *   POST /api/callified/calls/initiate               → 200 { stub, callId, status, ... }
 *                                                      | 400 { error, code: "MISSING_TO_PHONE" }
 *                                                      | 402 { error, code: "AI_CALLING_BUDGET_EXCEEDED", spentCents, capCents }
 *                                                      | 403 { error, code: "AI_CALLING_DISABLED" }
 *   GET  /api/callified/calls/:callId/result         → 200 { stub, callId, status, recordingUrl?, summary?, transcript?, ... }
 *
 * Drift pinned around (prompt vs. actual code):
 *   - Prompt said error codes were "CALLIFIED_BUDGET_EXCEEDED" / "CALLIFIED_DISABLED";
 *     actual route + SUT use "AI_CALLING_BUDGET_EXCEEDED" / "AI_CALLING_DISABLED".
 *     Tests pin the real codes.
 *   - Prompt mentioned "empty-history state"; the SUT has NO call-history view,
 *     just an empty-state card pre-first-initiate + a single-call-summary card
 *     after. Tests pin the empty-state card.
 *   - The 403 AI_CALLING_DISABLED path doesn't render an inline disabled message
 *     — it triggers refetchEnabled() which re-fetches /enabled and only when
 *     THAT returns false does the disabled-state mount. The test sequences both
 *     fetches to pin the full path.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules)
 *   - fetchApi mocked at ../utils/api (the page's dependency, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity stays
 *     stable across renders (the SUT closes over notify in async handlers).
 *   - travelSubBrand imported REAL (not mocked) so sub-brand-id drift is caught.
 *   - CapBanners imported REAL (not mocked) so the cap-pill / stub-banner /
 *     cap-exceeded-banner surfaces match production.
 *   - MemoryRouter wraps the SUT — the disabled-state surface renders a
 *     RouterLink to /admin/tenant-settings, which requires router context.
 *   - All data-dependent assertions use await findBy / waitFor (per CLAUDE.md
 *     tick #108 cron-learning: sync getBy for data-dependent text is a CI
 *     race trap).
 *
 * Path: flat __tests__/ per tick #111 path-coordination (sibling Agent B
 * owns BookingExpediaSearch.test.jsx in the same flat dir; no admin/ subdir
 * to avoid concurrent-subdir-creation races).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). The SUT closes over notify inside initiateCall + fetchResult,
// so a fresh object per render would flap state across re-renders.
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

import CallifiedCalls from '../pages/admin/CallifiedCalls';

const CAP_STATUS_OK = {
  spentCents: 1000,
  capCents: 10000,
  percent: 0.1,
  withinCap: true,
  alertThreshold: false,
};

// Canonical successful initiate response (stub-mode reflecting Q1 cred-pending).
function makeInitiateResponse(overrides = {}) {
  return {
    stub: true,
    callId: 'call-abc-123',
    status: 'initiated',
    toPhone: '+919876543210',
    subBrand: null,
    intent: null,
    persona: null,
    leadId: null,
    note: 'Stub mode — Callified.ai credentials pending (Q1).',
    ...overrides,
  };
}

// Canonical successful result-fetch response.
function makeResultResponse(overrides = {}) {
  return {
    stub: true,
    callId: 'call-abc-123',
    status: 'completed',
    recordingUrl: 'https://example.com/recordings/abc.mp3',
    summary: 'Lead expressed interest in Umrah package for December.',
    transcript: 'Agent: Hello… Customer: Hi, calling about…',
    outcome: 'qualified',
    note: null,
    ...overrides,
  };
}

// Install a fetchApi mock that routes by URL + method, with sensible defaults
// for the three mount-time GETs. Each test overrides only the surface it cares
// about.
function installFetchMock({
  enabled = { enabled: true },
  capStatus = CAP_STATUS_OK,
  initiate = makeInitiateResponse(),
  result = makeResultResponse(),
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/callified/enabled' && (!opts || !opts.method || opts.method === 'GET')) {
      if (enabled instanceof Error) return Promise.reject(enabled);
      return Promise.resolve(enabled);
    }
    if (url === '/api/callified/cap-status' && (!opts || !opts.method || opts.method === 'GET')) {
      if (capStatus instanceof Error) return Promise.reject(capStatus);
      return Promise.resolve(capStatus);
    }
    if (url === '/api/callified/calls/initiate' && opts?.method === 'POST') {
      if (initiate instanceof Error) return Promise.reject(initiate);
      return Promise.resolve(initiate);
    }
    if (url.startsWith('/api/callified/calls/') && url.endsWith('/result')) {
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    }
    return Promise.resolve(null);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <CallifiedCalls />
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

describe('<CallifiedCalls /> — DC-7 feature-flag disabled-state branching', () => {
  it('renders the full-page disabled state when GET /enabled returns { enabled: false }', async () => {
    installFetchMock({ enabled: { enabled: false } });
    renderPage();
    // The full-page disabled card surfaces via its testid.
    const disabled = await screen.findByTestId('callified-disabled-state');
    expect(disabled).toBeInTheDocument();
    expect(disabled).toHaveTextContent(/AI calling is disabled for this tenant/i);
    // Link to tenant settings is present + points at the right route.
    const link = screen.getByRole('link', {
      name: /Tenant Settings → AI Calling toggle/i,
    });
    expect(link).toHaveAttribute('href', '/admin/tenant-settings');
    // Critically, the call-initiate form is NOT rendered in the disabled state.
    expect(screen.queryByTestId('callified-initiate-btn')).toBeNull();
    expect(screen.queryByTestId('callified-filter-tophone')).toBeNull();
  });

  it('renders the call-initiate form when GET /enabled returns { enabled: true }', async () => {
    renderPage();
    // The initiate form surfaces (toPhone field + initiate button).
    expect(await screen.findByTestId('callified-filter-tophone')).toBeInTheDocument();
    expect(screen.getByTestId('callified-initiate-btn')).toBeInTheDocument();
    // The disabled-state card is absent.
    expect(screen.queryByTestId('callified-disabled-state')).toBeNull();
  });

  it('falls through to the enabled form when GET /enabled network-fails (defensive default)', async () => {
    // Per SUT comment: "Network / other error — assume enabled and let the
    // initiate-time 403 handler catch the real state if it differs."
    const err = new Error('network down');
    installFetchMock({ enabled: err });
    // Silence the SUT's console.warn for this path so the test output stays clean.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderPage();
    // Form renders even though the /enabled fetch rejected.
    expect(await screen.findByTestId('callified-initiate-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('callified-disabled-state')).toBeNull();
    warnSpy.mockRestore();
  });
});

describe('<CallifiedCalls /> — page chrome + cap-status pill lifecycle', () => {
  it('renders heading + all form fields + initiate button on mount (enabled branch)', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /Callified AI Calls/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('callified-filter-tophone')).toBeInTheDocument();
    expect(screen.getByTestId('callified-filter-subbrand')).toBeInTheDocument();
    expect(screen.getByTestId('callified-filter-leadid')).toBeInTheDocument();
    expect(screen.getByTestId('callified-filter-intent')).toBeInTheDocument();
    expect(screen.getByTestId('callified-filter-persona')).toBeInTheDocument();
    expect(screen.getByTestId('callified-initiate-btn')).toBeInTheDocument();
    // Default empty state (pre-first-initiate) is rendered.
    expect(screen.getByTestId('callified-empty-state')).toBeInTheDocument();
    // Let the mount-time GETs settle so dangling promises don't leak into the
    // next test.
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(([url]) => url === '/api/callified/cap-status'),
      ).toBe(true);
    });
  });

  it('GETs /api/callified/cap-status on mount + renders the green cap pill once resolved', async () => {
    renderPage();
    const pill = await screen.findByTestId('callified-cap-pill');
    // "10% of $100/mo cap" — formatPercent(0.1) + centsToUsd(10000) = "$100".
    expect(pill).toHaveTextContent(/10% of \$100\/mo cap/i);
    // Green pill border (jsdom normalises #22c55e → rgb form).
    expect(pill.style.border).toBe('1px solid rgb(34, 197, 94)');
    // Both mount GETs fired exactly once.
    const enabledCalls = fetchApiMock.mock.calls.filter(
      ([url]) => url === '/api/callified/enabled',
    );
    const capCalls = fetchApiMock.mock.calls.filter(
      ([url]) => url === '/api/callified/cap-status',
    );
    expect(enabledCalls.length).toBe(1);
    expect(capCalls.length).toBe(1);
  });

  it('swallows cap-status 403 silently (MANAGER role) — no pill renders', async () => {
    const err = new Error('Forbidden');
    err.status = 403;
    installFetchMock({ capStatus: err });
    renderPage();
    // Wait for the initiate button so we know the page rendered.
    await screen.findByTestId('callified-initiate-btn');
    // Settle the .finally() microtask that flips capStatusLoading=false.
    await new Promise((r) => setTimeout(r, 20));
    // No pill renders on MANAGER's 403; no error toast either.
    expect(screen.queryByTestId('callified-cap-pill')).toBeNull();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('renders the red over-cap pill when cap-status returns 402 (synthesises percent:1)', async () => {
    const err = new Error('Cap exceeded');
    err.status = 402;
    err.body = {
      error: 'AI calling monthly cap exceeded',
      code: 'AI_CALLING_BUDGET_EXCEEDED',
      spentCents: 12000,
      capCents: 10000,
    };
    installFetchMock({ capStatus: err });
    renderPage();
    const pill = await screen.findByTestId('callified-cap-pill');
    // Synthesised percent:1 → "100% of $100/mo cap"; red border.
    expect(pill).toHaveTextContent(/100% of \$100\/mo cap/i);
    expect(pill.style.border).toBe('1px solid rgb(244, 63, 94)');
  });
});

describe('<CallifiedCalls /> — initiate validation + happy path', () => {
  it('validation: empty toPhone → notify.error fires, no POST is sent', async () => {
    renderPage();
    await screen.findByTestId('callified-initiate-btn');
    // Wait for mount GETs so the next mockClear doesn't lose them.
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(([url]) => url === '/api/callified/cap-status'),
      ).toBe(true);
    });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByTestId('callified-initiate-btn'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        'Destination phone (E.164) is required',
      );
    });
    // No initiate POST fired.
    const posts = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/callified/calls/initiate' && opts?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('validation: non-E.164 toPhone → notify.error fires (matches /E.164 format/), no POST', async () => {
    renderPage();
    const phoneInput = await screen.findByTestId('callified-filter-tophone');
    // No leading "+" → fails the SUT's /^\+\d{8,15}$/ regex.
    fireEvent.change(phoneInput, { target: { value: '12345' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByTestId('callified-initiate-btn'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    // Most recent error mentions E.164 format.
    const lastMsg = notifyError.mock.calls.at(-1)[0];
    expect(lastMsg).toMatch(/E\.164 format/i);
    const posts = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/callified/calls/initiate' && opts?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('happy path: filling toPhone + clicking Initiate POSTs the form payload + renders call-summary card', async () => {
    renderPage();
    const phoneInput = await screen.findByTestId('callified-filter-tophone');
    fireEvent.change(phoneInput, { target: { value: '+919876543210' } });
    fireEvent.change(screen.getByTestId('callified-filter-intent'), {
      target: { value: 'follow-up' },
    });
    fireEvent.click(screen.getByTestId('callified-initiate-btn'));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === '/api/callified/calls/initiate' && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.toPhone).toBe('+919876543210');
      expect(body.intent).toBe('follow-up');
      // Sub-brand left "" → omitted; persona/leadId blank → omitted.
      expect(body.subBrand).toBeUndefined();
      expect(body.persona).toBeUndefined();
      expect(body.leadId).toBeUndefined();
    });

    // Call summary card replaces the empty state.
    expect(await screen.findByTestId('callified-call-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('callified-empty-state')).toBeNull();
    // notify.success fired with the callId.
    expect(notifySuccess).toHaveBeenCalled();
    expect(notifySuccess.mock.calls[0][0]).toMatch(/call-abc-123/);
  });

  it('stub-mode banner renders ONLY after initiate response carries stub:true', async () => {
    renderPage();
    await screen.findByTestId('callified-initiate-btn');
    // Pre-initiate, the stub banner is absent (it's gated on lastCall?.stub).
    expect(screen.queryByTestId('callified-stub-banner')).toBeNull();
    // Fire the initiate.
    fireEvent.change(screen.getByTestId('callified-filter-tophone'), {
      target: { value: '+919876543210' },
    });
    fireEvent.click(screen.getByTestId('callified-initiate-btn'));
    // Post-initiate, the stub banner surfaces with the Q1 cred copy.
    const banner = await screen.findByTestId('callified-stub-banner');
    expect(banner).toHaveTextContent(/Stub-mode response/i);
    expect(banner).toHaveTextContent(/Q1\s+cred/i);
    expect(banner).toHaveTextContent(/Callified\.ai/i);
  });
});

describe('<CallifiedCalls /> — result-fetch flow', () => {
  it('clicking "Fetch result" after a successful initiate GETs the result + renders the result card', async () => {
    renderPage();
    fireEvent.change(
      await screen.findByTestId('callified-filter-tophone'),
      { target: { value: '+919876543210' } },
    );
    fireEvent.click(screen.getByTestId('callified-initiate-btn'));
    const fetchBtn = await screen.findByTestId('callified-fetch-result-btn');

    fetchApiMock.mockClear();
    installFetchMock(); // restore defaults for the result GET below
    fireEvent.click(fetchBtn);

    await waitFor(() => {
      const resultGet = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' &&
          url.startsWith('/api/callified/calls/') &&
          url.endsWith('/result'),
      );
      expect(resultGet).toBeTruthy();
      // callId from the initiate response is URL-encoded into the path.
      expect(resultGet[0]).toBe('/api/callified/calls/call-abc-123/result');
    });
    // Result card renders with the recording link + summary copy.
    expect(await screen.findByTestId('callified-result-card')).toBeInTheDocument();
    expect(screen.getByTestId('callified-result-recording-link')).toHaveAttribute(
      'href',
      'https://example.com/recordings/abc.mp3',
    );
    expect(
      screen.getByText(/Lead expressed interest in Umrah package/i),
    ).toBeInTheDocument();
  });
});

describe('<CallifiedCalls /> — error / cap-exceeded / feature-disabled handling on initiate', () => {
  it('402 AI_CALLING_BUDGET_EXCEEDED → renders CapExceededBanner + hides the call-summary card', async () => {
    const err = new Error('AI calling monthly cap exceeded');
    err.status = 402;
    err.body = {
      error: 'AI calling monthly cap exceeded',
      code: 'AI_CALLING_BUDGET_EXCEEDED',
      spentCents: 12000,
      capCents: 10000,
    };
    installFetchMock({ initiate: err });
    renderPage();
    fireEvent.change(
      await screen.findByTestId('callified-filter-tophone'),
      { target: { value: '+919876543210' } },
    );
    fireEvent.click(screen.getByTestId('callified-initiate-btn'));

    const banner = await screen.findByTestId('callified-cap-exceeded-banner');
    // Provider label is "AI calling" per the SUT's CapExceededBanner prop.
    expect(banner).toHaveTextContent(/Monthly AI calling cap reached/i);
    // $120 spent of $100 cap.
    expect(banner).toHaveTextContent(/\$120 \/ \$100/);
    // Call summary card is NOT shown when capExceeded is set (the SUT branches
    // on capExceeded ? null : !lastCall ? <empty-state> : <summary>).
    expect(screen.queryByTestId('callified-call-summary')).toBeNull();
    expect(screen.queryByTestId('callified-empty-state')).toBeNull();
    // No global error toast — the banner is the surface.
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('403 AI_CALLING_DISABLED → re-fetches /enabled; flag-flipped re-render lands the disabled state', async () => {
    // First /enabled is true (mount), then on initiate failure the SUT calls
    // refetchEnabled which hits /enabled again — this time returning false,
    // flipping the page into the full-page disabled state.
    let enabledCallCount = 0;
    const initiateErr = new Error('AI calling is disabled for this tenant');
    initiateErr.status = 403;
    initiateErr.body = {
      error: 'AI calling is disabled for this tenant',
      code: 'AI_CALLING_DISABLED',
    };
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/callified/enabled') {
        enabledCallCount += 1;
        // First call (mount) → enabled=true so the form renders. Subsequent
        // calls (refetchEnabled from the 403 catch) → enabled=false so the
        // flag-flipped state surfaces.
        return Promise.resolve({ enabled: enabledCallCount === 1 });
      }
      if (url === '/api/callified/cap-status') return Promise.resolve(CAP_STATUS_OK);
      if (url === '/api/callified/calls/initiate' && opts?.method === 'POST') {
        return Promise.reject(initiateErr);
      }
      return Promise.resolve(null);
    });
    renderPage();
    fireEvent.change(
      await screen.findByTestId('callified-filter-tophone'),
      { target: { value: '+919876543210' } },
    );
    fireEvent.click(screen.getByTestId('callified-initiate-btn'));

    // After the 403 catch, the page should re-render into the disabled state.
    const disabled = await screen.findByTestId('callified-disabled-state');
    expect(disabled).toHaveTextContent(/AI calling is disabled for this tenant/i);
    // The /enabled refetch happened (count > 1).
    expect(enabledCallCount).toBeGreaterThanOrEqual(2);
    // No generic error toast — the disabled-state surface is the affordance.
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('generic 500 on initiate → notify.error fires with server-supplied message + no call card', async () => {
    const err = new Error('upstream timeout');
    err.status = 500;
    err.body = { error: 'Callified provider returned 503' };
    installFetchMock({ initiate: err });
    renderPage();
    fireEvent.change(
      await screen.findByTestId('callified-filter-tophone'),
      { target: { value: '+919876543210' } },
    );
    fireEvent.click(screen.getByTestId('callified-initiate-btn'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Callified provider returned 503');
    });
    // No call-summary card; no cap-exceeded banner.
    expect(screen.queryByTestId('callified-call-summary')).toBeNull();
    expect(screen.queryByTestId('callified-cap-exceeded-banner')).toBeNull();
    // Empty state still rendered.
    expect(screen.getByTestId('callified-empty-state')).toBeInTheDocument();
  });
});
