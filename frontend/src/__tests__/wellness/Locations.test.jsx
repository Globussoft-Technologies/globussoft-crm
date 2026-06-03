/**
 * wellness/Locations.test.jsx — vitest + RTL coverage for the Clinic
 * Locations page (multi-clinic operational config).
 *
 * Scope: pins the delete-button surface introduced 2026-05-30 alongside
 * the existing edit / active-toggle controls.
 *
 *   L1. Page renders heading + one card per location + total counter.
 *   L2. Each card surfaces a "Delete <name>" button (aria-label) so the
 *       trash icon is accessible to keyboard / screen-reader operators.
 *   L3. Clicking Delete → notify.confirm modal (the styled in-app modal,
 *       NOT the native window.confirm — the browser dialog reads
 *       "localhost says…" and is product-unfit). If the operator
 *       cancels, NO DELETE fetch fires (load() not re-invoked, no toast).
 *   L4. Confirm → DELETE /api/wellness/locations/:id fires, success
 *       toast is shown, list re-fetches to reflect the removal.
 *   L5. Server-side 409 LOCATION_IN_USE → fetchApi rejects (it surfaces
 *       the server error toast itself). The component must NOT emit a
 *       success toast and must NOT crash.
 *   L6. The edit/active-toggle controls keep working — sanity check that
 *       the new delete button doesn't displace siblings or break the
 *       header action row.
 *
 * Pattern mirrors wellness/Patients.test.jsx — vi.mock for fetchApi +
 * useNotify, stable mock object references so useCallback dependencies
 * don't churn, notify.confirm flipped per-test for cancel vs accept paths.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
// notify.confirm is a vi.fn so individual tests can flip the resolved
// value (cancel vs accept). The mock object reference itself stays
// stable across renders so useCallback dependency identity doesn't
// change and trigger infinite re-renders — see the 2026-05-XX RTL
// standing rule in CLAUDE.md.
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import Locations from '../../pages/wellness/Locations';

const sampleLocations = [
  {
    id: 1,
    name: 'Bangalore',
    addressLine: 'Industrial Layout, Koramangala',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560095',
    phone: '+91 9876543210',
    email: 'max@clowmail.com',
    isActive: true,
  },
  {
    id: 2,
    name: 'Ranchi',
    addressLine: 'The Ikon, Tagore Hill Road, Morabadi',
    city: 'Ranchi',
    state: 'Jharkhand',
    pincode: '834008',
    phone: '+91 9637866666',
    email: 'ranchi@enhancedwellness.in',
    isActive: true,
  },
];

function defaultFetchMock(url, opts) {
  if (url === '/api/wellness/locations' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleLocations);
  }
  if (url.startsWith('/api/wellness/locations/') && opts && opts.method === 'DELETE') {
    return Promise.resolve({ ok: true });
  }
  return Promise.resolve(null);
}

describe('<wellness/Locations /> — delete button', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    // Default to confirm=true. Individual tests flip this to false to
    // pin the cancel-path semantics.
    notifyConfirm.mockResolvedValue(true);
  });

  it('L1: renders the heading + total counter + one card per location', async () => {
    render(<Locations />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Clinic locations/i })).toBeInTheDocument();
    });
    // The header renders the count as a teal pill ("2") and the noun in a
    // sibling description span ("locations — add new ones..."). textContent
    // aggregates across descendants so the matcher fires on every ancestor;
    // use getAllByText and assert "at least one" instead of strict-single.
    expect(
      screen.getAllByText((_t, el) => /2 locations/i.test(el?.textContent || '')).length,
    ).toBeGreaterThanOrEqual(1);
    // One card per row (h3 with the location name).
    expect(screen.getByRole('heading', { name: /Bangalore/, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Ranchi/, level: 3 })).toBeInTheDocument();
  });

  it('L2: each card surfaces an accessible "Delete <name>" button', async () => {
    render(<Locations />);

    await waitFor(() => expect(screen.getByText('Bangalore')).toBeInTheDocument());

    // aria-label is the load-bearing accessibility hook — screen readers
    // announce "Delete Bangalore" / "Delete Ranchi" so operators know
    // which row they're deleting before the confirm dialog appears.
    expect(screen.getByRole('button', { name: /Delete Bangalore/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete Ranchi/i })).toBeInTheDocument();
  });

  it('L3: clicking Delete then Cancel in the confirm modal does NOT call the API', async () => {
    notifyConfirm.mockResolvedValue(false);

    render(<Locations />);
    await waitFor(() => expect(screen.getByText('Bangalore')).toBeInTheDocument());

    // Capture the call count BEFORE the click — the initial mount fetched
    // /api/wellness/locations once. We assert that the click did NOT add
    // a second DELETE call on top.
    const callsBeforeClick = fetchApiMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Delete Bangalore/i }));

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalledTimes(1));

    // The confirm config carries the destructive flag + the location
    // name verbatim so the styled modal renders the right title + red
    // primary button. Pinning this protects against accidental
    // regressions back to a non-destructive confirm style.
    const cfg = notifyConfirm.mock.calls[0][0];
    expect(cfg).toMatchObject({
      destructive: true,
      confirmText: 'Delete',
    });
    expect(cfg.title).toMatch(/Bangalore/);

    expect(fetchApiMock.mock.calls.length).toBe(callsBeforeClick);
    expect(notifySuccess).not.toHaveBeenCalled();
  });

  it('L4: confirm → DELETE is sent, success toast fires, list re-fetches', async () => {
    render(<Locations />);
    await waitFor(() => expect(screen.getByText('Bangalore')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Delete Bangalore/i }));

    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, opts]) => u === '/api/wellness/locations/1' && opts && opts.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });

    // Success toast uses the location name verbatim so the operator can
    // visually confirm the right row was removed.
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(expect.stringContaining('Bangalore'));
    });

    // After a successful delete, the list re-fetches so the row drops out
    // of view without a page reload. Verify the GET list call ran a
    // second time post-DELETE.
    const listGetCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) => u === '/api/wellness/locations' && (!opts || !opts.method || opts.method === 'GET'),
    );
    expect(listGetCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('L5: 409 LOCATION_IN_USE rejects gracefully — no success toast, no crash', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/wellness/locations' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(sampleLocations);
      }
      if (url === '/api/wellness/locations/1' && opts && opts.method === 'DELETE') {
        // fetchApi surfaces a server-shaped Error to callers + toasts the
        // server's `error` message itself. Mirror that contract here.
        return Promise.reject(new Error('Cannot delete "Bangalore" — 3 record(s) still reference it. Deactivate it instead.'));
      }
      return Promise.resolve(null);
    });

    render(<Locations />);
    await waitFor(() => expect(screen.getByText('Bangalore')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Delete Bangalore/i }));

    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, opts]) => u === '/api/wellness/locations/1' && opts && opts.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });

    // Critical: even on rejection, the catch handler swallows the error
    // (fetchApi already toasted the server message). No success toast,
    // and the row stays visible because no re-fetch was triggered.
    expect(notifySuccess).not.toHaveBeenCalled();
    expect(screen.getByText('Bangalore')).toBeInTheDocument();
  });

  it('L6: the edit / active-toggle controls still render alongside delete', async () => {
    render(<Locations />);
    await waitFor(() => expect(screen.getByText('Bangalore')).toBeInTheDocument());

    // The header action row holds three controls per card: edit (Pencil
    // icon, title "Edit location"), active/inactive toggle (button text),
    // and the new delete button. Sanity check all three coexist.
    expect(screen.getAllByTitle('Edit location').length).toBe(2);
    expect(screen.getAllByText('Active', { selector: 'button' }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: /Delete/i }).length).toBe(2);
  });
});
