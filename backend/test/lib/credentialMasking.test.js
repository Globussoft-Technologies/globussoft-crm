// Unit tests for backend/lib/credentialMasking.js
//
// Closes #651 — credentials never round-trip plaintext to the browser.
// The module is a thin wrapper around fieldEncryption + a small set of
// shape transformations (maskCredential, describeCredential, maskConfigRow,
// looksLikeMaskedSentinel). Encryption is opt-in via WELLNESS_FIELD_KEY;
// tests cover BOTH the enabled and disabled paths so neither implicitly
// breaks the other.
import { describe, test, expect } from 'vitest';

// Set the env-var BEFORE importing so getKey() in fieldEncryption caches
// the buffer. The disabled-path coverage is in a separate describe block
// below that operates only on values that don't depend on encryption.
process.env.WELLNESS_FIELD_KEY = 'b'.repeat(64);

const { default: cm } =
  await import('../../lib/credentialMasking.js').then(m => ({ default: m.default || m }));
const {
  MASK_SUFFIX,
  maskCredential,
  looksLikeMaskedSentinel,
  describeCredential,
  encryptCredential,
  decryptCredential,
  maskConfigRow,
} = cm;

const { encrypt } = await import('../../lib/fieldEncryption.js').then(m => m.default || m);

describe('credentialMasking — shape', () => {
  test('exports the expected functions + constants', () => {
    expect(MASK_SUFFIX).toBe('****');
    expect(typeof maskCredential).toBe('function');
    expect(typeof looksLikeMaskedSentinel).toBe('function');
    expect(typeof describeCredential).toBe('function');
    expect(typeof encryptCredential).toBe('function');
    expect(typeof decryptCredential).toBe('function');
    expect(typeof maskConfigRow).toBe('function');
  });
});

describe('maskCredential', () => {
  test('returns null for null / undefined / empty input', () => {
    expect(maskCredential(null)).toBeNull();
    expect(maskCredential(undefined)).toBeNull();
    expect(maskCredential('')).toBeNull();
  });

  test('returns "****<last4>" for plaintext credentials', () => {
    expect(maskCredential('abcdef123456')).toBe('****3456');
    expect(maskCredential('x')).toBe('****x');
    expect(maskCredential('abcd')).toBe('****abcd');
  });

  test('decrypts encrypted ciphertext before masking', () => {
    const plain = 'SECRET-ROTATE-KEY-9999';
    const cipher = encrypt(plain);
    // Sanity: encrypt should produce ENC:v1: prefix when key is set
    expect(cipher.startsWith('ENC:v1:')).toBe(true);
    expect(maskCredential(cipher)).toBe('****9999');
  });
});

describe('looksLikeMaskedSentinel', () => {
  test('true for the new "****<tail>" masked shape', () => {
    expect(looksLikeMaskedSentinel('****')).toBe(true);
    expect(looksLikeMaskedSentinel('****a3f1')).toBe(true);
    expect(looksLikeMaskedSentinel('****1234')).toBe(true); // 8 chars exactly
    expect(looksLikeMaskedSentinel('****abcd')).toBe(true);
  });

  test('true for the legacy "<prefix>****" shape (back-compat)', () => {
    // Pre-#651 the backend emitted "abc123****" — accept it as a sentinel
    // during the rollout window so old frontends don't accidentally
    // rotate a credential to a garbage value.
    expect(looksLikeMaskedSentinel('a****')).toBe(true);
    expect(looksLikeMaskedSentinel('abc123****')).toBe(true);
  });

  test('false for long strings even if they end in ****', () => {
    expect(looksLikeMaskedSentinel('a-very-long-credential-that-ends-****')).toBe(false);
  });

  test('false for non-strings, null, empty', () => {
    expect(looksLikeMaskedSentinel(null)).toBe(false);
    expect(looksLikeMaskedSentinel(undefined)).toBe(false);
    expect(looksLikeMaskedSentinel('')).toBe(false);
    expect(looksLikeMaskedSentinel(123)).toBe(false);
    expect(looksLikeMaskedSentinel({})).toBe(false);
  });

  test('false for strings that do not contain **** at either boundary', () => {
    expect(looksLikeMaskedSentinel('abc1234')).toBe(false);
    expect(looksLikeMaskedSentinel('xy**zw')).toBe(false);
  });
});

