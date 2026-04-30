// Shared helpers for logging CRM users into AdsGPT via the real
// socket.adsgpt.io → dashboard.adsgpt.io SSO impersonation flow.
//
// Consumed by:
//   - frontend/src/components/Sidebar.jsx  (left-menu link)
//   - frontend/src/pages/wellness/OwnerDashboard.jsx  (dashboard card)
//
// Both surfaces call launchAdsGptAs() so the CRM has a single SSO
// path — change the flow here, it updates everywhere.

export const ADSGPT_API_BASE  = import.meta.env.VITE_ADSGPT_API       || 'https://socket.adsgpt.io';
export const ADSGPT_DASHBOARD = import.meta.env.VITE_ADSGPT_DASHBOARD  || 'https://dashboard.adsgpt.io';

// Active aMember login connected to this CRM workspace. Picked from
// socket.adsgpt.io/adsgpt/amember/get-all-users (status=active).
// Override per-tenant via VITE_ADSGPT_DEMO_LOGIN at build time.
export const ADSGPT_DEMO_LOGIN = import.meta.env.VITE_ADSGPT_DEMO_LOGIN || 'sumitgh2050';

/**
 * Impersonate the configured AdsGPT aMember user and open the dashboard
 * in a new tab. Returns the target URL on success, throws on any failure
 * (token fetch, Redis handoff, popup blocked).
 *
 * SSO flow:
 *   1. GET  /adsgpt/check-access/by-login/<login>        → { ok, token }
 *   2. POST /adsgpt/backup/save  { query, token }         → { success, key }
 *   3. window.open(dashboard/?forword=<key>)              → AdsGPT sets cookie
 *
 * @param {string} [login] - aMember login; defaults to ADSGPT_DEMO_LOGIN
 */
export async function launchAdsGptAs(login = ADSGPT_DEMO_LOGIN) {
  if (!login) throw new Error('No AdsGPT login configured (set VITE_ADSGPT_DEMO_LOGIN)');

  // Step 1 — fetch impersonation token
  const tokenRes = await fetch(
    `${ADSGPT_API_BASE}/adsgpt/check-access/by-login/${encodeURIComponent(login)}`,
  );
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData?.ok || !tokenData?.token) {
    throw new Error(tokenData?.msg || tokenData?.message || `Token fetch failed (HTTP ${tokenRes.status})`);
  }

  // Step 2 — stash token in AdsGPT's Redis; get an opaque key back
  const saveRes = await fetch(`${ADSGPT_API_BASE}/adsgpt/backup/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '?sso=1', token: tokenData.token }),
  });
  const saveData = await saveRes.json().catch(() => ({}));
  if (!saveRes.ok || !saveData?.success || !saveData?.key) {
    throw new Error(saveData?.message || `SSO handoff failed (HTTP ${saveRes.status})`);
  }

  // Step 3 — open dashboard; its RunBackLog picks up ?forword= and
  // swaps the key for the access-token cookie on its own origin.
  const target = `${ADSGPT_DASHBOARD}/?forword=${encodeURIComponent(saveData.key)}`;
  window.open(target, '_blank', 'noopener,noreferrer');
  return target;
}
