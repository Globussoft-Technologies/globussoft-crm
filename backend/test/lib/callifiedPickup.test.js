import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  extractInterestedPlotAreaFromCallifiedDetails,
  extractPickupLocationFromCallifiedDetails,
  hasExplicitNoInterestedPlotArea,
} = requireCJS('../../lib/callifiedPickup');

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

  test('combines a pickup repeated by the AI with city and PIN supplied in the next customer reply', () => {
    const result = extractPickupLocationFromCallifiedDetails({
      transcripts: [{
        id: 504,
        transcript: [
          { role: 'AI', text: 'Could you please provide your complete pickup address, including a nearby landmark, city, and PIN code?' },
          { role: 'User', text: 'signal in Koramangala and place is Excellent Business.' },
          { role: 'AI', text: 'Just to confirm, your pickup will be from Excellent Business Building near Sony Signal, Koramangala; could you please provide your city and PIN code?' },
          { role: 'User', text: 'city is Bangalore and the PIN code is 560089.' },
          { role: 'AI', text: 'Thank you, your visit is confirmed.' },
          { role: 'User', text: 'Please call me again later.' },
        ],
      }],
      reviews: [],
    });

    expect(result).toEqual({
      pickupAddress: 'signal in Koramangala and place is Excellent Business, city is Bangalore and the PIN code is 560089',
      sourceTranscriptId: '504',
      sourceExcerpt: 'signal in Koramangala and place is Excellent Business. | city is Bangalore and the PIN code is 560089.',
    });
  });

  test('captures a customer address reply even when the customer does not repeat the words pickup location', () => {
    const result = extractPickupLocationFromCallifiedDetails({
      transcripts: [{
        id: 505,
        transcript: [
          { role: 'AI', text: 'Please provide your pickup location with a nearby landmark.' },
          { role: 'User', text: '42 Lake View Road, Koramangala, near Sony Signal.' },
          { role: 'AI', text: 'Thank you, your visit is confirmed.' },
        ],
      }],
      reviews: [],
    });

    expect(result.pickupAddress).toBe('42 Lake View Road, Koramangala, near Sony Signal');
  });

  test('does not mistake a transportation confirmation for a pickup address', () => {
    expect(extractPickupLocationFromCallifiedDetails({
      transcripts: [{
        id: 506,
        transcript: [
          { role: 'AI', text: 'Do you require transportation for the visit?' },
          { role: 'User', text: 'Yeah, it is required.' },
        ],
      }],
      reviews: [],
    })).toBeNull();
  });

  test('stops collecting pickup text after the customer confirms the address', () => {
    const result = extractPickupLocationFromCallifiedDetails({
      transcripts: [{
        id: 507,
        transcript: [
          { role: 'AI', text: 'So, the pickup address is Sony Signal, Koramangala near KEB Optical, Bangalore, with PIN code 560029. Is this correct?' },
          { role: 'User', text: 'Yeah, it is correct.' },
          { role: 'AI', text: 'What time would you prefer for us to pick you up tomorrow?' },
          { role: 'User', text: 'unten' },
          { role: 'User', text: '¿Qué?' },
        ],
      }],
      reviews: [],
    });

    expect(result.pickupAddress).toBe('Sony Signal, Koramangala near KEB Optical, Bangalore, with PIN code 560029');
  });

  test('keeps only the customer-provided pickup address instead of the AI confirmation text', () => {
    const result = extractPickupLocationFromCallifiedDetails({
      transcripts: [{
        id: 508,
        transcript: [
          { role: 'AI', text: 'Please share your complete pickup address, including a nearby landmark, city, and PIN code.' },
          { role: 'User', text: 'my pickup location is Purnima Saree Ladies PG, Haridwar Road, near Ladis Farm. And pin code is 512688.' },
          { role: 'AI', text: 'Your pickup location is Purnima Saree Ladies PG, Haridwar Road, near Ladis Farm, pin code five one two six eight eight; is that correct?' },
          { role: 'User', text: 'yes' },
        ],
      }],
      reviews: [],
    });

    expect(result.pickupAddress).toBe('Purnima Saree Ladies PG, Haridwar Road, near Ladis Farm. And pin code is 512688');
    expect(result.pickupAddress).not.toContain('is that correct');
  });
});

describe('extractInterestedPlotAreaFromCallifiedDetails', () => {
  test('extracts the specific site and ignores a later pickup-time answer', () => {
    const result = extractInterestedPlotAreaFromCallifiedDetails({
      transcripts: [{
        id: 601,
        created_at: '2026-10-08T05:33:32.000Z',
        transcript: [
          { role: 'AI', text: 'Are you still interested in visiting the plots, and do you have a specific site in mind?' },
          { role: 'User', text: 'Yeah, I am interested to visit the slots and specific site is code Mangla.' },
          { role: 'AI', text: 'Plot availability, final pricing, discounts, and legal approvals will be discussed during the site visit. What time would you prefer for us to pick you up tomorrow?' },
          { role: 'User', text: 'unten' },
        ],
      }],
      reviews: [],
    });

    expect(result).toBe('code Mangla');
  });

  test('leaves the interested area blank when the customer has no preference and asks for a recommendation', () => {
    const result = extractInterestedPlotAreaFromCallifiedDetails({
      transcripts: [{
        id: 602,
        created_at: '2026-10-08T05:40:00.000Z',
        transcript: [
          { role: 'AI', text: 'Do you have a specific plot or site in mind that you would like to visit?' },
          { role: 'User', text: 'Sí.' },
          { role: 'AI', text: 'Could you please specify which plot or site you are interested in visiting?' },
          { role: 'User', text: "Mhm. No, I don't have any specific recommendation. Can you recommend?" },
          { role: 'AI', text: 'A senior teammate will share available plots and recommendations during the site visit.' },
        ],
      }],
      reviews: [{
        transcript_id: 602,
        summary: 'The customer asked the agent to recommend an available plot in a suitable area.',
      }],
    });

    expect(result).toBeNull();
  });

  test('does not populate interested area from an AI-generated review summary', () => {
    expect(extractInterestedPlotAreaFromCallifiedDetails({
      transcripts: [{ id: 603, transcript: [{ role: 'User', text: 'Please recommend something.' }] }],
      reviews: [{ transcript_id: 603, summary: 'The customer is interested in plots in Koramangala.' }],
    })).toBeNull();
  });

  test('marks an explicit no-preference response so a previously inferred area can be cleared', () => {
    expect(hasExplicitNoInterestedPlotArea({
      transcripts: [{
        id: 604,
        transcript: [
          { role: 'AI', text: 'Which plot area are you interested in?' },
          { role: 'User', text: "I don't have a specific area. Can you recommend one?" },
        ],
      }],
    })).toBe(true);
  });

  test('does not clear the area when the customer later provides a specific location', () => {
    expect(hasExplicitNoInterestedPlotArea({
      transcripts: [{
        id: 605,
        transcript: [
          { role: 'User', text: "I don't have a specific area yet." },
          { role: 'User', text: 'My preferred area is Koramangala.' },
        ],
      }],
    })).toBe(false);
  });
});
