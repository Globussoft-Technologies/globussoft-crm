import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import WebFormLeadsModal from '../components/WebFormLeadsModal';
import { fetchApi } from '../utils/api';
vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
const form = { id: 7, name: 'Brand intake' };
beforeEach(() => vi.clearAllMocks());
test('shows dynamic fields, separate source and medium, dates and backend pagination/search', async () => {
  fetchApi.mockResolvedValue({ fields: [{ id: 's', label: 'Source' }, { id: 'm', label: 'Medium' }], total: 26,
  leads: [
    { id: 1, values: ['Website', 'Google'], createdAt: '2026-01-01', updatedAt: '2026-02-01' },
    { id: 2, values: ['Deleted Website', 'Old campaign'], createdAt: '2026-01-02', updatedAt: '2026-02-02', deletedAt: '2026-02-03' },
    { id: 3, values: ['Missing Lead', 'Unlinked campaign'], createdAt: '2026-01-03', updatedAt: '2026-02-03', contactId: null, isLead: false },
  ] });
  const close = vi.fn();
  render(<WebFormLeadsModal form={form} onClose={close} />);
  expect(await screen.findByText('Google')).toBeInTheDocument();
  expect(screen.getByText('Red rows indicate submissions that are not active Leads.').parentElement).toHaveAttribute('title', 'Red rows are Web Form submissions whose related record is not currently available as an active Lead.');
  for (const name of ['Source', 'Medium', 'Created', 'Last Updated']) expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
  const deletedRow = screen.getByText('Deleted Website').closest('tr');
  expect(deletedRow).toHaveAttribute('title', 'Marked red: not an active Lead. This lead was deleted from Leads');
  expect(deletedRow).toHaveStyle({ color: '#b91c1c' });
  expect(deletedRow).toHaveStyle({ display: 'table-row' });
  expect(screen.getByText('Deleted Website').closest('td')).toHaveStyle({ overflowWrap: 'break-word', wordBreak: 'normal' });
  expect(screen.getByText('Missing Lead').closest('tr')).toHaveAttribute('title', 'Marked red: not an active Lead. This submission no longer has a lead record in Leads');
  fireEvent.click(screen.getByRole('button', { name: 'Go to page 2', exact: true }));
  await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/forms/7/leads?page=2&limit=10&search='));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Priya' } });
  await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/forms/7/leads?page=1&limit=10&search=Priya'));
  fireEvent.click(screen.getByLabelText('Close dialog'));
  expect(close).toHaveBeenCalled();
});
test('renders empty and error states', async () => {
  fetchApi.mockResolvedValueOnce({ fields: [], leads: [], total: 0 }).mockRejectedValueOnce(new Error('Request failed'));
  render(<WebFormLeadsModal form={form} onClose={() => {}} />);
  expect(await screen.findByText('No leads found for this web form.')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Request failed');
});
