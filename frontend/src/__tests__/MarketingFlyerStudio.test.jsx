/**
 * MarketingFlyerStudio.test.jsx — vitest + RTL coverage for the
 * Phase 2 composer page (frontend/src/pages/travel/MarketingFlyerStudio.jsx,
 * GH #908; PRD docs/PRD_TRAVEL_MARKETING_FLYER.md).
 *
 * Scope: pins the prior SHELL invariants (heading, 4 sub-brand placeholder
 * cards matching the canonical id set from utils/travelSubBrand.js + the
 * RoleGuard RBAC gate) PLUS the slice-5 load+save lifecycle wiring against
 * /api/travel/flyer-templates (backend slice 3 commit 5c2dd474):
 *   - Mount with ?template=<id> in the URL fires GET /api/travel/flyer-templates/:id
 *   - Loaded-template metadata renders in the "Editing: <name>" banner
 *   - Composer state seeds from the response's paletteJson/layoutJson/assetsJson
 *     (JSON-string @db.Text columns parsed via JSON.parse)
 *   - "Save as Template" button opens the modal
 *   - Empty name → notify.error, no POST fires
 *   - Submit POSTs JSON-serialized palette/layout/assets + closes modal
 *   - URL updates to ?template=<newId> on save success (best-effort)
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - useActiveSubBrand mocked at `../utils/subBrand` with a STABLE
 *     module-level object reference (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap dep identity and
 *     infinite-re-render-hang the test). The mock value is mutated
 *     via .mockReturnValue() per-test, not by replacing the object.
 *   - useNotify mocked with a stable notify object (single instance used
 *     by every render — `useNotify: () => notifyObj`).
 *   - fetchApi mocked at `../utils/api` — per-test setup uses
 *     `fetchApiMock.mockResolvedValueOnce(...)` to script GET + POST outcomes.
 *   - useSearchParams + useNavigate from react-router-dom mocked with
 *     stable references — setSearchParamsMock is a vi.fn() that captures
 *     the URL-update side effect for assertion.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt's "?template=42 fires GET" — implementation parses the param
 *     via searchParams.get('template') (react-router-dom v6's hook); the
 *     mock returns a URLSearchParams-like object so .get('template')
 *     resolves correctly.
 *   - Prompt's "modal validation: empty name → notify.error, no POST" —
 *     the SUT short-circuits before fetchApi fires; assert fetchApi was
 *     never called AND notify.error fired with the canonical "name is
 *     required" copy.
 *   - Prompt's "URL update on save" — best-effort via setSearchParams; the
 *     mock captures the call args so the test can assert the URL was set
 *     to { template: '<newId>' }.
 *
 * Test cases (14 total — 6 prior SHELL + 8 new slice-5):
 *   Prior SHELL (kept):
 *     1. Heading + subtitle render.
 *     2. 4 sub-brand cards present.
 *     3. "Coming soon" overlay on every card.
 *     4. Active sub-brand visually highlighted.
 *     5. RoleGuard gate — USER blocked, ADMIN/MANAGER pass.
 *     6. Null active sub-brand renders without throwing.
 *   Slice 5 (new):
 *     7. Mount without ?template= does NOT fire GET.
 *     8. Mount with ?template=42 fires GET /api/travel/flyer-templates/42.
 *     9. Loaded-template banner renders the template name.
 *    10. "Save as Template" button renders + opens the modal on click.
 *    11. Modal empty-name submit → notify.error fired, no POST.
 *    12. Modal submit with name POSTs JSON-serialized palette/layout/assets.
 *    13. Successful POST closes the modal + updates URL to ?template=<newId>.
 *    14. 5xx (load + save) surfaces gracefully — composer stays mounted; for
 *        save, modal stays open so the operator can retry.
 *
 * Path: flat frontend/src/__tests__/MarketingFlyerStudio.test.jsx —
 * matches sibling subBrand.test.jsx + RoleGuard.test.jsx + Drugs.test.jsx
 * flat-path convention.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Stable mock impl for useActiveSubBrand — per-test setup uses
// `activeSubBrandMockImpl.mockReturnValue(...)` so the returned object
// reference stays controlled but the value can vary. The module mock
// always returns the SAME function reference, satisfying the RTL
// stable-mock-object standing rule.
const activeSubBrandMockImpl = vi.fn(() => ({ activeSubBrand: null, setActiveSubBrand: () => {} }));
vi.mock('../utils/subBrand', () => ({
  useActiveSubBrand: () => activeSubBrandMockImpl(),
}));

// notify mock kept stable — single object reference across all renders.
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
  prompt: () => Promise.resolve(''),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => React.createElement(React.Fragment, null, children),
}));

// fetchApi mocked — every test scripts its own GET/POST outcomes.
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// useSearchParams + useNavigate mocked — STABLE references for both the
// params object and the setSearchParams callback so RTL doesn't flap
// dependency identity across renders.
let mockSearchParamsString = '';
const setSearchParamsMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useSearchParams: () => [
      new URLSearchParams(mockSearchParamsString),
      setSearchParamsMock,
    ],
  };
});

import { AuthContext } from '../App';
import RoleGuard from '../components/RoleGuard';
import MarketingFlyerStudio from '../pages/travel/MarketingFlyerStudio';

function renderStudio({ role = 'MANAGER', wrapInRoleGuard = false } = {}) {
  const user = { userId: 1, name: 'Asha Marketer', email: 'a@x.test', role };
  const studio = wrapInRoleGuard ? (
    <RoleGuard allow={['ADMIN', 'MANAGER']} feature="Marketing Flyer Studio">
      <MarketingFlyerStudio />
    </RoleGuard>
  ) : (
    <MarketingFlyerStudio />
  );
  return render(
    <AuthContext.Provider value={{ user, token: 'tk', tenant: { vertical: 'travel' }, loading: false }}>
      <MemoryRouter>{studio}</MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  // Reset every mock between tests so per-test setup is explicit.
  activeSubBrandMockImpl.mockReset();
  activeSubBrandMockImpl.mockReturnValue({ activeSubBrand: null, setActiveSubBrand: () => {} });
  notifyObj.error.mockReset();
  notifyObj.info.mockReset();
  notifyObj.success.mockReset();
  fetchApiMock.mockReset();
  setSearchParamsMock.mockReset();
  mockSearchParamsString = '';
});

describe('MarketingFlyerStudio — SHELL surface', () => {
  it('renders the "Marketing Flyer Studio" heading + subtitle', () => {
    renderStudio();
    expect(screen.getByRole('heading', { level: 1, name: /marketing flyer studio/i })).toBeTruthy();
    // Subtitle mentions all 4 sub-brand labels — pin one of them as a
    // representative anchor for the subtitle's presence.
    expect(screen.getByText(/TMC \/ RFU \/ Travel Stall \/ Visa Sure/i)).toBeTruthy();
  });

  it('renders 4 sub-brand placeholder cards (tmc / rfu / travelstall / visasure)', () => {
    renderStudio();
    const ids = ['tmc', 'rfu', 'travelstall', 'visasure'];
    for (const id of ids) {
      const card = screen.getByTestId(`flyer-card-${id}`);
      expect(card).toBeTruthy();
      expect(card.getAttribute('data-sub-brand')).toBe(id);
    }
    // Container has exactly 4 cards — exact count guards against
    // accidental drift if a 5th sub-brand is added without updating the
    // canonical VALID_SUB_BRANDS set.
    const cards = screen.getByTestId('marketing-flyer-studio-cards').querySelectorAll('[data-sub-brand]');
    expect(cards.length).toBe(4);
  });

  it('shows a "Coming soon" overlay affordance on every sub-brand card', () => {
    renderStudio();
    const ids = ['tmc', 'rfu', 'travelstall', 'visasure'];
    for (const id of ids) {
      const overlay = screen.getByTestId(`flyer-card-${id}-coming-soon`);
      expect(overlay).toBeTruthy();
      // Overlay carries the literal "Coming soon" copy.
      expect(overlay.textContent || '').toMatch(/coming soon/i);
    }
  });

  it('visually highlights the active sub-brand card (data-active + aria-current)', () => {
    activeSubBrandMockImpl.mockReturnValue({ activeSubBrand: 'rfu', setActiveSubBrand: () => {} });
    renderStudio();
    const rfuCard = screen.getByTestId('flyer-card-rfu');
    expect(rfuCard.getAttribute('data-active')).toBe('true');
    expect(rfuCard.getAttribute('aria-current')).toBe('true');

    // Non-active cards remain data-active='false' with no aria-current.
    for (const id of ['tmc', 'travelstall', 'visasure']) {
      const card = screen.getByTestId(`flyer-card-${id}`);
      expect(card.getAttribute('data-active')).toBe('false');
      expect(card.getAttribute('aria-current')).toBeNull();
    }
  });

  it('RoleGuard gate — USER role renders the lock panel; ADMIN/MANAGER render the studio', () => {
    // USER role: lock panel renders, studio chrome absent.
    const { unmount } = renderStudio({ role: 'USER', wrapInRoleGuard: true });
    expect(screen.getByTestId('role-guard-locked-panel')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: /marketing flyer studio/i })).toBeNull();
    expect(screen.queryByTestId('marketing-flyer-studio')).toBeNull();
    unmount();

    // MANAGER role: studio mounts, lock panel absent.
    const managerRender = renderStudio({ role: 'MANAGER', wrapInRoleGuard: true });
    expect(screen.getByTestId('marketing-flyer-studio')).toBeTruthy();
    expect(screen.queryByTestId('role-guard-locked-panel')).toBeNull();
    managerRender.unmount();

    // ADMIN role: studio mounts, lock panel absent.
    renderStudio({ role: 'ADMIN', wrapInRoleGuard: true });
    expect(screen.getByTestId('marketing-flyer-studio')).toBeTruthy();
    expect(screen.queryByTestId('role-guard-locked-panel')).toBeNull();
  });

  it('renders without throwing when activeSubBrand is null (no card highlighted)', () => {
    activeSubBrandMockImpl.mockReturnValue({ activeSubBrand: null, setActiveSubBrand: () => {} });
    expect(() => renderStudio()).not.toThrow();
    // Heading mounts.
    expect(screen.getByRole('heading', { level: 1, name: /marketing flyer studio/i })).toBeTruthy();
    // All 4 cards mount with data-active='false' (no highlight).
    for (const id of ['tmc', 'rfu', 'travelstall', 'visasure']) {
      const card = screen.getByTestId(`flyer-card-${id}`);
      expect(card.getAttribute('data-active')).toBe('false');
      expect(card.getAttribute('aria-current')).toBeNull();
    }
    // Defensive — within() resolves the cards container so the test
    // double-checks the scope is what we expect.
    const container = screen.getByTestId('marketing-flyer-studio-cards');
    expect(within(container).getAllByText(/coming soon/i).length).toBeGreaterThanOrEqual(4);
  });
});

describe('MarketingFlyerStudio — slice 5 load + save template wiring', () => {
  it('mount without ?template= does NOT fire a GET', () => {
    mockSearchParamsString = '';
    renderStudio();
    // No load triggered — fetchApi never called.
    expect(fetchApiMock).not.toHaveBeenCalled();
    // Scaffold banner shown instead of loaded-template banner.
    expect(screen.queryByTestId('loaded-template-banner')).toBeNull();
    expect(screen.queryByTestId('loading-template')).toBeNull();
  });

  it('mount with ?template=42 fires GET /api/travel/flyer-templates/42', async () => {
    mockSearchParamsString = 'template=42';
    fetchApiMock.mockResolvedValueOnce({
      id: 42,
      name: 'Summer Europe Pack',
      subBrand: 'tmc',
      paletteJson: JSON.stringify({
        primaryHex: '#112233',
        secondaryHex: '#445566',
        accentHex: '#778899',
        textHex: '#000000',
        bgHex: '#FFFFFF',
      }),
      layoutJson: JSON.stringify([
        { type: 'text', x: 0, y: 0, width: 100, height: 40, content: 'Hello' },
      ]),
      assetsJson: JSON.stringify({ logo: '/uploads/tmc-logo.png' }),
    });
    renderStudio();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/travel/flyer-templates/42');
    });
  });

  it('loaded-template banner renders the template name after successful GET', async () => {
    mockSearchParamsString = 'template=7';
    fetchApiMock.mockResolvedValueOnce({
      id: 7,
      name: 'Ramadan Umrah Bronze',
      subBrand: 'rfu',
      paletteJson: JSON.stringify({
        primaryHex: '#0A1A2B',
        secondaryHex: '#1B2C3D',
        textHex: '#222222',
        bgHex: '#F5F5F5',
      }),
      layoutJson: JSON.stringify([
        { type: 'text', x: 10, y: 20, width: 200, height: 50, content: 'Ramadan 2026' },
      ]),
      assetsJson: null,
    });
    renderStudio();
    const banner = await screen.findByTestId('loaded-template-banner');
    expect(banner).toBeTruthy();
    expect(banner.textContent || '').toMatch(/Ramadan Umrah Bronze/);
    // notify.info fired with the load-success copy.
    expect(notifyObj.info).toHaveBeenCalledWith(expect.stringMatching(/loaded template/i));
  });

  it('"Save as Template" button renders + opens the modal on click', () => {
    renderStudio();
    const btn = screen.getByTestId('save-as-template-button');
    expect(btn).toBeTruthy();
    expect(screen.queryByTestId('save-template-modal')).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByTestId('save-template-modal')).toBeTruthy();
    expect(screen.getByTestId('save-template-name')).toBeTruthy();
    expect(screen.getByTestId('save-template-sub-brand')).toBeTruthy();
  });

  it('modal empty-name submit → notify.error fired, no POST', () => {
    renderStudio();
    fireEvent.click(screen.getByTestId('save-as-template-button'));
    const form = screen.getByTestId('save-template-form');
    // Name field is empty by default for a fresh composer. Submit anyway.
    fireEvent.submit(form);
    expect(notifyObj.error).toHaveBeenCalledWith(expect.stringMatching(/name.*required/i));
    expect(fetchApiMock).not.toHaveBeenCalled();
    // Modal stays open so the operator can fill in the name.
    expect(screen.queryByTestId('save-template-modal')).toBeTruthy();
  });

  it('modal submit with name POSTs JSON-serialized palette/layout/assets', async () => {
    fetchApiMock.mockResolvedValueOnce({
      id: 101,
      name: 'New Template',
      subBrand: 'tmc',
    });
    renderStudio();
    fireEvent.click(screen.getByTestId('save-as-template-button'));
    const nameInput = screen.getByTestId('save-template-name');
    fireEvent.change(nameInput, { target: { value: 'New Template' } });
    const subBrandSelect = screen.getByTestId('save-template-sub-brand');
    fireEvent.change(subBrandSelect, { target: { value: 'tmc' } });
    fireEvent.click(screen.getByTestId('save-template-submit'));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/travel/flyer-templates',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    // Pull out the body arg + assert it serialised palette/layout/assets.
    const [, options] = fetchApiMock.mock.calls[0];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.name).toBe('New Template');
    expect(parsedBody.subBrand).toBe('tmc');
    // paletteJson + layoutJson + assetsJson are JSON STRINGS (the @db.Text
    // contract per backend route parseJsonColumn).
    expect(typeof parsedBody.paletteJson).toBe('string');
    expect(typeof parsedBody.layoutJson).toBe('string');
    expect(typeof parsedBody.assetsJson).toBe('string');
    // The strings parse back into the expected shapes.
    const parsedPalette = JSON.parse(parsedBody.paletteJson);
    expect(typeof parsedPalette.primaryHex).toBe('string');
    expect(parsedPalette.primaryHex).toMatch(/^#[0-9a-fA-F]{6}$/);
    const parsedLayout = JSON.parse(parsedBody.layoutJson);
    expect(Array.isArray(parsedLayout)).toBe(true);
    expect(parsedLayout.length).toBeGreaterThan(0);
  });

  it('successful POST closes the modal + updates URL to ?template=<newId>', async () => {
    fetchApiMock.mockResolvedValueOnce({
      id: 123,
      name: 'Saved Template',
      subBrand: 'visasure',
    });
    renderStudio();
    fireEvent.click(screen.getByTestId('save-as-template-button'));
    fireEvent.change(screen.getByTestId('save-template-name'), {
      target: { value: 'Saved Template' },
    });
    fireEvent.click(screen.getByTestId('save-template-submit'));

    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalledWith(
        expect.stringMatching(/saved template/i),
      );
    });
    // Modal closed.
    expect(screen.queryByTestId('save-template-modal')).toBeNull();
    // URL update — the param is set to the new id as a string.
    expect(setSearchParamsMock).toHaveBeenCalledWith({ template: '123' });
  });

  it('5xx on save keeps the modal open so the operator can retry', async () => {
    const err = new Error('Server error');
    err.status = 500;
    fetchApiMock.mockRejectedValueOnce(err);
    renderStudio();
    fireEvent.click(screen.getByTestId('save-as-template-button'));
    fireEvent.change(screen.getByTestId('save-template-name'), {
      target: { value: 'Will Fail' },
    });
    fireEvent.click(screen.getByTestId('save-template-submit'));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
    // fetchApi auto-toasts the 5xx via global notify; the route-level
    // handler only re-toasts for non-HTTP errors, so notifyObj.error
    // is NOT fired again here. Critical contract: modal stays open +
    // submit button is enabled again so the operator can retry.
    expect(screen.queryByTestId('save-template-modal')).toBeTruthy();
    // No URL update on failure.
    expect(setSearchParamsMock).not.toHaveBeenCalled();
    // No success toast.
    expect(notifyObj.success).not.toHaveBeenCalled();
  });
});
