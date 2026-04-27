import React from 'react';
import { Link } from 'react-router-dom';
import { Package, ArrowRight, Users } from 'lucide-react';

/**
 * #305 — `/wellness/inventory` previously rendered a blank page because the
 * route had no element wired up. Inventory in the wellness vertical is
 * intentionally per-patient (it's a consumption ledger, not a warehouse SKU
 * list), implemented as the `InventoryTab` inside
 * `frontend/src/pages/wellness/PatientDetail.jsx`.
 *
 * Rather than returning a 404, this page explains the model and points the
 * user at the patient list, where they can drill into a record and open its
 * Inventory tab.
 */
export default function Inventory() {
  return (
    <div style={{ maxWidth: 720, margin: '2rem auto', padding: '0 1rem' }}>
      <div className="glass" style={{ padding: '2rem', borderRadius: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
          <Package size={28} color="var(--accent-color)" />
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>Inventory</h1>
        </div>

        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '1rem' }}>
          Inventory in the wellness vertical is tracked <strong>per patient</strong> as a
          consumption ledger — not as a stand-alone SKU warehouse. Each patient's
          treatment plan tracks how many units of a service or product they have
          remaining (e.g. 6 of 10 laser sessions used).
        </p>

        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
          To view or update inventory for a specific patient:
        </p>

        <ol style={{ color: 'var(--text-secondary)', lineHeight: 1.8, marginBottom: '1.5rem', paddingLeft: '1.25rem' }}>
          <li>Open <strong>Patients</strong> from the sidebar.</li>
          <li>Select a patient.</li>
          <li>Switch to the <strong>Inventory</strong> tab inside their detail view.</li>
        </ol>

        <Link
          to="/wellness/patients"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.6rem 1.25rem',
            background: 'var(--accent-color)',
            color: '#fff',
            textDecoration: 'none',
            borderRadius: 8,
            fontWeight: 500,
          }}
        >
          <Users size={16} /> Go to Patients <ArrowRight size={16} />
        </Link>

        <div style={{
          marginTop: '2rem',
          padding: '0.85rem 1rem',
          background: 'rgba(168, 85, 247, 0.08)',
          border: '1px solid rgba(168, 85, 247, 0.2)',
          borderRadius: 8,
          fontSize: '0.85rem',
          color: 'var(--text-secondary)',
        }}>
          <strong>Tip:</strong> if you're looking for low-stock alerts on consumables
          (needles, fillers, etc.), those run on the daily{' '}
          <code>lowStockEngine</code> cron and surface as recommendation cards on
          the Owner Dashboard.
        </div>
      </div>
    </div>
  );
}
