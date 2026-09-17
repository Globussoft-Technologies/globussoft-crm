import { describe, expect, it } from 'vitest';
import { parseCsvRows } from '../utils/csvParser';

describe('parseCsvRows', () => {
  it('parses quoted commas, escaped quotes, CRLF, and a BOM', () => {
    expect(parseCsvRows('\uFEFFname,email,role\r\n"Sharma, Sumit",sumit@example.com,USER\r\n"A ""quoted"" name",a@example.com,MANAGER')).toEqual([
      ['name', 'email', 'role'],
      ['Sharma, Sumit', 'sumit@example.com', 'USER'],
      ['A "quoted" name', 'a@example.com', 'MANAGER'],
    ]);
  });

  it('preserves embedded newlines and omits blank rows', () => {
    expect(parseCsvRows('name,notes\nAlice,"first line\nsecond line"\n\n')).toEqual([
      ['name', 'notes'],
      ['Alice', 'first line\nsecond line'],
    ]);
  });
});
