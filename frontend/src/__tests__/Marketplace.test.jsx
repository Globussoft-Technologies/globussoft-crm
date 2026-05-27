/**
 * Marketplace.test.jsx — vitest + RTL coverage for the Enterprise App
 * Marketplace page (frontend/src/pages/Marketplace.jsx, 82 LOC).
 *
 * The page is a small, mostly-hardcoded catalog of 4 third-party
 * integrations (Slack / Google Workspace / Stripe Billing / Mailchimp).
 * It fetches the current integration state from the backend on mount,
 * then renders an "Initiate OAuth Handshake" / "Integrated securely"
 * toggle per app. The toggle button POSTs the inverted active-state to
 * /api/integrations/toggle and reloads the list.
 *
 * Scope — pins the page-surface invariants:
 *   1. Smoke render — all four hardcoded app cards render with their
 *      brand names (Slack Native / Google Workspace / Stripe Billing /
 *      Mailchimp) and the page heading.
 *   2. Initial mount fires GET /api/integrations exactly once.
 *   3. Empty integrations list: every app card surfaces the
 *      "Initiate OAuth Handshake" CTA (no "Authenticated" badge).
 *   4. Loaded integrations with slack as active: the Slack card flips to
 *      the "Integrated securely" CTA + renders the "Authenticated"
 *      badge; the other three cards stay on "Initiate OAuth Handshake".
 *   5. Clicking "Initiate OAuth Handshake" on the Slack card (currently
 *      inactive) fires POST /api/integrations/toggle with body
 *      { provider: 'slack', isActive: true } (toggle inverts the
 *      installed state — undefined-as-falsy → true).
 *   6. Clicking "Integrated securely" on an active card fires the
 *      inverse toggle — body { provider: 'slack', isActive: false }
 *      because the page passes the toggle the currently-active record
 *      and negates it.
 *   7. Toggle endpoint failure surfaces notify.error with the literal
 *      "Encountered OAuth Handshake constraint." copy.
 *   8. Defensive: fetchApi('/api/integrations') returning a non-array
 *      (null / object / undefined) does NOT crash the page — all four
 *      cards still render in their default "Initiate OAuth Handshake"
 *      state. (Pinned because the SUT guards with
 *      `Array.isArray(data) ? data : []`.)
 *
 * Backend contracts pinned (1 list + 1 mutation):
 *   GET  /api/integrations
 *   POST /api/integrations/toggle    body { provider, isActive }
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules)
 *   - fetchApi mocked at ../utils/api (only API surface the SUT touches).
 *   - useNotify mocked at ../utils/notify (this codebase's convention —
 *     notify lives in utils/, not hooks/) with a stable notifyObj
 *     reference. Recreating { error, info, success, confirm } per call
 *     would land a fresh dep identity into any downstream useCallback
 *     chain and re-render-loop the test until vitest's per-test timeout
 *     fires. Marketplace itself doesn't currently useCallback, but the
 *     stable-ref pattern is the canonical project default.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object reference — see file header for the why.
const notifyError = vi.fn();
const notifyObj = {
  error: (...args) => notifyError(...args),
  info: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn().mockResolvedValue(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import Marketplace from '../pages/Marketplace';

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
});

/**
 * Helper — wire fetchApiMock so:
 *   - GET  /api/integrations          → resolves with `integrations`
 *   - POST /api/integrations/toggle   → resolves (or rejects) per arg
 */
function wireFetch({ integrations = [], toggleReject = false } = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/integrations' && (!opts || !opts.method)) {
      return Promise.resolve(integrations);
    }
    if (url === '/api/integrations/toggle' && opts?.method === 'POST') {
      return toggleReject
        ? Promise.reject(new Error('toggle failed'))
        : Promise.resolve({ ok: true });
    }
    return Promise.resolve(null);
  });
}

