// Wellness QR Generator — Events Management sidebar entry.
//
// Generates downloadable PNG QR codes client-side using the MIT `qrcode`
// library. QR codes are organised by event; each event holds one or more
// named QR configurations. Events and their QRs are persisted via the
// /api/wellness/qr-events backend API so they survive refreshes.
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  QrCode,
  Download,
  ExternalLink,
  Palette,
  RotateCcw,
  Check,
  Clock,
  Trash2,
  Plus,
  Search,
  ChevronDown,
  Pencil,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useNotify } from '../../utils/notify';
import { fetchApi } from '../../utils/api';
import PageHeader from '../../components/PageHeader';
import { AuthContext } from '../../App';

const ERROR_LEVELS = ['L', 'M', 'Q', 'H'];

/* eslint-disable react-refresh/only-export-components */
const QR_EVENTS_API = '/api/wellness/qr-events';

export async function loadEvents() {
  const data = await fetchApi(QR_EVENTS_API);
  return data || { events: [] };
}

export async function createEvent(name) {
  return fetchApi(QR_EVENTS_API, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function deleteEvent(eventId) {
  return fetchApi(`${QR_EVENTS_API}/${eventId}`, { method: 'DELETE' });
}

export async function createQr(eventId, fields) {
  return fetchApi(`${QR_EVENTS_API}/${eventId}/qrs`, {
    method: 'POST',
    body: JSON.stringify(fields),
  });
}

export async function updateQr(eventId, qrId, fields) {
  return fetchApi(`${QR_EVENTS_API}/${eventId}/qrs/${qrId}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
}

export async function deleteQr(eventId, qrId) {
  return fetchApi(`${QR_EVENTS_API}/${eventId}/qrs/${qrId}`, { method: 'DELETE' });
}
/* eslint-enable react-refresh/only-export-components */

export default function QRGenerator() {
  const notify = useNotify();
  const { tenant } = useContext(AuthContext) || {};

  const [events, setEvents] = useState([]);
  const [selectedEventId, setSelectedEventId] = useState('');
  const [qrName, setQrName] = useState('');
  const [text, setText] = useState('');
  const [size, setSize] = useState(256);
  const [fgColor, setFgColor] = useState('#000000');
  const [bgColor, setBgColor] = useState('#ffffff');
  const [errorLevel, setErrorLevel] = useState('M');
  const [editingQrId, setEditingQrId] = useState(null);
  const [dataUrl, setDataUrl] = useState('');
  const [generating, setGenerating] = useState(false);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [creatingInline, setCreatingInline] = useState(false);
  const [newEventName, setNewEventName] = useState('');

  const dropdownRef = useRef(null);
  const canvasRef = useRef(null);
  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedEventId) || null,
    [events, selectedEventId],
  );

  // Close the dropdown when clicking outside.
  useEffect(() => {
    if (!dropdownOpen) return undefined;
    const onDocClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [dropdownOpen]);

  // Auto-select the first event when data loads and nothing is selected.
  useEffect(() => {
    if (!selectedEventId && events.length > 0) {
      setSelectedEventId(events[0].id);
    }
  }, [events, selectedEventId]);

  // Generate the live QR preview whenever the text or design options change.
  useEffect(() => {
    let cancelled = false;
    if (!text.trim()) {
      setDataUrl('');
      return undefined;
    }
    setGenerating(true);
    QRCode.toDataURL(text, {
      width: Math.max(64, Math.min(1024, Number(size) || 256)),
      margin: 2,
      color: {
        dark: fgColor,
        light: bgColor,
      },
      errorCorrectionLevel: errorLevel,
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[QRGenerator] QR generation failed:', err);
          setDataUrl('');
        }
      })
      .finally(() => {
        if (!cancelled) setGenerating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [text, size, fgColor, bgColor, errorLevel]);

  // Also paint a canvas so users can right-click / copy if they prefer.
  useEffect(() => {
    if (!canvasRef.current || !text.trim()) return;
    const canvas = canvasRef.current;
    QRCode.toCanvas(canvas, text, {
      width: Math.max(64, Math.min(1024, Number(size) || 256)),
      margin: 2,
      color: { dark: fgColor, light: bgColor },
      errorCorrectionLevel: errorLevel,
    }).catch(() => {});
  }, [text, size, fgColor, bgColor, errorLevel]);

  const refreshEvents = useCallback(async () => {
    try {
      const data = await loadEvents();
      setEvents(data?.events || []);
    } catch {
      // fetchApi already surfaces user-facing errors.
    }
  }, []);

  // Load events from the backend on mount / tenant change.
  useEffect(() => {
    let cancelled = false;
    async function fetchEvents() {
      try {
        const data = await loadEvents();
        if (!cancelled) setEvents(data?.events || []);
      } catch {
        if (!cancelled) setEvents([]);
      }
    }
    fetchEvents();
    return () => {
      cancelled = true;
    };
  }, [tenant?.id]);

  const resetForm = useCallback(() => {
    setQrName('');
    setText('');
    setSize(256);
    setFgColor('#000000');
    setBgColor('#ffffff');
    setErrorLevel('M');
    setEditingQrId(null);
  }, []);

  const handleCreateEvent = async () => {
    const trimmed = newEventName.trim();
    if (!trimmed) {
      notify.error('Enter an event name.');
      return;
    }
    try {
      const created = await createEvent(trimmed);
      await refreshEvents();
      setSelectedEventId(created.id);
      setNewEventName('');
      setCreatingInline(false);
      setDropdownOpen(false);
      setSearchTerm('');
      notify.success(`Event "${created.name}" created`);
    } catch {
      // fetchApi already surfaces user-facing errors.
    }
  };

  const handleEventSelect = (value) => {
    setSelectedEventId(value);
    setDropdownOpen(false);
    setSearchTerm('');
  };

  const handleGenerate = useCallback(async () => {
    if (!text.trim()) {
      notify.error('Enter a URL before generating.');
      return;
    }
    if (!selectedEventId) {
      notify.error('Select or create an event first.');
      return;
    }
    const qrFields = { name: qrName, text, size, fgColor, bgColor, errorLevel };
    try {
      if (editingQrId) {
        await updateQr(selectedEventId, editingQrId, qrFields);
        notify.success('QR updated');
      } else {
        await createQr(selectedEventId, qrFields);
        notify.success('QR added to event');
      }
      await refreshEvents();
      resetForm();
    } catch {
      // fetchApi already surfaces user-facing errors.
    }
  }, [
    text,
    selectedEventId,
    qrName,
    size,
    fgColor,
    bgColor,
    errorLevel,
    editingQrId,
    refreshEvents,
    resetForm,
    notify,
  ]);

  const handleEditQr = (qr) => {
    setEditingQrId(qr.id);
    setQrName(qr.name || '');
    setText(qr.text || '');
    setSize(qr.size ?? 256);
    setFgColor(qr.fgColor || '#000000');
    setBgColor(qr.bgColor || '#ffffff');
    setErrorLevel(qr.errorLevel || 'M');
  };

  const handleDeleteQr = async (qrId) => {
    try {
      await deleteQr(selectedEventId, qrId);
      await refreshEvents();
      if (editingQrId === qrId) resetForm();
    } catch {
      // fetchApi already surfaces user-facing errors.
    }
  };

  const handleDownload = () => {
    if (!dataUrl) return;
    const fileName = editingQrId
      ? `qr-${(qrName || 'untitled').replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.png`
      : `qr-${Date.now()}.png`;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    notify.success('QR code downloaded');
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
      console.error('[QRGenerator] Download QR failed:', err);
      notify.error('Could not regenerate QR for download.');
    }
  };

  const openGeneratedLink = () => {
    if (!text.trim()) return;
    window.open(text, '_blank', 'noopener,noreferrer');
  };

  const filteredEvents = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return events;
    return events.filter((e) => e.name.toLowerCase().includes(term));
  }, [events, searchTerm]);

  const dropdownDisplay = selectedEvent ? selectedEvent.name : 'Select an event';

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <PageHeader
        icon={QrCode}
        title="QR Generator"
        description="Create downloadable QR codes for your clinic events."
      />

      {/* Event selector */}
      <div className="glass" style={{ ...cardStyle, marginBottom: '1.5rem', overflow: 'visible', position: 'relative', zIndex: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <Palette size={18} />
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Event</h3>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div ref={dropdownRef} style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 420 }}>
            <button
              type="button"
              onClick={() => setDropdownOpen((open) => !open)}
              data-testid="event-dropdown-trigger"
              aria-haspopup="listbox"
              aria-expanded={dropdownOpen}
              style={{
                ...inputStyle,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {dropdownDisplay}
              </span>
              <ChevronDown size={16} style={{ flexShrink: 0, marginLeft: '0.5rem' }} />
            </button>

            {dropdownOpen && (
              <div
                role="listbox"
                data-testid="event-dropdown-panel"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  right: 0,
                  maxHeight: 320,
                  overflowY: 'auto',
                  background: 'var(--surface-color, #fff)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 8,
                  zIndex: 100,
                  boxShadow: 'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.12))',
                }}
              >
                <div style={{ padding: '0.5rem', borderBottom: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <Search size={14} style={{ opacity: 0.6 }} />
                    <input
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      placeholder="Search events"
                      style={{
                        border: 'none',
                        background: 'transparent',
                        outline: 'none',
                        color: 'var(--text-primary)',
                        fontSize: '0.9rem',
                        width: '100%',
                      }}
                    />
                  </div>
                </div>
                {filteredEvents.length === 0 && (
                  <div style={{ padding: '0.75rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    No events found. Use <strong>+ New event</strong> to create one.
                  </div>
                )}
                {filteredEvents.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    role="option"
                    aria-selected={event.id === selectedEventId}
                    onClick={() => handleEventSelect(event.id)}
                    style={{
                      ...dropdownItem,
                      background: event.id === selectedEventId ? 'var(--subtle-bg-3, rgba(201,160,99,0.12))' : 'transparent',
                    }}
                  >
                    {event.id === selectedEventId && <Check size={14} />}
                    <span>{event.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            data-testid="new-event-button"
            onClick={() => {
              setDropdownOpen(false);
              setCreatingInline(true);
            }}
            style={btnPrimary}
            title="Create a new event"
          >
            <Plus size={16} /> New event
          </button>
        </div>

        {creatingInline && (
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>New event name</label>
              <input
                value={newEventName}
                onChange={(e) => setNewEventName(e.target.value)}
                placeholder="e.g. Summer Camp 2026"
                autoFocus
                style={{ ...inputStyle, marginTop: '0.35rem' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateEvent();
                  if (e.key === 'Escape') {
                    setCreatingInline(false);
                    setNewEventName('');
                  }
                }}
              />
            </div>
            <button type="button" onClick={handleCreateEvent} style={btnPrimary}>
              Create
            </button>
            <button
              type="button"
              onClick={() => {
                setCreatingInline(false);
                setNewEventName('');
              }}
              style={btnSecondary}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1.5rem',
          alignItems: 'start',
        }}
      >
        {/* Left column — inputs + design */}
        <div className="glass" style={cardStyle}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>QR name</label>
            <input
              value={qrName}
              onChange={(e) => setQrName(e.target.value)}
              placeholder="e.g. Registration desk"
              style={{ ...inputStyle, marginTop: '0.35rem' }}
              title="A friendly name for this QR code."
            />
          </div>

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>URL</label>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Enter URL here"
              style={{ ...inputStyle, marginTop: '0.35rem', fontSize: '0.9rem' }}
              title="The URL encoded in the QR code."
            />
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
            <button
              type="button"
              onClick={openGeneratedLink}
              disabled={!text.trim()}
              style={btnSecondary}
              title="Open the generated link in a new browser tab to test it."
            >
              <ExternalLink size={14} /> Test in browser
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              style={btnPrimary}
              title={editingQrId ? 'Save changes to this QR code.' : 'Generate the QR code and add it to the selected event.'}
            >
              <QrCode size={14} /> {editingQrId ? 'Update QR' : 'Generate QR'}
            </button>
            {editingQrId && (
              <button
                type="button"
                onClick={resetForm}
                style={btnSecondary}
                title="Cancel editing and clear the form."
              >
                Cancel
              </button>
            )}
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '1.25rem 0' }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <Palette size={18} />
            <h4 style={{ margin: 0, fontSize: '1rem' }}>Design</h4>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem', marginBottom: '1rem' }}>
            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.35rem' }}>
                <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>Foreground</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  id="qr-fg-color"
                  type="color"
                  value={fgColor}
                  onChange={(e) => setFgColor(e.target.value)}
                  style={{ ...colorInput, borderColor: fgColor }}
                  aria-label="QR foreground color"
                />
                <input
                  id="qr-fg-color-text"
                  type="text"
                  value={fgColor}
                  onChange={(e) => setFgColor(e.target.value)}
                  style={{ ...inputStyle, flex: 1, fontFamily: 'monospace' }}
                  maxLength={7}
                />
              </div>
            </div>
            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.35rem' }}>
                <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>Background</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  id="qr-bg-color"
                  type="color"
                  value={bgColor}
                  onChange={(e) => setBgColor(e.target.value)}
                  style={{ ...colorInput, borderColor: bgColor }}
                  aria-label="QR background color"
                />
                <input
                  id="qr-bg-color-text"
                  type="text"
                  value={bgColor}
                  onChange={(e) => setBgColor(e.target.value)}
                  style={{ ...inputStyle, flex: 1, fontFamily: 'monospace' }}
                  maxLength={7}
                />
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem', marginBottom: '1rem' }}>
            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.35rem' }}>
                <label htmlFor="qr-size" style={{ fontSize: '0.9rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  Size ({size}px)
                </label>
              </div>
              <input
                id="qr-size"
                type="range"
                min={128}
                max={512}
                step={16}
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.35rem' }}>
                <label htmlFor="qr-error-level" style={{ fontSize: '0.9rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  Error correction
                </label>
              </div>
              <select
                id="qr-error-level"
                value={errorLevel}
                onChange={(e) => setErrorLevel(e.target.value)}
                style={inputStyle}
              >
                {ERROR_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l} — {levelDescription(l)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => {
                setFgColor('#000000');
                setBgColor('#ffffff');
                setSize(256);
                setErrorLevel('M');
              }}
              style={btnSecondary}
              title="Restore the default QR design settings."
            >
              <RotateCcw size={14} /> Reset design
            </button>
          </div>
        </div>

        {/* Right column — preview + event QR list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="glass" style={{ ...cardStyle, textAlign: 'center' }}>
            <h3 style={{ margin: '0 0 1rem', fontSize: '1.1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
              <QrCode size={20} /> Preview
            </h3>

            <div
              style={{
                background: bgColor,
                border: '1px dashed var(--border-color)',
                borderRadius: 12,
                padding: '1rem',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 320,
                width: '100%',
                overflow: 'auto',
              }}
            >
              {dataUrl ? (
                <img
                  src={dataUrl}
                  alt="QR code preview"
                  style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
                  width={size}
                  height={size}
                />
              ) : (
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  {generating ? 'Generating…' : 'Enter a URL to preview the QR code.'}
                </div>
              )}
              <canvas ref={canvasRef} style={{ display: 'none' }} />
            </div>

            <div style={{ marginTop: '1rem', color: 'var(--text-secondary)', fontSize: '0.85rem', wordBreak: 'break-all' }}>
              {text || 'No URL entered'}
            </div>

            <button
              type="button"
              onClick={handleDownload}
              disabled={!dataUrl}
              style={{ ...btnPrimary, marginTop: '1.25rem', width: '100%', justifyContent: 'center' }}
              title="Download the QR code as a PNG image."
            >
              <Download size={18} /> Download PNG
            </button>
          </div>

          {selectedEvent && selectedEvent.qrs.length > 0 && (
            <div className="glass" style={cardStyle}>
              <h3 style={{ margin: '0 0 1rem', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Clock size={18} /> {selectedEvent.name} — Generated QRs
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {selectedEvent.qrs.map((qr) => (
                  <div
                    key={qr.id}
                    style={{
                      padding: '0.75rem',
                      border: '1px solid var(--border-color)',
                      borderRadius: 8,
                      background: editingQrId === qr.id ? 'var(--subtle-bg-3, rgba(201,160,99,0.12))' : 'rgba(255,255,255,0.03)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
                          {qr.name}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                          {new Date(qr.createdAt).toLocaleString()}
                          {qr.updatedAt && qr.updatedAt !== qr.createdAt && ` · edited`}
                        </div>
                        <div style={{ fontSize: '0.85rem', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                          {qr.text}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                          {qr.size}px · {qr.errorLevel}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.35rem', flexShrink: 0 }}>
                        <button
                          type="button"
                          onClick={() => handleEditQr(qr)}
                          style={{ ...btnSecondary, padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
                          title="Edit this QR code"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDownloadQr(qr)}
                          style={{ ...btnSecondary, padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
                          title="Download this QR"
                        >
                          <Download size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteQr(qr.id)}
                          style={{ ...btnSecondary, padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
                          title="Delete from event"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function levelDescription(level) {
  switch (level) {
    case 'L': return 'Low (~7%)';
    case 'M': return 'Medium (~15%)';
    case 'Q': return 'Quartile (~25%)';
    case 'H': return 'High (~30%)';
    default: return level;
  }
}

const cardStyle = {
  padding: '1.5rem',
  borderRadius: 12,
  border: '1px solid var(--border-color)',
};

const inputStyle = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'transparent',
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  boxSizing: 'border-box',
};

const colorInput = {
  width: 40,
  height: 40,
  padding: 2,
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  background: 'transparent',
  cursor: 'pointer',
};

const btnPrimary = {
  padding: '0.65rem 1.25rem',
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  fontWeight: 600,
  fontSize: '0.95rem',
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

const dropdownItem = {
  width: '100%',
  padding: '0.6rem 0.75rem',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--border-color)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  fontSize: '0.9rem',
  textAlign: 'left',
};
