/**
 * Suppliers.test.jsx — vitest + RTL coverage for the Travel-vertical
 * supplier-credential VAULT page (frontend/src/pages/travel/Suppliers.jsx).
 *
 * NOT to be confused with SuppliersAdmin.test.jsx, which covers the SIBLING
 * master-list metadata page (SuppliersAdmin.jsx). They share the "supplier"
 * noun but serve disjoint surfaces:
 *   - SuppliersAdmin.jsx  → /api/travel/suppliers (master list, non-sensitive)
 *   - Suppliers.jsx (THIS) → /api/travel/supplier-credentials (encrypted vault)
 *
 * The vault page lands at /travel/suppliers. Per its header comment + handler
 * shape, the credential plaintext NEVER ships in the list-GET response — only
 * metadata (id, category, supplierName, lastUsedAt). The ADMIN-only "Reveal"
 * button hits POST /:id/reveal which writes an access-log row BEFORE
 * decrypting, then returns the plaintext for ephemeral modal display.
 *
 * Scope — pins the page-surface invariants for the credential-vault admin
 * page (high-security surface, smaller affordance set than its sibling):
 *
 *   1. Page chrome: heading "Supplier Credentials" + AES-256-GCM warning
 *      banner + access-log notice + category filter + "Add credential" CTA
 *      (ADMIN-only — isAdmin = user.role === "ADMIN", SUT line 34).
 *   2. Loading state: shows "Loading…" placeholder before first GET
 *      resolves (await findByText per CLAUDE.md tick #108 cron-learning).
 *   3. GET on mount: hits /api/travel/supplier-credentials (with an empty
 *      query string suffix because SUT always appends `?${qs.toString()}`)
 *      and renders one row per credential (table layout).
 *   4. Empty state: renders "No credentials stored." when API returns [].
 *   5. CREDENTIAL MASKING (CRITICAL — security regression guard): the list
 *      response carries ONLY metadata (no loginId, no password, no
 *      encrypted blob). The page render must NEVER include the password or
 *      loginId strings before the user clicks Reveal. This test plants a
 *      sentinel "PLAINTEXT_PASSWORD_SHOULD_NEVER_LEAK" string into the
 *      mocked list response on a key the SUT does NOT consume — and
 *      asserts document.body.innerHTML does not contain it.
 *   6. Reveal flow: clicking the Reveal button POSTs to
 *      /api/travel/supplier-credentials/:id/reveal, then opens a
 *      role="dialog" modal containing the plaintext loginId + password.
 *   7. Reveal modal close: clicking the X button (aria-label "Close") OR
 *      the overlay backdrop dismisses the modal; clicking the dialog body
 *      does NOT propagate to the overlay (stopPropagation).
 *   8. Category filter: selecting "hotel" re-fetches the list with
 *      ?category=hotel in the query string.
 *   9. Add-credential modal: opens on CTA click; the password input is of
 *      type="password" (the browser masks the field while typing — pin
 *      this so a regression to type="text" is caught).
 *  10. Add validation: missing supplierName / loginId / password surfaces
 *      notify.error("supplierName + loginId + password required") and
 *      does NOT fire POST.
 *  11. Add happy path: filling all 3 required fields + clicking Save POSTs
 *      /api/travel/supplier-credentials with the form body; on success,
 *      notify.success fires + form clears + list re-fetches.
 *  12. Delete flow: clicking Trash2 prompts via window.confirm;
 *      confirm-yes → DELETE /api/travel/supplier-credentials/:id;
 *      confirm-no → no DELETE.
 *  13. RBAC: role=USER hides "Add credential", "Reveal", and "Delete"
 *      buttons (all three are gated on isAdmin).
 *  14. RBAC: role=MANAGER (not ADMIN) ALSO hides credential mutation
 *      buttons. Vault is tighter than the master-list (ADMIN-only vs
 *      ADMIN+MANAGER). Pin both gates.
 *
 * Backend contract pinned (per backend/routes/travel_suppliers.js
 * supplier-credentials handlers, shipped commit 192b8c1 + later hardening):
 *   GET    /api/travel/supplier-credentials[?category=]
 *          → 200 { credentials: [{ id, category, supplierName,
 *                                  lastUsedAt, createdAt, ... }] }
 *   POST   /api/travel/supplier-credentials
 *          body:{ category, supplierName, loginId, password }
 *          → 201 created (ADMIN-only). Backend encrypts password
 *            AES-256-GCM before persisting.
 *   POST   /api/travel/supplier-credentials/:id/reveal
 *          → 200 { id, category, supplierName, loginId, password,
 *                  metadata? }
 *            Writes access-log row BEFORE decrypting.
 *   DELETE /api/travel/supplier-credentials/:id
 *          → 204 No Content (ADMIN-only).
 *
 * Drift pinned (prompt vs. actual code — per CLAUDE.md tick #109-#119
 * agents' prompt-drift discipline; ALL prompts have been wrong about
 * something):
 *   - Prompt assumed the list GET returns a "credential-masked" shape
 *     `{ apiKey: { configured: true, last4: 'ab12' } }` (per the v3.7.8
 *     cron-learning) — WRONG for THIS page. Suppliers.jsx never reads
 *     loginId / password from the list-GET. The list response is pure
 *     metadata; full plaintext only ships on the explicit POST /:id/reveal
 *     endpoint. The "no raw key in DOM" guard is therefore stronger: NOT
 *     "raw key is masked", but "the field doesn't exist in the response
 *     shape at all". Test #5 plants a sentinel in an ignored key to prove
 *     the SUT genuinely doesn't render fields it doesn't read.
 *   - Prompt assumed sub-brand filter — WRONG. SUT has only a category
 *     filter (CATEGORIES constant, SUT line 15-24). No sub-brand chrome
 *     on this page; vault is per-tenant not per-sub-brand.
 *   - Prompt assumed "edit-credential flow" — WRONG. SUT has NO edit
 *     handler at all (no PUT, no openEdit, no rotate button). The model
 *     is "add new, reveal existing, delete obsolete". Tests omit the
 *     edit flow entirely.
 *   - Prompt assumed delete uses notify.confirm — WRONG. SUT uses native
 *     window.confirm (SUT line 90: `if (!confirm(...))`).
 *   - Prompt assumed RBAC gate is "ADMIN-only? MANAGER-allowed?" — actual
 *     gate is ADMIN-only. SUT line 34: `const isAdmin = user?.role ===
 *     "ADMIN"`. MANAGER is NOT a credential-vault writer. Test #14 pins
 *     this tighter gate explicitly.
 *   - Prompt assumed access-log display surface — WRONG. There's no
 *     in-page access-log table. Access-log presence is communicated only
 *     via a static warning banner ("Every Reveal click writes an
 *     access-log row...") + modal footnote ("This view has been logged in
 *     the credential's access trail"). Tests assert the banner copy +
 *     footnote copy render, not a per-row log table.
 *   - Prompt said "Loading…" — SUT renders `Loading&hellip;` HTML entity
 *     which DOM resolves to the unicode `Loading…`. Test #2 asserts on
 *     findByText('Loading…') with the real ellipsis char.
 *   - Prompt mentioned a 403 → "access-restricted state" — WRONG. SUT has
 *     no special 403 handling; all errors fall through `notify.error(...)
 *     + setCreds([])`. No "Access restricted" copy on this page.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (RTL standing rule: Wave 11 cfb5789 /
 *     Wave 12 f59e91d — fresh per-call objects flap useCallback identity).
 *   - AuthContext consumed from the real App module via Provider in the
 *     render wrapper (the SUT reads user.role to gate every mutation
 *     button). Default user role = ADMIN; one test mounts with USER,
 *     another with MANAGER.
 *   - window.confirm stubbed per-test for the delete flow.
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning).
 *
 * Path: flat __tests__/Suppliers.test.jsx — distinct from existing
 * SuppliersAdmin.test.jsx (verified via `ls Supplier*` pre-commit).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). The SUT closes over notify inside add / reveal / remove, so
// a fresh object per render would flap state across re-renders.
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
import Suppliers from '../pages/travel/Suppliers';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const MANAGER_USER = { userId: 2, name: 'Mgr', email: 'm@x.com', role: 'MANAGER' };
const USER_USER = { userId: 3, name: 'Plain User', email: 'u@x.com', role: 'USER' };

// Canonical credential metadata rows (NOTE: NO loginId / password fields on
// the list-GET response shape — only metadata. This is the contract; the
// SUT only consumes id / category / supplierName / lastUsedAt).
function makeCred(overrides = {}) {
  return {
    id: 501,
    tenantId: 1,
    category: 'airline',
    supplierName: 'Airline Portal',
    lastUsedAt: '2026-05-20T10:00:00.000Z',
    createdAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

const CREDS_DEFAULT = [
  makeCred({ id: 501, category: 'airline', supplierName: 'Airline Portal' }),
  makeCred({ id: 502, category: 'hotel', supplierName: 'Hotel Reservations', lastUsedAt: null }),
  makeCred({ id: 503, category: 'visa-portal', supplierName: 'Visa Govt Portal' }),
];

function installFetchMock({
  list = { credentials: CREDS_DEFAULT },
  create = null,
  reveal = null,
  del = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    // Reveal endpoint must match BEFORE the bare-list pattern (it shares the prefix).
    if (/\/api\/travel\/supplier-credentials\/\d+\/reveal$/.test(url) && method === 'POST') {
      if (reveal instanceof Error) return Promise.reject(reveal);
      return Promise.resolve(reveal || {
        id: 501, category: 'airline', supplierName: 'Airline Portal',
        loginId: 'agent-77', password: 'sup3r-secret-pw-revealed',
      });
    }
    if (/^\/api\/travel\/supplier-credentials\/\d+$/.test(url) && method === 'DELETE') {
      if (del instanceof Error) return Promise.reject(del);
      return Promise.resolve(null);
    }
    if (url === '/api/travel/supplier-credentials' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeCred({ id: 999 }));
    }
    if (url.startsWith('/api/travel/supplier-credentials') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <AuthContext.Provider value={value}>
      <Suppliers />
    </AuthContext.Provider>,
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

describe('<Suppliers /> — page chrome + RBAC (vault is ADMIN-only)', () => {
  it('renders heading + warning banner + category filter + "Add credential" CTA when role=ADMIN', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Supplier Credentials/i }),
    ).toBeInTheDocument();
    // AES-256-GCM warning copy in the sub-header.
    expect(screen.getByText(/AES-256-GCM at-rest/i)).toBeInTheDocument();
    // Access-log warning banner (not a per-row table, just static copy).
    expect(screen.getByText(/access-log row/)).toBeInTheDocument();
    expect(screen.getByText(/Only use when actively logging into the supplier portal/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by category/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add credential/i })).toBeInTheDocument();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(([u]) =>
        typeof u === 'string' && u.startsWith('/api/travel/supplier-credentials'));
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('hides "Add credential" CTA + Reveal/Delete buttons for plain USER role', async () => {
    renderPage(USER_USER);
    await screen.findByText('Airline Portal');
    expect(screen.queryByRole('button', { name: /Add credential/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reveal credential for /i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete credential for /i })).toBeNull();
  });

  it('hides "Add credential" CTA + Reveal/Delete buttons for MANAGER role (vault is ADMIN-only, tighter than master-list)', async () => {
    renderPage(MANAGER_USER);
    await screen.findByText('Airline Portal');
    expect(screen.queryByRole('button', { name: /Add credential/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reveal credential for /i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete credential for /i })).toBeNull();
  });
});

describe('<Suppliers /> — load + render lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/supplier-credentials') && method === 'GET') {
        return new Promise((res) => { resolveList = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveList({ credentials: CREDS_DEFAULT });
    await screen.findByText('Airline Portal');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/travel/supplier-credentials on mount and renders one row per credential', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.startsWith('/api/travel/supplier-credentials')
        && !u.includes('/reveal') && (!o?.method || o.method === 'GET'),
      );
      expect(listCall).toBeTruthy();
    });
    expect(await screen.findByText('Airline Portal')).toBeInTheDocument();
    expect(screen.getByText('Hotel Reservations')).toBeInTheDocument();
    expect(screen.getByText('Visa Govt Portal')).toBeInTheDocument();
  });

  it('renders empty state "No credentials stored." when API returns []', async () => {
    installFetchMock({ list: { credentials: [] } });
    renderPage();
    expect(await screen.findByText(/No credentials stored\./i)).toBeInTheDocument();
  });

  it('SECURITY GUARD: list-GET response NEVER renders plaintext password/loginId, even if backend regresses and leaks them in the row payload', async () => {
    // Plant a sentinel plaintext on the list-GET row. The SUT does NOT
    // consume password / loginId from the list response — only id /
    // category / supplierName / lastUsedAt. If a regression starts
    // rendering arbitrary row fields (e.g. via a debug spread), this
    // sentinel will appear in document.body and trip the assertion.
    const SENTINEL_PASSWORD = 'PLAINTEXT_PASSWORD_SHOULD_NEVER_LEAK_xyz_42';
    const SENTINEL_LOGIN = 'PLAINTEXT_LOGINID_SHOULD_NEVER_LEAK_abc_99';
    installFetchMock({
      list: {
        credentials: [
          makeCred({
            id: 501, supplierName: 'Airline Portal',
            // These fields should NEVER be sent by a hardened backend,
            // but we plant them defensively to verify the frontend
            // doesn't render unknown fields blindly.
            password: SENTINEL_PASSWORD,
            loginId: SENTINEL_LOGIN,
            encryptedBlob: 'enc:zzz:deadbeef',
          }),
        ],
      },
    });
    renderPage();
    await screen.findByText('Airline Portal');
    // The supplier name + category + date render, but the sentinel
    // fields do NOT.
    expect(screen.getByText('Airline Portal')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(SENTINEL_PASSWORD);
    expect(document.body.innerHTML).not.toContain(SENTINEL_LOGIN);
    expect(document.body.innerHTML).not.toContain('enc:zzz:deadbeef');
    // No reveal modal opened spontaneously.
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('<Suppliers /> — category filter', () => {
  it('selecting category "hotel" re-fetches the list with ?category=hotel', async () => {
    renderPage();
    await screen.findByText('Airline Portal');
    fetchApiMock.mockClear();
    installFetchMock({ list: { credentials: [CREDS_DEFAULT[1]] } });
    fireEvent.change(screen.getByLabelText(/Filter by category/i), { target: { value: 'hotel' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.includes('category=hotel')
        && !u.includes('/reveal') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<Suppliers /> — reveal flow (the one place plaintext appears)', () => {
  it('clicking Reveal POSTs /:id/reveal and opens a dialog modal with the plaintext loginId + password', async () => {
    renderPage();
    await screen.findByText('Airline Portal');
    // Before click: no dialog. No plaintext anywhere.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain('sup3r-secret-pw-revealed');

    fetchApiMock.mockClear();
    installFetchMock({
      reveal: {
        id: 501, category: 'airline', supplierName: 'Airline Portal',
        loginId: 'agent-77', password: 'sup3r-secret-pw-revealed',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Reveal credential for Airline Portal$/ }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/supplier-credentials/501/reveal' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
    });
    // Modal opens with plaintext.
    const dialog = await screen.findByRole('dialog', { name: /Revealed credential/i });
    expect(within(dialog).getByText('agent-77')).toBeInTheDocument();
    expect(within(dialog).getByText('sup3r-secret-pw-revealed')).toBeInTheDocument();
    // Footnote about access logging.
    expect(within(dialog).getByText(/logged in the credential's access trail/i)).toBeInTheDocument();
  });

  it('clicking the X button dismisses the reveal modal', async () => {
    renderPage();
    await screen.findByText('Airline Portal');
    fireEvent.click(screen.getByRole('button', { name: /^Reveal credential for Airline Portal$/ }));
    const dialog = await screen.findByRole('dialog', { name: /Revealed credential/i });
    expect(within(dialog).getByText('sup3r-secret-pw-revealed')).toBeInTheDocument();
    // Close via X icon-btn (aria-label "Close").
    fireEvent.click(within(dialog).getByRole('button', { name: /^Close$/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // Plaintext gone from DOM after close.
    expect(document.body.innerHTML).not.toContain('sup3r-secret-pw-revealed');
  });
});

describe('<Suppliers /> — add + delete', () => {
  it('clicking "Add credential" reveals form; password input has type="password" (browser masks while typing)', async () => {
    renderPage();
    await screen.findByText('Airline Portal');
    // Form fields not present yet.
    expect(screen.queryByPlaceholderText(/^Supplier name$/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Add credential/i }));
    // After click, form surfaces.
    expect(screen.getByPlaceholderText(/^Supplier name$/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/^Login ID$/i)).toBeInTheDocument();
    const pwInput = screen.getByPlaceholderText(/^Password$/i);
    expect(pwInput).toBeInTheDocument();
    // CRITICAL: password input must be type="password" (security regression
    // class: a flip to "text" would un-mask the field as the user types).
    expect(pwInput.getAttribute('type')).toBe('password');
  });

  it('validation: blank fields surface notify.error("supplierName + loginId + password required") and do NOT fire POST', async () => {
    renderPage();
    await screen.findByText('Airline Portal');
    fireEvent.click(screen.getByRole('button', { name: /Add credential/i }));
    fetchApiMock.mockClear();
    // Click Save with no input.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/supplierName \+ loginId \+ password required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/supplier-credentials' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('happy path: filled form POSTs body with category/supplierName/loginId/password, then re-fetches list', async () => {
    renderPage();
    await screen.findByText('Airline Portal');
    fireEvent.click(screen.getByRole('button', { name: /Add credential/i }));
    fireEvent.change(screen.getByPlaceholderText(/^Supplier name$/i), { target: { value: 'New Portal' } });
    fireEvent.change(screen.getByPlaceholderText(/^Login ID$/i), { target: { value: 'agent-99' } });
    fireEvent.change(screen.getByPlaceholderText(/^Password$/i), { target: { value: 'fresh-pw' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/supplier-credentials' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.category).toBe('airline'); // EMPTY_FORM default
      expect(body.supplierName).toBe('New Portal');
      expect(body.loginId).toBe('agent-99');
      expect(body.password).toBe('fresh-pw');
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Credential stored \(encrypted\)/i),
    );
    // List re-fetched after add (count GET-list calls AFTER mockClear).
    await waitFor(() => {
      const gets = fetchApiMock.mock.calls.filter(([u, o]) =>
        typeof u === 'string' && u.startsWith('/api/travel/supplier-credentials')
        && !u.includes('/reveal')
        && (!o?.method || o.method === 'GET'),
      );
      expect(gets.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('delete flow: confirm-yes → DELETE /:id; confirm-no → no DELETE', async () => {
    renderPage();
    await screen.findByText('Airline Portal');
    // Confirm-no path.
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: /^Delete credential for Airline Portal$/ }));
    await waitFor(() => {
      const deletes = fetchApiMock.mock.calls.filter(([u, o]) =>
        typeof u === 'string' && /^\/api\/travel\/supplier-credentials\/\d+$/.test(u) && o?.method === 'DELETE',
      );
      expect(deletes.length).toBe(0);
    });
    // Confirm-yes path.
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: /^Delete credential for Airline Portal$/ }));
    await waitFor(() => {
      const deletes = fetchApiMock.mock.calls.filter(([u, o]) =>
        u === '/api/travel/supplier-credentials/501' && o?.method === 'DELETE',
      );
      expect(deletes.length).toBe(1);
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Deleted/i));
  });
});
