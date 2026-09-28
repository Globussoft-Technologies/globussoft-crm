import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByText('Contacted')).toBeInTheDocument();
    expect(screen.getByText('Proposal')).toBeInTheDocument();
    expect(screen.getByText('Won')).toBeInTheDocument();
    expect(screen.getByText('Lost')).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith('/api/pipeline_stages?pipelineId=7', { silent: true });
    expect(screen.getByText('Proposal')).toHaveClass('current');
    expect(screen.getByText('Lead')).not.toHaveClass('current');
  });

  it('keeps the Add tag button available when a tag already exists', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/deals/42') return Promise.resolve({ ...deal, contact: { ...deal.contact, tags: ['Existing tag'] } });
      if (url === '/api/pipeline_stages') return Promise.resolve([{ id: 1, name: 'Lead' }]);
      if (url.startsWith('/api/pipelines')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderPage();

    expect((await screen.findAllByText('Existing tag')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    expect(await screen.findByRole('textbox', { name: 'Add tag' })).toBeInTheDocument();
  });

  it('supports the details tab search and show-empty-fields control', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Acme Expansion' });
    fireEvent.click(screen.getByRole('button', { name: 'Deal details' }));
    expect(screen.getByRole('heading', { name: 'Deal details' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search fields' }), { target: { value: 'Currency' } });
    expect(screen.getByText('Currency')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search fields' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /show empty fields/i }));
    expect(screen.getAllByText('Territory').length).toBeGreaterThan(0);
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

  it('opens Activities only from View all notes', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Acme Expansion' });
    fireEvent.click(screen.getByRole('button', { name: 'View all notes' }));
    expect(screen.getByRole('heading', { name: 'Activities' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Add note' })).not.toBeInTheDocument();
  });

  it('searches related contacts through the backend instead of truncating to an initial list', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/deals/42') return Promise.resolve(deal);
      if (url === '/api/pipeline_stages') return Promise.resolve([{ id: 1, name: 'Lead' }]);
      if (url.startsWith('/api/pipelines')) return Promise.resolve([]);
      if (url.includes('/api/contacts?') && url.includes('q=Beyond')) {
        return Promise.resolve({ data: [{ id: 999, name: 'Beyond First Page' }] });
      }
      if (url.startsWith('/api/contacts?')) return Promise.resolve({ data: [] });
      return Promise.resolve([]);
    });

    renderPage();
    await screen.findByRole('heading', { name: 'Acme Expansion' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit Related contact' })[0]);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search contacts' }), { target: { value: 'Beyond' } });

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/contacts?fields=summary&limit=50&q=Beyond',
      { silent: true },
    ));
    expect(await screen.findByRole('option', { name: 'Beyond First Page' })).toBeInTheDocument();
  });
});
