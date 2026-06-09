// @ts-check
/**
 * Unit tests for backend/lib/curriculumCsvParser.js — C6 slice.
 *
 * Pins the parser's contract per the C6 slice spec:
 *
 *   1. Happy path: valid CSV → all rows parsed, zero errors, no headerError.
 *   2. Missing required column: parser refuses (headerError set, rows: []).
 *   3. BOM-prefixed file parses correctly.
 *   4. Whitespace tolerance in cells (trim).
 *   5. Empty cells in optional columns (destinationLabel, fitRationale, etc.)
 *      → empty string / null. Required columns empty → per-row error.
 *   6. Invalid curriculum value → per-row error; row dropped.
 *   7. Round-trip: parse → serialize → parse → byte-equal rows.
 *   8. Empty CSV (header only, no rows) → empty rows array, no errors.
 *   9. Quoted commas in cells handled correctly.
 *  10. CRLF vs LF line endings both work.
 *  11. Unicode characters preserved through round-trip.
 *  12. Duplicate rows (same composite key) → both kept; upsert handles
 *      dedup at the route layer.
 *  13. Invalid fitScore / destinationId / isActive → per-row errors.
 *  14. Curriculum is normalised to canonical case (CBSE / ICSE / IB /
 *      Cambridge) regardless of input casing.
 *  15. Blank trailing rows (Excel pads) are silently skipped, not errors.
 *
 * The C6 slice spec lists ≥10 cases as the contract; the cases above
 * exhaustively cover every branch in parseCsv() + serializeCsv() — every
 * required-column branch, every optional-column branch, every error path.
 */

import { describe, test, expect } from 'vitest';
import {
  parseCsv,
  serializeCsv,
  REQUIRED_COLUMNS,
  ALLOWED_CURRICULA,
} from '../../lib/curriculumCsvParser.js';

const HEADER =
  'curriculum,grade,subject,learningOutcome,destinationLabel,destinationId,fitScore,fitRationale,isActive';

function row(opts = {}) {
  // Default valid-row factory.
  const r = {
    curriculum: 'CBSE',
    grade: 'Class 9',
    subject: 'Geography',
    learningOutcome: 'Plate tectonics + landform formation',
    destinationLabel: 'Mussoorie + Dehradun',
    destinationId: '',
    fitScore: '85',
    fitRationale: 'Direct fold-mountain field observation',
    isActive: 'true',
    ...opts,
  };
  return [
    r.curriculum,
    r.grade,
    r.subject,
    r.learningOutcome,
    r.destinationLabel,
    r.destinationId,
    r.fitScore,
    r.fitRationale,
    r.isActive,
  ].join(',');
}

describe('curriculumCsvParser — happy path', () => {
  test('case 1: valid CSV with 3 rows → all parsed, zero errors', () => {
    const csv = [
      HEADER,
      row({ curriculum: 'CBSE', subject: 'Geography' }),
      row({ curriculum: 'ICSE', subject: 'History', learningOutcome: 'Mughal architecture' }),
      row({ curriculum: 'IB', subject: 'Biology', learningOutcome: 'Marine ecosystems' }),
    ].join('\n');

    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0].curriculum).toBe('CBSE');
    expect(rows[0].subject).toBe('Geography');
    expect(rows[0].fitScore).toBe(85);
    expect(rows[0].isActive).toBe(true);
    expect(rows[1].curriculum).toBe('ICSE');
    expect(rows[2].curriculum).toBe('IB');
  });
});

describe('curriculumCsvParser — header errors', () => {
  test('case 2: missing required column (learningOutcome) → headerError set, rows empty', () => {
    const csv = [
      'curriculum,grade,subject,destinationLabel',
      'CBSE,Class 9,Geography,Andaman',
    ].join('\n');

    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeTruthy();
    expect(headerError).toContain('learningOutcome');
    expect(rows).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('case 2b: REQUIRED_COLUMNS export is the exact 4-column composite key', () => {
    expect(REQUIRED_COLUMNS).toEqual([
      'curriculum',
      'grade',
      'subject',
      'learningOutcome',
    ]);
  });

  test('case 2c: ALLOWED_CURRICULA export pins the canonical 4 values', () => {
    expect(ALLOWED_CURRICULA).toEqual(['CBSE', 'ICSE', 'IB', 'Cambridge']);
  });
});

describe('curriculumCsvParser — BOM tolerance', () => {
  test('case 3: BOM-prefixed file parses correctly', () => {
    const bom = '﻿';
    const csv = bom + [HEADER, row()].join('\n');

    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].curriculum).toBe('CBSE');
  });
});

