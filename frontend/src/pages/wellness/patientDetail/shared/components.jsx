import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, FileText, Download, Eye } from 'lucide-react';
import { getAuthToken } from '../../../../utils/api';
import { useNotify } from '../../../../utils/notify';
import { computeAgeFromDob, sexLabel, parseRxInstructions, th, td } from './helpers';
import TopScrollSync from '../../../../components/TopScrollSync';

// #226: shown above autosaved forms when a draft has been rehydrated from
// sessionStorage. Lets the user discard the restored input in one click.
export function RestoredBanner({ onDiscard }) {
  return (
    <div style={{
      marginBottom: '0.75rem', padding: '0.5rem 0.75rem',
      background: 'rgba(205,148,129,0.10)', border: '1px solid rgba(205,148,129,0.25)',
      borderRadius: 8, fontSize: '0.8rem', color: 'var(--text-primary)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
    }}>
      <span>Restored from your previous session.</span>
      <button type="button" onClick={onDiscard} style={{
        background: 'transparent', border: '1px solid rgba(205,148,129,0.4)',
        color: 'var(--text-primary)', padding: '0.25rem 0.6rem', borderRadius: 6,
        cursor: 'pointer', fontSize: '0.75rem',
      }}>
        Discard
      </button>
    </div>
  );
}

// Clinical-format Rx detail modal: patient demographics → chief complaint /
// diagnosis / investigations / advice → prescriptions table → notes.
//
// The narrative sections are real Prescription columns, written by the
// prescribing form. A Zylu-imported prescription carries them inside its
// free-text `instructions` instead, so parseRxInstructions remains the
// fallback reader for those rows. A section with nothing on either side is
// omitted rather than printed as an em dash.

// The clinical narrative rows, in the order a clinician reads them. `key` is
// both the Prescription column name and the parseRxInstructions output key, so
// one lookup covers a natively-written prescription and a Zylu-imported one.
const CLINICAL_ROWS = [
  { key: 'chiefComplaint', label: 'Chief Complaint' },
  { key: 'diagnosis', label: 'Diagnosis' },
  { key: 'investigations', label: 'Investigations' },
  { key: 'advice', label: 'Advice/Referrals' },
];

