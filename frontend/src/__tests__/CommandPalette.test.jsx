import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import CommandPalette from '../components/CommandPalette';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const real = await vi.importActual('react-router-dom');
  return { ...real, useNavigate: () => navigateMock };
});

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn((url) => {
    if (url === '/api/deals') {
      return Promise.resolve([
        { id: 1, title: 'Acme renewal', company: 'Acme', amount: 10000, stage: 'proposal' },
        { id: 2, title: 'Globus pilot', company: 'Globus', amount: 5000, stage: 'discovery' },
      ]);
    }
    if (url === '/api/contacts') {
      return Promise.resolve([
        { id: 1, name: 'Alice', email: 'alice@acme.test', role: 'CEO' },
        { id: 2, name: 'Bob', email: 'bob@globus.test', role: 'CTO' },
      ]);
    }
    return Promise.resolve([]);
  }),
}));

function openPalette() {
  // Cmd+K or Ctrl+K
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
}

describe('CommandPalette', () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  it('is hidden by default (renders nothing until opened)', () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    expect(screen.queryByPlaceholderText(/Search deals, contacts/i)).not.toBeInTheDocument();
  });

  it('opens on Ctrl+K and shows the search input', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    expect(await screen.findByPlaceholderText(/Search deals, contacts/i)).toBeInTheDocument();
  });

  it('shows Quick Links (Pipeline, Contacts) when query is empty', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    await screen.findByPlaceholderText(/Search deals, contacts/i);
    expect(screen.getByText(/Sales Pipeline/)).toBeInTheDocument();
    expect(screen.getByText(/Contact Directory/)).toBeInTheDocument();
  });

  it('typing filters fetched deals by title', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    const input = await screen.findByPlaceholderText(/Search deals, contacts/i);
    // Wait for deals + contacts fetched
    await waitFor(() => expect(screen.queryByText(/Acme renewal/)).toBeNull());
    fireEvent.change(input, { target: { value: 'Acme' } });
    expect(await screen.findByText(/Acme renewal/)).toBeInTheDocument();
    expect(screen.queryByText(/Globus pilot/)).not.toBeInTheDocument();
  });

  it('typing a non-matching query shows empty-state message', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    const input = await screen.findByPlaceholderText(/Search deals, contacts/i);
    await waitFor(() => {});
    fireEvent.change(input, { target: { value: 'zzqqqxx' } });
    expect(await screen.findByText(/No results found/i)).toBeInTheDocument();
  });

  it('clicking a quick link navigates', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    await screen.findByPlaceholderText(/Search deals, contacts/i);
    fireEvent.click(screen.getByText(/Sales Pipeline/));
    expect(navigateMock).toHaveBeenCalledWith('/pipeline');
  });

  it('Escape closes the palette', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    await screen.findByPlaceholderText(/Search deals, contacts/i);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByPlaceholderText(/Search deals, contacts/i)).not.toBeInTheDocument());
  });

  it('Ctrl+K toggles off when already open', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    await screen.findByPlaceholderText(/Search deals, contacts/i);
    openPalette(); // toggle
    await waitFor(() => expect(screen.queryByPlaceholderText(/Search deals, contacts/i)).not.toBeInTheDocument());
  });
});
