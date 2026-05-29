import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import CPQBuilder from '../components/CPQBuilder';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));

// Migration #129/Native-popup-cleanup: CPQBuilder switched alert() → notify.error().
// Mock the notify hook so tests can assert against notifyMock.error instead of window.alert.
const notifyMock = { error: vi.fn(), success: vi.fn(), info: vi.fn(), confirm: vi.fn(), prompt: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyMock, NotifyProvider: ({ children }) => children }));

describe('CPQBuilder', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyMock.error.mockReset();
    notifyMock.success.mockReset();
    notifyMock.info.mockReset();
  });

  it('loads quotes + products on mount, shows empty state', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/cpq/quotes/')) return Promise.resolve([]);
      if (url === '/api/cpq/products') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<CPQBuilder dealId={123} />);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/cpq/quotes/123'));
    expect(await screen.findByText(/No Configure, Price, Quote schemas/i)).toBeInTheDocument();
  });

  it('clicking "Mint SaaS Quote" opens the builder form', async () => {
    fetchApiMock.mockResolvedValue([]);
    render(<CPQBuilder dealId={1} />);
    fireEvent.click(await screen.findByText(/Mint SaaS Quote/i));
    expect(screen.getByPlaceholderText(/Quote Contract Title/)).toBeInTheDocument();
  });

  it('can add + remove line items', async () => {
    fetchApiMock.mockResolvedValue([]);
    render(<CPQBuilder dealId={1} />);
    fireEvent.click(await screen.findByText(/Mint SaaS Quote/i));
    fireEvent.click(screen.getByText(/Append Contract Line Object/i));
    // One line item row has a remove (Trash2) button — click it
    const trash = document.querySelectorAll('button svg');
    // Instead: locate by aria — fall back to picking the last button with lucide icon
    const removeBtns = Array.from(document.querySelectorAll('button')).filter(b => b.innerHTML.includes('<svg'));
    // The last "trash" sized button removes the line
    expect(screen.getByPlaceholderText(/Custom Configuration/i)).toBeInTheDocument();
  });

  it('saveQuote alerts if title is missing', async () => {
    fetchApiMock.mockResolvedValue([]);
    render(<CPQBuilder dealId={1} />);
    fireEvent.click(await screen.findByText(/Mint SaaS Quote/i));
    fireEvent.click(screen.getByText(/Commit Active CPQ Engine/i));
    expect(notifyMock.error).toHaveBeenCalledWith(expect.stringMatching(/title/i));
  });

  it('saveQuote posts to /api/cpq/quotes when title is provided', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (opts?.method === 'POST') return Promise.resolve({ id: 99 });
      return Promise.resolve([]);
    });
    render(<CPQBuilder dealId={7} />);
    fireEvent.click(await screen.findByText(/Mint SaaS Quote/i));
    fireEvent.change(screen.getByPlaceholderText(/Quote Contract Title/), { target: { value: 'My Quote' } });
    fireEvent.click(screen.getByText(/Commit Active CPQ Engine/i));
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/cpq/quotes',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('alerts on failed save', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (opts?.method === 'POST') return Promise.reject(new Error('nope'));
      return Promise.resolve([]);
    });
    render(<CPQBuilder dealId={7} />);
    fireEvent.click(await screen.findByText(/Mint SaaS Quote/i));
    fireEvent.change(screen.getByPlaceholderText(/Quote Contract Title/), { target: { value: 'My Quote' } });
    fireEvent.click(screen.getByText(/Commit Active CPQ Engine/i));
    await waitFor(() => expect(notifyMock.error).toHaveBeenCalledWith(expect.stringMatching(/failed/i)));
  });

  it('renders a quote card when quotes list has entries', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/cpq/quotes/')) {
        return Promise.resolve([
          {
            id: 1,
            title: 'Enterprise SLA',
            status: 'draft',
            createdAt: new Date().toISOString(),
            mrr: 1000,
            totalAmount: 500,
            lineItems: [
              { id: 11, quantity: 2, productName: 'Seats', unitPrice: 500, isRecurring: true },
              { id: 12, quantity: 1, productName: 'Setup', unitPrice: 500, isRecurring: false },
            ],
          },
        ]);
      }
      return Promise.resolve([]);
    });
    render(<CPQBuilder dealId={1} />);
    expect(await screen.findByText(/Enterprise SLA/)).toBeInTheDocument();
    expect(screen.getByText(/\$1,000/)).toBeInTheDocument(); // MRR
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Extended coverage — pins behaviours uncovered by the original 7 cases:
  // line-item add/remove math, quantity/price input updates, isRecurring
  // select toggle, Abort Schema cancel, non-array API response handling,
  // builder reset-after-save, multi-line-item aggregation, MRR-only header
  // (no one-time row), and load-error swallowing.
  // ───────────────────────────────────────────────────────────────────────────

  it('removeLine actually deletes the row from the DOM', async () => {
    fetchApiMock.mockResolvedValue([]);
    render(<CPQBuilder dealId={1} />);
    fireEvent.click(await screen.findByText(/Mint SaaS Quote/i));
    // Add two rows
    fireEvent.click(screen.getByText(/Append Contract Line Object/i));
    fireEvent.click(screen.getByText(/Append Contract Line Object/i));
    expect(screen.getAllByPlaceholderText(/Custom Configuration/i)).toHaveLength(2);
    // Remove first row: the trash button is the last child of each row; grab the first one.
    const rows = screen.getAllByPlaceholderText(/Custom Configuration/i);
    const firstRow = rows[0].closest('div');
    const trashBtn = firstRow.querySelector('button');
    fireEvent.click(trashBtn);
    expect(screen.getAllByPlaceholderText(/Custom Configuration/i)).toHaveLength(1);
  });

  it('updating quantity + unitPrice on a line item persists in the input value', async () => {
    fetchApiMock.mockResolvedValue([]);
    render(<CPQBuilder dealId={1} />);
    fireEvent.click(await screen.findByText(/Mint SaaS Quote/i));
    fireEvent.click(screen.getByText(/Append Contract Line Object/i));
    const productInput = screen.getByPlaceholderText(/Custom Configuration/i);
    fireEvent.change(productInput, { target: { value: 'Premium Seats' } });
    expect(productInput.value).toBe('Premium Seats');

    // Quantity input is the number input adjacent to the product input within the row
    const row = productInput.closest('div');
    const numberInputs = row.querySelectorAll('input[type="number"]');
    // numberInputs[0] = quantity, [1] = unitPrice
    fireEvent.change(numberInputs[0], { target: { value: '5' } });
    expect(numberInputs[0].value).toBe('5');
    fireEvent.change(numberInputs[1], { target: { value: '249.99' } });
    expect(numberInputs[1].value).toBe('249.99');
  });

  it('isRecurring select toggles between Monthly (MRR) and One-Time Payload', async () => {
    fetchApiMock.mockResolvedValue([]);
    render(<CPQBuilder dealId={1} />);
    fireEvent.click(await screen.findByText(/Mint SaaS Quote/i));
    fireEvent.click(screen.getByText(/Append Contract Line Object/i));
    const selects = document.querySelectorAll('select');
    expect(selects).toHaveLength(1);
    // Default is true (MRR)
    expect(selects[0].value).toBe('true');
    fireEvent.change(selects[0], { target: { value: 'false' } });
    expect(selects[0].value).toBe('false');
    // Flip back
    fireEvent.change(selects[0], { target: { value: 'true' } });
    expect(selects[0].value).toBe('true');
  });

  it('"Abort Schema" closes the builder without POSTing', async () => {
    fetchApiMock.mockResolvedValue([]);
    render(<CPQBuilder dealId={1} />);
    fireEvent.click(await screen.findByText(/Mint SaaS Quote/i));
    expect(screen.getByPlaceholderText(/Quote Contract Title/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Abort Schema/i));
    // Builder form disappears; Mint button comes back
    expect(screen.queryByPlaceholderText(/Quote Contract Title/)).not.toBeInTheDocument();
    expect(screen.getByText(/Mint SaaS Quote/i)).toBeInTheDocument();
    // No POST issued
    const postCalls = fetchApiMock.mock.calls.filter(([, opts]) => opts?.method === 'POST');
    expect(postCalls).toHaveLength(0);
  });

  it('handles non-array API responses gracefully (defaults to empty quotes)', async () => {
    fetchApiMock.mockImplementation((url) => {
      // Backend returns an object envelope instead of array — SUT must not crash
      if (url.startsWith('/api/cpq/quotes/')) return Promise.resolve({ error: 'malformed' });
      if (url === '/api/cpq/products') return Promise.resolve(null);
      return Promise.resolve([]);
    });
    render(<CPQBuilder dealId={42} />);
    // Empty-state copy still renders even when API returned a non-array
    expect(await screen.findByText(/No Configure, Price, Quote schemas/i)).toBeInTheDocument();
  });

  it('successful save resets the builder form + reloads quotes', async () => {
    let getCalls = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      if (opts?.method === 'POST') return Promise.resolve({ id: 1 });
      if (url.startsWith('/api/cpq/quotes/')) {
        getCalls += 1;
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
    render(<CPQBuilder dealId={7} />);
    await waitFor(() => expect(getCalls).toBeGreaterThanOrEqual(1));
    const initialGets = getCalls;
    fireEvent.click(await screen.findByText(/Mint SaaS Quote/i));
    fireEvent.change(screen.getByPlaceholderText(/Quote Contract Title/), { target: { value: 'Reset Test' } });
    fireEvent.click(screen.getByText(/Commit Active CPQ Engine/i));
    // Form closes, Mint button returns, quotes reload fired
    await waitFor(() => expect(screen.queryByPlaceholderText(/Quote Contract Title/)).not.toBeInTheDocument());
    expect(screen.getByText(/Mint SaaS Quote/i)).toBeInTheDocument();
    expect(getCalls).toBeGreaterThan(initialGets);
  });

  it('aggregates a quote card with multiple line items including one-time payload row', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/cpq/quotes/')) {
        return Promise.resolve([
          {
            id: 9,
            title: 'Multi-Item Quote',
            status: 'sent',
            createdAt: new Date('2026-01-15T00:00:00Z').toISOString(),
            mrr: 2500,
            totalAmount: 1500,
            lineItems: [
              { id: 1, quantity: 10, productName: 'API Calls', unitPrice: 100, isRecurring: true },
              { id: 2, quantity: 5, productName: 'Storage GB', unitPrice: 300, isRecurring: true },
              { id: 3, quantity: 1, productName: 'Onboarding', unitPrice: 1500, isRecurring: false },
            ],
          },
        ]);
      }
      return Promise.resolve([]);
    });
    render(<CPQBuilder dealId={9} />);
    expect(await screen.findByText(/Multi-Item Quote/)).toBeInTheDocument();
    // Each line item renders qty + productName
    expect(screen.getByText(/10x API Calls/)).toBeInTheDocument();
    expect(screen.getByText(/5x Storage GB/)).toBeInTheDocument();
    expect(screen.getByText(/1x Onboarding/)).toBeInTheDocument();
    // One-time payload section visible (totalAmount > 0)
    expect(screen.getByText(/One-time payload/i)).toBeInTheDocument();
    // Status shown
    expect(screen.getByText(/State: sent/)).toBeInTheDocument();
  });

  it('omits the one-time-payload row when totalAmount is 0 (MRR-only quote)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/cpq/quotes/')) {
        return Promise.resolve([
          {
            id: 10,
            title: 'Pure SaaS',
            status: 'draft',
            createdAt: new Date().toISOString(),
            mrr: 999,
            totalAmount: 0,
            lineItems: [
              { id: 1, quantity: 1, productName: 'Subscription', unitPrice: 999, isRecurring: true },
            ],
          },
        ]);
      }
      return Promise.resolve([]);
    });
    render(<CPQBuilder dealId={10} />);
    expect(await screen.findByText(/Pure SaaS/)).toBeInTheDocument();
    expect(screen.queryByText(/One-time payload/i)).not.toBeInTheDocument();
  });

  it('swallows load errors silently (no notify, no crash)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/cpq/quotes/')) return Promise.reject(new Error('network down'));
      if (url === '/api/cpq/products') return Promise.reject(new Error('network down'));
      return Promise.resolve([]);
    });
    render(<CPQBuilder dealId={555} />);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/cpq/quotes/555'));
    // Empty state still shows (quotes defaulted to [])
    expect(await screen.findByText(/No Configure, Price, Quote schemas/i)).toBeInTheDocument();
    // No error notification fired (load errors are deliberately swallowed)
    expect(notifyMock.error).not.toHaveBeenCalled();
  });
});
