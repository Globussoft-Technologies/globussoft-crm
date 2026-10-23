import { describe, expect, it } from 'vitest';
import { parseGoogleSuggestions } from '../../lib/googleAddressAutocomplete';

describe('parseGoogleSuggestions', () => {
  it('keeps the exact Google address label and stable place id', () => {
    const rows = parseGoogleSuggestions({
      suggestions: [{
        placePrediction: {
          placeId: 'ChIJ-exact-place',
          text: { text: '6PV8+HVJ, Devanahalli, Southegowdanahalli, Karnataka 562110, India' },
          structuredFormat: {
            mainText: { text: '6PV8+HVJ' },
            secondaryText: { text: 'Devanahalli, Southegowdanahalli, Karnataka 562110, India' },
          },
        },
      }],
    }, 6);

    expect(rows).toEqual([{
      place_id: 'ChIJ-exact-place',
      display_name: '6PV8+HVJ, Devanahalli, Southegowdanahalli, Karnataka 562110, India',
      name: '6PV8+HVJ',
      secondary_text: 'Devanahalli, Southegowdanahalli, Karnataka 562110, India',
      provider: 'google',
    }]);
  });

  it('drops query predictions and malformed place predictions', () => {
    expect(parseGoogleSuggestions({ suggestions: [
      { queryPrediction: { text: { text: 'not a place' } } },
      { placePrediction: { placeId: 'missing-text' } },
    ] })).toEqual([]);
  });
});
