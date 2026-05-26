import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * Wellness Visits page — broad contract pin.
 *
 * Scope (distinct from Visits.revenue.test.jsx which covers the #601
 * revenue-rollup rendering):
 *   - Loading + empty states
 *   - Patient-list rendering: name / phone / totals / last-visit
 *   - Date-range filter wires to the URL query
 *   - Per-page select wires to URL limit + resets skip
 *   - Custom-limit input flow (select → custom → bounds clamp → Back)
 *   - Pagination Previous/Next disable states
 *   - Patient row click drills into detail view (separate fetch)
 *   - Detail view: status badge text, doctor/service "—" fallbacks,
 *     notes truncation, "Back to Visits List" returns to list
 *   - Error states (fetch reject) render "No data." fallback
 *
 * fetchApi is mocked; tenant is INR/en-IN so money + date strings are
 * deterministic across CI ICU builds.
 */

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import Visits from '../pages/wellness/Visits';

const setTenant = (tenant) => {
  localStorage.setItem('tenant', JSON.stringify(tenant));
};

const renderVisits = () => render(<MemoryRouter><Visits /></MemoryRouter>);

const listPayload = (overrides = {}) => ({
  success: true,
  count: 2,
  totalRevenue: 18500,
  data: [
    {
      id: 1,
      name: 'Asha Patel',
      phone: '+919999900001',
      totalVisits: 3,
      totalRevenue: 12500,
      lastVisit: '2026-05-10T08:00:00.000Z',
    },
    {
      id: 2,
      name: 'Rohit Sharma',
      phone: null,
      totalVisits: 1,
      totalRevenue: 6000,
      lastVisit: '2026-05-05T08:00:00.000Z',
    },
  ],
  ...overrides,
});

const detailPayload = (overrides = {}) => ({
  success: true,
  count: 2,
  data: {
    patient: { id: 1, name: 'Asha Patel', phone: '+919999900001' },
    visits: [
      {
        id: 11,
        visitDate: '2026-05-10T08:00:00.000Z',
        doctor: { id: 1, name: 'Dr. Harsh' },
        service: { id: 5, name: 'GFC Hair Treatment' },
        amountCharged: 5000,
        revenue: 7500,
        status: 'completed',
        notes: 'First session went well, follow up in 4 weeks',
      },
      {
        id: 12,
        visitDate: '2026-04-15T08:00:00.000Z',
        doctor: null,
        service: null,
        amountCharged: null,
        revenue: null,
        status: 'pending',
        notes: '',
      },
    ],
  },
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
  fetchApi.mockReset();
});

