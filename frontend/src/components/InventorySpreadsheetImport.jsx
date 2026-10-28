import { useRef, useState } from 'react';
import { Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import { fetchApi } from '../utils/api';

const ACCEPTED_FILES = '.csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function readFile(file, mode) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The selected file could not be read.'));
    if (mode === 'arrayBuffer') reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  });
}

async function spreadsheetRows(file, columns) {
  const XLSX = await import('xlsx');
  const isCsv = file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv';
  const workbook = XLSX.read(await readFile(file, isCsv ? 'text' : 'arrayBuffer'), {
    type: isCsv ? 'string' : 'array',
  });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false });
  const keysByHeader = new Map(columns.map((column) => [column.header.trim().toLowerCase(), column.key]));
  return rawRows
    .map((rawRow) => Object.fromEntries(Object.entries(rawRow).map(([header, value]) => [
      keysByHeader.get(header.trim().toLowerCase()) || header.trim(),
      typeof value === 'string' ? value.trim() : value,
    ])))
    .filter((row) => Object.values(row).some((value) => String(value ?? '').trim()));
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function InventorySpreadsheetImport({
  entityLabel,
  endpoint,
  templateBaseName,
  sheetName,
  columns,
  example,
  onImported,
}) {
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    if (importing) return;
    setOpen(false);
    setFile(null);
    setError('');
  };

  const downloadTemplate = async (format) => {
    const headers = columns.map((column) => column.header);
    const values = columns.map((column) => example[column.key] ?? '');
    if (format === 'csv') {
      const csv = `${headers.map(csvCell).join(',')}\r\n${values.map(csvCell).join(',')}\r\n`;
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${templateBaseName}.csv`);
      return;
    }
    const XLSX = await import('xlsx');
    const worksheet = XLSX.utils.aoa_to_sheet([headers, values]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    XLSX.writeFile(workbook, `${templateBaseName}.xlsx`);
  };

  const importFile = async () => {
    if (!file) return;
    setImporting(true);
    setError('');
    try {
      const rows = await spreadsheetRows(file, columns);
      if (rows.length === 0) throw new Error('The file has no data rows. Keep the template header row and add at least one item.');
      if (rows.length > 200) throw new Error('Import up to 200 rows at a time.');
      const result = await fetchApi(endpoint, {
        method: 'POST',
        body: JSON.stringify({ rows }),
      });
      await onImported?.(result);
      setOpen(false);
      setFile(null);
      setError('');
    } catch (importError) {
      const details = importError?.data?.errors;
      const firstRowError = Array.isArray(details) && details[0]
        ? ` Row ${details[0].row}: ${details[0].error}`
        : '';
      setError(`${importError?.message || 'The file could not be imported.'}${firstRowError}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => setOpen(true)}
        style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap' }}
      >
        <Upload size={15} aria-hidden="true" /> Import CSV/Excel
      </button>
      {open && (
        <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,.55)', display: 'grid', placeItems: 'center', padding: 16 }}>
          <div role="dialog" aria-modal="true" aria-label={`Import ${entityLabel}`} className="card" style={{ width: 'min(620px, 100%)', padding: '1.25rem', background: 'var(--modal-bg, #fff)', color: 'var(--text-primary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '1.2rem' }}><FileSpreadsheet size={20} /> Import {entityLabel}</h2>
              <button type="button" className="btn-secondary" aria-label="Close import dialog" onClick={close} disabled={importing} style={{ padding: '.4rem' }}><X size={17} /></button>
            </div>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Download a template, keep its column names, then upload a CSV or Excel file. Existing matching rows are updated; new rows are created.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              <button type="button" className="btn-secondary" onClick={() => downloadTemplate('csv')}><Download size={14} /> CSV template</button>
              <button type="button" className="btn-secondary" onClick={() => downloadTemplate('xlsx')}><Download size={14} /> Excel template</button>
            </div>
            <label style={{ display: 'grid', gap: 7, fontSize: '.8rem', fontWeight: 700 }}>
              CSV or Excel file
              <input
                ref={inputRef}
                className="input-field"
                type="file"
                accept={ACCEPTED_FILES}
                onChange={(event) => { setFile(event.target.files?.[0] || null); setError(''); }}
              />
            </label>
            <div style={{ marginTop: 8, color: 'var(--text-secondary)', fontSize: '.76rem' }}>Accepted: CSV, XLS, XLSX · Maximum 200 rows</div>
            {error && <div role="alert" style={{ marginTop: 14, padding: 10, borderRadius: 8, color: 'var(--danger-color, #b42318)', background: 'rgba(220,38,38,.08)' }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button type="button" className="btn-secondary" onClick={close} disabled={importing}>Cancel</button>
              <button type="button" className="btn-primary" onClick={importFile} disabled={!file || importing}>{importing ? 'Importing…' : 'Import data'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
