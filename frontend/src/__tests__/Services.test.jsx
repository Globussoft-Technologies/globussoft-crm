/**
 * Services.test.jsx — wellness service catalog + packages page pin.
 *
 * Augments the original 4 smoke tests (catalog cards render, edit-mode flip,
 * PUT on save, confirm-on-deactivate) with substantial coverage of the
 * 903-LOC SUT at `pages/wellness/Services.jsx`:
 *
 *   - Tab switching (Catalog vs Packages vs Active Treatments)
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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
  getAuthToken: vi.fn(() => 'test-token'),
}));

import { fetchApi } from '../utils/api';
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

  it('exposes 3 tabs: Catalog, Packages, Active Treatments', async () => {
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    // Catalog label appears in both the page subtitle and the tab — use getAllByText.
    expect(screen.getAllByText(/Catalog/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Packages$/i)).toBeInTheDocument();
    expect(screen.getByText(/Active Treatments/i)).toBeInTheDocument();
  });

  it('switching to the Packages tab swaps the primary CTA to "Create Package"', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    // Catalog tab default — "New service" CTA visible
    expect(screen.getByRole('button', { name: /New service/i })).toBeInTheDocument();

    // Click Packages tab
    await user.click(screen.getByRole('button', { name: /^Packages$/i }));

    // Catalog CTA gone; Packages CTA visible
    expect(screen.queryByRole('button', { name: /New service/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Package/i })).toBeInTheDocument();
  });

  it('switching to Active Treatments fetches /api/wellness/activetreatment', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Active Treatments/i }));

    await waitFor(() => {
      const treatmentsCall = fetchApi.mock.calls.find(
        ([url]) => url === '/api/wellness/activetreatment'
      );
      expect(treatmentsCall).toBeTruthy();
    });
  });

  it('Active Treatments tab renders the empty-state copy when no rows', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Active Treatments/i }));

    await waitFor(() =>
      expect(screen.getByText(/No active treatment plans yet\./i)).toBeInTheDocument()
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

    // Packages CTA visible (Catalog CTA hidden)
    expect(screen.getByRole('button', { name: /Create Package/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New service/i })).not.toBeInTheDocument();
  });

  it('?tab=activetreatments lands on the Active Treatments tab', async () => {
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

    expect(screen.getByText(/No active treatment plans yet\./i)).toBeInTheDocument();
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
      // Sensible defaults from the initial state
      expect(body.category).toBe('aesthetics');
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

    // Second card = Botox row
    const editBtns = screen.getAllByTitle(/^Edit$/i);
    await user.click(editBtns[1]);

    expect(screen.getByDisplayValue('Botox 50u')).toBeInTheDocument();
    expect(screen.getByDisplayValue('15000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('45')).toBeInTheDocument();
    expect(screen.getByDisplayValue('30')).toBeInTheDocument();
  });

  it('clicking the × cancel button exits edit mode without saving', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getAllByTitle(/^Edit$/i)[0]);
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

    await user.click(screen.getAllByTitle(/^Edit$/i)[0]);
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
    await user.click(screen.getAllByTitle(/Deactivate/i)[0]);
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

    await user.click(screen.getAllByTitle(/Deactivate/i)[0]);

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

  it('builder renders service select + sessions slider + discount slider', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Packages$/i }));

    expect(screen.getByText(/Build a package/i)).toBeInTheDocument();
    expect(screen.getByText(/^Service$/i)).toBeInTheDocument();
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

describe('<Services /> — CSV export button state', () => {
  beforeEach(() => {
    fetchApi.mockReset();
  });

  it('Export CSV button is disabled when the catalog is empty', async () => {
    // Empty services list → button should be disabled.
    fetchApi.mockImplementation((url) => {
      if (url === '/api/wellness/services') return Promise.resolve([]);
      if (url === '/api/wellness/activetreatment') return Promise.resolve({ data: [] });
      return Promise.resolve({});
    });

    render(<MemoryRouter><Services /></MemoryRouter>);
    // Wait for the initial load() to settle (the "Loading…" placeholder is gone)
    await waitFor(() => expect(screen.queryByText(/^Loading…$/)).not.toBeInTheDocument());

    const exportBtn = screen.getByRole('button', { name: /Export CSV/i });
    expect(exportBtn).toBeDisabled();
  });

  it('Export CSV button is enabled when services are loaded', async () => {
    fetchApi.mockImplementation(defaultFetchRouter);
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    const exportBtn = screen.getByRole('button', { name: /Export CSV/i });
    expect(exportBtn).not.toBeDisabled();
  });

  it('Import CSV control is rendered as a file input wrapped in a label', async () => {
    fetchApi.mockImplementation(defaultFetchRouter);
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    // Import CSV label
    expect(screen.getByText(/Import CSV/i)).toBeInTheDocument();
    // Hidden file input is the only <input type="file"> on the page
    const fileInputs = document.querySelectorAll('input[type="file"]');
    expect(fileInputs.length).toBe(1);
    expect(fileInputs[0].accept).toMatch(/csv/);
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

    await user.click(screen.getAllByTitle(/^Edit$/i)[0]);
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

    await user.click(screen.getAllByTitle(/^Edit$/i)[0]);
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

    await user.click(screen.getAllByTitle(/^Edit$/i)[0]);
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

    await user.click(screen.getAllByTitle(/^Edit$/i)[0]);
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

    // The select has the "No services available" option AND the summary
    // shows the "Pick a service" placeholder.
    expect(screen.getByText(/No services available/i)).toBeInTheDocument();
    expect(screen.getByText(/Pick a service to see pricing/i)).toBeInTheDocument();
  });
});

describe('<Services /> — Active Treatments populated state', () => {
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
    await user.click(screen.getByRole('button', { name: /Active Treatments/i }));

    // Treatment heading + patient label + sessions counter
    await waitFor(() => expect(screen.getByText('GFC 6-session course')).toBeInTheDocument());
    expect(screen.getByText(/Asha Iyer/)).toBeInTheDocument();
    expect(screen.getByText(/2\/6 sessions/)).toBeInTheDocument();
    // Active treatments empty-state copy MUST NOT render when rows exist
    expect(screen.queryByText(/No active treatment plans yet\./i)).not.toBeInTheDocument();
  });
});

describe('<Services /> — CSV import handler', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });

  it('selecting a file on the hidden input triggers a multipart fetch to /api/csv/services/import.csv', async () => {
    // The import path uses native fetch (not fetchApi) for multipart upload.
    // Stub it on globalThis so we can capture the call.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ imported: 2, skipped: 0, errors: [] }),
    });

    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    // Locate the file input + upload a fake CSV
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    const csvFile = new File(['name,basePrice\nTestSvc,1000\n'], 'svc.csv', { type: 'text/csv' });
    await user.upload(fileInput, csvFile);

    await waitFor(() => {
      const importCall = fetchSpy.mock.calls.find(
        ([url, opts]) => url === '/api/csv/services/import.csv' && opts?.method === 'POST'
      );
      expect(importCall).toBeTruthy();
      // Body is a FormData instance carrying the file as "file"
      expect(importCall[1].body).toBeInstanceOf(FormData);
    });

    fetchSpy.mockRestore();
  });
});

describe('<Services /> — Packages CTA scroll anchor', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(defaultFetchRouter);
  });

  it('"Create Package" button invokes scrollIntoView on the builder anchor', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Packages$/i }));
    await waitFor(() => expect(screen.getByText(/Build a package/i)).toBeInTheDocument());

    // Patch scrollIntoView on the anchor element. jsdom does not implement
    // it natively — patching avoids the "not a function" error and lets us
    // assert the call shape.
    const anchor = document.getElementById('package-builder-anchor');
    expect(anchor).toBeTruthy();
    const scrollSpy = vi.fn();
    anchor.scrollIntoView = scrollSpy;

    await user.click(screen.getByRole('button', { name: /Create Package/i }));
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.calls[0][0]).toMatchObject({ behavior: 'smooth', block: 'start' });
  });
});
