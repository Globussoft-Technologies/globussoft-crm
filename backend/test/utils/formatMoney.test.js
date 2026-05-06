// Unit tests for backend/utils/formatMoney.js — the tenant-aware money
// formatter that backs the wellness vertical's PDF rendering, SMS
// templates, and server-side email rendering.
//
// Why this exists: regression class #286 / #330 reported `$` showing up
// on a wellness/INR tenant. The fix is to ensure every render path goes
// through a single helper that respects tenant.defaultCurrency +
// tenant.locale, NOT a hardcoded `$${amount}` template literal. This
// suite pins the helper's contract — closes the gap-card #22 acceptance:
//
//   - INR formatting:   formatMoney(310, 'INR', 'en-IN')      → '₹310.00'
//   - USD formatting:   formatMoney(3.73, 'USD', 'en-US')     → '$3.73'
//   - Sub-paise round:  formatMoney(123.456789, 'INR')        → '₹123.46'
//   - Never produces double symbols ($ ₹ or ₹ $)
//   - On wellness/INR tenant, no path produces `$`
//
// Pure-function pattern: no mocks, just input → output assertions.
// See backend/test/lib/validators.test.js for the same shape.
//
// Closes regression-coverage-backlog #22; covers GitHub issues #189,
// #198, #242, #243, #256, #286, #330. Note this test pins the HELPER's
// contract — the callsite sweep (audit `\$\$\{` template literals
// across the codebase that bypass the helper) is OUT OF SCOPE; that
// remains a follow-up audit.

import { describe, test, expect } from 'vitest';
const { formatMoney, currencySymbol, localeByCurrency } = require('../../utils/formatMoney');

describe('formatMoney — module shape', () => {
  test('exports formatMoney + currencySymbol + localeByCurrency', () => {
    expect(typeof formatMoney).toBe('function');
    expect(typeof currencySymbol).toBe('function');
    expect(localeByCurrency).toBeTypeOf('object');
  });

  test('localeByCurrency map covers every currency the codebase uses', () => {
    // Tenants in the seed: INR (Enhanced Wellness) + USD (Generic CRM).
    // Routes/currencies.js + frontend money.js list EUR/GBP/AED/SGD/AUD/CAD.
    expect(localeByCurrency.INR).toBe('en-IN');
    expect(localeByCurrency.USD).toBe('en-US');
    expect(localeByCurrency.EUR).toBe('en-IE');
    expect(localeByCurrency.GBP).toBe('en-GB');
    expect(localeByCurrency.AED).toBe('en-AE');
    expect(localeByCurrency.SGD).toBe('en-SG');
    expect(localeByCurrency.AUD).toBe('en-AU');
    expect(localeByCurrency.CAD).toBe('en-CA');
  });
});

describe('formatMoney — INR formatting (gap card acceptance)', () => {
  test('formatMoney(310, "INR", "en-IN") → "₹310.00" (verbatim acceptance)', () => {
    expect(formatMoney(310, 'INR', 'en-IN')).toBe('₹310.00');
  });

  test('zero amount renders with rupee symbol + 2dp', () => {
    expect(formatMoney(0, 'INR', 'en-IN')).toBe('₹0.00');
  });

  test('negative INR uses leading minus before symbol', () => {
    // Anti-regression: the symbol-before-minus form (e.g. '₹-500.00')
    // would break checkout displays. Intl renders '-₹500.00'.
    expect(formatMoney(-500, 'INR', 'en-IN')).toBe('-₹500.00');
  });

  test('large INR uses Indian comma grouping (lakh/crore segmentation)', () => {
    // Indian numbering: 12,34,567 — NOT 1,234,567.
    expect(formatMoney(1234567.89, 'INR', 'en-IN')).toBe('₹12,34,567.89');
  });

  test('INR defaults to en-IN locale when locale is omitted', () => {
    expect(formatMoney(123.456789, 'INR')).toBe('₹123.46');
  });
});

describe('formatMoney — USD formatting (gap card acceptance)', () => {
  test('formatMoney(3.73, "USD", "en-US") → "$3.73" (verbatim acceptance)', () => {
    expect(formatMoney(3.73, 'USD', 'en-US')).toBe('$3.73');
  });

  test('USD with decimal padding (whole number)', () => {
    expect(formatMoney(50, 'USD', 'en-US')).toBe('$50.00');
  });

  test('large USD uses western thousands grouping', () => {
    expect(formatMoney(1234567.89, 'USD', 'en-US')).toBe('$1,234,567.89');
  });
});

describe('formatMoney — sub-paise rounding to 2dp (gap card acceptance)', () => {
  test('formatMoney(123.456789, "INR") → "₹123.46" (verbatim acceptance)', () => {
    expect(formatMoney(123.456789, 'INR')).toBe('₹123.46');
  });

  test('rounding above .5 → up (1.235 → 1.24 under banker rounding)', () => {
    // Intl.NumberFormat uses half-even (banker) rounding by default.
    // 1.235 rounds to 1.24 because the fp representation of 1.235 is
    // slightly above 1.235.
    expect(formatMoney(1.235, 'INR', 'en-IN')).toBe('₹1.24');
  });

  test('rounding below .5 → down', () => {
    expect(formatMoney(1.234, 'INR', 'en-IN')).toBe('₹1.23');
  });

  test('rounding exactly .5 (above) → up to even', () => {
    // 1.245 → 1.25 (the fp encoding lands above 1.245).
    expect(formatMoney(1.245, 'INR', 'en-IN')).toBe('₹1.25');
  });
});

