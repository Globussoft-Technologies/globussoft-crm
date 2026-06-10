import { UserCircle, Clock, AlertTriangle } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData, todayLocalDayWindow } from '../useWidgetData.js';

export default function NextPatient({ meta }) {
  const { from, to } = todayLocalDayWindow();
  const { data, loading, error } = useWidgetData(
    `/api/wellness/visits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500`,
    [from, to],
  );

  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.visits)
      ? data.visits
      : [];
  const now = Date.now();
  const next = list
    .filter((v) => v.visitDate && new Date(v.visitDate).getTime() >= now)
    .sort((a, b) => new Date(a.visitDate) - new Date(b.visitDate))[0];

  // Surface count of REMAINING upcoming so the user knows how many more
  // come after this one — gives the card extra value vs just the name.
  const upcomingCount = list.filter(
    (v) => v.visitDate && new Date(v.visitDate).getTime() >= now,
  ).length;
  const afterNext = Math.max(0, upcomingCount - 1);

  const timeLabel = next?.visitDate
    ? new Date(next.visitDate).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  const patientName = next?.patient?.name || (next ? `Patient #${next.patientId}` : null);

  return (
    <WidgetCard
      title={meta?.title || 'Next patient'}
      description={meta?.description}
      icon={UserCircle}
      loading={loading}
      error={error}
      empty={!loading && !error && !next}
      emptyMessage="No more appointments today."
      emptyHint="You're all caught up — enjoy the breather."
      linkTo={next?.patientId ? `/wellness/patients/${next.patientId}` : '/wellness/calendar'}
      linkLabel={next ? 'Open patient' : 'Open calendar'}
    >
      {next && (
        <div style={wrap}>
          <div style={nameRow}>
            <span style={nameStyle}>{patientName}</span>
            {timeLabel && (
              <span style={timePill}>
                <Clock size={12} /> {timeLabel}
              </span>
            )}
          </div>

          <dl style={metaList}>
            {next.service?.name && (
              <Field label="Service" value={next.service.name} />
            )}
            {next.patient?.gender || next.patient?.dob ? (
              <Field
                label="Patient"
                value={[
                  next.patient?.gender,
                  next.patient?.dob ? `DOB ${formatDob(next.patient.dob)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ) : null}
          </dl>

          {next.patient?.allergies && (
            <div style={allergyBox}>
              <AlertTriangle size={13} />
              <span>
                <strong>Allergies:</strong> {next.patient.allergies}
              </span>
            </div>
          )}

          {afterNext > 0 && (
            <div style={tailStyle}>
              {afterNext} more appointment{afterNext === 1 ? '' : 's'} after this
            </div>
          )}
        </div>
      )}
    </WidgetCard>
  );
}

function Field({ label, value }) {
  return (
    <div style={fieldRow}>
      <dt style={fieldLabel}>{label}</dt>
      <dd style={fieldValue}>{value}</dd>
    </div>
  );
}

function formatDob(d) {
  try {
    return new Date(d).toLocaleDateString([], {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return d;
  }
}

const wrap = { display: 'flex', flexDirection: 'column', gap: '0.55rem' };

const nameRow = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
};

const nameStyle = {
  fontSize: '1.1rem',
  fontWeight: 700,
  lineHeight: 1.2,
  letterSpacing: '-0.01em',
  flex: 1,
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const timePill = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0.2rem 0.5rem',
  borderRadius: 999,
  background: 'color-mix(in srgb, var(--primary-color, var(--accent-color)) 14%, transparent)',
  color: 'var(--primary-color, var(--accent-color))',
  fontSize: '0.75rem',
  fontWeight: 600,
  flexShrink: 0,
};

const metaList = {
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const fieldRow = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.4rem',
  fontSize: '0.82rem',
};

const fieldLabel = {
  margin: 0,
  width: 64,
  flexShrink: 0,
  color: 'var(--text-secondary)',
  fontSize: '0.72rem',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const fieldValue = {
  margin: 0,
  flex: 1,
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const allergyBox = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.4rem',
  padding: '0.4rem 0.55rem',
  borderRadius: 8,
  background: 'rgba(220,38,38,0.08)',
  color: '#dc2626',
  fontSize: '0.78rem',
  lineHeight: 1.35,
};

const tailStyle = {
  marginTop: '0.1rem',
  fontSize: '0.74rem',
  color: 'var(--text-secondary)',
};
