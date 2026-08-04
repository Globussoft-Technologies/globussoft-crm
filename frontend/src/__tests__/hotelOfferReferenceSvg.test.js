import { describe, it, expect } from 'vitest';
import { buildReferenceHotelOfferSvg } from '../pages/travel/hotelOfferReferenceSvg';

describe('buildReferenceHotelOfferSvg', () => {
  it('keeps hotel pricing labels inside the image and hides the grand total', () => {
    const svg = buildReferenceHotelOfferSvg({
      hotelLabel: 'Hotel quotation',
      quoteMeta: {
        hotelLabel: 'Sponsored Hotels',
        city: 'Paris',
        stayLabel: 'Lowest prices for stays until 3 Oct',
        checkIn: '2026-08-02',
        checkOut: '2026-10-03',
        basisLabel: 'Total price',
        sourceLabel: 'Offline hotel prices',
      },
      pricedRows: [
        { label: 'Novotel Paris Les Halles', roomType: 'Deluxe Room', city: 'Paris', priceBasis: 'total', nights: 1, total: 33524, currency: 'INR' },
        { label: 'Hotel Belloy St Germain', roomType: 'Classic Room', city: 'Paris', priceBasis: 'total', nights: 1, total: 17195, currency: 'INR' },
      ],
    });

    expect(svg).toContain('Hotel-wise prices only');
    expect(svg).toContain('font-family="Aptos, Segoe UI, Helvetica Neue, Arial, sans-serif"');
    expect(svg).not.toContain('Quoted total');
    expect(svg).not.toContain('Final quoted amount');
    expect(svg).not.toContain('Total price');
    expect(svg).toContain('Hotel wise pricing');
  });
});

