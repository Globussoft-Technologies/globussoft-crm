// Wellness Events History — Events Management sidebar entry.
//
// Lists every saved event from the backend and, when expanded, shows all
// QR codes generated for that event with a download button.
import { useContext, useEffect, useState } from 'react';
import {
  History,
  ChevronDown,
  ChevronRight,
  Download,
  Calendar,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useNotify } from '../../utils/notify';
import PageHeader from '../../components/PageHeader';
import { AuthContext } from '../../App';
import { loadEvents } from './QRGenerator';

export default function EventsHistory() {
  const notify = useNotify();
  const { tenant } = useContext(AuthContext) || {};
  const [events, setEvents] = useState([]);
  const [expandedIds, setExpandedIds] = useState(new Set());

  useEffect(() => {
    let cancelled = false;
    async function fetchEvents() {
      try {
        const data = await loadEvents();
        const list = data?.events || [];
        if (!cancelled) {
          setEvents(list);
          if (list.length > 0) {
            setExpandedIds(new Set([list[0].id]));
          }
        }
      } catch {
        if (!cancelled) setEvents([]);
      }
    }
    fetchEvents();
    return () => {
      cancelled = true;
    };
  }, [tenant?.id]);

  const toggleEvent = (id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDownloadQr = async (qr) => {
    try {
      const url = await QRCode.toDataURL(qr.text, {
        width: Math.max(64, Math.min(1024, Number(qr.size) || 256)),
        margin: 2,
        color: { dark: qr.fgColor, light: qr.bgColor },
        errorCorrectionLevel: qr.errorLevel,
      });
      const a = document.createElement('a');
      a.href = url;
      a.download = `qr-${(qr.name || 'untitled').replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      notify.success('QR code downloaded');
    } catch (err) {
      console.error('[EventsHistory] Download QR failed:', err);
      notify.error('Could not regenerate QR for download.');
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <PageHeader
        icon={History}
        title="Events History"
        description="All QR codes organized by event."
      />

      {events.length === 0 ? (
        <div className="glass" style={emptyStateCard}>
          <Calendar size={40} style={{ opacity: 0.5, marginBottom: '0.75rem' }} />
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.1rem' }}>No events yet</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Create an event in the QR Generator to start collecting QR codes here.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {events.map((event) => {
            const isExpanded = expandedIds.has(event.id);
            return (
              <div key={event.id} className="glass" style={cardStyle}>
                <button
                  type="button"
                  onClick={() => toggleEvent(event.id)}
                  aria-expanded={isExpanded}
                  style={eventHeader}
                >
                  {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  <span style={{ flex: 1, textAlign: 'left', fontWeight: 600, fontSize: '1rem' }}>
                    {event.name}
                  </span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                    {event.qrs.length} QR{event.qrs.length === 1 ? '' : 's'}
                  </span>
                </button>

                {isExpanded && (
                  <div style={{ paddingTop: '1rem' }}>
                    {event.qrs.length === 0 ? (
                      <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                        No QR codes for this event yet.
                      </p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        {event.qrs.map((qr) => (
                          <div
                            key={qr.id}
                            style={{
                              padding: '0.75rem',
                              border: '1px solid var(--border-color)',
                              borderRadius: 8,
                              background: 'rgba(255,255,255,0.03)',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
                                  {qr.name}
                                </div>
                                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                                  {new Date(qr.createdAt).toLocaleString()}
                                </div>
                                <div style={{ fontSize: '0.85rem', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                                  {qr.text}
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                                  {qr.size}px · {qr.errorLevel}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleDownloadQr(qr)}
                                style={{ ...btnSecondary, padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
                                title="Download this QR"
                              >
                                <Download size={14} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const emptyStateCard = {
  padding: '2rem',
  borderRadius: 12,
  border: '1px solid var(--border-color)',
  textAlign: 'center',
  color: 'var(--text-primary)',
};

const cardStyle = {
  padding: '1rem 1.25rem',
  borderRadius: 12,
  border: '1px solid var(--border-color)',
};

const eventHeader = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  padding: '0.25rem',
  background: 'transparent',
  border: 'none',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 'inherit',
};

const btnSecondary = {
  padding: '0.6rem 1rem',
  background: 'transparent',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  fontSize: '0.9rem',
};
