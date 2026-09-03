import { useState, useRef } from 'react';
import { FileText } from 'lucide-react';
import { fetchApi } from '../../../../utils/api';
import { useNotify } from '../../../../utils/notify';
import { useFormAutosave } from '../../../../utils/useFormAutosave';
import { formatDate } from '../../../../utils/date';
import { labelStyle, inputStyle } from '../shared/helpers';
import { RestoredBanner, RxDetailModal } from '../shared/components';

const INITIAL_RX = {
  visitId: '',
  // `qty` is units DISPENSED off the shelf — blank means 1. Distinct from
  // `dosage`, which is how much the patient takes per administration.
  drugs: [{ name: '', drugId: '', strengthValue: '', strengthUnit: '', dosage: '', frequency: '', duration: '', qty: '' }],
  // How long the whole course runs. Optional: left blank the prescription has
  // no stated validity, which is NOT the same as expired.
  validityDays: '',
  instructions: '',
  // Structured clinical narrative. These are real Prescription columns.
  // They were previously recoverable only by a clinician knowing to type
  // "Diagnosis: ..." as a line inside the free-text Instructions box — a
  // parser built for Zylu-imported records — so on every prescription
  // written here they rendered as an em dash with no way to fill them.
  chiefComplaint: '',
  diagnosis: '',
  investigations: '',
  advice: '',
};

// Clinical narrative fields, in the order a clinician works through them.
// `key` is the Prescription column name, the request-body key and the
// parseRxInstructions output key, so the form, the API, the preview modal and
// the PDF all agree without a mapping table in between.
const CLINICAL_FIELDS = [
  { key: 'chiefComplaint', label: 'Chief complaint', placeholder: 'What the patient came in with' },
  { key: 'diagnosis', label: 'Diagnosis', placeholder: 'Clinical impression' },
  { key: 'investigations', label: 'Investigations', placeholder: 'Tests ordered or reviewed' },
  { key: 'advice', label: 'Advice / referrals', placeholder: 'Lifestyle advice, follow-up, onward referral' },
];

// Pull the leading numeric value out of a free-text default like "1 capsule" or
// "5 days" so we can pre-fill the numeric dosage / frequency / duration fields.
function extractNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  const str = String(value).trim();
  if (str === '') return '';
  const direct = parseInt(str, 10);
  if (!Number.isNaN(direct)) return direct;
  const match = str.match(/\d+/);
  return match ? parseInt(match[0], 10) : '';
}

// Typeahead over the tenant's Drug catalogue (GET /api/wellness/drugs?q=…).
// Free-text entry still works — selecting a row just auto-fills the sibling
// dosage/frequency/duration inputs from the drug's stored defaults.
/**
 * Stock chip for one catalogue row in the typeahead.
 *
 * A drug that isn't tracked (threshold 0) shows its count plainly rather than
 * a reassuring "in stock" — the clinic never said it was managing that one.
 */
