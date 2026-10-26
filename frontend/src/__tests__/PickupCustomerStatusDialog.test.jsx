import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import PickupCustomerStatusDialog from '../components/PickupCustomerStatusDialog';

test('shows workflow progress without history pagination controls', () => {
  const customer = { contactId: 61, contact: { name: 'Converted Customer' }, workflowHistory: [],
    workflowHistoryPagination: { page: 1, pageSize: 50, hasMore: true } };
  render(<PickupCustomerStatusDialog customer={customer} onClose={() => {}} />);
  expect(screen.getByText('Workflow progress')).toBeInTheDocument();
  expect(screen.getByTestId('workflow-timeline')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Older history' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Newer history' })).not.toBeInTheDocument();
  expect(screen.queryByText(/History page/)).not.toBeInTheDocument();
});

test('shows the transport pickup and drop-off times from the customer workflow', () => {
  const customer = {
    contactId: 61,
    contact: { name: 'Converted Customer' },
    workflow: {
      transport: {
        status: 'COMPLETED',
        pickupAt: '2026-10-06T09:15:00.000Z',
        dropOffAt: '2026-10-06T10:00:00.000Z',
      },
    },
    workflowHistory: [],
  };
  render(<PickupCustomerStatusDialog customer={customer} onClose={() => {}} />);

  const details = screen.getByTestId('customer-status-details');
  expect(details).toHaveTextContent('Pickup time');
  expect(details).toHaveTextContent('Site visit / drop-off time');
  expect(details).toHaveTextContent('2026');
});