export function RxDetailModal({ rx, patient, onClose }) {
  const notify = useNotify();
  const [downloading, setDownloading] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    const body = document.body;
    const html = document.documentElement;

    const originalBodyOverflow = body.style.overflow;
    const originalHtmlOverflow = html.style.overflow;

    body.style.overflow = 'hidden';
    html.style.overflow = 'hidden';

    return () => {
      body.style.overflow = originalBodyOverflow;
      html.style.overflow = originalHtmlOverflow;
    };
  }, []);
  let drugs = [];
  try { drugs = typeof rx.drugs === 'string' ? JSON.parse(rx.drugs) : rx.drugs; } catch { drugs = []; }
  if (!Array.isArray(drugs)) drugs = [];

  const parsed = parseRxInstructions(rx.instructions);
  const status = parsed.status || 'Issued';
  const age = computeAgeFromDob(patient?.dob);

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/wellness/prescriptions/${rx.id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `PDF download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `prescription-${rx.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      notify.error(err.message || 'Failed to download prescription PDF.');
    } finally {
      setDownloading(false);
    }
  };

  const previewPdf = async () => {
    setPreviewing(true);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/wellness/prescriptions/${rx.id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `PDF preview failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      notify.error(err.message || 'Failed to open prescription PDF.');
    } finally {
      setPreviewing(false);
    }
  };

  const headerRowStyle = {
    background: 'rgba(255,255,255,0.03)',
    padding: '0.6rem 0.85rem',
    borderRadius: 6,
    marginBottom: '0.5rem',
    fontSize: '0.85rem',
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, width: '100vw',
        height: '100vh', background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, overflow: 'hidden',
        overscrollBehavior: 'none',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{
          width: '95%',
          maxWidth: 1080,
          maxHeight: '90vh',
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '1.5rem',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.05rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <FileText size={18} /> Prescription #{rx.id}
          </h2>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: '0.4rem', marginBottom: '1rem', padding: '0.85rem', background: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
          <div style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
            <div><strong>Patient Name:</strong> {patient?.name || '—'}</div>
            <div><strong>Age:</strong> {age || '—'}</div>
            <div><strong>Sex:</strong> {sexLabel(patient?.gender) || '—'}</div>
            <div><strong>Status:</strong> <span style={{ color: 'var(--success-color, #10b981)' }}>{status}</span></div>
          </div>
          <div style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
            <div><strong>Patient ID:</strong> {patient?.id || '—'}</div>
            <div><strong>Prescriber:</strong> {rx.doctor?.name || '—'}</div>
            {rx.doctor?.registrationNumber && (
              <div><strong>Registration Number:</strong> {rx.doctor.registrationNumber}</div>
            )}
            <div><strong>Date:</strong> {new Date(rx.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
            {/* Only rendered when a validity was stated — a prescription
                without one is not expired, it simply has no end date, and
                printing "Valid until —" would imply otherwise. */}
            {rx.validUntil && (
              <div>
                <strong>Valid until:</strong>{' '}
                {new Date(rx.validUntil).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
                {rx.validityDays ? ` (${rx.validityDays} days)` : ''}
              </div>
            )}
          </div>
        </div>

        {/* Real columns first, legacy parser second. These four used to be
            recovered ONLY by scanning `instructions` for "Diagnosis:"-style
            prefixes — a reader built for Zylu-imported rows that nothing in
            this CRM ever wrote, so they were permanently blank on anything
            written here. They are columns now; the parser stays as the
            fallback so migrated prescriptions keep showing their narrative.

            Rows render only when they carry something. Four unfillable em
            dashes on every prescription was the complaint that started this,
            and the PDF has always gated the same block on `hasClinical`. */}
        {CLINICAL_ROWS.map(({ key, label }) => {
          const value = (rx[key] != null && String(rx[key]).trim()) || parsed[key];
          if (!value) return null;
          return (
            <div key={key} style={{ ...headerRowStyle, whiteSpace: 'pre-wrap' }}>
              <strong>{label}:</strong> {value}
            </div>
          );
        })}

        <h3 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '1rem 0 0.4rem' }}>Prescriptions</h3>
        <div style={{ marginBottom: '1rem' }}>
        <TopScrollSync>
          {/* Columns mirror the prescribing form in PrescribeTab.jsx exactly.
              They used to include Preparation / Route / Direction /
              Instructions / Start Date — five fields nothing in the app has
              ever written, so every prescription rendered five columns of
              "—" — while Duration and Qty, which the form DOES capture, had
              no column at all and were silently dropped from the preview.
              If a per-drug field is added to the form, add its column here. */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', minWidth: 560 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                <th style={th}>No.</th>
                <th style={th}>Drug Name</th>
                <th style={th}>Strength</th>
                <th style={th}>Dosage</th>
                <th style={th}>Frequency</th>
                <th style={th}>Duration</th>
                <th style={th}>Qty</th>
              </tr>
            </thead>
            <tbody>
              {drugs.length === 0 ? (
                <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: 'var(--text-secondary)' }}>(no medications listed)</td></tr>
              ) : drugs.map((d, i) => {
                // A prescription SNAPSHOTS the strength at issue time, so
                // cleaning a bad catalogue row does not retro-fix scripts
                // already written off it. Guard here too: a value with no
                // digit ("-") is not a strength, and a unit on its own is
                // meaningless — that pair is what printed as "--gm".
                const rawStrengthValue = d.strengthValue == null ? '' : String(d.strengthValue).trim();
                const rawStrengthUnit = d.strengthUnit == null ? '' : String(d.strengthUnit).trim();
                const strength = /[0-9]/.test(rawStrengthValue)
                  ? [rawStrengthValue, rawStrengthUnit].filter(Boolean).join('')
                  : (/[0-9]/.test(String(d.strength || '')) ? String(d.strength) : '—');
                // Duration is captured as a plain number of days; label the
                // unit so "2" cannot be misread as a dose or a pack count.
                const duration = d.duration ? `${d.duration} day${Number(d.duration) === 1 ? '' : 's'}` : '—';
                return (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-color)' }}>
                    <td style={td}>{i + 1}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{d.name || d.drug || '—'}</td>
                    <td style={td}>{strength}</td>
                    <td style={td}>{d.dosage || '—'}</td>
                    <td style={td}>{d.frequency || '—'}</td>
                    <td style={td}>{duration}</td>
                    {/* Blank qty dispenses 1 — see the Qty input's title in
                        PrescribeTab — so show that rather than an em dash. */}
                    <td style={td}>{d.qty || 1}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TopScrollSync>
        </div>

        <div style={headerRowStyle}><strong>Notes:</strong> {parsed.notes || '—'}</div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
          <button
            type="button"
            onClick={onClose}
            style={{ padding: '0.55rem 1rem', background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem' }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={previewPdf}
            disabled={previewing}
            title="Open the prescription PDF in a new tab"
            style={{
              padding: '0.55rem 1rem', background: 'transparent', color: 'var(--accent-color)',
              border: '1px solid var(--accent-color)', borderRadius: 8, cursor: previewing ? 'wait' : 'pointer',
              fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
              opacity: previewing ? 0.7 : 1,
            }}
          >
            <Eye size={14} /> {previewing ? 'Opening…' : 'See'}
          </button>
          <button
            type="button"
            onClick={downloadPdf}
            disabled={downloading}
            title="Download the prescription as a PDF file"
            style={{
              padding: '0.55rem 1rem', background: 'var(--accent-color)', color: '#fff',
              border: 'none', borderRadius: 8, cursor: downloading ? 'wait' : 'pointer',
              fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
              opacity: downloading ? 0.7 : 1,
            }}
          >
            <Download size={14} /> {downloading ? 'Preparing…' : 'Download PDF'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
