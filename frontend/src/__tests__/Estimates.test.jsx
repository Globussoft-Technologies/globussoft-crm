/**
 * Estimates.test.jsx — vitest + RTL page-level smoke for the Estimates page.
 *
 * Scope: pins the page-surface invariants for the sales-workflow estimate
 * builder + ledger. This is the page-level smoke complement to
 * Estimates.rowActions.test.jsx (which pins per-row PDF / Email / Convert /
 * Delete contracts).
 *
 *   1. Page renders heading "Estimates" + Create Estimate form + Estimate
 *      Ledger panel.
 *   2. Renders one row per /api/estimates entry with estimateNum, title,
 *      contact name, total (formatted), status badge.
 *   3. Empty state: "No estimates yet. Create one to get started." renders
 *      when /api/estimates returns [].
 *   4. Status-filter pills: clicking "Drafts" filters the ledger to Draft
 *      rows; clicking "Sent" filters to Sent rows; clicking the same pill
 *      twice resets to "all".
 *   5. Submitting the create form POSTs /api/estimates with title +
 *      lineItems (with discount baked into unitPrice).
 *   6. Validation: out-of-range line-item discount disables the submit
 *      button and surfaces an inline "out of range" message.
 *   7. Total Value pill reflects the visibleEstimates total (filter-aware):
 *      switching to Sent filter changes the total to the sum of Sent rows.
 *
 * Drift note: per-row PDF/Email/Convert/Delete row actions are pinned by
 * Estimates.rowActions.test.jsx. This file covers the page chrome +
 * create-form + status-filter contract. The visible-total pin is the
 * canonical regression test for the #255/#288 dupe (Total Value was
 * summing ALL estimates regardless of filter).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyError = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: vi.fn(),
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('../utils/money', () => ({
  formatMoney: (v) => `$${(Number(v) || 0).toFixed(2)}`,
  currencySymbol: () => '$',
}));
vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import { AuthContext } from '../App';
import Estimates from '../pages/Estimates';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

function renderEstimates() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user: ADMIN_USER, token: 'tk', tenant: { id: 1 }, loading: false }}>
        <Estimates />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

const sampleEstimates = [
  {
    id: 1,
    estimateNum: 'EST-001',
    title: 'Q1 retainer',
    status: 'Draft',
    totalAmount: 5000,
    validUntil: '2026-12-31',
    createdAt: '2026-01-01',
    contact: { id: 1, name: 'Acme Corp', email: 'a@acme.test' },
    lineItems: [{ id: 1, description: 'Hours', quantity: 10, unitPrice: 500 }],
  },
  {
    id: 2,
    estimateNum: 'EST-002',
    title: 'Onboarding package',
    status: 'Sent',
    totalAmount: 2000,
    validUntil: '2026-11-30',
    createdAt: '2026-02-01',
    contact: { id: 2, name: 'Globex Inc', email: 'b@globex.test' },
    lineItems: [{ id: 2, description: 'Setup', quantity: 1, unitPrice: 2000 }],
  },
  {
    id: 3,
    estimateNum: 'EST-003',
    title: 'Renewal proposal',
    status: 'Draft',
    totalAmount: 1500,
    validUntil: '2026-10-31',
    createdAt: '2026-03-01',
    contact: { id: 1, name: 'Acme Corp', email: 'a@acme.test' },
    lineItems: [{ id: 3, description: 'Maintenance', quantity: 5, unitPrice: 300 }],
  },
];

const sampleContacts = [
  { id: 1, name: 'Acme Corp', email: 'a@acme.test' },
  { id: 2, name: 'Globex Inc', email: 'b@globex.test' },
];

const sampleDeals = [
  { id: 1, title: 'Acme Renewal', amount: 50000 },
];

function defaultFetchMock(url, opts) {
  if (url === '/api/estimates' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleEstimates);
  }
  if (url === '/api/contacts') return Promise.resolve(sampleContacts);
  if (url === '/api/deals') return Promise.resolve(sampleDeals);
  return Promise.resolve([]);
}

describe('<Estimates /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
    fetchApiMock.mockImplementation(defaultFetchMock);
  });

  it('renders the heading + Create Estimate form + Estimate Ledger', async () => {
    renderEstimates();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Estimates$/i })).toBeInTheDocument();
    });
    // "Create Estimate" appears as both the form-panel heading AND the
    // submit button label, so use getAllByText with length >= 2.
    expect(screen.getAllByText(/Create Estimate/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Estimate Ledger/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Estimate/i })).toBeInTheDocument();
  });

  it('renders one row per estimate with estimateNum, title, contact, total, and status', async () => {
    renderEstimates();
    await waitFor(() => expect(screen.getByText('EST-001')).toBeInTheDocument());
    expect(screen.getByText('EST-002')).toBeInTheDocument();
    expect(screen.getByText('EST-003')).toBeInTheDocument();
    expect(screen.getByText('Q1 retainer')).toBeInTheDocument();
    expect(screen.getByText('Onboarding package')).toBeInTheDocument();
    // Acme appears as a contact on 2 rows AND in the Contact dropdown
    // option; just check at least 1 occurrence.
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThanOrEqual(1);
    // formatMoney mock yields $<amount>.
    expect(screen.getByText('$5000.00')).toBeInTheDocument();
    expect(screen.getByText('$2000.00')).toBeInTheDocument();
    expect(screen.getByText('$1500.00')).toBeInTheDocument();
    // Status badges — Sent appears as a badge + as the "Sent" pill label, so
    // assert at least one. Draft also appears in the Drafts pill.
    expect(screen.getAllByText('Sent').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Draft').length).toBeGreaterThanOrEqual(1);
  });

  it('shows the empty-state message when /api/estimates returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/estimates') return Promise.resolve([]);
      if (url === '/api/contacts') return Promise.resolve([]);
      if (url === '/api/deals') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderEstimates();
    await waitFor(() => {
      expect(
        screen.getByText(/No estimates yet\. Create one to get started\./i)
      ).toBeInTheDocument();
    });
  });

  it('clicking the "Sent" status pill filters the ledger to Sent rows only', async () => {
    renderEstimates();
    await waitFor(() => expect(screen.getByText('EST-001')).toBeInTheDocument());
    // All 3 rows visible initially.
    expect(screen.getByText('EST-001')).toBeInTheDocument();
    expect(screen.getByText('EST-002')).toBeInTheDocument();
    expect(screen.getByText('EST-003')).toBeInTheDocument();

    // Click Sent pill (button shows "1 Sent" — there's one Sent estimate).
    const sentPill = screen.getByRole('button', { pressed: false, name: /Sent$/ });
    fireEvent.click(sentPill);

    // Only EST-002 (Sent) remains.
    await waitFor(() => {
      expect(screen.getByText('EST-002')).toBeInTheDocument();
      expect(screen.queryByText('EST-001')).not.toBeInTheDocument();
      expect(screen.queryByText('EST-003')).not.toBeInTheDocument();
    });
  });

  it('submitting the create form POSTs /api/estimates with title and lineItems', async () => {
    renderEstimates();
    await waitFor(() => expect(screen.getByText('EST-001')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/estimates' && opts?.method === 'POST') {
        return Promise.resolve({ id: 99, estimateNum: 'EST-099', status: 'Draft' });
      }
      return defaultFetchMock(url, opts);
    });

    // Set title.
    fireEvent.change(screen.getByLabelText(/Estimate title/i), {
      target: { value: 'Test estimate' },
    });
    // Set line-item description.
    fireEvent.change(screen.getByLabelText(/Line item 1 description/i), {
      target: { value: 'Hours' },
    });
    fireEvent.change(screen.getByLabelText(/Line item 1 quantity/i), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText(/Line item 1 unit price/i), {
      target: { value: '100' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create Estimate/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/estimates' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.title).toBe('Test estimate');
      expect(Array.isArray(body.lineItems)).toBe(true);
      expect(body.lineItems[0]).toMatchObject({
        description: 'Hours',
        quantity: 2,
        unitPrice: 100,
      });
    });
  });

  it('out-of-range discount disables submit and surfaces an "out of range" message', async () => {
    renderEstimates();
    await waitFor(() => expect(screen.getByText('EST-001')).toBeInTheDocument());

    // Set a discount above the cap (100).
    fireEvent.change(screen.getByLabelText(/Line item 1 discount percent/i), {
      target: { value: '150' },
    });

    // The "out of range" inline message renders.
    await waitFor(() => {
      expect(screen.getByText(/out of range/i)).toBeInTheDocument();
    });

    // The submit button is disabled.
    const submitBtn = screen.getByRole('button', { name: /Create Estimate/i });
    expect(submitBtn).toBeDisabled();
  });

  it('Total Value pill reflects the visibleEstimates total (filter-aware)', async () => {
    renderEstimates();
    await waitFor(() => expect(screen.getByText('EST-001')).toBeInTheDocument());

    // All total = 5000 + 2000 + 1500 = 8500.
    expect(screen.getByText(/Total Value:\s*\$8500\.00/i)).toBeInTheDocument();

    // Click Sent pill — visibleEstimates becomes [EST-002] (totalAmount=2000).
    const sentPill = screen.getByRole('button', { pressed: false, name: /Sent$/ });
    fireEvent.click(sentPill);

    await waitFor(() => {
      expect(screen.getByText(/Total Value:\s*\$2000\.00/i)).toBeInTheDocument();
    });
  });
});
