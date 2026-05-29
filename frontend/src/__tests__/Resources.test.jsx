/**
 * Resources.test.jsx — vitest + RTL coverage for the wellness-vertical admin
 * Resources page (frontend/src/pages/wellness/Resources.jsx).
 *
 * Scope: pins the page-surface invariants for the bookable-Resources master
 * (rooms / machines / equipment that the Calendar's New-Visit modal pins each
 * visit to). Backed by backend/lib/bookingAvailability.js's
 * RESOURCE_DOUBLE_BOOKED gate — every visit with a non-null resourceId at the
 * same hour is rejected. UI is admin-only by backend role gate; UI does not
 * gate (matches Locations / Holidays / Memberships sibling pattern).
 *
 * Test cases (11):
 *   1. Heading "Resources" + Box icon + "New resource" CTA + count sub-copy
 *      ("Bookable rooms, machines, and equipment (N) — …") render.
 *   2. Loading state: bare `<div>Loading…</div>` renders while the parallel
 *      GETs (resources + locations) are in flight (per CLAUDE.md tick #108
 *      pattern — SUT line 134).
 *   3. Mount fires two parallel GETs: /api/wellness/resources +
 *      /api/wellness/locations (Promise.all inside `load()` SUT lines 28-37).
 *   4. Empty resources array → empty-state copy ("No resources yet. Add a
 *      treatment room or machine…") renders, no table rows.
 *   5. Populated rows render: name + type + location (looked up via
 *      locations.find on locationId) + active status ("Yes"/"No"). Tenant-wide
 *      resource (locationId null) shows "tenant-wide" label.
 *   6. "New resource" toggle opens the form (name input + type select with
 *      ROOM/MACHINE/EQUIPMENT + location select with tenant-wide option +
 *      active checkbox); CTA label flips to "Cancel"; click again hides form.
 *   7. Submit Create → POST /api/wellness/resources with body shape
 *      {name, type, locationId:int|null, isActive} + notify.success("Created…")
 *      + refetches the list.
 *   8. Name input is `required` (browser-native blank-blocking — SUT line 115).
 *   9. Edit (Pencil) opens the form pre-filled with the row's name + type +
 *      locationId + isActive; Save → PUT /api/wellness/resources/:id +
 *      notify.success("Updated…").
 *  10. Delete: window.confirm true → DELETE /api/wellness/resources/:id +
 *      notify.success("Deleted…") + refetch; window.confirm false → no DELETE
 *      fires (SUT line 81 — `if (!window.confirm(...)) return;`).
 *  11. Form's locationId select includes a "tenant-wide" option AND one option
 *      per location returned by the locations GET (clinic association picker).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/) with a
 *     stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap useCallback dep identity).
 *   - SUT does NOT consume AuthContext → no Provider wrapper needed.
 *   - window.confirm is stubbed per-test via vi.spyOn (matches Holidays
 *     sibling delete-flow pattern).
 *   - vi.mock paths are `../utils/api` and `../utils/notify` relative to the
 *     flat top-level `__tests__/` directory.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "delete flow OR toggle-only (verify which pattern
 *     SUT uses — Locations was toggle-only)". REALITY: Resources DOES support
 *     hard-delete via DELETE /api/wellness/resources/:id (SUT lines 80-87).
 *     Unlike Locations (which references-by-FK from Patient/Visit), Resources
 *     are nullable on Visit (visits keep their slot but lose the resource
 *     pointer per the confirm-prompt SUT line 81) — hard-delete is safe. The
 *     SUT also exposes the isActive checkbox in the form so a soft path
 *     exists too, but DELETE is the primary "remove" UX.
 *   - Prompt anticipated "RBAC: USER hides mutation CTAs only if SUT
 *     enforces". CONFIRMED backend-only: SUT does NOT consume AuthContext at
 *     all; every authenticated client sees New-resource CTA + Pencil + Trash.
 *     Backend wellness.js routes gate by verifyWellnessRole. Omitted in-page
 *     RBAC tests (covered by /api/wellness/resources api spec).
 *   - Prompt anticipated "Loading…" verbatim. CONFIRMED — SUT line 134
 *     renders bare `<div>Loading…</div>` (no ARIA / aria-busy).
 *   - Prompt anticipated "location filter (if present): clicking narrows
 *     query". REALITY: SUT has NO list-level location filter — the location
 *     dimension surfaces only in the form's locationId picker and in the
 *     per-row resolved Location column. The locations list is purely a
 *     foreign-key picker. Omitted.
 *   - Prompt anticipated "validation: empty name rejected". REALITY: SUT
 *     relies on browser-native `required` (SUT line 115). No in-JS validator
 *     to exercise; pinned via attribute presence (case 8).
 *   - Prompt anticipated "error handling: 500 → silent degrade or notify.
 *     error; 403 → access-restricted". CONFIRMED silent-degrade: SUT lines
 *     29-30 `.catch(() => [])` per-fetch swallows errors → resources/locations
 *     fall back to [] → empty-state. Behavior is identical to case 4. Omitted
 *     as structurally indistinguishable.
 *   - Backend endpoints confirmed at /api/wellness/resources + /api/wellness/
 *     locations (SUT lines 29, 30, 68, 71, 83). Pattern matches sibling
 *     Holidays / Locations.
 *   - locationId in the form is stored as a STRING (from the <select> value)
 *     and parsed to int (or null when blank) at submit time (SUT line 64).
 *     Reflected in case 7's POST-body assertion (locationId: 11 as int).
 *
 * Path: flat `__tests__/Resources.test.jsx` — matches sibling
 * Locations/Holidays/Vendors flat-path convention.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789, Wave 12 f59e91d).
// confirm is a vi.fn so individual tests can flip the resolved value
// (re-installed in beforeEach because vitest.setup.js calls restoreAllMocks).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import Resources from '../pages/wellness/Resources';

const LOCATIONS = [
  { id: 11, name: 'Bandra Clinic' },
  { id: 12, name: 'Andheri Clinic' },
];

const RESOURCES_FULL = [
  // Per-location resource.
  { id: 301, name: 'Laser Room 1', type: 'ROOM', locationId: 11, isActive: true },
  // Tenant-wide (locationId null).
  { id: 302, name: 'Mobile Q-Switch Laser', type: 'MACHINE', locationId: null, isActive: true },
  // Inactive equipment.
  { id: 303, name: 'Vintage Derma-Roller', type: 'EQUIPMENT', locationId: 12, isActive: false },
];

function installFetchMock({
  resources = RESOURCES_FULL,
  locations = LOCATIONS,
  resourcesPromise = null,
  locationsPromise = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/wellness/resources' && method === 'GET') {
      if (resourcesPromise) return resourcesPromise;
      return Promise.resolve(resources);
    }
    if (url === '/api/wellness/locations' && method === 'GET') {
      if (locationsPromise) return locationsPromise;
      return Promise.resolve(locations);
    }
    if (url === '/api/wellness/resources' && method === 'POST') {
      return Promise.resolve({ id: 999, ...JSON.parse(opts.body) });
    }
    if (/^\/api\/wellness\/resources\/\d+$/.test(url) && method === 'PUT') {
      return Promise.resolve({ ok: true });
    }
    if (/^\/api\/wellness\/resources\/\d+$/.test(url) && method === 'DELETE') {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

let confirmSpy;
beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  // Re-install notify.confirm impl (vitest.setup's restoreAllMocks wipes
  // vi.fn() implementations between tests).
  notifyConfirm.mockReset();
  notifyConfirm.mockImplementation(() => Promise.resolve(true));
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

describe('<Resources /> — page chrome', () => {
  it('renders heading "Resources" + "New resource" CTA + count sub-copy', async () => {
    installFetchMock();
    render(<Resources />);
    expect(
      screen.getByRole('heading', { name: /Resources/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /New resource/i }),
    ).toBeInTheDocument();
    // Sub-copy: "Bookable rooms, machines, and equipment (N) — …".
    await waitFor(() => {
      expect(
        screen.getAllByText((_t, el) =>
          /Bookable rooms, machines, and equipment.*calendar guards against same-hour double-booking/i.test(
            el?.textContent || '',
          ),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders "Loading…" while the initial parallel GETs are in flight', async () => {
    // Block both fetches indefinitely to pin the loading branch.
    installFetchMock({
      resourcesPromise: new Promise(() => {}),
      locationsPromise: new Promise(() => {}),
    });
    render(<Resources />);
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<Resources /> — mount fetch + list render', () => {
  it('fires two parallel GETs on mount: /api/wellness/resources + /api/wellness/locations', async () => {
    installFetchMock();
    render(<Resources />);
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toContain('/api/wellness/resources');
      expect(urls).toContain('/api/wellness/locations');
    });
  });

  it('renders empty-state when GET resolves to []', async () => {
    installFetchMock({ resources: [] });
    render(<Resources />);
    expect(
      await screen.findByText(
        /No resources yet\. Add a treatment room or machine/i,
      ),
    ).toBeInTheDocument();
  });

  it('renders rows with name + type + resolved location + active status; tenant-wide row labelled', async () => {
    installFetchMock();
    render(<Resources />);
    // Laser Room 1 row — name + type + Bandra Clinic + "Yes".
    expect(await screen.findByText(/^Laser Room 1$/)).toBeInTheDocument();
    expect(screen.getByText(/^Mobile Q-Switch Laser$/)).toBeInTheDocument();
    expect(screen.getByText(/^Vintage Derma-Roller$/)).toBeInTheDocument();
    // Type cells.
    expect(screen.getByText(/^ROOM$/)).toBeInTheDocument();
    expect(screen.getByText(/^MACHINE$/)).toBeInTheDocument();
    expect(screen.getByText(/^EQUIPMENT$/)).toBeInTheDocument();
    // Resolved location cells: Bandra (Laser Room 1), Andheri (Derma-Roller).
    const laserRow = screen.getByText(/^Laser Room 1$/).closest('tr');
    expect(within(laserRow).getByText(/Bandra Clinic/)).toBeInTheDocument();
    expect(within(laserRow).getByText(/^Yes$/)).toBeInTheDocument();
    // Tenant-wide row: Mobile Q-Switch Laser has locationId null → "tenant-wide".
    const mobileRow = screen.getByText(/^Mobile Q-Switch Laser$/).closest('tr');
    expect(within(mobileRow).getByText(/tenant-wide/i)).toBeInTheDocument();
    // Inactive row.
    const dermaRow = screen.getByText(/^Vintage Derma-Roller$/).closest('tr');
    expect(within(dermaRow).getByText(/^No$/)).toBeInTheDocument();
    expect(within(dermaRow).getByText(/Andheri Clinic/)).toBeInTheDocument();
  });
});

describe('<Resources /> — New-resource form toggle', () => {
  it('"New resource" opens the form (placeholders + selects + active checkbox); CTA label flips to "Cancel"', async () => {
    installFetchMock();
    render(<Resources />);
    await waitFor(() => {
      expect(screen.getByText(/^Laser Room 1$/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New resource/i }));
    // Name input visible.
    expect(
      screen.getByPlaceholderText(/Name — e\.g\. Laser Room 1/),
    ).toBeInTheDocument();
    // Two <select>s: type + location.
    const selects = document.querySelectorAll('form select');
    expect(selects.length).toBe(2);
    // Type select: ROOM / MACHINE / EQUIPMENT options.
    const typeOptions = Array.from(selects[0].options).map((o) => o.value);
    expect(typeOptions).toEqual(['ROOM', 'MACHINE', 'EQUIPMENT']);
    // Active checkbox label.
    expect(
      screen.getByLabelText(/Active \(bookable in calendar\)/i),
    ).toBeInTheDocument();
    // CTA flipped — find a button whose text contains "Cancel" in the header.
    // (Form also has a "Cancel" button inside.) getAllByText to handle both.
    const cancelMatches = screen.getAllByText(/Cancel/);
    expect(cancelMatches.length).toBeGreaterThanOrEqual(1);
    // Click the header CTA (the first button with Cancel in name).
    const headerCancel = screen.getAllByRole('button', { name: /Cancel/ })[0];
    fireEvent.click(headerCancel);
    expect(
      screen.queryByPlaceholderText(/Name — e\.g\. Laser Room 1/),
    ).toBeNull();
  });

  it('Name input carries the `required` attribute (browser-native blank-blocking)', async () => {
    installFetchMock();
    render(<Resources />);
    await waitFor(() => {
      expect(screen.getByText(/^Laser Room 1$/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New resource/i }));
    expect(
      screen.getByPlaceholderText(/Name — e\.g\. Laser Room 1/),
    ).toBeRequired();
  });
});

describe('<Resources /> — create POST', () => {
  it('Create → POST /api/wellness/resources with body shape {name, type, locationId:int, isActive} + notify.success + refetch', async () => {
    installFetchMock();
    render(<Resources />);
    await waitFor(() => {
      expect(screen.getByText(/^Laser Room 1$/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New resource/i }));
    fireEvent.change(
      screen.getByPlaceholderText(/Name — e\.g\. Laser Room 1/),
      { target: { value: 'HydraFacial Pod' } },
    );
    const selects = document.querySelectorAll('form select');
    // Type → MACHINE.
    fireEvent.change(selects[0], { target: { value: 'MACHINE' } });
    // Location → Bandra Clinic (id 11).
    fireEvent.change(selects[1], { target: { value: '11' } });
    // Submit.
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/resources' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toEqual({
        name: 'HydraFacial Pod',
        type: 'MACHINE',
        locationId: 11,
        isActive: true,
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Created.*HydraFacial Pod/i),
    );
    // Refetch: at least 2 GETs to /api/wellness/resources total (mount + after-create).
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        u === '/api/wellness/resources' && (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('<Resources /> — edit prefill + PUT', () => {
  it('Edit (Pencil) opens the form pre-filled and Save → PUT /api/wellness/resources/:id + notify.success', async () => {
    installFetchMock();
    render(<Resources />);
    await waitFor(() => {
      expect(screen.getByText(/^Laser Room 1$/)).toBeInTheDocument();
    });
    // Edit buttons use aria-label="Edit"; pick the first (Laser Room 1 row).
    const editButtons = screen.getAllByRole('button', { name: /^Edit$/ });
    expect(editButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(editButtons[0]); // Laser Room 1.
    // Pre-fill: name + type + locationId.
    const nameInput = screen.getByPlaceholderText(/Name — e\.g\. Laser Room 1/);
    expect(nameInput.value).toBe('Laser Room 1');
    const selects = document.querySelectorAll('form select');
    expect(selects[0].value).toBe('ROOM');
    expect(selects[1].value).toBe('11');
    // Active checkbox should be checked.
    const activeCheckbox = screen.getByLabelText(
      /Active \(bookable in calendar\)/i,
    );
    expect(activeCheckbox).toBeChecked();
    // Tweak name + Submit.
    fireEvent.change(nameInput, {
      target: { value: 'Laser Room 1 (refurbished)' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Update$/ }));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/resources/301' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('Laser Room 1 (refurbished)');
      expect(body.type).toBe('ROOM');
      expect(body.locationId).toBe(11);
      expect(body.isActive).toBe(true);
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Updated.*Laser Room 1 \(refurbished\)/i),
    );
  });
});

describe('<Resources /> — delete flow', () => {
  it('notify.confirm true → DELETE /api/wellness/resources/:id + notify.success + refetch', async () => {
    installFetchMock();
    render(<Resources />);
    const laserRow = (await screen.findByText(/^Laser Room 1$/)).closest('tr');
    const delBtn = within(laserRow).getByRole('button', { name: /^Delete$/ });
    notifyConfirm.mockImplementationOnce(() => Promise.resolve(true));
    fireEvent.click(delBtn);
    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/resources/301' && opts?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Deleted.*Laser Room 1/i),
    );
  });

  it('notify.confirm false → no DELETE fires', async () => {
    installFetchMock();
    render(<Resources />);
    const laserRow = (await screen.findByText(/^Laser Room 1$/)).closest('tr');
    const delBtn = within(laserRow).getByRole('button', { name: /^Delete$/ });
    notifyConfirm.mockImplementationOnce(() => Promise.resolve(false));
    fireEvent.click(delBtn);
    // Drain microtasks.
    await Promise.resolve();
    await Promise.resolve();
    const deleteCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'DELETE',
    );
    expect(deleteCall).toBeUndefined();
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});

describe('<Resources /> — location picker options', () => {
  it('form location <select> includes a "tenant-wide" option + one option per location from GET', async () => {
    installFetchMock();
    render(<Resources />);
    await waitFor(() => {
      expect(screen.getByText(/^Laser Room 1$/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New resource/i }));
    const selects = document.querySelectorAll('form select');
    const locationSelect = selects[1];
    const optionTexts = Array.from(locationSelect.options).map((o) =>
      o.textContent,
    );
    // Tenant-wide option.
    expect(optionTexts.some((t) => /tenant-wide/i.test(t))).toBe(true);
    // Each location appears.
    expect(optionTexts).toContain('Bandra Clinic');
    expect(optionTexts).toContain('Andheri Clinic');
    // Option values are the stringified IDs.
    const optionValues = Array.from(locationSelect.options).map((o) => o.value);
    expect(optionValues).toContain('11');
    expect(optionValues).toContain('12');
    expect(optionValues).toContain(''); // tenant-wide = empty string value.
  });
});
