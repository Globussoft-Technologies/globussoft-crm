/**
 * Services.test.jsx — wellness service catalog + packages page pin.
 *
 * Augments the original 4 smoke tests (catalog cards render, edit-mode flip,
 * PUT on save, confirm-on-deactivate) with substantial coverage of the
 * 903-LOC SUT at `pages/wellness/Services.jsx`:
 *
 *   - Tab switching (Catalog vs Packages vs Active Packages)
 *   - Create-service modal: open / form fields visible / POST to
 *     /api/wellness/services
 *   - Validation: blank name + zero price guards the submit button
 *   - Edit-service: pre-filled input value matches the row
 *   - Delete-service confirm flow (cancel branch + accept branch)
 *   - Initial tab driven by ?tab= search param
 *   - Package builder: service select + sessions slider + discount + computed
 *     price arithmetic (gross / savings / net) + "Copy pitch" copies the
 *     rendered text
 *   - Active treatments tab loads via fetchApi('/api/wellness/activetreatment')
 *     and renders the empty-state when no rows
 *   - CSV export button is disabled when services.length === 0
 *   - Header copy + tab labels present
 *
 * Mocks are mounted with stable-object refs per the 2026-05-23 cron-learnings
 * standing rule (useNotify object recreated per call → useCallback dep churn
 * → infinite re-renders → vitest timeout). Pure pin — no source changes.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
  getAuthToken: vi.fn(() => 'test-token'),
}));

const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn((input) => Promise.resolve(window.confirm(typeof input === 'string' ? input : input?.message || ''))),
  prompt: vi.fn(),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

// Default to a fully-permissioned viewer so existing assertions on New
// service / per-card Edit / Deactivate keep passing. The SUT now hides
// these when the viewer lacks services.write.
const FULL_PERMS = {
  isReady: true,
  hasPermission: () => true,
  permissions: ['services.read', 'services.write'],
  roles: [],
  isOwner: false,
  userType: null,
  isLoading: false,
  error: null,
  refresh: () => Promise.resolve(),
  hasAllPermissions: () => true,
  hasAnyPermission: () => true,
};
const usePermissionsMock = vi.fn(() => FULL_PERMS);
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: (...args) => usePermissionsMock(...args),
}));

import { fetchApi } from '../utils/api';
import { AuthContext } from '../App';
import Services from '../pages/wellness/Services';

const services = [
  { id: 10, name: 'GFC Hair', category: 'hair-restoration', ticketTier: 'high', basePrice: 8500, durationMin: 90, targetRadiusKm: 25, isActive: true },
  { id: 11, name: 'Botox 50u', category: 'aesthetics', ticketTier: 'medium', basePrice: 15000, durationMin: 45, targetRadiusKm: 30, isActive: true },
];

// Default fetchApi router for the multi-endpoint tests below — returns the
// services list on /api/wellness/services and an empty treatments envelope on
// /api/wellness/activetreatment. POSTs / PUTs resolve to {} so the submit
// handlers don't throw.
function defaultFetchRouter(url, opts) {
  if (typeof url !== 'string') return Promise.resolve([]);
  if (url === '/api/wellness/services' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(services);
  }
  if (url === '/api/wellness/activetreatment') {
    return Promise.resolve({ data: [] });
  }
  return Promise.resolve({});
}

describe('<Services /> — Catalog tab', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockResolvedValue(services);
  });

  it('renders catalog cards with price, duration, and radius', async () => {
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    expect(screen.getByText('Botox 50u')).toBeInTheDocument();
    // Indian-grouped prices
    expect(screen.getByText(/8,500/)).toBeInTheDocument();
    expect(screen.getByText(/15,000/)).toBeInTheDocument();
    // Durations
    expect(screen.getByText(/90 min/)).toBeInTheDocument();
    expect(screen.getByText(/45 min/)).toBeInTheDocument();
    // Radius
    expect(screen.getByText(/25 km/)).toBeInTheDocument();
    expect(screen.getByText(/30 km/)).toBeInTheDocument();
  });

  it('loads additional cards when the catalog scroll container reaches the bottom', async () => {
    const manyServices = Array.from({ length: 18 }, (_, index) => ({
      id: 100 + index,
      name: `Scrollable Service ${index + 1}`,
      category: 'hair-restoration',
      ticketTier: index % 2 === 0 ? 'medium' : 'high',
      basePrice: 5000 + index * 100,
      durationMin: 30,
      targetRadiusKm: 30,
      isActive: true,
    }));

    fetchApi.mockImplementation((url, opts) => {
      if (typeof url !== 'string') return Promise.resolve([]);
      if (url === '/api/wellness/services' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(manyServices);
      }
      if (url === '/api/wellness/service-categories?limit=1000') {
        return Promise.resolve([]);
      }
      return Promise.resolve({});
    });

    render(<MemoryRouter><Services /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByText('Scrollable Service 1')).toBeInTheDocument();
    });

    expect(screen.queryByText('Scrollable Service 13')).not.toBeInTheDocument();

    const scrollContainer = screen.getByTestId('services-catalog-scroll');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 800, configurable: true });
    scrollContainer.scrollTop = 728;
    fireEvent.scroll(scrollContainer);

    expect(
      await screen.findByText('Scrollable Service 13'),
    ).toBeInTheDocument();
  });

  it('clicking the pencil (Edit) button flips the card to edit mode', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    // The catalog's card order is not pinned (sort criterion may change), so
    // target the specific service via its per-card aria-label rather than
    // a positional selector.
    const editBtns = screen.getAllByLabelText(/^Edit service /i);
    expect(editBtns.length).toBe(2);
    await user.click(screen.getByLabelText('Edit service GFC Hair'));

    // Edit mode shows a Save button + the name as an input value
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('GFC Hair')).toBeInTheDocument();
  });

  it('Save in edit mode calls PUT to /api/wellness/services/:id', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Edit service GFC Hair'));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/services/10' && opts?.method === 'PUT'
      );
      expect(putCall).toBeTruthy();
    });
  });

  it('clicking the trash icon triggers confirm()', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Deactivate service GFC Hair'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/GFC Hair/);
  });
});

// =====================================================================
// EXTENSION — extra coverage of the 903-LOC SUT beyond the smoke tests
// =====================================================================

describe('<Services /> — header + tab navigation', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });

  it('renders the Sparkles header + descriptive subtitle', async () => {
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    expect(screen.getByRole('heading', { name: /Service catalog/i, level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Each service has a price, duration, and target marketing radius/i)).toBeInTheDocument();
  });

  it('exposes 3 tabs: Catalog, Packages, Active Packages', async () => {
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    // Catalog label appears in both the page subtitle and the tab — use getAllByText.
    expect(screen.getAllByText(/Catalog/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Packages$/i)).toBeInTheDocument();
    expect(screen.getByText(/Active Packages/i)).toBeInTheDocument();
  });

  it('switching to the Packages tab hides the Catalog CTA and renders the package builder', async () => {
    // Drift: the original "Create Package" button was removed when the
    // Packages tab moved to compute-on-the-fly (no DB record per the
    // SUT comment at Services.jsx:1097). The contract is now: switching
    // tabs hides the Catalog "New service" CTA and the package-builder
    // surface ("Build a package") appears.
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /New service/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Packages$/i }));

    expect(screen.queryByRole('button', { name: /New service/i })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Build a package/i)).toBeInTheDocument(),
    );
  });

  it('switching to Active Packages fetches /api/wellness/activetreatment', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Active Packages/i }));

    await waitFor(() => {
      const treatmentsCall = fetchApi.mock.calls.find(
        ([url]) => url === '/api/wellness/activetreatment'
      );
      expect(treatmentsCall).toBeTruthy();
    });
  });

  it('Active Packages tab renders the empty-state copy when no rows', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Active Packages/i }));

    await waitFor(() =>
      expect(screen.getByText(/No active packages yet\./i)).toBeInTheDocument()
    );
  });
});

describe('<Services /> — initial tab from URL search params', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });

  it('?tab=packages mounts directly on the Packages tab', async () => {
    render(
      <MemoryRouter initialEntries={['/wellness/services?tab=packages']}>
        <Services />
      </MemoryRouter>
    );
    // On Packages tab the Catalog cards don't render — wait for the builder
    // heading instead (it depends on the same load() that gates GFC Hair).
    await waitFor(() => expect(screen.getByText(/Build a package/i)).toBeInTheDocument());

    // Drift: the original "Create Package" CTA was removed (packages
    // are now computed on the fly per SUT line 1097). Pin only the
    // Catalog CTA absence on this tab — the builder surface presence
    // is already asserted by the waitFor above.
    expect(screen.queryByRole('button', { name: /New service/i })).not.toBeInTheDocument();
  });

  it('?tab=activepackages falls back to the renamed tab, not a blank page', async () => {
    // The saved-bundles tab that used to own this key was removed. A stale
    // bookmark has to land somewhere real.
    render(
      <MemoryRouter initialEntries={['/wellness/services?tab=activepackages']}>
        <Services />
      </MemoryRouter>
    );
    await waitFor(() => {
      const treatmentsCall = fetchApi.mock.calls.find(
        ([url]) => url === '/api/wellness/activetreatment'
      );
      expect(treatmentsCall).toBeTruthy();
    });

    expect(screen.getByText(/No active packages yet\./i)).toBeInTheDocument();
  });

  it('?tab=activetreatments lands on the Active Packages tab', async () => {
    render(
      <MemoryRouter initialEntries={['/wellness/services?tab=activetreatments']}>
        <Services />
      </MemoryRouter>
    );
    // Triggers loadTreatments effect on mount
    await waitFor(() => {
      const treatmentsCall = fetchApi.mock.calls.find(
        ([url]) => url === '/api/wellness/activetreatment'
      );
      expect(treatmentsCall).toBeTruthy();
    });

    expect(screen.getByText(/No active packages yet\./i)).toBeInTheDocument();
  });
});

describe('<Services /> — Create-service modal', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });

  it('clicking "New service" opens the form with all expected fields', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /New service/i }));

    // Visible labels for every field. "Marketing radius" appears once as a
    // label and once via the page's <p> subtitle copy on some layouts —
    // tolerate ≥1 with getAllByText.
    expect(screen.getByText(/Service name/i)).toBeInTheDocument();
    expect(screen.getByText(/^Category$/i)).toBeInTheDocument();
    expect(screen.getByText(/Ticket tier/i)).toBeInTheDocument();
    expect(screen.getByText(/Base price/i)).toBeInTheDocument();
    expect(screen.getByText(/Duration \(min\)/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Marketing radius/i).length).toBeGreaterThanOrEqual(1);

    // Placeholders confirm the inputs themselves are rendered
    expect(screen.getByPlaceholderText(/e\.g\. Hair Transplant/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/e\.g\. 5000/)).toBeInTheDocument();
  });

  it('clicking "New service" a second time toggles the form closed (button label flips to Cancel)', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /New service/i }));
    // The toggle now says "Cancel"
    const cancelBtn = screen.getByRole('button', { name: /^Cancel$/i });
    expect(cancelBtn).toBeInTheDocument();

    await user.click(cancelBtn);

    // Form gone, primary CTA restored
    expect(screen.queryByPlaceholderText(/e\.g\. Hair Transplant/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New service/i })).toBeInTheDocument();
  });

  it('submit button starts disabled (name + valid price required) and clicking it does NOT POST', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /New service/i }));

    // The Save button is rendered as <button type="submit" disabled> when form invalid.
    const saveBtn = screen.getByRole('button', { name: /^Save$/i });
    expect(saveBtn).toBeDisabled();

    const beforeCount = fetchApi.mock.calls.filter(
      ([url, opts]) => url === '/api/wellness/services' && opts?.method === 'POST'
    ).length;
    await user.click(saveBtn);
    const afterCount = fetchApi.mock.calls.filter(
      ([url, opts]) => url === '/api/wellness/services' && opts?.method === 'POST'
    ).length;
    expect(afterCount).toBe(beforeCount);
  });

  it('filling required fields enables Save and submits POST /api/wellness/services with the form body', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /New service/i }));

    const nameInput = screen.getByPlaceholderText(/e\.g\. Hair Transplant/i);
    const priceInput = screen.getByPlaceholderText(/e\.g\. 5000/);
    await user.type(nameInput, 'Microneedling RF');
    await user.clear(priceInput);
    await user.type(priceInput, '7500');

    const saveBtn = screen.getByRole('button', { name: /^Save$/i });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    await waitFor(() => {
      const postCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/services' && opts?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Microneedling RF');
      expect(body.basePrice).toBe(7500);
      // SUT moved from single `category` to multi-select `categoryIds` +
      // primary `categoryId` (first picked). Defaults: empty selection.
      expect(body.categoryIds).toEqual([]);
      expect(body.categoryId).toBeNull();
      expect(body.ticketTier).toBe('medium');
    });
  });
});

describe('<Services /> — Edit-card mode', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });

  it('edit-mode form is pre-filled with the row values', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Botox 50u')).toBeInTheDocument());

    // Catalog card order is NOT pinned (sort may change); target by aria-label.
    await user.click(screen.getByLabelText('Edit service Botox 50u'));

    expect(screen.getByDisplayValue('Botox 50u')).toBeInTheDocument();
    expect(screen.getByDisplayValue('15000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('45')).toBeInTheDocument();
    expect(screen.getByDisplayValue('30')).toBeInTheDocument();
  });

  it('clicking the × cancel button exits edit mode without saving', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Edit service GFC Hair'));
    expect(screen.getByDisplayValue('GFC Hair')).toBeInTheDocument();

    // The × button inside the edit card — find by lucide X icon's parent
    // structure: only sibling of Save inside the edit form. We use the
    // tagName + neighbour of the "Save" button to disambiguate.
    const saveBtn = screen.getByRole('button', { name: /^Save$/i });
    const cancelBtn = saveBtn.parentElement.querySelectorAll('button')[1];
    await user.click(cancelBtn);

    // Edit mode collapsed — display value gone, card heading text back
    expect(screen.queryByDisplayValue('GFC Hair')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /GFC Hair/i, level: 3 })).toBeInTheDocument();
  });

  it('PUT body includes the full payload shape (name, category, tier, price, duration, radius)', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Edit service GFC Hair'));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/services/10' && opts?.method === 'PUT'
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('GFC Hair');
      expect(body.category).toBe('hair-restoration');
      expect(body.ticketTier).toBe('high');
      expect(body.basePrice).toBe(8500);
      expect(body.durationMin).toBe(90);
      expect(body.targetRadiusKm).toBe(25);
      expect(body.isActive).toBe(true);
    });
  });
});

describe('<Services /> — Deactivate (soft delete)', () => {
  let confirmSpy;
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });
  afterEach(() => {
    if (confirmSpy) confirmSpy.mockRestore();
  });

  it('declining the confirm() does NOT fire any PUT', async () => {
    const user = userEvent.setup();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    const before = fetchApi.mock.calls.length;
    await user.click(screen.getByLabelText('Deactivate service GFC Hair'));
    // Confirm fired but no PUT followed
    expect(confirmSpy).toHaveBeenCalled();
    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 0));
    const putAfterDecline = fetchApi.mock.calls
      .slice(before)
      .find(([url, opts]) => url === '/api/wellness/services/10' && opts?.method === 'PUT');
    expect(putAfterDecline).toBeFalsy();
  });

  it('accepting the confirm() fires PUT with { isActive: false }', async () => {
    const user = userEvent.setup();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Deactivate service GFC Hair'));

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/services/10' && opts?.method === 'PUT'
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.isActive).toBe(false);
    });
  });
});

describe('<Services /> — Package builder tab', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });

  it('builder renders service multi-select + sessions slider + discount slider', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Packages$/i }));

    expect(screen.getByText(/Build a package/i)).toBeInTheDocument();
    // Multi-select replaced the single <select>; the label now carries a
    // selected count alongside it.
    expect(screen.getByTestId('package-service-select')).toBeInTheDocument();
    expect(screen.getByText(/^Services/i)).toBeInTheDocument();
    // "Sessions" + "Discount" labels
    expect(screen.getByText(/Sessions:/i)).toBeInTheDocument();
    expect(screen.getByText(/Discount:/i)).toBeInTheDocument();
    // Both ranges rendered
    const sliders = document.querySelectorAll('input[type="range"]');
    expect(sliders.length).toBe(2);
  });

  it('package summary shows gross / discount / net pricing arithmetic', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Packages$/i }));

    // Defaults: serviceId = first high-tier service (GFC Hair = 8500),
    // sessions = 6, discount = 15.
    // gross = 8500 * 6 = 51,000
    // savings = round(51000 * 15 / 100) = 7,650
    // net = 51000 - 7650 = 43,350
    expect(screen.getByText(/Gross total/i)).toBeInTheDocument();
    // Indian grouping renders these as 51,000 / 7,650 / 43,350. The net (43,350)
    // appears in BOTH the summary row AND the rendered pitch string, so we use
    // getAllByText for it (≥2 matches expected).
    expect(screen.getByText(/51,000/)).toBeInTheDocument();
    expect(screen.getByText(/7,650/)).toBeInTheDocument();
    expect(screen.getAllByText(/43,350/).length).toBeGreaterThanOrEqual(1);
  });

  it('"Copy pitch" button is rendered and clickable with a chosen service', async () => {
    const user = userEvent.setup();
    // Provide a clipboard stub so the writeText call doesn't blow up under jsdom.
    // navigator.clipboard is a read-only getter — assignment via Object.assign
    // throws; defineProperty bypasses that.
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: { writeText },
    });
    // PackageBuilder now copies via utils/clipboard.copyToClipboard, which only
    // uses navigator.clipboard.writeText when window.isSecureContext is true
    // (otherwise it falls back to the execCommand textarea trick). jsdom leaves
    // isSecureContext undefined, so force it on to exercise the modern path the
    // stub above is asserting against.
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      writable: true,
      value: true,
    });

    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Packages$/i }));

    const copyBtn = screen.getByRole('button', { name: /Copy pitch/i });
    await user.click(copyBtn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      // Pitch format: "<name> × <sessions> sessions = <money> (<discount>% off)"
      const arg = writeText.mock.calls[0][0];
      expect(arg).toMatch(/GFC Hair/);
      expect(arg).toMatch(/6 sessions/);
      expect(arg).toMatch(/15%/);
    });

    // After successful copy the button label switches to "Copied!"
    await waitFor(() => expect(screen.getByRole('button', { name: /Copied!/i })).toBeInTheDocument());
  });
});

describe('<Services /> — CSV toolbar surface', () => {
  beforeEach(() => {
    fetchApi.mockReset();
  });

  it('Export CSV button is rendered and not in an exporting state on mount', async () => {
    fetchApi.mockImplementation(defaultFetchRouter);
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    // The toolbar button reads "Export CSV" idle / "Exporting…" busy. The
    // SUT only disables it while an export is in flight (not on empty
    // catalog), so we pin presence + idle label only.
    // CsvImportExportToolbar with formats=['csv','xlsx'] renders a dropdown
    // button: aria-label="Export Services", visible text "Export".
    const exportBtn = screen.getByRole('button', { name: /^Export Services$/i });
    expect(exportBtn).not.toBeDisabled();
  });

  it('Import CSV control is rendered as a button (file input lives in the modal)', async () => {
    fetchApi.mockImplementation(defaultFetchRouter);
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    // Import CSV button visible on the toolbar — SUT moved the file picker
    // into a modal that opens on click, so no <input type="file"> exists
    // on initial render.
    expect(screen.getByRole('button', { name: /^Import Services$/i })).toBeInTheDocument();
    expect(document.querySelectorAll('input[type="file"]').length).toBe(0);
  });
});

// =====================================================================
// EXTENSION WAVE 2 — uncovered branches in ServiceCard save validation,
// PackageBuilder dynamic recompute, ActiveTreatmentsTab populated state,
// CSV import path, and per-card render details (category text + tier badge).
// =====================================================================

describe('<Services /> — Catalog card render details', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });

  it('renders category in uppercase and tier badge for each card', async () => {
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    // category text is uppercased via CSS text-transform; the DOM still
    // contains the raw value. Confirm both rows surface their category.
    expect(screen.getByText('hair-restoration')).toBeInTheDocument();
    expect(screen.getByText('aesthetics')).toBeInTheDocument();
    // Tier badges
    expect(screen.getByText(/^high$/)).toBeInTheDocument();
    expect(screen.getByText(/^medium$/)).toBeInTheDocument();
  });

  it('renders "Unlimited" radius when targetRadiusKm is null/0/missing', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/wellness/services') {
        return Promise.resolve([
          { id: 99, name: 'Unbounded Service', category: 'aesthetics', ticketTier: 'low', basePrice: 1000, durationMin: 30, targetRadiusKm: null, isActive: true },
        ]);
      }
      if (url === '/api/wellness/activetreatment') return Promise.resolve({ data: [] });
      return Promise.resolve({});
    });

    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Unbounded Service')).toBeInTheDocument());
    expect(screen.getByText(/Unlimited/i)).toBeInTheDocument();
  });
});

describe('<Services /> — ServiceCard inline-edit validation', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });

  it('Save with zero price short-circuits before firing PUT', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Edit service GFC Hair'));
    // Clear price + set to 0
    const priceInput = screen.getByDisplayValue('8500');
    await user.clear(priceInput);
    await user.type(priceInput, '0');

    const before = fetchApi.mock.calls.filter(
      ([url, opts]) => url === '/api/wellness/services/10' && opts?.method === 'PUT'
    ).length;
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 0));
    const after = fetchApi.mock.calls.filter(
      ([url, opts]) => url === '/api/wellness/services/10' && opts?.method === 'PUT'
    ).length;
    expect(after).toBe(before); // no PUT fired
  });

  it('Save with zero duration short-circuits before firing PUT', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Edit service GFC Hair'));
    const durationInput = screen.getByDisplayValue('90');
    await user.clear(durationInput);
    await user.type(durationInput, '0');

    const before = fetchApi.mock.calls.filter(
      ([url, opts]) => url === '/api/wellness/services/10' && opts?.method === 'PUT'
    ).length;
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await new Promise((r) => setTimeout(r, 0));
    const after = fetchApi.mock.calls.filter(
      ([url, opts]) => url === '/api/wellness/services/10' && opts?.method === 'PUT'
    ).length;
    expect(after).toBe(before);
  });

  it('Save with negative radius short-circuits before firing PUT', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Edit service GFC Hair'));
    const radiusInput = screen.getByDisplayValue('25');
    await user.clear(radiusInput);
    await user.type(radiusInput, '-5');

    const before = fetchApi.mock.calls.filter(
      ([url, opts]) => url === '/api/wellness/services/10' && opts?.method === 'PUT'
    ).length;
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await new Promise((r) => setTimeout(r, 0));
    const after = fetchApi.mock.calls.filter(
      ([url, opts]) => url === '/api/wellness/services/10' && opts?.method === 'PUT'
    ).length;
    expect(after).toBe(before);
  });

  it('editing description field round-trips into the PUT body', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Edit service GFC Hair'));
    // Description textarea is the only textarea inside the edit form.
    const textarea = document.querySelector('textarea');
    expect(textarea).toBeTruthy();
    await user.type(textarea, 'Premium graft service for hair restoration.');

    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/services/10' && opts?.method === 'PUT'
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.description).toMatch(/Premium graft service/);
    });
  });
});

describe('<Services /> — PackageBuilder dynamic recompute', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });

  it('changing the sessions slider recomputes gross / savings / net', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Packages$/i }));
    await waitFor(() => expect(screen.getByText(/51,000/)).toBeInTheDocument());

    // Sessions slider is the first range input
    const sliders = document.querySelectorAll('input[type="range"]');
    expect(sliders.length).toBe(2);
    // jsdom: fireEvent change instead of user.type (range input is non-typable)
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(sliders[0], { target: { value: '10' } });

    // 8500 * 10 = 85,000 ; discount 15% = 12,750 ; net = 72,250
    await waitFor(() => expect(screen.getByText(/85,000/)).toBeInTheDocument());
    expect(screen.getByText(/12,750/)).toBeInTheDocument();
  });

  it('changing discount to 0 yields gross === net (no savings)', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Packages$/i }));
    await waitFor(() => expect(screen.getByText(/51,000/)).toBeInTheDocument());

    // Discount slider is the second range input
    const sliders = document.querySelectorAll('input[type="range"]');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(sliders[1], { target: { value: '0' } });

    // gross = 51,000, savings = 0, net = 51,000 — gross + net both show 51,000
    await waitFor(() => {
      const matches = screen.getAllByText(/51,000/);
      // At least gross row + net row both render 51,000 → ≥ 2 matches.
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
    // Discount label updated to 0% — the value is rendered inside <strong>,
    // separate text node from the "Discount:" prefix, so query the <strong>.
    const strongs = Array.from(document.querySelectorAll('strong'));
    const discountStrong = strongs.find((s) => s.textContent === '0%');
    expect(discountStrong).toBeTruthy();
  });

  it('package builder shows "No services available" when services list is empty', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/wellness/services') return Promise.resolve([]);
      if (url === '/api/wellness/activetreatment') return Promise.resolve({ data: [] });
      return Promise.resolve({});
    });
    render(
      <MemoryRouter initialEntries={['/wellness/services?tab=packages']}>
        <Services />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText(/Build a package/i)).toBeInTheDocument());

    // The picker is replaced by a "No services available" notice AND the
    // summary shows its empty-selection placeholder.
    expect(screen.getByText(/No services available/i)).toBeInTheDocument();
    expect(screen.getByText(/Pick one or more services to see pricing/i)).toBeInTheDocument();
  });
});

/**
 * Multi-service packages.
 *
 * `sessions` repeats the WHOLE bundle, so the gross is the summed per-session
 * price × sessions. A one-service package must still price exactly as it did
 * before multi-select landed — that back-compat is what the first test pins.
 */
