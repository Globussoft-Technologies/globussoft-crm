import { afterEach, describe, expect, test } from 'vitest';
import encryption from '../../lib/travelHostingCredentialEncryption.js';

const {
  encryptTravelHostingCredential,
  decryptTravelHostingCredential,
  isEncrypted,
} = encryption;

const originalKey = process.env.TRAVEL_HOSTING_CREDENTIAL_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.TRAVEL_HOSTING_CREDENTIAL_KEY;
  else process.env.TRAVEL_HOSTING_CREDENTIAL_KEY = originalKey;
});

describe('travel hosting credential encryption', () => {
  test('encrypts and authenticates the complete credential payload', () => {
    process.env.TRAVEL_HOSTING_CREDENTIAL_KEY = 'd'.repeat(64);
    const plaintext = JSON.stringify({ host: 'sftp.example.com', password: 'secret' });
    const encrypted = encryptTravelHostingCredential(plaintext);

    expect(isEncrypted(encrypted)).toBe(true);
    expect(encrypted).not.toContain('secret');
    expect(decryptTravelHostingCredential(encrypted)).toBe(plaintext);
  });

  test('fails closed when the dedicated key is missing', () => {
    delete process.env.TRAVEL_HOSTING_CREDENTIAL_KEY;
    expect(() => encryptTravelHostingCredential('{"password":"secret"}')).toThrow(/must be configured/i);
  });

  test('refuses legacy plaintext values', () => {
    process.env.TRAVEL_HOSTING_CREDENTIAL_KEY = 'd'.repeat(64);
    expect(() => decryptTravelHostingCredential('{"password":"secret"}')).toThrow(/not encrypted/i);
  });

  test('rejects ciphertext modified after storage', () => {
    process.env.TRAVEL_HOSTING_CREDENTIAL_KEY = 'd'.repeat(64);
    const encrypted = encryptTravelHostingCredential('{"password":"secret"}');
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('0') ? '1' : '0'}`;
    expect(() => decryptTravelHostingCredential(tampered)).toThrow();
  });
});