describe('Marketplace page', () => {
  it('smoke renders the page header + 4 app cards by name', async () => {
    wireFetch({ integrations: [] });
    render(<Marketplace />);

    expect(
      await screen.findByRole('heading', { name: /Enterprise App Marketplace/i }),
    ).toBeTruthy();

    // All 4 hardcoded apps surface with their full brand name.
    expect(await screen.findByText(/Slack Native/i)).toBeTruthy();
    expect(screen.getByText(/Google Workspace/i)).toBeTruthy();
    expect(screen.getByText(/Stripe Billing/i)).toBeTruthy();
    expect(screen.getByText(/^Mailchimp$/i)).toBeTruthy();
  });

  it('fires GET /api/integrations on initial mount', async () => {
    wireFetch({ integrations: [] });
    render(<Marketplace />);

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/integrations');
    });
  });

  it('empty integrations list → all 4 cards show "Initiate OAuth Handshake"', async () => {
    wireFetch({ integrations: [] });
    render(<Marketplace />);

    // Wait for the initial fetch to settle.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/integrations');
    });

    const initiateButtons = await screen.findAllByRole('button', {
      name: /Initiate OAuth Handshake/i,
    });
    expect(initiateButtons.length).toBe(4);
    // No "Authenticated" badges in the empty state.
    expect(screen.queryByText(/^Authenticated$/i)).toBeNull();
  });

  it('slack active → Slack card flips to "Integrated securely" + "Authenticated" badge; others stay default', async () => {
    wireFetch({
      integrations: [{ provider: 'slack', isActive: true }],
    });
    render(<Marketplace />);

    // Slack card flipped to the integrated CTA.
    expect(
      await screen.findByRole('button', { name: /Integrated securely/i }),
    ).toBeTruthy();
    // And the Authenticated badge renders exactly once (for the Slack card).
    const badges = await screen.findAllByText(/^Authenticated$/);
    expect(badges.length).toBe(1);
    // The remaining 3 cards stay on the default "Initiate" CTA.
    const initiateButtons = screen.getAllByRole('button', {
      name: /Initiate OAuth Handshake/i,
    });
    expect(initiateButtons.length).toBe(3);
  });

  it('clicking "Initiate OAuth Handshake" on Slack fires POST /api/integrations/toggle with { provider: "slack", isActive: true } + reloads', async () => {
    wireFetch({ integrations: [] });
    render(<Marketplace />);

    // Wait for the page to settle into the empty state.
    const slackInitiate = await screen.findAllByRole('button', {
      name: /Initiate OAuth Handshake/i,
    });
    expect(slackInitiate.length).toBe(4);

    fetchApiMock.mockClear();
    // Re-wire so the post-toggle reload still resolves.
    wireFetch({ integrations: [] });

    // Slack is the first hardcoded app — click its Initiate button.
    fireEvent.click(slackInitiate[0]);

    await waitFor(() => {
      // Toggle POST fired with the inverted state.
      const toggleCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/integrations/toggle',
      );
      expect(toggleCall).toBeTruthy();
      expect(toggleCall[1].method).toBe('POST');
      expect(JSON.parse(toggleCall[1].body)).toEqual({
        provider: 'slack',
        isActive: true,
      });
    });

    // Reload (GET /api/integrations) also fires after the POST.
    await waitFor(() => {
      const reloadCalls = fetchApiMock.mock.calls.filter(
        (c) => c[0] === '/api/integrations',
      );
      expect(reloadCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('clicking "Integrated securely" on an active card fires toggle with { isActive: false } (negation)', async () => {
    wireFetch({
      integrations: [{ provider: 'slack', isActive: true }],
    });
    render(<Marketplace />);

    const integratedBtn = await screen.findByRole('button', {
      name: /Integrated securely/i,
    });

    fetchApiMock.mockClear();
    wireFetch({
      integrations: [{ provider: 'slack', isActive: true }],
    });

    fireEvent.click(integratedBtn);

    await waitFor(() => {
      const toggleCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/integrations/toggle',
      );
      expect(toggleCall).toBeTruthy();
      const body = JSON.parse(toggleCall[1].body);
      expect(body.provider).toBe('slack');
      // SUT logic: `!currentState` where currentState is the truthy installed
      // record → false.
      expect(body.isActive).toBe(false);
    });
  });

  it('toggle endpoint failure → notify.error("Encountered OAuth Handshake constraint.")', async () => {
    wireFetch({ integrations: [], toggleReject: true });
    render(<Marketplace />);

    const slackInitiate = await screen.findAllByRole('button', {
      name: /Initiate OAuth Handshake/i,
    });
    fireEvent.click(slackInitiate[0]);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        'Encountered OAuth Handshake constraint.',
      );
    });
  });

  it('non-array /integrations response (null) → page does not crash; all 4 cards stay in default state', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/integrations') return Promise.resolve(null);
      return Promise.resolve(null);
    });

    render(<Marketplace />);

    // Header still renders.
    expect(
      await screen.findByRole('heading', { name: /Enterprise App Marketplace/i }),
    ).toBeTruthy();
    // All four cards in default state — guard `Array.isArray(data) ? data : []`
    // kept the integrations state as []. No Authenticated badge.
    const initiateButtons = await screen.findAllByRole('button', {
      name: /Initiate OAuth Handshake/i,
    });
    expect(initiateButtons.length).toBe(4);
    expect(screen.queryByText(/^Authenticated$/)).toBeNull();
  });
});
