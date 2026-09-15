import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../App';

const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(),
};

vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));
vi.mock('../utils/api', () => ({ fetchApi: vi.fn(), getAuthToken: () => 'test-token' }));
vi.mock('socket.io-client', () => ({
  io: () => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() }),
}));
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
import Pipeline, { KANBAN_COLUMN_MIN_WIDTH, normalizePipelineStages, slugifyStageName, VIRTUALIZATION_THRESHOLD } from '../pages/Pipeline';

const STAGES = [
  { id: 1, name: 'New Lead', color: '#3b82f6', position: 0 },
  { id: 2, name: 'Won', color: '#10b981', position: 1 },
  { id: 3, name: 'Lost', color: '#ef4444', position: 2 },
];

const DEALS = [
  { id: 1, title: 'Acme Corp Renewal', company: 'Acme', contactName: 'Alice', ownerId: 11, ownerName: 'Anita', amount: 50000, probability: 25, stage: 'new-lead', expectedClose: '2026-09-01T00:00:00.000Z' },
  { id: 2, title: 'Globex Expansion', company: 'Globex', contactName: 'Bob', ownerId: 12, ownerName: 'Vikram', amount: 90000, probability: 100, stage: 'won', expectedClose: null },
  { id: 3, title: 'Initech Deal', company: 'Initech', contactName: 'Carol', ownerId: 11, ownerName: 'Anita', amount: 30000, probability: 10, stage: 'lost', expectedClose: null },
];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function mockApi({ deals = DEALS, stages = STAGES, pipelines = [] } = {}) {
  fetchApi.mockImplementation((url, options) => {
    if (options?.method === 'DELETE') return Promise.resolve({ ok: true });
    if (options?.method === 'PUT') return Promise.resolve({ ok: true });
    if (url.startsWith('/api/ai_scoring/score/')) return Promise.resolve({ probability: 73 });
    if (url.startsWith('/api/deals/stats')) return Promise.resolve({ totalDeals: deals.length, byStage: [] });
    if (url.startsWith('/api/deals?')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const query = String(params.get('search') || '').toLowerCase();
      const filtered = deals.filter((deal) =>
        (!query || [deal.title, deal.company, deal.contactName, deal.ownerName].some((value) => String(value || '').toLowerCase().includes(query)))
        && (!params.get('stage') || deal.stage === params.get('stage'))
        && (!params.get('ownerId') || String(deal.ownerId) === params.get('ownerId')),
      );
      return Promise.resolve({ data: filtered, total: filtered.length, page: 1, limit: 50, totalPages: 1 });
    }
    if (url.startsWith('/api/deals/')) return Promise.resolve(deals.find((deal) => String(deal.id) === url.split('/').pop()) || deals[0]);
    if (url.startsWith('/api/pipeline_stages')) return Promise.resolve(stages);
    if (url.startsWith('/api/pipelines')) return Promise.resolve(pipelines);
    if (url.startsWith('/api/staff')) return Promise.resolve([{ id: 11, name: 'Anita' }, { id: 12, name: 'Vikram' }]);
    return Promise.resolve([]);
  });
}

