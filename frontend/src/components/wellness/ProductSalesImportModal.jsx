// Product-sales snapshot importer for Reports → Per Product.
//
// The Per Product tab reads POS (SaleLineItem, lineType='PRODUCT') as its
// live source. A clinic that has just moved onto the CRM has no POS history
// yet but does have months of product sales in a CSV/XLSX export from the
// system it is leaving. This modal loads those exports so the tab has
// history on day one; it needs no attention afterwards, because the report
// switches to live POS figures on its own once sales are rung here.
//
// Backend contract (routes/wellness.js):
//   GET    /api/wellness/reports/per-product/imports
//   GET    /api/wellness/reports/per-product/import-template?format=csv|xlsx
//   POST   /api/wellness/reports/per-product/imports   (multipart `file`)
//   DELETE /api/wellness/reports/per-product/imports/:id
//
// A period that overlaps an existing import is refused with 409
// PERIOD_OVERLAP and the conflicting batches; the modal then offers
// "Replace" (re-POSTs with replace=true), because two snapshots covering the
// same days are two recordings of the same sales and keeping both would
// double every figure in the report.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, FileText, Upload, Trash2, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { formatMoney } from '../../utils/money';

const EXPECTED_HEADERS = [
  'Product Name',
  'HSN Code',
  'Product Count',
  'Gross Sales',
  'Discount',
  'Net Sales',
  'Tax',
  'Total Sales',
];

const ymd = (value) => {
  if (!value) return '';
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return '';
  }
};

