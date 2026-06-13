// @ts-check
/**
 * intakePayloadValidators — G014 unit-test surface
 * (PRD_TRAVEL_MULTICHANNEL_LEADS §3.1.4 + lib/intakePayloadValidators.js).
 *
 * Pure-function tests for the per-channel typed payload validators.
 * Mirrors the inboundLeadVerification.test.js shape: import the helper,
 * exercise every channel's happy / missing / wrong-shape branches,
 * assert the (valid, errors[]) return contract.
 *
 * Contracts pinned:
 *   - canonicaliseChannel: webform→web_form, metaads/metaad→meta_ad
 *   - validateForChannel: dispatches to the right validator + universal
 *     fallback on unknown channel
 *   - Per-channel validators each cover happy-path + ALL missing-field
 *     branches the route depends on
 *   - Returns shape: { valid: boolean, errors: [{field, message}, …] }
 */

import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  validateForChannel,
  canonicaliseChannel,
  validateVoice,
  validateSms,
  validateEmail,
  validateWebForm,
  validateReferral,
  validateChat,
  validateManual,
  validateMarketplaceLike,
  validateAdGeneric,
  requireEmailOrPhone,
} = requireCJS('../../lib/intakePayloadValidators');

describe('canonicaliseChannel — G004 alias map', () => {
  test('webform → web_form', () => {
    expect(canonicaliseChannel('webform')).toBe('web_form');
  });

  test('metaads → meta_ad', () => {
    expect(canonicaliseChannel('metaads')).toBe('meta_ad');
  });

  test('metaad → meta_ad', () => {
    expect(canonicaliseChannel('metaad')).toBe('meta_ad');
  });

  test('canonical names pass through unchanged', () => {
    expect(canonicaliseChannel('voice')).toBe('voice');
    expect(canonicaliseChannel('web_form')).toBe('web_form');
    expect(canonicaliseChannel('meta_ad')).toBe('meta_ad');
    expect(canonicaliseChannel('voyagr')).toBe('voyagr');
  });

  test('null / undefined / empty string → null', () => {
    expect(canonicaliseChannel(null)).toBeNull();
    expect(canonicaliseChannel(undefined)).toBeNull();
    expect(canonicaliseChannel('')).toBeNull();
    expect(canonicaliseChannel('   ')).toBeNull();
  });

  test('whitespace trimmed before lookup', () => {
    expect(canonicaliseChannel(' webform ')).toBe('web_form');
  });

  test('non-string input → null', () => {
    expect(canonicaliseChannel(42)).toBeNull();
    expect(canonicaliseChannel({})).toBeNull();
  });
});

describe('requireEmailOrPhone — universal contact assertion', () => {
  test('email present → no error', () => {
    expect(requireEmailOrPhone({ email: 'a@b.com' })).toEqual([]);
  });

  test('phone present → no error', () => {
    expect(requireEmailOrPhone({ phone: '+91999' })).toEqual([]);
  });

  test('both empty / missing → single error on email|phone field', () => {
    const errors = requireEmailOrPhone({});
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('email|phone');
  });

  test('whitespace-only counts as missing', () => {
    const errors = requireEmailOrPhone({ email: '   ', phone: '   ' });
    expect(errors).toHaveLength(1);
  });
});

