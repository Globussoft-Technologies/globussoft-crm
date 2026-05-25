/**
 * TenantSettings.test.jsx — vitest + RTL coverage for the admin per-tenant
 * budget-cap CRUD page (frontend/src/pages/admin/TenantSettings.jsx,
 * shipped tick #100 commit 0054a03, 411 LOC).
 *
 * Scope: pins the page-surface invariants for the per-tenant cap override UI:
 *   1. Loading state: renders "Loading tenant settings…" before the first
 *      fetch resolves.
 *   2. Page chrome on mount: heading "Tenant Settings" + a card per known
 *      cap key (4 — AdsGPT / AI calling / RateHawk / LLM).
 *   3. GET on mount: fetches /api/tenant-settings exactly once.
 *   4. Override badge — rows that are present in the response render the
 *      "Override" badge; rows absent render the "Default" badge.
 *   5. Dollar↔cent boundary: an override row with value="5000" cents renders
 *      its Current as "$50.00".
 *   6. Save flow: editing the input + clicking Save fires
 *      PUT /api/tenant-settings/<key> with body { value: "<cents-as-string>" }
 *      and the cents math (× 100, Math.round) round-trips correctly.
 *   7. Validation: typing a negative or non-numeric value and clicking Save
 *      surfaces notify.error and does NOT fire a PUT request.
 *   8. Save success: notify.success fires with the formatted dollar amount.
 *   9. Revert flow: clicking "Revert to default" on an override card calls
 *      notify.confirm; on confirm=true → DELETE /api/tenant-settings/<key>;
 *      on confirm=false → NO DELETE fires.
 *  10. Error handling on load: a rejected GET surfaces an error banner with
 *      the server-supplied error message + a Retry button.
 *  11. Save button is DISABLED when the input matches the current effective
 *      value (no dirty diff) and ENABLED after the input changes.
 *
 * Backend contract pinned (per backend/routes/tenant_settings.js):
 *   GET    /api/tenant-settings        → { settings:[{key,value,category}], defaults, allowedKeys }
 *   PUT    /api/tenant-settings/:key   { value: "<cents-as-string>", category? } → 200 envelope
 *   DELETE /api/tenant-settings/:key   → 204
 *
 * Why
 *   This admin page is the only human surface that touches the cents↔dollar
 *   boundary for the cross-cutting per-tenant cap pattern. A silent regression
 *   in the dollar→cents math (e.g. forgetting Math.round) would write the
 *   wrong cap value and silently let the consumer over-spend. The Save +
 *   validation + revert flow paths are load-bearing for ops correctness;
 *   the override-vs-default badge is load-bearing for "operator can tell
 *   at a glance which keys are overridden."
 *
 * Mocking discipline (per CLAUDE.md RTL standing rule):
 *   - fetchApi mocked at ../utils/api (the page's dependency surface, NOT
 *     global fetch).
 *   - notifyObj is a STABLE module-level object reference so the useNotify
 *     identity stays stable across renders (the SUT calls notify inside
 *     handler closures; an unstable identity would cause re-render flap).
 *   - confirmMock is the resolved value of notify.confirm — vi.fn() per
 *     test so the resolved boolean is controllable.
 *   - All data-dependent assertions use await findBy / waitFor (per CLAUDE.md
 *     tick #108 cron-learning: sync getBy for data-dependent text is a CI
 *     race trap).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object: the SUT's handleSave / handleRevert close over the
// notify reference inside useCallback-style handlers; a per-call fresh
// object would force re-renders and flap the dirty-diff state.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const confirmMock = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: confirmMock,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import TenantSettings from '../pages/admin/TenantSettings';

// Mirror backend/lib/tenantSettings.js KEYS + DEFAULTS for fixture purposes.
const KEY_ADSGPT = 'budgetCap_adsgpt_monthly_usd_cents';
const KEY_AI_CALL = 'budgetCap_ai_calling_monthly_usd_cents';
const KEY_RATEHAWK = 'budgetCap_ratehawk_monthly_usd_cents';
const KEY_LLM = 'budgetCap_llm_monthly_usd_cents';

const ALL_KEYS = [KEY_ADSGPT, KEY_AI_CALL, KEY_RATEHAWK, KEY_LLM];

// Default GET shape — empty settings array, defaults populated for all 4
// keys ($100/mo each = 10000 cents).
const DEFAULTS_FIXTURE = {
  [KEY_ADSGPT]: 10000,
  [KEY_AI_CALL]: 20000,
  [KEY_RATEHAWK]: 15000,
  [KEY_LLM]: 50000,
};

function makeListResponse(overrideRows = []) {
  return {
    settings: overrideRows,
    defaults: { ...DEFAULTS_FIXTURE },
    allowedKeys: ALL_KEYS,
  };
}

describe('<TenantSettings /> — admin per-tenant cap override UI', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    confirmMock.mockReset();
  });

  it('renders the loading state before the first GET resolves', () => {
    // Resolve the promise on a microtask after assertion — keeps the
    // component in its initial loading=true render long enough to verify.
    let resolveGet;
    fetchApiMock.mockImplementation(() => new Promise((resolve) => {
      resolveGet = resolve;
    }));
    render(<TenantSettings />);
    expect(screen.getByText(/Loading tenant settings…/i)).toBeInTheDocument();
    // Tidy up the dangling promise so the test runner doesn't warn.
    resolveGet?.(makeListResponse());
  });

  it('renders heading + 4 cap cards on mount; fires GET /api/tenant-settings once', async () => {
    fetchApiMock.mockResolvedValue(makeListResponse());
    render(<TenantSettings />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Tenant Settings/i })).toBeInTheDocument();
    });
    // Each known cap renders one card. Use data-testid to disambiguate.
    for (const key of ALL_KEYS) {
      expect(screen.getByTestId(`tenant-setting-card-${key}`)).toBeInTheDocument();
    }
    // GET fired exactly once with the canonical path (no method override =
    // default GET).
    expect(fetchApiMock).toHaveBeenCalledWith('/api/tenant-settings');
    const getCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/tenant-settings' && !opts,
    );
    expect(getCalls.length).toBe(1);
  });

  it('renders the "Override" badge for rows in settings[] and "Default" for absent rows', async () => {
    fetchApiMock.mockResolvedValue(
      makeListResponse([
        { key: KEY_ADSGPT, value: '5000', category: 'budget' },
      ]),
    );
    render(<TenantSettings />);
    // Wait for the AdsGPT card content to populate.
    const adsgptCard = await screen.findByTestId(`tenant-setting-card-${KEY_ADSGPT}`);
    expect(adsgptCard).toHaveTextContent(/Override/i);
    // The other 3 cards render the Default badge.
    for (const key of [KEY_AI_CALL, KEY_RATEHAWK, KEY_LLM]) {
      const card = screen.getByTestId(`tenant-setting-card-${key}`);
      expect(card).toHaveTextContent(/Default/i);
    }
  });

  it('renders an override row\'s value formatted as dollars ($50.00 for 5000 cents)', async () => {
    fetchApiMock.mockResolvedValue(
      makeListResponse([
        { key: KEY_ADSGPT, value: '5000', category: 'budget' },
      ]),
    );
    render(<TenantSettings />);
    const adsgptCard = await screen.findByTestId(`tenant-setting-card-${KEY_ADSGPT}`);
    // "Current" section renders "$50.00" for 5000 cents.
    expect(adsgptCard).toHaveTextContent('$50.00');
    // Input is also hydrated to "50.00" so a click-through Save without
    // changes is a no-op (Save disabled when isDirty=false).
    const input = screen.getByTestId(`tenant-setting-input-${KEY_ADSGPT}`);
    expect(input.value).toBe('50.00');
  });

  it('Save flow: editing the input + clicking Save fires PUT with cents-as-string body', async () => {
    fetchApiMock.mockResolvedValue(makeListResponse());
    render(<TenantSettings />);
    const input = await screen.findByTestId(`tenant-setting-input-${KEY_ADSGPT}`);
    // Change from default ($100.00 = 10000 cents) to $75.50 = 7550 cents.
    fireEvent.change(input, { target: { value: '75.50' } });

    // Now Save should be enabled — click it.
    fetchApiMock.mockClear();
    // First call: the PUT itself.
    // Second call: the load() refresh after success.
    fetchApiMock
      .mockResolvedValueOnce({
        key: KEY_ADSGPT,
        value: '7550',
        defaultValue: 10000,
        isOverride: true,
        category: 'budget',
      })
      .mockResolvedValueOnce(makeListResponse([
        { key: KEY_ADSGPT, value: '7550', category: 'budget' },
      ]));

    const saveBtn = screen.getByTestId(`tenant-setting-save-${KEY_ADSGPT}`);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === `/api/tenant-settings/${KEY_ADSGPT}` && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      // Math.round(75.50 * 100) = 7550 — round-trip dollar→cent.
      expect(body.value).toBe('7550');
    });
  });

  it('Save success surfaces notify.success with the formatted dollar amount', async () => {
    fetchApiMock.mockResolvedValue(makeListResponse());
    render(<TenantSettings />);
    const input = await screen.findByTestId(`tenant-setting-input-${KEY_ADSGPT}`);
    fireEvent.change(input, { target: { value: '42.00' } });

    fetchApiMock.mockClear();
    fetchApiMock
      .mockResolvedValueOnce({
        key: KEY_ADSGPT,
        value: '4200',
        defaultValue: 10000,
        isOverride: true,
        category: 'budget',
      })
      .mockResolvedValueOnce(makeListResponse([
        { key: KEY_ADSGPT, value: '4200', category: 'budget' },
      ]));

    fireEvent.click(screen.getByTestId(`tenant-setting-save-${KEY_ADSGPT}`));

    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalled();
      const msg = notifySuccess.mock.calls[0][0];
      expect(msg).toMatch(/\$42\.00\/mo/);
    });
  });

  it('Validation: empty / non-numeric input → notify.error fires, no PUT is sent', async () => {
    fetchApiMock.mockResolvedValue(makeListResponse());
    render(<TenantSettings />);
    const input = await screen.findByTestId(`tenant-setting-input-${KEY_ADSGPT}`);
    // Replace with a clearly-invalid value. The SUT's dollarStringToCents
    // strips non-numerics; an empty post-strip string parses to NaN → null.
    fireEvent.change(input, { target: { value: 'abc' } });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByTestId(`tenant-setting-save-${KEY_ADSGPT}`));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
      expect(notifyError.mock.calls[0][0]).toMatch(/Invalid amount/i);
    });
    // No PUT request was issued.
    const putCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        url === `/api/tenant-settings/${KEY_ADSGPT}` && opts?.method === 'PUT',
    );
    expect(putCalls.length).toBe(0);
  });

  it('Revert flow: confirm=true → DELETE fires; confirm=false → NO DELETE fires', async () => {
    fetchApiMock.mockResolvedValue(
      makeListResponse([
        { key: KEY_ADSGPT, value: '5000', category: 'budget' },
      ]),
    );
    render(<TenantSettings />);
    // Wait for the Revert button to appear (only renders on override rows).
    const revertBtn = await screen.findByTestId(`tenant-setting-revert-${KEY_ADSGPT}`);

    // First click: user cancels the confirm dialog.
    confirmMock.mockResolvedValueOnce(false);
    fetchApiMock.mockClear();
    fireEvent.click(revertBtn);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    // No DELETE fired because confirm returned false.
    const cancelledDeletes = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        url === `/api/tenant-settings/${KEY_ADSGPT}` && opts?.method === 'DELETE',
    );
    expect(cancelledDeletes.length).toBe(0);

    // Second click: user confirms.
    confirmMock.mockResolvedValueOnce(true);
    fetchApiMock
      .mockResolvedValueOnce(true) // the DELETE itself (fetchApi returns true on 204)
      .mockResolvedValueOnce(makeListResponse()); // post-delete refresh
    fireEvent.click(revertBtn);
    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === `/api/tenant-settings/${KEY_ADSGPT}` && opts?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it('Load error: rejected GET renders an error banner with the server message + Retry button', async () => {
    const err = new Error('Failed to list tenant settings');
    fetchApiMock.mockRejectedValueOnce(err);
    render(<TenantSettings />);
    await waitFor(() => {
      expect(screen.getByText('Failed to list tenant settings')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
    // Clicking Retry re-fires the GET.
    fetchApiMock.mockClear();
    fetchApiMock.mockResolvedValueOnce(makeListResponse());
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/tenant-settings');
    });
  });

  it('Save button disabled when input matches effective value; enabled after edit', async () => {
    fetchApiMock.mockResolvedValue(
      makeListResponse([
        { key: KEY_ADSGPT, value: '5000', category: 'budget' },
      ]),
    );
    render(<TenantSettings />);
    const input = await screen.findByTestId(`tenant-setting-input-${KEY_ADSGPT}`);
    // Hydrated to "50.00" matching the override (5000 cents). Save is
    // disabled because !isDirty.
    const saveBtn = screen.getByTestId(`tenant-setting-save-${KEY_ADSGPT}`);
    expect(saveBtn).toBeDisabled();

    // Edit → dirty → Save enables.
    fireEvent.change(input, { target: { value: '60.00' } });
    expect(saveBtn).not.toBeDisabled();
  });
});