function DrugStockTag({ drug }) {
  const qty = Number(drug.quantity ?? 0);
  const threshold = Number(drug.lowStockThreshold ?? 0);

  let fg = 'var(--text-secondary)';
  let label = `${qty} in stock`;
  if (qty <= 0) {
    fg = 'var(--danger-color)';
    label = 'out of stock';
  } else if (threshold > 0 && qty <= threshold) {
    fg = 'var(--warning-color)';
    label = `${qty} left — low`;
  } else if (threshold > 0) {
    fg = 'var(--success-color)';
  }

  return (
    <span style={{ fontSize: '0.75rem', fontWeight: 600, color: fg, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

function DrugAutocomplete({ value, onChange, onPick, onQuickAdd }) {
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);
  const blurTimerRef = useRef(null);

  const search = (q, pageNumber = 1, append = false) => {
    if (abortRef.current) abortRef.current.abort();

    const ac = new AbortController();
    abortRef.current = ac;

    const trimmed = (q || '').trim();

    const base =
      `/api/wellness/drugs?isActive=true&limit=20&page=${pageNumber}&fields=summary`;

    const url = trimmed
      ? `${base}&q=${encodeURIComponent(trimmed)}`
      : base;

    if (append) {
      setLoadingMore(true);
    }

    fetchApi(url, { signal: ac.signal, silent: true })
      .then((data) => {
        if (ac.signal.aborted) return;

        const rows = Array.isArray(data)
          ? data
          : (data?.items ?? []);

        if (append) {
          setResults((prev) => [...prev, ...rows]);
        } else {
          setResults(rows);
        }

        setPage(data?.page || pageNumber);
        setHasMore(Boolean(data?.hasMore));
      })
      .catch(() => {
        // typeahead is best effort
      })
      .finally(() => {
        setLoadingMore(false);
      });
  };

  const handleChange = (e) => {
    const next = e.target.value;

    onChange(next);
    setOpen(true);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      setPage(1);
      setHasMore(false);
      setResults([]);

      search(next, 1, false);
    }, 200);
  };

  const handleFocus = () => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }

    setOpen(true);
    setPage(1);
    search(value || '', 1, false);
  };

  const handleScroll = (e) => {
    const el = e.currentTarget;

    const isNearBottom =
      el.scrollTop + el.clientHeight >=
      el.scrollHeight - 40;

    if (
      isNearBottom &&
      hasMore &&
      !loadingMore
    ) {
      search(value || '', page + 1, true);
    }
  };

  const handleBlur = () => {
    blurTimerRef.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        placeholder="Drug name — start typing to search the catalogue"
        value={value}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        autoComplete="off"
        style={inputStyle}
      />
      {open && (results.length > 0 || (value || '').trim().length >= 2) && (
        <ul
          role="listbox"
          onScroll={handleScroll}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            maxHeight: 240,
            overflowY: 'auto',
            // --modal-bg is the only fully opaque surface token in BOTH
            // themes; --surface-color is translucent, which let the form
            // behind bleed through this list in light mode.
            background: 'var(--modal-bg)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            listStyle: 'none',
            padding: 4,
            margin: 0,
            zIndex: 20,
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          }}
        >
          {results.map((d) => (
            <li
              key={d.id}
              role="option"
              onMouseDown={(e) => { e.preventDefault(); onPick(d); setOpen(false); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover-bg)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={{
                padding: '0.45rem 0.6rem',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: '0.85rem',
                color: 'var(--text-primary)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.6rem' }}>
                <span style={{ fontWeight: 500 }}>
                  {d.name}
                  {d.strengthValue && d.strengthUnit && (
                    <span style={{ color: 'var(--text-secondary)', fontWeight: 400, marginLeft: 6 }}>
                      {d.strengthValue}{d.strengthUnit}
                    </span>
                  )}
                </span>
                {/* Stock at the point of prescribing — the doctor should know
                    before writing it, not after the patient asks. */}
                <DrugStockTag drug={d} />
              </div>
              {(d.genericName || d.dosageForm) && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                  {[d.genericName, d.dosageForm].filter(Boolean).join(' • ')}
                </div>
              )}
            </li>
          ))}
          {/* Nothing matched — offer to add it rather than leaving the doctor
              to type free text the catalogue will never learn about (and whose
              stock therefore can never be tracked). */}
          {!results.some(
            (d) => d.name.toLowerCase() === (value || '').trim().toLowerCase(),
          ) && (value || '').trim().length >= 2 && (
              <li
                role="option"
                onMouseDown={(e) => { e.preventDefault(); onQuickAdd((value || '').trim()); setOpen(false); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover-bg)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                style={{
                  padding: '0.45rem 0.6rem',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  color: 'var(--accent-color)',
                  borderTop: results.length > 0 ? '1px solid var(--border-color)' : 'none',
                  marginTop: results.length > 0 ? 4 : 0,
                }}
              >
                + Add &ldquo;{(value || '').trim()}&rdquo; to the drug catalogue
              </li>
            )}
        </ul>
      )}
    </div>
  );
}