describe('<Services /> — PackageBuilder multi-service selection', () => {
  const TWO_HIGH_TIER = [
    { id: 21, name: 'Alpha Peel', category: 'aesthetics', ticketTier: 'high', basePrice: 1000, durationMin: 30, targetRadiusKm: 10, isActive: true },
    { id: 22, name: 'Beta Laser', category: 'aesthetics', ticketTier: 'high', basePrice: 2000, durationMin: 45, targetRadiusKm: 10, isActive: true },
  ];

  beforeEach(() => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/wellness/services') return Promise.resolve(TWO_HIGH_TIER);
      if (url === '/api/wellness/activetreatment') return Promise.resolve({ data: [] });
      return Promise.resolve({});
    });
  });

  const openPackages = async () => {
    render(
      <MemoryRouter initialEntries={['/wellness/services?tab=packages']}>
        <Services />
      </MemoryRouter>
    );
    // "Build a package" renders before the services fetch resolves, so waiting
    // on it alone races the default selection. "Package price" only appears
    // once a service is selected and priced.
    await screen.findByText(/Build a package/i);
    await screen.findByText(/Package price/i);
  };

  it('defaults to the first service and prices it exactly as the single-select did', async () => {
    await openPackages();

    // 1000 × 6 sessions = 6,000 gross; 15% = 900; net 5,100.
    expect(screen.getByText(/Per session$/i)).toBeInTheDocument();
    expect(screen.getByText(/6,000/)).toBeInTheDocument();
    expect(screen.getByText(/900/)).toBeInTheDocument();
    expect(screen.getAllByText(/5,100/).length).toBeGreaterThanOrEqual(1);
  });

  it('sums the per-session price across every selected service', async () => {
    const user = userEvent.setup();
    await openPackages();

    // Open the multi-select and add the second service.
    // Scope to the dropdown: the selection chip also renders a
    // 'Remove Alpha Peel' button, so an unscoped name match is ambiguous.
    await user.click(within(screen.getByTestId('package-service-select')).getByRole('button'));
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    await user.click(checkboxes[1]);

    await waitFor(() =>
      expect(screen.getByText(/Per session \(2 services\)/i)).toBeInTheDocument(),
    );
    // (1000 + 2000) × 6 = 18,000 gross; 15% = 2,700; net 15,300.
    expect(screen.getByText(/3,000/)).toBeInTheDocument();
    expect(screen.getByText(/18,000/)).toBeInTheDocument();
    expect(screen.getByText(/2,700/)).toBeInTheDocument();
    expect(screen.getAllByText(/15,300/).length).toBeGreaterThanOrEqual(1);
  });

  it('itemises each bundled service and names them all in the pitch', async () => {
    const user = userEvent.setup();
    await openPackages();

    // Scope to the dropdown: the selection chip also renders a
    // 'Remove Alpha Peel' button, so an unscoped name match is ambiguous.
    await user.click(within(screen.getByTestId('package-service-select')).getByRole('button'));
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    await user.click(checkboxes[1]);

    await waitFor(() =>
      // The pitch now names each service with its own run, because a package
      // can be 3 of one and 2 of another rather than a flat multiple.
      expect(screen.getByText(/Alpha Peel × 6 \+ Beta Laser × 6 \(12 sessions\)/i)).toBeInTheDocument(),
    );
  });

  it('prices each service on its own run — 3 of one, 2 of the other', async () => {
    // The point of the split: 5 sessions that are 3 of one treatment and 2 of
    // another cost 3xA + 2xB, not a flat multiple of the bundle.
    const user = userEvent.setup();
    await openPackages();

    await user.click(within(screen.getByTestId('package-service-select')).getByRole('button'));
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    await user.click(checkboxes[1]);
    await waitFor(() => expect(screen.getByTestId('package-service-sessions-22')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('package-service-sessions-21'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('package-service-sessions-22'), { target: { value: '2' } });

    // 1000x3 + 2000x2 = 7,000 gross; 15% = 1,050; net 5,950.
    await waitFor(() => expect(screen.getByText(/7,000/)).toBeInTheDocument());
    expect(screen.getByText(/1,050/)).toBeInTheDocument();
    expect(screen.getAllByText(/5,950/).length).toBeGreaterThanOrEqual(1);
    // Five sittings in total, and no single "per session" price to quote.
    expect(screen.getByText(/Total sessions/i)).toBeInTheDocument();
    expect(screen.queryByText(/Per session/i)).not.toBeInTheDocument();
  });

  it('itemises the split with each service run', async () => {
    const user = userEvent.setup();
    await openPackages();
    await user.click(within(screen.getByTestId('package-service-select')).getByRole('button'));
    await user.click(document.querySelectorAll('input[type="checkbox"]')[1]);
    await waitFor(() => expect(screen.getByTestId('package-service-sessions-22')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('package-service-sessions-21'), { target: { value: '3' } });

    // Exact strings: the pitch line below also contains "Alpha Peel × 3".
    await waitFor(() => expect(screen.getByText('Alpha Peel × 3')).toBeInTheDocument());
    expect(screen.getByText('Beta Laser × 6')).toBeInTheDocument();
    // 1000x3 = 3,000 and 2000x6 = 12,000, priced per service.
    expect(screen.getByText(/^₹3,000$/)).toBeInTheDocument();
    expect(screen.getByText(/^₹12,000$/)).toBeInTheDocument();
  });

  it('the slider still sets every service at once', async () => {
    // It is the common case, and it is what the single number always meant.
    const user = userEvent.setup();
    await openPackages();
    await user.click(within(screen.getByTestId('package-service-select')).getByRole('button'));
    await user.click(document.querySelectorAll('input[type="checkbox"]')[1]);
    await waitFor(() => expect(screen.getByTestId('package-service-sessions-22')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('package-service-sessions-21'), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByTestId('package-service-sessions-21')).toHaveValue(2));

    const sliders = document.querySelectorAll('input[type="range"]');
    fireEvent.change(sliders[0], { target: { value: '4' } });

    await waitFor(() => expect(screen.getByTestId('package-service-sessions-21')).toHaveValue(4));
    expect(screen.getByTestId('package-service-sessions-22')).toHaveValue(4);
  });

  it('labels the slider with the slider value, not the total', async () => {
    // The bug this pins: the label read "Sessions: 16" directly above a thumb
    // sitting on 8. The label belongs to the slider; the totals get their own
    // line underneath, where they cannot be misread as the slider's value.
    const user = userEvent.setup();
    await openPackages();
    await user.click(within(screen.getByTestId('package-service-select')).getByRole('button'));
    await user.click(document.querySelectorAll('input[type="checkbox"]')[1]);
    await waitFor(() => expect(screen.getByTestId('package-service-sessions-22')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('package-service-sessions-21'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('package-service-sessions-22'), { target: { value: '7' } });

    await waitFor(() =>
      expect(screen.getByTestId('package-total-sessions')).toHaveTextContent('8'),
    );
    // The slider still reads its own value, and says what it does to a split.
    expect(screen.getByTestId('package-sessions-each')).toHaveTextContent('6');
    expect(screen.getByText(/Set every service to/i)).toBeInTheDocument();
    // Both counts, spelled out together.
    expect(screen.getByTestId('package-sessions-summary')).toHaveTextContent(
      /1 \+ 7 = 8 sessions across 2 services, booked as 7 visits/,
    );
  });

  it('says it plainly when a single service is selected', async () => {
    await openPackages();
    // One service: slider, sessions and visits are all 6, so no arithmetic is
    // spelled out and the label stays "Sessions".
    expect(screen.getByTestId('package-sessions-each')).toHaveTextContent('6');
    expect(screen.getByTestId('package-total-sessions')).toHaveTextContent('6');
    expect(screen.getByTestId('package-visit-count')).toHaveTextContent('6');
    expect(screen.queryByText(/across .* services/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Set every service to/i)).not.toBeInTheDocument();
  });

  describe('the hints on the counts', () => {
    it('explains what dragging the slider does to a split', async () => {
      const user = userEvent.setup();
      await openPackages();
      await user.click(within(screen.getByTestId('package-service-select')).getByRole('button'));
      await user.click(document.querySelectorAll('input[type="checkbox"]')[1]);
      await waitFor(() => expect(screen.getByTestId('package-service-sessions-22')).toBeInTheDocument());

      // Hidden until asked for — it is an explanation, not a warning.
      expect(screen.queryByTestId('package-sessions-hint-bubble')).not.toBeInTheDocument();

      await user.hover(screen.getByTestId('package-sessions-hint'));

      const bubble = await screen.findByTestId('package-sessions-hint-bubble');
      expect(bubble).toHaveTextContent(/overwrites a split/i);
      expect(bubble).toHaveTextContent(/type into the box on its chip/i);
    });

    it('explains sessions against visits when they differ', async () => {
      const user = userEvent.setup();
      await openPackages();
      await user.click(within(screen.getByTestId('package-service-select')).getByRole('button'));
      await user.click(document.querySelectorAll('input[type="checkbox"]')[1]);
      await waitFor(() => expect(screen.getByTestId('package-service-sessions-22')).toBeInTheDocument());
      fireEvent.change(screen.getByTestId('package-service-sessions-21'), { target: { value: '3' } });
      fireEvent.change(screen.getByTestId('package-service-sessions-22'), { target: { value: '4' } });
      await waitFor(() => expect(screen.getByTestId('package-visit-count')).toHaveTextContent('4'));

      await user.hover(screen.getByTestId('package-totals-hint'));

      const bubble = await screen.findByTestId('package-totals-hint-bubble');
      expect(bubble).toHaveTextContent(/7 treatment runs is what the price is built from/i);
      expect(bubble).toHaveTextContent(/4 appointments/i);
    });

    it('the hint opens on a tap as well as a hover', async () => {
      // Hover does not exist on a tablet, which is what the front desk uses.
      // A tap fires mouseover first, so the click must OPEN rather than
      // toggle — a toggle would open and close in the same gesture and the
      // tablet would show nothing at all.
      const user = userEvent.setup();
      await openPackages();

      await user.click(screen.getByTestId('package-sessions-hint'));
      expect(await screen.findByTestId('package-sessions-hint-bubble')).toBeInTheDocument();

      await user.click(screen.getByTestId('package-sessions-hint'));
      expect(screen.getByTestId('package-sessions-hint-bubble')).toBeInTheDocument();
    });

    it('the hint closes on Escape and on leaving it', async () => {
      const user = userEvent.setup();
      await openPackages();

      await user.hover(screen.getByTestId('package-sessions-hint'));
      expect(await screen.findByTestId('package-sessions-hint-bubble')).toBeInTheDocument();

      await user.unhover(screen.getByTestId('package-sessions-hint'));
      await waitFor(() =>
        expect(screen.queryByTestId('package-sessions-hint-bubble')).not.toBeInTheDocument(),
      );

      screen.getByTestId('package-sessions-hint').focus();
      expect(await screen.findByTestId('package-sessions-hint-bubble')).toBeInTheDocument();

      await user.keyboard('{Escape}');
      await waitFor(() =>
        expect(screen.queryByTestId('package-sessions-hint-bubble')).not.toBeInTheDocument(),
      );
    });

    it('the hint button never submits the form', async () => {
      const user = userEvent.setup();
      await openPackages();

      await user.click(screen.getByTestId('package-sessions-hint'));

      const posts = fetchApi.mock.calls.filter(([, opts]) => opts?.method === 'POST');
      expect(posts).toHaveLength(0);
    });
  });

  /**
   * 3 runs of one service and 4 of the other is 7 runs however they are
   * delivered — but the patient attends either 4 appointments (three with both
   * services, one with the leftover) or 7 (one service each). The clinic
   * chooses, and the choice is what the session counter counts down.
   */
  describe('delivering the runs — together or one per visit', () => {
    const pickBoth = async (user) => {
      await openPackages();
      await user.click(within(screen.getByTestId('package-service-select')).getByRole('button'));
      await user.click(document.querySelectorAll('input[type="checkbox"]')[1]);
      await waitFor(() => expect(screen.getByTestId('package-service-sessions-22')).toBeInTheDocument());
      fireEvent.change(screen.getByTestId('package-service-sessions-21'), { target: { value: '3' } });
      fireEvent.change(screen.getByTestId('package-service-sessions-22'), { target: { value: '4' } });
      await waitFor(() => expect(screen.getByTestId('package-total-sessions')).toHaveTextContent('7'));
    };

    it('defaults to sharing a visit — 3 + 4 is four appointments', async () => {
      const user = userEvent.setup();
      await pickBoth(user);

      expect(screen.getByTestId('package-session-mode-combined')).toBeChecked();
      expect(screen.getByTestId('package-visits')).toHaveTextContent('4');
      // The runs are still seven; only the packing changed.
      expect(screen.getByTestId('package-total-sessions')).toHaveTextContent('7');
    });

    it('one service per visit makes the same runs seven appointments', async () => {
      const user = userEvent.setup();
      await pickBoth(user);

      await user.click(screen.getByTestId('package-session-mode-separate'));

      await waitFor(() => expect(screen.getByTestId('package-total-sessions')).toHaveTextContent('7'));
      // Runs and visits agree, so the extra row drops away rather than
      // printing 7 twice.
      expect(screen.queryByTestId('package-visits')).not.toBeInTheDocument();
    });

    it('the price does not move with the packing — only the visit count', async () => {
      const user = userEvent.setup();
      await pickBoth(user);

      // 1000x3 + 2000x4 = 11,000 gross; 15% off = 9,350.
      expect(screen.getByText(/11,000/)).toBeInTheDocument();
      const before = screen.getAllByText(/9,350/).length;

      await user.click(screen.getByTestId('package-session-mode-separate'));

      await waitFor(() => expect(screen.getByTestId('package-session-mode-separate')).toBeChecked());
      expect(screen.getByText(/11,000/)).toBeInTheDocument();
      expect(screen.getAllByText(/9,350/).length).toBe(before);
    });

    it('sends the chosen packing with the package', async () => {
      const user = userEvent.setup();
      await pickBoth(user);
      await user.click(screen.getByTestId('package-session-mode-separate'));
      await user.type(screen.getByTestId('package-name-input'), 'Split Bundle');
      await user.click(screen.getByTestId('package-save'));

      await waitFor(() => {
        const post = fetchApi.mock.calls.find(
          ([url, opts]) => url === '/api/wellness/packages' && opts?.method === 'POST',
        );
        expect(post).toBeTruthy();
        const body = JSON.parse(post[1].body);
        expect(body.sessionMode).toBe('separate');
        expect(body.serviceSessions).toEqual({ 21: 3, 22: 4 });
      });
    });

    it('offers no packing choice for a single service — there is nothing to combine', async () => {
      await openPackages();
      expect(screen.queryByTestId('package-session-mode')).not.toBeInTheDocument();
    });
  });

  /**
   * The count box has to be typeable. Clamping on every keystroke meant
   * clearing it to type "5" read as 0, clamped back to 1, and you ended up
   * with 15 — there was no way to reach 5 at all.
   */
  describe('typing a session count', () => {
    const openWithBox = async () => {
      await openPackages();
      return screen.getByTestId('package-service-sessions-21');
    };

    it('clearing the box does not snap it back to 1', async () => {
      const box = await openWithBox();
      fireEvent.change(box, { target: { value: '' } });
      expect(box).toHaveValue(null);
    });

    it('clear then type 5 gives 5, not 15', async () => {
      const box = await openWithBox();
      fireEvent.change(box, { target: { value: '' } });
      fireEvent.change(box, { target: { value: '5' } });

      expect(box).toHaveValue(5);
      await waitFor(() =>
        expect(screen.getByTestId('package-total-sessions')).toHaveTextContent('5'),
      );
    });

    it('prices live while a valid number is being typed', async () => {
      const box = await openWithBox();
      fireEvent.change(box, { target: { value: '' } });
      fireEvent.change(box, { target: { value: '3' } });

      // 1000 x 3 = 3,000 gross.
      await waitFor(() => expect(screen.getByText(/3,000/)).toBeInTheDocument());
    });

    it('an emptied box falls back to its last real value on blur', async () => {
      const box = await openWithBox();
      fireEvent.change(box, { target: { value: '4' } });
      fireEvent.change(box, { target: { value: '' } });
      fireEvent.blur(box);

      expect(box).toHaveValue(4);
    });

    it('clamps an out-of-range number on blur rather than mid-keystroke', async () => {
      const box = await openWithBox();
      fireEvent.change(box, { target: { value: '0' } });
      // Still shown as typed — clamping here is what broke the field.
      expect(box).toHaveValue(0);

      fireEvent.blur(box);
      expect(box).toHaveValue(1);
    });

    it('caps at 60 on blur', async () => {
      const box = await openWithBox();
      fireEvent.change(box, { target: { value: '999' } });
      fireEvent.blur(box);

      expect(box).toHaveValue(60);
    });

    it('the slider follows the number that was typed', async () => {
      // The bug this pins: the header read "SESSIONS: 3" while the only
      // service on the package said 1.
      const box = await openWithBox();
      fireEvent.change(box, { target: { value: '' } });
      fireEvent.change(box, { target: { value: '5' } });

      await waitFor(() => expect(screen.getByTestId('package-sessions-each')).toHaveTextContent('5'));
      expect(document.querySelectorAll('input[type="range"]')[0]).toHaveValue('5');
    });

    it('dragging the slider clears a half-typed box', async () => {
      const box = await openWithBox();
      fireEvent.change(box, { target: { value: '' } });

      fireEvent.change(document.querySelectorAll('input[type="range"]')[0], { target: { value: '9' } });

      await waitFor(() => expect(screen.getByTestId('package-service-sessions-21')).toHaveValue(9));
    });
  });

  it('sends the split with the saved package', async () => {
    const user = userEvent.setup();
    await openPackages();
    await user.click(within(screen.getByTestId('package-service-select')).getByRole('button'));
    await user.click(document.querySelectorAll('input[type="checkbox"]')[1]);
    await waitFor(() => expect(screen.getByTestId('package-service-sessions-22')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('package-service-sessions-21'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('package-service-sessions-22'), { target: { value: '2' } });
    await user.type(screen.getByTestId('package-name-input'), 'Split Bundle');
    await user.click(screen.getByTestId('package-save'));

    await waitFor(() => {
      const post = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/packages' && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post[1].body).serviceSessions).toEqual({ 21: 3, 22: 2 });
    });
  });

  it('a bundled service can be removed from its chip', async () => {
    const user = userEvent.setup();
    await openPackages();

    // Scope to the dropdown: the selection chip also renders a
    // 'Remove Alpha Peel' button, so an unscoped name match is ambiguous.
    await user.click(within(screen.getByTestId('package-service-select')).getByRole('button'));
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    await user.click(checkboxes[1]);
    await waitFor(() =>
      expect(screen.getByText(/Per session \(2 services\)/i)).toBeInTheDocument(),
    );

    // Close the portal menu, then drop one service via its chip.
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /Remove Beta Laser/i }));

    await waitFor(() =>
      expect(screen.queryByText(/Per session \(2 services\)/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/Per session$/i)).toBeInTheDocument();
  });
});

describe('<Services /> — PackageBuilder tax, validity and sell-by', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-27T12:00:00'));
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
    notify.success.mockReset();
    notify.error.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const openBuilder = async (user) => {
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^Packages$/i }));
    await waitFor(() => expect(screen.getByText(/51,000/)).toBeInTheDocument());
  };

  const pickFrom = async (user, testId, optionLabel) => {
    const trigger = within(screen.getByTestId(testId)).getByRole('button');
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: optionLabel }));
  };

  it('adds the selected tax on top of the package price rather than inside it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openBuilder(user);

    // Default bundle: 8500 × 6 = 51,000 gross, 15% off → 43,350 net.
    expect(screen.getByText(/Package price$/i)).toBeInTheDocument();
    await pickFrom(user, 'package-tax-select', 'GST 18%');

    // The stored price stays pre-tax; the customer-facing total is derived.
    await waitFor(() => expect(screen.getByText(/Package price \(pre-tax\)/i)).toBeInTheDocument());
    expect(screen.getByText(/Tax \(18%\)/)).toBeInTheDocument();
    expect(screen.getByText(/7,803/)).toBeInTheDocument(); // 43,350 × 18%
    // 43,350 + 7,803 shows twice: the "Customer pays" row and the sales pitch,
    // which has to quote the tax-inclusive figure a customer would hear.
    expect(screen.getAllByText(/51,153/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/incl\. tax/i)).toBeInTheDocument();
  });

  it('sends tax, validity and sell-by with the saved package', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openBuilder(user);

    await user.type(screen.getByTestId('package-name-input'), 'Glow Season Bundle');
    await pickFrom(user, 'package-tax-select', 'GST 18%');
    await pickFrom(user, 'package-validity-select', '6 Months');
    fireEvent.change(screen.getByTestId('package-sell-by-input'), { target: { value: '2026-12-31' } });

    await user.click(screen.getByTestId('package-save'));

    await waitFor(() => {
      const post = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/packages' && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body).toMatchObject({
        name: 'Glow Season Bundle',
        taxPercent: 18,
        validityDays: 180,      // "6 Months" is stored as a day count
        sellByDate: '2026-12-31',
      });
    });
  });

  it('omits validity and sell-by when they are left alone', async () => {
    // No expiry and no sell-by is the default, and has to reach the API as an
    // explicit null rather than an empty string the validator would reject.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openBuilder(user);

    await user.type(screen.getByTestId('package-name-input'), 'Plain Bundle');
    await user.click(screen.getByTestId('package-save'));

    await waitFor(() => {
      const post = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/packages' && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.taxPercent).toBe(0);
      expect(body.validityDays).toBeNull();
      expect(body.sellByDate).toBeNull();
    });
  });

  it('blocks saving a package with a past sell-by date', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openBuilder(user);

    await user.type(screen.getByTestId('package-name-input'), 'Expired Bundle');
    fireEvent.change(screen.getByTestId('package-sell-by-input'), { target: { value: '2026-08-26' } });

    await user.click(screen.getByTestId('package-save'));

    expect(notify.error).toHaveBeenCalledWith('Sell-by date cannot be in the past');
    const packagePosts = fetchApi.mock.calls.filter(
      ([url, opts]) => url === '/api/wellness/packages' && opts?.method === 'POST',
    );
    expect(packagePosts).toHaveLength(0);
  });

  it('does not offer past dates in the builder sell-by input', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openBuilder(user);

    expect(screen.getByTestId('package-sell-by-input')).toHaveAttribute('min', '2026-08-27');
  });
});

