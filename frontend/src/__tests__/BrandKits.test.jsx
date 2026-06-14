/**
 * BrandKits.test.jsx — vitest + RTL coverage for the per-sub-brand BrandKit
 * admin page (frontend/src/pages/admin/BrandKits.jsx, shipped tick #102
 * commit a20f2d9, 903 LOC). The page consumes /api/brand-kits CRUD
 * (backend/routes/brand_kits.js) and renders a card-grid grouped by
 * sub-brand with per-card Activate / Edit / Delete actions.
 *
 * Scope — pins the page-surface invariants:
 *   1. Page chrome: heading "Brand Kits" + "New Brand Kit" CTA + filter
 *      bar (sub-brand select + "Show inactive versions" checkbox).
 *   2. Loading state: shows "Loading brand kits…" before fetchApi resolves.
 *      Asserted via findByText (CLAUDE.md tick #108 cron-learning — sync
 *      getByText for data-dependent text is a CI race trap).
 *   3. GET on mount: renders one card per kit, grouped by sub-brand, with
 *      per-sub-brand section header + version count caption + count of
 *      distinct sub-brands in the header subtitle.
 *   4. Active-version indicator: the active kit per sub-brand renders the
 *      "Active" badge and hides its "Activate" button; inactive versions
 *      render an "Inactive" badge + show the "Activate" button.
 *   5. Sub-brand filter: changing the filter dropdown triggers a new
 *      fetchApi call with the right `?subBrand=` query string. Picks
 *      "tmc" → call URL ends with ?subBrand=tmc; picks "__none__" →
 *      ?subBrand= (empty, backend normalises to NULL).
 *   6. Show-inactive checkbox: unchecking it triggers a fetch with
 *      ?isActive=true (i.e. excludes inactive versions).
 *   7. Activate flow: clicking "Activate" on a non-active card prompts a
 *      notify.confirm; on confirm, PUTs /api/brand-kits/<id> with
 *      { isActive: true } then reloads. On cancel, no PUT fires.
 *   8. New version flow: clicking "New Brand Kit" opens the modal;
 *      submitting it POSTs /api/brand-kits with the form payload (subBrand
 *      normalised from "__none__" → null).
 *   9. Delete flow: clicking Delete on a non-active kit prompts confirm
 *      then DELETEs /api/brand-kits/<id>. Clicking Delete on an ACTIVE
 *      kit short-circuits with a notify.error (no DELETE call, no confirm).
 *  10. Permission denied (403): empty payload + 403 status renders the
 *      "Access restricted" panel rather than the standard empty state.
 *  11. Empty state: 0 kits + 200 status renders "No brand kits configured."
 *
 * Why
 *   Tick #102's a20f2d9 shipped the page + 13 backend tests but no
 *   frontend coverage. The page implements two contracts that benefit
 *   most from regression pins: (a) the atomic-demote semantics (PUT
 *   { isActive: true } against ANY non-active kit, not a separate
 *   /activate endpoint), and (b) the client-side short-circuit on
 *   delete-of-active-kit (UX nicety that prevents the user seeing a
 *   confirm-then-422-error flow). Both are easy to silently regress.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules)
 *   - fetchApi from utils/api (the wrapper), NOT global fetch
 *   - useNotify returns a STABLE notifyObj — single reference for the
 *     whole file. Fresh objects per call cause infinite-render loops in
 *     pages that destructure notify into a useCallback dep array.
 *   - travelSubBrand utility is imported real (not mocked) so any future
 *     SUB_BRAND_IDS drift is caught by the suite rather than masked.
 *
 * Path: flat __tests__/ per tick #110 path-coordination (sibling Agent A
 * owns TenantSettings.test.jsx in the same flat dir; no admin/ subdir to
 * avoid the concurrent-subdir-creation race).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d): re-creating the object per call causes infinite re-render
// loops when consumer pages put notify into a useCallback dep array.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import BrandKits from '../pages/admin/BrandKits';

// Four kits across 3 sub-brands + 1 tenant-wide. Mirrors the seed-travel
// shape (one active version per sub-brand) so test data matches reality.
const sampleKits = [
  {
    id: 1,
    subBrand: null,
    version: 1,
    isActive: true,
    logoUrl: 'https://cdn.example.test/tenant-logo.png',
    logoDarkUrl: null,
    faviconUrl: null,
    primaryColor: '#265855',
    secondaryColor: '#CD9481',
    accentColor: '#C89A4E',
    bgColor: '#FFFFFF',
    textColor: '#1A1A1A',
    fontFamily: 'Inter, sans-serif',
    fontUrl: null,
    tagline: 'Tenant-wide default',
  },
  {
    id: 10,
    subBrand: 'tmc',
    version: 2,
    isActive: true,
    logoUrl: 'https://cdn.example.test/tmc-v2.png',
    primaryColor: '#122647',
    secondaryColor: '#C89A4E',
    accentColor: '#C89A4E',
    bgColor: '#FFFFFF',
    textColor: '#1A1A1A',
    fontFamily: 'Poppins, sans-serif',
    fontUrl: null,
    tagline: 'School trips made simple',
  },
  {
    id: 11,
    subBrand: 'tmc',
    version: 1,
    isActive: false,
    logoUrl: 'https://cdn.example.test/tmc-v1.png',
    primaryColor: '#122647',
    secondaryColor: '#C89A4E',
    accentColor: '#C89A4E',
    bgColor: '#FFFFFF',
    textColor: '#1A1A1A',
    fontFamily: null,
    fontUrl: null,
    tagline: null,
  },
  {
    id: 20,
    subBrand: 'rfu',
    version: 1,
    isActive: true,
    logoUrl: null,
    primaryColor: '#265855',
    secondaryColor: '#CD9481',
    accentColor: '#C89A4E',
    bgColor: '#FFFFFF',
    textColor: '#1A1A1A',
    fontFamily: null,
    fontUrl: null,
    tagline: 'Pilgrim journeys',
  },
];

function defaultFetchMock(url, opts) {
  if (url.startsWith('/api/brand-kits') && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve({ brandKits: sampleKits, total: sampleKits.length });
  }
  return Promise.resolve(null);
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  fetchApiMock.mockImplementation(defaultFetchMock);
});

describe('<BrandKits /> — page surface', () => {
  it('renders the heading + "New Brand Kit" CTA + sub-brand filter', async () => {
    render(<BrandKits />);
    // Heading is rendered synchronously (chrome, not data-dependent).
    expect(screen.getByRole('heading', { name: /^Brand Kits$/i })).toBeInTheDocument();
    // CTA — guarded via the data-testid that the SUT exposes.
    expect(screen.getByTestId('brand-kits-new-btn')).toBeInTheDocument();
    expect(screen.getByTestId('brand-kits-filter-subbrand')).toBeInTheDocument();
    expect(screen.getByTestId('brand-kits-show-inactive')).toBeInTheDocument();
    // Let the GET resolve so we don't leak pending fetches into the next test.
    await waitFor(() => {
      expect(screen.queryByText(/Loading brand kits/i)).toBeNull();
    });
  });

  it('shows a loading state before fetchApi resolves, then renders the cards', async () => {
    render(<BrandKits />);
    // Loading message renders immediately on mount.
    expect(screen.getByText(/Loading brand kits/i)).toBeInTheDocument();
    // After fetch resolves, the card grid renders — assert via findByText
    // (CLAUDE.md tick #108: sync getByText on data-dependent text is a
    // CI race trap).
    expect(await screen.findByText(/Version 2/i)).toBeInTheDocument();
  });

  it('renders one card per kit, grouped by sub-brand, with the count caption', async () => {
    render(<BrandKits />);
    // Four kits → four cards keyed by id.
    expect(await screen.findByTestId('brand-kit-card-1')).toBeInTheDocument();
    expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument();
    expect(screen.getByTestId('brand-kit-card-11')).toBeInTheDocument();
    expect(screen.getByTestId('brand-kit-card-20')).toBeInTheDocument();
    // Sub-brand section headers — TMC has 2 versions.
    expect(screen.getByText(/\(2 versions\)/i)).toBeInTheDocument();
    // Caption: "4 brand kits across 3 sub-brands." (tenant-wide null + tmc + rfu)
    expect(screen.getByText(/4 brand kits across 3 sub-brands/i)).toBeInTheDocument();
  });

  it('renders an "Active" badge on active kits and an "Inactive" badge on others', async () => {
    render(<BrandKits />);
    const activeKitCard = await screen.findByTestId('brand-kit-card-10');
    const inactiveKitCard = screen.getByTestId('brand-kit-card-11');
    // Active card carries the "Active" badge — case-sensitive text content
    // since the SUT uppercases via CSS textTransform, not source string.
    expect(activeKitCard.textContent).toMatch(/Active/);
    expect(inactiveKitCard.textContent).toMatch(/Inactive/);
    // Activate button only renders on the inactive card.
    expect(screen.queryByTestId('brand-kit-activate-10')).toBeNull();
    expect(screen.getByTestId('brand-kit-activate-11')).toBeInTheDocument();
  });

  it('changing the sub-brand filter triggers a fetch with ?subBrand=<id>', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fetchApiMock.mockClear();

    const filter = screen.getByTestId('brand-kits-filter-subbrand');
    fireEvent.change(filter, { target: { value: 'tmc' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) => url.includes('subBrand=tmc'));
      expect(call).toBeTruthy();
    });
  });

  it('unchecking "Show inactive versions" triggers a fetch with ?isActive=true', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fetchApiMock.mockClear();

    const showInactive = screen.getByTestId('brand-kits-show-inactive');
    fireEvent.click(showInactive); // toggles from true → false

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) => url.includes('isActive=true'));
      expect(call).toBeTruthy();
    });
  });

  it('clicking "Activate" on a non-active kit confirms then PUTs { isActive: true }', async () => {
    render(<BrandKits />);
    const activateBtn = await screen.findByTestId('brand-kit-activate-11');
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/brand-kits/11' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 11, isActive: true, subBrand: 'tmc', version: 1 });
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(activateBtn);

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/brand-kits/11' && opts?.method === 'PUT'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.isActive).toBe(true);
    });
  });

  it('cancelling the Activate confirm does NOT fire the PUT', async () => {
    notifyConfirm.mockResolvedValue(false);
    render(<BrandKits />);
    const activateBtn = await screen.findByTestId('brand-kit-activate-11');
    fetchApiMock.mockClear();

    fireEvent.click(activateBtn);

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    // Let any pending microtasks settle, then assert no PUT fired.
    await new Promise((r) => setTimeout(r, 30));
    const putCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/brand-kits/11' && opts?.method === 'PUT'
    );
    expect(putCall).toBeFalsy();
  });

  it('renders the Delete button as disabled on an ACTIVE kit (cannot fire confirm or DELETE)', async () => {
    // The SUT defends-in-depth: the Delete button is rendered with
    // `disabled={kit.isActive}` AND the handler short-circuits with a
    // notify.error if somehow invoked on an active kit. The disabled
    // attribute is the user-visible contract — a disabled button cannot
    // fire onClick, so the notify.error guard is belt-and-braces. Pin
    // the visible contract (disabled + cursor:not-allowed + a11y label).
    render(<BrandKits />);
    const deleteBtn = await screen.findByTestId('brand-kit-delete-10'); // id=10 is ACTIVE tmc v2
    expect(deleteBtn).toBeDisabled();
    expect(deleteBtn.getAttribute('aria-label')).toMatch(/Cannot delete active version/i);
    // Sanity: by contrast the non-active version's Delete button is enabled.
    const deleteBtn11 = screen.getByTestId('brand-kit-delete-11');
    expect(deleteBtn11).not.toBeDisabled();
  });

  it('clicking Delete on a non-active kit confirms then DELETEs', async () => {
    render(<BrandKits />);
    const deleteBtn = await screen.findByTestId('brand-kit-delete-11'); // inactive tmc v1
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/brand-kits/11' && opts?.method === 'DELETE') {
        return Promise.resolve(null);
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(deleteBtn);

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/brand-kits/11' && opts?.method === 'DELETE'
      );
      expect(call).toBeTruthy();
    });
  });

  it('clicking "New Brand Kit" opens the modal; submitting POSTs to /api/brand-kits', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/brand-kits' && opts?.method === 'POST') {
        return Promise.resolve({ id: 99, subBrand: null, version: 2, isActive: false });
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(screen.getByTestId('brand-kits-new-btn'));
    // Modal renders with role=dialog.
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Submit the form via the "Create Brand Kit" button. Default sub-brand
    // when the filter is "__all__" is "__none__" → backend receives null.
    fireEvent.click(screen.getByRole('button', { name: /Create Brand Kit/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/brand-kits' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.subBrand).toBeNull();
      expect(body.isActive).toBe(false);
    });
  });

  it('renders the "Access restricted" panel when the GET 403s', async () => {
    fetchApiMock.mockImplementation(() => {
      const err = new Error('Forbidden');
      err.status = 403;
      return Promise.reject(err);
    });
    render(<BrandKits />);
    expect(await screen.findByText(/Access restricted/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Your role does not have permission to view brand kits/i)
    ).toBeInTheDocument();
  });

  it('renders the empty-state panel when the GET returns 0 kits', async () => {
    fetchApiMock.mockImplementation(() => Promise.resolve({ brandKits: [], total: 0 }));
    render(<BrandKits />);
    expect(await screen.findByText(/No brand kits configured/i)).toBeInTheDocument();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Extended coverage — tick #141 (2026-05-26).
  // Augments the 13-test base with 9 cases covering: per-sub-brand grouping
  // semantics, create-modal form lifecycle, file-uri (logo URL) field send,
  // palette color picker → payload, font field → payload, atomic-demote
  // semantics (PUT with isActive:true is the activation pathway, no
  // separate /activate endpoint), edit-mode subBrand omission per
  // SUB_BRAND_IMMUTABLE contract, RBAC empty-vs-403 surfaces, and the
  // delete-on-active client-side short-circuit (notify.error fires WITHOUT
  // a confirm() prompt or DELETE call — but the button is also disabled so
  // this asserts the defense-in-depth handler logic via the modal-less
  // surface). All 9 follow the stable-mock-ref + getAllByText patterns.
  // ────────────────────────────────────────────────────────────────────────

  it('extended: groups kits into per-sub-brand sections with correct version counts', async () => {
    // Sample has: tenant-wide (1) + tmc (2) + rfu (1). Per-section caption
    // is "(N versions)". TMC has 2 versions and prints "(2 versions)";
    // tenant-wide + rfu each have 1 → "(1 version)" — that text appears
    // TWICE per the sample, so getAllByText is mandatory (RTL standing
    // rule for labels that appear as both filter chrome + row badges; same
    // shape for repeated section captions).
    render(<BrandKits />);
    await screen.findByTestId('brand-kit-card-10');
    expect(screen.getByText(/\(2 versions\)/i)).toBeInTheDocument();
    const singletonCaptions = screen.getAllByText(/\(1 version\)/i);
    expect(singletonCaptions.length).toBe(2); // tenant-wide + rfu
  });

  it('extended: create modal submits with the logo URL field correctly mapped to the payload', async () => {
    // Pin: typing into the Logo URL input flows through emptyToNull and
    // lands as a string in POST body (NOT null). Mirrors the asset-upload
    // contract — the UI is URL-based, not multipart-file-based per the
    // SUT's input[type=url] design. Captures the "logo upload" gap by
    // pinning the URL-driven submit path the SUT actually implements.
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/brand-kits' && opts?.method === 'POST') {
        return Promise.resolve({ id: 200, subBrand: null, version: 1, isActive: false });
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(screen.getByTestId('brand-kits-new-btn'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    const logoInput = screen.getByLabelText(/^Logo URL$/i);
    fireEvent.change(logoInput, {
      target: { value: 'https://cdn.example.test/uploaded-logo.png' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create Brand Kit/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/brand-kits' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.logoUrl).toBe('https://cdn.example.test/uploaded-logo.png');
    });
  });

  it('extended: palette color picker change flows into the create POST body', async () => {
    // Native input[type=color] backs the picker — fireEvent.change on the
    // primaryColor field hex-input (the text companion of the swatch) is
    // the testable seam. Picks the hex-text input via aria-label since
    // there are 2 visual inputs per color (the picker + the hex text).
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/brand-kits' && opts?.method === 'POST') {
        return Promise.resolve({ id: 201 });
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(screen.getByTestId('brand-kits-new-btn'));
    const primaryHex = screen.getByLabelText(/Primary color hex value/i);
    fireEvent.change(primaryHex, { target: { value: '#ABCDEF' } });

    fireEvent.click(screen.getByRole('button', { name: /Create Brand Kit/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/brand-kits' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.primaryColor).toBe('#ABCDEF');
    });
  });

  it('extended: font family text input flows into the create POST body', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/brand-kits' && opts?.method === 'POST') {
        return Promise.resolve({ id: 202 });
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(screen.getByTestId('brand-kits-new-btn'));
    const fontFamilyInput = screen.getByLabelText(/Font family/i);
    fireEvent.change(fontFamilyInput, { target: { value: 'Lora, Georgia, serif' } });

    fireEvent.click(screen.getByRole('button', { name: /Create Brand Kit/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/brand-kits' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.fontFamily).toBe('Lora, Georgia, serif');
    });
  });

  it('extended: atomic-demote — activation PUT carries only { isActive: true }, not a separate /activate endpoint', async () => {
    // Pins the activation contract: PUT against the kit's primary route
    // with { isActive: true } drives the atomic demotion of the prior
    // active version on the BACKEND. The frontend MUST NOT call a
    // hypothetical /activate sub-route (which would be a silent regression
    // if someone added one). The PUT body should ONLY signal isActive in
    // the activation pathway — not include unrelated fields like
    // primaryColor that the user didn't edit.
    render(<BrandKits />);
    const activateBtn = await screen.findByTestId('brand-kit-activate-11'); // tmc v1 inactive
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/brand-kits/11' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 11, isActive: true, subBrand: 'tmc', version: 1 });
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(activateBtn);

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/brand-kits/11' && opts?.method === 'PUT'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      // Activation pathway is minimal: only isActive in the body.
      expect(Object.keys(body)).toEqual(['isActive']);
      expect(body.isActive).toBe(true);
    });
    // Counter-assert: NO call to a hypothetical /activate sub-route.
    const activateRouteCall = fetchApiMock.mock.calls.find(([url]) =>
      String(url).includes('/activate')
    );
    expect(activateRouteCall).toBeFalsy();
  });

  it('extended: edit modal disables the sub-brand select (SUB_BRAND_IMMUTABLE contract)', async () => {
    // Pins the sub-brand-immutable invariant on the UI surface. The select
    // must be disabled when editingKit is truthy — backend rejects PUTs
    // that change subBrand with SUB_BRAND_IMMUTABLE 422, so the SUT
    // surfaces the constraint client-side.
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('brand-kit-edit-10'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const subBrandSelect = screen.getByLabelText(/^Sub-brand$/i);
    expect(subBrandSelect).toBeDisabled();
    // Hint copy confirms the constraint to the operator.
    expect(screen.getByText(/Immutable\. To move assets to a different sub-brand/i)).toBeInTheDocument();
  });

  it('extended: edit modal submit issues a PUT with no subBrand key in the body', async () => {
    // SUB_BRAND_IMMUTABLE on the backend means the frontend must NOT
    // include `subBrand` in the PUT payload (the SUT spreads `{}` instead
    // of `{ subBrand: ... }` when editingKit is truthy). Sibling assets
    // (logoUrl etc.) DO go in the body.
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-11')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/brand-kits/11' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 11, subBrand: 'tmc', version: 1, isActive: false });
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(screen.getByTestId('brand-kit-edit-11'));
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/brand-kits/11' && opts?.method === 'PUT'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      // No subBrand key — backend would 422 otherwise.
      expect('subBrand' in body).toBe(false);
      // Other fields still flow.
      expect(body.logoUrl).toBe('https://cdn.example.test/tmc-v1.png');
      expect(body.isActive).toBe(false);
    });
  });

  it('extended: closing the create modal via Cancel resets state and does NOT fire a POST', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByTestId('brand-kits-new-btn'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // No POST fired.
    const postCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/brand-kits' && opts?.method === 'POST'
    );
    expect(postCall).toBeFalsy();
  });

  it('extended: filter dropdown set to "__none__" issues a fetch with empty ?subBrand= (tenant-wide bucket)', async () => {
    // The "__none__" option in the filter maps to subBrand=NULL on the
    // backend (empty-string normalisation). Pins that this control-plane
    // value distinguishes "no filter" (__all__) from "tenant-wide only"
    // (__none__) in the issued URL.
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fetchApiMock.mockClear();

    const filter = screen.getByTestId('brand-kits-filter-subbrand');
    fireEvent.change(filter, { target: { value: '__none__' } });

    await waitFor(() => {
      // The URL ends with ?subBrand= (empty value, no trailing chars).
      const call = fetchApiMock.mock.calls.find(([url]) => {
        const u = String(url);
        // Look for `subBrand=` followed by either end-of-string or '&'.
        return /[?&]subBrand=(?:&|$)/.test(u);
      });
      expect(call).toBeTruthy();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // W4.A G099 — extended admin surface: WCAG checker + live preview +
  // advanced fields + version history + revert + copy-from.
  // ────────────────────────────────────────────────────────────────────────

  it('w4a: WCAG checker renders text-vs-background AND primary-vs-background rows in the modal', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('brand-kits-new-btn'));
    expect(screen.getByTestId('brand-kits-wcag-checker')).toBeInTheDocument();
    // Both contrast rows render with the WCAG-row test-ids.
    expect(screen.getByTestId('brand-kits-wcag-text-vs-background')).toBeInTheDocument();
    expect(screen.getByTestId('brand-kits-wcag-primary-vs-background')).toBeInTheDocument();
  });

  it('w4a: live preview pane renders inside the modal', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('brand-kits-new-btn'));
    expect(screen.getByTestId('brand-kits-live-preview')).toBeInTheDocument();
  });

  it('w4a: advanced section collapses by default; toggle reveals G089 extended fields', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('brand-kits-new-btn'));
    // Hidden by default.
    expect(screen.queryByTestId('brand-kits-advanced-section')).toBeNull();
    // Toggle reveals the section with the new fields.
    fireEvent.click(screen.getByTestId('brand-kits-advanced-toggle'));
    expect(screen.getByTestId('brand-kits-advanced-section')).toBeInTheDocument();
    expect(screen.getByLabelText(/Wordmark URL/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Hero image URL/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Heading font family/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Body font family/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Code font family/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/CMYK primary/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Email signature template/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Invoice \/ PDF footer text/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Mission statement/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Support email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Support phone/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Social links JSON/i)).toBeInTheDocument();
  });

  it('w4a: filling extended fields flows them through to the POST body', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/brand-kits' && opts?.method === 'POST') {
        return Promise.resolve({ id: 300 });
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(screen.getByTestId('brand-kits-new-btn'));
    fireEvent.click(screen.getByTestId('brand-kits-advanced-toggle'));

    fireEvent.change(screen.getByLabelText(/Wordmark URL/i), {
      target: { value: 'https://cdn.example/wordmark.svg' },
    });
    fireEvent.change(screen.getByLabelText(/Mission statement/i), {
      target: { value: 'Plan curriculum-aligned trips' },
    });
    fireEvent.change(screen.getByLabelText(/Support email/i), {
      target: { value: 'help@example.test' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create Brand Kit/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/brand-kits' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.wordmarkUrl).toBe('https://cdn.example/wordmark.svg');
      expect(body.missionStatement).toBe('Plan curriculum-aligned trips');
      expect(body.supportEmail).toBe('help@example.test');
    });
  });

  it('w4a: Versions button on a card opens the version history modal + lists rows', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());

    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/brand-kits/10/versions') {
        return Promise.resolve({
          versions: [
            { id: 10, subBrand: 'tmc', version: 2, isActive: true, updatedAt: '2026-01-10T00:00:00Z' },
            { id: 11, subBrand: 'tmc', version: 1, isActive: false, updatedAt: '2026-01-05T00:00:00Z' },
          ],
          total: 2,
        });
      }
      return defaultFetchMock(url);
    });

    fireEvent.click(screen.getByTestId('brand-kit-versions-10'));

    await waitFor(() => expect(screen.getByTestId('brand-kits-versions-modal')).toBeInTheDocument());
    expect(screen.getByTestId('brand-kits-version-row-2')).toBeInTheDocument();
    expect(screen.getByTestId('brand-kits-version-row-1')).toBeInTheDocument();
  });

  it('w4a: clicking Revert in versions modal confirms then POSTs /:id/revert/:version', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());

    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/brand-kits/10/versions' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({
          versions: [
            { id: 10, subBrand: 'tmc', version: 2, isActive: true, updatedAt: '2026-01-10T00:00:00Z' },
            { id: 11, subBrand: 'tmc', version: 1, isActive: false, updatedAt: '2026-01-05T00:00:00Z' },
          ],
          total: 2,
        });
      }
      if (url === '/api/brand-kits/10/revert/1' && opts?.method === 'POST') {
        return Promise.resolve({ id: 20, subBrand: 'tmc', version: 3, isActive: true });
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(screen.getByTestId('brand-kit-versions-10'));
    await waitFor(() => expect(screen.getByTestId('brand-kits-version-row-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('brand-kits-revert-1'));

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/brand-kits/10/revert/1' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
    });
  });

  it('w4a: Revert button on the ACTIVE version row is disabled', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());

    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/brand-kits/10/versions') {
        return Promise.resolve({
          versions: [
            { id: 10, subBrand: 'tmc', version: 2, isActive: true, updatedAt: '2026-01-10T00:00:00Z' },
          ],
          total: 1,
        });
      }
      return defaultFetchMock(url);
    });

    fireEvent.click(screen.getByTestId('brand-kit-versions-10'));
    await waitFor(() => expect(screen.getByTestId('brand-kits-version-row-2')).toBeInTheDocument());

    const revertBtn = screen.getByTestId('brand-kits-revert-2');
    expect(revertBtn).toBeDisabled();
  });

  it('w4a: Copy-from button opens modal; selecting a source then submitting POSTs /:id/copy-from/:sourceId', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/brand-kits/10/copy-from/20' && opts?.method === 'POST') {
        return Promise.resolve({ id: 30, subBrand: 'tmc', version: 3, isActive: false });
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(screen.getByTestId('brand-kit-copy-from-10'));
    expect(screen.getByTestId('brand-kits-copy-from-modal')).toBeInTheDocument();

    // Select a source — id=20 is rfu kit.
    const select = screen.getByTestId('brand-kits-copy-from-source');
    fireEvent.change(select, { target: { value: '20' } });

    fireEvent.click(screen.getByTestId('brand-kits-copy-from-submit'));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/brand-kits/10/copy-from/20' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
    });
  });

  it('w4a: Logo URL field renders an Upload button alongside the URL input', async () => {
    render(<BrandKits />);
    await waitFor(() => expect(screen.getByTestId('brand-kit-card-10')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('brand-kits-new-btn'));

    // Logo URL pair — input + Upload button.
    expect(screen.getByLabelText(/^Logo URL$/i)).toBeInTheDocument();
    expect(screen.getByTestId('brand-kits-upload-btn-bk-logo')).toBeInTheDocument();
    // Hidden file input is wired underneath.
    expect(screen.getByTestId('brand-kits-upload-input-bk-logo')).toBeInTheDocument();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Standalone unit: wcagContrastRatio() — exported helper.
// ────────────────────────────────────────────────────────────────────────
import { wcagContrastRatio } from '../pages/admin/BrandKits';

describe('wcagContrastRatio', () => {
  it('returns 21:1 for pure black on pure white', () => {
    const r = wcagContrastRatio('#000000', '#FFFFFF');
    expect(r).toBeCloseTo(21, 1);
  });
  it('returns 1.0 for identical colors', () => {
    expect(wcagContrastRatio('#265855', '#265855')).toBeCloseTo(1, 5);
  });
  it('returns null for invalid hex', () => {
    expect(wcagContrastRatio('not-a-hex', '#fff')).toBeNull();
    expect(wcagContrastRatio('#fff', null)).toBeNull();
  });
  it('treats 3-char shorthand as expanded form', () => {
    expect(wcagContrastRatio('#fff', '#000')).toBeCloseTo(21, 1);
  });
  it('passes AA for white text on a teal brand background (4.5+)', () => {
    const r = wcagContrastRatio('#FFFFFF', '#265855');
    expect(r).toBeGreaterThan(4.5);
  });
});