// ── Prescribe tab ─────────────────────────────────────────────────
export default function PrescribeTab({ patient, onSaved }) {
  const notify = useNotify();
  const initial = { ...INITIAL_RX, visitId: patient.visits[0]?.id || '' };
  const [draft, setDraft, isDirty, clearDraft] = useFormAutosave(`rx-${patient.id}`, initial);
  const { visitId, drugs, validityDays, instructions, chiefComplaint, diagnosis, investigations, advice } = draft;
  const [saving, setSaving] = useState(false);
  const [openRx, setOpenRx] = useState(null);
  const [showAllPastRx, setShowAllPastRx] = useState(false);

  const pastRx = [...(patient.prescriptions || [])].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  );
  const visiblePastRx = showAllPastRx ? pastRx : pastRx.slice(0, 5);

  const setVisitId = (v) => setDraft((s) => ({ ...s, visitId: v }));
  const setInstructions = (v) => setDraft((s) => ({ ...s, instructions: v }));
  const setClinical = (key, v) => setDraft((s) => ({ ...s, [key]: v }));
  const setValidityDays = (v) => setDraft((s) => ({ ...s, validityDays: v }));
  const setDrug = (i, k, v) => {
    setDraft((s) => {
      const next = [...s.drugs];
      next[i] = { ...next[i], [k]: v };
      return { ...s, drugs: next };
    });
  };
  const addDrug = () => setDraft((s) => ({
    ...s,
    drugs: [...s.drugs, { name: '', drugId: '', strengthValue: '', strengthUnit: '', dosage: '', frequency: '', duration: '', qty: '' }],
  }));

  // Add a missing drug to the catalogue without leaving the consultation.
  // The row lands at quantity 0 and the admins are notified to set stock —
  // a prescriber guessing at counts is how a stock ledger becomes fiction.
  const quickAddDrug = async (index, name) => {
    try {
      const created = await fetchApi('/api/wellness/drugs/quick-add', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setDraft((st) => {
        const next = [...st.drugs];
        next[index] = { ...next[index], name: created.name, drugId: created.id || '' };
        return { ...st, drugs: next };
      });
      notify.success(
        created.created
          ? `${created.name} added to the catalogue. An admin has been asked to set its stock.`
          : `${created.name} is already in the catalogue.`,
      );
    } catch (_err) { /* fetchApi already toasted */ }
  };

  const validDrugs = drugs.filter((d) => d.name && d.name.trim());
  // Mirrors the server's derivation (issue date + N days) purely so the
  // clinician sees the date they are committing to. The backend recomputes it;
  // this is never sent.
  const lapseDate = validityDays
    ? formatDate(new Date(Date.now() + Number(validityDays) * 86400000))
    : '';
  const canSave = !!visitId && validDrugs.length > 0;

  const submit = async (e) => {
    e.preventDefault();
    if (!visitId) { notify.error('Pick a visit this prescription belongs to (or log a visit first).'); return; }
    if (validDrugs.length === 0) {
      notify.error('At least one drug name is required to save a prescription.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetchApi('/api/wellness/prescriptions', {
        method: 'POST',
        body: JSON.stringify({
          visitId, patientId: patient.id,
          drugs: validDrugs,
          // Omitted when blank so the backend stores null ("no stated
          // validity") rather than coercing an empty string to 0.
          ...(validityDays ? { validityDays: Number(validityDays) } : {}),
          instructions,
          chiefComplaint,
          diagnosis,
          investigations,
          advice,
        }),
      });
      clearDraft();
      onSaved();
      // Say what came off the shelf. A silent decrement is indistinguishable
      // from a broken one, and the doctor is the person who can spot a wrong
      // count while the patient is still in the room.
      const moved = res?.stock?.adjusted || [];
      const unknown = res?.stock?.unmatched || [];
      let msg = 'Prescription saved.';
      if (moved.length) {
        msg += ` Stock updated: ${moved.map((m) => `${m.name} −${m.units} (${m.quantityAfter} left)`).join(', ')}.`;
      }
      if (unknown.length) {
        msg += ` Not in the catalogue, so stock was not changed: ${unknown.join(', ')}.`;
      }
      notify.success(msg);
    } catch (_err) { /* fetchApi already toasted */ } finally { setSaving(false); }
  };

  return (
    <>
      {pastRx.length > 0 && (
        <div className="glass" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <FileText size={16} /> Past prescriptions ({pastRx.length})
            </h3>
            {pastRx.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllPastRx((v) => !v)}
                style={{ background: 'transparent', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', fontSize: '0.8rem' }}
              >
                {showAllPastRx ? 'Show recent only' : `Show all ${pastRx.length}`}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {visiblePastRx.map((rx) => {
              let drugList = [];
              try {
                const parsed = typeof rx.drugs === 'string' ? JSON.parse(rx.drugs) : rx.drugs;
                if (Array.isArray(parsed)) drugList = parsed;
              } catch { /* fall through to empty */ }
              const summary = drugList.length === 0
                ? '(no medications)'
                : drugList.slice(0, 3).map((d) => d.name).filter(Boolean).join(', ')
                + (drugList.length > 3 ? ` + ${drugList.length - 3} more` : '');
              return (
                <button
                  key={rx.id}
                  type="button"
                  onClick={() => setOpenRx(rx)}
                  style={{
                    textAlign: 'left',
                    padding: '0.6rem 0.75rem',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 8,
                    cursor: 'pointer',
                    color: 'var(--text-primary)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '0.5rem',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {summary}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                      {new Date(rx.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                      {rx.doctor?.name && <> • {rx.doctor.name}</>}
                      {rx.validUntil && (
                        <> • valid until {formatDate(rx.validUntil)}</>
                      )}
                    </div>
                  </div>
                  <FileText size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {openRx && (
        <RxDetailModal
          rx={openRx}
          patient={patient}
          onClose={() => setOpenRx(null)}
        />
      )}

      <form onSubmit={submit} className="glass" style={{ padding: '1.5rem' }}>
        <h3 style={{ marginBottom: '1rem' }}>New prescription</h3>

        {isDirty && <RestoredBanner onDiscard={clearDraft} />}

        <div style={{ marginBottom: '1rem' }}>
          <label style={labelStyle}>Tied to visit</label>
          <select value={visitId} onChange={(e) => setVisitId(e.target.value)} style={inputStyle} required>
            <option value="">— select visit —</option>
            {patient.visits.map((v) => (
              <option key={v.id} value={v.id}>
                {formatDate(v.visitDate)} — {v.service?.name || 'Consultation'}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '0.5rem' }}><label style={labelStyle}>Drugs</label></div>
        {drugs.map((d, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 0.8fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <DrugAutocomplete
              value={d.name}
              onChange={(v) => setDrug(i, 'name', v)}
              onQuickAdd={(name) => quickAddDrug(i, name)}
              onPick={(drug) => setDraft((s) => {
                const next = [...s.drugs];
                next[i] = {
                  ...next[i],
                  drugId: drug.id || '',
                  name: drug.name,
                  strengthValue: drug.strengthValue || '',
                  strengthUnit: drug.strengthUnit || '',
                  dosage: next[i].dosage || extractNumber(drug.defaultDosage) || '',
                  frequency: next[i].frequency || extractNumber(drug.defaultFrequency) || '',
                  duration: next[i].duration || extractNumber(drug.defaultDuration) || '',
                };
                return { ...s, drugs: next };
              })}
            />
            <input type="number" min="1" placeholder="Dosage" value={d.dosage} onChange={(e) => setDrug(i, 'dosage', e.target.value === '' ? '' : parseInt(e.target.value, 10) || '')} style={inputStyle} />
            <input type="number" min="1" placeholder="Frequency" value={d.frequency} onChange={(e) => setDrug(i, 'frequency', e.target.value === '' ? '' : parseInt(e.target.value, 10) || '')} style={inputStyle} />
            <input type="number" min="1" placeholder="Duration" value={d.duration} onChange={(e) => setDrug(i, 'duration', e.target.value === '' ? '' : parseInt(e.target.value, 10) || '')} style={inputStyle} />
            {/* Units taken off the shelf. Blank = 1, so stock still moves when
                the doctor fills nothing in — which is the common case. */}
            <input
              type="number"
              min="1"
              max="1000"
              placeholder="Qty"
              title="Units dispensed — leave blank for 1"
              value={d.qty}
              onChange={(e) => setDrug(i, 'qty', e.target.value === '' ? '' : parseInt(e.target.value, 10) || '')}
              style={inputStyle}
            />
          </div>
        ))}
        <button type="button" onClick={addDrug} style={{ background: 'transparent', border: '1px dashed rgba(255,255,255,0.15)', color: 'var(--text-secondary)', padding: '0.4rem 0.75rem', borderRadius: 8, cursor: 'pointer', fontSize: '0.8rem', marginBottom: '1rem' }}>
          + Add drug
        </button>

        <div style={{ marginBottom: '1rem' }}>
          <label style={labelStyle}>Validity</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <input
              type="number"
              min="1"
              max="365"
              placeholder="e.g. 30"
              value={validityDays}
              onChange={(e) => setValidityDays(e.target.value === '' ? '' : parseInt(e.target.value, 10) || '')}
              style={{ ...inputStyle, width: 140 }}
            />
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              days
              {/* Echo the resulting lapse date back live. Without it "30" is an
                  abstract number; with it the clinician can sanity-check the
                  date the patient will be prompted to renew. */}
              {lapseDate && <> — lapses <strong>{lapseDate}</strong></>}
            </span>
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.35rem' }}>
            Optional. How long this course should last — used to remind the
            patient to ask for a renewal before it runs out.
          </div>
        </div>

        {/* Clinical narrative. Each maps 1:1 to a Prescription column and to a
            row on the preview + PDF; a blank one is omitted from both rather
            than printed as an em dash. Laid out in the same auto-fit grid the
            rest of this form uses, so it reflows on a narrow viewport instead
            of forcing a horizontal scroll. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
            gap: '0.75rem',
            marginBottom: '1rem',
          }}
        >
          {CLINICAL_FIELDS.map(({ key, label, placeholder }) => (
            <div key={key}>
              <label style={labelStyle} htmlFor={`rx-${key}`}>{label}</label>
              <textarea
                id={`rx-${key}`}
                value={draft[key]}
                onChange={(e) => setClinical(key, e.target.value)}
                rows={2}
                placeholder={placeholder}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </div>
          ))}
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label style={labelStyle}>Instructions</label>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.35rem' }}>
            Free-text notes for the patient. Clinical detail belongs in the
            fields above.
          </div>
        </div>

        <button
          type="submit"
          disabled={saving || !canSave}
          title={!canSave ? 'Pick a visit and enter at least one drug name' : ''}
          style={{
            padding: '0.55rem 1.25rem',
            background: canSave ? 'var(--success-color)' : 'rgba(107,114,128,0.3)',
            color: '#fff', border: 'none', borderRadius: 8,
            cursor: canSave && !saving ? 'pointer' : 'not-allowed',
            opacity: canSave ? 1 : 0.6,
          }}
        >
          {saving ? 'Saving…' : 'Save prescription'}
        </button>
      </form>
    </>
  );
}
