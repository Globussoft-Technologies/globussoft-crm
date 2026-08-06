import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const qdrantClient = require('../../lib/qdrantClient.js');

describe('qdrantClient — config surface', () => {
  const originalEnv = process.env.QDRANT_URL;

  beforeEach(() => {
    delete process.env.QDRANT_URL;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.QDRANT_URL;
    else process.env.QDRANT_URL = originalEnv;
  });

  test('isEnabled is false when QDRANT_URL is unset', () => {
    expect(qdrantClient.isEnabled()).toBe(false);
  });

  test('isEnabled is true when QDRANT_URL is set', () => {
    process.env.QDRANT_URL = 'http://localhost:6333';
    expect(qdrantClient.isEnabled()).toBe(true);
  });

  test('collectionName defaults to travel_knowledge', () => {
    delete process.env.QDRANT_COLLECTION;
    expect(qdrantClient.collectionName()).toBe('travel_knowledge');
  });

  test('VECTOR_SIZE matches OpenAI embedding dimensions', () => {
    expect(qdrantClient.VECTOR_SIZE).toBe(1536);
  });
});
