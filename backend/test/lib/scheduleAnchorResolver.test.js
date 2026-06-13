// PRD_TRAVEL_BILLING G025 (FR-3.2.e) — anchor-relative due-date resolver
// unit tests.
//
// What's pinned
// -------------
//   VALID_ANCHOR_TYPES — closed enum of 4 anchor kinds
//   isValidAnchorType — bool predicate
//   resolveAnchorDate — returns Date | null based on (anchorType, invoice, trip)
//   computeDueDate — pure (anchor + offset) → Date | null; signed offset; UTC
//
// Failure modes pinned: missing anchor returns null; invalid type returns
// null; non-integer offset returns null; null/undefined args return null.

import { describe, test, expect } from 'vitest';
import {
  VALID_ANCHOR_TYPES,
  isValidAnchorType,
  resolveAnchorDate,
  computeDueDate,
} from '../../lib/scheduleAnchorResolver.js';

describe('lib/scheduleAnchorResolver — VALID_ANCHOR_TYPES', () => {
  test('pins to the 4 PRD-defined values (booking/departure/return/issue)', () => {
    expect(VALID_ANCHOR_TYPES).toEqual([
      'booking_date',
      'departure_date',
      'return_date',
      'issue_date',
    ]);
  });
});

describe('lib/scheduleAnchorResolver — isValidAnchorType', () => {
  test.each([
    ['booking_date', true],
    ['departure_date', true],
    ['return_date', true],
    ['issue_date', true],
    ['random', false],
    ['', false],
    [null, false],
    [undefined, false],
    [42, false],
  ])('%j → %s', (input, expected) => {
    expect(isValidAnchorType(input)).toBe(expected);
  });
});

describe('lib/scheduleAnchorResolver — resolveAnchorDate', () => {
  test('booking_date resolves from trip.bookingDate first', () => {
    const trip = { bookingDate: new Date('2026-04-01T00:00:00.000Z') };
    const invoice = { bookingDate: new Date('2026-03-01T00:00:00.000Z') };
    const d = resolveAnchorDate('booking_date', invoice, trip);
    expect(d?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  test('booking_date falls back to invoice.bookingDate when trip has none', () => {
    const invoice = { bookingDate: new Date('2026-03-01T00:00:00.000Z') };
    const d = resolveAnchorDate('booking_date', invoice, null);
    expect(d?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  test('booking_date falls back to invoice.createdAt when no explicit booking date present', () => {
    const invoice = { createdAt: new Date('2026-02-01T00:00:00.000Z') };
    const d = resolveAnchorDate('booking_date', invoice, null);
    expect(d?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  test('departure_date uses trip.departDate (TmcTrip schema convention)', () => {
    const trip = { departDate: new Date('2026-06-15T00:00:00.000Z') };
    const d = resolveAnchorDate('departure_date', null, trip);
    expect(d?.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });

  test('departure_date accepts trip.departureDate fallback (forward compat)', () => {
    const trip = { departureDate: new Date('2026-06-20T00:00:00.000Z') };
    const d = resolveAnchorDate('departure_date', null, trip);
    expect(d?.toISOString()).toBe('2026-06-20T00:00:00.000Z');
  });

  test('return_date uses trip.returnDate', () => {
    const trip = { returnDate: new Date('2026-06-30T00:00:00.000Z') };
    const d = resolveAnchorDate('return_date', null, trip);
    expect(d?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });

  test('issue_date prefers invoice.issuedAt over invoice.createdAt', () => {
    const invoice = {
      issuedAt: new Date('2026-05-01T00:00:00.000Z'),
      createdAt: new Date('2026-04-25T00:00:00.000Z'),
    };
    const d = resolveAnchorDate('issue_date', invoice, null);
    expect(d?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  test('issue_date falls back to invoice.createdAt when issuedAt missing', () => {
    const invoice = { createdAt: new Date('2026-04-25T00:00:00.000Z') };
    const d = resolveAnchorDate('issue_date', invoice, null);
    expect(d?.toISOString()).toBe('2026-04-25T00:00:00.000Z');
  });

  test('return_date with no trip + no invoice → null', () => {
    expect(resolveAnchorDate('return_date', null, null)).toBeNull();
  });

  test('invalid anchorType → null', () => {
    expect(resolveAnchorDate('bogus', {}, {})).toBeNull();
  });

  test('null safety — empty objects + null trip', () => {
    expect(resolveAnchorDate('booking_date', {}, null)).toBeNull();
    expect(resolveAnchorDate('booking_date', null, null)).toBeNull();
  });
});

describe('lib/scheduleAnchorResolver — computeDueDate', () => {
  test('positive offset adds days to anchor', () => {
    const trip = { departDate: new Date('2026-06-15T00:00:00.000Z') };
    const d = computeDueDate({
      anchorType: 'departure_date',
      anchorOffset: 30,
      trip,
    });
    expect(d?.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  test('negative offset subtracts days from anchor (advance reminder)', () => {
    const trip = { departDate: new Date('2026-06-15T00:00:00.000Z') };
    const d = computeDueDate({
      anchorType: 'departure_date',
      anchorOffset: -7,
      trip,
    });
    expect(d?.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });

  test('zero offset equals the anchor date', () => {
    const trip = { departDate: new Date('2026-06-15T00:00:00.000Z') };
    const d = computeDueDate({
      anchorType: 'departure_date',
      anchorOffset: 0,
      trip,
    });
    expect(d?.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });

  test('missing anchorType returns null', () => {
    expect(computeDueDate({ anchorOffset: 5 })).toBeNull();
  });

  test('missing anchorOffset returns null', () => {
    expect(computeDueDate({ anchorType: 'booking_date' })).toBeNull();
  });

  test('non-integer offset returns null', () => {
    const trip = { departDate: new Date('2026-06-15T00:00:00.000Z') };
    expect(
      computeDueDate({ anchorType: 'departure_date', anchorOffset: 3.5, trip }),
    ).toBeNull();
  });

  test('non-numeric offset returns null', () => {
    expect(
      computeDueDate({ anchorType: 'booking_date', anchorOffset: 'thirty' }),
    ).toBeNull();
  });

  test('unresolvable anchor returns null', () => {
    // departure_date requested but neither trip nor invoice has it.
    expect(
      computeDueDate({
        anchorType: 'departure_date',
        anchorOffset: 7,
        invoice: { createdAt: new Date() },
        trip: null,
      }),
    ).toBeNull();
  });

  test('does not mutate the source anchor date object', () => {
    const original = new Date('2026-06-15T00:00:00.000Z');
    const trip = { departDate: original };
    computeDueDate({ anchorType: 'departure_date', anchorOffset: 30, trip });
    expect(trip.departDate.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(original.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });

  test('null args returns null safely (no throw)', () => {
    expect(computeDueDate(null)).toBeNull();
    expect(computeDueDate({})).toBeNull();
    expect(computeDueDate({ anchorType: null, anchorOffset: null })).toBeNull();
  });
});
