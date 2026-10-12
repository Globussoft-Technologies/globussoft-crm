import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import PickupCustomerStatusDialog from '../components/PickupCustomerStatusDialog';

const fetchApi = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ fetchApi }));

test('loads older workflow history on demand without downloading the whole history', async () => {
  const customer = { contactId: 61, contact: { name: 'Converted Customer' }, workflowHistory: [],
    workflowHistoryPagination: { page: 1, pageSize: 50, hasMore: true } };
  fetchApi.mockResolvedValue({ customers: [{ ...customer, workflowHistoryPagination: { page: 2, pageSize: 50, hasMore: false } }] });
  render(<PickupCustomerStatusDialog customer={customer} onClose={() => {}} />);
  expect(fetchApi).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Older history' }));
  expect(await screen.findByText(/History page 2/)).toBeInTheDocument();
  expect(fetchApi).toHaveBeenCalledWith('/api/pickup-plot-inventory/lead-status?contactIds=61&historyPage=2');
  expect(screen.getByRole('button', { name: 'Older history' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Newer history' })).toBeEnabled();
});
