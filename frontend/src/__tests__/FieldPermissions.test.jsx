/**
 * FieldPermissions.jsx — banner removal regression (#577).
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
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

import FieldPermissions from '../pages/FieldPermissions';

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
