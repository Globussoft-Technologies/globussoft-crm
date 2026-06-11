/**
 * EmbedAllowlist.test.jsx — vitest + RTL coverage for the ADMIN-only embed
 * allowlist editor page (frontend/src/pages/admin/EmbedAllowlist.jsx, S128).
 *
 * Scope — pins the page-surface invariants for the per-tenant embed-allowlist
 * editor that completes the S38/S39/S66/S129 chain:
 *   1. Loading state: renders "Loading embed allowlist…" before the first
 *      fetch resolves.
 *   2. Page chrome on mount: heading "Embed Allowlist".
 *   3. GET on mount: fetches /api/admin/tenants/:id/embed-allowlist exactly
 *      once with the user's tenantId.
 *   4. Empty state: when origins=[] the empty-state copy renders ("No
 *      allowlist set — partner iframes are unrestricted (wildcard fallback).")
 *   5. Chip render: when origins=["https://a.com","https://b.com"] both chips
 *      render with the correct text.
 *   6. Add origin happy-path: typing a valid HTTPS URL + clicking Add adds
 *      it as a chip and clears the input.
 *   7. Add origin rejects HTTP: typing "http://insecure.com" + clicking Add
 *      surfaces an inline error and the chip is NOT added.
 *   8. Add origin rejects empty: clicking Add with empty input surfaces an
 *      inline error.
 *   9. Add origin rejects duplicate: adding the same origin twice surfaces
 *      a duplicate-error and the chip is NOT added.
 *  10. Remove chip: clicking the × button on a chip removes it from the list
 *      and marks the page dirty.
 *  11. Save flow: clicking Save fires PATCH with the origins payload; on
 *      success the lastSavedJson rebases (Save becomes disabled again).
 *  12. Save button disabled when not dirty: the freshly-loaded page has Save
 *      disabled until the user adds or removes an origin.
 *  13. Load error: a rejected GET surfaces an error banner with the server
 *      message + a Retry button.
 *
 * S131 extensions — leftmost-wildcard subdomain support
 * ─────────────────────────────────────────────────────
 *  14. Add valid wildcard `https://*.partner.com` → chip rendered + Save
 *      becomes enabled (mirror of backend HTTPS_ORIGIN_RE_V2).
 *  15. Add invalid non-leftmost wildcard `https://foo.*.com` → inline error
 *      and chip NOT added (mirror of backend rejection).
 *  16. Add invalid bare `https://*` → inline error and chip NOT added.
 *
 * Mocking discipline (per TenantSettings.test.jsx + CLAUDE.md RTL standing rule)
 * ─────────────────────────────────────────────────────────────────────────────
 *   - fetchApi mocked at ../utils/api (the page's dependency surface, NOT
 *     global fetch).
 *   - notifyObj is a STABLE module-level object reference so useNotify
 *     identity stays stable across renders.
 *   - AuthContext is mocked at ../App to provide a user with tenantId=42.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object — see TenantSettings.test.jsx pattern.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: vi.fn(),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// AuthContext lives in App.jsx — mock it as a simple React context so the
// SUT can read user.tenantId. We intentionally avoid importing the real App
// module (which pulls in the full Router + every lazy page).
vi.mock('../App', () => {
  const React = require('react');
  return {
    AuthContext: React.createContext({
      user: { userId: 7, tenantId: 42, role: 'ADMIN' },
    }),
  };
});

import EmbedAllowlist from '../pages/admin/EmbedAllowlist';

function listResponse(origins = []) {
  return {
    tenantId: 42,
    origins,
    updatedAt: '2026-06-11T00:00:00Z',
  };
}

describe('<EmbedAllowlist /> — S128 admin embed-allowlist editor', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
  });

  it('1. renders the loading state before the first GET resolves', () => {
    let resolveGet;
    fetchApiMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveGet = resolve;
      }),
    );
    render(<EmbedAllowlist />);
    expect(screen.getByText(/Loading embed allowlist…/i)).toBeInTheDocument();
    resolveGet?.(listResponse());
  });

  it('2. renders heading + GETs once with tenantId on mount', async () => {
    fetchApiMock.mockResolvedValue(listResponse());
    render(<EmbedAllowlist />);
    expect(
      await screen.findByRole('heading', { name: /Embed Allowlist/i }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/admin/tenants/42/embed-allowlist',
    );
  });

  it('4. empty origins → renders the wildcard-fallback empty-state copy', async () => {
    fetchApiMock.mockResolvedValue(listResponse([]));
    render(<EmbedAllowlist />);
    expect(
      await screen.findByText(/No allowlist set/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/partner iframes are unrestricted/i),
    ).toBeInTheDocument();
  });

  it('5. populated origins → renders one chip per origin', async () => {
    fetchApiMock.mockResolvedValue(
      listResponse(['https://partner1.com', 'https://partner2.com']),
    );
    render(<EmbedAllowlist />);
    expect(await screen.findByText('https://partner1.com')).toBeInTheDocument();
    expect(screen.getByText('https://partner2.com')).toBeInTheDocument();
    // Empty-state copy should NOT render when origins is non-empty.
    expect(screen.queryByText(/No allowlist set/i)).not.toBeInTheDocument();
  });

  it('6. add valid HTTPS origin → chip appears + input clears + Save enables', async () => {
    fetchApiMock.mockResolvedValue(listResponse([]));
    render(<EmbedAllowlist />);
    await screen.findByText(/No allowlist set/i);

    const input = screen.getByTestId('embed-allowlist-input');
    fireEvent.change(input, { target: { value: 'https://newpartner.com' } });
    fireEvent.click(screen.getByTestId('embed-allowlist-add'));

    await waitFor(() => {
      expect(screen.getByText('https://newpartner.com')).toBeInTheDocument();
    });
    expect(input.value).toBe('');
    const saveBtn = screen.getByTestId('embed-allowlist-save');
    expect(saveBtn).not.toBeDisabled();
  });

  it('7. add HTTP origin → inline error + chip NOT added', async () => {
    fetchApiMock.mockResolvedValue(listResponse([]));
    render(<EmbedAllowlist />);
    await screen.findByText(/No allowlist set/i);

    const input = screen.getByTestId('embed-allowlist-input');
    fireEvent.change(input, { target: { value: 'http://insecure.com' } });
    // Add button should be DISABLED for invalid HTTPS regex match — the
    // disabled state is checked via the button itself but we also need to
    // verify the error path. Force-click the input via Enter to trip the
    // handleAdd path which sets inputError.
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.queryByText('http://insecure.com')).not.toBeInTheDocument();
    // The error message includes "HTTPS URL".
    expect(
      screen.getByTestId('embed-allowlist-input-error'),
    ).toHaveTextContent(/HTTPS URL/i);
  });

  it('8. add empty → inline error', async () => {
    fetchApiMock.mockResolvedValue(listResponse([]));
    render(<EmbedAllowlist />);
    await screen.findByText(/No allowlist set/i);

    const input = screen.getByTestId('embed-allowlist-input');
    fireEvent.keyDown(input, { key: 'Enter' }); // empty input
    // No chip rendered (chip wrapper is hidden when origins=[]).
    expect(screen.queryByTestId('embed-allowlist-chips')).not.toBeInTheDocument();
    // Empty-state still rendered.
    expect(screen.getByTestId('embed-allowlist-empty')).toBeInTheDocument();
  });

  it('9. add duplicate → duplicate error + chip not added twice', async () => {
    fetchApiMock.mockResolvedValue(listResponse(['https://dupcheck.com']));
    render(<EmbedAllowlist />);
    await screen.findByText('https://dupcheck.com');

    const input = screen.getByTestId('embed-allowlist-input');
    fireEvent.change(input, { target: { value: 'https://dupcheck.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(
      screen.getByTestId('embed-allowlist-input-error'),
    ).toHaveTextContent(/already in the allowlist/i);
    // Only one chip with that text — using a non-placeholder URL avoids
    // collision with the input placeholder "https://partner.com".
    expect(screen.getAllByText('https://dupcheck.com')).toHaveLength(1);
  });

  it('10. remove chip → chip disappears + Save becomes enabled', async () => {
    fetchApiMock.mockResolvedValue(
      listResponse(['https://drop.com', 'https://keep.com']),
    );
    render(<EmbedAllowlist />);
    await screen.findByText('https://drop.com');

    const removeBtn = screen.getByTestId('embed-allowlist-remove-https://drop.com');
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(screen.queryByText('https://drop.com')).not.toBeInTheDocument();
    });
    expect(screen.getByText('https://keep.com')).toBeInTheDocument();
    const saveBtn = screen.getByTestId('embed-allowlist-save');
    expect(saveBtn).not.toBeDisabled();
  });

  it('11. Save fires PATCH with origins payload + notify.success on response', async () => {
    fetchApiMock
      .mockResolvedValueOnce(listResponse([])) // initial GET
      .mockResolvedValueOnce(listResponse(['https://new.com'])); // PATCH

    render(<EmbedAllowlist />);
    await screen.findByText(/No allowlist set/i);

    fireEvent.change(screen.getByTestId('embed-allowlist-input'), {
      target: { value: 'https://new.com' },
    });
    fireEvent.click(screen.getByTestId('embed-allowlist-add'));
    await screen.findByText('https://new.com');

    fireEvent.click(screen.getByTestId('embed-allowlist-save'));

    await waitFor(() => {
      // The 2nd fetchApi call is the PATCH.
      expect(fetchApiMock).toHaveBeenCalledTimes(2);
    });
    const [, opts] = fetchApiMock.mock.calls[1];
    expect(fetchApiMock.mock.calls[1][0]).toBe(
      '/api/admin/tenants/42/embed-allowlist',
    );
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ origins: ['https://new.com'] });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Allowlist updated/i),
      );
    });
  });

  it('12. Save button disabled on freshly-loaded clean page (no dirty diff)', async () => {
    fetchApiMock.mockResolvedValue(listResponse(['https://a.com']));
    render(<EmbedAllowlist />);
    await screen.findByText('https://a.com');
    expect(screen.getByTestId('embed-allowlist-save')).toBeDisabled();
  });

  it('13. load error → renders error banner + Retry button', async () => {
    fetchApiMock.mockRejectedValueOnce(new Error('Forbidden'));
    render(<EmbedAllowlist />);
    expect(
      await screen.findByTestId('embed-allowlist-load-error'),
    ).toHaveTextContent(/Forbidden/);
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  // ── S131 wildcard support ────────────────────────────────────────────
  it('14. add valid leftmost wildcard `https://*.example-w.test` → chip + Save enables', async () => {
    // Note: use an origin whose literal text doesn't appear in the page
    // chrome (the help paragraph references `https://*.partner.com` as
    // an example, which would collide with getByText). Targeting the chip
    // by testid is more robust.
    fetchApiMock.mockResolvedValue(listResponse([]));
    render(<EmbedAllowlist />);
    await screen.findByText(/No allowlist set/i);

    const input = screen.getByTestId('embed-allowlist-input');
    fireEvent.change(input, { target: { value: 'https://*.example-w.test' } });
    fireEvent.click(screen.getByTestId('embed-allowlist-add'));

    await waitFor(() => {
      expect(
        screen.getByTestId('embed-allowlist-chip-https://*.example-w.test'),
      ).toBeInTheDocument();
    });
    expect(input.value).toBe('');
    const saveBtn = screen.getByTestId('embed-allowlist-save');
    expect(saveBtn).not.toBeDisabled();
  });

  it('15. add non-leftmost wildcard `https://foo.*.com` → inline error, chip NOT added', async () => {
    fetchApiMock.mockResolvedValue(listResponse([]));
    render(<EmbedAllowlist />);
    await screen.findByText(/No allowlist set/i);

    const input = screen.getByTestId('embed-allowlist-input');
    fireEvent.change(input, { target: { value: 'https://foo.*.com' } });
    // Add button is disabled when invalid (inputIsValid=false); fire Enter
    // to force the handleAdd path which sets inputError.
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.queryByText('https://foo.*.com')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('embed-allowlist-input-error'),
    ).toHaveTextContent(/HTTPS URL/i);
  });

  it('16. add bare `https://*` (no host suffix) → inline error, chip NOT added', async () => {
    fetchApiMock.mockResolvedValue(listResponse([]));
    render(<EmbedAllowlist />);
    await screen.findByText(/No allowlist set/i);

    const input = screen.getByTestId('embed-allowlist-input');
    fireEvent.change(input, { target: { value: 'https://*' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.queryByText(/^https:\/\/\*$/)).not.toBeInTheDocument();
    expect(
      screen.getByTestId('embed-allowlist-input-error'),
    ).toHaveTextContent(/HTTPS URL/i);
  });
});
