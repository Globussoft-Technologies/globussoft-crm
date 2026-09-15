import { describe, it, expect } from 'vitest';
import { SOCIAL_NETWORKS, normalizeSocialUrl } from '../components/contact/contactProfileConfig';

describe('SOCIAL_NETWORKS', () => {
  it('exposes facebook, github and twitter entries with icon + key', () => {
    expect(SOCIAL_NETWORKS.map((n) => n.key)).toEqual(['facebookUrl', 'githubUrl', 'twitterUrl']);
    for (const n of SOCIAL_NETWORKS) {
      expect(typeof n.label).toBe('string');
      expect(typeof n.placeholder).toBe('string');
      expect(n.icon).toBeTruthy();
    }
  });
});

describe('normalizeSocialUrl', () => {
  it('returns null for empty input', () => {
    expect(normalizeSocialUrl('')).toBeNull();
    expect(normalizeSocialUrl('   ')).toBeNull();
    expect(normalizeSocialUrl(null)).toBeNull();
    expect(normalizeSocialUrl(undefined)).toBeNull();
  });

  it('keeps http(s) URLs as-is (trimmed)', () => {
    expect(normalizeSocialUrl('https://github.com/octocat')).toBe('https://github.com/octocat');
    expect(normalizeSocialUrl('  http://x.com/user  ')).toBe('http://x.com/user');
  });

  it('prepends https:// when no scheme is present', () => {
    expect(normalizeSocialUrl('github.com/octocat')).toBe('https://github.com/octocat');
    expect(normalizeSocialUrl('facebook.com/user')).toBe('https://facebook.com/user');
  });

  it('rejects non-http schemes', () => {
    expect(normalizeSocialUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeSocialUrl('ftp://files.example.com/x')).toBeNull();
  });
});