describe('curriculumCsvParser — whitespace + optional handling', () => {
  test('case 4: whitespace in cells is trimmed', () => {
    const csv = [
      HEADER,
      '  CBSE  , Class 9 , Geography ,  Plate tectonics  ,Andaman,,85,,true',
    ].join('\n');

    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(errors).toEqual([]);
    expect(rows[0].curriculum).toBe('CBSE');
    expect(rows[0].grade).toBe('Class 9');
    expect(rows[0].subject).toBe('Geography');
    expect(rows[0].learningOutcome).toBe('Plate tectonics');
    expect(rows[0].destinationLabel).toBe('Andaman');
  });

  test('case 5: empty cells in optional columns → empty string / null', () => {
    const csv = [
      HEADER,
      // No destinationLabel, no destinationId, no fitScore, no fitRationale, no isActive.
      'CBSE,Class 9,Geography,Plate tectonics,,,,,',
    ].join('\n');

    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(errors).toEqual([]);
    expect(rows[0].destinationLabel).toBe('');
    expect(rows[0].destinationId).toBeNull();
    expect(rows[0].fitScore).toBeNull();
    expect(rows[0].fitRationale).toBe('');
    expect(rows[0].isActive).toBeNull();
  });

  test('case 5b: empty cells in required columns → per-row error, row dropped', () => {
    const csv = [
      HEADER,
      // No subject.
      'CBSE,Class 9,,Plate tectonics,,,,,',
    ].join('\n');

    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(2);
    expect(errors[0].message).toMatch(/subject is required/);
  });
});

describe('curriculumCsvParser — invalid values', () => {
  test('case 6: invalid curriculum value → per-row error', () => {
    const csv = [HEADER, row({ curriculum: 'FOO' })].join('\n');

    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(2);
    expect(errors[0].message).toMatch(/curriculum "FOO" not in allowed set/);
  });

  test('case 13a: invalid fitScore (out of range) → per-row error', () => {
    const csv = [HEADER, row({ fitScore: '150' })].join('\n');
    const { rows, errors } = parseCsv(csv);
    expect(rows).toEqual([]);
    expect(errors[0].message).toMatch(/fitScore "150" must be an integer/);
  });

  test('case 13b: invalid fitScore (non-integer) → per-row error', () => {
    const csv = [HEADER, row({ fitScore: 'high' })].join('\n');
    const { rows, errors } = parseCsv(csv);
    expect(rows).toEqual([]);
    expect(errors[0].message).toMatch(/fitScore "high" must be an integer/);
  });

  test('case 13c: invalid destinationId (negative) → per-row error', () => {
    const csv = [HEADER, row({ destinationId: '-5' })].join('\n');
    const { rows, errors } = parseCsv(csv);
    expect(rows).toEqual([]);
    expect(errors[0].message).toMatch(/destinationId "-5" must be a positive integer/);
  });

  test('case 13d: invalid isActive value → per-row error', () => {
    const csv = [HEADER, row({ isActive: 'maybe' })].join('\n');
    const { rows, errors } = parseCsv(csv);
    expect(rows).toEqual([]);
    expect(errors[0].message).toMatch(/isActive "maybe" must be true\/false/);
  });

  test('case 14: curriculum is normalised to canonical case (case-insensitive)', () => {
    const csv = [
      HEADER,
      row({ curriculum: 'cbse' }),
      row({ curriculum: 'iCsE' }),
      row({ curriculum: 'cambridge', learningOutcome: 'X' }),
    ].join('\n');

    const { rows, errors } = parseCsv(csv);
    expect(errors).toEqual([]);
    expect(rows[0].curriculum).toBe('CBSE');
    expect(rows[1].curriculum).toBe('ICSE');
    expect(rows[2].curriculum).toBe('Cambridge');
  });
});

describe('curriculumCsvParser — round-trip', () => {
  test('case 7: parse → serialize → parse yields byte-equal rows', () => {
    const csv = [
      HEADER,
      row({ curriculum: 'CBSE', subject: 'Geography', fitScore: '90', destinationId: '7' }),
      row({ curriculum: 'ICSE', subject: 'History', isActive: 'false', fitRationale: 'See unit 4.' }),
    ].join('\n');

    const first = parseCsv(csv);
    expect(first.headerError).toBeNull();
    expect(first.errors).toEqual([]);

    const reserialized = serializeCsv(first.rows);
    const second = parseCsv(reserialized);

    expect(second.headerError).toBeNull();
    expect(second.errors).toEqual([]);
    expect(second.rows).toEqual(first.rows);

    // And one more round to prove idempotence after the first pass.
    const third = parseCsv(serializeCsv(second.rows));
    expect(third.rows).toEqual(second.rows);
  });
});

