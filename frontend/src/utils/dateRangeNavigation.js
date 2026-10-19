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