describe('<Visits /> — broad contract', () => {
  it('renders the page header with Visits title + filter description', async () => {
    fetchApi.mockResolvedValue(listPayload());
    renderVisits();
    expect(screen.getByText('Visits')).toBeInTheDocument();
    expect(screen.getByText(/Patient visits — filterable by date/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());
  });

  it('shows Loading… placeholder before the first fetch resolves', () => {
    // Never-resolving promise so we observe the loading branch
    fetchApi.mockReturnValue(new Promise(() => {}));
    renderVisits();
    expect(screen.getByText(/Loading…/i)).toBeInTheDocument();
  });

  it('renders patient rows with name, phone, total visits, revenue', async () => {
    fetchApi.mockResolvedValue(listPayload());
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    expect(screen.getByText('Asha Patel')).toBeInTheDocument();
    expect(screen.getByText('Rohit Sharma')).toBeInTheDocument();
    expect(screen.getByText('+919999900001')).toBeInTheDocument();

    // Total Visits (en-IN locale numbers)
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('shows "No visits in this period." when data.data is empty', async () => {
    fetchApi.mockResolvedValue(listPayload({ count: 0, totalRevenue: 0, data: [] }));
    renderVisits();
    await waitFor(() => expect(screen.getByText(/No visits in this period\./i)).toBeInTheDocument());
  });

  it('renders dash fallback for missing phone numbers', async () => {
    fetchApi.mockResolvedValue(listPayload());
    renderVisits();
    await waitFor(() => expect(screen.getByText('Rohit Sharma')).toBeInTheDocument());

    // The patient row for Rohit Sharma has no phone → cell renders "—"
    const rohitRow = screen.getByText('Rohit Sharma').closest('tr');
    expect(rohitRow).not.toBeNull();
    expect(within(rohitRow).getByText('—')).toBeInTheDocument();
  });

  it('changing the from-date input triggers a new fetch with that startDate', async () => {
    fetchApi.mockResolvedValue(listPayload());
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    const inputs = document.querySelectorAll('input[type="date"]');
    expect(inputs.length).toBe(2);

    fireEvent.change(inputs[0], { target: { value: '2026-01-01' } });
    await waitFor(() => {
      const calls = fetchApi.mock.calls.map((c) => c[0]);
      expect(calls.some((u) => u.includes('startDate=2026-01-01'))).toBe(true);
    });
  });

  it('changing the per-page select dispatches a new fetch with that limit', async () => {
    fetchApi.mockResolvedValue(listPayload());
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    const selects = document.querySelectorAll('select');
    expect(selects.length).toBeGreaterThanOrEqual(1);
    const perPage = selects[0];

    fireEvent.change(perPage, { target: { value: '20' } });

    await waitFor(() => {
      const calls = fetchApi.mock.calls.map((c) => c[0]);
      expect(calls.some((u) => u.includes('limit=20'))).toBe(true);
    });
  });

  it('selecting "Custom" in per-page select reveals the custom limit input', async () => {
    fetchApi.mockResolvedValue(listPayload());
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    const perPage = document.querySelectorAll('select')[0];
    fireEvent.change(perPage, { target: { value: 'custom' } });

    const customInput = await screen.findByPlaceholderText(/Enter 1-50/i);
    expect(customInput).toBeInTheDocument();
    expect(screen.getByText(/^Back$/)).toBeInTheDocument();
  });

  it('custom-limit input clamps values > 50 down to 50', async () => {
    fetchApi.mockResolvedValue(listPayload());
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    const perPage = document.querySelectorAll('select')[0];
    fireEvent.change(perPage, { target: { value: 'custom' } });

    const customInput = await screen.findByPlaceholderText(/Enter 1-50/i);
    fireEvent.change(customInput, { target: { value: '999' } });

    await waitFor(() => {
      const calls = fetchApi.mock.calls.map((c) => c[0]);
      expect(calls.some((u) => /limit=50(?!\d)/.test(u))).toBe(true);
    });
  });

  it('clicking a patient row fetches that patient\'s detail and shows the detail header', async () => {
    fetchApi.mockResolvedValueOnce(listPayload());
    fetchApi.mockResolvedValueOnce(detailPayload());
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Asha Patel'));

    await waitFor(() => expect(screen.getByText(/Visits for Asha Patel/i)).toBeInTheDocument());
    // detail fetch URL targets the patient ID
    const detailCall = fetchApi.mock.calls.find((c) => c[0].includes('/api/wellness/reports/visit/1'));
    expect(detailCall).toBeTruthy();
  });

  it('detail view renders status badges per visit (completed / pending)', async () => {
    fetchApi.mockResolvedValueOnce(listPayload());
    fetchApi.mockResolvedValueOnce(detailPayload());
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Asha Patel'));
    await waitFor(() => expect(screen.getByText(/Visits for Asha Patel/i)).toBeInTheDocument());

    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('detail view renders "—" for missing doctor/service and empty notes', async () => {
    fetchApi.mockResolvedValueOnce(listPayload());
    fetchApi.mockResolvedValueOnce(detailPayload());
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Asha Patel'));
    await waitFor(() => expect(screen.getByText(/Visits for Asha Patel/i)).toBeInTheDocument());

    // Visit #12 has no doctor, no service, no notes → multiple "—" cells
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(3);
  });

  it('detail view truncates long notes with an ellipsis after 20 chars', async () => {
    fetchApi.mockResolvedValueOnce(listPayload());
    fetchApi.mockResolvedValueOnce(detailPayload());
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Asha Patel'));
    await waitFor(() => expect(screen.getByText(/Visits for Asha Patel/i)).toBeInTheDocument());

    // "First session went well, follow up in 4 weeks" (>20 chars) → truncated
    expect(screen.getByText(/^First session went w\.\.\.$/)).toBeInTheDocument();
  });

  it('"Back to Visits List" returns from detail to the patient list', async () => {
    fetchApi.mockResolvedValueOnce(listPayload());
    fetchApi.mockResolvedValueOnce(detailPayload());
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Asha Patel'));
    await waitFor(() => expect(screen.getByText(/Visits for Asha Patel/i)).toBeInTheDocument());

    const backBtn = screen.getByText(/Back to Visits List/i);
    fireEvent.click(backBtn);

    await waitFor(() => expect(screen.queryByText(/Visits for Asha Patel/i)).not.toBeInTheDocument());
    expect(screen.getByText(/Patient visits — filterable by date/i)).toBeInTheDocument();
  });

  it('detail view header reflects visit count ("2 visits in selected period")', async () => {
    fetchApi.mockResolvedValueOnce(listPayload());
    fetchApi.mockResolvedValueOnce(detailPayload());
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Asha Patel'));
    await waitFor(() => expect(screen.getByText(/Visits for Asha Patel/i)).toBeInTheDocument());

    expect(screen.getByText(/2 visits in selected period/i)).toBeInTheDocument();
  });

  it('detail-view singular count uses "1 visit" (no plural-s)', async () => {
    fetchApi.mockResolvedValueOnce(listPayload());
    fetchApi.mockResolvedValueOnce(
      detailPayload({
        count: 1,
        data: {
          patient: { id: 1, name: 'Asha Patel', phone: '+919999900001' },
          visits: [
            {
              id: 11,
              visitDate: '2026-05-10T08:00:00.000Z',
              doctor: { id: 1, name: 'Dr. Harsh' },
              service: { id: 5, name: 'Consult' },
              amountCharged: 1500,
              revenue: 1500,
              status: 'completed',
              notes: '',
            },
          ],
        },
      })
    );
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Asha Patel'));
    await waitFor(() => expect(screen.getByText(/Visits for Asha Patel/i)).toBeInTheDocument());

    expect(screen.getByText(/1 visit in selected period/i)).toBeInTheDocument();
    // not "1 visits"
    expect(screen.queryByText(/1 visits in selected period/i)).not.toBeInTheDocument();
  });

  it('fetch rejection on initial load renders the "No data." fallback', async () => {
    fetchApi.mockRejectedValue(new Error('boom'));
    renderVisits();
    await waitFor(() => expect(screen.getByText(/No data\./i)).toBeInTheDocument());
  });

  it('Previous button is disabled on the first page (skip=0)', async () => {
    fetchApi.mockResolvedValue(listPayload({ count: 50 }));
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    // Pagination visible only when count > limit (50 > 10)
    const prev = screen.getByRole('button', { name: /Previous/i });
    expect(prev).toBeDisabled();
  });

  it('clicking Next advances skip by limit and re-fetches', async () => {
    fetchApi.mockResolvedValue(listPayload({ count: 50 }));
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    const next = screen.getByRole('button', { name: /Next/i });
    expect(next).not.toBeDisabled();
    fireEvent.click(next);

    await waitFor(() => {
      const calls = fetchApi.mock.calls.map((c) => c[0]);
      expect(calls.some((u) => u.includes('skip=10') && u.includes('limit=10'))).toBe(true);
    });
  });

  it('Revenue summary card renders the totalRevenue value', async () => {
    fetchApi.mockResolvedValue(listPayload({ totalRevenue: 18500 }));
    renderVisits();
    await waitFor(() => expect(screen.getByText('Asha Patel')).toBeInTheDocument());

    // The Revenue label
    expect(screen.getByText(/^Revenue$/)).toBeInTheDocument();
    // 18,500 grouped in en-IN
    const matches = screen.getAllByText(/18,500/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});
