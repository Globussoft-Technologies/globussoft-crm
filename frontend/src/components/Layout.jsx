import React, { useContext, useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
// #475: removed ChevronDown import — the chevron next to the user name
// implied a dropdown affordance that didn't exist; clicking it just navigated
// to /profile. Logout is already a separate sibling button, so the simplest
// honest fix is to drop the chevron rather than add a dropdown that
// duplicates the logout button.
import { LogOut, Menu, Building2 } from 'lucide-react';
import Sidebar from './Sidebar';
import Omnibar from './Omnibar';
import Presence from './Presence';
import Softphone from './Softphone';
import NotificationBell from './NotificationBell';
import Avatar from './Avatar';
import TrialBanner from './TrialBanner';
import SubscriptionExpiryModal from './SubscriptionExpiryModal';
import { AuthContext } from '../App';
import { fetchApi } from '../utils/api';
import { setupPush } from '../utils/pushSetup';

// #555 (HI-06) — lock-per-session policy.
//
// Pre-fix, the SPA's tenant context could flip silently based on URL
// pathname — no switcher in the chrome, no audit trail, localStorage
// could disagree with the rendered shell (pen-test privilege-confusion
// surface). The earlier fix shipped an explicit switcher widget; v3.7.2
// disposition reset the policy to lock-per-session — pick the tenant at
// login and log out to switch. This component is now a READ-ONLY chip
// showing the active tenant prominently; there is no in-session switch
// path. The backend `/api/auth/tenant-switch` endpoint now returns
// 410 Gone with code TENANT_SWITCH_DISABLED.
function TenantChip({ tenant }) {
  if (!tenant?.name) return null;
  const isWellness = tenant?.vertical === 'wellness';
  return (
    <div
      data-testid="tenant-chip"
      title="Tenant is locked for this session. Log out and log back in to switch."
      style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        background: 'transparent', border: '1px solid var(--border-color)',
        color: 'var(--text-primary)', borderRadius: 8,
        padding: '6px 10px', fontSize: '0.85rem',
      }}
    >
      <Building2 size={14} aria-hidden="true" />
      <span>{tenant.name}</span>
      {isWellness && (
        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
          (wellness)
        </span>
      )}
    </div>
  );
}

// T2.1: drawer breakpoint. Mirror of the @media (max-width: 899px) rule in
// frontend/src/styles/responsive.css. CSS owns the visual contract; JS uses
// this constant only to decide when the sidebar is in "drawer" mode and
// therefore needs role="dialog" + aria-modal="true" + a focus trap.
const MOBILE_BREAKPOINT_PX = 900;