function renderPipeline(initialEntry = '/pipeline') {
  return render(
    <AuthContext.Provider value={{ user: { tenant: { vertical: 'generic' } } }}>
      <MemoryRouter initialEntries={[initialEntry]}><Pipeline /></MemoryRouter>
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

  it('keeps a ten-stage board readable with horizontal scrolling and removes duplicate stage columns', async () => {
    const manyStages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      name: `Stage ${index + 1}`,
      color: '#3b82f6',
      position: index,
    }));
    manyStages.push({ id: 99, name: ' Stage 1 ', color: '#ef4444', position: 99 });
    mockApi({ stages: manyStages });

    renderPipeline();
    const board = await screen.findByLabelText('Deal pipeline board');

    expect(board).toHaveStyle({
      gridTemplateColumns: `repeat(10, minmax(${KANBAN_COLUMN_MIN_WIDTH}px, 1fr))`,
      overflowX: 'auto',
      overflowY: 'hidden',
    });
    expect(screen.getAllByRole('heading', { name: 'Stage 1' })).toHaveLength(1);
  });

  it('selects the default pipeline when the URL does not specify one', async () => {
    mockApi({ pipelines: [
      { id: 41, name: 'Default Sales', isDefault: true },
      { id: 42, name: 'Secondary', isDefault: false },
    ] });

    renderPipeline();

    await waitFor(() => expect(screen.getByRole('combobox', { name: /pipeline/i })).toHaveValue('41'));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/deals\?.*pipelineId=41/)));
  });

  it('preserves an explicitly selected pipeline from the URL', async () => {
    mockApi({ pipelines: [
      { id: 41, name: 'Default Sales', isDefault: true },
      { id: 42, name: 'Secondary', isDefault: false },
    ] });

    renderPipeline('/pipeline?pipelineId=42');

    await waitFor(() => expect(screen.getByRole('combobox', { name: /pipeline/i })).toHaveValue('42'));
    expect(fetchApi).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/deals\?.*pipelineId=42/));
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
    await waitFor(() => expect(screen.queryByText('Acme Corp Renewal')).not.toBeInTheDocument());
    expect(screen.getByText('Globex Expansion')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'initech' } });
    await waitFor(() => expect(screen.queryByText('Globex Expansion')).not.toBeInTheDocument());
    expect(screen.getByText('Initech Deal')).toBeInTheDocument();
  });

  it('filters deals by stage and owner', async () => {
    renderPipeline();
    await screen.findByText('Acme Corp Renewal');
    fireEvent.click(screen.getByRole('button', { name: /more filters/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /stage/i }), { target: { value: 'won' } });
    await waitFor(() => expect(screen.queryByText('Acme Corp Renewal')).not.toBeInTheDocument());
    expect(screen.getByText('Globex Expansion')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: /owner/i }), { target: { value: '12' } });
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

  it('pages through the complete server result instead of capping at 500 rows', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/deals/stats')) return Promise.resolve({ totalDeals: 75, byStage: [] });
      if (url.startsWith('/api/deals?')) {
        const page = new URL(url, 'http://localhost').searchParams.get('page');
        const data = page === '2' ? [{ ...DEALS[0], id: 75, title: 'Deal on page two' }] : DEALS;
        return Promise.resolve({ data, total: 75, page: Number(page), limit: 50, totalPages: 2 });
      }
      if (url.startsWith('/api/pipeline_stages')) return Promise.resolve(STAGES);
      if (url.startsWith('/api/pipelines')) return Promise.resolve([]);
      if (url.startsWith('/api/staff')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderPipeline();
    expect(await screen.findByText('Showing 1–50 of 75 deals')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Deal on page two')).toBeInTheDocument();
    expect(screen.getByText('Showing 51–75 of 75 deals')).toBeInTheDocument();
  });

  it('ignores an older pipeline response that arrives after the latest selection', async () => {
    const older = deferred();
    const newer = deferred();
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/deals/stats')) return Promise.resolve({ totalDeals: 1, byStage: [] });
      if (url.startsWith('/api/deals?')) {
        const selected = new URL(url, 'http://localhost').searchParams.get('pipelineId');
        if (selected === '1') return older.promise;
        if (selected === '2') return newer.promise;
        return Promise.resolve({ data: DEALS, total: 3, page: 1, limit: 50, totalPages: 1 });
      }
      if (url.startsWith('/api/pipeline_stages')) return Promise.resolve(STAGES);
      if (url.startsWith('/api/pipelines')) return Promise.resolve([{ id: 1, name: 'Older' }, { id: 2, name: 'Latest' }]);
      if (url.startsWith('/api/staff')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderPipeline();
    await screen.findByText('Acme Corp Renewal');
    const pipeline = screen.getByRole('combobox', { name: /pipeline/i });
    fireEvent.change(pipeline, { target: { value: '1' } });
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(expect.stringContaining('pipelineId=1')));
    fireEvent.change(pipeline, { target: { value: '2' } });
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(expect.stringContaining('pipelineId=2')));

    await act(async () => newer.resolve({ data: [{ ...DEALS[0], id: 202, title: 'Latest pipeline deal' }], total: 1, page: 1, limit: 50, totalPages: 1 }));
    expect(await screen.findByText('Latest pipeline deal')).toBeInTheDocument();
    await act(async () => older.resolve({ data: [{ ...DEALS[0], id: 101, title: 'Stale pipeline deal' }], total: 1, page: 1, limit: 50, totalPages: 1 }));
    expect(screen.queryByText('Stale pipeline deal')).not.toBeInTheDocument();
    expect(screen.getByText('Latest pipeline deal')).toBeInTheDocument();
  });

  it('exports the stage-name utility and virtualization threshold', () => {
    expect(slugifyStageName('New Lead')).toBe('new-lead');
    expect(slugifyStageName('WON')).toBe('won');
    expect(slugifyStageName(null)).toBe('');
    expect(normalizePipelineStages([{ id: 1, name: 'New Lead' }, { id: 2, name: ' new lead ' }])).toHaveLength(1);
    expect(VIRTUALIZATION_THRESHOLD).toBe(100);
  });
});
