/**
 * TravelKycCallback.test.jsx — vitest + RTL coverage for the DigiLocker /
 * Aadhaar OAuth callback landing page
 * (frontend/src/pages/travel/TravelKycCallback.jsx).
 *
 * The component reads ?code & ?state from window.location.search and replays
 * them to the backend to complete verification, branching on a `flow` prop:
 *   - flow="portal"    → POST /api/portal/kyc/callback (Bearer portalToken)
 *   - flow="microsite" → POST /api/travel/microsites/public/:uuid/verify/
 *                        aadhaar/callback (uuid from sessionStorage)
 *
 * Pinned invariants:
 *   1. portal success: POSTs {state,code} with the localStorage portalToken
 *      as Bearer, renders the verified message.
 *   2. microsite success: reads the stashed uuid from sessionStorage, POSTs
 *      to the public callback, clears the stash, renders verified.
 *   3. microsite with NO stashed uuid → context-lost error (never POSTs).
 *   4. backend error → error message surfaced.
 *   5. DigiLocker ?error=access_denied → declined message (never POSTs).
 *   6. missing code/state → error (never POSTs).
 *
 * No react-router: the component reads window.location directly, so it
 * renders without a router. The post-success redirect is a setTimeout(1800)
 * — tests never advance timers, so window.location.href is never assigned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import TravelKycCallback from '../pages/travel/TravelKycCallback';

function jsonResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function setUrl(search) {
  window.history.replaceState(null, '', `/travel/kyc/callback${search}`);
}

beforeEach(() => {
  global.fetch = vi.fn();
  localStorage.clear();
  sessionStorage.clear();
  setUrl('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<TravelKycCallback flow="portal" />', () => {
  it('POSTs state+code with the portal Bearer token and shows the verified last-4', async () => {
    setUrl('?state=s1&code=c1');
    localStorage.setItem('portalToken', 'ptok');
    global.fetch.mockImplementation(() => jsonResponse(200, { verified: true, aadhaarLast4: '1234' }));

    render(<TravelKycCallback flow="portal" />);

    expect(await screen.findByText(/Verified ✓ — Aadhaar ••••1234/)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/portal/kyc/callback');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer ptok');
    expect(JSON.parse(opts.body)).toEqual({ state: 's1', code: 'c1' });
  });

  it('surfaces a backend error', async () => {
    setUrl('?state=s1&code=c1');
    localStorage.setItem('portalToken', 'ptok');
    global.fetch.mockImplementation(() => jsonResponse(502, { error: 'DigiLocker exchange failed' }));

    render(<TravelKycCallback flow="portal" />);

    expect(await screen.findByText(/DigiLocker exchange failed/)).toBeInTheDocument();
    expect(await screen.findByText(/Verification problem/)).toBeInTheDocument();
  });
});

describe('<TravelKycCallback flow="microsite" />', () => {
  it('reads the stashed uuid, POSTs to the public callback, clears the stash', async () => {
    setUrl('?state=s2&code=c2');
    sessionStorage.setItem('kycMicrositeUuid', 'uuid-x');
    global.fetch.mockImplementation(() => jsonResponse(200, { verified: true, aadhaarLast4: '9999' }));

    render(<TravelKycCallback flow="microsite" />);

    expect(await screen.findByText(/Verified ✓ — Aadhaar ••••9999/)).toBeInTheDocument();
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/travel/microsites/public/uuid-x/verify/aadhaar/callback');
    expect(JSON.parse(opts.body)).toEqual({ state: 's2', code: 'c2' });
    // Stash is consumed so a refresh can't double-submit.
    expect(sessionStorage.getItem('kycMicrositeUuid')).toBeNull();
  });

  it('errors (without POSTing) when the uuid stash is missing', async () => {
    setUrl('?state=s2&code=c2');
    // no sessionStorage uuid
    render(<TravelKycCallback flow="microsite" />);

    expect(await screen.findByText(/context was lost/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('<TravelKycCallback /> — DigiLocker / param errors', () => {
  it('shows a declined message when DigiLocker returns ?error=access_denied', async () => {
    setUrl('?error=access_denied');
    render(<TravelKycCallback flow="microsite" />);

    expect(await screen.findByText(/declined to share your Aadhaar/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('errors when code/state are missing from the redirect', async () => {
    setUrl('');
    render(<TravelKycCallback flow="portal" />);

    expect(await screen.findByText(/did not return the expected/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
