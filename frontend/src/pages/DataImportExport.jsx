// Unified Import / Export hub. Replaces having to hop between Services /
// Patients / Memberships / Products / Bookings just to push or pull a CSV.
//
// Implementation: this page is intentionally thin — it delegates the
// actual export-download / import-modal / template-download / async-job
// polling to the existing CsvImportExportToolbar component, exactly the
// same one each entity page already uses. The dropdown only switches
// which `entity` prop the toolbar renders against. So there is ONE code
// path for CSV I/O across the app; the hub is a discovery surface, not
// a parallel implementation.
import { useMemo, useState } from 'react';
import { Database, Download, Upload, Info } from 'lucide-react';
import CsvImportExportToolbar from '../components/wellness/CsvImportExportToolbar';

// Mirrors the entities defined by routes/wellnessCsv.js + lib/csvEntities.js.
// Order matches the dropdown the user sees. The description is rendered
// inline so the admin knows exactly what each export will include before
// they click the button.
const ENTITIES = [
  {
    key: 'customers',
    label: 'Patients',
    description: 'Patient master list — name, phone, email, DOB, gender, blood group, source, location, allergies, notes. PHI-gated.',
  },
  {
    key: 'services',
    label: 'Services',
    description: 'Service catalog rows — name, category, ticket tier, base price, duration, marketing radius, description, image URL.',
  },
  {
    key: 'products',
    label: 'Drugs / Products',
    description: 'Inventory items — SKU/code, name, category, unit price, stock threshold, manufacturer, tax, barcode.',
  },
  {
    key: 'packages',
    label: 'Membership Packages',
    description: 'Membership plans — name, validity (days), price, currency, entitlements (service × quantity).',
  },
  {
    key: 'bookings',
    label: 'Bookings / Visits',
    description: 'Appointment ledger — date/time, patient, service, doctor, location, status, amount charged.',
  },
  {
    key: 'invoices',
    label: 'Invoices',
    description: 'Billing records — invoice number, contact email, amount, status, due / issued dates, recurrence. Imports are upserts keyed by invoiceNum.',
  },
];

export default function DataImportExport() {
  const [entityKey, setEntityKey] = useState(ENTITIES[0].key);
  const entity = useMemo(() => ENTITIES.find((e) => e.key === entityKey) || ENTITIES[0], [entityKey]);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out', maxWidth: 900 }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Database size={24} /> Import / Export Data
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          One place to bulk-import or download any dataset as CSV. Pick the data type below, then use the buttons on the right.
        </p>
      </header>

      <div className="glass" style={{ padding: '1.5rem', marginBottom: '1.25rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.4rem' }}>
          Data type
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
          <select
            value={entityKey}
            onChange={(e) => setEntityKey(e.target.value)}
            style={{ flex: '1 1 220px', minWidth: 0, padding: '0.55rem 0.75rem', borderRadius: 8, border: '1px solid var(--border-color, rgba(255,255,255,0.15))', background: 'var(--surface-color, rgba(255,255,255,0.04))', color: 'var(--text-primary)', fontSize: '0.95rem' }}
          >
            {ENTITIES.map((opt) => (
              <option key={opt.key} value={opt.key}>{opt.label}</option>
            ))}
          </select>

          {/* Toolbar = the exact same component each entity page uses
              (Services / Patients / Products / etc.). Re-keyed by entity
              so its internal modal state resets cleanly when the user
              switches data types mid-flight. */}
          <CsvImportExportToolbar
            key={entity.key}
            entity={entity.key}
            label={entity.label}
          />
        </div>

        <div style={{ marginTop: '1rem', padding: '0.75rem 0.9rem', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.5rem' }}>
          <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{entity.description}</span>
        </div>
      </div>

      <div className="glass" style={{ padding: '1.25rem 1.5rem' }}>
        <h2 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.6rem' }}>How it works</h2>
        <ul style={{ paddingLeft: '1.1rem', margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <li style={{ marginBottom: '0.3rem' }}>
            <Download size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
            <strong style={{ color: 'var(--text-primary)' }}>Export CSV</strong> — streams the full filtered list as a CSV download.
          </li>
          <li style={{ marginBottom: '0.3rem' }}>
            <Upload size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
            <strong style={{ color: 'var(--text-primary)' }}>Import CSV</strong> — opens the upload modal. Get the template first, fill in the rows, preview parses client-side, then submit. Files over 5MB or 5,000 rows queue in the background and email you on completion.
          </li>
          <li>
            Imports are <strong style={{ color: 'var(--text-primary)' }}>upserts</strong> — existing rows (matched by name or SKU depending on the entity) get updated, new rows are inserted. Errors surface row-by-row so you can fix and re-upload only the failing rows.
          </li>
        </ul>
      </div>
    </div>
  );
}