describe('formatMoney — symbol absence (#286 / #330 anti-regression)', () => {
  // The reported bug: `$` showing up on a wellness/INR tenant.
  // For every non-USD currency the formatter MUST NOT emit '$'.

  test('INR output never contains $ (the #286/#330 regression)', () => {
    expect(formatMoney(1000, 'INR', 'en-IN')).not.toContain('$');
    expect(formatMoney(0, 'INR', 'en-IN')).not.toContain('$');
    expect(formatMoney(-1234.56, 'INR', 'en-IN')).not.toContain('$');
    expect(formatMoney(1234567.89, 'INR', 'en-IN')).not.toContain('$');
  });

  test('EUR output contains € and never $', () => {
    const out = formatMoney(99.99, 'EUR', 'en-IE');
    expect(out).toContain('€');
    expect(out).not.toContain('$');
    expect(out).not.toContain('₹');
  });

  test('GBP output contains £ and never $', () => {
    const out = formatMoney(50, 'GBP', 'en-GB');
    expect(out).toContain('£');
    expect(out).not.toContain('$');
    expect(out).not.toContain('₹');
  });

  test('never produces double currency symbols ($ ₹ or ₹ $)', () => {
    // Anti-regression: a previous bug concatenated the helper's output
    // with a hardcoded `$${amount}` upstream, producing '$ ₹310.00'.
    // The HELPER itself never emits more than one symbol.
    const inr = formatMoney(310, 'INR', 'en-IN');
    expect(inr.match(/[₹$£€]/g)).toHaveLength(1);

    const usd = formatMoney(3.73, 'USD', 'en-US');
    expect(usd.match(/[₹$£€]/g)).toHaveLength(1);

    const eur = formatMoney(100, 'EUR', 'en-IE');
    expect(eur.match(/[₹$£€]/g)).toHaveLength(1);
  });
});

describe('formatMoney — locale variation for same currency', () => {
  test('en-IN vs en-US group USD differently when forced', () => {
    // USD in en-IN locale uses Indian grouping for the digits, NOT US
    // grouping. This verifies that LOCALE drives grouping, while
    // CURRENCY drives the symbol — the two are independent inputs.
    const inUS = formatMoney(1234567.89, 'USD', 'en-US');
    const inIN = formatMoney(1234567.89, 'USD', 'en-IN');
    expect(inUS).toBe('$1,234,567.89');
    // en-IN locale + USD currency → Indian grouping with $ symbol.
    expect(inIN).toContain('$');
    expect(inIN).toContain('12,34,567');
  });
});

describe('formatMoney — non-finite & string input (graceful degrade)', () => {
  test('NaN → em-dash placeholder', () => {
    expect(formatMoney(NaN)).toBe('—');
  });

  test('Infinity → em-dash placeholder', () => {
    expect(formatMoney(Infinity)).toBe('—');
    expect(formatMoney(-Infinity)).toBe('—');
  });

  test('undefined → em-dash placeholder (Number(undefined) is NaN)', () => {
    expect(formatMoney(undefined)).toBe('—');
  });

  test('numeric string is parsed via Number()', () => {
    expect(formatMoney('1234.5', 'USD', 'en-US')).toBe('$1,234.50');
  });
});

describe('formatMoney — back-compat: options-object signature', () => {
  test('accepts opts object as 2nd arg (matches frontend money.js shape)', () => {
    expect(formatMoney(99.99, { currency: 'EUR', locale: 'en-IE' })).toBe('€99.99');
  });

  test('opts.currency overrides default USD', () => {
    expect(formatMoney(310, { currency: 'INR' })).toBe('₹310.00');
  });

  test('positional and opts-object signatures yield identical output', () => {
    const positional = formatMoney(1234.5, 'INR', 'en-IN');
    const optsObject = formatMoney(1234.5, { currency: 'INR', locale: 'en-IN' });
    expect(positional).toBe(optsObject);
  });
});

describe('currencySymbol — per-currency symbol lookup', () => {
  test('returns ₹ for INR', () => {
    expect(currencySymbol('INR', 'en-IN')).toBe('₹');
  });

  test('returns $ for USD', () => {
    expect(currencySymbol('USD', 'en-US')).toBe('$');
  });

  test('returns € for EUR', () => {
    expect(currencySymbol('EUR', 'en-IE')).toBe('€');
  });

  test('returns £ for GBP', () => {
    expect(currencySymbol('GBP', 'en-GB')).toBe('£');
  });

  test('falls back to currency code on invalid input', () => {
    // Invalid currency codes throw inside Intl; the helper catches and
    // returns the code itself. Defends the PDF/email render path
    // against bad-data crashes.
    expect(currencySymbol('NOT_A_CURRENCY')).toBe('NOT_A_CURRENCY');
  });
});
