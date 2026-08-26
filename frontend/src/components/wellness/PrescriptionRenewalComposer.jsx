import { useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { asDrugArray, drugLabel } from '../../hooks/usePrescriptionRenewals';
import ModalShell from './ModalShell';

/**
 * Patient-side "ask for a repeat" UI, shared by the two surfaces that offer it.
 *
 * Two pages need this and they must not drift:
 *   - /wellness/my-prescriptions        — the action ON the prescription card,
 *                                         which is where a patient looking at
 *                                         their medicines actually expects it.
 *   - /wellness/my-prescription-requests — the dedicated page that tracks what
 *                                         they have already asked for.
 *
 * Both talk to the SAME `/api/wellness/portal/prescription-requests` pair the
 * Android app uses, so a request raised from either page is the same row the
 * clinic sees in its queue.
 *
 * The "which prescriptions already have a request open" gate lives in
 * hooks/usePrescriptionRenewals.js, so this file exports only a component.
 *
 * Rendered through <ModalShell>, which portals to document.body. That is not
 * cosmetic: the app shell's <main> carries `animation: fadeIn ... forwards`
 * whose final frame is `transform: translateY(0)`, and a non-none transform
 * makes an element the containing block for `position: fixed` descendants. An
 * in-place fixed overlay therefore anchors to the TOP OF MAIN'S SCROLLED
 * CONTENT rather than the viewport — click the action on a card far down the
 * list and the dialog renders far above the fold, with only its footer slice
 * visible. Portalling out of <main> is what makes it land on screen.
 */

/**
 * The ask.
 *
 * Defaults to "the whole prescription" because that is both the most common
 * case and the one the API treats as the ABSENCE of a selection — so the
 * patient only touches the checkboxes when they want less than everything, and
 * the default payload omits `medicines` entirely rather than sending every name.
 */
export default function PrescriptionRenewalComposer({
  prescription,
  onClose,
  onSubmitted,
  notify,
}) {
  const drugs = useMemo(
    () => asDrugArray(prescription?.drugs),
    [prescription],
  );
  const [wholeRx, setWholeRx] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const [durationDays, setDurationDays] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const toggle = (name) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const submit = async () => {
    if (saving) return;
    if (!wholeRx && selected.size === 0) {
      notify.error('Pick at least one medicine, or ask for the whole prescription.');
      return;
    }
    setSaving(true);
    try {
      await fetchApi('/api/wellness/portal/prescription-requests', {
        method: 'POST',
        body: JSON.stringify({
          prescriptionId: prescription.id,
          ...(wholeRx ? {} : { medicines: [...selected] }),
          ...(durationDays ? { durationDays: Number(durationDays) } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });
      onSubmitted();
    } catch (err) {
      notify.error(err?.message || 'Could not send your request');
    } finally {
      setSaving(false);
    }
  };

  if (!prescription) return null;

  const doctorName = prescription.doctor?.name || prescription.doctorName;

  return (
    <ModalShell
      title="Request a renewal"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" onClick={onClose} style={secondaryButton}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            style={{ ...primaryButton, opacity: saving ? 0.6 : 1 }}
          >
            {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            Send request
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: '1rem' }}>
        <div style={muted}>
          Prescription #{prescription.id}
          {doctorName ? ` · Dr ${doctorName}` : ''}
        </div>

        <label style={checkRow}>
          <input
            type="checkbox"
            checked={wholeRx}
            onChange={(e) => setWholeRx(e.target.checked)}
          />
          <span>Renew the complete prescription</span>
        </label>

        {!wholeRx && (
          <div style={{ display: 'grid', gap: '0.4rem' }}>
            <div style={muted}>Choose the medicines you need:</div>
            {drugs.map((d, i) => {
              const name = d?.name || d?.drugName || '';
              return (
                <label key={`${name}-${i}`} style={checkRow}>
                  <input
                    type="checkbox"
                    checked={selected.has(name)}
                    onChange={() => toggle(name)}
                  />
                  <span>{drugLabel(d)}</span>
                </label>
              );
            })}
          </div>
        )}

        <label style={{ display: 'grid', gap: '0.3rem' }}>
          <span style={muted}>How long do you need it for? (optional)</span>
          <input
            type="number"
            min="1"
            max="365"
            placeholder="e.g. 60 days"
            value={durationDays}
            onChange={(e) => setDurationDays(e.target.value)}
            style={input}
          />
        </label>

        <label style={{ display: 'grid', gap: '0.3rem' }}>
          <span style={muted}>Anything the clinic should know? (optional)</span>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. the 10mg made me drowsy"
            style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }}
          />
        </label>
      </div>
    </ModalShell>
  );
}

const muted = { fontSize: '0.82rem', color: 'var(--text-secondary)' };

const checkRow = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontSize: '0.9rem',
  cursor: 'pointer',
};

const input = {
  width: '100%',
  padding: '0.5rem 0.7rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--subtle-bg-2)',
  color: 'inherit',
  fontSize: '0.9rem',
};

const secondaryButton = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.45rem 0.85rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--subtle-bg-2)',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: '0.85rem',
};

const primaryButton = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.45rem 0.9rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff',
  cursor: 'pointer',
  fontSize: '0.85rem',
  fontWeight: 600,
};
