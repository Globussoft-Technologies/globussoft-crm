import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../App';

const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(),
};

vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));
vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
vi.mock('../utils/money', () => ({
  formatMoney: (value) => `$${Number(value || 0).toLocaleString('en-US')}`,
}));
vi.mock('../components/DealModal', () => ({ default: () => null }));
vi.mock('../components/contact/ActionModals', () => ({
  DealModal: ({ onClose }) => (
    <div role="dialog" aria-label="Add deal dialog">
      <button type="button" onClick={onClose}>Cancel</button>
    </div>
  ),
}));

import { fetchApi } from '../utils/api';
import Pipeline, { slugifyStageName, VIRTUALIZATION_THRESHOLD } from '../pages/Pipeline';

const STAGES = [
  { id: 1, name: 'New Lead', color: '#3b82f6', position: 0 },
  { id: 2, name: 'Won', color: '#10b981', position: 1 },
  { id: 3, name: 'Lost', color: '#ef4444', position: 2 },
];

const DEALS = [
  { id: 1, title: 'Acme Corp Renewal', company: 'Acme', contactName: 'Alice', ownerName: 'Anita', amount: 50000, probability: 25, stage: 'new-lead', expectedClose: '2026-09-01T00:00:00.000Z' },
  { id: 2, title: 'Globex Expansion', company: 'Globex', contactName: 'Bob', ownerName: 'Vikram', amount: 90000, probability: 100, stage: 'won', expectedClose: null },
  { id: 3, title: 'Initech Deal', company: 'Initech', contactName: 'Carol', ownerName: 'Anita', amount: 30000, probability: 10, stage: 'lost', expectedClose: null },
];

function mockApi({ deals = DEALS, stages = STAGES, pipelines = [] } = {}) {
  fetchApi.mockImplementation((url, options) => {
    if (options?.method === 'DELETE') return Promise.resolve({ ok: true });
    if (options?.method === 'PUT') return Promise.resolve({ ok: true });
    if (url.startsWith('/api/ai_scoring/score/')) return Promise.resolve({ probability: 73 });
    if (url.startsWith('/api/deals/')) return Promise.resolve(deals.find((deal) => String(deal.id) === url.split('/').pop()) || deals[0]);
    if (url.startsWith('/api/deals')) return Promise.resolve(deals);
    if (url.startsWith('/api/pipeline_stages')) return Promise.resolve(stages);
    if (url.startsWith('/api/pipelines')) return Promise.resolve(pipelines);
    return Promise.resolve([]);
  });
}

function renderPipeline() {
  return render(
    <AuthContext.Provider value={{ user: { tenant: { vertical: 'generic' } } }}>
      <MemoryRouter><Pipeline /></MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  notifyObj.confirm.mockResolvedValue(true);
  mockApi();
});

describe('Deals and Pipelines page', () => {
  it('renders the current page heading and primary actions', async () => {
    renderPipeline();
    expect(await screen.findByRole('heading', { name: 'Deals and Pipelines' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /add deal/i }).length).toBeGreaterThan(0);
  });

  it('shows the loading state while the API requests are pending', () => {
    fetchApi.mockImplementation(() => new Promise(() => {}));
    renderPipeline();
    expect(screen.getByText(/loading deals/i)).toBeInTheDocument();
  });

  it('renders deals in their pipeline stages', async () => {
    renderPipeline();
    expect(await screen.findByText('Acme Corp Renewal')).toBeInTheDocument();
    expect(screen.getByText('Globex Expansion')).toBeInTheDocument();
    expect(screen.getByText('Initech Deal')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getAllByText('Anita').length).toBeGreaterThan(0);
  });

  it('switches to List view and renders the list columns', async () => {
    renderPipeline();
    await screen.findByText('Acme Corp Renewal');
    fireEvent.click(screen.getByRole('button', { name: /list/i }));
    expect(screen.getByText('Deal')).toBeInTheDocument();
    expect(screen.getByText('Contact')).toBeInTheDocument();
    expect(screen.getByText('Stage')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Probability')).toBeInTheDocument();
  });

  it('filters deals by title and company search', async () => {
    renderPipeline();
    await screen.findByText('Acme Corp Renewal');
    const search = screen.getByRole('textbox', { name: /search deals/i });
    fireEvent.change(search, { target: { value: 'globex' } });
    expect(screen.getByText('Globex Expansion')).toBeInTheDocument();
    expect(screen.queryByText('Acme Corp Renewal')).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'initech' } });
    expect(screen.getByText('Initech Deal')).toBeInTheDocument();
    expect(screen.queryByText('Globex Expansion')).not.toBeInTheDocument();
  });

  it('filters deals by stage and owner', async () => {
    renderPipeline();
    await screen.findByText('Acme Corp Renewal');
    fireEvent.click(screen.getByRole('button', { name: /more filters/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /stage/i }), { target: { value: 'won' } });
    expect(screen.getByText('Globex Expansion')).toBeInTheDocument();
    expect(screen.queryByText('Acme Corp Renewal')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: /owner/i }), { target: { value: 'Vikram' } });
    expect(screen.getByText('Globex Expansion')).toBeInTheDocument();
  });

  it('deletes a deal only after CRM confirmation', async () => {
    renderPipeline();
    await screen.findByText('Acme Corp Renewal');
    fireEvent.click(screen.getByRole('button', { name: /delete deal Acme Corp Renewal/i }));
    await waitFor(() => expect(notifyObj.confirm).toHaveBeenCalled());
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/deals/1', expect.objectContaining({ method: 'DELETE' })));
    expect(notifyObj.success).toHaveBeenCalledWith('Deal deleted');
  });

  it('updates the displayed probability when a deal score is generated', async () => {
    renderPipeline();
    await screen.findByText('Acme Corp Renewal');
    fireEvent.click(screen.getByRole('button', { name: /generate deal score for Acme Corp Renewal/i }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/ai_scoring/score/1'));
    expect(notifyObj.success).toHaveBeenCalledWith('Deal score updated');
  });

  it('opens and closes the Add Deal dialog', async () => {
    renderPipeline();
    await screen.findByText('Acme Corp Renewal');
    fireEvent.click(screen.getAllByRole('button', { name: /add deal/i })[0]);
    expect(screen.getByRole('dialog', { name: /add deal dialog/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog', { name: /add deal dialog/i })).not.toBeInTheDocument();
  });

  it('exports the stage-name utility and virtualization threshold', () => {
    expect(slugifyStageName('New Lead')).toBe('new-lead');
    expect(slugifyStageName('WON')).toBe('won');
    expect(slugifyStageName(null)).toBe('');
    expect(VIRTUALIZATION_THRESHOLD).toBe(100);
  });
});