describe('validateVoice — G013 voice channel', () => {
  test('happy path → valid', () => {
    const r = validateVoice({
      callId: 'call_abc123',
      direction: 'inbound',
      phone: '+919876543210',
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('missing callId → error on callId field', () => {
    const r = validateVoice({ direction: 'inbound', phone: '+91' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'callId')).toBe(true);
  });

  test('missing direction → error on direction field', () => {
    const r = validateVoice({ callId: 'x', phone: '+91' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'direction')).toBe(true);
  });

  test('invalid direction → error', () => {
    const r = validateVoice({ callId: 'x', direction: 'sideways', phone: '+91' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'direction')).toBe(true);
  });

  test('missing phone (email-only) → error (voice requires phone)', () => {
    const r = validateVoice({ callId: 'x', direction: 'inbound', email: 'a@b.com' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'phone')).toBe(true);
  });

  test('body non-object → single _body error', () => {
    const r = validateVoice(null);
    expect(r.valid).toBe(false);
    expect(r.errors[0].field).toBe('_body');
  });

  test('outbound direction accepted', () => {
    const r = validateVoice({
      callId: 'call_x',
      direction: 'outbound',
      phone: '+91',
    });
    expect(r.valid).toBe(true);
  });
});

describe('validateSms — G004 SMS channel', () => {
  test('happy path with from + body → valid', () => {
    const r = validateSms({ from: '+91', body: 'I want a Mecca tour' });
    expect(r.valid).toBe(true);
  });

  test('from absent but phone field set → from-equivalent accepted', () => {
    const r = validateSms({ phone: '+91', body: 'hello' });
    expect(r.valid).toBe(true);
  });

  test('missing from AND phone → error on from field', () => {
    const r = validateSms({ body: 'hello' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'from')).toBe(true);
  });

  test('missing body → error on body field', () => {
    const r = validateSms({ from: '+91' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'body')).toBe(true);
  });
});

describe('validateEmail — G004 inbound email channel', () => {
  test('happy path with email + subject → valid', () => {
    const r = validateEmail({ email: 'a@b.com', subject: 'Quote please' });
    expect(r.valid).toBe(true);
  });

  test('missing email → error', () => {
    const r = validateEmail({ subject: 'x' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'email')).toBe(true);
  });

  test('missing subject → error', () => {
    const r = validateEmail({ email: 'a@b.com' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'subject')).toBe(true);
  });
});

describe('validateWebForm — G004 canonical web_form', () => {
  test('email-only → valid', () => {
    const r = validateWebForm({ email: 'a@b.com' });
    expect(r.valid).toBe(true);
  });

  test('phone-only → valid', () => {
    const r = validateWebForm({ phone: '+91' });
    expect(r.valid).toBe(true);
  });

  test('neither → invalid', () => {
    const r = validateWebForm({});
    expect(r.valid).toBe(false);
  });
});

describe('validateReferral — G012 referral channel', () => {
  test('happy path with referrerContactId + email → valid', () => {
    const r = validateReferral({
      referrerContactId: 42,
      email: 'referee@example.com',
    });
    expect(r.valid).toBe(true);
  });

  test('missing referrerContactId → error', () => {
    const r = validateReferral({ email: 'r@example.com' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'referrerContactId')).toBe(true);
  });

  test('non-integer referrerContactId → error', () => {
    const r = validateReferral({
      referrerContactId: 'not-a-number',
      phone: '+91',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'referrerContactId')).toBe(true);
  });

  test('missing email AND phone but referrerContactId present → still invalid (universal check)', () => {
    const r = validateReferral({ referrerContactId: 42 });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'email|phone')).toBe(true);
  });
});

describe('validateChat / validateManual / validateMarketplaceLike — universal-only validators', () => {
  test('chat: email present → valid', () => {
    expect(validateChat({ email: 'a@b.com' }).valid).toBe(true);
  });

  test('chat: empty → invalid (universal email-or-phone)', () => {
    expect(validateChat({}).valid).toBe(false);
  });

  test('manual: phone present → valid', () => {
    expect(validateManual({ phone: '+91' }).valid).toBe(true);
  });

  test('marketplaceLike: email present → valid', () => {
    expect(validateMarketplaceLike({ email: 'a@b.com' }).valid).toBe(true);
  });

  test('adGeneric: phone present → valid', () => {
    expect(validateAdGeneric({ phone: '+91' }).valid).toBe(true);
  });
});

describe('validateForChannel — dispatcher', () => {
  test('voice channel routes to validateVoice', () => {
    const r = validateForChannel('voice', { phone: '+91' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'callId')).toBe(true);
  });

  test('alias webform → web_form validator → universal check passes', () => {
    const r = validateForChannel('webform', { email: 'a@b.com' });
    expect(r.valid).toBe(true);
  });

  test('alias metaads → meta_ad validator', () => {
    const r = validateForChannel('metaads', { email: 'a@b.com' });
    expect(r.valid).toBe(true);
  });

  test('unknown channel → universal fallback', () => {
    const r = validateForChannel('quantum-fax', { email: 'a@b.com' });
    expect(r.valid).toBe(true);
  });

  test('unknown channel + no contact → fallback returns universal error', () => {
    const r = validateForChannel('quantum-fax', {});
    expect(r.valid).toBe(false);
  });

  test('null channel → universal fallback', () => {
    const r = validateForChannel(null, { phone: '+91' });
    expect(r.valid).toBe(true);
  });

  test('sms canonical channel routes correctly', () => {
    const r = validateForChannel('sms', { from: '+91', body: 'hi' });
    expect(r.valid).toBe(true);
  });

  test('email canonical channel routes correctly', () => {
    const r = validateForChannel('email', { email: 'a@b.com', subject: 'x' });
    expect(r.valid).toBe(true);
  });

  test('referral channel without referrerContactId fails', () => {
    const r = validateForChannel('referral', { email: 'a@b.com' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'referrerContactId')).toBe(true);
  });
});
