import { describe, test, expect, vi } from 'vitest';

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
    expect(travelRag.buildQueryText({}, null)).toBe('School trip diagnostic profile.');
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
    expect(out.recommendedTrips[0].places[0].learnings).toHaveLength(2);
  });

  test('extracts JSON from a markdown fenced block', () => {
    const text = '```json\n{"readinessScore": 5, "summary": "OK", "recommendedTrips": []}\n```';
    const out = travelRag.parseRagResponse(text);
    expect(out.readinessScore).toBe(5);
    expect(out.recommendedTrips).toEqual([]);
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
});
