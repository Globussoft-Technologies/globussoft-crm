import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import WebFormLeadsModal from '../components/WebFormLeadsModal';
import { fetchApi } from '../utils/api';
vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
const form = { id: 7, name: 'Brand intake' };
beforeEach(() => vi.clearAllMocks());
test('shows dynamic fields, separate source and medium, dates and backend pagination/search', async () => {
  fetchApi.mockResolvedValue({ fields: [{ id: 's', label: 'Source' }, { id: 'm', label: 'Medium' }], total: 26,
    leads: [{ id: 1, values: ['Website', 'Google'], createdAt: '2026-01-01', updatedAt: '2026-02-01' }] });
  const close = vi.fn();
  render(<WebFormLeadsModal form={form} onClose={close} />);
  expect(await screen.findByText('Google')).toBeInTheDocument();
  for (const name of ['Source', 'Medium', 'Created', 'Last Updated']) expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
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
