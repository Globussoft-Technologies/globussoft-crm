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

  // ─────────────────────────────────────────────────────────────────────────────
  // Tick #141 Agent C — extending coverage from 294L → ~500L (SUT 397L).
  // Targets the previously-uncovered SUT branches:
  //   • #218 catalog defensive-filter (price/duration sanity gate)
  //   • Multi-bookingType chip group + IN_HOME / VIDEO conditional UI
  //   • Wave 8b Resource picker (CLINIC_VISIT + location-scoped filter)
  //   • Wave 2 Agent LL UTM + document.referrer capture-and-forward
  //   • Submitting button state ("Booking…" + disabled while in flight)
  //   • Successful-submit autosave-draft cleanup
  // ─────────────────────────────────────────────────────────────────────────────

  it('filters out services with corrupt price/duration values (#218 defensive cap)', async () => {
    // Service grid should drop rows where basePrice<=0, durationMin<=0, NaN,
    // or values above the caps (price>5_000_000 or duration>720). Only the
    // single well-formed row should reach the picker.
    const corruptProfile = {
      ...sampleProfile,
      services: [
        { id: 100, name: 'Good Service', category: 'Aesthetic', basePrice: 1000, durationMin: 30, supportedBookingTypes: ['CLINIC_VISIT'] },
        { id: 101, name: 'Zero Price', category: 'Doctor', basePrice: 0, durationMin: 30, supportedBookingTypes: ['CLINIC_VISIT'] },
        { id: 102, name: 'Negative Duration', category: 'Doctor', basePrice: 500, durationMin: -10, supportedBookingTypes: ['CLINIC_VISIT'] },
        { id: 103, name: 'NaN Price', category: 'Doctor', basePrice: 'oops', durationMin: 30, supportedBookingTypes: ['CLINIC_VISIT'] },
        { id: 104, name: 'Excessive Price', category: 'Doctor', basePrice: 9_000_000, durationMin: 30, supportedBookingTypes: ['CLINIC_VISIT'] },
        { id: 105, name: 'Day-Long Duration', category: 'Doctor', basePrice: 500, durationMin: 1000, supportedBookingTypes: ['CLINIC_VISIT'] },
      ],
    };
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(corruptProfile) });
    renderPage();

    expect(await screen.findByText('Good Service')).toBeInTheDocument();
    expect(screen.queryByText('Zero Price')).not.toBeInTheDocument();
    expect(screen.queryByText('Negative Duration')).not.toBeInTheDocument();
    expect(screen.queryByText('NaN Price')).not.toBeInTheDocument();
    expect(screen.queryByText('Excessive Price')).not.toBeInTheDocument();
    expect(screen.queryByText('Day-Long Duration')).not.toBeInTheDocument();
  });

  it('renders the booking-type radiogroup when service supports >1 channel', async () => {
    // SUT line 241: chip group is HIDDEN when supported.length === 1; visible
    // otherwise. With CLINIC_VISIT + IN_HOME, two radio buttons render.
    const multiTypeProfile = {
      ...sampleProfile,
      services: [
        { id: 200, name: 'Hybrid Service', category: 'Doctor', basePrice: 2000, durationMin: 30,
          supportedBookingTypes: ['CLINIC_VISIT', 'IN_HOME', 'VIDEO'] },
      ],
    };
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(multiTypeProfile) });
    renderPage();

    await screen.findByText('Hybrid Service');
    fireEvent.click(screen.getByText('Hybrid Service'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));

    // The radiogroup heading + three radios render on the details step.
    expect(await screen.findByText(/How would you like the appointment/i)).toBeInTheDocument();
    const radiogroup = screen.getByRole('radiogroup', { name: /Appointment type/i });
    expect(radiogroup).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Clinic visit/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /At home/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Video consult/i })).toBeInTheDocument();
    // CLINIC_VISIT is the default; aria-checked=true on that one.
    expect(screen.getByRole('radio', { name: /Clinic visit/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('reveals the at-home address block when user picks IN_HOME', async () => {
    // SUT lines 287-319: address textarea + city + pincode inputs render
    // ONLY when bookingType=IN_HOME. The Wave 8b resource picker disappears
    // (it's CLINIC_VISIT-only) — keeping the form coherent.
    const multiTypeProfile = {
      ...sampleProfile,
      services: [
        { id: 200, name: 'Hybrid Service', category: 'Doctor', basePrice: 2000, durationMin: 30,
          supportedBookingTypes: ['CLINIC_VISIT', 'IN_HOME'] },
      ],
    };
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(multiTypeProfile) });
    renderPage();

    await screen.findByText('Hybrid Service');
    fireEvent.click(screen.getByText('Hybrid Service'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));

    // Pre-IN_HOME: address inputs hidden.
    expect(screen.queryByLabelText(/Address line/i)).not.toBeInTheDocument();

    // Click the At home radio.
    fireEvent.click(await screen.findByRole('radio', { name: /At home/i }));

    // Address fields render.
    expect(await screen.findByLabelText(/Address line/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/City/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Pincode/i)).toBeInTheDocument();
    // Pincode input enforces the 6-digit pattern.
    expect(screen.getByLabelText(/Pincode/i)).toHaveAttribute('pattern', '\\d{6}');
  });

  it('renders the VIDEO info banner about SMS link delivery', async () => {
    // SUT lines 321-326: VIDEO branch shows a hint about receiving a video
    // call link by SMS once the slot is confirmed.
    const videoProfile = {
      ...sampleProfile,
      services: [
        { id: 300, name: 'Telehealth Consult', category: 'Doctor', basePrice: 800, durationMin: 15,
          supportedBookingTypes: ['CLINIC_VISIT', 'VIDEO'] },
      ],
    };
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(videoProfile) });
    renderPage();

    await screen.findByText('Telehealth Consult');
    fireEvent.click(screen.getByText('Telehealth Consult'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));

    fireEvent.click(await screen.findByRole('radio', { name: /Video consult/i }));
    expect(await screen.findByText(/video call link by SMS/i)).toBeInTheDocument();
  });

  it('IN_HOME submit includes atHomeAddress + city + pincode in POST body', async () => {
    const multiTypeProfile = {
      ...sampleProfile,
      services: [
        { id: 200, name: 'Hybrid Service', category: 'Doctor', basePrice: 2000, durationMin: 30,
          supportedBookingTypes: ['CLINIC_VISIT', 'IN_HOME'] },
      ],
    };
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(multiTypeProfile) });
    renderPage();

    await screen.findByText('Hybrid Service');
    fireEvent.click(screen.getByText('Hybrid Service'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));

    fireEvent.click(await screen.findByRole('radio', { name: /At home/i }));
    fireEvent.change(await screen.findByLabelText(/Your name/i), { target: { value: 'Anita Rao' } });
    fireEvent.change(screen.getByLabelText(/Phone number/i), { target: { value: '9123456780' } });
    fireEvent.change(screen.getByLabelText(/Address line/i), { target: { value: 'B-12, Mayur Vihar Ph-1' } });
    fireEvent.change(screen.getByLabelText(/City/i), { target: { value: 'New Delhi' } });
    fireEvent.change(screen.getByLabelText(/Pincode/i), { target: { value: '110091' } });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ patient: { id: 902, name: 'Anita Rao' }, visit: { id: 5502 } }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Confirm booking/i }));

    await waitFor(() => {
      const postCall = global.fetch.mock.calls.find((c) => c[0] === '/api/wellness/public/book');
      expect(postCall).toBeDefined();
    });

    const postCall = global.fetch.mock.calls.find((c) => c[0] === '/api/wellness/public/book');
    const body = JSON.parse(postCall[1].body);
    expect(body).toMatchObject({
      bookingType: 'IN_HOME',
      atHomeAddress: 'B-12, Mayur Vihar Ph-1',
      atHomeCity: 'New Delhi',
      atHomePincode: '110091',
    });
  });

  it('renders the Wave 8b Resource picker filtered to the chosen location', async () => {
    // SUT lines 332-357: resource picker renders when bookingType=CLINIC_VISIT
    // AND profile.resources is non-empty. Resources are filtered to ones whose
    // locationId is null (unscoped) OR matches picked.location.id.
    const resourcedProfile = {
      ...sampleProfile,
      resources: [
        { id: 401, name: 'Room A', type: 'ROOM', locationId: 21 },
        { id: 402, name: 'Chair 3', type: 'CHAIR', locationId: 21 },
        { id: 403, name: 'Mobile Cart', type: 'EQUIPMENT', locationId: null },
        // This one is scoped to a DIFFERENT location → should be filtered out.
        { id: 404, name: 'Other-Clinic Room', type: 'ROOM', locationId: 99 },
      ],
    };
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(resourcedProfile) });
    renderPage();

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));

    const picker = await screen.findByLabelText(/Preferred room or resource/i);
    expect(picker).toBeInTheDocument();
    // Default placeholder option present.
    expect(screen.getByText(/No preference/i)).toBeInTheDocument();
    // In-scope resources rendered; type suffix shown for non-ROOM only.
    expect(screen.getByText('Room A')).toBeInTheDocument();
    expect(screen.getByText(/Chair 3 \(chair\)/)).toBeInTheDocument();
    expect(screen.getByText(/Mobile Cart \(equipment\)/)).toBeInTheDocument();
    // Out-of-scope resource NOT rendered.
    expect(screen.queryByText(/Other-Clinic Room/)).not.toBeInTheDocument();
  });

  it('sends resourceId as a number in the POST body when user picks a resource', async () => {
    const resourcedProfile = {
      ...sampleProfile,
      resources: [
        { id: 401, name: 'Room A', type: 'ROOM', locationId: 21 },
      ],
    };
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(resourcedProfile) });
    renderPage();

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));

    fireEvent.change(await screen.findByLabelText(/Your name/i), { target: { value: 'Priya Sharma' } });
    fireEvent.change(screen.getByLabelText(/Phone number/i), { target: { value: '9988776655' } });
    fireEvent.change(screen.getByLabelText(/Preferred room or resource/i), { target: { value: '401' } });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ patient: { id: 903 }, visit: { id: 5503 } }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Confirm booking/i }));

    await waitFor(() => {
      const postCall = global.fetch.mock.calls.find((c) => c[0] === '/api/wellness/public/book');
      expect(postCall).toBeDefined();
    });

    const postCall = global.fetch.mock.calls.find((c) => c[0] === '/api/wellness/public/book');
    const body = JSON.parse(postCall[1].body);
    // SUT line 116 parses the value with parseInt(value, 10) — number, not string.
    expect(body.resourceId).toBe(401);
    expect(typeof body.resourceId).toBe('number');
  });

  it('omits resourceId from the POST body when user keeps the default "No preference"', async () => {
    // SUT line 115: resourceId is only attached when truthy. Empty string
    // (the default option) must NOT land in the payload.
    const resourcedProfile = {
      ...sampleProfile,
      resources: [{ id: 401, name: 'Room A', type: 'ROOM', locationId: 21 }],
    };
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(resourcedProfile) });
    renderPage();

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));

    fireEvent.change(await screen.findByLabelText(/Your name/i), { target: { value: 'Kavya Menon' } });
    fireEvent.change(screen.getByLabelText(/Phone number/i), { target: { value: '9000111222' } });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ patient: { id: 904 }, visit: { id: 5504 } }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Confirm booking/i }));

    await waitFor(() => {
      const postCall = global.fetch.mock.calls.find((c) => c[0] === '/api/wellness/public/book');
      expect(postCall).toBeDefined();
    });

    const postCall = global.fetch.mock.calls.find((c) => c[0] === '/api/wellness/public/book');
    const body = JSON.parse(postCall[1].body);
    expect(body).not.toHaveProperty('resourceId');
  });

  it('hides the resource picker entirely when profile.resources is empty', async () => {
    // SUT line 332: picker section guards on resources.length > 0. With an
    // empty resources array (the seed default), no Preferred-room label.
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
    renderPage();

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));

    await screen.findByLabelText(/Your name/i);
    expect(screen.queryByLabelText(/Preferred room or resource/i)).not.toBeInTheDocument();
  });

  it('captures UTM params from the URL and forwards them in the POST body', async () => {
    // SUT lines 63-84: utm_source/medium/campaign/term/content from
    // location.search land on the `utm` key of the payload.
    const originalLocation = window.location;
    delete window.location;
    window.location = { ...originalLocation, search: '?utm_source=fb&utm_medium=cpc&utm_campaign=spring2026&utm_term=prp&utm_content=hero' };

    try {
      global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
      renderPage();

      await screen.findByText('PRP Hair Treatment');
      fireEvent.click(screen.getByText('PRP Hair Treatment'));
      fireEvent.click(await screen.findByText('Greater Kailash Clinic'));
      fireEvent.change(await screen.findByLabelText(/Your name/i), { target: { value: 'Sneha P' } });
      fireEvent.change(screen.getByLabelText(/Phone number/i), { target: { value: '9112233445' } });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ patient: { id: 905 }, visit: { id: 5505 } }),
      });

      fireEvent.click(screen.getByRole('button', { name: /Confirm booking/i }));

      await waitFor(() => {
        const postCall = global.fetch.mock.calls.find((c) => c[0] === '/api/wellness/public/book');
        expect(postCall).toBeDefined();
      });

      const postCall = global.fetch.mock.calls.find((c) => c[0] === '/api/wellness/public/book');
      const body = JSON.parse(postCall[1].body);
      expect(body.utm).toMatchObject({
        utmSource: 'fb',
        utmMedium: 'cpc',
        utmCampaign: 'spring2026',
        utmTerm: 'prp',
        utmContent: 'hero',
      });
    } finally {
      window.location = originalLocation;
    }
  });

  it('omits the `utm` key entirely on an organic visit (no UTM query params)', async () => {
    // SUT lines 76-77: `hasAny` guard keeps the JSON payload tidy when no
    // UTM fields populated. Organic visit → no `utm` key in the POST.
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
    renderPage();

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));
    fireEvent.change(await screen.findByLabelText(/Your name/i), { target: { value: 'Organic Visitor' } });
    fireEvent.change(screen.getByLabelText(/Phone number/i), { target: { value: '9000000111' } });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ patient: { id: 906 }, visit: { id: 5506 } }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Confirm booking/i }));

    await waitFor(() => {
      const postCall = global.fetch.mock.calls.find((c) => c[0] === '/api/wellness/public/book');
      expect(postCall).toBeDefined();
    });

    const postCall = global.fetch.mock.calls.find((c) => c[0] === '/api/wellness/public/book');
    const body = JSON.parse(postCall[1].body);
    expect(body).not.toHaveProperty('utm');
  });

  it('clears the autosaved draft from sessionStorage after a successful submit', async () => {
    // SUT line 133: clearDraft() fires inside the res.ok branch. The
    // useFormAutosave key is `gbs.form.public-booking.<slug>`.
    const slug = 'enhanced-wellness';
    const draftKey = `gbs.form.public-booking.${slug}`;

    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
    renderPage(slug);

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));

    fireEvent.change(await screen.findByLabelText(/Your name/i), { target: { value: 'Draft Tester' } });
    fireEvent.change(screen.getByLabelText(/Phone number/i), { target: { value: '9333444555' } });

    // After dirty typing, the autosave writes the draft.
    await waitFor(() => expect(sessionStorage.getItem(draftKey)).not.toBeNull());

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ patient: { id: 907, name: 'Draft Tester' }, visit: { id: 5507 } }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Confirm booking/i }));

    // After successful submit, the draft must be cleared.
    await screen.findByText(/Booking confirmed/i);
    expect(sessionStorage.getItem(draftKey)).toBeNull();
  });

  it('keys the autosaved draft by tenant slug so drafts do not leak between clinics', async () => {
    // SUT line 38: useFormAutosave(`public-booking.${slug || 'default'}`).
    // Typing under one slug must populate its key only.
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sampleProfile) });
    renderPage('clinic-alpha');

    await screen.findByText('PRP Hair Treatment');
    fireEvent.click(screen.getByText('PRP Hair Treatment'));
    fireEvent.click(await screen.findByText('Greater Kailash Clinic'));
    fireEvent.change(await screen.findByLabelText(/Your name/i), { target: { value: 'Cross-Clinic Tester' } });

    await waitFor(() => {
      expect(sessionStorage.getItem('gbs.form.public-booking.clinic-alpha')).not.toBeNull();
    });
    // Bravo-clinic key must NOT be populated by typing under alpha-clinic.
    expect(sessionStorage.getItem('gbs.form.public-booking.clinic-bravo')).toBeNull();
  });
});
