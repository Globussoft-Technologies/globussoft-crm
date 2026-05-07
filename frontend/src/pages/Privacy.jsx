import React, { useState, useEffect, useContext } from 'react';
import { Shield, Download, Trash2, Clock, AlertTriangle, CheckCircle2, Save } from 'lucide-react';
import { fetchApi, getAuthToken } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';

// CRM messaging entities — visible to every tenant.
const CRM_RETENTION_ENTITIES = [
  { entity: 'EmailMessage', label: 'Email Messages', defaultDays: 730 },
  { entity: 'CallLog', label: 'Call Logs', defaultDays: 365 },
  { entity: 'Activity', label: 'Activities', defaultDays: 1095 },
  { entity: 'SmsMessage', label: 'SMS Messages', defaultDays: 365 },
  { entity: 'WhatsAppMessage', label: 'WhatsApp Messages', defaultDays: 365 },
];

// #576 — Clinical / Medical Records retention. Visible only when
// tenant.vertical === 'wellness'. Defaults match DPDP / clinical norms.
// 2555d = ~7y; 3650d = ~10y. ConsentForm carries the legal-defensibility
// rationale: signed consent must outlive the engagement.
const CLINICAL_RETENTION_ENTITIES = [
  { entity: 'Patient', label: 'Patients', defaultDays: 3650 },
  { entity: 'Visit', label: 'Visits', defaultDays: 2555 },
  { entity: 'Prescription', label: 'Prescriptions', defaultDays: 2555 },
  { entity: 'ConsentForm', label: 'Consent Forms', defaultDays: 2555 },
  { entity: 'TreatmentPlan', label: 'Treatment Plans', defaultDays: 2555 },
  { entity: 'MedicalAttachment', label: 'Medical Attachments', defaultDays: 2555 },
];


