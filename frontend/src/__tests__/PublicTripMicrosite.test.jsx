/**
 * PublicTripMicrosite.test.jsx — vitest + RTL coverage for the public
 * parent/teacher trip microsite (frontend/src/pages/travel/PublicTripMicrosite.jsx).
 *
 * The page loads public trip info + the participant list, then drives
 * DigiLocker Aadhaar verification per participant. There is NO app-side OTP
 * gate — DigiLocker authenticates the individual during its own consent
 * flow. All backend calls are raw `fetch` to the public
 * /api/travel/microsites/public/:uuid/* endpoints.
 *
 * Pinned invariants:
 *   1. mount loads public info + participants → renders destination + names.
 *   2. 404 → "Trip page not found"; 410 GONE → "expired".
 *   3. an already-verified participant shows the masked last-4 badge; an
 *      unverified one shows a "Verify Aadhaar" button.
 *   4. stub mode: "Verify Aadhaar" completes inline (start → callback) and the
 *      participant flips to verified after the reload.
 *   5. real mode: stashes the uuid in sessionStorage and redirects the browser
 *      to the DigiLocker oauthUrl (no inline callback).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PublicTripMicrosite from '../pages/travel/PublicTripMicrosite';

const BASE = '/api/travel/microsites/public/uuid-x';

let startMode;   // 'stub' | 'apisetu-partner'
let aaravLast4;  // null until verified, then '9999'
let infoResponse; // { status, body }

function jsonResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function installMock() {
  global.fetch = vi.fn((url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === BASE && method === 'GET') {
      return jsonResponse(infoResponse.status, infoResponse.body);
    }
    if (url === `${BASE}/participants` && method === 'GET') {
      return jsonResponse(200, {
        participants: [
          { id: 1, fullName: 'Aarav Sharma', aadhaarLast4: aaravLast4 },
          { id: 2, fullName: 'Bina Patel', aadhaarLast4: '4321' },
        ],
      });
    }
    if (url === `${BASE}/verify/aadhaar/start` && method === 'POST') {
      return startMode === 'stub'
        ? jsonResponse(201, { mode: 'stub', state: 'st1', sessionId: 9 })
        : jsonResponse(201, { mode: 'apisetu-partner', oauthUrl: 'https://dl.example/authorize?x=1', state: 'st1', sessionId: 9 });
    }
    if (url === `${BASE}/verify/aadhaar/callback` && method === 'POST') {
      aaravLast4 = '9999';
      return jsonResponse(200, { verified: true, aadhaarLast4: '9999' });
    }
    return jsonResponse(404, { error: 'unexpected', code: 'X' });
  });
}

function renderPage(uuid = 'uuid-x') {
  return render(
    <MemoryRouter initialEntries={[`/p/tripmicrosite/${uuid}`]}>
      <Routes>
        <Route path="/p/tripmicrosite/:publicUuid" element={<PublicTripMicrosite />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  startMode = 'stub';
  aaravLast4 = null;
  infoResponse = {
    status: 200,
    body: {
      trip: { destination: 'Goa Ed Tour', departDate: '2026-09-01', returnDate: '2026-09-10' },
      itineraryHtml: '<p>Itinerary details</p>',
    },
  };
  sessionStorage.clear();
  installMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<PublicTripMicrosite /> — load states', () => {
  it('renders the trip destination + participants after load', async () => {
    renderPage();
    expect(await screen.findByText('Goa Ed Tour')).toBeInTheDocument();
    expect(screen.getByText(/Aadhaar verification/i)).toBeInTheDocument();
    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument();
    expect(screen.getByText('Bina Patel')).toBeInTheDocument();
  });

  it('shows "Trip page not found" on 404', async () => {
    infoResponse = { status: 404, body: { error: 'Microsite not found', code: 'NOT_FOUND' } };
    renderPage();
    expect(await screen.findByText(/Trip page not found/i)).toBeInTheDocument();
  });

  it('shows an expiry message on 410 GONE', async () => {
    infoResponse = { status: 410, body: { error: 'expired', code: 'GONE' } };
    renderPage();
    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
  });
});

describe('<PublicTripMicrosite /> — participant affordances', () => {
  it('verified participant shows the masked badge; unverified shows a Verify button', async () => {
    renderPage();
    await screen.findByText('Aarav Sharma');
    // Bina is already verified → masked badge, not a button.
    expect(screen.getByText(/Verified ••••4321/)).toBeInTheDocument();
    // Aarav is unverified → exactly one Verify Aadhaar button.
    expect(screen.getAllByRole('button', { name: /Verify Aadhaar/i })).toHaveLength(1);
  });
});

describe('<PublicTripMicrosite /> — Aadhaar verification', () => {
  it('stub mode: Verify Aadhaar completes inline and flips the participant to verified', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Verify Aadhaar/i }));

    // After start(stub) → callback → reload, Aarav shows the synthetic last-4.
    expect(await screen.findByText(/Verified ••••9999/)).toBeInTheDocument();
    const cbCall = global.fetch.mock.calls.find(([u]) => u === `${BASE}/verify/aadhaar/callback`);
    expect(cbCall).toBeTruthy();
    expect(JSON.parse(cbCall[1].body)).toEqual({ state: 'st1', code: 'stub-code' });
  });

  it('real mode: stashes the uuid and redirects to the DigiLocker oauthUrl', async () => {
    startMode = 'apisetu-partner';
    const hrefMock = vi.fn();
    const orig = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { search: '', origin: 'http://localhost', set href(v) { hrefMock(v); }, get href() { return 'http://localhost'; } },
    });
    try {
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /Verify Aadhaar/i }));

      await waitFor(() => expect(hrefMock).toHaveBeenCalledWith('https://dl.example/authorize?x=1'));
      expect(sessionStorage.getItem('kycMicrositeUuid')).toBe('uuid-x');
      // Real mode must NOT call the inline callback.
      expect(global.fetch.mock.calls.find(([u]) => u === `${BASE}/verify/aadhaar/callback`)).toBeFalsy();
    } finally {
      if (orig) Object.defineProperty(window, 'location', orig);
    }
  });
});
