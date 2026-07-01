/**
 * PublicTripMicrosite.test.jsx — vitest + RTL coverage for the public
 * parent/teacher trip microsite (frontend/src/pages/travel/PublicTripMicrosite.jsx).
 *
 * The page loads public trip info and, when the visitor arrives from the
 * landing-page registration with a ?draftToken, lets them (a) confirm their
 * registration via phone OTP and (b) upload their own Passport + Aadhaar
 * documents with a parent-consent checkbox.
 *
 * IMPORTANT privacy invariant: this is a PUBLIC page, so it must NOT show any
 * other traveller's data. The old per-participant Aadhaar-verification section
 * (which listed every traveller's name + last-4) was removed — these tests pin
 * that it stays gone.
 *
 * Pinned invariants:
 *   1. mount loads public info → renders destination; NO participant list /
 *      Aadhaar section is rendered.
 *   2. 404 → "Trip page not found"; 410 GONE → "expired".
 *   3. no draftToken → no upload button; a hint tells the visitor to open
 *      their registration link.
 *   4. with draftToken → an "Upload documents" button opens a modal that
 *      requires both files + consent and POSTs multipart to /documents.
 *   5. Phase 7 RegistrationConfirmPanel behaviour is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PublicTripMicrosite from '../pages/travel/PublicTripMicrosite';

const BASE = '/api/travel/microsites/public/uuid-x';

let infoResponse; // { status, body }

function jsonResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

// Base mock — the page only fetches the public info endpoint when there's no
// draftToken. A stray call to anything else resolves 404 so the test surfaces
// an unexpected request rather than hanging.
function installMock() {
  global.fetch = vi.fn((url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === BASE && method === 'GET') {
      return jsonResponse(infoResponse.status, infoResponse.body);
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
  it('renders the trip destination and does NOT render any participant / Aadhaar section', async () => {
    renderPage();
    expect(await screen.findByTestId('microsite-destination-title')).toHaveTextContent('Goa Ed Tour');
    // Privacy: the public participant list + Aadhaar verification section is gone.
    expect(screen.queryByTestId('microsite-aadhaar-section')).not.toBeInTheDocument();
    expect(screen.queryByText(/Verify Aadhaar/i)).not.toBeInTheDocument();
    // The page never fetches the (PII-leaking) participants endpoint.
    expect(global.fetch.mock.calls.some(([u]) => String(u).endsWith('/participants'))).toBe(false);
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
    const logo = await screen.findByTestId('microsite-brand-logo');
    expect(logo).toBeInTheDocument();
    expect(logo.tagName).toBe('IMG');
    expect(logo).toHaveAttribute('alt', 'Travel that teaches logo');
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
    expect(screen.getByText('hello@example.com').closest('a')?.getAttribute('href')).toBe('mailto:hello@example.com');
    expect(screen.getByText('+91-22-1234-5678').closest('a')?.getAttribute('href')).toBe('tel:+91-22-1234-5678');
  });

  it('falls back to default Plane icon + no brand-footer when brandKit is null', async () => {
    renderPage();
    await screen.findByTestId('microsite-destination-title');
    expect(screen.queryByAltText(/Brand logo/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('microsite-brand-footer')).not.toBeInTheDocument();
  });
});

// ─── Document upload (draftToken-scoped) ─────────────────────────────

describe('<PublicTripMicrosite /> — document upload', () => {
  // The upload button + modal only appear for a registrant identified by a
  // draftToken. We override window.location for the duration of each test.
  async function withDraftToken(token, body) {
    const orig = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { search: `?draftToken=${token}`, origin: 'http://localhost', href: 'http://localhost' },
    });
    try {
      return await body();
    } finally {
      if (orig) Object.defineProperty(window, 'location', orig);
    }
  }

  function installDocMock({
    draftSummary = {
      id: 7001, status: 'DRAFT', otpVerified: false,
      studentFirstName: 'Aarav', parentFirstName: 'Rohan',
      parentPhoneMasked: '••••••3210', parentPhoneLast4: '3210',
      parentEmailMasked: 'ro••••@example.com', hasPassport: true,
      hasPassportDoc: false, hasAadhaarDoc: false, consentGiven: false,
    },
    uploadResponse = jsonResponse(200, {
      ok: true,
      documents: { passport: true, aadhaar: true, consentCapturedAt: '2026-07-01T00:00:00.000Z' },
    }),
  } = {}) {
    global.fetch = vi.fn((url, opts = {}) => {
      const method = opts.method || 'GET';
      if (url === BASE && method === 'GET') return jsonResponse(infoResponse.status, infoResponse.body);
      if (url.startsWith(`${BASE}/draft-summary?token=`) && method === 'GET') return jsonResponse(200, draftSummary);
      if (url === `${BASE}/documents` && method === 'POST') return uploadResponse;
      // request-otp / verify-otp fire from the RegistrationConfirmPanel that
      // also renders under a draftToken; stub them so they never 404-noise.
      if (url === `${BASE}/request-otp` && method === 'POST') return jsonResponse(201, { sent: true });
      if (url === `${BASE}/verify-otp` && method === 'POST') return jsonResponse(200, { verified: true });
      return jsonResponse(404, { error: 'unexpected', code: 'X' });
    });
  }

  const makeFile = (name, type) => new File(['x'], name, { type });

  it('shows no upload button and a "use your registration link" hint when there is no draftToken', async () => {
    installMock();
    renderPage();
    await screen.findByTestId('microsite-destination-title');
    expect(screen.queryByTestId('microsite-upload-docs-btn')).not.toBeInTheDocument();
    expect(screen.getByText(/open this page from the registration link/i)).toBeInTheDocument();
  });

  it('shows the upload button under a draftToken and opens the modal on click', async () => {
    installDocMock();
    await withDraftToken('abc123', async () => {
      renderPage();
      const btn = await screen.findByTestId('microsite-upload-docs-btn');
      expect(btn).toHaveTextContent(/Upload documents/i);
      fireEvent.click(btn);
      expect(await screen.findByTestId('microsite-doc-modal')).toBeInTheDocument();
    });
  });

  it('blocks submit until consent is ticked and both files are chosen', async () => {
    installDocMock();
    await withDraftToken('abc123', async () => {
      renderPage();
      fireEvent.click(await screen.findByTestId('microsite-upload-docs-btn'));
      await screen.findByTestId('microsite-doc-modal');

      // No consent, no files → consent error, no POST.
      fireEvent.click(screen.getByTestId('microsite-doc-submit'));
      expect(await screen.findByTestId('microsite-doc-error')).toHaveTextContent(/parent consent/i);
      expect(global.fetch.mock.calls.some(([u]) => u === `${BASE}/documents`)).toBe(false);

      // Consent but still no files → missing-files error.
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByTestId('microsite-doc-submit'));
      expect(await screen.findByTestId('microsite-doc-error')).toHaveTextContent(/Passport and Aadhaar/i);
      expect(global.fetch.mock.calls.some(([u]) => u === `${BASE}/documents`)).toBe(false);
    });
  });

  it('happy path: pick both files + consent → POSTs multipart and shows the done state', async () => {
    installDocMock();
    await withDraftToken('abc123', async () => {
      renderPage();
      fireEvent.click(await screen.findByTestId('microsite-upload-docs-btn'));
      await screen.findByTestId('microsite-doc-modal');

      fireEvent.change(screen.getByTestId('microsite-doc-passport'), {
        target: { files: [makeFile('passport.pdf', 'application/pdf')] },
      });
      fireEvent.change(screen.getByTestId('microsite-doc-aadhaar'), {
        target: { files: [makeFile('aadhaar.png', 'image/png')] },
      });
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByTestId('microsite-doc-submit'));

      expect(await screen.findByTestId('microsite-doc-modal-done')).toBeInTheDocument();

      const post = global.fetch.mock.calls.find(([u, o]) => u === `${BASE}/documents` && o?.method === 'POST');
      expect(post).toBeTruthy();
      // Body is a FormData carrying the token, consent flag and both files.
      const fd = post[1].body;
      expect(fd).toBeInstanceOf(FormData);
      expect(fd.get('draftToken')).toBe('abc123');
      expect(fd.get('consent')).toBe('true');
      expect(fd.get('passport')).toBeInstanceOf(File);
      expect(fd.get('aadhaar')).toBeInstanceOf(File);
    });
  });

  it('surfaces a server error inside the modal without closing it', async () => {
    installDocMock({ uploadResponse: jsonResponse(400, { error: 'Draft token has expired', code: 'DRAFT_EXPIRED' }) });
    await withDraftToken('abc123', async () => {
      renderPage();
      fireEvent.click(await screen.findByTestId('microsite-upload-docs-btn'));
      await screen.findByTestId('microsite-doc-modal');
      fireEvent.change(screen.getByTestId('microsite-doc-passport'), {
        target: { files: [makeFile('p.pdf', 'application/pdf')] },
      });
      fireEvent.change(screen.getByTestId('microsite-doc-aadhaar'), {
        target: { files: [makeFile('a.pdf', 'application/pdf')] },
      });
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByTestId('microsite-doc-submit'));

      expect(await screen.findByTestId('microsite-doc-error')).toHaveTextContent(/expired/i);
      expect(screen.getByTestId('microsite-doc-modal')).toBeInTheDocument();
      expect(screen.queryByTestId('microsite-doc-modal-done')).not.toBeInTheDocument();
    });
  });

  it('when a doc is already on record, the button reads "Update documents" and a single re-upload is allowed', async () => {
    installDocMock({
      draftSummary: {
        id: 7001, status: 'OTP_VERIFIED', otpVerified: true,
        studentFirstName: 'Aarav', parentFirstName: 'Rohan',
        parentPhoneMasked: '••••••3210', parentPhoneLast4: '3210',
        parentEmailMasked: 'ro••••@example.com', hasPassport: true,
        hasPassportDoc: true, hasAadhaarDoc: true, consentGiven: true,
      },
    });
    await withDraftToken('abc123', async () => {
      renderPage();
      const btn = await screen.findByTestId('microsite-upload-docs-btn');
      expect(btn).toHaveTextContent(/Update documents/i);
      fireEvent.click(btn);
      await screen.findByTestId('microsite-doc-modal');
      // Both already uploaded → replacing just the passport + re-consenting works.
      fireEvent.change(screen.getByTestId('microsite-doc-passport'), {
        target: { files: [makeFile('newpass.pdf', 'application/pdf')] },
      });
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByTestId('microsite-doc-submit'));
      expect(await screen.findByTestId('microsite-doc-modal-done')).toBeInTheDocument();
      const post = global.fetch.mock.calls.find(([u, o]) => u === `${BASE}/documents` && o?.method === 'POST');
      expect(post[1].body.get('passport')).toBeInstanceOf(File);
      expect(post[1].body.get('aadhaar')).toBeNull(); // not re-sent
    });
  });
});

// ─── Phase 7 — RegistrationConfirmPanel (hybrid registration flow) ──

describe('<PublicTripMicrosite /> — Phase 7 RegistrationConfirmPanel', () => {
  async function withDraftToken(token, body) {
    const orig = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { search: `?draftToken=${token}`, origin: 'http://localhost', href: 'http://localhost' },
    });
    try {
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
      hasPassportDoc: false,
      hasAadhaarDoc: false,
      consentGiven: false,
    }),
  } = {}) {
    global.fetch = vi.fn((url, opts = {}) => {
      const method = opts.method || 'GET';
      if (url === BASE && method === 'GET') {
        return jsonResponse(infoResponse.status, infoResponse.body);
      }
      // draft-summary fires on panel mount AND from the page-level doc-status
      // fetch when a ?draftToken is present.
      if (url.startsWith(`${BASE}/draft-summary?token=`) && method === 'GET') {
        return draftSummaryResponse;
      }
      if (url === `${BASE}/request-otp` && method === 'POST') {
        return requestOtpResponse;
      }
      if (url === `${BASE}/verify-otp` && method === 'POST') {
        return verifyOtpResponse;
      }
      return jsonResponse(404, { error: 'unexpected', code: 'X' });
    });
  }

  it('renders the panel + greeting + masked phone when ?draftToken is in the URL', async () => {
    installMockWithOtp();
    await withDraftToken('abc123', async () => {
      renderPage();
      expect(await screen.findByTestId('registration-confirm-panel')).toBeInTheDocument();
      expect(await screen.findByText(/Hi Rohan/)).toBeInTheDocument();
      expect(screen.getByText('••••••3210')).toBeInTheDocument();
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
      const sendBtn = await screen.findByTestId('registration-request-otp-btn');
      fireEvent.click(sendBtn);

      const codeInput = await screen.findByTestId('registration-code-input');
      fireEvent.change(codeInput, { target: { value: '1234' } });
      fireEvent.click(screen.getByTestId('registration-verify-otp-btn'));

      expect(await screen.findByTestId('registration-confirmed')).toBeInTheDocument();
      expect(screen.getByText(/registration is being reviewed/i)).toBeInTheDocument();
      expect(screen.getByText(/What we received/i)).toBeInTheDocument();

      const reqCall = global.fetch.mock.calls.find(([u]) => u === `${BASE}/request-otp`);
      expect(JSON.parse(reqCall[1].body)).toEqual({ purpose: 'registration', draftToken: 'abc123' });

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
        hasPassportDoc: false, hasAadhaarDoc: false, consentGiven: false,
      }),
    });
    await withDraftToken('already-verified', async () => {
      renderPage();
      expect(await screen.findByTestId('registration-confirmed')).toBeInTheDocument();
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
      expect(screen.getByTestId('registration-request-otp-btn')).toBeInTheDocument();
    });
  });
});
