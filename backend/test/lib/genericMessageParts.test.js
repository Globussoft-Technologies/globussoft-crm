import { describe, expect, test } from 'vitest';
import {
  GENERIC_SMS_MESSAGE_LIMIT,
  GENERIC_WHATSAPP_MESSAGE_LIMIT,
  splitGenericMessage,
} from '../../lib/genericMessageParts.js';

describe('Generic CRM message parts', () => {
  test('keeps messages at the channel limit in one part', () => {
    expect(splitGenericMessage('S'.repeat(GENERIC_SMS_MESSAGE_LIMIT), GENERIC_SMS_MESSAGE_LIMIT)).toEqual(['S'.repeat(150)]);
    expect(splitGenericMessage('W'.repeat(GENERIC_WHATSAPP_MESSAGE_LIMIT), GENERIC_WHATSAPP_MESSAGE_LIMIT)).toEqual(['W'.repeat(250)]);
  });

  test('splits overflow into separate parts without exceeding the limit', () => {
    const parts = splitGenericMessage(`${'word '.repeat(70)}finished`, GENERIC_SMS_MESSAGE_LIMIT);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.length <= GENERIC_SMS_MESSAGE_LIMIT)).toBe(true);
    expect(parts.join('')).toBe(`${'word '.repeat(70)}finished`);
  });

  test('hard-splits a token that is longer than the configured limit', () => {
    expect(splitGenericMessage('x'.repeat(301), GENERIC_SMS_MESSAGE_LIMIT).map(part => part.length)).toEqual([150, 150, 1]);
  });

  test('never separates surrogate pairs or combining characters', () => {
    for (const suffix of ['😀', 'e\u0301', '👩‍💻']) {
      const text = 'x'.repeat(149) + suffix;
      const parts = splitGenericMessage(text, 150);
      expect(parts.join('')).toBe(text);
      expect(parts.every(part => part.isWellFormed() && part.length <= 150)).toBe(true);
      expect(parts.at(-1)).toBe(suffix);
    }
  });

  test('keeps URLs intact at a split boundary, including long signed links', () => {
    const url = 'https://example.com/select?token=abcdef';
    const text = 'x'.repeat(240) + url;
    const parts = splitGenericMessage(text, 250);
    expect(parts).toEqual(['x'.repeat(240), url]);
    expect(parts.join('')).toBe(text);
    const longUrl = 'https://example.com/' + 'x'.repeat(200);
    expect(splitGenericMessage('Before ' + longUrl + ' after', 150)).toEqual(['Before ', longUrl, ' after']);
  });
});
