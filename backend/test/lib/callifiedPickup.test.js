import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const { extractPickupLocationFromCallifiedDetails } = requireCJS('../../lib/callifiedPickup');

describe('extractPickupLocationFromCallifiedDetails', () => {
  test('extracts the pickup address from the Callified review summary', () => {
    const result = extractPickupLocationFromCallifiedDetails({
      transcripts: [{
        id: 501,
        created_at: '2026-10-06T11:38:00.000Z',
        transcript: [{ role: 'AI', text: 'Thank you. I recorded your pickup details.' }],
      }],
      reviews: [{
        transcript_id: 501,
        summary: 'The customer confirmed a plot visit. The pickup location is eighth block Koramangala near Lavis Pharma, SLS Ladies PG.',
      }],
    });

    expect(result).toEqual({
      pickupAddress: 'eighth block Koramangala near Lavis Pharma, SLS Ladies PG',
      sourceTranscriptId: '501',
      sourceExcerpt: 'The customer confirmed a plot visit. The pickup location is eighth block Koramangala near Lavis Pharma, SLS Ladies PG.',
    });
  });

  test('uses the AI confirmation when the review has no pickup address', () => {
    const result = extractPickupLocationFromCallifiedDetails({
      transcripts: [{
        id: 502,
        created_at: '2026-10-06T11:40:00.000Z',
        transcript: [{
          role: 'AI',
          text: 'I have recorded that your pickup location is eighth block Koramangala near Lavis Pharma, SLS Ladies PG for tomorrow at ten AM. We look forward to seeing you.',
        }],
      }],
      reviews: [],
    });

    expect(result.pickupAddress).toBe('eighth block Koramangala near Lavis Pharma, SLS Ladies PG');
  });

  test('does not create a pickup from an unrelated conversation', () => {
    expect(extractPickupLocationFromCallifiedDetails({
      transcripts: [{ id: 503, transcript: [{ role: 'User', text: 'Please call me tomorrow.' }] }],
      reviews: [],
    })).toBeNull();
  });
});
