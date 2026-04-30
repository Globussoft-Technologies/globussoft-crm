// Shared helpers for logging CRM users into Callified via SSO.
//
// Consumed by:
//   - frontend/src/components/Sidebar.jsx (left-menu link)
//   - frontend/src/pages/wellness/OwnerDashboard.jsx (dashboard card)
//
// Flow:
//   1. Frontend calls CRM backend: GET /api/integrations/callified/auth-url
//   2. Backend generates JWT signed with Callified secret, returns full auth URL
//   3. Frontend opens the URL in a new tab
//   4. Callified validates JWT and logs user into dashboard

import { fetchApi } from './api';

/**
 * Launch Callified dashboard with SSO authentication for the current CRM user.
 * Calls the CRM backend to get a signed JWT auth URL, then opens it in a new tab.
 *
 * @throws {Error} if the backend call fails or Callified is not configured
 * @returns {Promise<string>} the target URL that was opened
 */
export async function launchCallifiedSSO() {
  // Step 1 — fetch auth URL from CRM backend (with Bearer token auth)
  const data = await fetchApi('/api/integrations/callified/auth-url', { silent: false });

  if (!data?.authUrl) {
    throw new Error('Backend did not return an auth URL');
  }

  // Step 2 — open Callified dashboard in new tab with JWT token
  window.open(data.authUrl, '_blank', 'noopener,noreferrer');

  return data.authUrl;
}
