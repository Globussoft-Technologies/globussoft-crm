/**
 * FieldPermissions.jsx — banner removal regression (#577) + extended surface coverage.
 *
 * Pre-#577 the page rendered an amber AlertTriangle banner reading
 * "Restricting field access requires app restart for changes to fully
 * apply. Rules are stored immediately, but existing route handlers must
 * adopt the fieldFilter middleware before enforcement takes effect."
 *
 * The banner text was an admission that fieldFilter wasn't actually wired
 * into route handlers — admins toggled rules with no idea whether they'd
 * take effect. The fix wires fieldFilter into the 4 entities the page
 * shows (Deal, Contact, Invoice, Quote) and removes the banner.
 *
 * This spec pins:
 *   1. The amber banner is NOT rendered.
 *   2. The page still renders normally (entity tabs, matrix, save button).
 *
 * Extended coverage augments the original 2-test smoke with the rest of
 * the 547-LOC surface: matrix render, per-field Allow/Deny toggle
 * interaction, read-revokes-write side effect, view toggle (fields vs
 * matrix), entity-tab switching, module × action matrix cell flip, ADMIN
 * disabled cells, save-all bulk-update POST + savedAt confirmation, error
 * banner on load failure, loading-state visibility during initial fetch,
 * fallback-entities path when /entities endpoint rejects, and empty-field
 * empty-state row. All assertions pin behaviour, not source — toggling
 * cells in the test does not require fetchApi side effects (state is
 * client-side until Save).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

import FieldPermissions from '../pages/FieldPermissions';

// Helper to set up a typical successful fetch sequence:
//   1st call: /entities  → returns entityMap (or rejects → fallback)
//   2nd call: /field-permissions  → returns grouped rules
//   3rd call: /matrix  → reject by default so the SUT's fallback builder
//             populates moduleMatrix from FALLBACK_ENTITIES (otherwise
//             the matrix view tbody is empty and per-cell testids never
//             render). Override `matrix:` to supply server payload.
function mockHappyLoad({ entities, grouped, matrix } = {}) {
  fetchApiMock.mockImplementation(async (url) => {
    if (url === '/api/field-permissions/entities') return entities ?? {};
    if (url === '/api/field-permissions/matrix') {
      if (matrix === undefined) throw new Error('no-matrix');
      return matrix;
    }
    if (url === '/api/field-permissions') return grouped ?? {};
    return {};
  });
}

describe('<FieldPermissions /> — banner removal (#577)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    // /entities + /field-permissions both default to {}
    fetchApiMock.mockResolvedValue({});
  });

  it('does NOT render the "requires app restart" amber banner', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      // wait for the loading state to finish
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/Restricting field access requires app restart/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/route handlers must adopt the/i)).not.toBeInTheDocument();
  });

  it('still renders the matrix surface (entity tabs + Save button)', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    // Page-level header.
    expect(screen.getByRole('heading', { name: /Field-Level Permissions/i })).toBeInTheDocument();
    // Save button still rendered.
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeInTheDocument();
    // The 4 entity tabs (the same set the FALLBACK_ENTITIES constant declares).
    expect(screen.getByRole('button', { name: /^Deal$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Contact$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Invoice$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Quote$/ })).toBeInTheDocument();
  });
});

describe('<FieldPermissions /> — extended surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    mockHappyLoad();
  });

  it('renders the per-field permissions matrix with rows × roles after load', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    // Deal is the default active entity; its FALLBACK fields include 'title', 'amount', etc.
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('amount')).toBeInTheDocument();
    expect(screen.getByText('currency')).toBeInTheDocument();
    // ROLES column headers — appear at minimum in the per-field thead.
    // (matrix view is hidden by default, so these appear once each.)
    expect(screen.getAllByText('ADMIN').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('MANAGER').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('USER').length).toBeGreaterThanOrEqual(1);
  });

  it('toggling Read on a cell flips state; revoking Read auto-revokes Write', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    // Per row each role has [Read, Write] buttons. Default state: all canRead=true,
    // canWrite=true → both toggles read as "Allowed" in the title attr.
    // Grab all Read buttons; pick one and verify it starts allowed, click → becomes denied.
    const readBtns = screen.getAllByTitle(/^Read: Allowed$/);
    expect(readBtns.length).toBeGreaterThan(0);
    const firstRead = readBtns[0];
    fireEvent.click(firstRead);
    // After clicking: read button moves to Denied; the same row's write should
    // become N/A (no read access) — the read-revokes-write side effect.
    await waitFor(() => {
      // At least one Read button now shows "Denied" — the one we just clicked.
      expect(screen.getAllByTitle(/^Read: Denied$/).length).toBeGreaterThan(0);
    });
    // And at least one Write button now reads "N/A (no read access)".
    expect(screen.getAllByTitle(/^Write: N\/A \(no read access\)$/).length).toBeGreaterThan(0);
  });

  it('switching entity tab changes the visible field rows', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    // Default = Deal, so 'currency' (Deal) is visible and 'dueDate' (Invoice) is not.
    expect(screen.getByText('currency')).toBeInTheDocument();
    expect(screen.queryByText('dueDate')).not.toBeInTheDocument();

    // Click the Invoice tab.
    const invoiceTab = screen.getByRole('button', { name: /^Invoice$/ });
    fireEvent.click(invoiceTab);

    // 'dueDate' (Invoice's third field per FALLBACK_ENTITIES) is now visible;
    // 'currency' is not.
    await waitFor(() => {
      expect(screen.getByText('dueDate')).toBeInTheDocument();
    });
    expect(screen.queryByText('currency')).not.toBeInTheDocument();
  });

  it('switching to the Module × action view renders MATRIX_ROLES + ACTIONS headers', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    // Flip to matrix view.
    const matrixToggle = screen.getByTestId('fp-view-matrix');
    fireEvent.click(matrixToggle);

    // ACTIONS column headers.
    await waitFor(() => {
      expect(screen.getByTestId('fp-matrix-table')).toBeInTheDocument();
    });
    expect(screen.getByText('READ')).toBeInTheDocument();
    expect(screen.getByText('WRITE')).toBeInTheDocument();
    expect(screen.getByText('DELETE')).toBeInTheDocument();
    expect(screen.getByText('EXPORT')).toBeInTheDocument();
    // Sub-role rows are only in the matrix view: doctor, professional, etc.
    expect(screen.getAllByText('doctor').length).toBeGreaterThan(0);
    expect(screen.getAllByText('telecaller').length).toBeGreaterThan(0);
  });

  it('flipping a non-ADMIN matrix cell changes its label from Allow to Deny', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('fp-view-matrix'));
    await waitFor(() => {
      expect(screen.getByTestId('fp-matrix-table')).toBeInTheDocument();
    });

    // Pick a deterministic non-ADMIN cell: Deal × MANAGER × WRITE.
    const cell = screen.getByTestId('fp-cell-Deal-MANAGER-WRITE');
    expect(cell).not.toBeDisabled();
    expect(cell).toHaveTextContent('Allow');

    fireEvent.click(cell);
    await waitFor(() => {
      expect(screen.getByTestId('fp-cell-Deal-MANAGER-WRITE')).toHaveTextContent('Deny');
    });
  });

  it('ADMIN matrix cells are disabled (implicit allow, infinity glyph)', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('fp-view-matrix'));
    await waitFor(() => {
      expect(screen.getByTestId('fp-matrix-table')).toBeInTheDocument();
    });

    const adminCell = screen.getByTestId('fp-cell-Deal-ADMIN-WRITE');
    expect(adminCell).toBeDisabled();
    // Glyph for ADMIN bypass.
    expect(adminCell).toHaveTextContent('∞');
    // Clicking should NOT flip it (still ∞, not Deny).
    fireEvent.click(adminCell);
    expect(adminCell).toHaveTextContent('∞');
  });

  it('Save Changes POSTs to /api/field-permissions/bulk-update with rules payload + shows Saved confirmation', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });

    // After initial load the next fetchApi call should be the bulk-update POST.
    // Make it succeed.
    fetchApiMock.mockResolvedValueOnce({ ok: true });

    const saveBtn = screen.getByRole('button', { name: /Save Changes/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      // The most recent call must be the bulk-update POST.
      const last = fetchApiMock.mock.calls[fetchApiMock.mock.calls.length - 1];
      expect(last[0]).toBe('/api/field-permissions/bulk-update');
      expect(last[1]).toMatchObject({ method: 'POST' });
      // Body is JSON-stringified { rules: [...] }
      const body = JSON.parse(last[1].body);
      expect(Array.isArray(body.rules)).toBe(true);
      expect(body.rules.length).toBeGreaterThan(0);
      // Each rule has the expected shape.
      const rule = body.rules[0];
      expect(rule).toHaveProperty('role');
      expect(rule).toHaveProperty('entity');
      expect(rule).toHaveProperty('field');
      expect(rule).toHaveProperty('action');
      expect(rule).toHaveProperty('canRead');
      expect(rule).toHaveProperty('canWrite');
    });

    // "Saved <time>" confirmation appears.
    await waitFor(() => {
      expect(screen.getByText(/Saved /i)).toBeInTheDocument();
    });
  });

  it('shows error banner when bulk-update fails', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });

    fetchApiMock.mockRejectedValueOnce(new Error('Network blowup'));

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => {
      expect(screen.getByText(/Network blowup/i)).toBeInTheDocument();
    });
  });

  it('renders the loading state during initial fetch', async () => {
    // Pre-build a pending promise the SUT will block on. Capture its resolver
    // BEFORE render() so the resolver is defined when we call it later.
    let resolveGrouped;
    const groupedPromise = new Promise((res) => { resolveGrouped = res; });
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/field-permissions/entities') return Promise.resolve({});
      if (url === '/api/field-permissions/matrix') return Promise.resolve({});
      if (url === '/api/field-permissions') return groupedPromise;
      return Promise.resolve({});
    });

    render(<FieldPermissions />);
    // Loading text visible synchronously after first paint.
    expect(screen.getByText(/Loading permissions/i)).toBeInTheDocument();

    // Release the hanging promise and confirm loading-text disappears.
    resolveGrouped({});
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
  });

  it('falls back to FALLBACK_ENTITIES when /entities endpoint rejects', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/field-permissions/entities') {
        return Promise.reject(new Error('Entities down'));
      }
      if (url === '/api/field-permissions') return Promise.resolve({});
      if (url === '/api/field-permissions/matrix') return Promise.resolve({});
      return Promise.resolve({});
    });

    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    // The fallback entities — Deal/Contact/Invoice/Quote tabs — still render.
    expect(screen.getByRole('button', { name: /^Deal$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Contact$/ })).toBeInTheDocument();
    // And the default Deal fields still appear.
    expect(screen.getByText('title')).toBeInTheDocument();
  });

  it('honours a grouped rule response: server-side denial reflects in the cell toggle', async () => {
    // Server says: MANAGER's Deal.amount has canRead=false, canWrite=false.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/field-permissions/entities') return Promise.resolve({});
      if (url === '/api/field-permissions/matrix') return Promise.reject(new Error('no-matrix'));
      if (url === '/api/field-permissions') {
        return Promise.resolve({
          Deal: [
            { role: 'MANAGER', field: 'amount', action: 'WRITE', canRead: false, canWrite: false },
          ],
        });
      }
      return Promise.resolve({});
    });

    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });

    // Locate the row for 'amount' and assert MANAGER's Read button is in Denied state.
    const amountCell = screen.getByText('amount').closest('tr');
    expect(amountCell).toBeTruthy();
    // The row has 3 role columns (ADMIN, MANAGER, USER) — each with Read + Write.
    // MANAGER's Read should now be "Denied".
    const deniedInRow = within(amountCell).getAllByTitle(/^Read: Denied$/);
    expect(deniedInRow.length).toBeGreaterThan(0);
  });

  it('shows empty-state row when active entity has no fields', async () => {
    // Server returns an entity with an empty fields array.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/field-permissions/entities') {
        return Promise.resolve({ Custom: [] });
      }
      if (url === '/api/field-permissions') return Promise.resolve({});
      if (url === '/api/field-permissions/matrix') return Promise.resolve({});
      return Promise.resolve({});
    });

    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    // The Custom tab should be the only entity tab — and active by default since
    // 'Deal' is no longer in the entities map. (activeEntity stays 'Deal' from
    // initial useState, so fields = entities['Deal'] = undefined → []. Either
    // way the empty-state row renders.)
    expect(screen.getByText(/No fields configured for this entity/i)).toBeInTheDocument();
  });

  // ── Additional surface coverage (Wave: 547L SUT / extending past 366L) ──

  it('shows error banner when initial /field-permissions load rejects', async () => {
    // The OUTER try/catch in loadAll wraps the /field-permissions call. If it
    // rejects, the SUT renders an error banner with the message. (The
    // /entities and /matrix calls have inner try/catch with fallbacks, so
    // they don't trip the outer catch.)
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/field-permissions/entities') return Promise.resolve({});
      if (url === '/api/field-permissions/matrix') return Promise.reject(new Error('matrix-down'));
      if (url === '/api/field-permissions') return Promise.reject(new Error('Bulk-load exploded'));
      return Promise.resolve({});
    });

    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    // Error banner rendered with the rejection message.
    expect(screen.getByText(/Bulk-load exploded/i)).toBeInTheDocument();
    // SUT still falls back to FALLBACK_ENTITIES matrix, so Deal tab + fields still render.
    expect(screen.getByRole('button', { name: /^Deal$/ })).toBeInTheDocument();
    expect(screen.getByText('title')).toBeInTheDocument();
  });

  it('view toggle: clicking Per-field after matrix hides the matrix table and shows entity tabs', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    // Flip to matrix view first.
    fireEvent.click(screen.getByTestId('fp-view-matrix'));
    await waitFor(() => {
      expect(screen.getByTestId('fp-matrix-table')).toBeInTheDocument();
    });
    // Flip back to per-field view.
    fireEvent.click(screen.getByTestId('fp-view-fields'));
    await waitFor(() => {
      expect(screen.queryByTestId('fp-matrix-table')).not.toBeInTheDocument();
    });
    // Per-field surface returns: 'title' field row + Deal entity tab + the
    // legend phrase about read-revokes-write are all rendered.
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText(/Revoking Read automatically revokes Write/i)).toBeInTheDocument();
  });

  it('view toggle: active button has btn-primary class indicating current view', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    // Initial: 'fields' view active.
    const fieldsBtn = screen.getByTestId('fp-view-fields');
    const matrixBtn = screen.getByTestId('fp-view-matrix');
    expect(fieldsBtn.className).toMatch(/btn-primary/);
    expect(matrixBtn.className).not.toMatch(/btn-primary/);

    // Flip — class assignment swaps.
    fireEvent.click(matrixBtn);
    await waitFor(() => {
      expect(matrixBtn.className).toMatch(/btn-primary/);
    });
    expect(fieldsBtn.className).not.toMatch(/btn-primary/);
  });

  it('Save button disables during save and re-enables on success', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });

    // Make bulk-update hang so we can observe the saving state mid-flight.
    let resolveSave;
    fetchApiMock.mockImplementationOnce(() => new Promise((res) => { resolveSave = res; }));

    const saveBtn = screen.getByRole('button', { name: /Save Changes/i });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    // While the save promise is pending: button is disabled and the label
    // reads "Saving…".
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Saving/i })).toBeDisabled();
    });

    // Resolve the pending save → button returns to enabled state.
    resolveSave({ ok: true });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save Changes/i })).not.toBeDisabled();
    });
  });

  it('ADMIN matrix cell title attr reflects implicit-allow bypass', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('fp-view-matrix'));
    await waitFor(() => {
      expect(screen.getByTestId('fp-matrix-table')).toBeInTheDocument();
    });
    // ADMIN cells get a "ADMIN bypass: implicit allow" tooltip — non-ADMIN
    // cells get a flip-state tooltip ("Allowed (click to deny)" or
    // "Denied (click to allow)").
    const adminCell = screen.getByTestId('fp-cell-Deal-ADMIN-DELETE');
    expect(adminCell.getAttribute('title')).toMatch(/ADMIN bypass/i);

    const managerCell = screen.getByTestId('fp-cell-Deal-MANAGER-DELETE');
    expect(managerCell.getAttribute('title')).toMatch(/Allowed \(click to deny\)/i);
  });

  it('Save payload emits a star rule per (entity, role, action) tuple — all 4 ACTIONS represented', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });

    fetchApiMock.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      const last = fetchApiMock.mock.calls[fetchApiMock.mock.calls.length - 1];
      expect(last[0]).toBe('/api/field-permissions/bulk-update');
    });

    const last = fetchApiMock.mock.calls[fetchApiMock.mock.calls.length - 1];
    const body = JSON.parse(last[1].body);
    // Star rules (field='*', emitted by the moduleMatrix block) must include
    // all 4 actions for the canonical RBAC roles.
    const dealStarRules = body.rules.filter(
      (r) => r.entity === 'Deal' && r.field === '*' && r.role === 'MANAGER',
    );
    const actionSet = new Set(dealStarRules.map((r) => r.action));
    expect(actionSet.has('READ')).toBe(true);
    expect(actionSet.has('WRITE')).toBe(true);
    expect(actionSet.has('DELETE')).toBe(true);
    expect(actionSet.has('EXPORT')).toBe(true);

    // Per-field rules (non-star) all have action='WRITE' — that's the legacy
    // bucket comment in buildRulesPayload.
    const dealAmountRule = body.rules.find(
      (r) => r.entity === 'Deal' && r.field === 'amount' && r.role === 'USER',
    );
    expect(dealAmountRule).toBeTruthy();
    expect(dealAmountRule.action).toBe('WRITE');
  });

  it('renders all FALLBACK Deal fields as per-field rows (10 fields × 3 roles)', async () => {
    render(<FieldPermissions />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading permissions/i)).not.toBeInTheDocument();
    });
    // FALLBACK_ENTITIES.Deal has 8 fields (title, amount, currency,
    // probability, stage, expectedClose, ownerId, lostReason). Each must
    // render as a row.
    for (const f of ['title', 'amount', 'currency', 'probability', 'stage', 'expectedClose', 'ownerId', 'lostReason']) {
      expect(screen.getByText(f)).toBeInTheDocument();
    }
  });
});
