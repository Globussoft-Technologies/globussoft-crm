// @ts-check
/**
 * backend/lib/passportVizParser.js — visual-zone (printed labels) parser.
 *
 * Pure logic, so we feed representative full-page OCR text and pin the
 * label-based field extraction + human date parsing + country→ISO3 mapping.
 * The primary fixture mirrors the real UAE specimen whose MRZ is malformed —
 * exactly the case the VIZ parser exists to rescue.
 */
import { describe, test, expect } from 'vitest';
import { parseViz, parseHumanDate, normalizeNationality } from '../../lib/passportVizParser.js';

// Representative VIZ OCR (labels + values), like the UAE specimen.
const VIZ_TEXT = [
  'UNITED ARAB EMIRATES',
  'Type P  Country Code ARE  Passport No P90S12345',
  'Names HUDA BIN NASSER',
  'Nationality United Arab Emirates',
  'Date of Birth 27/07/1987   Sex F',
  'Place of Birth DUBAI',
  'Date of Expiry 12/01/2021   Date of Issue 12/01/2016',
].join('\n');

describe('parseHumanDate', () => {
  test('DD/MM/YYYY (day-first)', () => {
    expect(parseHumanDate('27/07/1987')).toBe('1987-07-27');
    expect(parseHumanDate('12/01/2021')).toBe('2021-01-12');
  });
  test('other separators + month names', () => {
    expect(parseHumanDate('27-07-1987')).toBe('1987-07-27');
    expect(parseHumanDate('27.07.1987')).toBe('1987-07-27');
    expect(parseHumanDate('27 JUL 1987')).toBe('1987-07-27');
  });
  test('rejects junk + impossible dates', () => {
    expect(parseHumanDate('not a date')).toBeNull();
    expect(parseHumanDate('31/02/2020')).toBeNull(); // Feb 31
    expect(parseHumanDate('')).toBeNull();
  });
});

describe('normalizeNationality', () => {
  test('maps known country names to ISO-3', () => {
    expect(normalizeNationality('United Arab Emirates')).toBe('ARE');
    expect(normalizeNationality('INDIAN')).toBe('IND');
    expect(normalizeNationality('united states of america')).toBe('USA');
  });
  test('falls back to upper-cased text for unknowns', () => {
    expect(normalizeNationality('Wakanda')).toBe('WAKANDA');
    expect(normalizeNationality('')).toBeNull();
  });
});

describe('parseViz — UAE specimen', () => {
  const v = parseViz(VIZ_TEXT);

  test('extracts the labeled fields correctly', () => {
    expect(v.passportNumber).toBe('P90S12345');
    expect(v.dateOfBirth).toBe('1987-07-27');
    expect(v.dateOfExpiry).toBe('2021-01-12');
    expect(v.dateOfIssue).toBe('2016-01-12'); // NOT the expiry on the same line
    expect(v.nationality).toBe('ARE');
    expect(v.sex).toBe('F');
    expect(v.fullName).toBe('HUDA BIN NASSER');
  });

  test('returns null when no labels are present', () => {
    expect(parseViz('a line of prose with no passport labels at all')).toBeNull();
    expect(parseViz('')).toBeNull();
  });
});
