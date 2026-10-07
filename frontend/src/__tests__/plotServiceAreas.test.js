import { describe, expect, it } from 'vitest';
import { serviceAreaFromPlot } from '../utils/plotServiceAreas';

describe('serviceAreaFromPlot', () => {
  it('infers Karnataka from a Bangalore address without an explicit state', () => {
    expect(serviceAreaFromPlot({
      id: 9,
      name: 'plot-1',
      address: 'CA-17, 6th Cross, 6th Block, Koramangala, Bangalore - 560095',
    })).toMatchObject({
      plotSiteId: 9,
      area: 'Koramangala',
      state: 'Karnataka',
      pincode: '560095',
    });
  });

  it('also recognises the Bengaluru spelling', () => {
    expect(serviceAreaFromPlot({
      id: 10,
      name: 'plot-2',
      address: '100 Feet Road, Indiranagar, Bengaluru: 560038',
    })).toMatchObject({
      area: 'Indiranagar',
      state: 'Karnataka',
      pincode: '560038',
    });
  });

  it('recognises the common Banglore misspelling used in saved addresses', () => {
    expect(serviceAreaFromPlot({
      id: 11,
      name: 'plot-3',
      address: 'CA-17, 6th Cross, Koramangala, Banglore - 560095',
    })).toMatchObject({
      area: 'Koramangala',
      state: 'Karnataka',
      pincode: '560095',
    });
  });
});
