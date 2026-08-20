// Unified Import / Export hub. The page is a thin discovery surface around the
// shared CSV toolbar; endpoint config below decides whether a tenant should use
// generic CRM CSV routes or wellness PHI-gated CSV routes.
import { useContext, useMemo, useState } from 'react';
import { Database, Upload, Download, Info } from 'lucide-react';
import { AuthContext } from '../App';
import CsvImportExportToolbar from '../components/wellness/CsvImportExportToolbar';

const genericEndpoint = (entity, slug = entity) => ({
  meta: `/api/csv/${slug}`,
  template: `/api/csv/${slug}/template.csv`,
  export: `/api/csv/${slug}/export.csv`,
  import: `/api/csv/${slug}/import.csv`,
});

const GENERIC_ENTITIES = [
  {
    key: 'contacts',
    label: 'Contacts',
    description: 'CRM contact directory - name, email, phone, company, title, status, source and created date.',
    endpoints: genericEndpoint('contacts'),
  },
  {
    key: 'services',
    label: 'Services',
    description: 'Service catalog rows - name, category, ticket tier, base price, duration, description and active status.',
    endpoints: genericEndpoint('services'),
  },
  {
    key: 'products',
    label: 'Products',
    description: 'Product catalog rows - name, SKU, price, recurring flag, current stock and threshold.',
    endpoints: genericEndpoint('products'),
  },
  {
    key: 'membership-plans',
    label: 'Membership Plans',
    description: 'Membership plan rows - name, duration, price, currency, entitlements, description and active status.',
    endpoints: genericEndpoint('membership-plans'),
  },
  {
    key: 'bookings',
    label: 'Bookings',
    description: 'Booking rows - contact details, schedule, duration, meeting URL, notes and status.',
    endpoints: genericEndpoint('bookings'),
  },
];

const WELLNESS_ENTITIES = [
  {
    key: 'customers',
    label: 'Patients',
    description: 'Patient master list - name, phone, email, DOB, gender, blood group, source, allergies and notes. PHI-gated.',
  },
  {
    key: 'services',
    label: 'Services',
    description: 'Service catalog rows - name, category, ticket tier, base price, duration, marketing radius and description.',
  },
  {
    key: 'products',
    label: 'Drugs / Products',
    description: 'Drug catalog rows - name, generic name, dosage form, strength, dosage defaults, notes and active status.',
  },
  {
    key: 'packages',
    label: 'Membership Packages',
    description: 'Membership plans - name, validity, price, currency and service entitlements.',
  },
  {
    key: 'bookings',
    label: 'Bookings / Visits',
    description: 'Appointment ledger - date/time, patient, service, doctor, location, status, amount charged and notes.',
  },
];

export default function DataImportExport() {
  const { tenant } = useContext(AuthContext);
  const isWellness = tenant?.vertical === 'wellness';
  const entities = isWellness ? WELLNESS_ENTITIES : GENERIC_ENTITIES;
  const [entityKey, setEntityKey] = useState(entities[0].key);
  const entity = useMemo(() => entities.find((e) => e.key === entityKey) || entities[0], [entities, entityKey]);
  const toolbarFormats = isWellness ? ['csv', 'xlsx'] : ['csv'];
  const pageTitle = isWellness ? 'Template Import / Export' : 'Import / Export Data';
  const pageDescription = isWellness
    ? 'Download a CSV or Excel template, fill it in, then bulk import or export the matching wellness dataset.'
    : 'One place to bulk-import or download any dataset as CSV. Pick the data type below, then use the buttons on the right.';

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out', maxWidth: 900 }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Database size={24} /> {pageTitle}
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          {pageDescription}
        </p>
      </header>

      {isWellness && (
        <div
          className="glass"
          data-testid="wellness-template-guidance"
          style={{
            marginBottom: '1.25rem',
            padding: '1rem 1.1rem',
            border: '1px solid rgba(38, 88, 85, 0.18)',
            background: 'linear-gradient(135deg, rgba(205, 148, 129, 0.12), rgba(38, 88, 85, 0.08))',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.35rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700 }}>
            <Info size={16} />
            Template-based wellness imports
          </div>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.5 }}>
            Patients, services, drugs/products, membership packages, and bookings all use the same downloadable templates.
            Fill one out, then import CSV or Excel with the matching columns.
          </p>
        </div>
      )}

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
            {entities.map((opt) => (
              <option key={opt.key} value={opt.key}>{opt.label}</option>
            ))}
          </select>

          <CsvImportExportToolbar
            key={entity.key}
            entity={entity.key}
            label={entity.label}
            endpoints={entity.endpoints}
            formats={toolbarFormats}
          />
        </div>

        <div style={{ marginTop: '1rem', padding: '0.75rem 0.9rem', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.5rem' }}>
          <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{entity.description}</span>
        </div>
      </div>

      <div className="glass" style={{ padding: '1.25rem 1.5rem' }}>
        <h2 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.6rem' }}>
          {isWellness ? 'How the template flow works' : 'How it works'}
        </h2>
        <ul style={{ paddingLeft: '1.1rem', margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <li style={{ marginBottom: '0.3rem' }}>
            <Upload size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
            <strong style={{ color: 'var(--text-primary)' }}>{isWellness ? 'Export CSV / Excel' : 'Export CSV'}</strong> - {isWellness ? 'streams the full filtered list as a CSV or Excel download.' : 'streams the full filtered list as a CSV download.'}
          </li>
          <li style={{ marginBottom: '0.3rem' }}>
            <Download size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
            <strong style={{ color: 'var(--text-primary)' }}>{isWellness ? 'Import CSV / Excel' : 'Import CSV'}</strong> - opens the upload modal. Get the template first, fill in the rows, preview parses client-side, then submit.
          </li>
          <li>
            Imports are <strong style={{ color: 'var(--text-primary)' }}>upserts</strong> - existing rows get updated, new rows are inserted. Errors surface row-by-row so you can fix and re-upload only the failing rows.
          </li>
        </ul>
      </div>
    </div>
  );
}
