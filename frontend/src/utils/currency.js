// Multi-currency formatting + conversion helpers.
// Used by the Currencies page and any module that displays per-deal amounts.

export const CURRENCY_SYMBOLS = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
  JPY: '¥',
  CNY: '¥',
  CAD: 'C$',
  AUD: 'A$',
  CHF: 'CHF',
  HKD: 'HK$',
  SGD: 'S$',
  NZD: 'NZ$',
  ZAR: 'R',
  AED: 'د.إ',
  SAR: 'ر.س',
  BRL: 'R$',
  MXN: 'Mex$',
  KRW: '₩',
  RUB: '₽',
  TRY: '₺',
  THB: '฿',
};

const ZERO_DECIMAL_CODES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'IDR']);

// Format a number like 1,23,456 (Indian numbering: lakh / crore grouping).
function formatIndian(n, decimals) {
  const sign = n < 0 ? '-' : '';
  const absN = Math.abs(n);
  const fixed = absN.toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const lastThree = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const groupedRest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${groupedRest},${lastThree}` : lastThree;
  return decPart ? `${sign}${grouped}.${decPart}` : `${sign}${grouped}`;
}

// Format with locale-default thousand separators.
function formatWestern(n, decimals) {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format a numeric amount with the symbol for the given ISO code.
 * INR uses Indian (lakh/crore) digit grouping.
 */
export function formatCurrency(amount, code = 'USD') {
  const upper = String(code || 'USD').toUpperCase();
  const symbol = CURRENCY_SYMBOLS[upper] || `${upper} `;
  const value = Number.isFinite(amount) ? amount : parseFloat(amount) || 0;
  const decimals = ZERO_DECIMAL_CODES.has(upper) ? 0 : 2;

  const body = upper === 'INR' ? formatIndian(value, decimals) : formatWestern(value, decimals);
  // Symbol-prefix style for all listed currencies.
  return value < 0 ? `-${symbol}${body.replace(/^-/, '')}` : `${symbol}${body}`;
}

/**
 * Convert an amount between two currencies, using a list returned from /api/currencies.
 * Each currency's exchangeRate is expressed as "1 base = exchangeRate units of this currency".
 */
export function convertCurrency(amount, fromCode, toCode, currencies = []) {
  const value = Number.isFinite(amount) ? amount : parseFloat(amount) || 0;
  const from = String(fromCode || '').toUpperCase();
  const to = String(toCode || '').toUpperCase();
  if (from === to) return value;

  const fromCur = currencies.find((c) => c.code === from);
  const toCur = currencies.find((c) => c.code === to);
  if (!fromCur || !toCur) return value;

  const fromRate = parseFloat(fromCur.exchangeRate) || 1;
  const toRate = parseFloat(toCur.exchangeRate) || 1;
  // amount_in_base = amount / fromRate; amount_in_to = amount_in_base * toRate
  return (value / fromRate) * toRate;
}

// Persisted conversions must fail closed. The legacy display helper above
// intentionally keeps its fallback, but must not relabel an unconverted value
// when writing financial data back to the API.
export function convertCurrencyStrict(amount, fromCode, toCode, currencies = []) {
  const value = Number(amount);
  const from = String(fromCode || '').trim().toUpperCase();
  const to = String(toCode || '').trim().toUpperCase();
  if (!Number.isFinite(value) || amount === '' || amount == null) throw new Error('Enter a valid amount.');
  if (!from || !to) throw new Error('Choose valid source and target currencies.');
  if (from === to) return value;
  const rates = new Map(currencies.map(currency => [String(currency.code || '').toUpperCase(), Number(currency.exchangeRate)]));
  const fromRate = rates.get(from);
  const toRate = rates.get(to);
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    throw new Error(`Exchange rates unavailable for ${from} to ${to}. Reload currencies and try again.`);
  }
  const converted = (value / fromRate) * toRate;
  if (!Number.isFinite(converted)) throw new Error('Unable to convert this amount safely.');
  return converted;
}

/**
 * Strip currency symbols and grouping characters and parse into a Number.
 * "$1,234.56" -> 1234.56 ; "₹1,23,456.78" -> 123456.78
 */
export function parseCurrency(str) {
  if (str == null) return 0;
  if (typeof str === 'number') return str;
  const cleaned = String(str).replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return 0;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export default {
  CURRENCY_SYMBOLS,
  formatCurrency,
  convertCurrency,
  parseCurrency,
};
