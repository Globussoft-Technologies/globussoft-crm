/**
 * wellness/PointOfSale.test.jsx — vitest + RTL coverage for the wellness POS
 * surface (cash-and-carry shift + sale builder).
 *
 * Scope: pins the page-surface invariants for the surface actually shipped
 * today (Wave 2/7 — shift card, line-item builder, totals card, complete-
 * sale CTA). The previous file pinned a Booking | Walk-in tab strip +
 * payment splitter UI that the component does not ship in this build. Per
 * the project's "prefer editing the test file" rule, this file pins what
 * the component actually renders.
 *
 * Pinned invariants:
 *   1. Page renders heading "Point of Sale".
 *   2. With no open shift, the "No shift open" card and the Register +
 *      Opening float inputs render.
 *   3. Mount fires GET /api/pos/registers (with isActive=true) + GET
 *      /api/pos/shifts/current + GET /api/wellness/locations.
 *   4. With an OPEN shift, the "Shift open" banner + "Current sale (0
 *      lines)" basket header render.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'fake-token',
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('../../utils/money', () => ({
  formatMoney: (v) => `₹${Number(v || 0).toFixed(2)}`,
  currencySymbol: () => '₹',
}));

import PointOfSale from '../../pages/wellness/PointOfSale';
import { AuthContext } from '../../App';

function defaultFetchMock(url) {
  if (typeof url === 'string') {
    if (url.startsWith('/api/pos/registers')) {
      return Promise.resolve([{ id: 1, name: 'Front Desk', location: { name: 'Main' } }]);
    }
    if (url.startsWith('/api/pos/shifts/current')) {
      return Promise.resolve(null);
    }
    if (url.startsWith('/api/wellness/locations')) {
      return Promise.resolve([{ id: 1, name: 'Main Clinic' }]);
    }
  }
  return Promise.resolve(null);
}

function renderPOS({ user, fetchImpl } = {}) {
  fetchApiMock.mockImplementation(fetchImpl || defaultFetchMock);
  const authValue = {
    user: user || { id: 1, userId: 1, role: 'ADMIN', name: 'Test Admin' },
    setUser: vi.fn(),
  };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue}>
        <PointOfSale />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('<wellness/PointOfSale /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
  });

  it('renders the Point of Sale heading', async () => {
    renderPOS();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Point of Sale/i })).toBeInTheDocument();
    });
  });

  it('shows the "No shift open" card when /api/pos/shifts/current returns null', async () => {
    renderPOS();
    expect(await screen.findByText(/No shift open/i)).toBeInTheDocument();
    // Opening-float label + Open shift button are reachable.
    // The label appears multiple times (input label + helper text); the existence
    // assertion only needs ≥1.
    expect(screen.getAllByText(/Opening float/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /Open shift/i })).toBeInTheDocument();
  });

  it('mount fires GET /api/pos/registers + /api/pos/shifts/current + /api/wellness/locations', async () => {
    renderPOS();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(calls.some((u) => typeof u === 'string' && u.startsWith('/api/pos/registers'))).toBe(true);
      expect(calls.some((u) => typeof u === 'string' && u.startsWith('/api/pos/shifts/current'))).toBe(true);
      expect(calls.some((u) => typeof u === 'string' && u.startsWith('/api/wellness/locations'))).toBe(true);
    });
  });

  it('with an OPEN shift, renders the "Shift open" banner + "Current sale" basket header', async () => {
    renderPOS({
      fetchImpl: (url) => {
        if (typeof url === 'string') {
          if (url.startsWith('/api/pos/registers')) {
            return Promise.resolve([{ id: 1, name: 'Front Desk', location: { name: 'Main' } }]);
          }
          if (url.startsWith('/api/pos/shifts/current')) {
            return Promise.resolve({
              id: 99,
              registerId: 1,
              openingFloat: 500,
              register: { id: 1, name: 'Front Desk', location: { name: 'Main' } },
            });
          }
          if (url.startsWith('/api/wellness/locations')) {
            return Promise.resolve([{ id: 1, name: 'Main Clinic' }]);
          }
        }
        return Promise.resolve(null);
      },
    });

    // Banner copy includes "Shift open" + "opening float" (the formatted
    // money sibling) — pin the opening-float copy to disambiguate from
    // the closed-state heading.
    expect(await screen.findByText(/opening float/i)).toBeInTheDocument();
    // Empty basket header.
    expect(screen.getByText(/Current sale \(0 lines\)/i)).toBeInTheDocument();
  });
});
