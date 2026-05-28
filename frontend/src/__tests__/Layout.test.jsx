import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';
import Layout from '../components/Layout';
import { AuthContext, ThemeContext } from '../App';

// Stub the heavy children — we care about Layout's wiring
vi.mock('../components/Sidebar', () => ({ default: () => <div data-testid="sidebar-stub" /> }));
vi.mock('../components/Omnibar', () => ({ default: () => <div data-testid="omnibar-stub" /> }));
vi.mock('../components/Presence', () => ({ default: () => <div data-testid="presence-stub" /> }));
vi.mock('../components/Softphone', () => ({ default: () => <div data-testid="softphone-stub" /> }));
vi.mock('../components/NotificationBell', () => ({ default: () => <div data-testid="bell-stub" /> }));

// #555: mock fetchApi (Layout no longer pings /api/auth/tenants under
// lock-per-session — the chip reads from AuthContext.tenant — but
// fetchApi is still used by the subscription-status fetch elsewhere in
// Layout, so the mock stays.).
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  setActiveTenantId: () => {},
  getActiveTenantId: () => null,
}));

const setupPushMock = vi.fn(() => Promise.resolve(true));
vi.mock('../utils/pushSetup', () => ({ setupPush: (...args) => setupPushMock(...args) }));

function renderLayout(args = {}) {
  const { user, initialRoute = '/' } = args;
  // Honor explicit `tenant: null` (the "missing-tenant state" test passes this).
  // Pre-fix, the `|| { vertical: 'generic' }` fallthrough ate the null and the
  // test couldn't reach the no-tenant branch.
  const tenant = 'tenant' in args ? args.tenant : { vertical: 'generic' };
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <AuthContext.Provider value={{
        user: user || { name: 'Alice', email: 'alice@x.test', role: 'USER' },
        setUser: vi.fn(),
        token: 't-abc',
        setToken: vi.fn(),
        tenant,
        setTenant: vi.fn(),
      }}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<div data-testid="outlet">HOME</div>} />
          </Route>
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe('Layout', () => {
  beforeEach(() => {
    setupPushMock.mockClear();
    fetchApiMock.mockReset();
    fetchApiMock.mockResolvedValue({});
  });

  it('renders Sidebar + Omnibar + Presence + NotificationBell + outlet', () => {
    renderLayout();
    expect(screen.getByTestId('sidebar-stub')).toBeInTheDocument();
    expect(screen.getByTestId('omnibar-stub')).toBeInTheDocument();
    expect(screen.getByTestId('presence-stub')).toBeInTheDocument();
    expect(screen.getByTestId('bell-stub')).toBeInTheDocument();
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });

  it('renders Softphone for generic tenants', () => {
    renderLayout({ tenant: { vertical: 'generic' } });
    expect(screen.getByTestId('softphone-stub')).toBeInTheDocument();
  });

  it('hides Softphone for wellness tenants (Callified handles voice)', () => {
    renderLayout({ tenant: { vertical: 'wellness' } });
    expect(screen.queryByTestId('softphone-stub')).not.toBeInTheDocument();
  });

  it('shows user name + email initial', () => {
    renderLayout({ user: { name: 'Bob', email: 'bob@x.test', role: 'USER' } });
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('falls back to "User" label when user has no name/email', () => {
    renderLayout({ user: { role: 'USER' } });
    expect(screen.getByText('User')).toBeInTheDocument();
  });

  it('registers push on mount when token present', () => {
    renderLayout();
    expect(setupPushMock).toHaveBeenCalledWith('t-abc');
  });

  it('logout button has aria-label + is clickable', () => {
    renderLayout();
    const btn = screen.getByLabelText(/Log out/i);
    expect(btn).toBeInTheDocument();
    // Clicking should not crash — side effects (navigate, token clear) happen
    fireEvent.click(btn);
    expect(localStorage.getItem('token')).toBeNull();
  });

  // #642: header avatar renders a role pip so the signed-in operator can
  // tell at a glance whether they're Owner / Admin / Manager / User.
  it('renders the role badge on the header avatar when authenticated', () => {
    renderLayout({ user: { name: 'Rishu', email: 'rishu@x.test', role: 'ADMIN' } });
    const pip = screen.getByTestId('avatar-role-badge');
    expect(pip).toBeInTheDocument();
    expect(pip).toHaveTextContent('A');
    expect(pip).toHaveAttribute('aria-label', 'Role: ADMIN');
  });

  it('renders OWNER role pip distinct from ADMIN', () => {
    renderLayout({ user: { name: 'Owner', email: 'o@x.test', role: 'OWNER' } });
    expect(screen.getByTestId('avatar-role-badge')).toHaveTextContent('O');
  });

  // #555 (HI-06) — lock-per-session policy. The earlier in-session
  // switcher widget is gone; in its place is a read-only chip that
  // shows the active tenant prominently. To switch tenants, users log
  // out and log back in.
  it('renders the read-only tenant chip with the tenant name', () => {
    renderLayout({ tenant: { id: 1, name: 'Default Org', vertical: 'generic' } });
    const chip = screen.getByTestId('tenant-chip');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent('Default Org');
  });

  it('marks the chip as wellness when the tenant vertical is wellness', () => {
    renderLayout({ tenant: { id: 2, name: 'Enhanced Wellness', vertical: 'wellness' } });
    const chip = screen.getByTestId('tenant-chip');
    expect(chip).toHaveTextContent('Enhanced Wellness');
    expect(chip).toHaveTextContent(/wellness/i);
  });

  it('does NOT render an in-session switcher (lock-per-session policy)', () => {
    renderLayout({ tenant: { id: 1, name: 'Default Org', vertical: 'generic' } });
    expect(screen.queryByTestId('tenant-switcher')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /switch tenant/i })).not.toBeInTheDocument();
  });

  it('chip is non-interactive (no click handler dispatches a switch)', () => {
    renderLayout({ tenant: { id: 1, name: 'Default Org', vertical: 'generic' } });
    const chip = screen.getByTestId('tenant-chip');
    fireEvent.click(chip);
    // No /api/auth/tenant-switch call should ever fire from clicking the chip.
    const calls = fetchApiMock.mock.calls;
    expect(calls.find((c) => c[0] === '/api/auth/tenant-switch')).toBeFalsy();
  });

  it('renders nothing when tenant is missing', () => {
    renderLayout({ tenant: null });
    expect(screen.queryByTestId('tenant-chip')).not.toBeInTheDocument();
  });

  // #725 — the TenantChip background must come from a CSS variable
  // (--accent-bg with a theme-aware var-fallback chain), NOT the hardcoded
  // light-blue hex (`#f0f4ff`) that pre-fix bled through on non-wellness dark
  // mode. We assert the inline style references the var so a future regression
  // (re-introducing a hex literal) is caught by this test.
  it('TenantChip background uses var(--accent-bg) — no hardcoded #f0f4ff fallback', () => {
    renderLayout({ tenant: { id: 1, name: 'Default Org', vertical: 'generic' } });
    const chip = screen.getByTestId('tenant-chip');
    const inlineBg = chip.getAttribute('style') || '';
    expect(inlineBg).toMatch(/var\(--accent-bg/);
    // Defensive: the previous hardcoded fallback was #f0f4ff. If it shows up
    // anywhere in the inline style, the regression is back.
    expect(inlineBg).not.toMatch(/#f0f4ff/i);
  });

  // #730 — `{daysRemaining && <TrialBanner/>}` previously rendered a literal
  // "0" between the header and main when daysRemaining === 0 (last-day-of-trial
  // / expired), because `&&` short-circuits to the falsy left-hand numeric.
  // The fix uses `daysRemaining > 0` which short-circuits to `false`. We pin
  // the negative contract here: after the subscription fetch resolves with
  // daysRemaining=0, the .app-main subtree has no stray "0" text node child
  // before <main>.
  it('does not render a stray "0" text node when daysRemaining === 0 (#730)', async () => {
    // Make the subscriptions/status probe return daysRemaining=0 to force
    // the falsy-numeric path that previously bled through.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/subscriptions/status') {
        return Promise.resolve({ daysRemaining: 0, trialEndsAt: null });
      }
      return Promise.resolve({});
    });
    renderLayout();
    // Allow the useEffect-driven fetch to settle.
    await new Promise((r) => setTimeout(r, 10));
    // Walk the .app-main subtree's immediate children and assert no text node
    // is exactly "0". The bug surface was a sibling text node between
    // <header> and <main>, NOT inside any element's textContent.
    const appMain = document.querySelector('.app-main');
    expect(appMain).toBeTruthy();
    const strayZeros = Array.from(appMain.childNodes).filter(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim() === '0',
    );
    expect(strayZeros).toHaveLength(0);
  });

  it('still does not render a stray "0" when daysRemaining is null (subscription endpoint silent)', async () => {
    // The endpoint-silent path (fetchApi resolves to {} so daysRemaining stays
    // at its null initial state) is the common case — pin it too so a future
    // refactor that flips the guard back to bare-truthy doesn't slip through.
    fetchApiMock.mockResolvedValue({});
    renderLayout();
    await new Promise((r) => setTimeout(r, 10));
    const appMain = document.querySelector('.app-main');
    const strayZeros = Array.from(appMain.childNodes).filter(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim() === '0',
    );
    expect(strayZeros).toHaveLength(0);
  });

  // -- Extended coverage (Layout.jsx is 416L; bring ratio above 51%) --
  //
  // The cases below target uncovered branches identified by reading the SUT
  // end-to-end: SMS banner gating by role + features.smsConfigured,
  // hamburger aria-controls + aria-expanded initial state, search button
  // event dispatch (#851), logout server-side revocation call (#528),
  // theme-toggle ThemeContext branch (#862), document.title tenant-
  // awareness (#704), build footer rendering (#634), and push-setup
  // token gating.

  // T1.2 -- SMS banner visible to ADMIN when smsConfigured===false.
  it('renders the SMS-not-configured banner for ADMIN when features.smsConfigured is false', () => {
    renderLayout({
      user: { name: 'Admin', email: 'a@x.test', role: 'ADMIN', features: { smsConfigured: false } },
    });
    expect(screen.getByTestId('sms-not-configured-banner')).toBeInTheDocument();
  });

  it('renders the SMS banner for MANAGER too (isStaff branch)', () => {
    renderLayout({
      user: { name: 'Mgr', email: 'm@x.test', role: 'MANAGER', features: { smsConfigured: false } },
    });
    expect(screen.getByTestId('sms-not-configured-banner')).toBeInTheDocument();
  });

  it('hides the SMS banner for regular USERs even when smsConfigured===false', () => {
    renderLayout({
      user: { name: 'User', email: 'u@x.test', role: 'USER', features: { smsConfigured: false } },
    });
    expect(screen.queryByTestId('sms-not-configured-banner')).not.toBeInTheDocument();
  });

  it('hides the SMS banner when smsConfigured===true', () => {
    renderLayout({
      user: { name: 'Admin', email: 'a@x.test', role: 'ADMIN', features: { smsConfigured: true } },
    });
    expect(screen.queryByTestId('sms-not-configured-banner')).not.toBeInTheDocument();
  });

  // T2.1 -- hamburger toggle exposes correct aria attributes for desktop
  // resting state. JSDOM matchMedia defaults to non-mobile, and Layout's
  // auto-close effect immediately reverts sidebarOpen to false after any
  // open click on desktop. So we pin the wiring (aria-controls,
  // aria-expanded initial, .sidebar-toggle class) rather than the
  // open-flow which is asymmetric to the viewport.
  it('hamburger toggle exposes correct aria-controls + initial aria-expanded', () => {
    renderLayout();
    const btn = screen.getByLabelText(/Open navigation menu/i);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-controls', 'app-sidebar');
    expect(btn).toHaveClass('sidebar-toggle');
    expect(btn).toHaveAttribute('type', 'button');
  });

  // #851 -- the legacy "Open global search" header button dispatched
  // `omnibar:open` so the dropdown panel would open without a keyboard
  // shortcut. e7253919 replaced the button with an INLINE <Omnibar /> in the
  // header (see Layout.jsx:376), so the dispatch contract no longer has a UI
  // surface in Layout — the omnibar:open listener is still wired in Omnibar
  // for any external caller that hasn't migrated (Omnibar.jsx:283), and the
  // listener side is covered by Omnibar.test.jsx.
  it.skip('search button dispatches an omnibar:open CustomEvent — removed in e7253919 (inline Omnibar)', () => {});

  // #528 (CRIT-03 fix) -- logout calls POST /api/auth/logout server-side
  // BEFORE clearing local state, so the JWT is added to the RevokedToken
  // denylist. Without this, a captured bearer remains valid for 7 days.
  it('logout calls POST /api/auth/logout for server-side JWT revocation (#528)', async () => {
    renderLayout();
    const btn = screen.getByLabelText(/Log out/i);
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 10));
    const logoutCalls = fetchApiMock.mock.calls.filter(
      (c) => c[0] === '/api/auth/logout',
    );
    expect(logoutCalls.length).toBeGreaterThanOrEqual(1);
    expect(logoutCalls[0][1]).toMatchObject({ method: 'POST', silent: true });
  });

  // #862 -- theme toggle button is gated on ThemeContext.toggleTheme. With
  // no provider, the guard (`useContext(ThemeContext) || {}`) returns
  // undefined and the button is skipped.
  it('theme toggle button is absent when ThemeContext is not provided', () => {
    renderLayout();
    expect(screen.queryByLabelText(/Switch theme/i)).not.toBeInTheDocument();
  });

  it('theme toggle button renders + calls toggleTheme when ThemeContext provides one', () => {
    const toggleTheme = vi.fn();
    render(
      <MemoryRouter initialEntries={['/']}>
        <ThemeContext.Provider value={{ theme: 'light', toggleTheme }}>
          <AuthContext.Provider value={{
            user: { name: 'Alice', email: 'a@x.test', role: 'USER' },
            setUser: vi.fn(), token: 't-abc', setToken: vi.fn(),
            tenant: { vertical: 'generic', name: 'Default Org' }, setTenant: vi.fn(),
          }}>
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<div data-testid="outlet">HOME</div>} />
              </Route>
            </Routes>
          </AuthContext.Provider>
        </ThemeContext.Provider>
      </MemoryRouter>
    );
    const themeBtn = screen.getByLabelText(/Switch theme \(currently light\)/i);
    expect(themeBtn).toBeInTheDocument();
    fireEvent.click(themeBtn);
    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });

  // #704 -- document.title reflects tenant.name so operators with many
  // open tabs can pick out the CRM tab fast.
  it('updates document.title with the tenant name (#704)', async () => {
    renderLayout({ tenant: { id: 1, name: 'Acme Corp', vertical: 'generic' } });
    await new Promise((r) => setTimeout(r, 5));
    expect(document.title).toBe('Acme Corp — CRM');
  });

  it('falls back to "Globussoft CRM" title when tenant.name is missing', async () => {
    renderLayout({ tenant: { vertical: 'generic' } });
    await new Promise((r) => setTimeout(r, 5));
    expect(document.title).toBe('Globussoft CRM');
  });

  // #634 / #656 -- the build footer always shows the version (visible to
  // everyone, already in /api/health). The git-SHA component is gated to
  // ADMINs in the SUT (recon-leak guard).
  it('build footer renders with the version for any authenticated user', () => {
    renderLayout({ user: { name: 'U', email: 'u@x.test', role: 'USER' } });
    const footer = screen.getByTestId('app-build-footer');
    expect(footer).toBeInTheDocument();
    expect(footer.textContent).toMatch(/v[\w.\-]+/);
  });

  // Push setup is gated on a truthy token; without a token, setupPush is
  // never invoked (avoids registering push for the not-yet-authenticated
  // splash/login path).
  it('does NOT call setupPush when token is falsy', () => {
    setupPushMock.mockClear();
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthContext.Provider value={{
          user: { name: 'A', email: 'a@x.test', role: 'USER' },
          setUser: vi.fn(), token: null, setToken: vi.fn(),
          tenant: { vertical: 'generic' }, setTenant: vi.fn(),
        }}>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<div data-testid="outlet">HOME</div>} />
            </Route>
          </Routes>
        </AuthContext.Provider>
      </MemoryRouter>
    );
    expect(setupPushMock).not.toHaveBeenCalled();
  });

  // The subscription-status fetch is gated on user truthiness. Pin the
  // silent:true + endpoint to prevent a future refactor from flipping it
  // to a noisy fetch on every render.
  it('fetches /api/subscriptions/status when user is present', async () => {
    renderLayout();
    await new Promise((r) => setTimeout(r, 10));
    const subCalls = fetchApiMock.mock.calls.filter(
      (c) => c[0] === '/api/subscriptions/status',
    );
    expect(subCalls.length).toBeGreaterThanOrEqual(1);
    expect(subCalls[0][1]).toMatchObject({ silent: true });
  });
});
