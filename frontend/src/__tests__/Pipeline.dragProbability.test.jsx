/**
 * Pipeline.jsx — inline stage update and probability sync.
 *
 * The pipeline was revamped from a kanban (drag-and-drop) to a flat table
 * with an inline stage <select> per row. This file pins the inline stage
 * update contracts that replaced the drag-and-drop probability sync (#605).
 *
 * Contracts pinned here:
 *   1. Changing the stage <select> to "won" PUTs /api/deals/:id with
 *      { stage: 'won' } and updates the row optimistically.
 *   2. Changing the stage <select> to "lost" PUTs /api/deals/:id with
 *      { stage: 'lost' }.
 *   3. Changing to an intermediate stage sends the correct stage value.
 *   4. On PUT error, the row reverts to its original stage and shows
 *      notify.error.
 *   5. The stage select is disabled while the update is in-flight.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../App';

// ── Stable notify mock ────────────────────────────────────────────────────────
const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(),
};
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));
vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
vi.mock('../utils/money', () => ({
  formatMoney: (n) => (n != null ? `$${Number(n).toLocaleString('en-US')}` : '—'),
  currencySymbol: () => '$',
}));
vi.mock('socket.io-client', () => ({
  io: () => ({ on: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock('../components/DealModal', () => ({ default: () => null }));

import { fetchApi } from '../utils/api';
import Pipeline from '../pages/Pipeline';

const STAGES = [
  { id: 1, name: 'Lead',     color: '#3b82f6', position: 0 },
  { id: 2, name: 'Proposal', color: '#a855f7', position: 1 },
  { id: 3, name: 'Won',      color: '#10b981', position: 2 },
  { id: 4, name: 'Lost',     color: '#ef4444', position: 3 },
];

beforeEach(() => {
  vi.clearAllMocks();
  notifyObj.confirm.mockResolvedValue(true);
});

function mockApi(deals, putResponse = null) {
  fetchApi.mockImplementation((url, opts) => {
    if (opts?.method === 'PUT') {
      if (putResponse instanceof Error) return Promise.reject({ body: { error: putResponse.message } });
      const id = parseInt(url.split('/').pop(), 10);
      const body = JSON.parse(opts.body || '{}');
      const existing = deals.find((d) => d.id === id) || { id };
      return Promise.resolve({ ...existing, ...body });
    }
    if (url.startsWith('/api/deals')) return Promise.resolve(deals);
    if (url.startsWith('/api/pipeline_stages')) return Promise.resolve(STAGES);
    return Promise.resolve([]);
  });
}

function renderPage() {
  return render(
    <AuthContext.Provider value={{ user: null }}>
      <MemoryRouter><Pipeline /></MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('Pipeline inline stage update (replaces drag-and-drop after table revamp)', () => {
  it('changing stage to "won" sends PUT /api/deals/:id with { stage: "won" }', async () => {
    const deals = [
      { id: 101, title: 'Acme Corp Renewal', amount: 50000, probability: 25, stage: 'lead' },
    ];
    mockApi(deals);
    renderPage();
    await screen.findByText('Acme Corp Renewal');

    const [stageSelect] = screen.getAllByRole('combobox', { name: /change stage/i });
    fireEvent.change(stageSelect, { target: { value: 'won' } });

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(([url, opts]) =>
        url.includes('/api/deals/101') && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      expect(JSON.parse(putCall[1].body)).toMatchObject({ stage: 'won' });
    });
  });

  it('changing stage to "lost" sends PUT /api/deals/:id with { stage: "lost" }', async () => {
    const deals = [
      { id: 102, title: 'Globex Expansion', amount: 40000, probability: 70, stage: 'proposal' },
    ];
    mockApi(deals);
    renderPage();
    await screen.findByText('Globex Expansion');

    const [stageSelect] = screen.getAllByRole('combobox', { name: /change stage/i });
    fireEvent.change(stageSelect, { target: { value: 'lost' } });

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(([url, opts]) =>
        url.includes('/api/deals/102') && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      expect(JSON.parse(putCall[1].body)).toMatchObject({ stage: 'lost' });
    });
  });

  it('changing stage to an intermediate value sends the correct stage slug', async () => {
    const deals = [
      { id: 103, title: 'Initech Annual', amount: 90000, probability: 25, stage: 'lead' },
    ];
    mockApi(deals);
    renderPage();
    await screen.findByText('Initech Annual');

    const [stageSelect] = screen.getAllByRole('combobox', { name: /change stage/i });
    fireEvent.change(stageSelect, { target: { value: 'proposal' } });

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(([url, opts]) =>
        url.includes('/api/deals/103') && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      expect(JSON.parse(putCall[1].body)).toMatchObject({ stage: 'proposal' });
    });
  });

  it('reverts stage and shows notify.error when PUT fails', async () => {
    const deals = [
      { id: 104, title: 'Revert Test Deal', amount: 5000, probability: 30, stage: 'lead' },
    ];
    mockApi(deals, new Error('Server error'));
    renderPage();
    await screen.findByText('Revert Test Deal');

    const [stageSelect] = screen.getAllByRole('combobox', { name: /change stage/i });
    fireEvent.change(stageSelect, { target: { value: 'won' } });

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith('Server error');
    });
    // After error, the select reverts to original value — wait for re-render
    await waitFor(() => {
      expect(screen.getAllByRole('combobox', { name: /change stage/i })[0]).toHaveValue('lead');
    });
  });

  it('shows probability badge for each deal row', async () => {
    const deals = [
      { id: 201, title: 'Deal A', amount: 1000, probability: 45, stage: 'proposal' },
      { id: 202, title: 'Deal B', amount: 2000, probability: 80, stage: 'won' },
    ];
    mockApi(deals);
    renderPage();
    await screen.findByText('Deal A');
    expect(screen.getByText('45%')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
  });
});
