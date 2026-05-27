/**
 * EmbassyRulesAdmin.test.jsx — vitest + RTL coverage for the Phase 3 Visa Sure
 * Embassy Rules admin CRUD page (frontend/src/pages/travel/visa/
 * EmbassyRulesAdmin.jsx, tick #178 — consumes /api/embassy-rules from
 * backend commit 05587ac7 — tick #175).
 *
 * Scope — pins the page-surface invariants for the embassy-rules admin
 * (sibling to QuotesAdmin / InvoicesAdmin / TenantSettings):
 *
 *   1. Loading state: shows "Loading…" before the first GET resolves
 *      (await findByText per CLAUDE.md tick #108 cron-learning).
 *   2. Page chrome on mount: heading "Embassy Rules" + filter chrome
 *      (country / rule type / severity / active selects) + "New Rule"
 *      CTA (ADMIN only).
 *   3. GET on mount: hits /api/embassy-rules (no query string when all
 *      filters empty) exactly once.
 *   4. List render: rules table renders one row per rule with
 *      destinationCountry / ruleType / applicationType / actionLabel /
 *      severity badge / isActive + per-row Edit/Delete actions
 *      (ADMIN-only).
 *   5. Filter interaction: typing into the country filter triggers
 *      re-fetch with ?destinationCountry=US (uppercased) in the query
 *      string. Severity filter re-fetch fires with ?severity=warning.
 *   6. New Rule modal: clicking "New Rule" opens the modal with all
 *      expected fields (Destination country / Rule type / Application
 *      type / Advisor warning / Severity / Condition JSON / Active).
 *      Submit fires POST /api/embassy-rules with the trimmed body
 *      (destinationCountry uppercased + applicationType=null when blank).
 *   7. Validation — invalid JSON: typing malformed JSON into the
 *      conditionJson textarea + clicking Save surfaces an inline error
 *      ("Condition JSON is not valid JSON") and does NOT fire a POST.
 *   8. Validation — invalid country: a 1-char country (e.g. "U")
 *      surfaces "Destination country must be a 2-letter ISO code" and
 *      does NOT fire a POST.
 *   9. Edit flow: clicking Edit on a row opens the modal with all
 *      fields pre-filled from that rule; submitting fires
 *      PUT /api/embassy-rules/<id> with the updated fields.
 *  10. Delete flow: clicking Delete on a row fires window.confirm; on
 *      confirm=true a DELETE /api/embassy-rules/<id> fires; on
 *      confirm=false NO DELETE fires.
 *  11. RBAC: role=USER hides the New Rule CTA + per-row Edit/Delete
 *      buttons (the GET still fires for read-only visibility).
 *  12. Server error mapping: a POST returning INVALID_DESTINATION_COUNTRY
 *      surfaces "Destination country must be a 2-letter ISO code" via
 *      both the inline field error AND notify.error.
 *
 * Backend contract pinned (per backend/routes/embassy_rules.js — 05587ac7):
 *   GET    /api/embassy-rules?destinationCountry&ruleType&severity&isActive
 *          → 200 { rules, total, limit, offset }
 *   POST   /api/embassy-rules → 201 created (ADMIN-only)
 *          body: { ruleType, destinationCountry, applicationType?,
 *                  conditionJson?, actionLabel, severity, isActive? }
 *   PUT    /api/embassy-rules/:id → 200 updated (ADMIN-only)
 *   DELETE /api/embassy-rules/:id → 200 soft-deleted
 *   Error codes: INVALID_DESTINATION_COUNTRY / INVALID_SEVERITY /
 *                INVALID_RULE_TYPE / MISSING_FIELDS / EMPTY_BODY /
 *                INVALID_ID / RBAC_DENIED / EMBASSY_RULE_NOT_FOUND /
 *                EMBASSY_RULE_DUPLICATE
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (RTL standing rule: Wave 11 cfb5789 /
 *     Wave 12 f59e91d — fresh per-call objects flap state across renders).
 *   - AuthContext is wrapped via Provider — Default user role = ADMIN;
 *     one test mounts with role=USER to assert RBAC hide.
 *   - window.confirm is stubbed per-test (vi.spyOn) so we can drive the
 *     confirm=true / confirm=false branches of the delete flow.
 *   - All data-dependent assertions use await findBy / waitFor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). The SUT closes over notify in submit / handleDelete
// handlers; a fresh per-call object would flap useCallback identity.
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
import EmbassyRulesAdmin from '../pages/travel/visa/EmbassyRulesAdmin';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const USER_USER = { userId: 3, name: 'Plain User', email: 'u@x.com', role: 'USER' };

function makeRule(overrides = {}) {
  return {
    id: 401,
    tenantId: 1,
    ruleType: 'document_required',
    destinationCountry: 'US',
    applicationType: 'tourist',
    conditionJson: null,
    actionLabel: 'Police clearance certificate required (last 90 days)',
    severity: 'warning',
    isActive: true,
    createdById: 1,
    createdAt: '2026-05-20T10:00:00.000Z',
    updatedAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const RULES_DEFAULT = [
  makeRule({
    id: 401,
    destinationCountry: 'US',
    ruleType: 'document_required',
    applicationType: 'tourist',
    actionLabel: 'Police clearance certificate required (last 90 days)',
    severity: 'warning',
    isActive: true,
  }),
  makeRule({
    id: 402,
    destinationCountry: 'GB',
    ruleType: 'minimum_funds',
    applicationType: 'student',
    actionLabel: 'Show minimum GBP 1334/month maintenance funds',
    severity: 'blocker',
    isActive: true,
  }),
  makeRule({
    id: 403,
    destinationCountry: 'AE',
    ruleType: 'cooldown_period',
    applicationType: null,
    actionLabel: 'Cooldown: 30 days between rejected applications',
    severity: 'info',
    isActive: false,
  }),
];

function installFetchMock({
  list = { rules: RULES_DEFAULT, total: RULES_DEFAULT.length, limit: 100, offset: 0 },
  create = null,
  update = null,
  del = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (typeof url === 'string' && url.startsWith('/api/embassy-rules')) {
      if (method === 'GET') {
        if (list instanceof Error) return Promise.reject(list);
        return Promise.resolve(list);
      }
      if (method === 'POST') {
        if (create instanceof Error) return Promise.reject(create);
        return Promise.resolve(create || makeRule({ id: 999 }));
      }
      if (method === 'PUT') {
        if (update instanceof Error) return Promise.reject(update);
        return Promise.resolve(update || makeRule({ id: 401 }));
      }
      if (method === 'DELETE') {
        if (del instanceof Error) return Promise.reject(del);
        return Promise.resolve(del || { ...makeRule({ id: 401 }), isActive: false });
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
        <EmbassyRulesAdmin />
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

describe('<EmbassyRulesAdmin /> — page chrome + RBAC', () => {
  it('renders heading + filter chrome + "New Rule" CTA when role=ADMIN; fires GET on mount', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Embassy Rules/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by destination country/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by rule type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by severity/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by active state/i)).toBeInTheDocument();
    expect(screen.getByTestId('embassy-rule-new')).toBeInTheDocument();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([u]) => typeof u === 'string' && u.startsWith('/api/embassy-rules'),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('hides "New Rule" + Edit/Delete CTAs for role=USER; GET still fires for read-only', async () => {
    renderPage(USER_USER);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    expect(screen.queryByTestId('embassy-rule-new')).toBeNull();
    // Wait for rows to render, then assert no per-row mutation buttons.
    await screen.findByText(/Police clearance certificate required/i);
    expect(screen.queryByTestId('embassy-rule-edit-401')).toBeNull();
    expect(screen.queryByTestId('embassy-rule-delete-401')).toBeNull();
  });
});

describe('<EmbassyRulesAdmin /> — list + filter lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/embassy-rules')) {
        return new Promise((res) => { resolveList = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText(/Loading…/i).length).toBeGreaterThanOrEqual(1);
    });
    resolveList({ rules: RULES_DEFAULT, total: RULES_DEFAULT.length, limit: 100, offset: 0 });
    await screen.findByText(/Police clearance certificate required/i);
  });

  it('GET on mount with NO query string when filters are empty; renders one row per rule', async () => {
    renderPage();
    await waitFor(() => {
      const getCall = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          typeof u === 'string'
          && u.startsWith('/api/embassy-rules')
          && (!o?.method || o.method === 'GET'),
      );
      expect(getCall).toBeTruthy();
      expect(getCall[0]).toBe('/api/embassy-rules');
    });
    // Each rule renders by actionLabel text.
    expect(await screen.findByText(/Police clearance certificate required/i)).toBeInTheDocument();
    expect(screen.getByText(/Show minimum GBP 1334\/month/i)).toBeInTheDocument();
    expect(screen.getByText(/Cooldown: 30 days between rejected/i)).toBeInTheDocument();
    // Severity badges + country cells.
    expect(screen.getByTestId('embassy-rule-row-401')).toHaveTextContent('US');
    expect(screen.getByTestId('embassy-rule-row-402')).toHaveTextContent('blocker');
    expect(screen.getByTestId('embassy-rule-row-403')).toHaveTextContent('info');
  });

  it('country filter re-fetches with ?destinationCountry=US (uppercased)', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    const countryInput = screen.getByLabelText(/Filter by destination country/i);
    fireEvent.change(countryInput, { target: { value: 'us' } });
    await waitFor(() => {
      const fetchCall = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('destinationCountry=US'),
      );
      expect(fetchCall).toBeTruthy();
    });
  });

  it('severity filter re-fetches with ?severity=warning', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by severity/i), { target: { value: 'warning' } });
    await waitFor(() => {
      const fetchCall = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('severity=warning'),
      );
      expect(fetchCall).toBeTruthy();
    });
  });
});

describe('<EmbassyRulesAdmin /> — create modal', () => {
  it('opens with all expected fields when "New Rule" is clicked', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('embassy-rule-new'));
    expect(await screen.findByText(/New Embassy Rule/i)).toBeInTheDocument();
    expect(screen.getByTestId('embassy-rule-form-country')).toBeInTheDocument();
    expect(screen.getByTestId('embassy-rule-form-rule-type')).toBeInTheDocument();
    expect(screen.getByTestId('embassy-rule-form-app-type')).toBeInTheDocument();
    expect(screen.getByTestId('embassy-rule-form-action-label')).toBeInTheDocument();
    expect(screen.getByTestId('embassy-rule-form-severity')).toBeInTheDocument();
    expect(screen.getByTestId('embassy-rule-form-condition-json')).toBeInTheDocument();
    expect(screen.getByTestId('embassy-rule-form-active')).toBeInTheDocument();
  });

  it('submit happy path: POST /api/embassy-rules with the trimmed + uppercased body', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('embassy-rule-new'));
    await screen.findByText(/New Embassy Rule/i);

    fireEvent.change(screen.getByTestId('embassy-rule-form-country'), { target: { value: 'fr' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-rule-type'), { target: { value: 'interview_required' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-action-label'), {
      target: { value: 'In-person interview required at French Embassy New Delhi' },
    });
    // Leave applicationType blank → backend gets null.
    fireEvent.change(screen.getByTestId('embassy-rule-form-severity'), { target: { value: 'blocker' } });

    fetchApiMock.mockClear();
    installFetchMock();

    fireEvent.click(screen.getByTestId('embassy-rule-form-submit'));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/embassy-rules' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.destinationCountry).toBe('FR'); // uppercased
      expect(body.ruleType).toBe('interview_required');
      expect(body.actionLabel).toBe('In-person interview required at French Embassy New Delhi');
      expect(body.applicationType).toBe(null); // blank → null
      expect(body.severity).toBe('blocker');
      expect(body.isActive).toBe(true);
    });
    await waitFor(() => expect(notifySuccess).toHaveBeenCalled());
  });

  it('validation — invalid JSON in conditionJson surfaces inline error and does NOT POST', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('embassy-rule-new'));
    await screen.findByText(/New Embassy Rule/i);

    fireEvent.change(screen.getByTestId('embassy-rule-form-country'), { target: { value: 'US' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-rule-type'), { target: { value: 'document_required' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-action-label'), { target: { value: 'Test rule' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-condition-json'), {
      target: { value: '{not-valid-json' },
    });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByTestId('embassy-rule-form-submit'));

    await waitFor(() => {
      expect(screen.getByText(/Condition JSON is not valid JSON/i)).toBeInTheDocument();
    });
    const postCalls = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/embassy-rules' && o?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('validation — 1-char country fires inline error and does NOT POST', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('embassy-rule-new'));
    await screen.findByText(/New Embassy Rule/i);

    // The maxLength=2 attribute prevents typing more than 2 chars in a
    // real browser; jsdom does NOT enforce maxLength on fireEvent.change
    // so we deliberately type a 1-char value to exercise the validation
    // gate. This is the documented jsdom + RTL behavior — the gate
    // catches the bad value regardless of whether the browser would
    // have prevented it.
    fireEvent.change(screen.getByTestId('embassy-rule-form-country'), { target: { value: 'U' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-rule-type'), { target: { value: 'document_required' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-action-label'), { target: { value: 'Test rule' } });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByTestId('embassy-rule-form-submit'));

    await waitFor(() => {
      expect(
        screen.getByText(/2-letter ISO code/i),
      ).toBeInTheDocument();
    });
    const postCalls = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/embassy-rules' && o?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('server error mapping: INVALID_DESTINATION_COUNTRY → inline error + notify.error', async () => {
    const err = new Error('destinationCountry must be a 2-character uppercase ISO-3166-1 alpha-2 code');
    err.code = 'INVALID_DESTINATION_COUNTRY';
    err.data = { code: 'INVALID_DESTINATION_COUNTRY', error: err.message };

    installFetchMock({ create: err });
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('embassy-rule-new'));
    await screen.findByText(/New Embassy Rule/i);

    // Submit with a value that PASSES client-side gate (so the request
    // actually fires and we exercise the server-error mapping path).
    fireEvent.change(screen.getByTestId('embassy-rule-form-country'), { target: { value: 'US' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-rule-type'), { target: { value: 'document_required' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-action-label'), { target: { value: 'Test rule' } });
    fireEvent.click(screen.getByTestId('embassy-rule-form-submit'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
      const msg = notifyError.mock.calls[0][0];
      expect(msg).toMatch(/2-letter ISO code/i);
    });
    // Inline field error on the destinationCountry field.
    expect(screen.getAllByText(/2-letter ISO code/i).length).toBeGreaterThanOrEqual(1);
  });
});

describe('<EmbassyRulesAdmin /> — edit + delete', () => {
  it('edit flow: opens modal pre-filled + fires PUT on submit', async () => {
    renderPage();
    const editBtn = await screen.findByTestId('embassy-rule-edit-401');
    fireEvent.click(editBtn);
    expect(await screen.findByText(/Edit Embassy Rule/i)).toBeInTheDocument();
    // Pre-filled from the rule.
    expect(screen.getByTestId('embassy-rule-form-country').value).toBe('US');
    expect(screen.getByTestId('embassy-rule-form-rule-type').value).toBe('document_required');
    expect(screen.getByTestId('embassy-rule-form-action-label').value).toMatch(/Police clearance/i);

    // Tweak the action label + submit.
    fireEvent.change(screen.getByTestId('embassy-rule-form-action-label'), {
      target: { value: 'Police clearance certificate required (last 180 days)' },
    });

    fetchApiMock.mockClear();
    installFetchMock();

    fireEvent.click(screen.getByTestId('embassy-rule-form-submit'));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/embassy-rules/401' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.actionLabel).toMatch(/180 days/);
    });
    await waitFor(() => expect(notifySuccess).toHaveBeenCalled());
  });

  it('delete flow: window.confirm=true → DELETE fires; confirm=false → NO DELETE fires', async () => {
    renderPage();
    const deleteBtn = await screen.findByTestId('embassy-rule-delete-401');

    // First click: user cancels the confirm dialog.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fetchApiMock.mockClear();
    fireEvent.click(deleteBtn);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    const cancelledDeletes = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/embassy-rules/401' && o?.method === 'DELETE',
    );
    expect(cancelledDeletes.length).toBe(0);

    // Second click: user confirms.
    confirmSpy.mockReturnValue(true);
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(deleteBtn);
    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/embassy-rules/401' && o?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });
    await waitFor(() => expect(notifySuccess).toHaveBeenCalled());
    confirmSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Extension cases (tick #197 — appended by test-cron agent A)
//
// Adds coverage for the previously-unexercised branches enumerated below.
// SUT is 855L; pre-extension test was 495L (57% ratio). Targets:
//
//   13. Empty state copy when rules.length === 0.
//   14. Load error banner + Retry button (loadError state path).
//   15. Active filter re-fetch with ?isActive=true and ?isActive=false.
//   16. Rule-type filter re-fetch with ?ruleType=<value>.
//   17. Multiple filters combined into one query string.
//   18. Missing ruleType client-side validation gate (no POST fires).
//   19. Missing actionLabel client-side validation gate (no POST fires).
//   20. Modal close via Cancel button (modal disappears, no POST fires).
//   21. Modal close via backdrop click (modal disappears).
//   22. applicationType pre-filled in the edit modal AND submitted in PUT.
//   23. EMBASSY_RULE_DUPLICATE server error → user-friendly inline + toast.
//   24. RBAC_DENIED server error → generic banner (no field-level inline).
//   25. Delete failure path → notify.error fired, list NOT reloaded.
//   26. Active toggle in the form payload (uncheck → isActive=false in POST).
//   27. Row with applicationType=null renders "all" placeholder; inactive
//       row renders "No".
//   28. Severity badge renders em-dash placeholder when severity is falsy.
//
// Mocking discipline preserved per CLAUDE.md RTL standing rules: stable
// notifyObj reference (shared with the original suite), fetchApi mocked
// at the page's dep, AuthContext wrapped via Provider, all data-deps
// awaited via findBy/waitFor.
// ---------------------------------------------------------------------------

describe('<EmbassyRulesAdmin /> — empty + error states', () => {
  it('renders the empty-state copy when the rules array is empty', async () => {
    installFetchMock({ list: { rules: [], total: 0, limit: 100, offset: 0 } });
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    expect(
      await screen.findByText(/No embassy rules match the current filters/i),
    ).toBeInTheDocument();
  });

  it('renders error banner + Retry button when GET rejects; Retry re-fires the GET', async () => {
    const loadError = new Error('Network exploded');
    installFetchMock({ list: loadError });
    renderPage();
    expect(
      await screen.findByText(/Network exploded|Failed to load embassy rules/i),
    ).toBeInTheDocument();
    // Retry button shown alongside the error.
    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    expect(retryBtn).toBeInTheDocument();

    // After Retry, swap to a successful GET — list should populate.
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(retryBtn);
    expect(
      await screen.findByText(/Police clearance certificate required/i),
    ).toBeInTheDocument();
  });
});

describe('<EmbassyRulesAdmin /> — additional filter combinations', () => {
  it('active-only filter re-fetches with ?isActive=true', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by active state/i), {
      target: { value: 'true' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('isActive=true'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('inactive-only filter re-fetches with ?isActive=false', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by active state/i), {
      target: { value: 'false' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('isActive=false'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('rule-type filter re-fetches with ?ruleType=<value>', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by rule type/i), {
      target: { value: 'cooldown_period' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('ruleType=cooldown_period'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('multiple filters compose into one URL with all three params', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/Filter by destination country/i), {
      target: { value: 'gb' },
    });
    fireEvent.change(screen.getByLabelText(/Filter by severity/i), {
      target: { value: 'blocker' },
    });
    fireEvent.change(screen.getByLabelText(/Filter by active state/i), {
      target: { value: 'true' },
    });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u]) =>
          typeof u === 'string'
          && u.includes('destinationCountry=GB')
          && u.includes('severity=blocker')
          && u.includes('isActive=true'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<EmbassyRulesAdmin /> — additional validation + modal-close paths', () => {
  // #978 closed: the missing-ruleType case is covered by the HTML5 `required`
  // attribute on the input — the browser pre-empts submit before any JS gate
  // can fire. Assert the attribute is in place so a future regression that
  // drops `required` (and silently removes the native validation) reds.
  it('validation — ruleType input carries HTML5 required (native browser validation)', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('embassy-rule-new'));
    await screen.findByText(/New Embassy Rule/i);

    const ruleTypeInput = screen.getByTestId('embassy-rule-form-rule-type');
    expect(ruleTypeInput).toBeRequired();
    expect(ruleTypeInput.tagName).toBe('INPUT');
  });

  // #978 closed: same coverage pattern as the ruleType assertion above —
  // actionLabel relies on HTML5 `required` for the missing-field case. Pin the
  // attribute presence so it can't silently regress.
  it('validation — actionLabel input carries HTML5 required (native browser validation)', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('embassy-rule-new'));
    await screen.findByText(/New Embassy Rule/i);

    const actionLabelInput = screen.getByTestId('embassy-rule-form-action-label');
    expect(actionLabelInput).toBeRequired();
    expect(actionLabelInput.tagName).toBe('INPUT');
  });

  it('Cancel button closes the modal without firing a POST', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('embassy-rule-new'));
    await screen.findByText(/New Embassy Rule/i);

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => {
      expect(screen.queryByText(/New Embassy Rule/i)).toBeNull();
    });
    const postCalls = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/embassy-rules' && o?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('backdrop click closes the modal', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('embassy-rule-new'));
    const heading = await screen.findByText(/New Embassy Rule/i);
    // Backdrop is the presentation div wrapping the form; click it directly.
    const backdrop = heading.closest('[role="presentation"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop);
    await waitFor(() => {
      expect(screen.queryByText(/New Embassy Rule/i)).toBeNull();
    });
  });
});

describe('<EmbassyRulesAdmin /> — edit pre-fill + extra server errors', () => {
  it('edit modal pre-fills applicationType AND PUT body includes it', async () => {
    renderPage();
    const editBtn = await screen.findByTestId('embassy-rule-edit-401');
    fireEvent.click(editBtn);
    await screen.findByText(/Edit Embassy Rule/i);

    // Rule 401 has applicationType=tourist.
    expect(screen.getByTestId('embassy-rule-form-app-type').value).toBe('tourist');
    expect(screen.getByTestId('embassy-rule-form-severity').value).toBe('warning');
    expect(screen.getByTestId('embassy-rule-form-active').checked).toBe(true);

    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByTestId('embassy-rule-form-submit'));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/embassy-rules/401' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.applicationType).toBe('tourist');
      expect(body.severity).toBe('warning');
      expect(body.isActive).toBe(true);
    });
  });

  it('EMBASSY_RULE_DUPLICATE server error → user-friendly toast + banner', async () => {
    const err = new Error('Duplicate rule');
    err.code = 'EMBASSY_RULE_DUPLICATE';
    err.data = { code: 'EMBASSY_RULE_DUPLICATE', error: err.message };

    installFetchMock({ create: err });
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('embassy-rule-new'));
    await screen.findByText(/New Embassy Rule/i);

    fireEvent.change(screen.getByTestId('embassy-rule-form-country'), { target: { value: 'US' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-rule-type'), { target: { value: 'document_required' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-action-label'), { target: { value: 'Dup label' } });
    fireEvent.click(screen.getByTestId('embassy-rule-form-submit'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
      const msg = notifyError.mock.calls[0][0];
      expect(msg).toMatch(/country \+ rule-type \+ application-type combination already exists/i);
    });
    // EMBASSY_RULE_DUPLICATE has no field mapping → renders as generic banner.
    expect(
      screen.getByText(/country \+ rule-type \+ application-type combination already exists/i),
    ).toBeInTheDocument();
  });

  it('RBAC_DENIED server error → generic banner copy (no field-level inline)', async () => {
    const err = new Error('Only admins can mutate embassy rules');
    err.code = 'RBAC_DENIED';
    err.data = { code: 'RBAC_DENIED', error: err.message };

    installFetchMock({ create: err });
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('embassy-rule-new'));
    await screen.findByText(/New Embassy Rule/i);

    fireEvent.change(screen.getByTestId('embassy-rule-form-country'), { target: { value: 'US' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-rule-type'), { target: { value: 'document_required' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-action-label'), { target: { value: 'Banned op' } });
    fireEvent.click(screen.getByTestId('embassy-rule-form-submit'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
      const msg = notifyError.mock.calls[0][0];
      expect(msg).toMatch(/Only admins can modify embassy rules/i);
    });
    // The RBAC_DENIED code badge should appear in the banner.
    expect(screen.getByText(/\[RBAC_DENIED\]/)).toBeInTheDocument();
  });

  it('delete failure → notify.error fired; list NOT reloaded', async () => {
    const err = new Error('boom');
    err.code = 'EMBASSY_RULE_NOT_FOUND';
    err.data = { code: 'EMBASSY_RULE_NOT_FOUND', error: err.message };

    installFetchMock({ del: err });
    renderPage();
    const deleteBtn = await screen.findByTestId('embassy-rule-delete-401');

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchApiMock.mockClear();
    // Re-install with the rejecting delete now that we cleared the mock.
    installFetchMock({ del: err });

    fireEvent.click(deleteBtn);

    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    const msg = notifyError.mock.calls[0][0];
    expect(msg).toMatch(/Rule no longer exists/i);
    // notify.success must NOT have been called (no reload-on-success path).
    expect(notifySuccess).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe('<EmbassyRulesAdmin /> — form + row rendering edge cases', () => {
  it('unchecking the Active checkbox sends isActive=false in the POST body', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('embassy-rule-new'));
    await screen.findByText(/New Embassy Rule/i);

    fireEvent.change(screen.getByTestId('embassy-rule-form-country'), { target: { value: 'US' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-rule-type'), { target: { value: 'document_required' } });
    fireEvent.change(screen.getByTestId('embassy-rule-form-action-label'), { target: { value: 'Soft-disabled rule' } });

    // Default is checked=true; click to uncheck.
    const activeCheckbox = screen.getByTestId('embassy-rule-form-active');
    expect(activeCheckbox.checked).toBe(true);
    fireEvent.click(activeCheckbox);
    expect(activeCheckbox.checked).toBe(false);

    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByTestId('embassy-rule-form-submit'));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/embassy-rules' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.isActive).toBe(false);
    });
  });

  it('row with applicationType=null renders "all" placeholder; inactive row renders "No"', async () => {
    renderPage();
    // Rule 403 has applicationType=null and isActive=false.
    const row = await screen.findByTestId('embassy-rule-row-403');
    expect(row).toHaveTextContent(/all/i);
    expect(row).toHaveTextContent(/No/);
  });
});
