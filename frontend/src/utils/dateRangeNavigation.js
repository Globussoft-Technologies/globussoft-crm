import { scopedStorageKey } from './scopedStorage';

const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '';
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : '';
};

export function readDateRange(searchParams) {
  return {
    from: validDate(searchParams.get('from')),
    to: validDate(searchParams.get('to')),
  };
}

export function setDateRangeParams(searchParams, range) {
  const next = new URLSearchParams(searchParams);
  for (const key of ['from', 'to']) {
    const value = validDate(range[key]);
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

export function pathWithDateRange(path, range) {
  const [pathname, query = ''] = path.split('?');
  const params = setDateRangeParams(new URLSearchParams(query), range);
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}

const dashboardRangeKey = (scope) => scopedStorageKey('dashboard-date-range', scope);
const dashboardFilterKey = (scope) => scopedStorageKey('dashboard-filter', scope);

export function readSavedDashboardDateRange(scope) {
  try {
    const stored = sessionStorage.getItem(dashboardRangeKey(scope));
    if (!stored) return null;
    const range = readDateRange(new URLSearchParams(stored));
    return range.from || range.to ? range : null;
  } catch {
    return null;
  }
}

export function saveDashboardDateRange(scope, range) {
  try {
    const key = dashboardRangeKey(scope);
    if (range.from || range.to) sessionStorage.setItem(key, setDateRangeParams(new URLSearchParams(), range).toString());
    else sessionStorage.removeItem(key);
  } catch {
    // Storage may be unavailable; URL-based navigation still carries the range.
  }
}

export function readSavedDashboardFilter(scope) {
  try {
    const stored = sessionStorage.getItem(dashboardFilterKey(scope));
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    const range = readDateRange(new URLSearchParams(
      setDateRangeParams(new URLSearchParams(), parsed?.range || {}).toString(),
    ));
    const allowedPresets = new Set(['all', 'last7', 'last30', 'thisQuarter', 'lastQuarter', 'custom']);
    if (!allowedPresets.has(parsed?.preset)) return null;
    return { preset: parsed.preset, range };
  } catch {
    return null;
  }
}

export function saveDashboardFilter(scope, { preset, range }) {
  try {
    const allowedPresets = new Set(['all', 'last7', 'last30', 'thisQuarter', 'lastQuarter', 'custom']);
    if (!allowedPresets.has(preset)) return;
    sessionStorage.setItem(dashboardFilterKey(scope), JSON.stringify({
      preset,
      range: readDateRange(new URLSearchParams(setDateRangeParams(new URLSearchParams(), range || {}).toString())),
    }));
  } catch {
    // Storage may be unavailable; the dashboard remains usable for this visit.
  }
}
