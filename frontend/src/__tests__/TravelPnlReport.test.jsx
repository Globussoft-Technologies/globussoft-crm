import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock('../utils/notify', () => ({
  useNotify: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), confirm: vi.fn() }),
}));

import TravelPnlReport from '../pages/travel/PnlReport';

const PNL_RESPONSE = {
  totals: { revenue: 150000, capturedCost: 70000, quoteValue: 50000, grossProfit: 80000, marginPct: 53.33, invoiceCount: 2, costLineCount: 2, quoteLineCount: 1 },
  brands: [
    { subBrand: 'tmc', revenue: 100000, capturedCost: 40000, quoteValue: 50000, grossProfit: 60000, marginPct: 60, invoiceCount: 1, costLineCount: 1, quoteLineCount: 1 },
    { subBrand: 'rfu', revenue: 50000, capturedCost: 30000, grossProfit: 20000, marginPct: 40, invoiceCount: 1, costLineCount: 1 },
  ],
  revenueRows: Array.from({ length: 11 }, (_, index) => ({
    id: index + 1,
    invoiceNum: `TINV-${index + 1}`,
    subBrand: index % 2 ? 'rfu' : 'tmc',
    status: 'Paid',
    amount: 100000 + index,
    createdAt: '2026-01-10T00:00:00.000Z',
  })),
  costRows: [{ id: 2, itineraryId: 9, subBrand: 'tmc', destination: 'Jaipur', itemType: 'hotel', description: 'Hotel block', unitCost: 20000, quantity: 2, capturedCost: 40000 }],
  quoteRows: [{ id: 3, quoteId: 41, subBrand: 'tmc', quoteStatus: 'Accepted', lineType: 'flight', description: 'Quoted flight package', unitPrice: 25000, quantity: 2, amount: 50000 }],
  currency: 'INR',
};

beforeEach(() => {
  fetchApiMock.mockReset();
  fetchApiMock.mockResolvedValue(PNL_RESPONSE);
});

describe('<TravelPnlReport />', () => {
  it('renders back link, brand P&L totals and detail source tables', async () => {
    render(
      <MemoryRouter initialEntries={['/travel/reports/pnl?source=reports&from=2026-01-01&to=2026-01-31']}>
        <TravelPnlReport />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: /Back to reports/i })).toBeInTheDocument();
    expect(await screen.findByText(/Brand-wise profit\/loss/i)).toBeInTheDocument();
    expect(screen.getByText(/Revenue source: travel invoices/i)).toBeInTheDocument();
    expect(screen.getByText(/Accepted quote source: quote, flight and package lines/i)).toBeInTheDocument();
    expect(screen.getByText(/Cost source: itinerary item costs/i)).toBeInTheDocument();
    expect(screen.getByText('TINV-1')).toBeInTheDocument();
    expect(screen.getByText('Showing 10 of 11 - scroll inside table for more')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Next/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Prev/i })).not.toBeInTheDocument();
    expect(screen.queryByText('TINV-11')).not.toBeInTheDocument();
    const revenueBox = screen.getByTestId('revenue-source-scroll');
    Object.defineProperty(revenueBox, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(revenueBox, 'clientHeight', { value: 392, configurable: true });
    fireEvent.scroll(revenueBox, { target: { scrollTop: 620 } });
    expect(await screen.findByText('TINV-11')).toBeInTheDocument();
    expect(screen.getByText('Showing 11 of 11')).toBeInTheDocument();
    expect(screen.getByText('Hotel block')).toBeInTheDocument();
    expect(screen.getByText('Quoted flight package')).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/travel/reports/pnl?from=2026-01-01&to=2026-01-31');
    });
  });
});