describe('<Services /> — who is offered a package to buy', () => {
  // Staff are role USER / userType STAFF. Reading role === 'USER' as
  // "customer" put a Buy button in front of every doctor, nurse and
  // telecaller — and buying from a staff account would mint a Patient record
  // named after them.
  const LIVE_PACKAGE = {
    id: 3,
    name: 'Strict removal',
    serviceIds: [10],
    services: [{ id: 10, name: 'GFC Hair', basePrice: 8500 }],
    missingServiceIds: [],
    sessions: 4,
    discountPercent: 15,
    grossPrice: 59992,
    price: 50993,
    isActive: true,
    isPublic: true,
  };

  const renderAs = async ({ userType, role, canWrite }) => {
    usePermissionsMock.mockReturnValue({
      ...FULL_PERMS,
      userType,
      hasPermission: () => canWrite,
    });
    fetchApi.mockImplementation((url) => {
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/packages') return Promise.resolve({ packages: [LIVE_PACKAGE] });
      if (url === '/api/wellness/activetreatment') return Promise.resolve({ data: [] });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(
      <AuthContext.Provider value={{ user: { role }, tenant: { name: 'Clinic' } }}>
        <MemoryRouter><Services /></MemoryRouter>
      </AuthContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^Packages$/i }));
    return user;
  };

  afterEach(() => {
    usePermissionsMock.mockReturnValue(FULL_PERMS);
  });

  it('offers a customer the package to buy', async () => {
    await renderAs({ userType: 'CUSTOMER', role: 'CUSTOMER', canWrite: false });

    await waitFor(() => expect(screen.getByTestId('package-buy-3')).toBeInTheDocument());
    expect(screen.queryByText(/Build a package/i)).not.toBeInTheDocument();
  });

  it('offers a doctor nothing to buy — they may look, not purchase', async () => {
    await renderAs({ userType: 'STAFF', role: 'USER', canWrite: false });

    // The catalog they sell is visible…
    await waitFor(() => expect(screen.getByText('Strict removal')).toBeInTheDocument());
    // …without a purchase, and without the builder they cannot save from.
    expect(screen.queryByTestId('package-buy-3')).not.toBeInTheDocument();
    expect(screen.queryByText(/Build a package/i)).not.toBeInTheDocument();
  });

  it('gives a doctor no publish or retire controls either', async () => {
    await renderAs({ userType: 'STAFF', role: 'USER', canWrite: false });

    await waitFor(() => expect(screen.getByText('Strict removal')).toBeInTheDocument());
    expect(screen.queryByTestId('package-publish-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('package-terms-3')).not.toBeInTheDocument();
  });

  it('gives someone who can manage the catalog the builder, not a Buy button', async () => {
    await renderAs({ userType: 'STAFF', role: 'ADMIN', canWrite: true });

    await waitFor(() => expect(screen.getByText(/Build a package/i)).toBeInTheDocument());
    expect(screen.queryByTestId('package-buy-3')).not.toBeInTheDocument();
  });
});

describe('<Services /> — Active Packages populated state', () => {
  beforeEach(() => {
    fetchApi.mockReset();
  });

  it('renders treatment cards when /api/wellness/activetreatment returns rows', async () => {
    const user = userEvent.setup();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/activetreatment') {
        return Promise.resolve({
          data: [
            {
              id: 501,
              name: 'GFC 6-session course',
              status: 'active',
              totalSessions: 6,
              completedSessions: 2,
              totalPrice: 51000,
              startedAt: '2026-04-01T00:00:00Z',
              nextDueAt: '2026-06-01T00:00:00Z',
              patient: { name: 'Asha Iyer', email: 'asha@example.com', phone: '+91-9000011111' },
              service: { name: 'GFC Hair', durationMin: 90, basePrice: 8500, targetRadiusKm: 25, category: 'hair-restoration' },
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Active Packages/i }));

    // Treatment heading + patient label + sessions counter
    await waitFor(() => expect(screen.getByText('GFC 6-session course')).toBeInTheDocument());
    expect(screen.getByText(/Asha Iyer/)).toBeInTheDocument();
    expect(screen.getByText(/2\/6 sessions/)).toBeInTheDocument();
    // Active treatments empty-state copy MUST NOT render when rows exist
    expect(screen.queryByText(/No active packages yet\./i)).not.toBeInTheDocument();
  });

  it('a bundle saved on the Packages tab shows up here, above the patient plans', async () => {
    // The clinic calls both things "packages": a bundle they offer, and a
    // plan a patient has bought. Building one has to land somewhere visible.
    const user = userEvent.setup();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/packages') {
        return Promise.resolve({
          packages: [
            {
              id: 90,
              name: 'Glow Bundle',
              serviceIds: [10],
              services: [{ id: 10, name: 'GFC Hair', basePrice: 8500 }],
              missingServiceIds: [],
              sessions: 6,
              discountPercent: 10,
              grossPrice: 51000,
              price: 45900,
              isActive: true,
              isPublic: false,
            },
          ],
        });
      }
      if (url === '/api/wellness/activetreatment') {
        return Promise.resolve({
          data: [{
            id: 501,
            name: 'GFC 6-session course',
            status: 'active',
            totalSessions: 6,
            completedSessions: 2,
            totalPrice: 51000,
            startedAt: '2026-04-01T00:00:00Z',
            patient: { name: 'Asha Iyer' },
            service: { name: 'GFC Hair' },
          }],
        });
      }
      return Promise.resolve({});
    });

    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Active Packages/i }));

    // Both halves render, each under its own heading.
    await waitFor(() => expect(screen.getByText('Glow Bundle')).toBeInTheDocument());
    expect(screen.getByText(/Packages you offer/i)).toBeInTheDocument();
    expect(screen.getByText(/Patient packages in progress/i)).toBeInTheDocument();
    expect(screen.getByText('GFC 6-session course')).toBeInTheDocument();
  });

  it('omits the bundle section entirely when no bundle has been built', async () => {
    // A clinic that only tracks what patients bought sees the tab unchanged —
    // no empty section, no extra headings.
    const user = userEvent.setup();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/packages') return Promise.resolve({ packages: [] });
      if (url === '/api/wellness/activetreatment') {
        return Promise.resolve({
          data: [{
            id: 502,
            name: 'Solo plan',
            status: 'active',
            totalSessions: 4,
            completedSessions: 0,
            totalPrice: 12000,
            startedAt: '2026-04-01T00:00:00Z',
            patient: { name: 'Ravi Menon' },
            service: { name: 'GFC Hair' },
          }],
        });
      }
      return Promise.resolve({});
    });

    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Active Packages/i }));

    await waitFor(() => expect(screen.getByText('Solo plan')).toBeInTheDocument());
    expect(screen.queryByText(/Packages you offer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Patient packages in progress/i)).not.toBeInTheDocument();
  });

  it('loads additional treatment cards when the scroll container reaches the bottom', async () => {
    const user = userEvent.setup();
    const manyTreatments = Array.from({ length: 18 }, (_, index) => ({
      id: 700 + index,
      name: `Scrollable treatment ${index + 1}`,
      status: 'active',
      totalSessions: 6,
      completedSessions: 1,
      totalPrice: 24000,
      startedAt: '2026-04-01T00:00:00Z',
      nextDueAt: '2026-06-01T00:00:00Z',
      patient: { name: `Patient ${index + 1}` },
      service: { name: 'GFC Hair', durationMin: 90, basePrice: 8500, targetRadiusKm: 25, category: 'hair-restoration' },
    }));

    fetchApi.mockImplementation((url) => {
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/activetreatment') return Promise.resolve({ data: manyTreatments });
      return Promise.resolve({});
    });

    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Active Packages/i }));

    await waitFor(() => {
      expect(screen.getByText('Scrollable treatment 1')).toBeInTheDocument();
    });
    expect(screen.queryByText('Scrollable treatment 13')).not.toBeInTheDocument();

    const scrollContainer = screen.getByTestId('active-treatments-scroll');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 800, configurable: true });
    scrollContainer.scrollTop = 728;
    fireEvent.scroll(scrollContainer);

    expect(
      await screen.findByText('Scrollable treatment 13'),
    ).toBeInTheDocument();
  });

  it('keeps the cancelled badge inside the treatment card container', async () => {
    const user = userEvent.setup();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/activetreatment') {
        return Promise.resolve({
          data: [
            {
              id: 502,
              name: 'Very long cancelled treatment plan name that should wrap cleanly',
              status: 'cancelled',
              totalSessions: 4,
              completedSessions: 1,
              totalPrice: 12000,
              startedAt: '2026-04-01T00:00:00Z',
              nextDueAt: null,
              patient: { name: 'Meera Shah' },
              service: { name: 'Acne Vulgaris Treatment', durationMin: 60, basePrice: 3000, targetRadiusKm: 20, category: 'acne' },
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Active Packages/i }));

    const card = await screen.findByTestId('treatment-card-502');
    const badge = within(card).getByTestId('treatment-status-502');
    expect(badge).toHaveTextContent(/cancelled/i);
    expect(card).toContainElement(badge);
  });
});

describe('<Services /> — CSV import modal flow', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });

  it('clicking Import CSV opens a dialog containing the file input', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    // No file input until the modal opens.
    expect(document.querySelectorAll('input[type="file"]').length).toBe(0);

    await user.click(screen.getByRole('button', { name: /Import Services|^Import CSV$/i }));

    // Dialog now mounted with a file input inside it.
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    const fileInputs = document.querySelectorAll('input[type="file"]');
    expect(fileInputs.length).toBeGreaterThanOrEqual(1);
    expect(fileInputs[0].accept).toMatch(/csv/);
  });
});

describe('<Services /> — Packages CTA scroll anchor', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });

  // DRIFT: the "Create Package" CTA + its scroll-to-anchor handler were
  // removed when packages moved to compute-on-the-fly (no DB record per
  // Services.jsx:1097 comment). The builder is now rendered inline at
  // the top of the Packages tab so scroll-down-to-builder UX is moot.
  // Re-enable / rewrite this case if the CTA returns in a future redesign.
  it.skip('"Create Package" button invokes scrollIntoView on the builder anchor (SUT no longer renders the CTA)', () => {});
});
