/**
 * TravelKycCallback.test.jsx — vitest + RTL coverage for the DigiLocker /
 * Aadhaar OAuth callback landing page
 * (frontend/src/pages/travel/TravelKycCallback.jsx).
 *
 * The component reads ?code & ?state from window.location.search and replays
 * them to the authenticated travel portal backend:
 *   - POST /api/portal/kyc/callback (Bearer portalToken)
 *
 * Pinned invariants:
 *   1. portal success: POSTs {state,code} with the localStorage portalToken
 *      as Bearer, renders the verified message.
 *   2. backend error → error message surfaced.
 *   3. DigiLocker ?error=access_denied → declined message (never POSTs).
 *   4. missing code/state → error (never POSTs).
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
  window.history.replaceState(null, '', `/travel/portal/kyc/callback${search}`);
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

describe('<TravelKycCallback />', () => {
  it('POSTs state+code with the portal Bearer token and shows the verified last-4', async () => {
    setUrl('?state=s1&code=c1');
    localStorage.setItem('portalToken', 'ptok');
    global.fetch.mockImplementation(() => jsonResponse(200, { verified: true, aadhaarLast4: '1234' }));

    render(<TravelKycCallback />);

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

    render(<TravelKycCallback />);

    expect(await screen.findByText(/DigiLocker exchange failed/)).toBeInTheDocument();
    expect(await screen.findByText(/Verification problem/)).toBeInTheDocument();
  });
});

describe('<TravelKycCallback /> — DigiLocker / param errors', () => {
  it('shows a declined message when DigiLocker returns ?error=access_denied', async () => {
    setUrl('?error=access_denied');
    render(<TravelKycCallback />);

    expect(await screen.findByText(/declined to share your Aadhaar/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('errors when code/state are missing from the redirect', async () => {
    setUrl('');
    render(<TravelKycCallback />);

    expect(await screen.findByText(/did not return the expected/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
