/**
 * Sandbox.test.jsx — vitest + RTL coverage for the admin Sandbox & Snapshots
 * page (frontend/src/pages/Sandbox.jsx). The page surfaces tenant
 * snapshot/restore/reset operations — the most destructive admin surface in
 * the CRM — so the chrome's role-gating + double-confirm modal contracts
 * (typing the literal token `RESTORE` / `DELETE_EVERYTHING`) need pinned
 * tests so an accidental refactor can't quietly weaken them.
 *
 * Sandbox.jsx reads its role NOT from AuthContext but by base64-decoding the
 * JWT payload itself via `getAuthToken()` + `JSON.parse(atob(...))`. So the
 * mock for `../utils/api`'s `getAuthToken` returns a real-shaped 3-segment
 * JWT (`header.<base64-payload>.sig`) with `{ role: 'ADMIN' }` / `{ role:
 * 'USER' }` payloads — anything else returns 'USER' via the catch-fall.
 *
 * Contracts pinned here:
 *   1. ADMIN role: mount renders heading + "Create Snapshot" + "Reset
 *      Tenant" buttons; GET /api/sandbox fires once.
 *   2. USER role: "Reset Tenant" button is HIDDEN; "Restore" + "Delete" row
 *      buttons are HIDDEN; "Restore & delete require ADMIN" hint shows.
 *   3. Empty-state copy renders when /api/sandbox returns [].
 *   4. Snapshot list row renders name, description, formatted size (KB/MB),
 *      and the snapshot id badge (#<id>).
 *   5. "Create Snapshot" modal: submitting with a non-empty name POSTs
 *      /api/sandbox with the form fields then re-loads the list.
 *   6. Restore modal (ADMIN): confirm button stays disabled until the user
 *      types the literal `RESTORE`; clicking with the right token POSTs
 *      /api/sandbox/<id>/restore.
 *   7. Restore modal (ADMIN): typing the wrong token + clicking confirm is
 *      a no-op (button disabled; no POST fires).
 *   8. Reset Tenant modal: confirm button stays disabled until the user
 *      types `DELETE_EVERYTHING`; clicking with the right token POSTs
 *      /api/sandbox/reset with `{ confirm: 'DELETE_EVERYTHING' }` body.
 *   9. Delete row button (ADMIN): fires notify.confirm; on yes, DELETEs
 *      /api/sandbox/<id> then re-loads the list.
 *  10. Disk-usage helper: 0 → "0 B"; 512 → "512 B"; 2048 → "2.0 KB"; 5MB →
 *      "5.00 MB" (smoke-tests `formatBytes` via the rendered cells).
 *
 * Stable mock pattern (per the 2026-05-12 standing rule): notify object is
 * one reference for the whole module so hooks reading it in `useCallback`
 * deps don't cause re-render loops.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// JWT payloads — base64-encoded {role: 'ADMIN'} / {role: 'USER'}. The page's
// getRole() does `JSON.parse(atob(token.split('.')[1]))` so a real 3-segment
// shape is load-bearing; a bare string returns 'USER' via the catch.
const ADMIN_JWT = 'header.eyJyb2xlIjoiQURNSU4ifQ==.sig';
const USER_JWT = 'header.eyJyb2xlIjoiVVNFUiJ9.sig';
let currentToken = ADMIN_JWT;

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  // Reads through a closure so individual tests can swap the role before
  // calling renderSandbox().
  getAuthToken: () => currentToken,
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import Sandbox from '../pages/Sandbox';

const sampleSnapshots = [
  {
    id: 11,
    name: 'Pre-migration baseline',
    description: 'Captured before Q1 migration',
    createdAt: '2026-04-01T10:00:00.000Z',
    sizeBytes: 2048,
  },
  {
    id: 12,
    name: 'After May import',
    description: null,
    createdAt: '2026-05-15T08:30:00.000Z',
    sizeBytes: 5 * 1024 * 1024,
  },
];

function defaultFetchMock(url, opts) {
  if (url === '/api/sandbox' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleSnapshots);
  }
  if (url === '/api/sandbox' && opts?.method === 'POST') {
    return Promise.resolve({ ok: true });
  }
  if (url.match(/^\/api\/sandbox\/\d+\/restore$/)) {
    return Promise.resolve({ restored: { contacts: 5, deals: 2 } });
  }
  if (url.match(/^\/api\/sandbox\/\d+$/) && opts?.method === 'DELETE') {
    return Promise.resolve({ ok: true });
  }
  if (url === '/api/sandbox/reset' && opts?.method === 'POST') {
    return Promise.resolve({ ok: true });
  }
  return Promise.resolve(null);
}

function renderSandbox(role = 'ADMIN') {
  currentToken = role === 'ADMIN' ? ADMIN_JWT : USER_JWT;
  return render(<Sandbox />);
}

describe('<Sandbox /> — page surface + role gate', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
    currentToken = ADMIN_JWT;
  });

  it('ADMIN: renders heading, Create + Reset buttons, fires GET /api/sandbox on mount', async () => {
    renderSandbox('ADMIN');
    expect(
      screen.getByRole('heading', { name: /Sandbox.*Snapshots/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Snapshot/i })).toBeInTheDocument();
    // Reset Tenant button is ADMIN-only.
    expect(screen.getByRole('button', { name: /Reset Tenant/i })).toBeInTheDocument();

    await waitFor(() => {
      const getCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/sandbox' && (!o || !o.method || o.method === 'GET'),
      );
      expect(getCall).toBeTruthy();
    });
  });

  it('USER role: Reset Tenant button is hidden and "require ADMIN" hint renders', async () => {
    renderSandbox('USER');
    // Create Snapshot is allowed for everyone (per the source — no isAdmin gate
    // on this button; only Reset + Restore + Delete are gated).
    expect(screen.getByRole('button', { name: /Create Snapshot/i })).toBeInTheDocument();
    // Reset Tenant is hidden.
    expect(screen.queryByRole('button', { name: /Reset Tenant/i })).not.toBeInTheDocument();

    // Wait for snapshot rows to render so the per-row gating is checked
    // against a populated list.
    await screen.findByText('Pre-migration baseline');
    expect(screen.getByText(/Restore .* delete require ADMIN/i)).toBeInTheDocument();
    // Restore + Delete row buttons are NOT rendered for USER.
    expect(screen.queryByRole('button', { name: /Restore/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/i })).not.toBeInTheDocument();
    // Download is still visible to USER.
    expect(screen.getAllByRole('button', { name: /Download/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('renders the empty-state when /api/sandbox returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/sandbox') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderSandbox('ADMIN');
    expect(await screen.findByText(/No snapshots yet\./i)).toBeInTheDocument();
    // Snapshot count header reflects 0.
    expect(screen.getByText(/Saved Snapshots \(0\)/i)).toBeInTheDocument();
  });

  it('renders one row per snapshot with name, id badge, description, and formatted size', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');
    expect(screen.getByText('After May import')).toBeInTheDocument();
    // Id badges (#11, #12) render below the name.
    expect(screen.getByText('#11')).toBeInTheDocument();
    expect(screen.getByText('#12')).toBeInTheDocument();
    // Description renders for snapshot 11; snapshot 12's null description
    // falls back to the "No description" placeholder.
    expect(screen.getByText('Captured before Q1 migration')).toBeInTheDocument();
    expect(screen.getByText(/No description/i)).toBeInTheDocument();
    // formatBytes: 2048 → "2.0 KB"; 5 MiB → "5.00 MB".
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('5.00 MB')).toBeInTheDocument();
    // Counter in section header.
    expect(screen.getByText(/Saved Snapshots \(2\)/i)).toBeInTheDocument();
  });

  it('Create Snapshot modal: submitting with a valid name POSTs /api/sandbox then reloads', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    fireEvent.click(screen.getByRole('button', { name: /Create Snapshot/i }));

    const nameInput = screen.getByPlaceholderText(/Pre-migration baseline/i);
    fireEvent.change(nameInput, { target: { value: 'Tick #200 baseline' } });
    const descInput = screen.getByPlaceholderText(/What is this snapshot for/i);
    fireEvent.change(descInput, { target: { value: 'before risky change' } });

    // The modal renders a second "Create Snapshot" button (the form submit)
    // ALONGSIDE the header trigger button. getAllByRole returns both — the
    // form submit is the second one (rendered later in the tree, inside the
    // <form>). Pin via the trailing position.
    const allCreateBtns = screen.getAllByRole('button', { name: /Create Snapshot/i });
    const submitBtn = allCreateBtns[allCreateBtns.length - 1];
    fireEvent.click(submitBtn);

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/sandbox' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Tick #200 baseline');
      expect(body.description).toBe('before risky change');
    });
    // Re-load fires a second GET /api/sandbox.
    await waitFor(() => {
      const getCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/sandbox' && (!o || !o.method || o.method === 'GET'),
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('Restore modal (ADMIN): confirm button enables only when "RESTORE" is typed; click POSTs /restore', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');

    // Click the Restore button on snapshot #11's row.
    const restoreBtns = screen.getAllByRole('button', { name: /Restore/i });
    fireEvent.click(restoreBtns[0]);

    // Modal opens — confirm button reads "Confirm Restore" and starts disabled.
    const confirmBtn = await screen.findByRole('button', { name: /Confirm Restore/i });
    expect(confirmBtn).toBeDisabled();

    // Type something else → still disabled.
    const input = screen.getByPlaceholderText('RESTORE');
    fireEvent.change(input, { target: { value: 'restore' } });
    expect(confirmBtn).toBeDisabled();

    // Type the exact literal → enables.
    fireEvent.change(input, { target: { value: 'RESTORE' } });
    expect(confirmBtn).not.toBeDisabled();

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const restoreCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/sandbox/11/restore' && o?.method === 'POST',
      );
      expect(restoreCall).toBeTruthy();
    });
    // Success toast surfaces the restored-summary.
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Restore complete/i),
      );
    });
  });

  it('Restore modal (ADMIN): wrong token stays disabled and no POST fires when forced', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');
    fireEvent.click(screen.getAllByRole('button', { name: /Restore/i })[0]);

    const confirmBtn = await screen.findByRole('button', { name: /Confirm Restore/i });
    fireEvent.change(screen.getByPlaceholderText('RESTORE'), {
      target: { value: 'NOPE' },
    });

    fetchApiMock.mockClear();
    fireEvent.click(confirmBtn); // disabled-button click — should no-op.

    // No restore POST fired.
    const restoreCall = fetchApiMock.mock.calls.find(([u]) =>
      typeof u === 'string' && u.match(/\/restore$/),
    );
    expect(restoreCall).toBeUndefined();
  });

  it('Reset Tenant modal: requires the literal "DELETE_EVERYTHING" then POSTs /api/sandbox/reset with confirm body', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');

    fireEvent.click(screen.getByRole('button', { name: /Reset Tenant/i }));
    const wipeBtn = await screen.findByRole('button', { name: /Wipe All Data/i });
    expect(wipeBtn).toBeDisabled();

    const input = screen.getByPlaceholderText('DELETE_EVERYTHING');
    fireEvent.change(input, { target: { value: 'delete_everything' } });
    expect(wipeBtn).toBeDisabled();

    fireEvent.change(input, { target: { value: 'DELETE_EVERYTHING' } });
    expect(wipeBtn).not.toBeDisabled();

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    fireEvent.click(wipeBtn);

    await waitFor(() => {
      const resetCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/sandbox/reset' && o?.method === 'POST',
      );
      expect(resetCall).toBeTruthy();
      const body = JSON.parse(resetCall[1].body);
      expect(body.confirm).toBe('DELETE_EVERYTHING');
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/All tenant data has been wiped/i),
      );
    });
  });

  it('Delete row button (ADMIN): confirms then DELETEs /api/sandbox/<id> then reloads', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');

    notifyConfirm.mockResolvedValueOnce(true);
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    const deleteBtns = screen.getAllByRole('button', { name: /^Delete$/i });
    fireEvent.click(deleteBtns[0]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/Permanently delete snapshot/i),
      );
    });
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/sandbox/11' && o?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
    // Re-load fires a second GET.
    await waitFor(() => {
      const getCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/sandbox' && (!o || !o.method || o.method === 'GET'),
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('Delete row button (ADMIN): if confirm() resolves false, NO DELETE fires', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');

    notifyConfirm.mockResolvedValueOnce(false);
    fetchApiMock.mockClear();

    fireEvent.click(screen.getAllByRole('button', { name: /^Delete$/i })[0]);

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    // Give the microtask queue a tick to settle.
    await new Promise((r) => setTimeout(r, 0));
    const delCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u?.match(/^\/api\/sandbox\/\d+$/) && o?.method === 'DELETE',
    );
    expect(delCall).toBeUndefined();
  });

  it('formatBytes smoke-tests via rendered cells: small + KB + MB sizes', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/sandbox') {
        return Promise.resolve([
          { id: 1, name: 'Tiny', description: null, createdAt: '2026-01-01T00:00:00Z', sizeBytes: 0 },
          { id: 2, name: 'BytesOnly', description: null, createdAt: '2026-01-02T00:00:00Z', sizeBytes: 512 },
          { id: 3, name: 'Kibi', description: null, createdAt: '2026-01-03T00:00:00Z', sizeBytes: 2048 },
          { id: 4, name: 'Mebi', description: null, createdAt: '2026-01-04T00:00:00Z', sizeBytes: 5 * 1024 * 1024 },
        ]);
      }
      return Promise.resolve(null);
    });
    renderSandbox('ADMIN');
    await screen.findByText('Tiny');
    // 0 → "0 B"; 512 → "512 B"; 2048 → "2.0 KB"; 5MB → "5.00 MB".
    expect(screen.getByText('0 B')).toBeInTheDocument();
    expect(screen.getByText('512 B')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('5.00 MB')).toBeInTheDocument();
  });

  // ── Extension cases (snapshots / restore / isolation / destructive guards) ──

  it('formatBytes GB branch: 2 GiB renders "2.00 GB"', async () => {
    // formatBytes' fourth branch (n < 1024^3 → MB) is exercised above; this
    // covers the final fall-through branch (n >= 1024^3 → GB).
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/sandbox') {
        return Promise.resolve([
          { id: 91, name: 'Gibi', description: null, createdAt: '2026-01-01T00:00:00Z', sizeBytes: 2 * 1024 * 1024 * 1024 },
        ]);
      }
      return Promise.resolve(null);
    });
    renderSandbox('ADMIN');
    await screen.findByText('Gibi');
    expect(screen.getByText('2.00 GB')).toBeInTheDocument();
  });

  it('DANGER warning banner renders for both ADMIN and USER (always visible)', async () => {
    renderSandbox('USER');
    await screen.findByText('Pre-migration baseline');
    expect(
      screen.getByText(/DANGER: Restoring or resetting will permanently delete current data/i),
    ).toBeInTheDocument();
    // The banner copy lists the captured tables — pinned so a refactor that
    // accidentally hides the "what's captured" disclosure is caught.
    expect(
      screen.getByText(/Snapshots capture Contacts, Deals, Activities/i),
    ).toBeInTheDocument();
  });

  it('Create Snapshot: whitespace-only name does NOT POST (submitCreate early-return)', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    fireEvent.click(screen.getByRole('button', { name: /Create Snapshot/i }));
    // Type only spaces — passes the `required` browser-validation (which jsdom
    // doesn't enforce anyway) but trips the explicit `.trim()` guard in
    // submitCreate().
    const nameInput = screen.getByPlaceholderText(/Pre-migration baseline/i);
    fireEvent.change(nameInput, { target: { value: '   ' } });

    // Submit via the form's submit button (the second "Create Snapshot" button).
    const allCreateBtns = screen.getAllByRole('button', { name: /Create Snapshot/i });
    const submitBtn = allCreateBtns[allCreateBtns.length - 1];
    // Trigger form submission directly to bypass jsdom's lack of `required`
    // enforcement.
    const form = submitBtn.closest('form');
    fireEvent.submit(form);

    // Give the microtask queue a tick to settle.
    await new Promise((r) => setTimeout(r, 0));
    // No POST fired.
    const postCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/sandbox' && o?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('Create Snapshot error path: fetchApi rejection surfaces notify.error', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');

    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sandbox' && opts?.method === 'POST') {
        return Promise.reject(new Error('disk full'));
      }
      if (url === '/api/sandbox') return Promise.resolve(sampleSnapshots);
      return Promise.resolve(null);
    });

    fireEvent.click(screen.getByRole('button', { name: /Create Snapshot/i }));
    fireEvent.change(screen.getByPlaceholderText(/Pre-migration baseline/i), {
      target: { value: 'will fail' },
    });
    const allCreateBtns = screen.getAllByRole('button', { name: /Create Snapshot/i });
    fireEvent.click(allCreateBtns[allCreateBtns.length - 1]);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to create snapshot.*disk full/i),
      );
    });
  });

  it('Restore error path: fetchApi rejection surfaces notify.error and keeps modal open', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');

    fireEvent.click(screen.getAllByRole('button', { name: /Restore/i })[0]);
    const confirmBtn = await screen.findByRole('button', { name: /Confirm Restore/i });
    fireEvent.change(screen.getByPlaceholderText('RESTORE'), {
      target: { value: 'RESTORE' },
    });

    fetchApiMock.mockImplementation((url, opts) => {
      if (url.match(/^\/api\/sandbox\/\d+\/restore$/) && opts?.method === 'POST') {
        return Promise.reject(new Error('snapshot corrupt'));
      }
      if (url === '/api/sandbox') return Promise.resolve(sampleSnapshots);
      return Promise.resolve(null);
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Restore failed.*snapshot corrupt/i),
      );
    });
    // Modal still mounted — the confirm button is still in the DOM (state
    // cleanup only happens on success).
    expect(screen.queryByRole('button', { name: /Confirm Restore/i })).toBeInTheDocument();
  });

  it('Reset Tenant error path: fetchApi rejection surfaces notify.error', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');

    fireEvent.click(screen.getByRole('button', { name: /Reset Tenant/i }));
    const wipeBtn = await screen.findByRole('button', { name: /Wipe All Data/i });
    fireEvent.change(screen.getByPlaceholderText('DELETE_EVERYTHING'), {
      target: { value: 'DELETE_EVERYTHING' },
    });

    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sandbox/reset' && opts?.method === 'POST') {
        return Promise.reject(new Error('db locked'));
      }
      if (url === '/api/sandbox') return Promise.resolve(sampleSnapshots);
      return Promise.resolve(null);
    });
    fireEvent.click(wipeBtn);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Reset failed.*db locked/i),
      );
    });
  });

  it('Restore modal: Cancel button closes the modal and clears the confirm text', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');

    fireEvent.click(screen.getAllByRole('button', { name: /Restore/i })[0]);
    await screen.findByRole('button', { name: /Confirm Restore/i });

    // Type the confirm token so we can verify it's cleared on Cancel.
    fireEvent.change(screen.getByPlaceholderText('RESTORE'), {
      target: { value: 'RESTORE' },
    });

    // The Restore modal renders a Cancel button — multiple modals can share
    // the name so scope to the dialog by looking inside it. There's only one
    // Cancel rendered at a time, so a getAllByText fallback is safe.
    const cancelBtns = screen.getAllByRole('button', { name: /^Cancel$/ });
    fireEvent.click(cancelBtns[0]);

    // Modal unmounted — Confirm Restore button no longer in the DOM.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Confirm Restore/i })).not.toBeInTheDocument();
    });

    // Re-open and verify the confirm text was reset (not persisted across
    // open/close cycles).
    fireEvent.click(screen.getAllByRole('button', { name: /Restore/i })[0]);
    await screen.findByRole('button', { name: /Confirm Restore/i });
    const reopenedInput = screen.getByPlaceholderText('RESTORE');
    expect(reopenedInput.value).toBe('');
  });

  it('getRole: missing token + malformed payload both fall back to USER (Reset hidden)', async () => {
    // First render — no token at all.
    currentToken = null;
    const { unmount } = render(<Sandbox />);
    await screen.findByText('Pre-migration baseline');
    expect(screen.queryByRole('button', { name: /Reset Tenant/i })).not.toBeInTheDocument();
    unmount();

    // Second render — token with a non-decodable payload segment.
    currentToken = 'header.@@@not-base64@@@.sig';
    render(<Sandbox />);
    await screen.findByText('Pre-migration baseline');
    expect(screen.queryByRole('button', { name: /Reset Tenant/i })).not.toBeInTheDocument();
  });

  it('Delete row buttons render only for ADMIN (per-row destructive isolation indicator)', async () => {
    // ADMIN sees both Restore + Delete per row (2 snapshots × 2 buttons = 4
    // destructive-row buttons + the top-bar Reset Tenant button).
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');
    const restoreBtns = screen.getAllByRole('button', { name: /Restore/i });
    const deleteBtns = screen.getAllByRole('button', { name: /^Delete$/i });
    // Two row Restore buttons (one per snapshot).
    expect(restoreBtns.length).toBe(2);
    expect(deleteBtns.length).toBe(2);
    // The id badge (#11, #12) is the per-row isolation indicator — every
    // destructive action is scoped to the snapshot id it sits beside.
    expect(screen.getByText('#11')).toBeInTheDocument();
    expect(screen.getByText('#12')).toBeInTheDocument();
  });

  it('Reset Tenant success: modal closes, confirm input is cleared, list reloads', async () => {
    renderSandbox('ADMIN');
    await screen.findByText('Pre-migration baseline');

    fireEvent.click(screen.getByRole('button', { name: /Reset Tenant/i }));
    const wipeBtn = await screen.findByRole('button', { name: /Wipe All Data/i });
    fireEvent.change(screen.getByPlaceholderText('DELETE_EVERYTHING'), {
      target: { value: 'DELETE_EVERYTHING' },
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    fireEvent.click(wipeBtn);

    // Modal unmounts on success → the Wipe button leaves the DOM.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Wipe All Data/i })).not.toBeInTheDocument();
    });
    // A re-load GET fired post-reset.
    await waitFor(() => {
      const getCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/sandbox' && (!o || !o.method || o.method === 'GET'),
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(1);
    });

    // Re-open the modal — confirm input was cleared on success.
    fireEvent.click(screen.getByRole('button', { name: /Reset Tenant/i }));
    await screen.findByRole('button', { name: /Wipe All Data/i });
    const reopenedInput = screen.getByPlaceholderText('DELETE_EVERYTHING');
    expect(reopenedInput.value).toBe('');
  });
});
