// Wellness QR Generator — Marketing sidebar entry.
//
// Generates downloadable PNG QR codes client-side using the MIT `qrcode`
// library. Supports custom URLs/text plus quick presets for the authenticated
// wellness booking page and gift-card storefront. History is kept in
// localStorage per tenant so generated QR configurations persist across
// refreshes.
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
  Type,
  Gift,
  CalendarDays,
  Palette,
  RotateCcw,
  Check,
  Clock,
  Trash2,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useNotify } from '../../utils/notify';
import PageHeader from '../../components/PageHeader';
import { AuthContext } from '../../App';

const SOURCE_TYPES = [
  {
    key: 'custom',
    label: 'Custom URL / Text',
    icon: Type,
    tooltip: 'Link to any website, form, or text you want.',
  },
  {
    key: 'booking',
    label: 'Public Booking Page',
    icon: CalendarDays,
    tooltip: 'Link to your authenticated appointment booking page.',
  },
  {
    key: 'giftcards',
    label: 'Buy Gift Cards',
    icon: Gift,
    tooltip: 'Link to the gift card purchase page.',
  },
];

const ERROR_LEVELS = ['L', 'M', 'Q', 'H'];

function historyKey(tenantId) {
  return `wellness-qr-history-${tenantId || 'default'}`;
}

