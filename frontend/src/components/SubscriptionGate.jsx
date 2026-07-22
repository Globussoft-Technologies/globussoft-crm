import React, { useContext, useEffect, useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Lock, CreditCard, AlertTriangle, LogOut } from 'lucide-react';
import { AuthContext } from '../App';
import { fetchApi } from '../utils/api';

// Hard subscription paywall.
//
// Renders a full-viewport, NON-DISMISSABLE overlay that blocks all
// interaction when the tenant's trial has ended OR its paid subscription
// has expired/been cancelled. The only paths forward are:
//   - Click "Upgrade" → navigate to /pricing (admin pays from there).
//   - Click "Logout" (so a wrong-account user isn't locked in).
//
// Routes allowed through the gate (so the buyer can complete checkout):
//   /pricing, /payment-success, /payment-failed.
//
// Role behavior:
//   - ADMIN (the buyer): sees the Upgrade CTA that drops them on /pricing.
//   - MANAGER / USER / wellness staff: see a "contact your admin" message.
//     They can't buy — only the workspace admin can.
//   - No role bypass: everyone must have valid coverage before using the CRM.
//
// State source:
//   GET /api/subscriptions/status — returns
//     { subscriptionStatus, trialEndsAt, daysRemaining, subscription, ... }
//   The backend's checkSubscription middleware ALSO 402s every protected
//   API call when expired, so a stale gate state self-corrects: the first
//   401-not-401 response with `error: 'TRIAL_EXPIRED'` or
//   'NO_ACTIVE_SUBSCRIPTION' refetches and re-renders the gate.

const ALLOWED_PATHS = ['/pricing', '/payment-success', '/payment-failed', '/login', '/signup'];

const C = {
  overlayBg: 'rgba(15, 23, 42, 0.78)', // slate-900 / 78%
  card: '#ffffff',
  text: '#0f172a',
  text2: '#475569',
  text3: '#64748b',
  border: '#e2e8f0',
  danger: '#dc2626',
  dangerBg: '#fef2f2',
  warning: '#d97706',
  warningBg: '#fffbeb',
  accent: '#4f46e5',
};

function isPathAllowed(pathname) {
  if (!pathname) return false;
  return ALLOWED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export default function SubscriptionGate({ children }) {
  const { user, setUser, setToken, token } = useContext(AuthContext);
  const navigate = useNavigate();
  const location = useLocation();
  const [status, setStatus] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!token || !user) return;
    try {
      const data = await fetchApi('/api/subscriptions/status', { silent: true });
      setStatus(data);
    } catch (err) {
      // 402 from checkSubscription means we're behind the paywall — surface
      // a synthetic status so the overlay renders.
      const msg = String(err?.message || '');
      if (/trial_expired/i.test(msg)) {
        setStatus({ subscriptionStatus: 'TRIAL', daysRemaining: 0, _forced: true });
      } else if (/no_active_subscription/i.test(msg) || /402/.test(msg)) {
        setStatus({ subscriptionStatus: 'EXPIRED', daysRemaining: 0, _forced: true });
      }
      // Any other error: leave status null, fall through to children. A
      // permanent backend outage shouldn't lock everyone out — the
      // backend's own checkSubscription middleware is the source of truth.
    } finally {
      setLoaded(true);
    }
  }, [token, user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-check on route change so navigating to /pricing → paying → coming
  // back to /dashboard fires a fresh status fetch and lifts the gate.
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const handleLogout = async () => {
    try { await fetchApi('/api/auth/logout', { method: 'POST', silent: true }); } catch { /* keep going */ }
    if (setUser) setUser(null);
    if (setToken) setToken(null);
    try { localStorage.removeItem('user'); } catch { /* ignore */ }
    navigate('/login', { replace: true });
  };

  const handleUpgrade = () => navigate('/pricing');

  // Bypass conditions:
  //   - Not logged in → children render (login/signup unauth views).
  //   - User row hasn't arrived yet → children (let the rest of the app
  //     handle auth-loading state).
  //   - Platform OWNER (isOwner) → never blocked.
  //   - Route is in the allow-list → children (so they can actually pay).
  if (!token || !user) return children;
  if (isPathAllowed(location.pathname)) return children;

  // Wait for the first status fetch before deciding. A fast-rendered gate
  // overlay that flashes for one frame then disappears is worse UX than
  // a brief delay before any decision.
  if (!loaded || !status) return children;

  const subStatus = status.subscriptionStatus;
  const days = typeof status.daysRemaining === 'number' ? status.daysRemaining : null;

  // ACTIVE subscription → no gate.
  if (subStatus === 'ACTIVE') return children;
  // TRIAL with time remaining → no gate (Layout still renders the soft
  // TrialBanner). Treat null daysRemaining as "trust the status".
  if (subStatus === 'TRIAL' && (days === null || days > 0)) return children;

  // Anything else → BLOCK.
  const isTrialEnded = subStatus === 'TRIAL';
  const isAdmin = user.role === 'ADMIN';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="subscription-gate-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 100000,
        background: C.overlayBg, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          background: C.card, borderRadius: 16, padding: 40, maxWidth: 480, width: '100%',
          boxShadow: '0 25px 60px rgba(0,0,0,0.35)', textAlign: 'center',
          border: `1px solid ${C.border}`,
        }}
      >
        <div
          style={{
            width: 72, height: 72, borderRadius: '50%',
            background: isTrialEnded ? C.warningBg : C.dangerBg,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 20,
          }}
          aria-hidden="true"
        >
          {isTrialEnded
            ? <AlertTriangle size={32} color={C.warning} />
            : <Lock size={32} color={C.danger} />}
        </div>

        <h1
          id="subscription-gate-title"
          style={{ fontSize: '1.4rem', fontWeight: 800, color: C.text, marginBottom: 10, letterSpacing: '-0.02em' }}
        >
          {isTrialEnded ? 'Your free trial has ended' : 'Your subscription has ended'}
        </h1>

        <p style={{ fontSize: '0.95rem', color: C.text2, lineHeight: 1.55, marginBottom: 8 }}>
          {isTrialEnded
            ? 'Your 15-day trial is over. Upgrade now to keep using the workspace.'
            : 'Your paid plan is no longer active. Renew to restore access.'}
        </p>

        {!isAdmin && (
          <p style={{ fontSize: '0.85rem', color: C.text3, lineHeight: 1.55, marginTop: 14, padding: '12px 16px', background: '#f8fafc', borderRadius: 8, border: `1px solid ${C.border}` }}>
            Only the workspace admin can purchase or renew the subscription. Please contact them, or sign out to use a different account.
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 26 }}>
          {isAdmin && (
            <button
              onClick={handleUpgrade}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '14px 24px', fontSize: '0.95rem', fontWeight: 700,
                background: C.accent, color: '#fff', border: 'none', borderRadius: 10,
                cursor: 'pointer', fontFamily: 'inherit',
                boxShadow: '0 4px 14px rgba(79,70,229,0.35)',
              }}
            >
              <CreditCard size={16} />
              {isTrialEnded ? 'Upgrade Now' : 'Renew Subscription'}
            </button>
          )}
          <button
            onClick={handleLogout}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '12px 24px', fontSize: '0.88rem', fontWeight: 600,
              background: 'transparent', color: C.text3, border: `1px solid ${C.border}`, borderRadius: 10,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>

        <p style={{ fontSize: '0.72rem', color: C.text3, marginTop: 22, lineHeight: 1.5 }}>
          Need help? Reach out to your account manager at Globussoft.
        </p>
      </div>
    </div>
  );
}
