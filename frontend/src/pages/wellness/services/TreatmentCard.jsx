import { Clock, Trash2, IndianRupee, MapPin } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatDate } from '../../utils/date';
import { iconBtn, statusColor } from './shared';

export default function TreatmentCard({ treatment, onChanged, onSelect }) {
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

  const handleCancel = async () => {
    if (!await notify.confirm({
      message: `Cancel this treatment plan for ${treatment.patient?.name}?`,
      destructive: true,
      confirmText: 'Cancel Plan'
    })) return;
    await updateStatus('cancelled');
  };

  return (
    <div className="glass" style={{ padding: '1.25rem', position: 'relative', cursor: 'pointer', transition: 'all 0.3s ease' }} onClick={() => onSelect(treatment)}>
      <div style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', display: 'flex', gap: '0.25rem', zIndex: 10 }}>
        <button onClick={() => updateStatus(treatment.status === 'active' ? 'paused' : 'active')} title={treatment.status === 'active' ? 'Pause' : 'Resume'} style={iconBtn}>
          <Clock size={12} />
        </button>
        <button onClick={handleCancel} title="Cancel" style={{ ...iconBtn, color: 'var(--danger-color)' }}>
          <Trash2 size={12} />
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {treatment.patient?.name}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginTop: '0.15rem', flex: 1 }}>{treatment.name}</h3>
            <span style={{ background: statusColor[treatment.status] || statusColor.active, color: '#fff', padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.65rem', textTransform: 'uppercase', fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap' }}>
              {statusLabel}
            </span>
          </div>
        </div>
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
        <span><IndianRupee size={12} style={{ verticalAlign: 'middle' }} /> {treatment.totalPrice?.toLocaleString('en-IN') || '0'}</span>
        <span><Clock size={12} style={{ verticalAlign: 'middle' }} /> {treatment.completedSessions}/{treatment.totalSessions} sessions</span>
        <span><MapPin size={12} style={{ verticalAlign: 'middle' }} /> Due: {nextDueDate}</span>
      </div>

      {/* Progress bar */}
      <div style={{ marginTop: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Progress</span>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{progressPercent}%</span>
        </div>
        <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 4, height: '6px', overflow: 'hidden' }}>
          <div style={{ background: statusColor[treatment.status] || statusColor.active, height: '100%', width: `${progressPercent}%`, transition: 'width 0.3s ease' }} />
        </div>
      </div>

      {treatment.service && (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
          <strong>Service:</strong> {treatment.service.name}
        </p>
      )}
    </div>
  );
}
