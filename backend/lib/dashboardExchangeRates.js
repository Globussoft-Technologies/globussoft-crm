const prisma = require('./prisma');

// Public market data shared across tenants. Never store tenant data in this cache.
const KEY = 'generic_dashboard_fx_v1';
const REFRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
let inFlight;
let retryAfter = 0;

function validDate(value) {
  const time = Date.parse(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(time)
    && new Date(time).toISOString().slice(0, 10) === value;
}

function validSnapshot(value) {
  return value && value.source === 'Frankfurter' && value.rates?.USD === 1
    && Number.isFinite(Date.parse(value.checkedAt)) && value.dates
    && Object.entries(value.rates).every(([code, rate]) => /^[A-Z]{3}$/.test(code)
      && Number.isFinite(rate) && rate > 0
      && validDate(value.dates[code]));
}

async function refreshSnapshot() {
  const response = await fetch('https://api.frankfurter.dev/v2/rates?base=USD', {
    signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Exchange-rate provider unavailable');
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new Error('Invalid exchange-rate response');
  const rates = { USD: 1 };
  const dates = {};
  const today = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    if (row.base !== 'USD' || !/^[A-Z]{3}$/.test(row.quote)
      || !Number.isFinite(row.rate) || row.rate <= 0
      || !validDate(row.date) || row.date > today) {
      throw new Error('Invalid exchange-rate quote');
    }
    rates[row.quote] = row.rate;
    dates[row.quote] = row.date;
  }
  rates.USD = 1;
  dates.USD = Object.values(dates).sort().at(-1);
  const snapshot = { source: 'Frankfurter', checkedAt: new Date().toISOString(), rates, dates };
  if (!validSnapshot(snapshot)) throw new Error('Invalid exchange-rate snapshot');
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, category: 'exchange-rates', value: JSON.stringify(snapshot) },
    update: { value: JSON.stringify(snapshot) },
  });
  return snapshot;
}

async function getSnapshot() {
  let snapshot = null;
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
    const parsed = row ? JSON.parse(row.value) : null;
    if (validSnapshot(parsed)) snapshot = parsed;
  } catch { /* A corrupt/unavailable cache must not invent exchange rates. */ }
  const checked = snapshot && Date.parse(snapshot.checkedAt);
  const refreshDue = !checked || Date.now() - checked >= REFRESH_MS
    || new Date(checked).toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10);
  let refreshFailed = false;
  if (refreshDue) {
    if (Date.now() < retryAfter) refreshFailed = true;
    else {
      if (!inFlight) {
        inFlight = module.exports.refreshSnapshot().finally(() => { inFlight = null; });
      }
      try { snapshot = await inFlight; retryAfter = 0; }
      catch { retryAfter = Date.now() + RETRY_MS; refreshFailed = true; }
    }
  }
  return { snapshot, refreshFailed };
}

async function getDashboardRates(baseCurrency, currencies) {
  const { snapshot, refreshFailed } = await module.exports.getSnapshot();
  const codes = [...new Set([baseCurrency, ...currencies])];
  const missingCurrencies = codes.filter(code => code !== baseCurrency
    && (!snapshot?.rates[code] || !snapshot?.rates[baseCurrency]));
  const dates = codes.filter(code => snapshot?.dates[code]).map(code => snapshot.dates[code]).sort();
  const asOf = dates[0] || null;
  // Weekends/holidays may retain the previous published reference date.
  const stale = refreshFailed || !snapshot || !asOf
    || Date.now() - Date.parse(`${asOf}T00:00:00Z`) > 4 * 86400000;
  const rates = {};
  for (const code of codes) {
    if (code === baseCurrency) rates[code] = 1;
    else if (!missingCurrencies.includes(code)) rates[code] = snapshot.rates[baseCurrency] / snapshot.rates[code];
  }
  return { baseCurrency, source: snapshot?.source || null, asOf,
    checkedAt: snapshot?.checkedAt || null, stale, missingCurrencies,
    incomplete: missingCurrencies.length > 0, rates };
}

module.exports = { getDashboardRates, getSnapshot, refreshSnapshot, validSnapshot };
