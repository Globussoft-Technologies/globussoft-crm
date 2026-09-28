import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  cleanDomains,
  validSyntax,
  validateEmail,
  clearMxCache,
} = requireCJS('../../lib/webFormEmailValidation');

beforeEach(() => {
  clearMxCache();
});

describe('web form email validation', () => {
  test('normalizes and de-duplicates configured domains', () => {
    expect(cleanDomains([' @Example.COM. ', 'example.com', 'invalid'])).toEqual(['example.com']);
  });

  test.each(['missing-at.example.com', 'a..b@example.com', 'a@example'])('rejects invalid syntax: %s', async (email) => {
    expect(validSyntax(email)).toBe(false);
    await expect(validateEmail(email, {})).resolves.toMatchObject({
      valid: false,
      code: 'INVALID_EMAIL',
    });
  });

  test('enforces allowed and blocked company-domain settings', async () => {
    await expect(validateEmail('person@other.com', {
      allowedEmailDomains: ['example.com'],
    })).resolves.toMatchObject({ valid: false, code: 'EMAIL_DOMAIN_NOT_ALLOWED' });

    await expect(validateEmail('person@gmail.com', {
      emailValidationType: 'company',
      blockedEmailDomains: ['gmail.com'],
    })).resolves.toMatchObject({ valid: false, code: 'PERSONAL_EMAIL_BLOCKED' });
  });

  test('accepts an MX-backed domain and caches repeated lookups', async () => {
    const resolveMx = vi.fn().mockResolvedValue([{ exchange: 'mail.example.com', priority: 10 }]);
    const settings = { emailMxValidation: true };

    await expect(validateEmail('one@example.com', settings, { resolveMx })).resolves.toEqual({
      valid: true,
      domain: 'example.com',
    });
    await expect(validateEmail('two@example.com', settings, { resolveMx })).resolves.toEqual({
      valid: true,
      domain: 'example.com',
    });
    expect(resolveMx).toHaveBeenCalledTimes(1);
  });

  test('rejects missing MX records and bounds slow DNS lookups', async () => {
    const noMx = vi.fn().mockResolvedValue([]);
    await expect(validateEmail('one@no-mail.example', { emailMxValidation: true }, { resolveMx: noMx }))
      .resolves.toMatchObject({ valid: false, code: 'EMAIL_MX_INVALID' });

    clearMxCache();
    const neverResolves = vi.fn(() => new Promise(() => {}));
    await expect(validateEmail('one@slow.example', { emailMxValidation: true }, {
      resolveMx: neverResolves,
      timeoutMs: 5,
    })).resolves.toMatchObject({ valid: false, code: 'EMAIL_MX_INVALID' });
  });
});