const Layout = () => {
  const { user, setUser, setToken, token, tenant, setTenant } = useContext(AuthContext);
  const navigate = useNavigate();
  // Wellness tenants use Callified.ai for voice — hide the built-in softphone
  const isWellness = tenant?.vertical === 'wellness';
  // T2.1 (extends #228): drawer state for the mobile sidebar (<900px). Desktop
  // (>=900px) ignores this — CSS keeps the sidebar statically positioned.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Track viewport so we can apply role="dialog" + aria-modal only when the
  // sidebar is actually rendering as a drawer. SSR-safe initial value: assume
  // desktop, then sync on mount via the resize listener below.
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  // Keep a ref to the hamburger so we can return focus to it when the drawer
  // closes — required for keyboard / screen-reader users (WAI-ARIA APG dialog
  // pattern: focus must return to the trigger).
  const toggleRef = useRef(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
    const update = () => setIsMobileViewport(mql.matches);
    update();
    // matchMedia change events: addEventListener is the modern API; some
    // older Safari builds only have addListener. Try modern first.
    if (mql.addEventListener) {
      mql.addEventListener('change', update);
      return () => mql.removeEventListener('change', update);
    }
    mql.addListener(update);
    return () => mql.removeListener(update);
  }, []);

  // When the drawer closes (either via backdrop, ESC, route change, or the
  // user resizing back to desktop), return focus to the hamburger so keyboard
  // users don't lose their place. Only fires when transitioning from
  // open → closed; the open path (focus into the drawer) is handled in
  // Sidebar.jsx where the first focusable link lives.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !sidebarOpen) {
      toggleRef.current?.focus();
    }
    wasOpenRef.current = sidebarOpen;
  }, [sidebarOpen]);

  // If the user resizes from mobile back to desktop while the drawer is open,
  // close it — otherwise the drawer state lingers and the next mobile-resize
  // re-opens it unexpectedly. Cheap and idempotent.
  useEffect(() => {
    if (!isMobileViewport && sidebarOpen) setSidebarOpen(false);
  }, [isMobileViewport, sidebarOpen]);

  // T1.2: warn admin/manager when SMS provider is not configured. Patient
  // portal OTP login + appointment reminders silently fail without it. The
  // /api/auth/me response includes features.smsConfigured (set in
  // backend/routes/auth.js:331). Hide for regular USERs since they can't
  // do anything about it.
  const role = user?.role;
  const isStaff = role === 'ADMIN' || role === 'MANAGER';
  const showSmsBanner = isStaff && user?.features?.smsConfigured === false;

  const [daysRemaining, setDaysRemaining] = useState(null);
  const [trialEndsAt, setTrialEndsAt] = useState(null);

  // Auto-register push notifications after login (silent failures OK)
  useEffect(() => {
    if (token) setupPush(token).catch(() => {});
  }, [token]);

  // #704: tenant-aware document.title so operators with many open tabs can
  // identify the CRM tab quickly. Falls back to the static "Globussoft CRM"
  // when tenant hasn't loaded yet (pre-login, splash, transient).
  useEffect(() => {
    const brand = tenant?.name?.trim();
    const next = brand ? `${brand} — CRM` : 'Globussoft CRM';
    if (document.title !== next) {
      document.title = next;
    }
  }, [tenant?.name]);

  // Fetch subscription status to show trial banner and modal
  useEffect(() => {
    const fetchSubStatus = async () => {
      try {
        const data = await fetchApi('/api/subscriptions/status', { silent: true });
        if (data) {
          setDaysRemaining(data.daysRemaining);
          setTrialEndsAt(data.trialEndsAt);
        }
      } catch (err) {
        // silently fail
      }
    };

    if (user) {
      fetchSubStatus();
    }
  }, [user]);

  const handleLogout = async () => {
    // #528 (CRIT-03 fix): revoke the JWT SERVER-SIDE before clearing local
    // state. POST /api/auth/logout reads req.user.jti and adds it to the
    // RevokedToken denylist (verifyToken middleware checks it on every
    // subsequent request). Without this call, the JWT remained valid until
    // its 7-day natural expiry — anyone who captured the bearer pre-logout
    // (XSS, shared device, leaked log line) could replay it indefinitely.
    //
    // We `await` so the server-side revocation is committed before we
    // navigate away, but wrap in try/catch so a network blip doesn't stall
    // the UI — local cleanup runs unconditionally either way. silent:true
    // so a transient 5xx doesn't fire an error toast on a path the user
    // is already leaving.
    try {
      await fetchApi('/api/auth/logout', { method: 'POST', silent: true });
    } catch { /* server-side revoke failed — local cleanup still runs */ }

    // #343: setToken(null) flows through setAuthToken → clears the in-memory
    // holder + sessionStorage. The legacy localStorage.removeItem('token')
    // call is now a defensive no-op against any stale pre-#343 token, kept
    // so users mid-migration don't end up with a ghost bearer hanging around.
    setUser(null);
    setToken(null);
    try { localStorage.removeItem('token'); } catch { /* ignore */ }
    navigate('/login');
  };

  return (
    <div className="app-shell" style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg-color)' }}>
      <Sidebar
        mobileOpen={sidebarOpen}
        onMobileClose={() => setSidebarOpen(false)}
        isMobileViewport={isMobileViewport}
      />
      <div className="app-main" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {showSmsBanner && (
          <div
            role="alert"
            data-testid="sms-not-configured-banner"
            style={{
              background: '#fef3c7',
              borderBottom: '1px solid #f59e0b',
              color: '#92400e',
              padding: '10px 24px',
              fontSize: '0.85rem',
              lineHeight: 1.4,
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              flexShrink: 0,
            }}
          >
            <span aria-hidden="true" style={{ fontSize: '1.1rem' }}>⚠️</span>
            <span style={{ flex: 1 }}>
              <strong>SMS provider not configured.</strong> Patient portal OTP login and appointment reminders are not delivering. Configure `MSG91_AUTH_KEY` (or another provider) in the backend `.env` to restore SMS dispatch.
            </span>
          </div>
        )}
        <header style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          padding: '8px 24px',
          gap: '8px',
          borderBottom: '1px solid var(--border-color)',
          background: 'var(--surface-color)',
          minHeight: 48,
          flexShrink: 0,
        }}>
          {/* T2.1: hamburger toggle. Visibility is controlled entirely by the
              .sidebar-toggle class in responsive.css (hidden on desktop,
              inline-flex at <900px with 44x44 touch target). The inline
              display:none was removed because React's inline style wins over
              stylesheets, which made the desktop @media flip impossible. */}
          <button
            ref={toggleRef}
            type="button"
            className="sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label={sidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
            title={sidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={sidebarOpen}
            aria-controls="app-sidebar"
            style={{
              background: 'none', border: '1px solid var(--border-color)',
              color: 'var(--text-primary)', borderRadius: 8,
              width: 36, height: 36, cursor: 'pointer',
              marginRight: 'auto',
            }}
          >
            <Menu size={18} />
          </button>
          <TenantChip tenant={tenant} />
          <NotificationBell />
          <button
            onClick={() => navigate('/profile')}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-primary)', fontSize: '0.85rem', fontWeight: 500,
              padding: '6px 10px', borderRadius: '6px',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
          >
            {/* #642: shared Avatar primitive renders a deterministic-coloured
                circle + role pip so signed-in operators can tell at a glance
                whether they're Owner / Admin / Manager / User. */}
            <Avatar
              name={user?.name || user?.email || 'User'}
              size={28}
              roleBadge={user?.role || undefined}
            />
            <span>{user?.name || user?.email || 'User'}</span>
          </button>
          <button
            onClick={handleLogout}
            title="Logout"
            aria-label="Log out of your account"
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)', fontSize: '0.8rem',
              padding: '6px 10px', borderRadius: '6px',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,0.1)'; e.currentTarget.style.color = '#ef4444'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <LogOut size={16} />
          </button>
        </header>
        {daysRemaining && (
          <TrialBanner daysRemaining={daysRemaining} />
        )}
        <SubscriptionExpiryModal daysRemaining={daysRemaining} trialEndsAt={trialEndsAt} />
        <main className="animate-fade-in" style={{ flex: 1, overflowY: 'auto', padding: '0', backgroundColor: 'transparent' }}>
          <Outlet />
        </main>
        {/* #634: build identifier — small, low-contrast, app-shell footer.
            Version is sourced from backend/package.json at build time (see
            vite.config.js define block) so it stays aligned with /api/health.
            Git SHA is git rev-parse --short HEAD at build time, omitted in
            environments where git isn't available.
            #656: SHA is a recon leak for non-admin viewers (lets an attacker
            fingerprint the deployed commit and cross-reference vulnerable
            ranges). Version stays visible to everyone (it's already in the
            unauthenticated /api/health response). SHA is gated to ADMINs. */}
        <footer
          data-testid="app-build-footer"
          style={{
            flexShrink: 0,
            padding: '4px 16px',
            textAlign: 'right',
            borderTop: '1px solid var(--border-color)',
            background: 'var(--surface-color)',
            color: 'var(--text-secondary)',
            fontSize: '0.7rem',
            opacity: 0.7,
          }}
        >
          <small>
            v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'}
            {user?.role === 'ADMIN' && typeof __APP_GIT_SHA__ !== 'undefined' && __APP_GIT_SHA__ ? ` · ${__APP_GIT_SHA__}` : ''}
          </small>
        </footer>
      </div>
      <Omnibar />
      {!isWellness && <Softphone />}
      <Presence />
    </div>
  );
};

export default Layout;
