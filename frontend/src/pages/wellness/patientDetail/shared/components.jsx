import { useState } from 'react';
import { X, FileText, Download, Eye } from 'lucide-react';
import { getAuthToken } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { computeAgeFromDob, sexLabel, parseRxInstructions, th, td } from './helpers';

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

// Clinical-format Rx detail modal. Matches the Zylu-style prescription layout
// (Patient demographics → Chief complaint / Diagnosis / Investigations / Advice
// → Prescriptions table → Notes). Free-text Rx without zylu-style labels still
// display fine — every unmatched section just shows "—".
export function RxDetailModal({ rx, patient, onClose }) {
  const notify = useNotify();
  const [downloading, setDownloading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
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

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{
          width: '95%', maxWidth: 1080, maxHeight: '90vh', overflow: 'auto',
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
          </div>
        </div>

        <div style={headerRowStyle}><strong>Chief Complaint:</strong> {parsed.chiefComplaint || '—'}</div>
        <div style={headerRowStyle}><strong>Diagnosis:</strong> {parsed.diagnosis || '—'}</div>
        <div style={headerRowStyle}><strong>Investigations:</strong> {parsed.investigations || '—'}</div>
        <div style={{ ...headerRowStyle, whiteSpace: 'pre-wrap' }}><strong>Advice/Referrals:</strong> {parsed.advice || '—'}</div>

        <h3 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '1rem 0 0.4rem' }}>Prescriptions</h3>
        <div style={{ overflowX: 'auto', marginBottom: '1rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', minWidth: 720 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                <th style={th}>No.</th>
                <th style={th}>Drug Name</th>
                <th style={th}>Strength</th>
                <th style={th}>Preparation</th>
                <th style={th}>Route</th>
                <th style={th}>Dosage</th>
                <th style={th}>Direction</th>
                <th style={th}>Frequency</th>
                <th style={th}>Instructions</th>
                <th style={th}>Start Date</th>
              </tr>
            </thead>
            <tbody>
              {drugs.length === 0 ? (
                <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: 'var(--text-secondary)' }}>(no medications listed)</td></tr>
              ) : drugs.map((d, i) => {
                const strength = [d.strengthValue, d.strengthUnit].filter(Boolean).join('') || d.strength || '—';
                const startDate = d.startDate ? new Date(d.startDate).toLocaleDateString('en-IN') : '—';
                return (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-color)' }}>
                    <td style={td}>{i + 1}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{d.name || d.drug || '—'}</td>
                    <td style={td}>{strength}</td>
                    <td style={td}>{d.preparation || d.dosageForm || '—'}</td>
                    <td style={td}>{d.route || '—'}</td>
                    <td style={td}>{d.dosage || '—'}</td>
                    <td style={td}>{d.direction || '—'}</td>
                    <td style={td}>{d.frequency || '—'}</td>
                    <td style={td}>{d.instructions || '—'}</td>
                    <td style={td}>{startDate}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
    </div>
  );
}
