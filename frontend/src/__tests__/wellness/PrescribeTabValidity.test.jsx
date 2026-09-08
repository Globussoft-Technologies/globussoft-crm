/**
 * PrescribeTabValidity.test.jsx — the "Validity" field on the New prescription
 * form.
 *
 * Validity is what the renewal reminder will fire against, so the risk is a
 * field that looks filled in but never reaches the server, or one that sends
 * a value the backend then rejects. Pinned here:
 *   1. The field renders and is optional — a prescription saves without it,
 *      and the payload omits `validityDays` entirely rather than sending ''
 *      or 0 (both of which the backend would read differently from "unset").
 *   2. A stated validity is sent as a NUMBER.
 *   3. The resulting lapse date is echoed back live, so "30" isn't an abstract
 *      number the clinician has to convert in their head.
 *   4. Past prescriptions show their validity, so a saved value is verifiable
 *      without opening the row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'fake-token',
}));

const notifySuccess = vi.fn();
const notifyError = vi.fn();
vi.mock('../../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    success: notifySuccess,
    info: vi.fn(),
    confirm: () => Promise.resolve(true),
  }),
}));

vi.mock('../../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

// The real autosave hook persists to storage; here it just needs to hold
// state so typing actually updates the draft.
vi.mock('../../utils/useFormAutosave', () => {
  const { useState } = require('react');
  return {
    useFormAutosave: (_key, initial) => {
      const [draft, setDraft] = useState(initial);
      return [draft, setDraft, false, () => {}];
    },
  };
});

import PrescribeTab from '../../pages/wellness/patientDetail/tabs/PrescribeTab';

const PATIENT = {
  id: 2965,
  name: 'Mohit das',
  visits: [{ id: 4, visitDate: '2026-08-26T09:00:00.000Z', service: { name: 'Basic FUE' } }],
  prescriptions: [
    {
      id: 366,
      createdAt: '2026-08-26T09:00:00.000Z',
      drugs: [{ name: 'Minoxidil 5%' }],
      doctor: { name: 'Rupal Sharma' },
      validityDays: 30,
      validUntil: '2026-09-25T09:00:00.000Z',
    },
    {
      id: 369,
      createdAt: '2026-07-24T09:00:00.000Z',
      drugs: [{ name: 'Amoxicillin 500mg' }],
      doctor: { name: 'DOCTOR MANSI' },
      validityDays: null,
      validUntil: null,
    },
  ],
};

function renderTab() {
  return render(<PrescribeTab patient={PATIENT} onSaved={() => {}} />);
}

/** Fill the one required drug name so the form can be submitted. */
function fillDrug() {
  const drug = screen.getByPlaceholderText(/Drug name/i);
  fireEvent.change(drug, { target: { value: 'Amoxicillin 500mg' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchApiMock.mockResolvedValue({ id: 999 });
});

describe('PrescribeTab — validity', () => {
  it('renders the field as optional, with the reminder rationale on it', () => {
    renderTab();
    expect(screen.getByText('Validity')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. 30')).toBeInTheDocument();
    expect(screen.getByText(/remind the patient to ask for a renewal/i)).toBeInTheDocument();
  });

  it('omits validityDays entirely when left blank', async () => {
    renderTab();
    fillDrug();
    fireEvent.click(screen.getByRole('button', { name: /Save prescription/i }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/wellness/prescriptions' && c[1]?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      // Not '' and not 0 — the backend reads absence as "no stated validity",
      // and either of those would mean something different.
      expect('validityDays' in body).toBe(false);
    });
  });

  it('sends a stated validity as a number', async () => {
    renderTab();
    fillDrug();
    fireEvent.change(screen.getByPlaceholderText('e.g. 30'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /Save prescription/i }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/wellness/prescriptions' && c[1]?.method === 'POST',
      );
      const body = JSON.parse(post[1].body);
      expect(body.validityDays).toBe(30);
      expect(typeof body.validityDays).toBe('number');
    });
  });

  it('echoes the resulting lapse date back as the clinician types', () => {
    renderTab();
    expect(screen.queryByText(/lapses/i)).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('e.g. 30'), { target: { value: '30' } });

    const expected = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    expect(screen.getByText(/lapses/i)).toBeInTheDocument();
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('shows validity on past prescriptions that have one, and nothing on those that do not', () => {
    renderTab();
    // Rx 366 states 30 days → 2026-09-25.
    expect(screen.getByText(/valid until 2026-09-25/i)).toBeInTheDocument();
    // Rx 369 has none — no "valid until" for it, and crucially no "—" that
    // would read as an expiry the clinician never set.
    expect(screen.getAllByText(/valid until/i)).toHaveLength(1);
  });
});
