/**
 * Unit tests for backend/lib/landingPath.js — Role.landingPath validation
 * + normalisation. Same regex/length contract is mirrored client-side in
 * RolesAdmin.jsx (validateLandingPathClient); if you change the rules
 * here, update the frontend mirror too.
 */

import { describe, it, expect } from 'vitest';
import { validateLandingPath, normalizeLandingPath } from '../../lib/landingPath.js';

describe('validateLandingPath', () => {
  describe('null/empty cases', () => {
    it('accepts null', () => {
      expect(validateLandingPath(null)).toBeNull();
    });

    it('accepts undefined', () => {
      expect(validateLandingPath(undefined)).toBeNull();
    });

    it('accepts empty string (means: use vertical default)', () => {
      expect(validateLandingPath('')).toBeNull();
    });
  });

  describe('happy paths', () => {
    it('accepts a simple root path', () => {
      expect(validateLandingPath('/home')).toBeNull();
    });

    it('accepts nested routes', () => {
      expect(validateLandingPath('/wellness/calendar')).toBeNull();
      expect(validateLandingPath('/wellness/telecaller')).toBeNull();
      expect(validateLandingPath('/portal')).toBeNull();
    });

    it('accepts paths with query strings', () => {
      expect(validateLandingPath('/wellness/reports?tab=pnl')).toBeNull();
      expect(validateLandingPath('/dashboard?view=kpi&range=7d')).toBeNull();
    });

    it('accepts paths with hyphens and underscores', () => {
      expect(validateLandingPath('/book-appointment')).toBeNull();
      expect(validateLandingPath('/some_underscored_path')).toBeNull();
    });
  });

  describe('rejected shapes (security)', () => {
    it('rejects non-string values', () => {
      expect(validateLandingPath(123)).toMatch(/must be a string/);
      expect(validateLandingPath({})).toMatch(/must be a string/);
      expect(validateLandingPath([])).toMatch(/must be a string/);
    });

    it('rejects absolute http URLs', () => {
      expect(validateLandingPath('http://evil.com/dashboard')).toMatch(
        /relative SPA path/,
      );
      expect(validateLandingPath('https://evil.com/dashboard')).toMatch(
        /relative SPA path/,
      );
    });

    it('rejects protocol-relative paths (//evil.com/x)', () => {
      // The // case is caught by the "starts with //" check first
      expect(validateLandingPath('//evil.com/x')).toMatch(/cannot start with/);
    });

    it('rejects paths missing leading slash', () => {
      expect(validateLandingPath('dashboard')).toMatch(/relative SPA path/);
      expect(validateLandingPath('home')).toMatch(/relative SPA path/);
    });

    it('rejects paths with whitespace', () => {
      expect(validateLandingPath('/wellness calendar')).toMatch(
        /relative SPA path/,
      );
    });

    it('rejects paths with quotes or angle brackets (XSS surface)', () => {
      expect(validateLandingPath('/x"onerror=alert(1)')).toMatch(
        /relative SPA path/,
      );
      expect(validateLandingPath('/<script>')).toMatch(/relative SPA path/);
    });

    it('rejects paths longer than 200 chars', () => {
      const long = '/' + 'a'.repeat(201);
      expect(validateLandingPath(long)).toMatch(/too long/);
    });

    it('accepts exactly 200 chars (boundary)', () => {
      const max = '/' + 'a'.repeat(199);
      expect(max.length).toBe(200);
      expect(validateLandingPath(max)).toBeNull();
    });
  });
});

describe('normalizeLandingPath', () => {
  it('returns null for null/undefined/empty', () => {
    expect(normalizeLandingPath(null)).toBeNull();
    expect(normalizeLandingPath(undefined)).toBeNull();
    expect(normalizeLandingPath('')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeLandingPath('  /home  ')).toBe('/home');
    expect(normalizeLandingPath('\t/wellness/calendar\n')).toBe(
      '/wellness/calendar',
    );
  });

  it('collapses whitespace-only string to null', () => {
    expect(normalizeLandingPath('   ')).toBeNull();
    expect(normalizeLandingPath('\t\n')).toBeNull();
  });

  it('coerces non-strings to string then trims', () => {
    expect(normalizeLandingPath(42)).toBe('42');
  });
});
