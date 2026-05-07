import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * #601 — Wellness Visits page revenue rendering.
 *
 * Pre-fix:
 *   - Per-visit cell read from `visit.amountCharged` only (often null).
 *   - No page-level Revenue summary card on the patient list.
 *
 * Post-fix:
 *   - Per-visit cell reads `visit.revenue` first (server-side rollup that
 *     prefers paid invoices, falls back to amountCharged), then defaults
 *     to amountCharged for backward compat with older API responses.
 *   - Patient list shows a Revenue summary card driven by data.totalRevenue.
 */

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import Visits from '../pages/wellness/Visits';

const setTenant = (tenant) => {
  localStorage.setItem('tenant', JSON.stringify(tenant));
};

beforeEach(() => {
  localStorage.clear();
  setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
  fetchApi.mockReset();
});

describe('<Visits /> — #601 revenue rendering', () => {
  it('renders page-level Revenue summary card from data.totalRevenue', async () => {
    fetchApi.mockResolvedValue({
      success: true,
      count: 1,
      totalRevenue: 12500,
      data: [
        {
          id: 1,
          name: 'Asha Patel',
          phone: '+919999900001',
          totalVisits: 2,
          totalRevenue: 12500,
          lastVisit: new Date().toISOString(),
        },
      ],
    });

    render(<MemoryRouter><Visits /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    // Revenue summary card label + value (Indian-grouped INR)
    expect(screen.getByText(/^Revenue$/i)).toBeInTheDocument();
    // 12,500 appears in BOTH the page-card AND the patient row's Total
    // Revenue cell — getAllByText is the right matcher.
    const matches = screen.getAllByText(/12,500/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('per-visit detail row uses visit.revenue when present', async () => {
    // First call: patient list
    fetchApi.mockResolvedValueOnce({
      success: true,
      count: 1,
      totalRevenue: 7500,
      data: [
        {
          id: 1,
          name: 'Asha Patel',
          phone: '+919999900001',
          totalVisits: 1,
          totalRevenue: 7500,
          lastVisit: new Date().toISOString(),
        },
      ],
    });
    // Second call: patient detail (clicked into)
    fetchApi.mockResolvedValueOnce({
      success: true,
      count: 1,
      data: {
        patient: { id: 1, name: 'Asha Patel', phone: '+919999900001' },
        visits: [
          {
            id: 11,
            visitDate: new Date().toISOString(),
            doctor: { id: 1, name: 'Dr. Harsh' },
            service: { id: 5, name: 'GFC Hair' },
            amountCharged: 5000,
            revenue: 7500,           // paid-invoice rollup wins
            status: 'completed',
            notes: 'Session 1',
          },
        ],
      },
    });

    render(<MemoryRouter><Visits /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    // Click into the patient
    fireEvent.click(screen.getByText('Asha Patel'));

    await waitFor(() => expect(screen.getByText(/Visits for Asha Patel/)).toBeInTheDocument());

    // Detail row's Amount column should show 7,500 (revenue), not 5,000
    expect(screen.getByText(/7,500/)).toBeInTheDocument();
    expect(screen.queryByText(/5,000/)).not.toBeInTheDocument();
  });

  it('per-visit detail row falls back to amountCharged when revenue is missing', async () => {
    fetchApi.mockResolvedValueOnce({
      success: true,
      count: 1,
      totalRevenue: 5000,
      data: [
        {
          id: 1,
          name: 'Asha Patel',
          phone: '+919999900001',
          totalVisits: 1,
          totalRevenue: 5000,
          lastVisit: new Date().toISOString(),
        },
      ],
    });
    fetchApi.mockResolvedValueOnce({
      success: true,
      count: 1,
      data: {
        patient: { id: 1, name: 'Asha Patel', phone: '+919999900001' },
        visits: [
          {
            id: 11,
            visitDate: new Date().toISOString(),
            doctor: { id: 1, name: 'Dr. Harsh' },
            service: { id: 5, name: 'GFC Hair' },
            amountCharged: 5000,
            // revenue intentionally missing — older response shape
            status: 'completed',
            notes: 'Session 1',
          },
        ],
      },
    });

    render(<MemoryRouter><Visits /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Asha Patel'));
    await waitFor(() => expect(screen.getByText(/Visits for Asha Patel/)).toBeInTheDocument());

    // Falls back to amountCharged
    expect(screen.getByText(/5,000/)).toBeInTheDocument();
  });

  it('renders ₹0 when revenue is null and amountCharged is null', async () => {
    fetchApi.mockResolvedValueOnce({
      success: true,
      count: 1,
      totalRevenue: 0,
      data: [
        {
          id: 1,
          name: 'Asha Patel',
          phone: '+919999900001',
          totalVisits: 1,
          totalRevenue: 0,
          lastVisit: new Date().toISOString(),
        },
      ],
    });
    fetchApi.mockResolvedValueOnce({
      success: true,
      count: 1,
      data: {
        patient: { id: 1, name: 'Asha Patel', phone: '+919999900001' },
        visits: [
          {
            id: 11,
            visitDate: new Date().toISOString(),
            doctor: null,
            service: null,
            amountCharged: null,
            revenue: null,
            status: 'booked',
            notes: '',
          },
        ],
      },
    });

    render(<MemoryRouter><Visits /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Asha Patel'));
    await waitFor(() => expect(screen.getByText(/Visits for Asha Patel/)).toBeInTheDocument());

    // Multiple ₹0 cells (page-card + detail row); ensure at least one
    const zeros = screen.getAllByText(/₹\s*0(?:\.|$|\s)/);
    expect(zeros.length).toBeGreaterThanOrEqual(1);
  });
});
