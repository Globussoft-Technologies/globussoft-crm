import { describe, expect, test } from 'vitest';
import {
  normalizeLoginHost,
  shouldSkipLoginAccountLimiter,
  loginIpKey,
} from '../../lib/loginLimiterPolicy.js';

describe('normalizeLoginHost', () => {
  test('lowercases and strips ports from req.hostname', () => {
    expect(normalizeLoginHost({ hostname: 'CRM.GLOBUSDemos.com:443' })).toBe('crm.globusdemos.com');
  });

  test('falls back to the host header and unwraps bracketed IPv6 hosts', () => {
    expect(normalizeLoginHost({ headers: { host: '[::1]:5173' } })).toBe('::1');
  });
});

describe('loginIpKey', () => {
  test('keys IPv4 requests by their IP string, not by request-object identity', () => {
    expect(loginIpKey({ ip: '203.0.113.9' })).toBe('203.0.113.9');
    expect(loginIpKey({ ip: '203.0.113.9' })).toBe('203.0.113.9');
  });

  test('normalizes IPv6 addresses using express-rate-limit subnet semantics', () => {
    expect(loginIpKey({ ip: '2001:db8:abcd:1234::1' })).toBe('2001:db8:abcd:1200::/56');
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
