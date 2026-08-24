import { describe, expect, test } from 'vitest';
import {
  normalizeLoginHost,
  shouldSkipLoginAccountLimiter,
} from '../../lib/loginLimiterPolicy.js';

describe('normalizeLoginHost', () => {
  test('lowercases and strips ports from req.hostname', () => {
    expect(normalizeLoginHost({ hostname: 'CRM.GLOBUSDemos.com:443' })).toBe('crm.globusdemos.com');
  });

  test('falls back to the host header and unwraps bracketed IPv6 hosts', () => {
    expect(normalizeLoginHost({ headers: { host: '[::1]:5173' } })).toBe('::1');
  });
});

describe('shouldSkipLoginAccountLimiter', () => {
  test.each([
    ['crm.globusdemos.com', { hostname: 'crm.globusdemos.com' }],
    ['localhost', { headers: { host: 'localhost:3000' } }],
    ['127.0.0.1', { hostname: '127.0.0.1' }],
    ['::1', { headers: { host: '[::1]:3000' } }],
  ])('returns true for demo/local login host %s', (_host, req) => {
    expect(shouldSkipLoginAccountLimiter(req)).toBe(true);
  });

  test('returns false for an unrelated production host', () => {
    expect(
      shouldSkipLoginAccountLimiter({ hostname: 'crm.example.com' }),
    ).toBe(false);
  });
});
