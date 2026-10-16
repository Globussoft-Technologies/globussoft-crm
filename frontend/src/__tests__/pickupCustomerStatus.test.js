import { describe, expect, it } from 'vitest';
import { pickupTripStatusStyle } from '../utils/pickupCustomerStatus';

describe('pickupTripStatusStyle', () => {
  it.each(['COMPLETED', 'TRANSACTION_COMPLETED'])(
    'uses the completed style for %s',
    (status) => {
      expect(pickupTripStatusStyle(status)).toEqual({
        color: '#047857',
        background: 'rgba(16,185,129,.14)',
      });
    },
  );

  it('keeps the pending pickup and default styles distinct', () => {
    expect(pickupTripStatusStyle('PICKUP_LOCATION_CAPTURED').color).toBe('#a16207');
    expect(pickupTripStatusStyle('ASSIGNED').color).toBe('var(--primary-color, var(--accent-color))');
  });
});
