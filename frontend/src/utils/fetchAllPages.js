import { fetchApi } from './api';

const DEFAULT_API_LIMIT = 100;
const MAX_PAGE_SIZE = 500;

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const buildPageUrl = (path, limit, offset) => {
  const [pathname, query = ''] = String(path).split('?', 2);
  const params = new URLSearchParams(query);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `${pathname}?${params.toString()}`;
};

/**
 * Fetch every page from an offset-paginated endpoint that returns an array.
 * The original URL is requested first so existing filters and cached requests
 * retain their current behaviour.
 */
export async function fetchAllPages(path, options = {}) {
  const { pageSize = MAX_PAGE_SIZE, ...fetchOptions } = options;
  const request = Object.keys(fetchOptions).length > 0
    ? (url) => fetchApi(url, fetchOptions)
    : (url) => fetchApi(url);

  const firstPage = await request(path);
  if (!Array.isArray(firstPage)) return [];

  const [, query = ''] = String(path).split('?', 2);
  const initialParams = new URLSearchParams(query);
  const firstLimit = Math.min(
    positiveInteger(initialParams.get('limit'), DEFAULT_API_LIMIT),
    MAX_PAGE_SIZE,
  );
  if (firstPage.length < firstLimit) return firstPage;

  const requestedPageSize = Math.min(
    positiveInteger(pageSize, MAX_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  let offset = positiveInteger(initialParams.get('offset'), 0) + firstPage.length;
  const rows = [...firstPage];
  const seenIds = new Set(firstPage.map((row) => row?.id).filter(Boolean));

  while (true) {
    const page = await request(buildPageUrl(path, requestedPageSize, offset));
    if (!Array.isArray(page) || page.length === 0) break;

    page.forEach((row) => {
      if (row?.id && seenIds.has(row.id)) return;
      if (row?.id) seenIds.add(row.id);
      rows.push(row);
    });

    offset += page.length;
    if (page.length < requestedPageSize) break;
  }

  return rows;
}
