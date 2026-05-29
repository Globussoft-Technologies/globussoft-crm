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

  // ─── Extended cases (test-cron) ─────────────────────────────────────────────
  // SUT surface still uncovered after the initial 8: Cmd+K (metaKey) accelerator,
  // contact filtering, deal-by-company filtering, case-insensitive matching,
  // clicking deal/contact results to navigate, overlay-backdrop-closes,
  // inner-card-stopPropagation, query-clear-on-close, footer hints render,
  // deal-card stage badge + formatted money, ESC pseudo-button visible.

  it('opens on Cmd+K (metaKey) just like Ctrl+K', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByPlaceholderText(/Search deals, contacts/i)).toBeInTheDocument();
  });

  it('typing filters fetched contacts by name', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    const input = await screen.findByPlaceholderText(/Search deals, contacts/i);
    fireEvent.change(input, { target: { value: 'Alice' } });
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('typing filters fetched contacts by email substring', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    const input = await screen.findByPlaceholderText(/Search deals, contacts/i);
    fireEvent.change(input, { target: { value: 'globus.test' } });
    // Bob's email matches, Alice's does not — and Globus deal title also matches
    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('typing filters fetched deals by company name', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    const input = await screen.findByPlaceholderText(/Search deals, contacts/i);
    // 'Acme' matches both deal.title ("Acme renewal") AND deal.company ("Acme")
    // 'globus' (lowercase) tests case-insensitive company match exclusively
    fireEvent.change(input, { target: { value: 'globus' } });
    expect(await screen.findByText(/Globus pilot/)).toBeInTheDocument();
    expect(screen.queryByText(/Acme renewal/)).not.toBeInTheDocument();
  });

  it('filtering is case-insensitive on both fields', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    const input = await screen.findByPlaceholderText(/Search deals, contacts/i);
    fireEvent.change(input, { target: { value: 'ACME' } });
    expect(await screen.findByText(/Acme renewal/)).toBeInTheDocument();
  });

  it('clicking a filtered deal result navigates to /pipeline and closes', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    const input = await screen.findByPlaceholderText(/Search deals, contacts/i);
    fireEvent.change(input, { target: { value: 'Acme' } });
    const dealRow = await screen.findByText(/Acme renewal/);
    fireEvent.click(dealRow);
    expect(navigateMock).toHaveBeenCalledWith('/pipeline');
    await waitFor(() => expect(screen.queryByPlaceholderText(/Search deals, contacts/i)).not.toBeInTheDocument());
  });

  it('clicking a filtered contact result navigates to /contacts', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    const input = await screen.findByPlaceholderText(/Search deals, contacts/i);
    fireEvent.change(input, { target: { value: 'Alice' } });
    const contactRow = await screen.findByText('Alice');
    fireEvent.click(contactRow);
    expect(navigateMock).toHaveBeenCalledWith('/contacts');
  });

  it('clicking the overlay backdrop closes the palette', async () => {
    const { container } = render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    await screen.findByPlaceholderText(/Search deals, contacts/i);
    // Outermost div in palette overlay has the onClick={() => setIsOpen(false)} handler
    const overlay = container.querySelector('div[style*="position: fixed"]');
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay);
    await waitFor(() => expect(screen.queryByPlaceholderText(/Search deals, contacts/i)).not.toBeInTheDocument());
  });

  it('clicking the inner card does NOT close (stopPropagation)', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    const input = await screen.findByPlaceholderText(/Search deals, contacts/i);
    // Click the input itself — it's inside the card whose onClick calls stopPropagation
    fireEvent.click(input);
    // Palette must still be visible (input still in document)
    expect(screen.getByPlaceholderText(/Search deals, contacts/i)).toBeInTheDocument();
  });

  it('query clears when the palette is closed and reopened', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    let input = await screen.findByPlaceholderText(/Search deals, contacts/i);
    fireEvent.change(input, { target: { value: 'Acme' } });
    expect(input.value).toBe('Acme');
    // Close via Escape
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByPlaceholderText(/Search deals, contacts/i)).not.toBeInTheDocument());
    // Reopen — query should be cleared by the effect (setQuery(''))
    openPalette();
    input = await screen.findByPlaceholderText(/Search deals, contacts/i);
    expect(input.value).toBe('');
  });

  it('renders the footer hints (navigation + selection)', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    await screen.findByPlaceholderText(/Search deals, contacts/i);
    expect(screen.getByText(/to navigate/i)).toBeInTheDocument();
    expect(screen.getByText(/to select/i)).toBeInTheDocument();
    // ESC button in the search bar
    expect(screen.getByText('ESC')).toBeInTheDocument();
  });

  it('renders the deal stage badge alongside title', async () => {
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    openPalette();
    const input = await screen.findByPlaceholderText(/Search deals, contacts/i);
    fireEvent.change(input, { target: { value: 'Acme' } });
    expect(await screen.findByText(/Acme renewal/)).toBeInTheDocument();
    // Stage rendered as visible badge text
    expect(screen.getByText('proposal')).toBeInTheDocument();
  });
});
