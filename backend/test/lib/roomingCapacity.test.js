import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  parseSharingCapacity,
  resolveSharingCapacity,
  legacyRoomTypeForCapacity,
  serializeRoomCapacity,
} = requireCJS('../../lib/roomingCapacity');

describe('trip room sharing capacity', () => {
  test.each([1, 2, 5, 12])('accepts custom positive integer capacity %i', (capacity) => {
    expect(parseSharingCapacity(capacity)).toBe(capacity);
    expect(parseSharingCapacity(String(capacity))).toBe(capacity);
  });

  test.each([0, -1, 1.5, 2_147_483_648, '2.5', '', 'not-a-number', null, undefined])(
    'rejects invalid sharing capacity %s',
    (capacity) => {
      expect(parseSharingCapacity(capacity)).toBeNull();
    },
  );

  test('reads legacy room types when a row has not been backfilled', () => {
    expect(resolveSharingCapacity({ roomType: 'triple', sharingCapacity: null })).toBe(3);
    expect(serializeRoomCapacity({ id: 9, roomType: 'quad' })).toMatchObject({ sharingCapacity: 4 });
  });

  test('prefers the persisted custom capacity and keeps a legacy-compatible type label', () => {
    expect(resolveSharingCapacity({ roomType: 'custom', sharingCapacity: 7 })).toBe(7);
    expect(legacyRoomTypeForCapacity(7)).toBe('custom');
    expect(legacyRoomTypeForCapacity(2)).toBe('twin');
  });
});