function loadHistory(tenantId) {
  try {
    const raw = localStorage.getItem(historyKey(tenantId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(tenantId, history) {
  try {
    localStorage.setItem(historyKey(tenantId), JSON.stringify(history));
  } catch {
    // Ignore storage quota / private-mode errors.
  }
}

export default function QRGenerator() {
  const notify = useNotify();
  const { tenant } = useContext(AuthContext) || {};
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const [sourceType, setSourceType] = useState('custom');
  const [text, setText] = useState('');
  const [size, setSize] = useState(256);
  const [fgColor, setFgColor] = useState('#000000');
  const [bgColor, setBgColor] = useState('#ffffff');
  const [errorLevel, setErrorLevel] = useState('M');
  const [dataUrl, setDataUrl] = useState('');
  const [generating, setGenerating] = useState(false);
  const [history, setHistory] = useState(() => loadHistory(tenant?.id));

  const canvasRef = useRef(null);

  // Build the canonical URL from the current source selection.
  const computedUrl = useMemo(() => {
    if (sourceType === 'custom') return text;
    if (sourceType === 'booking') return `${origin}/wellness/book-appointment`;
    if (sourceType === 'giftcards') return `${origin}/wellness/buy-giftcards`;
    return '';
  }, [sourceType, text, origin]);

  // Sync the editable text when a preset changes so the user sees the target URL.
  useEffect(() => {
    if (sourceType !== 'custom') {
      setText(computedUrl);
    }
  }, [computedUrl, sourceType]);

  // Generate the live QR preview whenever the text or design options change.
  useEffect(() => {
    let cancelled = false;
    if (!text.trim()) {
      setDataUrl('');
      return;
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

  const handleDownload = () => {
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `qr-${sourceType}-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    notify.success('QR code downloaded');
  };

  const handleGenerate = useCallback(() => {
    if (!text.trim()) {
      notify.error('Enter a URL or text before generating.');
      return;
    }
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sourceType,
      text,
      size,
      fgColor,
      bgColor,
      errorLevel,
      createdAt: new Date().toISOString(),
    };
    const next = [entry, ...history].slice(0, 50);
    setHistory(next);
    saveHistory(tenant?.id, next);
    notify.success('QR saved to history');
  }, [text, sourceType, size, fgColor, bgColor, errorLevel, history, tenant?.id, notify]);

  const restoreHistoryItem = (item) => {
    setSourceType(item.sourceType);
    setText(item.text);
    setSize(item.size);
    setFgColor(item.fgColor);
    setBgColor(item.bgColor);
    setErrorLevel(item.errorLevel);
  };

  const deleteHistoryItem = (id) => {
    const next = history.filter((h) => h.id !== id);
    setHistory(next);
    saveHistory(tenant?.id, next);
  };

  const downloadHistoryItem = async (item) => {
    try {
      const url = await QRCode.toDataURL(item.text, {
        width: Math.max(64, Math.min(1024, Number(item.size) || 256)),
        margin: 2,
        color: { dark: item.fgColor, light: item.bgColor },
        errorCorrectionLevel: item.errorLevel,
      });
      const a = document.createElement('a');
      a.href = url;
      a.download = `qr-${item.sourceType}-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      notify.success('QR code downloaded');
    } catch (err) {
      console.error('[QRGenerator] Download from history failed:', err);
      notify.error('Could not regenerate QR for download.');
    }
  };

  const openGeneratedLink = () => {
    if (!text.trim()) return;
    window.open(text, '_blank', 'noopener,noreferrer');
  };

  const selectedSource = SOURCE_TYPES.find((s) => s.key === sourceType);
  const SourceIcon = selectedSource?.icon || QrCode;

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <PageHeader
        icon={QrCode}
        title="QR Generator"
        description="Create downloadable QR codes for your clinic's booking page, gift cards, or any custom link."
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1.5rem',
          alignItems: 'start',
        }}
      >
        {/* Left column — source + options */}
        <div className="glass" style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
            <SourceIcon size={20} />
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Source</h3>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.5rem', marginBottom: '1.25rem' }}>
            {SOURCE_TYPES.map((source) => {
              const Icon = source.icon;
              const active = source.key === sourceType;
              return (
                <button
                  key={source.key}
                  type="button"
                  title={source.tooltip}
                  onClick={() => setSourceType(source.key)}
                  style={{
                    ...sourceChip,
                    background: active ? 'var(--primary-color, var(--accent-color))' : 'transparent',
                    color: active ? '#fff' : 'var(--text-primary)',
                    borderColor: active ? 'var(--primary-color, var(--accent-color))' : 'var(--border-color)',
                  }}
                  aria-pressed={active}
                >
                  <Icon size={16} />
                  <span>{source.label}</span>
                  {active && <Check size={14} />}
                </button>
              );
            })}
          </div>

          {sourceType === 'booking' && (
            <div style={{ ...helperBox, marginBottom: '1rem' }}>
              <CalendarDays size={16} />
              <span>
                QR will link to <strong>{origin}/wellness/book-appointment</strong>. Scanner must be logged in to book.
              </span>
            </div>
          )}

          {sourceType === 'giftcards' && (
            <div style={{ ...helperBox, marginBottom: '1rem' }}>
              <Gift size={16} />
              <span>
                QR will link to <strong>{origin}/wellness/buy-giftcards</strong>. Scanner must be logged in to purchase.
              </span>
            </div>
          )}

          <div style={{ marginBottom: '0.75rem' }}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={sourceType === 'custom' ? '' : 'Generated link'}
              disabled={sourceType !== 'custom'}
              style={{ ...inputStyle, fontFamily: sourceType === 'custom' ? 'inherit' : 'monospace', fontSize: '0.9rem' }}
              title="The URL or text encoded in the QR code."
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
              title="Generate the QR code and save it to history."
            >
              <QrCode size={14} /> Generate QR
            </button>
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

        {/* Right column — preview + history */}
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
                  {generating ? 'Generating…' : 'Enter a URL or choose a source to preview the QR code.'}
                </div>
              )}
              <canvas ref={canvasRef} style={{ display: 'none' }} />
            </div>

            <div style={{ marginTop: '1rem', color: 'var(--text-secondary)', fontSize: '0.85rem', wordBreak: 'break-all' }}>
              {text || 'No content selected'}
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

          {history.length > 0 && (
            <div className="glass" style={cardStyle}>
              <h3 style={{ margin: '0 0 1rem', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Clock size={18} /> History
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {history.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      padding: '0.75rem',
                      border: '1px solid var(--border-color)',
                      borderRadius: 8,
                      background: 'rgba(255,255,255,0.03)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                          {new Date(item.createdAt).toLocaleString()}
                        </div>
                        <div style={{ fontSize: '0.85rem', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                          {item.text}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                          {SOURCE_TYPES.find((s) => s.key === item.sourceType)?.label} · {item.size}px · {item.errorLevel}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.35rem', flexShrink: 0 }}>
                        <button
                          type="button"
                          onClick={() => restoreHistoryItem(item)}
                          style={{ ...btnSecondary, padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
                          title="Restore this configuration"
                        >
                          Restore
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadHistoryItem(item)}
                          style={{ ...btnSecondary, padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
                          title="Download this QR again"
                        >
                          <Download size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteHistoryItem(item.id)}
                          style={{ ...btnSecondary, padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
                          title="Delete from history"
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

const sourceChip = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.4rem',
  padding: '0.5rem 0.6rem',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: '0.8rem',
  fontWeight: 500,
  transition: 'all 0.15s ease',
};

const inputStyle = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'transparent',
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  marginTop: '0.35rem',
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

const helperBox = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.5rem',
  padding: '0.75rem',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.05)',
  color: 'var(--text-secondary)',
  fontSize: '0.85rem',
};
