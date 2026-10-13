import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import {
  buildAllowedOrigins,
  isAllowedOrigin,
  normalizeOrigin,
  parseConfiguredOrigins,
} from '../../lib/corsOrigins.js';

let savedFrontendUrl;
let savedCorsAllowed;

beforeEach(() => {
  savedFrontendUrl = process.env.FRONTEND_URL;
  savedCorsAllowed = process.env.CORS_ALLOWED_ORIGINS;
  delete process.env.FRONTEND_URL;
  delete process.env.CORS_ALLOWED_ORIGINS;
});

afterEach(() => {
  if (savedFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = savedFrontendUrl;
  if (savedCorsAllowed === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = savedCorsAllowed;
});

describe('corsOrigins', () => {
  test('normalizes configured origins to scheme and host', () => {
    expect(normalizeOrigin(' HTTPS://New.Example.com/path/ ')).toBe('https://new.example.com');
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
  });

  test('parses CSV and JSON-array configuration', () => {
    expect(parseConfiguredOrigins('https://a.example.com, https://b.example.com')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
    expect(parseConfiguredOrigins('["https://a.example.com", "https://b.example.com"]')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  test('adds a future frontend domain without a code change', () => {
    process.env.FRONTEND_URL = 'https://new-crm.example.com/';
    process.env.CORS_ALLOWED_ORIGINS = 'https://partner.example.com';
    const origins = buildAllowedOrigins();
    expect(origins).toContain('https://new-crm.example.com');
    expect(origins).toContain('https://partner.example.com');
  });

  test('matches the current production origin after normalization', () => {
    expect(isAllowedOrigin('HTTPS://GLOBUSCRM.COM/path', [
      'https://globuscrm.com',
    ])).toBe(true);
    expect(isAllowedOrigin('https://attacker.example.com', [
      'https://globuscrm.com',
    ])).toBe(false);
  });
});