describe('curriculumCsvParser — empty + edge', () => {
  test('case 8a: header-only CSV (no data rows) → empty rows, no errors', () => {
    const csv = HEADER;
    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(rows).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('case 8b: empty string → empty rows, no errors, no headerError', () => {
    const { rows, errors, headerError } = parseCsv('');
    expect(headerError).toBeNull();
    expect(rows).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('case 8c: non-string input → headerError, no throw', () => {
    // @ts-expect-error intentional bad input
    const { rows, errors, headerError } = parseCsv(null);
    expect(headerError).toBe('input must be a string');
    expect(rows).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('case 15: blank trailing rows are silently skipped, not errors', () => {
    const csv = [HEADER, row(), '', '   ', '', '   '].join('\n');
    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});

describe('curriculumCsvParser — quoting + line endings + unicode', () => {
  test('case 9: quoted commas in cells handled correctly', () => {
    const csv = [
      HEADER,
      // destinationLabel contains commas → quoted.
      'CBSE,Class 9,Geography,Plate tectonics,"Mussoorie, Dehradun, Rishikesh",,85,,true',
    ].join('\n');

    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(errors).toEqual([]);
    expect(rows[0].destinationLabel).toBe('Mussoorie, Dehradun, Rishikesh');
  });

  test('case 10a: CRLF line endings work', () => {
    const csv = [HEADER, row()].join('\r\n');
    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  test('case 10b: LF line endings work', () => {
    const csv = [HEADER, row()].join('\n');
    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  test('case 11: unicode characters preserved through round-trip', () => {
    const csv = [
      HEADER,
      // Devanagari + emoji + accented Latin
      'CBSE,Class 9,Geography,हिन्दी learning outcome — île Müller café 🌍,Mussoorie,,75,Notes with é,true',
    ].join('\n');

    const first = parseCsv(csv);
    expect(first.headerError).toBeNull();
    expect(first.errors).toEqual([]);
    expect(first.rows[0].learningOutcome).toBe(
      'हिन्दी learning outcome — île Müller café 🌍',
    );
    expect(first.rows[0].fitRationale).toBe('Notes with é');

    const second = parseCsv(serializeCsv(first.rows));
    expect(second.rows).toEqual(first.rows);
  });
});

describe('curriculumCsvParser — duplicate rows', () => {
  test('case 12: duplicate rows with same composite key are both kept; upsert dedup is the route layer', () => {
    const csv = [
      HEADER,
      row({ fitScore: '70', fitRationale: 'First take' }),
      row({ fitScore: '90', fitRationale: 'Updated take' }),
    ].join('\n');

    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0].fitScore).toBe(70);
    expect(rows[1].fitScore).toBe(90);
    expect(rows[0].curriculum).toBe(rows[1].curriculum);
    expect(rows[0].grade).toBe(rows[1].grade);
    expect(rows[0].subject).toBe(rows[1].subject);
    expect(rows[0].learningOutcome).toBe(rows[1].learningOutcome);
  });
});

describe('curriculumCsvParser — multi-error per-row reporting', () => {
  test('a row with multiple validation errors yields multiple error entries', () => {
    const csv = [
      HEADER,
      'FOO,,,,,abc,200,,unknown',
    ].join('\n');

    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(rows).toEqual([]);
    // Every error annotates the same row number.
    expect(errors.length).toBeGreaterThanOrEqual(4);
    for (const e of errors) {
      expect(e.row).toBe(2);
    }
    const messages = errors.map((e) => e.message).join(' | ');
    expect(messages).toMatch(/curriculum/);
    expect(messages).toMatch(/grade is required/);
    expect(messages).toMatch(/subject is required/);
    expect(messages).toMatch(/learningOutcome is required/);
  });
});

describe('curriculumCsvParser — serializeCsv defensive', () => {
  test('serializeCsv with empty input returns header-only CSV', () => {
    const csv = serializeCsv([]);
    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(rows).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('serializeCsv with non-array input returns header-only CSV', () => {
    // @ts-expect-error intentional bad input
    const csv = serializeCsv(null);
    expect(typeof csv).toBe('string');
    const { rows, errors, headerError } = parseCsv(csv);
    expect(headerError).toBeNull();
    expect(rows).toEqual([]);
    expect(errors).toEqual([]);
  });
});
