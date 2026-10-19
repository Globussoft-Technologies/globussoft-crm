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
