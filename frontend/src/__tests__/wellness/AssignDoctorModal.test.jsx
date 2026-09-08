/**
 * AssignDoctorModal.test.jsx — the "assign a doctor to this appointment" picker.
 *
 * THE BUG THIS PINS
 *   The modal asked `/doctors/availability?date=…` and nothing more, so the
 *   endpoint could only answer day-level questions — leave and block-times. A
 *   doctor who already held an appointment in this very slot was still offered,
 *   the admin picked them, and the server rejected the assignment with
 *   SLOT_TAKEN only after the click.
 *
 *   It now sends the slot's `time` (plus `serviceId` to size it, and
 *   `excludeVisitId` so the appointment being assigned never counts as its own
 *   conflict), and renders the specific reason a doctor can't be chosen.
 *
 * The server-side guard remains the authority — this is about not offering a
 * choice that is going to be refused.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../../utils/api', () => ({ fetchApi: vi.fn() }));

import AssignDoctorModal from '../../pages/wellness/calendar/AssignDoctorModal';
import { fetchApi } from '../../utils/api';

const notify = { error: vi.fn(), success: vi.fn(), info: vi.fn() };

// 2026-09-10 14:30 local — the modal derives its date/time from this instant.
const VISIT = {
  id: 555,
  visitDate: new Date(2026, 8, 10, 14, 30).toISOString(),
  serviceId: 42,
};

const DOCTORS = [
  { id: 7, name: 'Dr Rao', specialty: 'Derm', wellnessRole: 'doctor', available: true, unavailableReason: null },
  { id: 8, name: 'Dr Singh', specialty: null, wellnessRole: 'doctor', available: false, unavailableReason: 'Already booked at this time', conflictVisitId: 900 },
  { id: 9, name: 'Dr Menon', specialty: null, wellnessRole: 'doctor', available: false, unavailableReason: 'On leave' },
];

let lastUrl;

beforeEach(() => {
  vi.clearAllMocks();
  lastUrl = null;
  fetchApi.mockImplementation(async (url) => {
    lastUrl = url;
    if (url.includes('/doctors/availability')) return DOCTORS;
    return {};
  });
});

function renderModal(visit = VISIT) {
  return render(
    <AssignDoctorModal visit={visit} notify={notify} onClose={() => {}} onAssigned={() => {}} />,
  );
}

describe('AssignDoctorModal', () => {
  it('asks about the appointment’s exact SLOT, not just its day', async () => {
    renderModal();
    await waitFor(() => expect(lastUrl).toBeTruthy());

    const url = new URL(lastUrl, 'http://x');
    expect(url.searchParams.get('date')).toBe('2026-09-10');
    // The whole fix: without `time` the endpoint cannot know about existing
    // appointments in this slot.
    expect(url.searchParams.get('time')).toBe('14:30');
  });

  it('sizes the slot by the booked service', async () => {
    renderModal();
    await waitFor(() => expect(lastUrl).toBeTruthy());
    expect(new URL(lastUrl, 'http://x').searchParams.get('serviceId')).toBe('42');
  });

  it('excludes the appointment being assigned from its own conflict check', async () => {
    renderModal();
    await waitFor(() => expect(lastUrl).toBeTruthy());
    expect(new URL(lastUrl, 'http://x').searchParams.get('excludeVisitId')).toBe('555');
  });

  it('offers a free doctor and refuses a doctor already booked in the slot', async () => {
    renderModal();
    await screen.findByText('Dr Rao');

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    // Dr Rao is free; Dr Singh is already booked in this slot and Dr Menon is
    // on leave — neither can be selected.
    expect(radios[0]).toBeEnabled();
    expect(radios[1]).toBeDisabled();
    expect(radios[2]).toBeDisabled();
  });

  it('says WHY each doctor cannot be picked, rather than a bare "Unavailable"', async () => {
    renderModal();
    await screen.findByText('Dr Singh');
    // Different problems, different fixes — the operator needs to tell them apart.
    expect(screen.getByText('Already booked at this time')).toBeInTheDocument();
    expect(screen.getByText('On leave')).toBeInTheDocument();
  });

  it('falls back to a day-level question when the visit time is unusable', async () => {
    renderModal({ id: 1, visitDate: 'not-a-date' });
    // Nothing to ask about — the modal must not fire a request with NaN in it.
    await waitFor(() => {
      const called = fetchApi.mock.calls.map((c) => c[0]).filter(Boolean);
      expect(called.every((u) => !String(u).includes('NaN'))).toBe(true);
    });
  });
});
