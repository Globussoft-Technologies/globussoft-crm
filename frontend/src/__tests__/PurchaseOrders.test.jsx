/**
 * PurchaseOrders.test.jsx - RTL coverage for the travel supplier purchase
 * orders table. Pins the page chrome and the row-count badge so the list
 * stays in sync with the fetched data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

import PurchaseOrders from '../pages/travel/PurchaseOrders';

const PURCHASE_ORDERS = [
  {
    id: 1,
    poNumber: 'PO-001',
    supplierId: 10,
    supplier: { name: 'Alpha Tours' },
    status: 'draft',
    totalAmount: 1200,
    currency: 'INR',
    createdAt: '2026-08-20T08:00:00.000Z',
  },
  {
    id: 2,
    poNumber: 'PO-002',
    supplierId: 11,
    supplier: { name: 'Blue Skies Holidays' },
    status: 'sent',
    totalAmount: 2450,
    currency: 'INR',
    createdAt: '2026-08-20T09:00:00.000Z',
  },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <PurchaseOrders />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
});

describe('<PurchaseOrders />', () => {
  it('renders the header badge and the fetched rows', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/travel/purchase-orders?')) {
        return Promise.resolve({ purchaseOrders: PURCHASE_ORDERS });
      }
      if (url === '/api/travel/suppliers?limit=200') {
        return Promise.resolve({ suppliers: [] });
      }
      return Promise.resolve({});
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: /Supplier Purchase Orders/i })).toBeInTheDocument();
    expect(screen.getByTitle('2 Total Purchase Orders')).toBeInTheDocument();
    expect(screen.getByText('PO-001')).toBeInTheDocument();
    expect(screen.getByText('PO-002')).toBeInTheDocument();
  });
});
