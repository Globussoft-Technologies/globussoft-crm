import { describe, test, expect } from 'vitest';

const {
  chunkText,
  normaliseSubBrand,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  SUB_BRAND_ALIASES,
} = require('../../lib/travelKnowledgeBaseSync.js');

describe('travelKnowledgeBaseSync — chunkText', () => {
  test('returns empty array for empty text', () => {
    expect(chunkText('')).toEqual([]);
  });

  test('returns a single chunk for short text', () => {
    const text = 'Short text.';
    const chunks = chunkText(text, CHUNK_SIZE, CHUNK_OVERLAP);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Short text.');
  });

  test('splits long text into overlapping chunks', () => {
    const word = 'word ';
    const text = word.repeat(500).trim();
    const chunks = chunkText(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk except the last should be roughly the chunk size.
    for (let i = 0; i < chunks.length - 1; i += 1) {
      expect(chunks[i].length).toBeGreaterThanOrEqual(80);
      expect(chunks[i].length).toBeLessThanOrEqual(100);
    }
    // Overlap sanity: chunk 1 should end with words that appear in chunk 2.
    const tailWords = chunks[0].split(' ').slice(-3);
    const headWords = chunks[1].split(' ').slice(0, 3);
    expect(tailWords.some((w) => headWords.includes(w))).toBe(true);
  });
});

describe('travelKnowledgeBaseSync — normaliseSubBrand', () => {
  test('maps known aliases to canonical tokens', () => {
    expect(normaliseSubBrand('TMC')).toBe('tmc');
    expect(normaliseSubBrand('TMC School Trips')).toBe('tmc');
    expect(normaliseSubBrand('RFU — Umrah')).toBe('rfu');
    expect(normaliseSubBrand('Travel Stall')).toBe('travelstall');
    expect(normaliseSubBrand('Visa Sure')).toBe('visasure');
  });

  test('normalises unknown names to lowercase alphanumeric', () => {
    expect(normaliseSubBrand('Some Brand!')).toBe('somebrand');
  });

  test('exposes the alias map for introspection', () => {
    expect(SUB_BRAND_ALIASES.tmc).toContain('tmc');
  });
});
