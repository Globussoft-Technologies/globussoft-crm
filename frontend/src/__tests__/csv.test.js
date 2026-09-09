import { describe, expect, it } from 'vitest';
import { parseCsvTable } from '../utils/csv';

describe('parseCsvTable', () => {
  it('handles BOMs, CRLF, quoted commas, and escaped quotes', () => {
    const result = parseCsvTable('\uFEFFName,Company,Note\r\nAarav,"Acme, Inc.","Said ""hello"""\r\n');
    expect(result).toEqual({
      headers: ['name', 'company', 'note'],
      records: [['Aarav', 'Acme, Inc.', 'Said "hello"']],
    });
  });

  it('keeps embedded newlines inside quoted fields and accepts lone CR records', () => {
    const result = parseCsvTable('name,note\rPriya,"line one\nline two"\rKaran,done');
    expect(result.records).toEqual([
      ['Priya', 'line one\nline two'],
      ['Karan', 'done'],
    ]);
  });

  it('preserves short and long rows so callers can report column mismatches', () => {
    const result = parseCsvTable('a,b\n1\n2,3,4');
    expect(result.records).toEqual([['1'], ['2', '3', '4']]);
  });

  it('drops blank records and rejects non-string input', () => {
    expect(parseCsvTable('a,b\n\n1,2\n   \n').records).toEqual([['1', '2']]);
    expect(() => parseCsvTable(null)).toThrow(TypeError);
  });
});
