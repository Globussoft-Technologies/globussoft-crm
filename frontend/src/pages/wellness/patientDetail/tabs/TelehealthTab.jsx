import { useState } from 'react';
import { Copy, Video } from 'lucide-react';
import { fetchApi } from '../../../../utils/api';
import { useNotify } from '../../../../utils/notify';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../../../../components/wellness/DateRangeFilter';

function slugifyName(n) {
  return String(n || 'patient')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'patient';
}

// ── Agent B: Telehealth tab (Jitsi-embedded video consults) ───────
export default function TelehealthTab({ patient, onSaved }) {
  const notify = useNotify();
  const [activeRoom, setActiveRoom] = useState(null);
  const [busyVisitId, setBusyVisitId] = useState(null);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState(EMPTY_DATE_FILTER);
  const [rangeStart, rangeEnd] = resolveDateRange(filter);

  const allVisits = (patient.visits || []).slice().sort(
    (a, b) => new Date(b.visitDate) - new Date(a.visitDate),
  );
  const visits = (rangeStart && rangeEnd)
    ? allVisits.filter((v) => {
        const ts = new Date(v.visitDate).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : allVisits;

  const startOrJoin = async (visit) => {
    let room = visit.videoRoom;
    if (!room) {
      room = `gbs-${visit.id}-${slugifyName(patient.name)}`;
      setBusyVisitId(visit.id);
      try {
        await fetchApi(`/api/wellness/visits/${visit.id}`, {
          method: 'PUT',
          body: JSON.stringify({ videoRoom: room }),
        });
        if (onSaved) onSaved();
      } catch (e) {
        notify.error('Failed to start consult: ' + (e.message || 'unknown error'));
        setBusyVisitId(null);
        return;
      }
      setBusyVisitId(null);
    }
    setActiveRoom(room);
    setCopied(false);
  };

  const shareUrl = activeRoom ? `https://meet.jit.si/${activeRoom}` : '';

  const copyLink = async () => {
    if (!shareUrl) return;
    try {
      const { copyToClipboard } = await import('../../../../utils/clipboard');
      await copyToClipboard(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore — best-effort copy */
    }
  };

  if (allVisits.length === 0) {
    return (
      <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        No visits yet — log a visit first to start a video consult.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div
        className="glass"
        style={{
          padding: '0.6rem 0.85rem', display: 'flex', flexWrap: 'wrap',
          alignItems: 'center', gap: '0.6rem',
        }}
      >
        <DateRangeFilter value={filter} onChange={setFilter} label="Filter by visit date" />
        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {visits.length === allVisits.length
            ? `${allVisits.length} visit${allVisits.length === 1 ? '' : 's'}`
            : `${visits.length} of ${allVisits.length} visits`}
        </span>
      </div>
      <div className="glass" style={{ padding: '1rem' }}>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
          Each visit can host one video room. Patients join the same link from the patient portal.
        </div>
        {visits.length === 0 && (
          <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No visits in the selected range.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {visits.map((v) => {
            const has = !!v.videoRoom;
            const isActive = activeRoom && v.videoRoom === activeRoom;
            return (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0.75rem', background: 'rgba(255,255,255,0.04)', borderRadius: 8, border: isActive ? '1px solid var(--accent-color)' : '1px solid transparent' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.9rem', fontWeight: 500 }}>
                    {v.service?.name || 'Visit'} <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>— {new Date(v.visitDate).toLocaleString('en-IN')}</span>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Status: {v.status}
                    {has && <> • Room: <code style={{ color: 'var(--accent-color)' }}>{v.videoRoom}</code></>}
                    {v.bookingType && v.bookingType !== 'CLINIC_VISIT' && (
                      <> • {v.bookingType.replace(/_/g, ' ').toLowerCase()}</>
                    )}
                    {v.bookingType === 'IN_HOME' && Number.isFinite(v.travelTimeMinutes) && v.travelTimeMinutes > 0 && (
                      <> • Travel: {v.travelTimeMinutes} min</>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => startOrJoin(v)}
                  disabled={busyVisitId === v.id}
                  style={{ padding: '0.45rem 0.85rem', background: has ? 'var(--success-color)' : 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                >
                  <Video size={14} />
                  {busyVisitId === v.id ? 'Starting…' : has ? 'Join video' : 'Start video consult'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {activeRoom && (
        <div className="glass" style={{ padding: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Live consult — room <code style={{ color: 'var(--text-primary)' }}>{activeRoom}</code>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <button
                onClick={copyLink}
                style={{ padding: '0.4rem 0.75rem', background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
              >
                <Copy size={13} /> {copied ? 'Copied!' : 'Share with patient'}
              </button>
              <button
                onClick={() => setActiveRoom(null)}
                style={{ padding: '0.4rem 0.75rem', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', fontSize: '0.8rem' }}
              >
                Close
              </button>
            </div>
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', wordBreak: 'break-all' }}>
            {shareUrl}
          </div>
          <iframe
            title="Telehealth video consult"
            src={shareUrl}
            allow="camera; microphone; fullscreen; display-capture; autoplay"
            style={{ width: '100%', height: 600, border: 0, borderRadius: 8, background: '#000' }}
          />
        </div>
      )}
    </div>
  );
}
