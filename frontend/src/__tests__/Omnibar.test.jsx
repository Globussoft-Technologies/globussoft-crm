/**
 * Omnibar component contract pin (vitest + RTL).
 *
 * SUT: frontend/src/components/Omnibar.jsx — the always-visible inline
 * top-bar search field. Replaced the legacy Cmd/Ctrl+K modal overlay so
 * the search affordance is discoverable, and extended the result-set
 * from 3 entities to all 10 the backend returns + a client-side "Pages"
 * section sourced from /api/pages/me.
 *
 * Contract pinned here:
 *   - The input is ALWAYS in the DOM (no modal, no toggle-hidden state).
 *   - Ctrl+K and Cmd+K BOTH focus the input.
 *   - Escape clears the query + blurs the input.
 *   - `omnibar:open` custom event focuses the input (back-compat).
 *   - query.length < 2 ⇒ NO fetch is fired (debounce guard).
 *   - query.length ≥ 2 + 300ms quiet ⇒ fetchApi('/api/search?q=...').
 *   - URL is encoded via encodeURIComponent.
 *   - Empty results ⇒ shows "No algorithmic matches located for ..."
 *     with the query echoed.
 *   - Populated results render section headings + row content. Pages
 *     match comes from /api/pages/me + client-side substring filter
 *     across label / description / category / path.
 *   - Clicking a result row navigates via react-router AND clears the
 *     query (which collapses the dropdown).
 *
 * Bug-class this protects against:
 *   - Removing the Ctrl+K affordance (power users rely on it).
 *   - Forgetting to encodeURIComponent (would 500 on '#' / '&' queries).
 *   - Dropping the <2 char guard (would spam the search endpoint per
 *     keystroke + tie up the backend search index).
 *   - Regressing the Pages section back to "only contacts/deals/invoices"
 *     — the original UX shipped 3 of 10 backend result types.
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
  fetchApi: vi.fn((url) => {
    if (url === '/api/pages/me') {
      return Promise.resolve({
        pages: [
          { path: '/contacts', label: 'Contacts', description: 'Contact directory', category: 'Sales' },
          { path: '/settings', label: 'Settings', description: 'Tenant settings + integrations', category: 'Admin' },
          { path: '/wellness/patients', label: 'Patients', description: 'Patient directory + clinical records', category: 'Clinical' },
          { path: '/wellness/invoices', label: 'Invoices', description: 'Invoice ledger + payment links', category: 'Finance' },
        ],
      });
    }
    return Promise.resolve({ contacts: [], deals: [], invoices: [] });
  }),
}));

import { fetchApi } from '../utils/api';

const PLACEHOLDER = /Search pages, contacts/i;

function pressKey(key, { ctrl = false, meta = false } = {}) {
  fireEvent.keyDown(window, { key, ctrlKey: ctrl, metaKey: meta });
}

async function renderOmnibarAndWaitForPages() {
  const view = render(<MemoryRouter><Omnibar /></MemoryRouter>);
  // The pages fetch fires on mount; wait for it to settle so subsequent
  // `await screen.findByText` against page rows don't race the initial load.
  await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/pages/me', { silent: true }));
  return view;
}

describe('Omnibar (inline top-bar)', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    fetchApi.mockClear();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/pages/me') {
        return Promise.resolve({
        pages: [
          { path: '/contacts', label: 'Contacts', description: 'Contact directory', category: 'Sales' },
          { path: '/settings', label: 'Settings', description: 'Tenant settings + integrations', category: 'Admin' },
          { path: '/wellness/patients', label: 'Patients', description: 'Patient directory + clinical records', category: 'Clinical' },
          { path: '/wellness/invoices', label: 'Invoices', description: 'Invoice ledger + payment links', category: 'Finance' },
        ],
      });
      }
      return Promise.resolve({ contacts: [], deals: [], invoices: [] });
    });
  });

  it('renders the inline search input on mount (no modal — always visible)', async () => {
    await renderOmnibarAndWaitForPages();
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });

  it('Ctrl+K focuses the search input', async () => {
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    pressKey('k', { ctrl: true });
    expect(document.activeElement).toBe(input);
  });

  it('Cmd+K (metaKey) focuses the search input — Mac shortcut', async () => {
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    pressKey('k', { meta: true });
    expect(document.activeElement).toBe(input);
  });

  it('Escape clears the query', async () => {
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'something' } });
    expect(input.value).toBe('something');
    input.focus();
    pressKey('Escape');
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('focuses the input via the `omnibar:open` window event (#851 back-compat)', async () => {
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    act(() => {
      window.dispatchEvent(new Event('omnibar:open'));
    });
    expect(document.activeElement).toBe(input);
  });

  it('does NOT fetch /api/search when query is shorter than 2 characters', async () => {
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fetchApi.mockClear();
    fireEvent.change(input, { target: { value: 'a' } });
    await new Promise((r) => setTimeout(r, 450));
    expect(
      fetchApi.mock.calls.some((c) => typeof c[0] === 'string' && c[0].startsWith('/api/search')),
    ).toBe(false);
  });

  it('fetches /api/search?q=... after the 300ms debounce when query length >= 2', async () => {
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    input.focus();
    fireEvent.change(input, { target: { value: 'acme' } });
    await waitFor(
      () => expect(fetchApi).toHaveBeenCalledWith('/api/search?q=acme'),
      { timeout: 2000 },
    );
  });

  it('URL-encodes the query string (special chars like # / & / spaces)', async () => {
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    input.focus();
    fireEvent.change(input, { target: { value: 'a&b #c' } });
    await waitFor(
      () => expect(fetchApi).toHaveBeenCalledWith('/api/search?q=a%26b%20%23c'),
      { timeout: 2000 },
    );
  });

  it('shows the empty-state message when no results match (no pages, no entities)', async () => {
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    input.focus();
    // 'zzqqqxx' won't match any of the mocked pages' labels/descriptions.
    fireEvent.change(input, { target: { value: 'zzqqqxx' } });
    expect(
      await screen.findByText(/No algorithmic matches located for/i, {}, { timeout: 2000 }),
    ).toBeInTheDocument();
    // The query is echoed inside the empty-state message.
    expect(screen.getByText('zzqqqxx')).toBeInTheDocument();
  });

  it('matches accessible pages from /api/pages/me by label (Pages section)', async () => {
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    input.focus();
    fireEvent.change(input, { target: { value: 'sett' } });
    expect(await screen.findByText(/^Pages$/i, {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('matches the wellness invoice page from /api/pages/me', async () => {
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    input.focus();
    fireEvent.change(input, { target: { value: 'invoice' } });
    expect(await screen.findByText(/^Pages$/i, {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText('Invoices')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Invoices'));
    expect(navigateMock).toHaveBeenCalledWith('/wellness/invoices');
  });

  it('matches accessible pages by description (e.g. "directory" → Contacts + Patients)', async () => {
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    input.focus();
    fireEvent.change(input, { target: { value: 'directory' } });
    await screen.findByText(/^Pages$/i, {}, { timeout: 2000 });
    expect(screen.getByText('Contacts')).toBeInTheDocument();
    expect(screen.getByText('Patients')).toBeInTheDocument();
  });

  it('clicking a page row navigates to its path and clears the query', async () => {
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    input.focus();
    fireEvent.change(input, { target: { value: 'patient' } });
    const row = await screen.findByText('Patients', {}, { timeout: 2000 });
    fireEvent.click(row);
    expect(navigateMock).toHaveBeenCalledWith('/wellness/patients');
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('renders contact + deal + invoice + ticket + task result rows under their section headers', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/pages/me') return Promise.resolve({ pages: [] });
      return Promise.resolve({
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
        tickets: [
          { id: 201, subject: 'Acme login issue', status: 'OPEN', priority: 'HIGH' },
        ],
        tasks: [
          { id: 301, title: 'Acme follow-up', status: 'PENDING' },
        ],
      });
    });
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    input.focus();
    fireEvent.change(input, { target: { value: 'acme' } });
    // Section headers — the new contract renames sections to the plural
    // entity name (Contacts/Pipeline/Invoices/Tickets/Tasks).
    expect(await screen.findByText(/^Contacts$/i, {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText(/^Pipeline$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Invoices$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Tickets$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Tasks$/i)).toBeInTheDocument();
    // Row contents — "Alice Chen" appears twice (contact row's primary line +
    // the invoice row's secondary line via contact.name), so use getAllByText
    // with length >= 2 to express the contract honestly.
    expect(screen.getAllByText(/Alice Chen/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('alice@acme.test')).toBeInTheDocument();
    expect(screen.getByText('Acme renewal')).toBeInTheDocument();
    expect(screen.getByText(/INV-2026-001/)).toBeInTheDocument();
    expect(screen.getByText('PAID')).toBeInTheDocument();
    expect(screen.getByText(/Acme login issue/)).toBeInTheDocument();
    expect(screen.getByText(/Acme follow-up/)).toBeInTheDocument();
  });

  it('clicking a contact result row navigates to /contacts/:id', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/pages/me') return Promise.resolve({ pages: [] });
      return Promise.resolve({
        contacts: [
          { id: 7, name: 'Alice Chen', company: 'Acme Corp', email: 'alice@acme.test' },
        ],
        deals: [],
        invoices: [],
      });
    });
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    input.focus();
    fireEvent.change(input, { target: { value: 'alice' } });
    const row = await screen.findByText(/Alice Chen/, {}, { timeout: 2000 });
    fireEvent.click(row);
    expect(navigateMock).toHaveBeenCalledWith('/contacts/7');
  });

  it('clears the dropdown when the query drops below 2 characters', async () => {
    fetchApi.mockImplementationOnce((url) => {
      if (url === '/api/pages/me') return Promise.resolve({ pages: [] });
      return Promise.resolve({ contacts: [], deals: [], invoices: [] });
    }).mockImplementationOnce((url) => {
      if (url === '/api/pages/me') return Promise.resolve({ pages: [] });
      return Promise.resolve({
        contacts: [
          { id: 1, name: 'Alice Chen', company: 'Acme Corp', email: 'alice@acme.test' },
        ],
        deals: [],
        invoices: [],
      });
    });
    fetchApi.mockImplementation((url) => {
      if (url === '/api/pages/me') return Promise.resolve({ pages: [] });
      return Promise.resolve({
        contacts: [
          { id: 1, name: 'Alice Chen', company: 'Acme Corp', email: 'alice@acme.test' },
        ],
        deals: [],
        invoices: [],
      });
    });
    await renderOmnibarAndWaitForPages();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    input.focus();
    fireEvent.change(input, { target: { value: 'alice' } });
    expect(await screen.findByText(/Alice Chen/, {}, { timeout: 2000 })).toBeInTheDocument();
    // Drop below 2 chars — dropdown should collapse.
    fireEvent.change(input, { target: { value: 'a' } });
    await waitFor(() => expect(screen.queryByText(/Alice Chen/)).not.toBeInTheDocument());
  });
});