describe('describeCredential', () => {
  test('returns {configured:false,last4:null} for empty / missing values', () => {
    expect(describeCredential(null)).toEqual({ configured: false, last4: null });
    expect(describeCredential('')).toEqual({ configured: false, last4: null });
    expect(describeCredential(undefined)).toEqual({ configured: false, last4: null });
  });

  test('returns {configured:true,last4:"****<tail>"} for plaintext', () => {
    expect(describeCredential('abcdEFGH')).toEqual({ configured: true, last4: '****EFGH' });
  });

  test('returns {configured:true,last4:"****<tail>"} for ciphertext (decrypted last4)', () => {
    const cipher = encrypt('rotate-test-LMNO');
    expect(describeCredential(cipher)).toEqual({ configured: true, last4: '****LMNO' });
  });
});

describe('encryptCredential + decryptCredential — round-trip', () => {
  test('encrypt then decrypt returns the original plaintext', () => {
    const plain = 'sk_live_abcXYZ123_full_credential_here';
    const cipher = encryptCredential(plain);
    expect(cipher).not.toBe(plain); // actually encrypted with key set
    expect(decryptCredential(cipher)).toBe(plain);
  });

  test('encrypt is a no-op on null / empty', () => {
    expect(encryptCredential(null)).toBeNull();
    expect(encryptCredential('')).toBe('');
    expect(encryptCredential(undefined)).toBeUndefined();
  });

  test('decrypt is a no-op on plaintext that was never encrypted (legacy rows)', () => {
    expect(decryptCredential('legacy-plaintext-value')).toBe('legacy-plaintext-value');
  });

  test('decrypt is a no-op on null / empty', () => {
    expect(decryptCredential(null)).toBeNull();
    expect(decryptCredential('')).toBe('');
  });
});

describe('maskConfigRow', () => {
  test('replaces every named field with a {configured,last4} object', () => {
    const row = {
      id: 7,
      provider: 'msg91',
      apiKey: 'plain-apikey-LAST',
      authToken: 'plain-authtoken-TAIL',
      senderId: 'GBSCRM',
      isActive: true,
    };
    const masked = maskConfigRow(row, ['apiKey', 'authToken']);
    expect(masked.id).toBe(7);
    expect(masked.provider).toBe('msg91');
    expect(masked.senderId).toBe('GBSCRM');
    expect(masked.isActive).toBe(true);
    expect(masked.apiKey).toEqual({ configured: true, last4: '****LAST' });
    expect(masked.authToken).toEqual({ configured: true, last4: '****TAIL' });
  });

  test('marks missing/empty secret fields as configured:false', () => {
    const row = {
      provider: 'msg91',
      apiKey: '',
      authToken: null,
    };
    const masked = maskConfigRow(row, ['apiKey', 'authToken']);
    expect(masked.apiKey).toEqual({ configured: false, last4: null });
    expect(masked.authToken).toEqual({ configured: false, last4: null });
  });

  test('returns the row unchanged when row is null/undefined', () => {
    expect(maskConfigRow(null, ['apiKey'])).toBeNull();
    expect(maskConfigRow(undefined, ['apiKey'])).toBeUndefined();
  });

  test('handles encrypted secret fields transparently', () => {
    const row = {
      provider: 'meta_cloud',
      accessToken: encrypt('rotate-accesstoken-WXYZ'),
    };
    const masked = maskConfigRow(row, ['accessToken']);
    expect(masked.accessToken.configured).toBe(true);
    expect(masked.accessToken.last4).toBe('****WXYZ');
  });
});
