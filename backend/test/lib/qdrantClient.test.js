import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const qdrantClient = require('../../lib/qdrantClient.js');
const hasQdrantClientLibrary = (() => {
  try {
    require.resolve('@qdrant/js-client-rest');
    return true;
  } catch {
    return false;
  }
})();

describe('qdrantClient — config surface', () => {
  const originalUrl = process.env.QDRANT_URL;
  const originalCollection = process.env.QDRANT_COLLECTION;

  beforeEach(() => {
    delete process.env.QDRANT_URL;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.QDRANT_URL;
    else process.env.QDRANT_URL = originalUrl;
    if (originalCollection === undefined) delete process.env.QDRANT_COLLECTION;
    else process.env.QDRANT_COLLECTION = originalCollection;
  });

  test('isEnabled is false when QDRANT_URL is unset', () => {
    expect(qdrantClient.isEnabled()).toBe(false);
  });

  test('isEnabled reflects client-library availability when QDRANT_URL is set', () => {
    process.env.QDRANT_URL = 'http://localhost:6333';
    expect(qdrantClient.isEnabled()).toBe(hasQdrantClientLibrary);
  });

  test('collectionName defaults to travel_knowledge', () => {
    delete process.env.QDRANT_COLLECTION;
    expect(qdrantClient.collectionName()).toBe('travel_knowledge');
  });

  test('VECTOR_SIZE matches OpenAI embedding dimensions', () => {
    expect(qdrantClient.VECTOR_SIZE).toBe(1536);
  });
});
