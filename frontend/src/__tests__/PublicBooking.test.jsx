/**
 * PublicBooking.test.jsx — vitest + RTL coverage for the public (unauthed)
 * /book/:slug clinic-booking landing page (wellness vertical).
 *
 * Tick #133 Agent B — adds first unit coverage for
 * frontend/src/pages/wellness/PublicBooking.jsx. The SUT is real (398 lines,
 * shipped with v3.1 wellness vertical; extended by Wave 2 Agent LL
 * booking-widget completion + Wave 8b resource picker). It is the only
 * unauthed surface on the frontend — cold visitors land here from a public
 * link (https://crm.globusdemos.com/book/<tenant-slug>), pick a service +
 * clinic + slot, fill in contact details, and POST to the throttled
 * /api/wellness/public/book endpoint.
 *
 * Scope — pins the page-surface invariants:
 *   1. Initial mount fires GET /api/wellness/public/tenant/:slug with the
 *      URL slug param verbatim (NO Bearer header — this is public).
 *   2. Loading state ("Loading…") renders while the catalog fetch is in
 *      flight; replaced by the service grid once profile resolves.
 *   3. Tenant-not-found (non-2xx GET) renders the "Clinic not found." chrome
 *      — the SUT swallows the status code and renders a friendly message.
 *   4. Service picker renders one button per service from
 *      profile.services with name + price + duration; clicking advances
 *      to the location step.
 *   5. Location picker renders one button per profile.locations with
 *      addressLine + city + pincode; clicking advances to details.
 *   6. Details form renders contact-info inputs (name / phone / email),
 *      a datetime-local slot input, and a notes input — with the picked
 *      service + location summary banner at the top.
 *   7. Submitting the form POSTs /api/wellness/public/book with the
 *      tenant slug + serviceId + locationId + contact fields +
 *      bookingType=CLINIC_VISIT default; on success renders the
 *      "Booking confirmed" confirmation screen with visit #id.
 *   8. Submit error (non-ok JSON with .error) surfaces inline error text
 *      under the form ("Booking failed" if server omits a message).
 *   9. Network error (fetch throws) surfaces the friendly "Network error."
 *      banner instead of crashing.
 *
 * Drift notes pinned during authoring:
 *   - SUT uses NATIVE fetch (not fetchApi from utils/api), so the global
 *     fetch is stubbed per-test. No Bearer / Authorization header is
 *     expected on either GET or POST.
 *   - SUT uses useParams() — must wrap in MemoryRouter + Routes + Route
 *     with path="/book/:slug" so the slug is actually populated.
 *   - SUT uses useFormAutosave (sessionStorage-backed) — clean storage
 *     in beforeEach so a previous test's draft doesn't pollute the next.
 *   - The "Clinic not found." copy is the literal SUT text (line 55),
 *     even though the gap-card framing said "Tenant not found."
 *   - The default bookingType is 'CLINIC_VISIT' (line 12); the chip group
 *     is HIDDEN when the service supports only CLINIC_VISIT (line 241),
 *     so tests use services with supportedBookingTypes=['CLINIC_VISIT']
 *     to keep the form simple.
 *
 * Mock discipline (per CLAUDE.md feedback rules):
 *   - global.fetch is per-test stubbed (vi.fn) so each test asserts its
 *     own URL/body shape; reset in beforeEach.
 *   - No useNotify is consumed by the SUT (public page, no toast surface);
 *     errors render inline.
 *   - No AuthContext is consumed (public page).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import PublicBooking from '../pages/wellness/PublicBooking';

const sampleProfile = {
  tenant: { id: 1, name: 'Enhanced Wellness', slug: 'enhanced-wellness' },
  services: [
    {
      id: 11,
      name: 'PRP Hair Treatment',
      category: 'Aesthetic',
      basePrice: 8000,
      durationMin: 45,
      supportedBookingTypes: ['CLINIC_VISIT'],
    },
    {
      id: 12,
      name: 'Consultation',
      category: 'Doctor',
      basePrice: 1500,
      durationMin: 20,
      supportedBookingTypes: ['CLINIC_VISIT'],
    },
  ],
  locations: [
    {
      id: 21,
      name: 'Greater Kailash Clinic',
      addressLine: 'M-block, GK-2',
      city: 'New Delhi',
      pincode: '110048',
    },
  ],
  resources: [],
};

function renderPage(slug = 'enhanced-wellness') {
  return render(
    <MemoryRouter initialEntries={[`/book/${slug}`]}>
      <Routes>
        <Route path="/book/:slug" element={<PublicBooking />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('PublicBooking (/book/:slug) — public unauthed wellness booking flow', () => {
  beforeEach(() => {
    // Clean autosave draft between tests so the form starts fresh.
    try { sessionStorage.clear(); } catch { /* ignore */ }
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Loading… chrome while the tenant catalog fetch is in flight', async () => {
    // Return a never-resolving promise so the loading state stays put.
    global.fetch.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findByText(/Loading/i)).toBeInTheDocument();
  });

  it('fires GET /api/wellness/public/tenant/:slug with the URL slug on mount', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
    renderPage('enhanced-wellness');

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith('/api/wellness/public/tenant/enhanced-wellness');
    // First call carries no second-arg (no headers / no Bearer) — this is a public endpoint.
    expect(global.fetch.mock.calls[0][1]).toBeUndefined();
  });

  it('renders "Clinic not found." when the tenant fetch returns a non-2xx', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) });
    renderPage('does-not-exist');
    expect(await screen.findByText(/Clinic not found/i)).toBeInTheDocument();
  });

  it('renders the tenant heading + service picker once the catalog resolves', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
    renderPage();

    // Tenant brand surfaces in the header.
    expect(await screen.findByRole('heading', { name: 'Enhanced Wellness' })).toBeInTheDocument();
    // Both services render as picker buttons.
    expect(screen.getByText('PRP Hair Treatment')).toBeInTheDocument();
    expect(screen.getByText('Consultation')).toBeInTheDocument();
    // Step heading: "1. Pick a service"
    expect(screen.getByText(/Pick a service/i)).toBeInTheDocument();
  });

  it('clicking a service advances to the location-picker step', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
    renderPage();

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));

    // Location picker chrome.
    expect(await screen.findByText(/Pick a clinic/i)).toBeInTheDocument();
    expect(screen.getByText('Greater Kailash Clinic')).toBeInTheDocument();
    // Location address detail is composed of addressLine + city + pincode.
    expect(screen.getByText(/M-block, GK-2, New Delhi 110048/)).toBeInTheDocument();
  });

  it('clicking a location advances to the details form with the chosen service summary', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
    renderPage();

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));

    // Details-step chrome.
    expect(await screen.findByText(/Your details/i)).toBeInTheDocument();
    // Contact-info inputs.
    expect(screen.getByLabelText(/Your name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Phone number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Preferred slot/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Notes/i)).toBeInTheDocument();
    // The chosen service + clinic appear in the summary banner.
    expect(screen.getByRole('button', { name: /Confirm booking/i })).toBeInTheDocument();
  });

  it('submits POST /api/wellness/public/book with tenant slug + service + location + contact + CLINIC_VISIT default', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
    renderPage();

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));

    fireEvent.change(await screen.findByLabelText(/Your name/i), { target: { value: 'Rashmi Iyer' } });
    fireEvent.change(screen.getByLabelText(/Phone number/i), { target: { value: '9876543210' } });
    fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: 'rashmi@example.com' } });

    // Queue the POST response BEFORE clicking submit.
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ patient: { id: 901, name: 'Rashmi Iyer' }, visit: { id: 5501 } }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Confirm booking/i }));

    await waitFor(() => {
      const postCall = global.fetch.mock.calls.find((c) => c[0] === '/api/wellness/public/book');
      expect(postCall).toBeDefined();
    });

    const postCall = global.fetch.mock.calls.find((c) => c[0] === '/api/wellness/public/book');
    expect(postCall[1].method).toBe('POST');
    expect(postCall[1].headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(postCall[1].body);
    expect(body).toMatchObject({
      tenantSlug: 'enhanced-wellness',
      serviceId: 11,
      locationId: 21,
      name: 'Rashmi Iyer',
      phone: '9876543210',
      email: 'rashmi@example.com',
      bookingType: 'CLINIC_VISIT',
    });
  });

  it('renders the "Booking confirmed" confirmation screen with visit #id on success', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
    renderPage();

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));
    fireEvent.change(await screen.findByLabelText(/Your name/i), { target: { value: 'Rashmi Iyer' } });
    fireEvent.change(screen.getByLabelText(/Phone number/i), { target: { value: '9876543210' } });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ patient: { id: 901, name: 'Rashmi Iyer' }, visit: { id: 5501 } }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Confirm booking/i }));

    expect(await screen.findByText(/Booking confirmed/i)).toBeInTheDocument();
    // The visit id is surfaced as the reference.
    expect(screen.getByText(/visit #5501/)).toBeInTheDocument();
    // Patient name appears in the greeting.
    expect(screen.getByText(/Hi Rashmi Iyer/)).toBeInTheDocument();
  });

  it('surfaces the server-supplied error message when POST /public/book returns non-ok', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
    renderPage();

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));
    fireEvent.change(await screen.findByLabelText(/Your name/i), { target: { value: 'Rashmi Iyer' } });
    fireEvent.change(screen.getByLabelText(/Phone number/i), { target: { value: '9876543210' } });

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Phone already booked for this slot' }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Confirm booking/i }));

    expect(await screen.findByText(/Phone already booked for this slot/i)).toBeInTheDocument();
    // Confirmation chrome must NOT render on failure.
    expect(screen.queryByText(/Booking confirmed/i)).not.toBeInTheDocument();
  });

  it('renders the friendly "Network error." banner when the POST fetch throws', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
    renderPage();

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));
    fireEvent.change(await screen.findByLabelText(/Your name/i), { target: { value: 'Rashmi Iyer' } });
    fireEvent.change(screen.getByLabelText(/Phone number/i), { target: { value: '9876543210' } });

    global.fetch.mockRejectedValueOnce(new Error('socket hang up'));

    fireEvent.click(screen.getByRole('button', { name: /Confirm booking/i }));

    expect(await screen.findByText(/Network error/i)).toBeInTheDocument();
    expect(screen.queryByText(/Booking confirmed/i)).not.toBeInTheDocument();
  });
});
