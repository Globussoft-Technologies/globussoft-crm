/**
 * Pipeline.jsx — drag-and-drop probability sync (#605).
 *
 * Pre-fix: dragging a deal between stages updated only the `stage` field via
 * PUT /:id/stage; the deal's `probability` stayed at the old value until a
 * full re-fetch / hard refresh. Forecast widget + per-column weighted total
 * rendered stale numbers for ~30s. Some users manually re-edited the deal
 * to "fix" the probability, double-saving.
 *
 * Fix: drag handler computes the destination stage's default probability
 * (won=100, lost=0, lead=25, contacted=40, proposal=70, negotiation=80) and
 * sends BOTH stage AND probability in a single PUT /:id call. Local state
 * updates optimistically with both fields so the badge / column total
 * reflect the new stage immediately.
 *
 * Contracts pinned here:
 *   1. Drop on `won` snaps probability to 100 in local state immediately.
 *   2. Drop on `lost` snaps probability to 0 in local state immediately.
 *   3. Drop on intermediate stage (e.g. proposal) sets probability per
 *      the stage→probability mapping (proposal=70).
 *   4. The network call is PUT /:id with BOTH {stage, probability} in the
 *      body, NOT PUT /:id/stage with stage-only.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
}));

vi.mock('socket.io-client', () => ({
  io: () => ({
    on: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock('../components/DealModal', () => ({
  default: () => null,
}));

import { fetchApi } from '../utils/api';
import Pipeline from '../pages/Pipeline';

const STAGES = [
  { id: 1, name: 'Lead', color: '#3b82f6', position: 0 },
  { id: 2, name: 'Contacted', color: '#f59e0b', position: 1 },
  { id: 3, name: 'Proposal', color: '#a855f7', position: 2 },
  { id: 4, name: 'Won', color: '#10b981', position: 3 },
  { id: 5, name: 'Lost', color: '#ef4444', position: 4 },
];

beforeEach(() => {
  vi.clearAllMocks();
  try {
    localStorage.setItem('tenant', JSON.stringify({ defaultCurrency: 'USD', locale: 'en-US' }));
  } catch {
    /* ignore */
  }
});

function mockApi({ deals = [] }) {
  fetchApi.mockImplementation((url, opts) => {
    if (url === '/api/deals') return Promise.resolve(deals);
    if (url === '/api/contacts') return Promise.resolve([]);
    if (url === '/api/pipeline_stages') return Promise.resolve(STAGES);
    // PUT /api/deals/:id — return the body merged onto the existing deal,
    // mimicking the server's reconcile behaviour.
    if (url.startsWith('/api/deals/') && opts && opts.method === 'PUT') {
      const id = parseInt(url.split('/').pop());
      const body = JSON.parse(opts.body || '{}');
      const existing = deals.find(d => d.id === id) || { id };
      return Promise.resolve({ ...existing, ...body });
    }
    return Promise.resolve(null);
  });
}

function makeDataTransfer(dealId) {
  // Minimal DataTransfer stub — Pipeline.jsx only calls setData on dragstart
  // and getData on drop.
  const store = {};
  return {
    setData: (k, v) => { store[k] = String(v); },
    getData: (k) => (k === 'dealId' ? String(dealId) : store[k] || ''),
  };
}

async function performDrop(dealId, targetStageHeading) {
  // Find the target column by its <h3> stage title and walk up to the column
  // container (the .glass div with the onDrop handler).
  const heading = screen.getByText(targetStageHeading, { selector: 'h3' });
  const column = heading.closest('.glass');
  expect(column).toBeTruthy();
  const dataTransfer = makeDataTransfer(dealId);
  fireEvent.dragOver(column, { dataTransfer });
  fireEvent.drop(column, { dataTransfer });
}

describe('Pipeline drag-and-drop probability sync (#605)', () => {
  it('drop on Closed Won snaps probability to 100 immediately and sends PUT /:id with both fields', async () => {
    const initialDeal = {
      id: 101, title: 'Acme Corp Renewal', amount: 50000, probability: 25, stage: 'lead',
    };
    mockApi({ deals: [initialDeal] });

    render(<MemoryRouter><Pipeline /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument());

    // Pre-drop, the badge in the Lead column reads 25%.
    expect(screen.getByText('25%')).toBeInTheDocument();

    await performDrop(101, 'Won');

    // Probability snaps to 100% optimistically (before the network response).
    await waitFor(() => {
      expect(screen.getByText('100%')).toBeInTheDocument();
      expect(screen.queryByText('25%')).not.toBeInTheDocument();
    });

    // Network call shape: PUT /api/deals/101 with both stage AND probability
    // in the body. NOT /api/deals/101/stage.
    const putCall = fetchApi.mock.calls.find(
      ([url, opts]) => url === '/api/deals/101' && opts?.method === 'PUT',
    );
    expect(putCall).toBeTruthy();
    const body = JSON.parse(putCall[1].body);
    expect(body).toEqual({ stage: 'won', probability: 100 });
  });

  it('drop on Closed Lost snaps probability to 0 immediately', async () => {
    const initialDeal = {
      id: 102, title: 'Globex Expansion', amount: 40000, probability: 70, stage: 'proposal',
    };
    mockApi({ deals: [initialDeal] });

    render(<MemoryRouter><Pipeline /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument());

    expect(screen.getByText('70%')).toBeInTheDocument();

    await performDrop(102, 'Lost');

    await waitFor(() => {
      expect(screen.getByText('0%')).toBeInTheDocument();
    });

    const putCall = fetchApi.mock.calls.find(
      ([url, opts]) => url === '/api/deals/102' && opts?.method === 'PUT',
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse(putCall[1].body)).toEqual({ stage: 'lost', probability: 0 });
  });

  it('drop on intermediate stage uses the stage→probability mapping (proposal=70)', async () => {
    const initialDeal = {
      id: 103, title: 'Initech Annual', amount: 90000, probability: 25, stage: 'lead',
    };
    mockApi({ deals: [initialDeal] });

    render(<MemoryRouter><Pipeline /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument());

    expect(screen.getByText('25%')).toBeInTheDocument();

    await performDrop(103, 'Proposal');

    await waitFor(() => {
      expect(screen.getByText('70%')).toBeInTheDocument();
    });

    const putCall = fetchApi.mock.calls.find(
      ([url, opts]) => url === '/api/deals/103' && opts?.method === 'PUT',
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse(putCall[1].body)).toEqual({ stage: 'proposal', probability: 70 });
  });
});
