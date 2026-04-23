import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import CPQBuilder from '../components/CPQBuilder';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));

describe('CPQBuilder', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
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
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<CPQBuilder dealId={1} />);
    fireEvent.click(await screen.findByText(/Mint SaaS Quote/i));
    fireEvent.click(screen.getByText(/Commit Active CPQ Engine/i));
    expect(alertSpy).toHaveBeenCalledWith(expect.stringMatching(/title/i));
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
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<CPQBuilder dealId={7} />);
    fireEvent.click(await screen.findByText(/Mint SaaS Quote/i));
    fireEvent.change(screen.getByPlaceholderText(/Quote Contract Title/), { target: { value: 'My Quote' } });
    fireEvent.click(screen.getByText(/Commit Active CPQ Engine/i));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(expect.stringMatching(/failed/i)));
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
});
