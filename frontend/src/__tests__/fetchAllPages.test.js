import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import { fetchAllPages } from '../utils/fetchAllPages';

describe('fetchAllPages', () => {
  beforeEach(() => {
    fetchApi.mockReset();
  });

  it('keeps the original request unchanged when the first page is incomplete', async () => {
    fetchApi.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    await expect(fetchAllPages('/api/contacts?status=Lead')).resolves.toHaveLength(2);
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fetchApi).toHaveBeenCalledWith('/api/contacts?status=Lead');
  });

  it('drains every page after a full default page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
    const secondPage = Array.from({ length: 500 }, (_, index) => ({ id: index + 101 }));
    const finalPage = [{ id: 601 }, { id: 602 }];
    fetchApi
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(finalPage);

    const rows = await fetchAllPages('/api/deals');

    expect(rows).toHaveLength(602);
    expect(fetchApi.mock.calls.map(([url]) => url)).toEqual([
      '/api/deals',
      '/api/deals?limit=500&offset=100',
      '/api/deals?limit=500&offset=600',
    ]);
  });

  it('preserves filters and de-duplicates records at page boundaries', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({ id: index + 1 }));
    fetchApi
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([{ id: 500 }, { id: 501 }]);

    const rows = await fetchAllPages('/api/contacts?status=Lead&limit=500');

    expect(rows).toHaveLength(501);
    expect(fetchApi).toHaveBeenNthCalledWith(
      2,
      '/api/contacts?status=Lead&limit=500&offset=500',
    );
  });
});