export default function ProductSalesImportModal({ defaultFrom, defaultTo, onClose, onImported }) {
  const fileInputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [periodStart, setPeriodStart] = useState(defaultFrom || '');
  const [periodEnd, setPeriodEnd] = useState(defaultTo || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Populated from a 400 INVALID_ROWS body — the per-row reasons the backend
  // refused, so the operator can fix the sheet instead of guessing.
  const [rowErrors, setRowErrors] = useState([]);
  // Populated from a 409 PERIOD_OVERLAP body; its presence turns the primary
  // button into "Replace & upload".
  const [conflicts, setConflicts] = useState([]);
  const [success, setSuccess] = useState(null);
  const [imports, setImports] = useState([]);
  const [loadingImports, setLoadingImports] = useState(true);

  const loadImports = () => {
    setLoadingImports(true);
    fetchApi('/api/wellness/reports/per-product/imports', { silent: true })
      .then((res) => setImports(Array.isArray(res?.rows) ? res.rows : []))
      .catch(() => setImports([]))
      .finally(() => setLoadingImports(false));
  };

  useEffect(loadImports, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Template download goes through raw fetch, not an <a href>: the href path
  // would drop the Authorization header and 401.
  const downloadTemplate = async (format) => {
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/wellness/reports/per-product/import-template?format=${format}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Template download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `product-sales-import-template.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e.message || 'Template download failed');
    }
  };

  const upload = async ({ replace = false } = {}) => {
    if (!file) {
      setError('Choose a CSV or Excel file first.');
      return;
    }
    if (!periodStart || !periodEnd) {
      setError('Set the period this file covers — the file itself has no dates in it.');
      return;
    }
    if (periodStart > periodEnd) {
      setError('Period start must be on or before period end.');
      return;
    }
    setBusy(true);
    setError(null);
    setRowErrors([]);
    setSuccess(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('periodStart', periodStart);
      form.append('periodEnd', periodEnd);
      if (note) form.append('note', note);
      if (replace) form.append('replace', 'true');
      const res = await fetchApi('/api/wellness/reports/per-product/imports', {
        method: 'POST',
        body: form,
        silent: true,
      });
      setConflicts([]);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setSuccess({
        imported: res?.imported || 0,
        matchedProducts: res?.matchedProducts || 0,
        replaced: res?.replaced || 0,
        totalSales: res?.import?.totalSales || 0,
      });
      loadImports();
      if (onImported) onImported();
    } catch (e) {
      if (e.code === 'PERIOD_OVERLAP') {
        setConflicts(Array.isArray(e.data?.conflicts) ? e.data.conflicts : []);
        setError(e.message);
      } else if (e.code === 'INVALID_ROWS') {
        setRowErrors(Array.isArray(e.data?.errors) ? e.data.errors : []);
        setError(e.message);
      } else {
        setError(e.message || 'Import failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const removeImport = async (id) => {
    setBusy(true);
    try {
      await fetchApi(`/api/wellness/reports/per-product/imports/${id}`, {
        method: 'DELETE',
        silent: true,
      });
      loadImports();
      if (onImported) onImported();
    } catch (e) {
      setError(e.message || 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  // Portal to document.body — the Reports page's tab strip and export bar
  // are inside transformed/positioned containers, and a `position: fixed`
  // overlay rendered inside one would be clipped to that box.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="product-sales-import-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem',
      }}
      onClick={onClose}
    >
      <div
        className="glass"
        style={{
          maxWidth: 760,
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          padding: '2rem',
          position: 'relative',
          background: 'var(--surface-color, rgba(250, 246, 237, 0.95))',
          color: 'var(--text-primary, inherit)',
          border: '1px solid var(--border-color, rgba(0,0,0,0.1))',
          boxShadow: 'var(--shadow-lg, 0 24px 60px rgba(0,0,0,0.25))',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: '1rem', right: '1rem', background: 'transparent',
            border: 'none', cursor: 'pointer', color: 'inherit',
          }}
        >
          <X size={20} />
        </button>

        <h2 id="product-sales-import-title" style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Upload size={20} /> Import product sales
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: '0.85rem', lineHeight: 1.6 }}>
          Upload the product-sales export from your previous system. Expected columns:{' '}
          <code style={codePill}>{EXPECTED_HEADERS.join(', ')}</code>. Extra columns are
          ignored, and the file&apos;s own <strong>Total</strong> row is skipped.
          <br />
          Once you start ringing product sales through POS here, this tab switches to
          live figures on its own — imports only fill the period before that.
        </p>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
          <button type="button" onClick={() => downloadTemplate('csv')} style={ghostBtn}>
            <FileText size={14} /> CSV template
          </button>
          <button type="button" onClick={() => downloadTemplate('xlsx')} style={ghostBtn}>
            <FileText size={14} /> Excel template
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
          <label style={fieldLabel}>
            Period start
            <input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              style={fieldInput}
            />
          </label>
          <label style={fieldLabel}>
            Period end
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              style={fieldInput}
            />
          </label>
          <label style={fieldLabel}>
            Note (optional)
            <input
              type="text"
              value={note}
              placeholder="e.g. Zenoti export, FY25 Q1"
              onChange={(e) => setNote(e.target.value)}
              style={fieldInput}
            />
          </label>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setError(null);
              setRowErrors([]);
              setConflicts([]);
            }}
            aria-label="Select the product sales CSV or Excel file"
            style={{ display: 'block', fontSize: '0.85rem' }}
          />
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginTop: '0.35rem' }}>
            {file ? `Selected: ${file.name}` : 'Accepted: CSV, XLSX — up to 5 MB.'}
          </div>
        </div>

        {error && (
          <div role="alert" style={alertBox('var(--danger-color, #ef4444)')}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <div>{error}</div>
              {rowErrors.length > 0 && (
                <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
                  {rowErrors.slice(0, 10).map((re, i) => (
                    <li key={`${re.rowNumber}-${i}`}>Row {re.rowNumber}: {re.reason}</li>
                  ))}
                  {rowErrors.length > 10 && <li>…and {rowErrors.length - 10} more.</li>}
                </ul>
              )}
              {conflicts.length > 0 && (
                <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
                  {conflicts.map((c) => (
                    <li key={c.id}>
                      {c.fileName || `Import #${c.id}`} — {ymd(c.periodStart)} to {ymd(c.periodEnd)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {success && (
          <div role="status" style={alertBox('var(--success-color, #22c55e)')}>
            <CheckCircle2 size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              Imported {success.imported} product row{success.imported === 1 ? '' : 's'}
              {' '}({formatMoney(success.totalSales)} total sales).
              {' '}{success.matchedProducts} matched a product in your catalogue.
              {success.replaced > 0 && ` Replaced ${success.replaced} earlier import(s).`}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginBottom: '1.5rem' }}>
          <button type="button" onClick={onClose} style={ghostBtn} disabled={busy}>Close</button>
          <button
            type="button"
            onClick={() => upload({ replace: conflicts.length > 0 })}
            disabled={busy || !file}
            style={primaryBtn(busy || !file)}
          >
            {busy
              ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
              : <Upload size={14} />}
            {conflicts.length > 0 ? 'Replace & upload' : 'Upload'}
          </button>
        </div>

        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, margin: '0 0 0.5rem' }}>Existing imports</h3>
        {loadingImports && <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Loading…</div>}
        {!loadingImports && imports.length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            Nothing imported yet.
          </div>
        )}
        {!loadingImports && imports.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
              <thead>
                <tr>
                  {['Period', 'File', 'Rows', 'Total sales', ''].map((h, i) => (
                    <th key={h || i} style={{ ...miniTh, textAlign: i === 2 || i === 3 ? 'right' : 'left' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {imports.map((b) => (
                  <tr key={b.id}>
                    <td style={miniTd}>{ymd(b.periodStart)} → {ymd(b.periodEnd)}</td>
                    <td style={miniTd}>{b.fileName || '—'}{b.note ? ` (${b.note})` : ''}</td>
                    <td style={{ ...miniTd, textAlign: 'right' }}>{b.rowCount}</td>
                    <td style={{ ...miniTd, textAlign: 'right' }}>{formatMoney(b.totalSales)}</td>
                    <td style={{ ...miniTd, textAlign: 'right' }}>
                      <button
                        type="button"
                        onClick={() => removeImport(b.id)}
                        disabled={busy}
                        aria-label={`Delete import ${b.fileName || b.id}`}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--danger-color, #ef4444)' }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

const codePill = {
  background: 'rgba(255,255,255,0.08)',
  padding: '0.1rem 0.35rem',
  borderRadius: 4,
  fontSize: '0.75rem',
};
const ghostBtn = {
  display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
  padding: '0.45rem 0.85rem', background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
  color: 'inherit', fontSize: '0.8rem', cursor: 'pointer',
};
const primaryBtn = (disabled) => ({
  display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
  padding: '0.45rem 1rem', background: 'var(--accent-color)',
  border: '1px solid transparent', borderRadius: 8, color: '#fff',
  fontSize: '0.8rem', cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
});
const fieldLabel = {
  display: 'flex', flexDirection: 'column', gap: '0.3rem',
  fontSize: '0.75rem', color: 'var(--text-secondary)',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};
const fieldInput = {
  padding: '0.45rem 0.6rem', borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)',
  fontSize: '0.85rem', textTransform: 'none', letterSpacing: 'normal',
};
const alertBox = (color) => ({
  display: 'flex', gap: '0.5rem', alignItems: 'flex-start',
  border: `1px solid ${color}`, borderRadius: 8,
  padding: '0.65rem 0.8rem', marginBottom: '1rem',
  fontSize: '0.8rem', color,
});
const miniTh = {
  padding: '0.4rem 0.6rem', fontSize: '0.68rem', fontWeight: 600,
  color: 'var(--text-secondary)', textTransform: 'uppercase',
  letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.08)',
};
const miniTd = {
  padding: '0.4rem 0.6rem',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
};
