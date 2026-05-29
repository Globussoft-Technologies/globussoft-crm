/**
 * Estimates.jsx — #603 per-row action buttons.
 *
 * What this test pins
 * -------------------
 *   #603 — Estimates list rows MUST expose at least: Download PDF, Email
 *          (to linked contact), Convert to Invoice, Delete. Pre-fix the
 *          list only had Convert + Delete; users were forced into the
 *          row detail page for every PDF / email action.
 *
 *          - PDF button issues a fetch to /api/estimates/:id/pdf with the
 *            auth header, then triggers a download.
 *          - Email button POSTs to /api/estimates/:id/email and surfaces
 *            success / failure via notify.
 *          - Email button is disabled when the linked contact has no email.
 *
 * Backend contract pinned by this test
 * ------------------------------------
 *   - GET /api/estimates/:id/pdf returns a Blob (application/pdf)
 *   - POST /api/estimates/:id/email accepts {} body, returns { delivered }
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),

  prompt: vi.fn(() => Promise.resolve("")),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

vi.mock('../utils/money', () => ({
  formatMoney: (v) => `$${(Number(v) || 0).toFixed(2)}`,
  currencySymbol: () => '$',
}));
vi.mock('../utils/date', () => ({
  formatDate: (d) => new Date(d).toISOString().slice(0, 10),
}));

import Estimates from '../pages/Estimates';

const sampleEstimate = {
  id: 42,
  estimateNum: 'EST-AAAA01',
  title: 'Q1 maintenance retainer',
  status: 'Draft',
  totalAmount: 5000,
  validUntil: '2026-12-31',
  createdAt: '2026-01-01',
  contact: { id: 7, name: 'Aanya Sharma', email: 'aanya@example.com' },
  lineItems: [{ id: 1, description: 'Hours', quantity: 10, unitPrice: 500 }],
};

const sampleNoEmail = {
  ...sampleEstimate,
  id: 43,
  estimateNum: 'EST-AAAA02',
  contact: { id: 8, name: 'Rohit (no email)', email: null },
};

function fakeFetchApi(url, opts) {
  if (url === '/api/estimates' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve([sampleEstimate, sampleNoEmail]);
  }
  if (url === '/api/contacts') return Promise.resolve([]);
  if (url === '/api/deals') return Promise.resolve([]);
  if (url.startsWith('/api/estimates/') && url.endsWith('/email') && opts?.method === 'POST') {
    return Promise.resolve({ success: true, delivered: true, to: 'aanya@example.com' });
  }
  return Promise.resolve([]);
}

describe('<Estimates /> — #603 per-row actions', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notify.success.mockReset();
    notify.error.mockReset();
    notify.info.mockReset();
    notify.confirm.mockClear();
    notify.confirm.mockImplementation(() => Promise.resolve(true));
    fetchApiMock.mockImplementation(fakeFetchApi);
    // Stub global fetch for the PDF download path.
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      blob: () => Promise.resolve(new Blob(['%PDF'], { type: 'application/pdf' })),
    }));
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('renders PDF, Email, Convert, and Delete row buttons for each estimate', async () => {
    render(<Estimates />);
    await waitFor(() => expect(screen.getByText('EST-AAAA01')).toBeInTheDocument());
    // PDF + Email + Convert + Delete present for the first row.
    expect(screen.getByLabelText(/Download PDF for estimate EST-AAAA01/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Email estimate EST-AAAA01/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Convert estimate EST-AAAA01 to invoice/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Delete estimate EST-AAAA01/i)).toBeInTheDocument();
  });

  it('clicking PDF fetches /api/estimates/:id/pdf with the auth header', async () => {
    const user = userEvent.setup();
    render(<Estimates />);
    await waitFor(() => expect(screen.getByText('EST-AAAA01')).toBeInTheDocument());
    await user.click(screen.getByLabelText(/Download PDF for estimate EST-AAAA01/i));
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
      const url = globalThis.fetch.mock.calls[0][0];
      expect(url).toMatch(/\/api\/estimates\/42\/pdf$/);
      expect(globalThis.fetch.mock.calls[0][1]?.headers?.Authorization).toBe('Bearer test-token');
    });
  });

  it('clicking Email POSTs to /api/estimates/:id/email and surfaces success', async () => {
    const user = userEvent.setup();
    render(<Estimates />);
    await waitFor(() => expect(screen.getByText('EST-AAAA01')).toBeInTheDocument());
    await user.click(screen.getByLabelText(/Email estimate EST-AAAA01/i));
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url, opts]) => /\/api\/estimates\/42\/email$/.test(url) && opts?.method === 'POST'
      );
      expect(calls.length).toBe(1);
    });
    expect(notify.success).toHaveBeenCalledWith(expect.stringMatching(/aanya@example\.com/));
  });

  it('Email button is disabled when the contact has no email', async () => {
    render(<Estimates />);
    await waitFor(() => expect(screen.getByText('EST-AAAA02')).toBeInTheDocument());
    const emailBtn = screen.getByLabelText(/Email estimate EST-AAAA02/i);
    expect(emailBtn).toBeDisabled();
  });
});
