import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';
import { formatDate } from '../../utils/date';
import { statusColor } from './shared';

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.75rem', paddingBottom: '0.5rem', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        {title}
      </h3>
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {children}
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '1rem', fontSize: '0.9rem', paddingBottom: '0.5rem' }}>
      <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

export default function TreatmentDetailModal({ treatment, onClose, onChanged }) {
  const notify = useNotify();
  const statusLabel = treatment.status ? treatment.status.charAt(0).toUpperCase() + treatment.status.slice(1) : 'Active';
  const progressPercent = treatment.totalSessions > 0 ? Math.round((treatment.completedSessions / treatment.totalSessions) * 100) : 0;
  const nextDueDate = treatment.nextDueAt ? formatDate(treatment.nextDueAt) : 'Not scheduled';
  const startDate = formatDate(treatment.startedAt);

  const updateStatus = async (newStatus) => {
    try {
      await fetchApi(`/api/wellness/treatment-plans/${treatment.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus }),
      });
      notify.success(`Treatment plan marked as ${newStatus}`);
      onChanged && onChanged();
    } catch (_err) { /* fetchApi already surfaced the message */ }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }} onClick={onClose}>
      <div className="glass" style={{ maxWidth: '600px', width: '90%', maxHeight: '80vh', overflow: 'auto', padding: '2rem', position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} style={{ position: 'absolute', top: '1rem', right: '1rem', background: 'transparent', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>×</button>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '1.5rem', gap: '1rem' }}>
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.25rem' }}>{treatment.name}</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Treatment Plan Details</p>
          </div>
          <span style={{ background: statusColor[treatment.status] || statusColor.active, color: '#fff', padding: '0.4rem 0.8rem', borderRadius: 6, fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: 600, whiteSpace: 'nowrap' }}>
            {statusLabel}
          </span>
        </div>

        {/* Patient Information */}
        <Section title="Patient Information">
          <DetailRow label="Name" value={treatment.patient?.name || 'N/A'} />
          <DetailRow label="Email" value={treatment.patient?.email || 'N/A'} />
          <DetailRow label="Phone" value={treatment.patient?.phone || 'N/A'} />
          <DetailRow label="Gender" value={treatment.patient?.gender || 'N/A'} />
          <DetailRow label="Blood Group" value={treatment.patient?.bloodGroup || 'N/A'} />
          <DetailRow label="Date of Birth" value={treatment.patient?.dob ? formatDate(treatment.patient.dob) : 'N/A'} />
          {treatment.patient?.allergies && <DetailRow label="Allergies" value={treatment.patient.allergies} />}
          {treatment.patient?.notes && <DetailRow label="Notes" value={treatment.patient.notes} />}
        </Section>

        {/* Service Information */}
        {treatment.service && (
          <Section title="Service Information">
            <DetailRow label="Service Name" value={treatment.service.name} />
            <DetailRow label="Category" value={treatment.service.category} />
            <DetailRow label="Base Price" value={formatMoney(treatment.service.basePrice, { maximumFractionDigits: 0 })} />
            <DetailRow label="Duration" value={`${treatment.service.durationMin} minutes`} />
            <DetailRow label="Target Radius" value={treatment.service.targetRadiusKm ? `${treatment.service.targetRadiusKm} km` : 'Unlimited'} />
            {treatment.service.description && <DetailRow label="Description" value={treatment.service.description} />}
          </Section>
        )}

        {/* Treatment Plan Details */}
        <Section title="Treatment Plan Details">
          <DetailRow label="Total Sessions" value={treatment.totalSessions} />
          <DetailRow label="Completed Sessions" value={treatment.completedSessions} />
          <DetailRow label="Progress" value={`${progressPercent}%`} />
          <DetailRow label="Total Price" value={formatMoney(treatment.totalPrice || 0, { maximumFractionDigits: 0 })} />
          <DetailRow label="Start Date" value={startDate} />
          <DetailRow label="Next Due Date" value={nextDueDate} />
        </Section>

        {/* Progress Bar */}
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>Session Progress</span>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{treatment.completedSessions}/{treatment.totalSessions}</span>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 8, height: '12px', overflow: 'hidden' }}>
            <div style={{ background: statusColor[treatment.status] || statusColor.active, height: '100%', width: `${progressPercent}%`, transition: 'width 0.3s ease' }} />
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button onClick={() => updateStatus(treatment.status === 'active' ? 'paused' : 'active')} style={{ flex: 1, padding: '0.75rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            {treatment.status === 'active' ? '⏸ Pause' : '▶ Resume'}
          </button>
          <button onClick={() => updateStatus('completed')} style={{ flex: 1, padding: '0.75rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            ✓ Mark Complete
          </button>
          <button onClick={() => updateStatus('cancelled')} style={{ flex: 1, padding: '0.75rem', background: 'var(--danger-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            ✕ Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
