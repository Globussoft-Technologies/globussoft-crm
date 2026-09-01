/**
 * RxDetailModal.test.jsx — prescription preview table contract.
 *
 * Tester-filed bug: "Prescription Preview table does not match with the Drug
 * input form."
 *
 * The preview rendered ten columns — No. / Drug Name / Strength / Preparation /
 * Route / Dosage / Direction / Frequency / Instructions / Start Date — but the
 * prescribing form in PrescribeTab.jsx only ever writes:
 *
 *     { name, drugId, strengthValue, strengthUnit, dosage, frequency, duration, qty }
 *
 * So five columns (Preparation, Route, Direction, Instructions, Start Date)
 * had no writer anywhere in the app and rendered "—" on every prescription
 * ever created, while Duration and Qty — which the form DOES capture — had no
 * column at all and were silently dropped from the preview.
 *
 * These tests pin the table to the form's actual field set in both
 * directions, so neither a dead column nor a dropped field can come back.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('../../utils/api', () => ({
  getAuthToken: () => 'test-token',
  fetchApi: vi.fn(() => Promise.resolve({})),
}));

const notifyObj = { error: vi.fn(), info: vi.fn(), success: vi.fn(), confirm: vi.fn() };
vi.mock('../../utils/notify', () => ({ useNotify: () => notifyObj }));

import { RxDetailModal } from '../../pages/wellness/patientDetail/shared/components';

// Exactly the shape PrescribeTab.jsx writes — nothing more.
const RX = {
  id: 503,
  createdAt: '2026-08-28T10:00:00Z',
  instructions: 'good',
  drugs: JSON.stringify([
    {
      name: '360 Block Sunscreen',
      drugId: 12,
      strengthValue: '50',
      strengthUnit: 'gm',
      dosage: 2,
      frequency: 2,
      duration: 2,
      qty: 3,
    },
    // Blank qty — the form's Qty input is annotated "leave blank for 1".
    { name: 'Biotin', dosage: 1, frequency: 1, duration: 1, qty: '' },
  ]),
};

const PATIENT = { id: 5398, name: 'CRM 1' };

function renderModal() {
  return render(<RxDetailModal rx={RX} patient={PATIENT} onClose={() => {}} />);
}

/** The medications table, located by its "Drug Name" header. */
function drugTable() {
  return screen.getByRole('columnheader', { name: /drug name/i }).closest('table');
}

describe('RxDetailModal — prescription preview table', () => {
  it('renders a column for every field the prescribing form captures', () => {
    renderModal();
    const headers = within(drugTable())
      .getAllByRole('columnheader')
      .map((th) => th.textContent.trim());

    expect(headers).toEqual([
      'No.',
      'Drug Name',
      'Strength',
      'Dosage',
      'Frequency',
      'Duration',
      'Qty',
    ]);
  });

  it('renders no column the form cannot fill', () => {
    renderModal();
    const headers = within(drugTable())
      .getAllByRole('columnheader')
      .map((th) => th.textContent.trim().toLowerCase());

    // Nothing in the app has ever written these onto a prescription drug row,
    // so a column for one is guaranteed to render an em dash forever.
    for (const dead of ['preparation', 'route', 'direction', 'instructions', 'start date']) {
      expect(headers).not.toContain(dead);
    }
  });

  it('shows the Duration and Qty the form captured', () => {
    renderModal();
    const rows = within(drugTable()).getAllByRole('row');
    // rows[0] is the header row.
    const first = within(rows[1]).getAllByRole('cell').map((c) => c.textContent.trim());

    expect(first[1]).toBe('360 Block Sunscreen');
    expect(first[2]).toBe('50gm');   // strengthValue + strengthUnit
    expect(first[3]).toBe('2');      // dosage
    expect(first[4]).toBe('2');      // frequency
    expect(first[5]).toBe('2 days'); // duration, unit-labelled
    expect(first[6]).toBe('3');      // qty — previously had nowhere to render
  });

  it('renders the clinical narrative from the real Prescription columns', () => {
    render(
      <RxDetailModal
        rx={{
          ...RX,
          chiefComplaint: 'Itchy scalp for three weeks',
          diagnosis: 'Seborrheic dermatitis',
          investigations: 'KOH mount negative',
          advice: 'Review in four weeks',
        }}
        patient={PATIENT}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Itchy scalp for three weeks/)).toBeInTheDocument();
    expect(screen.getByText(/Seborrheic dermatitis/)).toBeInTheDocument();
    expect(screen.getByText(/KOH mount negative/)).toBeInTheDocument();
    expect(screen.getByText(/Review in four weeks/)).toBeInTheDocument();
  });

  it('falls back to the instructions parser for a Zylu-imported prescription', () => {
    // Columns null; the narrative lives inline in the migrated free text.
    render(
      <RxDetailModal
        rx={{
          id: 900,
          drugs: '[]',
          instructions: '[ZYLU-#4412]\nChief Complaint: Hair fall\nDiagnosis: Androgenetic alopecia',
        }}
        patient={PATIENT}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Hair fall/)).toBeInTheDocument();
    expect(screen.getByText(/Androgenetic alopecia/)).toBeInTheDocument();
  });

  it('hides a clinical row that has nothing on either side', () => {
    renderModal(); // RX carries no clinical columns and no prefixed text
    // The complaint that started this: four permanently-empty rows on every
    // prescription written in this CRM.
    expect(screen.queryByText(/Chief Complaint/i)).toBeNull();
    expect(screen.queryByText(/Diagnosis/i)).toBeNull();
    expect(screen.queryByText(/Investigations/i)).toBeNull();
    expect(screen.queryByText(/Advice\/Referrals/i)).toBeNull();
  });

  it('does not print a junk strength snapshotted before the catalogue was validated', () => {
    // strengthValue "-" / strengthUnit "-gm" was accepted by the Drug
    // catalogue before its write path was validated, and joined to "--gm"
    // here. A prescription snapshots strength at issue time, so repairing the
    // catalogue row cannot fix scripts already written off it.
    render(
      <RxDetailModal
        rx={{
          id: 504,
          drugs: JSON.stringify([
            { name: '360 Block Sunscreen', strengthValue: '-', strengthUnit: '-gm', dosage: 2, frequency: 2, duration: 2, qty: 1 },
          ]),
        }}
        patient={PATIENT}
        onClose={() => {}}
      />,
    );
    const rows = within(drugTable()).getAllByRole('row');
    const cells = within(rows[1]).getAllByRole('cell').map((c) => c.textContent.trim());

    expect(cells[1]).toBe('360 Block Sunscreen');
    expect(cells[2]).toBe('—');
    expect(cells[2]).not.toContain('gm');
  });

  it('treats a blank qty as 1, matching the form’s own annotation', () => {
    renderModal();
    const rows = within(drugTable()).getAllByRole('row');
    const second = within(rows[2]).getAllByRole('cell').map((c) => c.textContent.trim());

    expect(second[1]).toBe('Biotin');
    expect(second[5]).toBe('1 day'); // singular
    expect(second[6]).toBe('1');     // blank dispenses one unit
  });
});
