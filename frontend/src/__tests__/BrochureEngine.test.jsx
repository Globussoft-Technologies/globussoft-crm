/**
 * BrochureEngine.test.jsx — vitest + RTL coverage for the Travel-vertical
 * Brochure Engine page (frontend/src/pages/travel/BrochureEngine.jsx).
 *
 * Lands at /travel/brochures. Wraps the vendored agentic-orchcrm engine. This
 * suite pins the CRM-side UI contract added by the BROCHURE_HANDOFF work:
 *   1. Page chrome: heading + Generate/History tabs + Brief textarea.
 *   2. Mount fetches: GET /sectors + GET /models + GET /brochures (history).
 *   3. Sector select is populated from /sectors.
 *   4. Model picker: strategy select renders; the pre-run cost estimate is
 *      computed from the catalog (deterministic fixture → "$0.015").
 *   5. Brand kit: opening the panel + adding a contact line persists it; the
 *      "Place logo" button is absent until a logo is set.
 *   6. Generate button: disabled with an empty brief, enabled once typed; a
 *      click POSTs /runs with the goal + the selected strategy in the body.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, not global fetch);
 *     getAuthToken stubbed so the SSE URL builds.
 *   - notifyObj is a STABLE module-level reference (Wave 11/12 rule).
 *   - EventSource stubbed globally so the run's openStream() doesn't throw.
 *   - Data-dependent assertions use findBy / waitFor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (no fresh object per render).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = { error: notifyError, info: notifyInfo, success: notifySuccess, confirm: notifyConfirm };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import BrochureEngine from '../pages/travel/BrochureEngine';

// Two available models. Under the 'recommended' strategy the engine routes
// every tier to the cheapest/balanced model 'a' (see resolveStrategyAssignment),
// so the deterministic cost works out to $0.015 across TIER_TOKENS.
const MODELS_FIXTURE = {
  tiers: ['reasoning', 'balanced', 'fast', 'writing'],
  strategies: ['recommended', 'cheapest', 'smartest', 'custom'],
  defaults: { reasoning: 'a', balanced: 'a', fast: 'a', writing: 'a' },
  models: [
    { id: 'a', label: 'Cheap Model', provider: 'groq', blurb: 'cheap', available: true, intelligence: 4, costEff: 5, inputPer1M: 0.15, outputPer1M: 0.75 },
    { id: 'b', label: 'Smart Model', provider: 'openai', blurb: 'smart', available: true, intelligence: 5, costEff: 2, inputPer1M: 2.5, outputPer1M: 15 },
  ],
};

const EXISTING_BRAND_KITS_FIXTURE = {
  brandKits: [
    {
      id: 42,
      tenantId: 1,
      subBrand: 'tmc',
      version: 3,
      isActive: true,
      updatedAt: '2026-08-01T00:00:00Z',
    },
  ],
};

const BRAND_KIT_DETAIL_FIXTURE = {
  brandKit: {
    id: 42,
    logoUrl: '/uploads/brand-kits/1/_default/logo.png',
    primaryColor: '#265855',
    secondaryColor: '#CD9481',
    accentColor: '#0e6b4f',
    bgColor: '#FAF6EE',
    textColor: '#1A1A1A',
    tagline: 'Crafted journeys',
    supportPhone: '+91 98765 43210',
    supportEmail: 'hello@agency.com',
    socialLinksJson: '[{"network":"instagram","url":"https://ig"}]',
  },
};

function wireFetch() {
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/travel/brochures/sectors') {
      return Promise.resolve({ sectors: [{ key: 'travel', name: 'Travel Brochure', description: 'agency-grade', styles: ['tmc-press', 'editorial-sakura'] }] });
    }
    if (url === '/api/travel/brochures/models') return Promise.resolve(MODELS_FIXTURE);
    if (url === '/api/brand-kits?fields=summary') return Promise.resolve(EXISTING_BRAND_KITS_FIXTURE);
    if (url === '/api/brand-kits/42') return Promise.resolve(BRAND_KIT_DETAIL_FIXTURE);
    if (url === '/api/travel/brochures/runs' && opts?.method === 'POST') {
      return Promise.resolve({ runId: 'br_test123', brochureId: 7, status: 'running' });
    }
    if (url === '/api/travel/brochures') return Promise.resolve({ brochures: [] });
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <BrochureEngine />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  wireFetch();
  // Minimal EventSource stub — the run's openStream constructs one.
  global.EventSource = class {
    constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; }
    close() {}
  };
});

describe('BrochureEngine page', () => {
  it('renders the header, tabs, and brief field', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Brochure Engine/i })).toBeInTheDocument();
    expect(screen.getByTestId('tab-generate')).toBeInTheDocument();
    expect(screen.getByTestId('tab-history')).toBeInTheDocument();
    expect(screen.getByTestId('brochure-goal')).toBeInTheDocument();
  });

  it('fetches sectors, models and history on mount', async () => {
    renderPage();
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map((c) => c[0]);
      expect(urls).toContain('/api/travel/brochures/sectors');
      expect(urls).toContain('/api/travel/brochures/models');
      expect(urls).toContain('/api/travel/brochures');
    });
  });

  it('shows Travel as a fixed (non-dropdown) sector with its description', async () => {
    renderPage();
    expect(await screen.findByText('agency-grade')).toBeInTheDocument(); // sector description
    expect(screen.getByTestId('sector-static')).toHaveTextContent('Travel');
    // Sector is no longer a dropdown — no Travel Brochure <option>.
    expect(screen.queryByRole('option', { name: 'Travel Brochure' })).not.toBeInTheDocument();
  });

  it('Template/Style offers exactly two options with Editorial Sakura as the default', async () => {
    renderPage();
    const select = await screen.findByTestId('style-select');
    expect(select.value).toBe('editorial-sakura');
    const optionTexts = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(optionTexts).toEqual(['Editorial Sakura (Default)', 'TMC Press']);
  });

  it('shows a deterministic pre-run cost estimate from the catalog', async () => {
    renderPage();
    // Header chip on the collapsed Models panel shows the estimate.
    expect(await screen.findByTestId('cost-estimate')).toHaveTextContent('$0.015');
  });

  it('renders the strategy picker when the Models panel is opened', async () => {
    renderPage();
    await screen.findByTestId('cost-estimate');
    fireEvent.click(screen.getByText(/^Models/));
    expect(await screen.findByRole('option', { name: /Recommended/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Cheapest/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Smartest/i })).toBeInTheDocument();
  });

  it('brand kit: opening the panel and adding a contact line persists it; no placer without a logo', async () => {
    renderPage();
    fireEvent.click(screen.getByText(/Brand Kit/i));
    // No logo set → no "Place logo" button.
    expect(screen.queryByTestId('open-placer')).not.toBeInTheDocument();
    // Add a contact line.
    fireEvent.click(screen.getByText('+ Add contact'));
    const input = screen.getByPlaceholderText('+91 98765 43210');
    fireEvent.change(input, { target: { value: '+91 99999 00000' } });
    expect(input.value).toBe('+91 99999 00000');
  });

  it('Generate is disabled with an empty brief and enabled once typed', async () => {
    renderPage();
    const btn = screen.getByTestId('generate-brochure');
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByTestId('brochure-goal'), { target: { value: '5-day Goa trip for a couple.' } });
    expect(btn).not.toBeDisabled();
  });

  it('Generate posts /runs with the goal and the selected strategy', async () => {
    renderPage();
    await screen.findByTestId('cost-estimate');
    fireEvent.change(screen.getByTestId('brochure-goal'), { target: { value: '5-day Goa trip for a couple.' } });
    fireEvent.click(screen.getByTestId('generate-brochure'));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find((c) => c[0] === '/api/travel/brochures/runs' && c[1]?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.goal).toBe('5-day Goa trip for a couple.');
      expect(body.sectorKey).toBe('travel');
      expect(body.styleKey).toBe('editorial-sakura'); // always explicit, defaults to editorial-sakura
      expect(body.strategy).toBe('recommended');
    });
  });

  it('loads existing brand kits on mount and shows the selector', async () => {
    renderPage();
    fireEvent.click(screen.getByText(/Brand Kit/i));
    const selector = await screen.findByTestId('existing-brand-kit');
    expect(selector).toBeInTheDocument();
    expect(within(selector).getByText('Custom brand kit')).toBeInTheDocument();
    expect(within(selector).getByText('tmc — v3')).toBeInTheDocument();
  });

  it('selecting an existing brand kit loads its values and sends existingBrandKitId on generate', async () => {
    renderPage();
    await screen.findByTestId('cost-estimate');
    fireEvent.click(screen.getByText(/Brand Kit/i));
    const selector = await screen.findByTestId('existing-brand-kit');
    fireEvent.change(selector, { target: { value: '42' } });

    // Wait for the detail fetch + UI update.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/brand-kits/42');
    });

    fireEvent.change(screen.getByTestId('brochure-goal'), { target: { value: '5-day Goa trip.' } });
    fireEvent.click(screen.getByTestId('generate-brochure'));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find((c) => c[0] === '/api/travel/brochures/runs' && c[1]?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.existingBrandKitId).toBe(42);
      expect(body.brand.logoUrl).toBe('/uploads/brand-kits/1/_default/logo.png');
      expect(body.brand.colors.accent).toBe('#0e6b4f');
      expect(body.brand.contact).toContain('+91 98765 43210');
      expect(body.brand.socials).toContain('instagram');
    });
  });

  it('shows the full brand-kit colour palette and lets the user pick a different accent', async () => {
    renderPage();
    await screen.findByTestId('cost-estimate');
    fireEvent.click(screen.getByText(/Brand Kit/i));
    const selector = await screen.findByTestId('existing-brand-kit');
    fireEvent.change(selector, { target: { value: '42' } });

    await waitFor(() => {
      expect(screen.getByLabelText('Use Primary colour')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Use Primary colour'));
    fireEvent.change(screen.getByTestId('brochure-goal'), { target: { value: '5-day Goa trip.' } });
    fireEvent.click(screen.getByTestId('generate-brochure'));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find((c) => c[0] === '/api/travel/brochures/runs' && c[1]?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.brand.colors.accent).toBe('#265855');
    });
  });

  it('pastes the empty structured template when the Template chip is clicked', async () => {
    renderPage();
    await screen.findByTestId('cost-estimate');
    fireEvent.click(screen.getByRole('button', { name: /^Template$/ }));
    const goal = screen.getByTestId('brochure-goal');
    expect(goal.value).toContain('AGENCY:');
    expect(goal.value).toContain('[TYPE]');
    expect(goal.value).toContain('DAY BY DAY:');
  });
});
