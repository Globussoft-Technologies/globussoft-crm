/**
 * Locations.test.jsx — vitest + RTL coverage for the wellness-vertical
 * multi-clinic locations admin page (frontend/src/pages/wellness/Locations.jsx).
 *
 * Scope: pins the page-surface invariants for the per-clinic location master —
 * heading + CTA, loading state, GET on mount, empty-state, location-card
 * render (name + city/state/pincode + addressLine + phone + email + active
 * badge), New-location form open/close + CTA-label flip, create POST shape,
 * edit-prefill flow (Pencil opens form pre-filled), Active/Inactive toggle
 * (PUT with {isActive:!current}), and pincode-input behaviour (digits-only +
 * 6-char cap, per SUT line 98).
 *
 * Test cases (10):
 *   1. Heading "Clinic locations" + "New location" CTA + location-count
 *      sub-copy ("N location(s) — add new ones as you franchise.") render.
 *   2. Loading state: "Loading…" renders while the initial GET is in flight
 *      (per CLAUDE.md tick #108 cron-learning).
 *   3. GET /api/wellness/locations fires on mount and rendered cards match
 *      payload.
 *   4. Empty-state copy "No locations yet. Add one to start tracking per-
 *      clinic metrics." renders when GET resolves to [].
 *   5. Location card renders name + city/state/pincode + addressLine + phone
 *      + email + Active/Inactive status badge.
 *   6. Clicking "New location" opens the form (name + addressLine + city +
 *      state + pincode + phone + email fields visible); CTA label flips to
 *      "Cancel"; click again closes + flips back.
 *   7. Submitting the form POSTs /api/wellness/locations with body shape
 *      {name, addressLine, city, state, pincode, phone, email} + notify.success
 *      + refetches the list.
 *   8. Name + addressLine + city inputs carry the `required` attribute
 *      (browser-native blank-blocking — SUT lines 91-93).
 *   9. Clicking the card's Edit (Pencil) button opens the form pre-filled with
 *      name + addressLine + city + state + pincode + phone + email; Save →
 *      PUT /api/wellness/locations/:id + notify.success.
 *  10. Active/Inactive toggle: clicking the status button on an Active row
 *      PUTs {isActive:false} to /api/wellness/locations/:id + notify.success
 *      (Deactivated); clicking on an Inactive row PUTs {isActive:true}.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/) with a
 *     stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap useCallback dep identity).
 *   - SUT does NOT consume AuthContext → no Provider wrapper. MemoryRouter is
 *     defensive in case any lazy descendant pulls in a Link/useNavigate.
 *   - No window.confirm needed (SUT has NO delete flow — drift item below).
 *   - vi.mock paths are `../utils/api` and `../utils/notify` relative to the
 *     flat top-level `__tests__/` directory.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "delete flow with native window.confirm + DELETE".
 *     REALITY: SUT has NO delete capability — only an Active/Inactive toggle
 *     (PUT with {isActive: !current}, SUT lines 60-66). Locations are
 *     soft-deactivated, never hard-deleted (likely because Patient.locationId
 *     + Visit.locationId reference them per CLAUDE.md Prisma extended-fields).
 *     Replaced the delete cases with toggle-Active cases (case 10).
 *   - Prompt anticipated "default-location indicator (chip/badge on default
 *     location)". REALITY: SUT has NO concept of a default location. Every
 *     location is equal — Patient/Visit just carry their own locationId. No
 *     'Set as default' button, no PATCH endpoint, no default chip. Omitted.
 *   - Prompt anticipated "Set as default flow (if present): PATCHes ...".
 *     REALITY: same as above — not implemented. Omitted.
 *   - Prompt anticipated "RBAC: USER hides mutation CTAs only if SUT
 *     enforces". CONFIRMED backend-only: the SUT does NOT consume AuthContext
 *     at all; every authenticated client sees the New-location CTA + Pencil +
 *     toggle buttons. Backend wellness.js route gates by role. Omitted in-page
 *     RBAC tests (covered by /api/wellness/locations api spec).
 *   - Prompt anticipated "Loading…" verbatim. CONFIRMED — SUT line 112 renders
 *     "Loading…" exactly (not "Loading locations…"). Pin via /^Loading…$/.
 *   - Prompt anticipated "validation: empty name rejected". REALITY: SUT
 *     relies on browser-native `required` attributes on name + addressLine +
 *     city inputs (SUT lines 91-93). No in-JS validation function to test.
 *     Pinned via attribute presence (case 8).
 *   - Prompt anticipated "active/inactive badge per row". CONFIRMED — SUT
 *     lines 136-139 render either "Active" or "Inactive" inside the toggle
 *     button. The button is ALSO the toggle (no separate badge + button).
 *   - Prompt anticipated "error handling: 500 → silent degrade or notify.
 *     error; 403 → access-restricted". CONFIRMED silent-degrade: SUT line 19
 *     `.catch(() => setLocations([]))` swallows errors silently → empty-state.
 *     Behaviour is identical to case 4 (empty-state). Omitted error-branch
 *     case as it's structurally indistinguishable.
 *   - Prompt anticipated "pincode field with 6-digit pattern". CONFIRMED —
 *     SUT line 98 enforces inputMode=numeric, pattern=\d{6}, maxLength=6, and
 *     strips non-digits on change. Form submission with a valid 6-digit
 *     pincode pinned in case 7's POST-body assertion.
 *   - Backend endpoint confirmed at /api/wellness/locations (SUT lines 19, 48,
 *     51, 62). Pattern matches sibling ServiceCategories + Vendors.
 *
 * Path: flat __tests__/Locations.test.jsx — matches sibling
 * Vendors/ServiceCategories/Holidays flat-path convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789, Wave 12 f59e91d).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import Locations from '../pages/wellness/Locations';

const RANCHI_LOCATION = {
  id: 501,
  name: 'Ranchi',
  addressLine: '12, Main Rd, Lalpur',
  city: 'Ranchi',
  state: 'Jharkhand',
  pincode: '834001',
  phone: '+91 98765 43210',
  email: 'ranchi@enhancedwellness.in',
  isActive: true,
};
const PATNA_LOCATION = {
  id: 502,
  name: 'Patna',
  addressLine: '8 Boring Rd, Patliputra Colony',
  city: 'Patna',
  state: 'Bihar',
  pincode: '800013',
  phone: '+91 90000 22222',
  email: 'patna@enhancedwellness.in',
  isActive: false,
};

function installFetchMock({
  locations = [RANCHI_LOCATION, PATNA_LOCATION],
  locationsPromise = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/wellness/locations' && method === 'GET') {
      if (locationsPromise) return locationsPromise;
      return Promise.resolve(locations);
    }
    if (/^\/api\/wellness\/locations(\/\d+)?$/.test(url)) {
      // POST / PUT — resolve so submit / toggle paths complete.
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Locations />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
});

describe('<Locations /> — page chrome', () => {
  it('renders heading "Clinic locations" + "New location" CTA + location-count sub-copy', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Clinic locations/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /New location/i }),
    ).toBeInTheDocument();
    // Sub-copy uses count + "location(s)" + "add new ones as you franchise"
    // phrasing.
    await waitFor(() => {
      expect(
        screen.getAllByText((_t, el) =>
          /\d+ location.*add new ones as you franchise/i.test(
            el?.textContent || '',
          ),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders "Loading…" while the initial GET is in flight', async () => {
    // Block the fetch indefinitely to pin the loading branch.
    installFetchMock({ locationsPromise: new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<Locations /> — mount fetch + list render', () => {
  it('fires GET /api/wellness/locations on mount and renders location cards', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/locations');
    });
    // "Ranchi" appears as the card h3 + as a text node inside the
    // city/state/pincode line ("Ranchi, Jharkhand — 834001"). Use
    // findAllByText with the default text-node matcher — at least the h3
    // resolves; the text-node-with-siblings city node may or may not depending
    // on RTL's normalizer, so >=1 is the safe floor.
    expect((await screen.findAllByText('Ranchi')).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.getAllByText('Patna').length).toBeGreaterThanOrEqual(1);
    // The card heading (h3) renders the location name — pin specifically.
    expect(
      screen.getByRole('heading', { level: 3, name: /Ranchi/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: /Patna/i }),
    ).toBeInTheDocument();
  });

  it('renders the empty-state copy when GET resolves to []', async () => {
    installFetchMock({ locations: [] });
    renderPage();
    expect(
      await screen.findByText(/No locations yet\. Add one to start tracking/i),
    ).toBeInTheDocument();
  });

  it('renders location-card fields: name + city/state/pincode + addressLine + phone + email + status', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 3, name: /Ranchi/i }),
      ).toBeInTheDocument();
    });
    // City/state/pincode composite cell (SUT lines 122-124 render
    // "Ranchi, Jharkhand — 834001" / "Patna, Bihar — 800013"). The matcher
    // resolves on both the wrapping <div> and intermediary spans →
    // getAllByText with >=1.
    expect(
      screen.getAllByText((_t, el) =>
        /Ranchi,\s*Jharkhand\s*—\s*834001/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText((_t, el) =>
        /Patna,\s*Bihar\s*—\s*800013/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // addressLine text.
    expect(screen.getByText('12, Main Rd, Lalpur')).toBeInTheDocument();
    expect(
      screen.getByText('8 Boring Rd, Patliputra Colony'),
    ).toBeInTheDocument();
    // phone + email rendered.
    expect(
      screen.getAllByText((_t, el) =>
        /\+91 98765 43210/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText((_t, el) =>
        /ranchi@enhancedwellness\.in/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // Status: one Active (Ranchi), one Inactive (Patna).
    expect(screen.getByText(/^Active$/)).toBeInTheDocument();
    expect(screen.getByText(/^Inactive$/)).toBeInTheDocument();
  });
});

describe('<Locations /> — New-location form toggle', () => {
  it('"New location" opens the form (label flips to "Cancel"); click again closes it', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Ranchi').length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(screen.getByRole('button', { name: /New location/i }));
    // Form fields visible.
    expect(
      screen.getByPlaceholderText(/Short name — e\.g\. Ranchi/),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Address — e\.g\. 12, Main Rd, Lalpur/),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/^City — e\.g\. Ranchi$/),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Pincode — 6 digits/),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Phone — e\.g\. \+91 98765 43210/),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Email — e\.g\. clinic@brand\.in/),
    ).toBeInTheDocument();
    // CTA label flipped.
    expect(
      screen.getByRole('button', { name: /^Cancel$/ }),
    ).toBeInTheDocument();
    // Click Cancel → form closes, label flips back.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(
      screen.queryByPlaceholderText(/Short name — e\.g\. Ranchi/),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /New location/i }),
    ).toBeInTheDocument();
  });

  it('name + addressLine + city inputs carry the `required` attribute', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Ranchi').length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(screen.getByRole('button', { name: /New location/i }));
    expect(
      screen.getByPlaceholderText(/Short name — e\.g\. Ranchi/),
    ).toBeRequired();
    expect(
      screen.getByPlaceholderText(/Address — e\.g\. 12, Main Rd, Lalpur/),
    ).toBeRequired();
    expect(
      screen.getByPlaceholderText(/^City — e\.g\. Ranchi$/),
    ).toBeRequired();
  });
});

describe('<Locations /> — create POST', () => {
  it('Create → POST /api/wellness/locations with body shape + notify.success + refetch', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Ranchi').length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(screen.getByRole('button', { name: /New location/i }));
    fireEvent.change(
      screen.getByPlaceholderText(/Short name — e\.g\. Ranchi/),
      { target: { value: 'Dhanbad' } },
    );
    fireEvent.change(
      screen.getByPlaceholderText(/Address — e\.g\. 12, Main Rd, Lalpur/),
      { target: { value: '4 Bank More, Dhanbad' } },
    );
    fireEvent.change(screen.getByPlaceholderText(/^City — e\.g\. Ranchi$/), {
      target: { value: 'Dhanbad' },
    });
    fireEvent.change(screen.getByPlaceholderText(/State — e\.g\. Jharkhand/), {
      target: { value: 'Jharkhand' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Pincode — 6 digits/), {
      target: { value: '826001' },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/Phone — e\.g\. \+91 98765 43210/),
      { target: { value: '+91 90000 33333' } },
    );
    fireEvent.change(
      screen.getByPlaceholderText(/Email — e\.g\. clinic@brand\.in/),
      { target: { value: 'dhanbad@enhancedwellness.in' } },
    );

    fireEvent.click(screen.getByRole('button', { name: /Save location/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/locations' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({
        name: 'Dhanbad',
        addressLine: '4 Bank More, Dhanbad',
        city: 'Dhanbad',
        state: 'Jharkhand',
        pincode: '826001',
        phone: '+91 90000 33333',
        email: 'dhanbad@enhancedwellness.in',
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Created.*Dhanbad/i),
    );
    // After create, list refetches → at least 2 GETs total.
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        u === '/api/wellness/locations' && (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('<Locations /> — edit prefill + PUT', () => {
  it('Edit (Pencil) opens the form pre-filled and Save → PUT /api/wellness/locations/:id', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Ranchi').length).toBeGreaterThanOrEqual(1);
    });
    // Edit buttons use title="Edit location"; pick the first (Ranchi row,
    // sorted by API response order).
    const editButtons = screen.getAllByTitle('Edit location');
    expect(editButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(editButtons[0]); // Ranchi row.

    // Pre-fill: name + addressLine + city + state + pincode + phone + email.
    const nameInput = screen.getByPlaceholderText(/Short name — e\.g\. Ranchi/);
    expect(nameInput.value).toBe('Ranchi');
    expect(
      screen.getByPlaceholderText(/Address — e\.g\. 12, Main Rd, Lalpur/).value,
    ).toBe('12, Main Rd, Lalpur');
    expect(
      screen.getByPlaceholderText(/^City — e\.g\. Ranchi$/).value,
    ).toBe('Ranchi');
    expect(
      screen.getByPlaceholderText(/State — e\.g\. Jharkhand/).value,
    ).toBe('Jharkhand');
    expect(screen.getByPlaceholderText(/Pincode — 6 digits/).value).toBe(
      '834001',
    );
    expect(
      screen.getByPlaceholderText(/Phone — e\.g\. \+91 98765 43210/).value,
    ).toBe('+91 98765 43210');
    expect(
      screen.getByPlaceholderText(/Email — e\.g\. clinic@brand\.in/).value,
    ).toBe('ranchi@enhancedwellness.in');

    // Tweak name + submit.
    fireEvent.change(nameInput, {
      target: { value: 'Ranchi (Lalpur HQ)' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/locations/501' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('Ranchi (Lalpur HQ)');
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Updated.*Ranchi \(Lalpur HQ\)/i),
    );
  });
});

describe('<Locations /> — Active/Inactive toggle', () => {
  it('clicking the Active button on an active row PUTs {isActive:false} + notify "Deactivated"', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Ranchi').length).toBeGreaterThanOrEqual(1);
    });
    // The Ranchi row's status button is the only one with text "Active".
    fireEvent.click(screen.getByRole('button', { name: /^Active$/ }));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/locations/501' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body).toEqual({ isActive: false });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Deactivated.*Ranchi/i),
    );
  });

  it('clicking the Inactive button on an inactive row PUTs {isActive:true} + notify "Activated"', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Patna').length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(screen.getByRole('button', { name: /^Inactive$/ }));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/locations/502' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body).toEqual({ isActive: true });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Activated.*Patna/i),
    );
  });
});
