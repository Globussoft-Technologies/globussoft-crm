// @ts-check
import { describe, test, expect } from 'vitest';
import { parsePaddleOutput } from '../../lib/paddleOcrRunner.js';

describe('paddleOcrRunner parsePaddleOutput', () => {
  test('extracts Paddle rec_texts and averages confidence', () => {
    const stdout = JSON.stringify({
      result: {
        rec_texts: [
          'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
          'L898902C36UTO7408122F1204159ZE184226B<<<<<10',
          'Passport No L898902C3',
        ],
        rec_scores: [0.98, 0.97, 0.93],
      },
    });

    const parsed = parsePaddleOutput(stdout);

    expect(parsed.text).toContain('P<UTOERIKSSON');
    expect(parsed.text).toContain('Passport No L898902C3');
    expect(parsed.confidence).toBeGreaterThan(0.9);
  });

  test('falls back to plain text lines when output is not JSON', () => {
    const parsed = parsePaddleOutput('Passport No P1234567\nDate of Birth 01/01/1990');
    expect(parsed.text).toContain('Passport No P1234567');
    expect(parsed.confidence).toBeNull();
  });
});
