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
      // G095 — public response carries an additive `brandKit` block.
      // Default null = portal falls back to the legacy navy/gold chrome.
      brandKit: null,
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
    expect(await screen.findByTestId('microsite-destination-title')).toHaveTextContent('Goa Ed Tour');
    expect(screen.getByTestId('microsite-aadhaar-section')).toBeInTheDocument();
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

describe('<PublicTripMicrosite /> — G095 brand-kit consumer', () => {
  it('renders brand logo + tagline in the header when brandKit is populated', async () => {
    infoResponse = {
      status: 200,
      body: {
        trip: { destination: 'Bali Trip', departDate: '2026-09-01', returnDate: '2026-09-10' },
        itineraryHtml: '<p>Itinerary</p>',
        brandKit: {
          logoUrl: 'https://cdn.example/tmc-logo.png',
          primaryColor: '#1F4E79',
          tagline: 'Travel that teaches',
        },
      },
    };
    renderPage();
    // Brand logo image renders with the tagline embedded into alt.
    const logo = await screen.findByTestId('microsite-brand-logo');
    expect(logo).toBeInTheDocument();
    expect(logo.tagName).toBe('IMG');
    expect(logo).toHaveAttribute('alt', 'Travel that teaches logo');
    // Tagline copy ALSO shows in the header.
    expect(screen.getByText('Travel that teaches')).toBeInTheDocument();
  });

  it('renders the brand footer with mission + support contacts when populated', async () => {
    infoResponse = {
      status: 200,
      body: {
        trip: { destination: 'Bali Trip', departDate: '2026-09-01', returnDate: '2026-09-10' },
        itineraryHtml: '<p>Itinerary</p>',
        brandKit: {
          primaryColor: '#1F4E79',
          missionStatement: 'Designing educational tours since 2015.',
          supportEmail: 'hello@example.com',
          supportPhone: '+91-22-1234-5678',
          footerText: '© 2026 Test Brand',
        },
      },
    };
    renderPage();
    expect(await screen.findByTestId('microsite-brand-footer')).toBeInTheDocument();
    expect(screen.getByText(/Designing educational tours since 2015/i)).toBeInTheDocument();
    expect(screen.getByText('hello@example.com')).toBeInTheDocument();
    expect(screen.getByText('+91-22-1234-5678')).toBeInTheDocument();
    expect(screen.getByText('© 2026 Test Brand')).toBeInTheDocument();
    // mailto + tel: hrefs.
    expect(screen.getByText('hello@example.com').closest('a')?.getAttribute('href')).toBe('mailto:hello@example.com');
    expect(screen.getByText('+91-22-1234-5678').closest('a')?.getAttribute('href')).toBe('tel:+91-22-1234-5678');
  });

  it('falls back to default Plane icon + no brand-footer when brandKit is null', async () => {
    // Default fixture already has brandKit:null — assert the fallback.
    renderPage();
    await screen.findByTestId('microsite-destination-title');
    // No brand-logo IMG and no brand-footer in fallback mode.
    expect(screen.queryByAltText(/Brand logo/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('microsite-brand-footer')).not.toBeInTheDocument();
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

// ─── Phase 7 — RegistrationConfirmPanel (hybrid registration flow) ──

describe('<PublicTripMicrosite /> — Phase 7 RegistrationConfirmPanel', () => {
  // The panel reads `?draftToken=...` from window.location.search; we
  // override window.location for the duration of each test that needs
  // the panel rendered. The legacy load-states / Aadhaar tests don't
  // override window.location, so they continue to render WITHOUT the
  // panel (back-compat verified separately below).
  async function withDraftToken(token, body) {
    const orig = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { search: `?draftToken=${token}`, origin: 'http://localhost', href: 'http://localhost' },
    });
    try {
      // await — otherwise finally restores window.location BEFORE the
      // async body runs, and the component never sees the draftToken.
      return await body();
    } finally {
      if (orig) Object.defineProperty(window, 'location', orig);
    }
  }

  function installMockWithOtp({
    requestOtpResponse = jsonResponse(201, { sent: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    verifyOtpResponse = jsonResponse(200, {
      verified: true,
      accessToken: 'jwt.access.token',
      expiresIn: '30m',
      draftBound: { id: 7001, status: 'OTP_VERIFIED', alreadyVerified: false },
    }),
    draftSummaryResponse = jsonResponse(200, {
      id: 7001,
      status: 'DRAFT',
      otpVerified: false,
      studentFirstName: 'Aarav',
      parentFirstName: 'Rohan',
      parentEmailMasked: 'ro••••@example.com',
      parentPhoneMasked: '••••••3210',
      parentPhoneLast4: '3210',
      hasPassport: true,
    }),
  } = {}) {
    global.fetch = vi.fn((url, opts = {}) => {
      const method = opts.method || 'GET';
      if (url === BASE && method === 'GET') {
        return jsonResponse(infoResponse.status, infoResponse.body);
      }
      if (url === `${BASE}/participants` && method === 'GET') {
        return jsonResponse(200, { participants: [] });
      }
      // Phase 7+ — draft-summary fires on panel mount when a
      // ?draftToken is present.
      if (url.startsWith(`${BASE}/draft-summary?token=`) && method === 'GET') {
        return Promise.resolve(draftSummaryResponse);
      }
      if (url === `${BASE}/request-otp` && method === 'POST') {
        return Promise.resolve(requestOtpResponse);
      }
      if (url === `${BASE}/verify-otp` && method === 'POST') {
        return Promise.resolve(verifyOtpResponse);
      }
      return jsonResponse(404, { error: 'unexpected', code: 'X' });
    });
  }

  it('renders the panel + greeting + masked phone when ?draftToken is in the URL', async () => {
    installMockWithOtp();
    await withDraftToken('abc123', async () => {
      renderPage();
      expect(await screen.findByTestId('registration-confirm-panel')).toBeInTheDocument();
      // Greeting derived from the draft summary's parentFirstName
      expect(await screen.findByText(/Hi Rohan/)).toBeInTheDocument();
      // Masked phone visible in the "we'll send to" row
      expect(screen.getByText('••••••3210')).toBeInTheDocument();
      // Single "Send verification code" button (no phone input — user
      // doesn't have to retype what they entered on the landing page)
      expect(screen.getByTestId('registration-request-otp-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('registration-phone-input')).not.toBeInTheDocument();
    });
  });

  it('does NOT render the panel when ?draftToken is absent', async () => {
    installMock();
    renderPage();
    await screen.findByTestId('microsite-destination-title');
    expect(screen.queryByTestId('registration-confirm-panel')).not.toBeInTheDocument();
  });

  it('happy path: send code → enter code → verify → "awaiting review" + receipt panel', async () => {
    installMockWithOtp();
    await withDraftToken('abc123', async () => {
      renderPage();
      // Wait for summary to load + reveal the send button
      const sendBtn = await screen.findByTestId('registration-request-otp-btn');
      fireEvent.click(sendBtn);

      // Verify form appears (no phone input)
      const codeInput = await screen.findByTestId('registration-code-input');
      fireEvent.change(codeInput, { target: { value: '1234' } });
      fireEvent.click(screen.getByTestId('registration-verify-otp-btn'));

      // Terminal "verified" state surfaces with the receipt summary
      expect(await screen.findByTestId('registration-confirmed')).toBeInTheDocument();
      expect(screen.getByText(/registration is being reviewed/i)).toBeInTheDocument();
      expect(screen.getByText(/What we received/i)).toBeInTheDocument();

      // request-otp body carries only purpose + draftToken (phone derived server-side)
      const reqCall = global.fetch.mock.calls.find(([u]) => u === `${BASE}/request-otp`);
      expect(JSON.parse(reqCall[1].body)).toEqual({ purpose: 'registration', draftToken: 'abc123' });

      // verify-otp body carries draftToken + code (phone derived server-side)
      const verifyCall = global.fetch.mock.calls.find(([u]) => u === `${BASE}/verify-otp`);
      expect(JSON.parse(verifyCall[1].body)).toEqual({
        purpose: 'registration',
        code: '1234',
        draftToken: 'abc123',
      });
    });
  });

  it('already-verified draft (otpVerified=true on summary) jumps straight to verified state', async () => {
    installMockWithOtp({
      draftSummaryResponse: jsonResponse(200, {
        id: 7001, status: 'OTP_VERIFIED', otpVerified: true,
        studentFirstName: 'Aarav', parentFirstName: 'Rohan',
        parentPhoneMasked: '••••••3210', parentPhoneLast4: '3210',
        parentEmailMasked: 'ro••••@example.com', hasPassport: true,
      }),
    });
    await withDraftToken('already-verified', async () => {
      renderPage();
      expect(await screen.findByTestId('registration-confirmed')).toBeInTheDocument();
      // No OTP flow surfaces — terminal verified state on revisit
      expect(screen.queryByTestId('registration-request-otp-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('registration-code-input')).not.toBeInTheDocument();
    });
  });

  it('OTP_INVALID on verify is retryable — panel stays on verify-form with error', async () => {
    installMockWithOtp({
      verifyOtpResponse: jsonResponse(400, { error: 'wrong code', code: 'OTP_INVALID' }),
    });
    await withDraftToken('abc123', async () => {
      renderPage();
      fireEvent.click(await screen.findByTestId('registration-request-otp-btn'));
      fireEvent.change(await screen.findByTestId('registration-code-input'), { target: { value: '9999' } });
      fireEvent.click(screen.getByTestId('registration-verify-otp-btn'));

      const err = await screen.findByTestId('registration-otp-error');
      expect(err.textContent).toMatch(/code doesn't match/i);
      expect(screen.getByTestId('registration-code-input')).toBeInTheDocument();
      expect(screen.queryByTestId('registration-confirmed')).not.toBeInTheDocument();
    });
  });

  it('DRAFT_NOT_FOUND on draft-summary fetch is TERMINAL — shows error, no OTP form', async () => {
    installMockWithOtp({
      draftSummaryResponse: jsonResponse(404, { error: 'draft not found', code: 'DRAFT_NOT_FOUND' }),
    });
    await withDraftToken('ghost', async () => {
      renderPage();
      const err = await screen.findByTestId('registration-error');
      expect(err.textContent).toMatch(/could not find your registration/i);
      expect(screen.queryByTestId('registration-request-otp-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('registration-code-input')).not.toBeInTheDocument();
    });
  });

  it('DRAFT_WRONG_TRIP on draft-summary is TERMINAL — shows trip-mismatch copy', async () => {
    installMockWithOtp({
      draftSummaryResponse: jsonResponse(403, { error: 'wrong trip', code: 'DRAFT_WRONG_TRIP' }),
    });
    await withDraftToken('othertrip', async () => {
      renderPage();
      const err = await screen.findByTestId('registration-error');
      expect(err.textContent).toMatch(/different trip/i);
    });
  });

  it('DRAFT_EXPIRED on draft-summary is TERMINAL — asks user to re-submit form', async () => {
    installMockWithOtp({
      draftSummaryResponse: jsonResponse(400, { error: 'expired', code: 'DRAFT_EXPIRED' }),
    });
    await withDraftToken('expired', async () => {
      renderPage();
      const err = await screen.findByTestId('registration-error');
      expect(err.textContent).toMatch(/expired/i);
      expect(err.textContent).toMatch(/re-submit/i);
    });
  });

  it('OTP_COOLDOWN on request-otp surfaces the wait-a-minute copy', async () => {
    installMockWithOtp({
      requestOtpResponse: jsonResponse(429, { error: 'cooldown', code: 'OTP_COOLDOWN' }),
    });
    await withDraftToken('abc123', async () => {
      renderPage();
      fireEvent.click(await screen.findByTestId('registration-request-otp-btn'));
      const err = await screen.findByTestId('registration-otp-error');
      expect(err.textContent).toMatch(/wait a minute/i);
      // Send button still visible — retryable
      expect(screen.getByTestId('registration-request-otp-btn')).toBeInTheDocument();
    });
  });
});
