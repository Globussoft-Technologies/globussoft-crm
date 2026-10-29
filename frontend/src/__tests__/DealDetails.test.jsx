import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));

import DealDetails from '../pages/DealDetails';

const deal = {
  id: 42,
  title: 'Acme Expansion',
  amount: 5600,
  currency: 'USD',
  probability: 40,
  stage: 'proposal',
  expectedClose: '2026-11-15T00:00:00.000Z',
  createdAt: '2026-08-15T00:00:00.000Z',
  contact: { id: 7, name: 'Alice Example', company: 'Acme Corp', source: 'Web Form' },
  owner: { name: 'Ravi Owner' },
  activities: [{ id: 1, type: 'Note', description: 'Follow up after the proposal.', createdAt: '2026-09-01T00:00:00.000Z' }],
  quotes: [],
};

const manyNotes = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
  type: 'Note',
  description: `Note ${index + 1}`,
  createdAt: '2026-09-01T00:00:00.000Z',
}));

function renderPage(path = '/deals/42') {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/deals/:dealId" element={<DealDetails />} /></Routes></MemoryRouter>);
}

describe('<DealDetails />', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/deals/42') return Promise.resolve(deal);
      if (url === '/api/pipeline_stages') return Promise.resolve([{ id: 1, name: 'Lead' }, { id: 2, name: 'Proposal' }, { id: 3, name: 'Won' }]);
      if (url.startsWith('/api/pipelines')) return Promise.resolve([{ id: 7, name: 'Enterprise', isDefault: true }]);
      return Promise.resolve([]);
    });
  });

  it('loads the selected deal and renders dynamic summary data', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Acme Expansion' })).toBeInTheDocument();
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ravi Owner').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Follow up after the proposal.').length).toBeGreaterThan(0);
    expect(fetchApiMock).toHaveBeenCalledWith('/api/deals/42');
  });

  it.each(['missing', 'failed', 'invalid', 'pending'])('does not save a currency change with %s rates', async (scenario) => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/deals/42') return Promise.resolve({ ...deal, amount: 8300, currency: 'INR' });
      if (url === '/api/currencies') {
        if (scenario === 'failed') return Promise.reject(new Error('Currency request failed'));
        if (scenario === 'pending') return new Promise(() => {});
        return Promise.resolve(scenario === 'invalid' ? [{ code: 'INR', exchangeRate: 0 }, { code: 'USD', exchangeRate: 1 }] : []);
      }
      return Promise.resolve([]);
    });
    renderPage();
    const control = await screen.findByRole('combobox', { name: 'Deal currency' });
    fireEvent.change(control, { target: { value: 'USD' } });
    await waitFor(() => expect(control).not.toBeDisabled());
    expect(control).toHaveValue('INR');
    expect(fetchApiMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  });

  it('saves a correctly converted deal currency when rates are available', async () => {
    const rates = [{ code: 'INR', exchangeRate: 83 }, { code: 'USD', exchangeRate: 1 }];
    fetchApiMock.mockImplementation((url, options) => {
      if (url === '/api/deals/42') return Promise.resolve({ ...deal, amount: 8300, currency: 'INR', ...(options?.method === 'PUT' ? JSON.parse(options.body) : {}) });
      if (url === '/api/currencies') return Promise.resolve(rates);
      return Promise.resolve([]);
    });
    renderPage();
    const control = await screen.findByRole('combobox', { name: 'Deal currency' });
    await act(async () => {});
    fireEvent.change(control, { target: { value: 'USD' } });
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/deals/42', {
      method: 'PUT', body: JSON.stringify({ amount: 100, currency: 'USD' }),
    }));
  });

  it.each(['amount', 'currency'])('blocks the inline %s editor from saving without exchange rates', async (field) => {
    fetchApiMock.mockImplementation((url) => url === '/api/deals/42'
      ? Promise.resolve({ ...deal, amount: 8300, currency: 'INR' }) : Promise.resolve([]));
    renderPage();
    await screen.findByRole('heading', { name: deal.title });
    act(() => window.dispatchEvent(new CustomEvent('deal-details-edit', { detail: { field, anchor: { bottom: 100, left: 10 } } })));
    const dialog = screen.getByRole('dialog', { name: field === 'amount' ? 'Edit Amount' : 'Edit Currency' });
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'USD' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Exchange rates unavailable/);
    expect(fetchApiMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  });

  it('loads every stage from the selected Generic CRM pipeline and highlights only the deal stage', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/deals/42') return Promise.resolve({ ...deal, pipelineId: 7 });
      if (url === '/api/pipeline_stages?pipelineId=7') {
        return Promise.resolve([
          { id: 1, name: 'Lead' },
          { id: 2, name: 'Contacted' },
          { id: 3, name: 'Proposal' },
          { id: 4, name: 'Won' },
          { id: 5, name: 'Lost' },
        ]);
      }
      if (url.startsWith('/api/pipelines')) return Promise.resolve([{ id: 7, name: 'Enterprise', isDefault: true }]);
      return Promise.resolve([]);
    });

    renderPage();

    expect(await screen.findByText('Lead')).toBeInTheDocument();
    const tracker = within(document.querySelector('.deal-reference-tracker'));
    expect(tracker.getByText('Contacted')).toBeInTheDocument();
    expect(tracker.getByText('Proposal')).toBeInTheDocument();
    expect(tracker.getByText('Won')).toBeInTheDocument();
    expect(tracker.getByText('Lost')).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith('/api/pipeline_stages?pipelineId=7', { silent: true });
    expect(tracker.getByText('Proposal')).toHaveClass('current');
    expect(tracker.getByText('Lead')).not.toHaveClass('current');
  });

  it('does not render the removed Overview / Deal details workspace', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Acme Expansion' });
    expect(document.querySelector('.deal-reference-workspace')).not.toBeInTheDocument();
    expect(screen.queryByText('Click to add tags')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add tag' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Search fields' })).not.toBeInTheDocument();
    expect(screen.queryByText('Overview')).not.toBeInTheDocument();
  });

  it('opens Add note only from the note entry area', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Acme Expansion' });
    fireEvent.focus(screen.getByPlaceholderText('Type your note here...'));
    expect(screen.getByRole('dialog', { name: 'Add note' })).toBeInTheDocument();
  });

  it('keeps many notes in an independently scrollable list', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/deals/42') return Promise.resolve({ ...deal, activities: manyNotes });
      if (url === '/api/pipeline_stages') return Promise.resolve([{ id: 1, name: 'Lead' }]);
      if (url.startsWith('/api/pipelines')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderPage();
    await screen.findByText('Note 12');

    const notesCard = document.querySelector('.deal-reference-notes');
    const notesList = notesCard?.querySelector('.deal-notes-list');
    expect(notesCard).toHaveStyle({ overflow: 'hidden' });
    expect(notesList).toHaveStyle({ overflowY: 'auto', minHeight: '0px' });
    expect(notesList?.children).toHaveLength(12);
  });

  it('keeps the Generic CRM page vertically scrollable for content below the viewport', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Acme Expansion' });

    const pageScrollStyle = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent)
      .find((css) => css.includes('.generic-deal-details-page') && css.includes('overflow-y:auto !important'));
    expect(pageScrollStyle).toContain('overflow-y:auto !important');
  });

  it('uses theme-aware Generic deal page backgrounds in light and dark mode', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Acme Expansion' });
    const pageStyle = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent)
      .find((css) => css.includes('.generic-deal-details-page{background:var(--surface-color) !important;padding:18px'));
    expect(pageStyle).toContain('background:var(--surface-color) !important;padding:clamp');
    expect(pageStyle).not.toContain('#f1f3f6');
  });

  it('opens Activities only from View all notes', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Acme Expansion' });
    fireEvent.click(screen.getByRole('button', { name: 'View all notes' }));
    expect(screen.getByRole('heading', { name: 'Activities' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Add note' })).not.toBeInTheDocument();
  });

});
