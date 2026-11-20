import { fetchApi } from './api';

// Keep requests small and serial. Never retry destructive batches implicitly.
export async function runLeadBatches(url, method, ids, fields = {}, onProgress = () => {}) {
  const unique = [...new Set(ids)];
  const totals = { updated: 0, deleted: 0, skipped: 0 };
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const result = await fetchApi(url, {
      method,
      ...(method === 'DELETE' ? { readDeleteResponse: true } : {}),
      body: JSON.stringify({ ...fields, contactIds: batch }),
    });
    if (method === 'DELETE' && !Number.isSafeInteger(result?.deleted)) {
      throw new Error('The server did not confirm how many leads were deleted. Check the refreshed list before trying again.');
    }
    for (const key of Object.keys(totals)) totals[key] += Number(result?.[key]) || 0;
    onProgress({ done: Math.min(offset + batch.length, unique.length), total: unique.length });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return totals;
}
