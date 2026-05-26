/**
 * Omnibar component contract pin (vitest + RTL).
 *
 * SUT: frontend/src/components/Omnibar.jsx — the Cmd/Ctrl+K global
 * search overlay that hits GET /api/search?q=<term> after a 300ms debounce
 * (SEARCH_DEBOUNCE_MS from utils/timing) and renders three sections:
 * Address Book (contacts), Pipeline Extracted (deals), Financial Ledgers
 * (invoices). Hidden until opened; opens on Ctrl/Cmd+K OR a custom
 * `omnibar:open` window event (added per issue #851 so the header's
 * Search button can trigger it without lifting state into a context).
 *
 * Contract pinned here:
 *   - Hidden by default (returns null until isOpen).
 *   - Ctrl+K and Cmd+K both toggle open/closed.
 *   - Escape closes (but does NOT toggle re-open).
 *   - `omnibar:open` custom event opens (one-way; no toggle).
 *   - query.length < 2 ⇒ NO fetch is fired (debounce guard).
 *   - query.length ≥ 2 + 300ms quiet ⇒ fetchApi('/api/search?q=...').
 *   - URL is encoded via encodeURIComponent.
 *   - Empty results (all three arrays empty) ⇒ shows
 *     "No algorithmic matches located for ..." with the query echoed.
 *   - Populated results render section headings + row content
 *     (name + email for contacts, title + stage for deals, invoiceNum
 *     + status for invoices).
 *   - Clicking a result row closes the omnibar (sets isOpen=false).
 *
 * Bug-class this protects against:
 *   - Removing the toggle behaviour on Ctrl+K (regressing to open-only).
 *   - Forgetting to encodeURIComponent (would 500 on '#' / '&' queries).
 *   - Dropping the <2 char guard (would spam the search endpoint per
 *     keystroke + tie up the backend search index).
 *   - Removing the `omnibar:open` custom event listener (#851 — Layout
 *     header's Search button would silently stop working).
 *
 * Note on timers: we deliberately use REAL timers and rely on RTL's
 * `waitFor` / `findBy*` queries (which poll up to a default 1000ms) to
 * observe the 300ms debounce. Fake timers conflict with `findBy*`'s
 * internal polling and time out spuriously.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import Omnibar from '../components/Omnibar';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const real = await vi.importActual('react-router-dom');
  return { ...real, useNavigate: () => navigateMock };
});

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(() => Promise.resolve({ contacts: [], deals: [], invoices: [] })),
}));

import { fetchApi } from '../utils/api';

function openOmnibar({ meta = false } = {}) {
  // Ctrl+K (or Cmd+K when meta=true) fires on the global window listener.
  fireEvent.keyDown(window, { key: 'k', ctrlKey: !meta, metaKey: meta });
}

const PLACEHOLDER = /Omnisearch Contacts, Pipelines, or Invoices/i;

describe('Omnibar', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    fetchApi.mockClear();
    fetchApi.mockResolvedValue({ contacts: [], deals: [], invoices: [] });
  });

  it('is hidden by default (renders nothing until opened)', () => {
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();
  });

  it('opens on Ctrl+K and shows the search input', async () => {
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    openOmnibar();
    expect(await screen.findByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });

  it('opens on Cmd+K (metaKey) — Mac shortcut', async () => {
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    openOmnibar({ meta: true });
    expect(await screen.findByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });

  it('Ctrl+K toggles closed when already open', async () => {
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    openOmnibar();
    await screen.findByPlaceholderText(PLACEHOLDER);
    openOmnibar(); // toggle off
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument()
    );
  });

  it('Escape closes the omnibar', async () => {
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    openOmnibar();
    await screen.findByPlaceholderText(PLACEHOLDER);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument()
    );
  });

  it('opens via `omnibar:open` custom window event (#851 Layout header button)', async () => {
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    act(() => {
      window.dispatchEvent(new Event('omnibar:open'));
    });
    expect(await screen.findByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });

  it('does NOT fetch when query is shorter than 2 characters (debounce guard)', async () => {
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    openOmnibar();
    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'a' } });
    // Wait past the 300ms debounce window and confirm no fetch fired.
    await new Promise((r) => setTimeout(r, 450));
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('fetches /api/search?q=... after the 300ms debounce when query length >= 2', async () => {
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    openOmnibar();
    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'acme' } });
    await waitFor(
      () => expect(fetchApi).toHaveBeenCalledWith('/api/search?q=acme'),
      { timeout: 2000 }
    );
  });

  it('URL-encodes the query string (special chars like # / & / spaces)', async () => {
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    openOmnibar();
    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'a&b #c' } });
    await waitFor(
      () => expect(fetchApi).toHaveBeenCalledWith('/api/search?q=a%26b%20%23c'),
      { timeout: 2000 }
    );
  });

  it('shows the empty-state message when all three result arrays are empty', async () => {
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    openOmnibar();
    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'zzqqqxx' } });
    expect(
      await screen.findByText(/No algorithmic matches located for/i, {}, { timeout: 2000 })
    ).toBeInTheDocument();
    // The query is echoed inside the empty-state message.
    expect(screen.getByText('zzqqqxx')).toBeInTheDocument();
  });

  it('renders contact + deal + invoice result rows under their section headers', async () => {
    fetchApi.mockResolvedValueOnce({
      contacts: [
        { id: 1, name: 'Alice Chen', company: 'Acme Corp', email: 'alice@acme.test' },
      ],
      deals: [
        { id: 11, title: 'Acme renewal', stage: 'proposal', amount: 10000, currency: 'USD' },
      ],
      invoices: [
        {
          id: 101,
          invoiceNum: 'INV-2026-001',
          status: 'PAID',
          amount: 5000,
          contact: { name: 'Alice Chen' },
        },
      ],
    });
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    openOmnibar();
    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'acme' } });
    // Section headers
    expect(
      await screen.findByText(/Address Book/i, {}, { timeout: 2000 })
    ).toBeInTheDocument();
    expect(screen.getByText(/Pipeline Extracted/i)).toBeInTheDocument();
    expect(screen.getByText(/Financial Ledgers/i)).toBeInTheDocument();
    // Row contents — "Alice Chen" appears twice (contacts row + invoice's
    // `contact.name`), so use getAllByText with length >= 2.
    expect(screen.getAllByText(/Alice Chen/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('alice@acme.test')).toBeInTheDocument();
    expect(screen.getByText('Acme renewal')).toBeInTheDocument();
    expect(screen.getByText(/INV-2026-001/)).toBeInTheDocument();
    expect(screen.getByText('PAID')).toBeInTheDocument();
  });

  it('clicking a contact result row closes the omnibar', async () => {
    fetchApi.mockResolvedValueOnce({
      contacts: [
        { id: 1, name: 'Alice Chen', company: 'Acme Corp', email: 'alice@acme.test' },
      ],
      deals: [],
      invoices: [],
    });
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    openOmnibar();
    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'alice' } });
    const row = await screen.findByText(/Alice Chen/, {}, { timeout: 2000 });
    fireEvent.click(row);
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument()
    );
  });

  it('clears results to the empty-shape when the query drops below 2 characters', async () => {
    fetchApi.mockResolvedValueOnce({
      contacts: [
        { id: 1, name: 'Alice Chen', company: 'Acme Corp', email: 'alice@acme.test' },
      ],
      deals: [],
      invoices: [],
    });
    render(<MemoryRouter><Omnibar /></MemoryRouter>);
    openOmnibar();
    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'alice' } });
    expect(
      await screen.findByText(/Alice Chen/, {}, { timeout: 2000 })
    ).toBeInTheDocument();
    // Drop below 2 chars — should reset to empty result-shape, no further fetch.
    fetchApi.mockClear();
    fireEvent.change(input, { target: { value: 'a' } });
    await waitFor(() => expect(screen.queryByText(/Alice Chen/)).not.toBeInTheDocument());
    // And wait past the debounce window to confirm no fetch fired.
    await new Promise((r) => setTimeout(r, 450));
    expect(fetchApi).not.toHaveBeenCalled();
  });
});
