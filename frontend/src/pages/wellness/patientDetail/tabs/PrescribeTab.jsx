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
  drugs: [{ name: '', dosage: '', frequency: '', duration: '' }],
  instructions: '',
};

// Typeahead over the tenant's Drug catalogue (GET /api/wellness/drugs?q=…).
// Free-text entry still works — selecting a row just auto-fills the sibling
// dosage/frequency/duration inputs from the drug's stored defaults.
function DrugAutocomplete({ value, onChange, onPick }) {
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);
  const blurTimerRef = useRef(null);

  const search = (q) => {
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const trimmed = (q || '').trim();
    const url = trimmed
      ? `/api/wellness/drugs?q=${encodeURIComponent(trimmed)}&isActive=true&limit=20`
      : `/api/wellness/drugs?isActive=true&limit=20`;
    fetchApi(url, { signal: ac.signal, silent: true })
      .then((data) => {
        if (ac.signal.aborted) return;
        setResults(Array.isArray(data) ? data : []);
      })
      .catch(() => { /* typeahead is best-effort; ignore failures */ });
  };

  const handleChange = (e) => {
    const next = e.target.value;
    onChange(next);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(next), 200);
  };

  const handleFocus = () => {
    if (blurTimerRef.current) { clearTimeout(blurTimerRef.current); blurTimerRef.current = null; }
    setOpen(true);
    search(value || '');
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
      {open && results.length > 0 && (
        <ul
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            maxHeight: 240,
            overflowY: 'auto',
            background: 'var(--surface-color, #1f2937)',
            border: '1px solid rgba(255,255,255,0.1)',
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
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={{
                padding: '0.45rem 0.6rem',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: '0.85rem',
                color: 'var(--text-primary)',
              }}
            >
              <div style={{ fontWeight: 500 }}>
                {d.name}
                {d.strengthValue && d.strengthUnit && (
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 400, marginLeft: 6 }}>
                    {d.strengthValue}{d.strengthUnit}
                  </span>
                )}
              </div>
              {(d.genericName || d.dosageForm) && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                  {[d.genericName, d.dosageForm].filter(Boolean).join(' • ')}
                </div>
              )}
            </li>
          ))}
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
  const { visitId, drugs, instructions } = draft;
  const [saving, setSaving] = useState(false);
  const [openRx, setOpenRx] = useState(null);
  const [showAllPastRx, setShowAllPastRx] = useState(false);

  const pastRx = [...(patient.prescriptions || [])].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  );
  const visiblePastRx = showAllPastRx ? pastRx : pastRx.slice(0, 5);

  const setVisitId = (v) => setDraft((s) => ({ ...s, visitId: v }));
  const setInstructions = (v) => setDraft((s) => ({ ...s, instructions: v }));
  const setDrug = (i, k, v) => {
    setDraft((s) => {
      const next = [...s.drugs];
      next[i] = { ...next[i], [k]: v };
      return { ...s, drugs: next };
    });
  };
  const addDrug = () => setDraft((s) => ({
    ...s,
    drugs: [...s.drugs, { name: '', dosage: '', frequency: '', duration: '' }],
  }));

  const validDrugs = drugs.filter((d) => d.name && d.name.trim());
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
      await fetchApi('/api/wellness/prescriptions', {
        method: 'POST',
        body: JSON.stringify({
          visitId, patientId: patient.id,
          drugs: validDrugs,
          instructions,
        }),
      });
      clearDraft();
      onSaved();
      notify.success('Prescription saved.');
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
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <DrugAutocomplete
              value={d.name}
              onChange={(v) => setDrug(i, 'name', v)}
              onPick={(drug) => setDraft((s) => {
                const next = [...s.drugs];
                next[i] = {
                  ...next[i],
                  name: drug.name,
                  dosage: next[i].dosage || drug.defaultDosage || '',
                  frequency: next[i].frequency || drug.defaultFrequency || '',
                  duration: next[i].duration || drug.defaultDuration || '',
                };
                return { ...s, drugs: next };
              })}
            />
            <input placeholder="Dosage" value={d.dosage} onChange={(e) => setDrug(i, 'dosage', e.target.value)} style={inputStyle} />
            <input placeholder="Frequency" value={d.frequency} onChange={(e) => setDrug(i, 'frequency', e.target.value)} style={inputStyle} />
            <input placeholder="Duration" value={d.duration} onChange={(e) => setDrug(i, 'duration', e.target.value)} style={inputStyle} />
          </div>
        ))}
        <button type="button" onClick={addDrug} style={{ background: 'transparent', border: '1px dashed rgba(255,255,255,0.15)', color: 'var(--text-secondary)', padding: '0.4rem 0.75rem', borderRadius: 8, cursor: 'pointer', fontSize: '0.8rem', marginBottom: '1rem' }}>
          + Add drug
        </button>

        <div style={{ marginBottom: '1rem' }}>
          <label style={labelStyle}>Instructions</label>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
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
