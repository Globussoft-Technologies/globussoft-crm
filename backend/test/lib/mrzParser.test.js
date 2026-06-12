// @ts-check
/**
 * backend/lib/mrzParser.js — ICAO 9303 TD3 MRZ parser.
 *
 * Pure logic, so no OCR / image needed: we feed known MRZ strings and pin
 * field extraction + check-digit validation + date windowing. The canonical
 * fixture is the ICAO 9303 specimen (UTOPIA / Anna Maria Eriksson), whose
 * check digits are valid by construction.
 */
import { describe, test, expect } from 'vitest';
import {
  parseMrz, parseTd3, findMrzLines, computeCheckDigit, checkField, parseMrzDate, normalizeLine,
} from '../../lib/mrzParser.js';

// ICAO 9303 Appendix specimen — all check digits valid.
const L1 = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';
const L2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10';

describe('computeCheckDigit', () => {
  test('matches the published specimen check digits', () => {
    expect(computeCheckDigit('L898902C3')).toBe(6); // passport number
    expect(computeCheckDigit('740812')).toBe(2); // DOB
    expect(computeCheckDigit('120415')).toBe(9); // expiry
  });

  test('treats letters as 10-35 and < as 0', () => {
    // 'A'=10 with weight 7 → 70 → mod 10 = 0
    expect(computeCheckDigit('A')).toBe(0);
    expect(computeCheckDigit('<')).toBe(0);
  });
});

describe('checkField', () => {
  test('validates a field against its check char', () => {
    expect(checkField('L898902C3', '6')).toBe(true);
    expect(checkField('L898902C3', '5')).toBe(false);
  });
  test("treats a '<' check char as 0", () => {
    expect(checkField('<<<<<<', '<')).toBe(true); // all-filler → 0
  });
});

describe('parseMrzDate', () => {
  test('DOB in the future pivots to 19xx', () => {
    // pivot = 26 (i.e. "today" is 20xx, year 2026)
    expect(parseMrzDate('740812', 'dob', 26)).toBe('1974-08-12');
    expect(parseMrzDate('050101', 'dob', 26)).toBe('2005-01-01'); // 05 <= 26 → 2005
  });
  test('expiry uses the <70 → 20xx window', () => {
    expect(parseMrzDate('120415', 'expiry', 26)).toBe('2012-04-15');
    expect(parseMrzDate('300101', 'expiry', 26)).toBe('2030-01-01');
  });
  test('rejects structurally invalid dates', () => {
    expect(parseMrzDate('991399', 'expiry', 26)).toBeNull(); // month 13
    expect(parseMrzDate('abcdef', 'dob', 26)).toBeNull();
  });

  test('rejects calendar-impossible days (day-of-month + leap year)', () => {
    expect(parseMrzDate('740230', 'dob', 26)).toBeNull(); // Feb 30
    expect(parseMrzDate('740431', 'dob', 26)).toBeNull(); // Apr 31
    expect(parseMrzDate('740229', 'dob', 26)).toBeNull(); // Feb 29 in non-leap 1974
    expect(parseMrzDate('000229', 'dob', 26)).toBe('2000-02-29'); // 2000 IS a leap year
    expect(parseMrzDate('240229', 'expiry', 26)).toBe('2024-02-29'); // 2024 leap
  });
});

describe('parseTd3 — canonical specimen', () => {
  const r = parseTd3(L1, L2, 26);

  test('all core check digits pass → valid', () => {
    expect(r.valid).toBe(true);
    expect(r.checks.passportNumber).toBe(true);
    expect(r.checks.dateOfBirth).toBe(true);
    expect(r.checks.dateOfExpiry).toBe(true);
    expect(r.checks.composite).toBe(true);
  });

  test('extracts the visual + MRZ fields correctly', () => {
    expect(r.fields.passportNumber).toBe('L898902C3');
    expect(r.fields.surname).toBe('ERIKSSON');
    expect(r.fields.givenNames).toBe('ANNA MARIA');
    expect(r.fields.nationality).toBe('UTO');
    expect(r.fields.issuingCountry).toBe('UTO');
    expect(r.fields.dateOfBirth).toBe('1974-08-12');
    expect(r.fields.sex).toBe('F');
    expect(r.fields.dateOfExpiry).toBe('2012-04-15');
    expect(r.mrz).toBe(`${L1}\n${L2}`);
  });
});

describe('parseTd3 — corrupted check digit', () => {
  test('still parses fields but flags invalid', () => {
    const badL2 = `L898902C35UTO7408122F1204159ZE184226B<<<<<10`; // number check 6→5
    const r = parseTd3(L1, badL2, 26);
    expect(r.valid).toBe(false);
    expect(r.checks.passportNumber).toBe(false);
    // Field still extracted (operator can correct via Edit & approve).
    expect(r.fields.passportNumber).toBe('L898902C3');
  });
});

describe('findMrzLines / parseMrz — within noisy OCR text', () => {
  test('locates the MRZ pair amid visual-zone OCR noise', () => {
    const noisy = [
      'UNITED ARAB EMIRATES',
      'Type P  Country Code ARE',
      'Names HUDA BIN NASSER',
      L1,
      L2,
      'MINISTRY OF INTERIOR',
    ].join('\n');
    const pair = findMrzLines(noisy);
    expect(pair).not.toBeNull();
    expect(pair.line1.startsWith('P<UTO')).toBe(true);

    const parsed = parseMrz(noisy, { nowYearLast2: 26 });
    expect(parsed.fields.passportNumber).toBe('L898902C3');
    expect(parsed.valid).toBe(true);
  });

  test('returns null when there is no MRZ-like content', () => {
    expect(parseMrz('just some words with no machine readable zone', { nowYearLast2: 26 })).toBeNull();
    expect(parseMrz('', {})).toBeNull();
  });

  test('maps name vs data line by structure even when the data line OCRs first', () => {
    // Data line appears BEFORE the name line in the OCR text — the parser must
    // still assign line1=name, line2=data (review fix: identify by structure,
    // not source order).
    const swapped = `${L2}\n${L1}`;
    const parsed = parseMrz(swapped, { nowYearLast2: 26 });
    expect(parsed).not.toBeNull();
    expect(parsed.fields.passportNumber).toBe('L898902C3');
    expect(parsed.fields.surname).toBe('ERIKSSON');
    expect(parsed.valid).toBe(true);
  });
});

describe('normalizeLine', () => {
  test('uppercases, strips spaces, and keeps only the MRZ alphabet', () => {
    expect(normalizeLine('  l898902c3 6uto ')).toBe('L898902C36UTO');
    expect(normalizeLine('p<uto!@#')).toBe('P<UTO');
  });
});
