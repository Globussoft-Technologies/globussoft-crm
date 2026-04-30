// Unit tests for backend/lib/fieldEncryption.js
//
// The module reads WELLNESS_FIELD_KEY env once and caches the result. Because
// vitest runs all tests in this file in one process, we set a valid key
// BEFORE importing the SUT to lock in the "enabled" path. The "disabled"
// path is exercised in a child process via execSync to bypass the cache.
import { describe, test, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 32-byte (64 hex char) key — set BEFORE import so getKey() caches the buffer.
process.env.WELLNESS_FIELD_KEY = 'a'.repeat(64);

// fieldEncryption is a CJS module — vitest's ESM bridge gives us the
// commonJS exports object as the default of the namespace.
const fieldEncryption = await import('../../lib/fieldEncryption.js');
const { encrypt, decrypt, isEncrypted } = fieldEncryption.default || fieldEncryption;

// Helper: spawn a child node process with a tmp script that exercises the
// fieldEncryption module fresh. Avoids polluting the in-process cache.
function runChild(scriptBody) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fe-'));
  const file = path.join(dir, 'probe.js');
  // Resolve fieldEncryption.js path relative to cwd (backend/)
  const sutPath = path.resolve(process.cwd(), 'lib/fieldEncryption.js').replace(/\\/g, '/');
  const wrapped = scriptBody.replace('__SUT__', JSON.stringify(sutPath));
  writeFileSync(file, wrapped, 'utf8');
  try {
    return execSync(`node "${file}"`, { encoding: 'utf8' });
  } finally {
    try { unlinkSync(file); } catch (_) {}
  }
}

describe('lib/fieldEncryption — module shape', () => {
  test('exports encrypt, decrypt, isEncrypted', () => {
    expect(typeof encrypt).toBe('function');
    expect(typeof decrypt).toBe('function');
    expect(typeof isEncrypted).toBe('function');
  });
});

describe('lib/fieldEncryption — isEncrypted', () => {
  test('detects ENC:v1: prefix', () => {
    expect(isEncrypted('ENC:v1:abc:def:ghi')).toBe(true);
  });

  test('rejects plain strings', () => {
    expect(isEncrypted('hello')).toBe(false);
    expect(isEncrypted('plain text content')).toBe(false);
  });

  test('rejects null/undefined/non-string', () => {
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted(123)).toBe(false);
    expect(isEncrypted({})).toBe(false);
    expect(isEncrypted([])).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isEncrypted('')).toBe(false);
  });

  test('rejects partial prefix matches', () => {
    expect(isEncrypted('ENC:')).toBe(false);
    expect(isEncrypted('ENC:v2:foo')).toBe(false);
  });
});

describe('lib/fieldEncryption — encrypt', () => {
  test('returns null/empty unchanged', () => {
    expect(encrypt(null)).toBeNull();
    expect(encrypt('')).toBe('');
    expect(encrypt(undefined)).toBeUndefined();
  });

  test('encrypts plaintext to ENC:v1: format', () => {
    const out = encrypt('Patient is allergic to penicillin');
    expect(out).toMatch(/^ENC:v1:[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/);
  });

  test('produces different ciphertext for same plaintext (random IV)', () => {
    const a = encrypt('hello world');
    const b = encrypt('hello world');
    expect(a).not.toBe(b);
  });

  test('does not re-encrypt already-encrypted values', () => {
    const once = encrypt('secret');
    const twice = encrypt(once);
    expect(twice).toBe(once);
  });

  test('JSON-stringifies non-string inputs', () => {
    const out = encrypt({ x: 1 });
    expect(isEncrypted(out)).toBe(true);
    expect(decrypt(out)).toBe('{"x":1}');
  });

  test('handles numbers via JSON.stringify', () => {
    const out = encrypt(42);
    expect(isEncrypted(out)).toBe(true);
    expect(decrypt(out)).toBe('42');
  });
});

describe('lib/fieldEncryption — decrypt', () => {
  test('returns plaintext unchanged when input not encrypted', () => {
    expect(decrypt('plain string')).toBe('plain string');
    expect(decrypt(null)).toBeNull();
    expect(decrypt('')).toBe('');
    expect(decrypt(123)).toBe(123);
  });

  test('round-trips a basic ASCII string', () => {
    const cipher = encrypt('hello');
    expect(decrypt(cipher)).toBe('hello');
  });

  test('round-trips a long string', () => {
    const long = 'x'.repeat(5000);
    expect(decrypt(encrypt(long))).toBe(long);
  });

  test('round-trips Unicode (Devanagari + emoji)', () => {
    const text = 'नमस्ते दुनिया 🌍';
    expect(decrypt(encrypt(text))).toBe(text);
  });

  test('round-trips medical text with newlines', () => {
    const note = 'Allergies:\n- Penicillin\n- Latex\n\nHistory: prior surgery 2024.';
    expect(decrypt(encrypt(note))).toBe(note);
  });

  test('returns ciphertext unchanged when GCM tag mismatch (tampering)', () => {
    const c = encrypt('original');
    // Flip a hex char in the ciphertext segment
    const parts = c.split(':');
    const last = parts[parts.length - 1];
    const tampered = parts.slice(0, -1).join(':') + ':' + (last[0] === '0' ? '1' : '0') + last.slice(1);
    const out = decrypt(tampered);
    expect(out).toBe(tampered); // graceful fallback
  });

  test('returns ciphertext unchanged on malformed input', () => {
    const bad = 'ENC:v1:bad:format:notrealhex';
    const out = decrypt(bad);
    expect(out).toBe(bad);
  });
});

describe('lib/fieldEncryption — disabled path (no key)', () => {
  // Run a child node process with no WELLNESS_FIELD_KEY to exercise the
  // disabled / no-op branches. This is necessary because the module caches
  // the key on first read.
  test('encrypt is no-op when key missing', () => {
    const stdout = runChild(`
delete process.env.WELLNESS_FIELD_KEY;
const { encrypt, isEncrypted } = require(__SUT__);
const out = encrypt('hello');
console.log(JSON.stringify({ out, encrypted: isEncrypted(out) }));
`);
    const result = JSON.parse(stdout.trim());
    expect(result.out).toBe('hello');
    expect(result.encrypted).toBe(false);
  });

  test('decrypt of plaintext is no-op when key missing', () => {
    const stdout = runChild(`
delete process.env.WELLNESS_FIELD_KEY;
const { decrypt } = require(__SUT__);
console.log(decrypt('plaintext'));
`);
    expect(stdout.trim()).toBe('plaintext');
  });

  test('decrypt of ciphertext returns ciphertext unchanged when key missing', () => {
    const stdout = runChild(`
delete process.env.WELLNESS_FIELD_KEY;
const { decrypt } = require(__SUT__);
console.log(decrypt('ENC:v1:aa:bb:cc'));
`);
    expect(stdout.trim()).toBe('ENC:v1:aa:bb:cc');
  });

  test('disables when key has wrong length (warns + falls through)', () => {
    const stdout = runChild(`
process.env.WELLNESS_FIELD_KEY = 'tooshort';
const { encrypt } = require(__SUT__);
console.log(encrypt('hello'));
`);
    // Warning goes to stderr; stdout is just the (unencrypted) plaintext
    expect(stdout.trim()).toBe('hello');
  });
});
