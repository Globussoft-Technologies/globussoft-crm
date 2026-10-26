import { beforeEach, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FilterPanel from '../components/FilterPanel';
import { fetchApi } from '../utils/api';
vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
const valuesUrl = (field) => `/api/contacts/filter-values/${field}?status=Lead`;
beforeEach(() => fetchApi.mockReset().mockResolvedValue({ values: [{ value: 'John', label: 'John' }] }));

test.each(['firstName', 'lastName', 'utm_source'])('%s choices use remote search instead of a truncated local list', async (field) => {
  render(<FilterPanel fieldsUrl="/api/contacts/filter-fields" valuesUrl={valuesUrl}
    fieldKey={field} fieldLabel={field} fieldKind="text" autoOpen filters={[]} onChange={() => {}} />);
  const input = await screen.findByRole('textbox', { name: 'Search values' });
  expect(fetchApi).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: 'Jo' } });
  await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
    `/api/contacts/filter-values/${field}?status=Lead&q=Jo`, { silent: true },
  ));
  expect(await screen.findByRole('checkbox', { name: 'John' })).toBeInTheDocument();
});

test('shows web form lead counts beside every form option', async () => {
  fetchApi.mockResolvedValue({ values: [
    { value: 'Globus CRM', label: 'Globus CRM', count: 31 },
    { value: 'Unused form', label: 'Unused form', count: 0 },
  ] });
  render(<FilterPanel fieldsUrl="/api/contacts/filter-fields" valuesUrl={valuesUrl}
    fieldKey="webForm" fieldLabel="Web Form" fieldKind="text" autoOpen filters={[]} onChange={() => {}} />);
  expect(await screen.findByRole('checkbox', { name: 'Globus CRM (31)' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Unused form (0)' })).toBeInTheDocument();
});

test('shows a search box for web forms in the compact filter summary', async () => {
  fetchApi.mockImplementation((url) => Promise.resolve(url === '/api/contacts/filter-fields'
    ? { fields: [{ field: 'webForm', label: 'Web Form', kind: 'text' }] }
    : { values: [
      { value: 'Demo Form', label: 'Demo Form', count: 0 },
      { value: 'Social Reel Farm', label: 'Social Reel Farm', count: 4 },
    ] }));
  render(<FilterPanel fieldsUrl="/api/contacts/filter-fields" valuesUrl={valuesUrl}
    layoutVariant="freshsales" filters={[{ field: 'webForm', label: 'Web Form', kind: 'text', operator: 'contains', values: [] }]} onChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Filter by' }));
  const search = await screen.findByRole('textbox', { name: 'Search web forms' });
  expect(search).toHaveAttribute('placeholder', 'Search web forms…');
  expect(await screen.findByRole('checkbox', { name: 'Social Reel Farm (4)' })).toBeInTheDocument();
  fireEvent.change(search, { target: { value: 'Demo' } });
  expect(screen.getByRole('checkbox', { name: 'Demo Form (0)' })).toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: 'Social Reel Farm (4)' })).not.toBeInTheDocument();
});
