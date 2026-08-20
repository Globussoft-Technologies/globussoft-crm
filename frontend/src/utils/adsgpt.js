import { fetchApi } from "./api";

// Shared helpers for logging CRM users into AdsGPT via a backend-proxied
// SSO flow. The backend performs the socket.adsgpt.io handshake server-side,
// so the browser no longer depends on AdsGPT allowing the CRM origin in CORS.
//
// Consumed by:
//   - frontend/src/components/Sidebar.jsx  (left-menu link)
//   - frontend/src/pages/wellness/OwnerDashboard.jsx  (dashboard card)
//
// Both surfaces call launchAdsGptAs() so the CRM has a single SSO
// path — change the flow here, it updates everywhere.

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
 *   1. GET /api/integrations/adsgpt/sso-url?login=<login> → { authUrl }
 *   2. window.open(authUrl)                               → AdsGPT sets cookie
 *
 * @param {string} [login] - aMember login; defaults to ADSGPT_DEMO_LOGIN
 */
export async function launchAdsGptAs(login = ADSGPT_DEMO_LOGIN) {
  if (!login) throw new Error('AdsGPT login not configured. Please set it in Settings.');

  const params = new URLSearchParams({ login });
  const data = await fetchApi(`/api/integrations/adsgpt/sso-url?${params.toString()}`);
  if (!data?.authUrl) {
    throw new Error('AdsGPT SSO URL was not returned');
  }

  const target = data.authUrl;
  window.open(target, '_blank', 'noopener,noreferrer');
  return target;
}
