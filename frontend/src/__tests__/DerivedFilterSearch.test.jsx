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