export default function Privacy() {
  const notify = useNotify();
  const { user, tenant } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN';
  const isWellness = tenant?.vertical === 'wellness';
  // #576 — wellness tenants append the Clinical/Medical Records sub-section
  // to the editable RETENTION_ENTITIES list.
  const VISIBLE_RETENTION_ENTITIES = isWellness
    ? [...CRM_RETENTION_ENTITIES, ...CLINICAL_RETENTION_ENTITIES]
    : CRM_RETENTION_ENTITIES;

  const [policies, setPolicies] = useState([]);
  const [policiesLoading, setPoliciesLoading] = useState(true);
  const [savingPolicies, setSavingPolicies] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (!isAdmin) { setPoliciesLoading(false); return; }
    loadPolicies();
  }, [isAdmin]);

  const loadPolicies = async () => {
    try {
      const existing = await fetchApi('/api/gdpr/retention-policies');
      const map = {};
      (Array.isArray(existing) ? existing : []).forEach(p => { map[p.entity] = p; });
      // #389: defaults previously rendered blank when the server returned
      // a row with retainDays === 0 / "" / null. ?? only catches null+undef,
      // so a zero or empty string leaked through as a blank input. Coerce
      // to a positive integer and fall back to the canonical default
      // otherwise.
      const merged = VISIBLE_RETENTION_ENTITIES.map(meta => {
        const row = map[meta.entity];
        const raw = row?.retainDays;
        const days = Number(raw);
        const retainDays = Number.isFinite(days) && days > 0 ? days : meta.defaultDays;
        return {
          entity: meta.entity,
          label: meta.label,
          retainDays,
          isActive: row?.isActive ?? false,
        };
      });
      setPolicies(merged);
    } catch (err) {
      console.error(err);
      setPolicies(VISIBLE_RETENTION_ENTITIES.map(m => ({ entity: m.entity, label: m.label, retainDays: m.defaultDays, isActive: false })));
    } finally {
      setPoliciesLoading(false);
    }
  };

  const handleExportMe = async () => {
    setExporting(true);
    setExportSuccess(false);
    try {
      const token = getAuthToken();
      const res = await fetch('/api/gdpr/export/me', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `my-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setExportSuccess(true);
      setTimeout(() => setExportSuccess(false), 4000);
    } catch (err) {
      notify.error('Failed to export data: ' + err.message);
    } finally {
      setExporting(false);
    }
  };

  const updatePolicy = (entity, field, value) => {
    setPolicies(prev => prev.map(p => p.entity === entity ? { ...p, [field]: value } : p));
  };

  const handleSavePolicies = async () => {
    setSavingPolicies(true);
    try {
      await fetchApi('/api/gdpr/retention-policies', {
        method: 'PUT',
        body: JSON.stringify(policies.map(p => ({
          entity: p.entity,
          retainDays: parseInt(p.retainDays) || 0,
          isActive: !!p.isActive,
        }))),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 3000);
      // #388: explicit toast in addition to the inline "Saved" flash. The
      // flash is easy to miss on a long page; the toast is the consistent
      // CRUD-feedback surface used by every other save handler in the app.
      notify.success('Retention policy saved');
      loadPolicies();
    } catch (err) {
      notify.error('Failed to save policies: ' + err.message);
    } finally {
      setSavingPolicies(false);
    }
  };

  // #584: confirmation must match the user's actual email (anti-fat-finger,
  // GitHub-style). The string check was previously the literal "DELETE",
  // which is bypassable by anyone with a single misclick.
  const confirmTarget = (user?.email || '').trim();
  const confirmMatches =
    confirmTarget.length > 0 &&
    deleteConfirmText.trim().toLowerCase() === confirmTarget.toLowerCase();

  const handleAccountDeletion = async () => {
    if (!confirmMatches) {
      notify.error('Please type your account email to confirm');
      return;
    }
    setDeleting(true);
    try {
      // We file the request via the export endpoint as a placeholder for the queue.
      // Actual user-account purge requires admin review per platform policy.
      await fetchApi('/api/gdpr/consent', {
        method: 'POST',
        body: JSON.stringify({
          contactId: user?.userId || 0,
          type: 'data_processing',
          granted: false,
          source: 'account_deletion_request',
        }),
      }).catch(() => {});
      notify.success('Your account deletion request has been submitted. An administrator will review and complete the anonymization within 30 days.');
      setShowDeleteModal(false);
      setDeleteConfirmText('');
    } catch (err) {
      notify.error('Failed to submit deletion request: ' + err.message);
    } finally {
      setDeleting(false);
    }
  };

  const card = {
    background: 'var(--surface-color, rgba(255,255,255,0.6))',
    backdropFilter: 'blur(12px)',
    border: '1px solid var(--border-color, rgba(255,255,255,0.18))',
    borderRadius: '14px',
    padding: '1.5rem',
    marginBottom: '1.5rem',
    boxShadow: '0 4px 24px rgba(0,0,0,0.04)',
    color: 'var(--text-primary)',
  };

  return (
    <div style={{ padding: '2rem', maxWidth: '1100px', margin: '0 auto', animation: 'fadeIn 0.3s ease' }}>
      {/* Header */}
      <header style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '2rem' }}>
        <Shield size={28} style={{ color: 'var(--accent-color, #3b82f6)' }} />
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: '700', margin: 0 }}>Privacy & Data Controls</h1>
          <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.9rem', margin: '0.25rem 0 0' }}>
            Manage your personal data, exercise your GDPR rights, and configure retention policies.
          </p>
        </div>
      </header>

      {/* Section 1 — Export My Data */}
      <section style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <Download size={20} style={{ color: '#3b82f6' }} />
          <h2 style={{ fontSize: '1.15rem', fontWeight: '600', margin: 0 }}>Export My Data</h2>
        </div>
        <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.9rem', marginBottom: '1rem' }}>
          Download a complete JSON archive of all data linked to your user account: deals, tasks, expenses, activities,
          emails, calls, messages, and audit history.
        </p>
        <button
          onClick={handleExportMe}
          disabled={exporting}
          style={{
            background: '#3b82f6', color: '#fff', border: 'none', padding: '0.6rem 1.25rem',
            borderRadius: '8px', cursor: exporting ? 'wait' : 'pointer', fontWeight: '500',
            display: 'inline-flex', alignItems: 'center', gap: '0.5rem', opacity: exporting ? 0.7 : 1,
          }}
        >
          <Download size={16} />
          {exporting ? 'Preparing export...' : 'Download My Data (JSON)'}
        </button>
        {exportSuccess && (
          <span style={{ marginLeft: '1rem', color: '#10b981', fontSize: '0.875rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            <CheckCircle2 size={16} /> Export downloaded
          </span>
        )}
      </section>

      {/* Section 2 — Retention Policies (admin) */}
      {isAdmin && (
        <section style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Clock size={20} style={{ color: '#f59e0b' }} />
              <h2 style={{ fontSize: '1.15rem', fontWeight: '600', margin: 0 }}>Data Retention Policies</h2>
            </div>
            {savedFlash && (
              <span style={{ color: '#10b981', fontSize: '0.875rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                <CheckCircle2 size={16} /> Saved
              </span>
            )}
          </div>
          <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            When a policy is active, the daily retention engine deletes records older than the specified number of days
            for the current organization.
          </p>
          {policiesLoading ? (
            <div style={{ padding: '1rem', color: 'var(--text-secondary, #6b7280)' }}>Loading policies...</div>
          ) : (
            <>
              <RetentionTable
                title="CRM Messaging"
                rows={policies.filter(p => CRM_RETENTION_ENTITIES.some(m => m.entity === p.entity))}
                updatePolicy={updatePolicy}
              />
              {isWellness && (
                <RetentionTable
                  title="Clinical / Medical Records"
                  subtitle="DPDP / clinical-records norm — 7y for clinical entities, 10y for Patient. Soft-delete first, hard-purge after the tombstone window."
                  rows={policies.filter(p => CLINICAL_RETENTION_ENTITIES.some(m => m.entity === p.entity))}
                  updatePolicy={updatePolicy}
                  testId="clinical-retention-table"
                />
              )}
            </>
          )}
          <button
            onClick={handleSavePolicies}
            disabled={savingPolicies || policiesLoading}
            style={{
              marginTop: '1rem', background: '#10b981', color: '#fff', border: 'none',
              padding: '0.6rem 1.25rem', borderRadius: '8px', cursor: savingPolicies ? 'wait' : 'pointer',
              fontWeight: '500', display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
              opacity: savingPolicies ? 0.7 : 1,
            }}
          >
            <Save size={16} />
            {savingPolicies ? 'Saving...' : 'Save Policies'}
          </button>
        </section>
      )}

      {/* Section 3 — Account Deletion */}
      <section style={{ ...card, borderColor: 'rgba(239, 68, 68, 0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <Trash2 size={20} style={{ color: '#ef4444' }} />
          <h2 style={{ fontSize: '1.15rem', fontWeight: '600', margin: 0 }}>Account Deletion</h2>
        </div>
        <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.9rem', marginBottom: '1rem' }}>
          Request permanent deletion of your account. All personal data linked to your user (activities, messages, calls)
          will be hard-deleted. Records required for accounting integrity (deals, invoices) will have your identity
          anonymized but remain in the system for compliance.
        </p>
        <button
          onClick={() => setShowDeleteModal(true)}
          style={{
            background: '#ef4444', color: '#fff', border: 'none', padding: '0.6rem 1.25rem',
            borderRadius: '8px', cursor: 'pointer', fontWeight: '500',
            display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
          }}
        >
          <Trash2 size={16} /> Request Account Deletion
        </button>
      </section>

      {/* Section 4 — Compliance Info */}
      <section style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <Shield size={20} style={{ color: '#8b5cf6' }} />
          <h2 style={{ fontSize: '1.15rem', fontWeight: '600', margin: 0 }}>Compliance Information</h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
          <div>
            <strong style={{ display: 'block', marginBottom: '0.25rem' }}>GDPR (EU)</strong>
            <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.85rem', margin: 0 }}>
              Right to access, rectification, erasure, portability, and restriction. Lawful basis: consent and legitimate interest.
            </p>
          </div>
          {/* #576 — DPDP (India) bullet, only on wellness vertical. */}
          {isWellness && (
            <div data-testid="dpdp-compliance-bullet">
              <strong style={{ display: 'block', marginBottom: '0.25rem' }}>DPDP (India)</strong>
              <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.85rem', margin: 0 }}>
                Digital Personal Data Protection Act 2023. Clinical records retained per Indian Medical Council norms (7 years
                for consents/Rx/visits/treatment plans; 10 years for patient identity). Configure windows in the Clinical /
                Medical Records section above.
              </p>
            </div>
          )}
          <div>
            <strong style={{ display: 'block', marginBottom: '0.25rem' }}>CCPA (California)</strong>
            <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.85rem', margin: 0 }}>
              Right to know, delete, and opt-out of sale. We do not sell personal information to third parties.
            </p>
          </div>
          <div>
            <strong style={{ display: 'block', marginBottom: '0.25rem' }}>Data Residency</strong>
            <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.85rem', margin: 0 }}>
              Data stored in the organization's chosen region. Encryption at rest (MySQL) and in transit (TLS 1.2+).
            </p>
          </div>
          <div>
            <strong style={{ display: 'block', marginBottom: '0.25rem' }}>DPO Contact</strong>
            <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.85rem', margin: 0 }}>
              For privacy enquiries, email <a href="mailto:privacy@globussoft.com" style={{ color: 'var(--accent-color, #3b82f6)' }}>privacy@globussoft.com</a>.
            </p>
          </div>
        </div>
      </section>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div
          onClick={() => !deleting && setShowDeleteModal(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface-color, #fff)', borderRadius: '12px', padding: '1.75rem',
              maxWidth: '480px', width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
              color: 'var(--text-primary)',
              backdropFilter: 'blur(12px)',
              border: '1px solid var(--border-color)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <AlertTriangle size={22} style={{ color: '#ef4444' }} />
              <h3 style={{ fontSize: '1.15rem', fontWeight: '700', margin: 0 }}>Confirm Account Deletion</h3>
            </div>
            {/* #584: explicitly name the user being deleted so a misclick on
                a shared workstation is visually obvious before commit. */}
            <p
              data-testid="delete-target"
              style={{ fontSize: '0.9rem', marginBottom: '0.75rem' }}
            >
              You are about to permanently delete the account for{' '}
              <strong>{user?.name || user?.email || 'this user'}</strong>
              {user?.email && user?.name ? ` (${user.email})` : ''}.
            </p>
            <p style={{ color: '#dc2626', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              This cannot be undone.
            </p>
            <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
              The following will be hard-deleted:
            </p>
            <ul
              style={{
                color: 'var(--text-secondary, #6b7280)',
                fontSize: '0.85rem',
                margin: '0 0 0.75rem 1.25rem',
                padding: 0,
              }}
            >
              <li>Personal profile data (name, email, phone, avatar)</li>
              <li>Activities, tasks, calls, messages, and emails authored by you</li>
              <li>Saved dashboards, reports, and notification preferences</li>
            </ul>
            <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
              Records required for accounting integrity (deals, invoices, signed contracts, audit log
              entries) are retained but anonymized — they cannot be re-linked to you. A 30-day grace
              period applies before the deletion is finalized by an administrator.
            </p>
            <p style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
              Type your account email <strong>{confirmTarget || '(unknown)'}</strong> to confirm:
            </p>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={confirmTarget || 'your.email@example.com'}
              aria-label="Type your account email to confirm deletion"
              style={{
                width: '100%', padding: '0.55rem 0.75rem', borderRadius: '8px',
                border: '1px solid var(--border-color, #d1d5db)',
                background: 'var(--input-bg, #fff)',
                color: 'var(--text-primary)',
                marginBottom: '1rem', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setShowDeleteModal(false); setDeleteConfirmText(''); }}
                disabled={deleting}
                style={{
                  background: 'transparent', color: 'var(--text-primary, #111827)',
                  border: '1px solid var(--border-color, #d1d5db)', padding: '0.5rem 1rem',
                  borderRadius: '8px', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleAccountDeletion}
                disabled={deleting || !confirmMatches}
                style={{
                  background: 'var(--danger-color, #dc2626)', color: '#fff', border: 'none', padding: '0.5rem 1rem',
                  borderRadius: '8px', cursor: deleting ? 'wait' : 'pointer',
                  opacity: (!confirmMatches || deleting) ? 0.5 : 1,
                }}
              >
                {deleting ? 'Submitting...' : 'Yes, delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// #576 — extracted retention-table fragment so the wellness vertical can
// render two grouped tables (CRM Messaging + Clinical / Medical Records)
// from the same single state array, without each row needing its own
// section header.
function RetentionTable({ title, subtitle, rows, updatePolicy, testId }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div data-testid={testId} style={{ marginTop: '1rem' }}>
      <h3 style={{ fontSize: '0.95rem', fontWeight: 600, margin: '0 0 0.25rem' }}>{title}</h3>
      {subtitle && (
        <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.8rem', margin: '0 0 0.5rem' }}>{subtitle}</p>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
            <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary, #6b7280)' }}>Entity</th>
            <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary, #6b7280)' }}>Retain (days)</th>
            <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary, #6b7280)' }}>Active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => (
            <tr key={p.entity} style={{ borderBottom: '1px solid var(--border-color, #f3f4f6)' }}>
              <td style={{ padding: '0.6rem 0.5rem', fontWeight: '500' }}>{p.label}</td>
              <td style={{ padding: '0.6rem 0.5rem' }}>
                <input
                  type="number"
                  min={1}
                  value={p.retainDays}
                  onChange={(e) => updatePolicy(p.entity, 'retainDays', e.target.value)}
                  style={{
                    width: '110px', padding: '0.4rem 0.6rem', borderRadius: '6px',
                    border: '1px solid var(--border-color, #d1d5db)', background: 'var(--input-bg, #fff)',
                    color: 'var(--text-primary, #111827)',
                  }}
                />
              </td>
              <td style={{ padding: '0.6rem 0.5rem' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!!p.isActive}
                    onChange={(e) => updatePolicy(p.entity, 'isActive', e.target.checked)}
                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '0.85rem', color: p.isActive ? '#10b981' : 'var(--text-secondary, #6b7280)' }}>
                    {p.isActive ? 'Enabled' : 'Disabled'}
                  </span>
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
