import { describe, test, expect } from 'vitest';

const travelRag = require('../../lib/travelRag.js');

describe('travelRag — buildQueryText', () => {
  test('stringifies answer map into a profile sentence', () => {
    const q = travelRag.buildQueryText({ grade: '6', curriculum: 'CBSE', groupSize: '40' }, null);
    expect(q).toContain('grade: 6');
    expect(q).toContain('curriculum: CBSE');
    expect(q).toContain('groupSize: 40');
  });

  test('handles multi-select answers', () => {
    const q = travelRag.buildQueryText({ interests: ['history', 'science'] }, null);
    expect(q).toContain('history, science');
  });

  test('falls back to a generic profile when answers are empty', () => {
    expect(travelRag.buildQueryText({}, null)).toBe('travel diagnostic profile.');
  });
});

describe('travelRag — parseRagResponse', () => {
  test('parses plain JSON and normalises shape', () => {
    const text = JSON.stringify({
      readinessScore: 8,
      summary: 'Great fit',
      recommendedTrips: [
        {
          name: 'Europe Tour',
          driveLink: 'https://drive.example.com/europe',
          places: [
            { name: 'Paris', learnings: ['Art history', 'Urban planning'] },
          ],
        },
      ],
    });
    const out = travelRag.parseRagResponse(text);
    expect(out.readinessScore).toBe(8);
    expect(out.summary).toBe('Great fit');
    expect(out.recommendedTrips).toHaveLength(1);
    expect(out.recommendedTrips[0].learnings).toHaveLength(2);
  });

  test('extracts JSON from a markdown fenced block', () => {
    const text = '```json\n{"readinessScore": 5, "summary": "OK", "recommendedTrips": []}\n```';
    const out = travelRag.parseRagResponse(text);
    expect(out.readinessScore).toBe(5);
    expect(out.recommendedTrips).toEqual([]);
  });

  test('recovers an LLM response with an unescaped line break inside a JSON string', () => {
    const text = `{"readinessScore": 7, "summary": "A useful\nlearning profile", "recommendedTrips": [{"name": "Hampi Tour", "summary": "History and\nheritage", "learnings": []}]}`;
    const out = travelRag.parseRagResponse(text);

    expect(out.summary).toBe('A useful\nlearning profile');
    expect(out.recommendedTrips[0].summary).toBe('History and\nheritage');
  });

  test('returns null for non-JSON text', () => {
    expect(travelRag.parseRagResponse('plain text')).toBeNull();
  });

  test('clamps readiness score to 0-10', () => {
    const text = JSON.stringify({ readinessScore: 15, summary: '', recommendedTrips: [] });
    expect(travelRag.parseRagResponse(text).readinessScore).toBe(10);
  });

  test('filters out trips with no name', () => {
    const text = JSON.stringify({
      readinessScore: 7,
      recommendedTrips: [{ name: '', driveLink: 'x', places: [] }, { name: 'Valid Trip', driveLink: 'y', places: [] }],
    });
    expect(travelRag.parseRagResponse(text).recommendedTrips).toHaveLength(1);
  });

  test('caps recommendedTrips at 10 by default (no topK argument)', () => {
    const text = JSON.stringify({
      readinessScore: 7,
      recommendedTrips: Array.from({ length: 15 }, (_, i) => ({ name: `Trip ${i}`, driveLink: '', places: [] })),
    });
    expect(travelRag.parseRagResponse(text).recommendedTrips).toHaveLength(10);
  });

  test('caps recommendedTrips at a custom topK when provided', () => {
    const text = JSON.stringify({
      readinessScore: 7,
      recommendedTrips: Array.from({ length: 15 }, (_, i) => ({ name: `Trip ${i}`, driveLink: '', places: [] })),
    });
    expect(travelRag.parseRagResponse(text, 3).recommendedTrips).toHaveLength(3);
    expect(travelRag.parseRagResponse(text, 15).recommendedTrips).toHaveLength(15);
  });
});

describe('travelRag — fillRecommendationTarget', () => {
  test('keeps AI-ranked results first and fills the configured count with distinct semantic brochures', () => {
    const result = travelRag.fillRecommendationTarget(
      [{ name: 'Japan', driveLink: 'https://drive.example/japan', summary: 'AI-ranked match', learnings: [] }],
      [
        { fileName: 'Japan.pdf', driveLink: 'https://drive.example/japan', text: 'Duplicate result that should not appear.', category: 'International' },
        { fileName: 'Europe Tour.pdf', driveLink: 'https://drive.example/europe', text: 'Students explore history, culture, and geography through guided visits.', category: 'International' },
        { fileName: 'Vietnam.pdf', driveLink: 'https://drive.example/vietnam', text: 'A hands-on programme covering local heritage and environmental learning.', category: 'International' },
      ],
      3,
    );

    expect(result).toHaveLength(3);
    expect(result.map((item) => item.name)).toEqual(['Japan', 'Europe Tour', 'Vietnam']);
    expect(result[1].summary).toBe('An immersive international learning experience that combines cultural discovery with hands-on exploration.');
  });

  test('keeps distinct products when their stable Drive links differ', () => {
    const result = travelRag.fillRecommendationTarget(
      [{ name: 'Delhi, Agra & Jaipur-5days', driveLink: 'https://drive.example/delhi-a', summary: '', learnings: [] }],
      [
        { fileName: 'Delhi, Agra & Jaipur Tour.pdf', driveLink: 'https://drive.example/delhi-b', category: 'Domestic' },
        { fileName: 'Hampi Tour.pdf', driveLink: 'https://drive.example/hampi', category: 'Domestic' },
      ],
      3,
    );

    expect(result.map((item) => item.name)).toEqual([
      'Delhi, Agra & Jaipur-5days',
      'Delhi, Agra & Jaipur Tour',
      'Hampi Tour',
    ]);
  });

  test('preserves duration variants when no stable brochure identity is available', () => {
    const result = travelRag.fillRecommendationTarget(
      [{ name: 'Goa Tour 4 Days', summary: '', learnings: [] }],
      [{ fileName: 'Goa Tour 7 Days.pdf', category: 'Domestic' }],
      2,
    );

    expect(result.map((item) => item.name)).toEqual(['Goa Tour 4 Days', 'Goa Tour 7 Days']);
  });
});

describe('travelRag — bounded Qdrant retrieval', () => {
  test('scales with recommendation count without requesting hundreds of points', () => {
    expect(travelRag.getRagRetrievalLimit(1)).toBe(30);
    expect(travelRag.getRagRetrievalLimit(10)).toBe(80);
    expect(travelRag.getRagRetrievalLimit(100)).toBe(120);
  });
});

describe('travelRag — brochure identity metadata', () => {
  test('keeps the stable Drive file id while consolidating brochure chunks', () => {
    const result = travelRag.consolidateChunks([
      {
        id: 'point-1',
        score: 0.9,
        payload: {
          driveFileId: 'drive-file-123',
          fileName: 'Goa Tour 4 Days.pdf',
          driveViewLink: 'https://drive.google.com/file/d/drive-file-123/view',
          folderPath: 'TMC/Domestic',
          text: 'Best matching excerpt',
        },
      },
    ]);

    expect(result[0]).toMatchObject({
      driveFileId: 'drive-file-123',
      fileName: 'Goa Tour 4 Days.pdf',
    });
  });
});
