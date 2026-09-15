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
vi.mock('../utils/money', () => ({ formatMoney: (value) => `$${Number(value || 0).toLocaleString('en-US')}` }));
vi.mock('../components/DealModal', () => ({ default: () => null }));
vi.mock('../components/contact/ActionModals', () => ({ DealModal: () => null }));

import { fetchApi } from '../utils/api';
import Pipeline from '../pages/Pipeline';

const STAGES = [
  { id: 1, name: 'New Lead', color: '#3b82f6', position: 0 },
  { id: 2, name: 'Won', color: '#10b981', position: 1 },
  { id: 3, name: 'Lost', color: '#ef4444', position: 2 },
];

const DEALS = [
  { id: 101, title: 'Acme Corp Renewal', contactName: 'Alice Lead', ownerName: 'Anita', amount: 50000, probability: 25, stage: 'new-lead' },
];

function mockApi({ putError = false } = {}) {
  fetchApi.mockImplementation((url, options) => {
    if (options?.method === 'PUT') {
      return putError
        ? Promise.reject({ body: { error: 'Unable to move deal' } })
        : Promise.resolve({ ok: true });
    }
    if (url.startsWith('/api/deals')) return Promise.resolve(DEALS);
    if (url.startsWith('/api/pipeline_stages')) return Promise.resolve(STAGES);
    if (url.startsWith('/api/pipelines')) return Promise.resolve([]);
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

function stageSection(name) {
  return screen.getByRole('heading', { name }).closest('section');
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockApi();
});

describe('Deals and Pipelines kanban stage movement', () => {
  it('moves a deal by dragging its card to another stage and persists the stage', async () => {
    renderPipeline();
    const card = (await screen.findByText('Acme Corp Renewal')).closest('article');
    const won = stageSection('Won');
    fireEvent.dragStart(card, { dataTransfer: { effectAllowed: '' } });
    fireEvent.drop(won);

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/deals/101',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ stage: 'won' }) }),
    ));
    expect(notifyObj.success).toHaveBeenCalledWith('Deal stage updated');
    expect(await withinSection(won).findByText('Acme Corp Renewal')).toBeInTheDocument();
  });

  it('updates the probability to 100% when a deal is moved to Won', async () => {
    renderPipeline();
    const card = (await screen.findByText('Acme Corp Renewal')).closest('article');
    fireEvent.dragStart(card, { dataTransfer: { effectAllowed: '' } });
    fireEvent.drop(stageSection('Won'));
    await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument());
  });

  it('reverts the optimistic move and reports an error when the stage update fails', async () => {
    mockApi({ putError: true });
    renderPipeline();
    const card = (await screen.findByText('Acme Corp Renewal')).closest('article');
    fireEvent.dragStart(card, { dataTransfer: { effectAllowed: '' } });
    fireEvent.drop(stageSection('Won'));
    await waitFor(() => expect(notifyObj.error).toHaveBeenCalledWith('Unable to move deal'));
    expect(withinSection(stageSection('New Lead')).getByText('Acme Corp Renewal')).toBeInTheDocument();
  });
});

function withinSection(section) {
  return {
    findByText: async (text) => {
      await waitFor(() => expect(section.textContent).toContain(text));
      return section.querySelector('h3');
    },
    getByText: (text) => {
      const elements = [...section.querySelectorAll('*')].filter((element) => element.textContent === text);
      if (!elements.length) throw new Error(`Unable to find ${text} in stage section`);
      return elements[0];
    },
  };
}
