import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { fetchApi, getAuthToken } from '../../../../utils/api';
import { useNotify } from '../../../../utils/notify';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../../../../components/wellness/DateRangeFilter';
import { labelStyle, inputStyle } from '../shared/helpers';

// ── Consent tab with signature canvas ─────────────────────────────
export default function ConsentTab({ patient, services, onSaved }) {
  const notify = useNotify();
  const canvasRef = useRef(null);
  const [templateName, setTemplateName] = useState('hair-transplant');
  const [serviceId, setServiceId] = useState('');
  const [saving, setSaving] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [templates, setTemplates] = useState([]);
  useEffect(() => {
    fetchApi('/api/wellness/consent-templates')
      .then((res) => {
        const list = Array.isArray(res) ? res.filter((t) => t.isActive !== false) : [];
        setTemplates(list);
        if (list.length > 0 && !list.some((t) => t.key === templateName)) {
          setTemplateName(list[0].key);
        }
      })
      .catch(() => { /* fall back to legacy hardcoded options below */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const selectedTemplate = templates.find((t) => t.key === templateName) || null;
  const [hasStrokes, setHasStrokes] = useState(false);

  const [downloadingId, setDownloadingId] = useState(null);

  const downloadConsentPdf = async (c) => {
    setDownloadingId(c.id);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/wellness/consents/${c.id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      console.warn(`[PDF Download] Status: ${res.status}, Content-Type: ${res.headers.get('content-type')}`);
      if (!res.ok) throw new Error(`PDF download failed (${res.status})`);
      const blob = await res.blob();
      console.warn(`[PDF Download] Blob size: ${blob.size} bytes, type: ${blob.type}`);
      if (blob.size === 0) throw new Error('PDF blob is empty');
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      console.error('[PDF Download Error]', err);
      notify.error(err.message || 'Failed to download consent PDF.');
    } finally {
      setDownloadingId(null);
    }
  };

  const startDraw = (e) => {
    setIsDrawing(true);
    setHasStrokes(true);
    const ctx = canvasRef.current.getContext('2d');
    const cssColor = getComputedStyle(canvasRef.current).getPropertyValue('--text-primary').trim();
    ctx.strokeStyle = cssColor || '#1f2937';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    const { x, y } = getCoords(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const draw = (e) => {
    if (!isDrawing) return;
    const ctx = canvasRef.current.getContext('2d');
    const { x, y } = getCoords(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const endDraw = () => setIsDrawing(false);
  const getCoords = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  };
  const clearSig = () => {
    const c = canvasRef.current;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    setHasStrokes(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!hasStrokes) {
      notify.error('Please capture the patient signature before saving the consent.');
      return;
    }
    setSaving(true);
    try {
      const signatureSvg = canvasRef.current.toDataURL('image/png');
      await fetchApi('/api/wellness/consents', {
        method: 'POST',
        body: JSON.stringify({
          patientId: patient.id,
          serviceId: serviceId || null,
          templateName,
          signatureSvg,
          captureMethod: 'tablet-handoff',
        }),
      });
      clearSig();
      onSaved();
      notify.success('Consent captured.');
    } catch (_err) { /* fetchApi already toasted */ } finally { setSaving(false); }
  };

  const allPriorConsents = Array.isArray(patient?.consents) ? patient.consents : [];
  const [consentFilter, setConsentFilter] = useState(EMPTY_DATE_FILTER);
  const [consentRangeStart, consentRangeEnd] = resolveDateRange(consentFilter);
  const priorConsents = (consentRangeStart && consentRangeEnd)
    ? allPriorConsents.filter((c) => {
        const ts = new Date(c.signedAt).getTime();
        return ts >= consentRangeStart.getTime() && ts <= consentRangeEnd.getTime();
      })
    : allPriorConsents;
  const formatPriorDate = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <form onSubmit={submit} className="glass" style={{ padding: '1.5rem' }}>
      <section
        data-testid="prior-consents"
        style={{
          marginBottom: '1.5rem',
          padding: '1rem',
          background: 'var(--card-bg, rgba(0,0,0,0.04))',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: 8,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Recent consents</h3>
          {allPriorConsents.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <DateRangeFilter value={consentFilter} onChange={setConsentFilter} label={null} />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {priorConsents.length === allPriorConsents.length
                  ? `${allPriorConsents.length}`
                  : `${priorConsents.length} of ${allPriorConsents.length}`}
              </span>
            </div>
          )}
        </div>
        {allPriorConsents.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No prior consents on file.
          </p>
        ) : priorConsents.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No consents in the selected range.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {priorConsents.map((c) => (
              <li
                key={c.id}
                style={{
                  padding: '0.4rem 0',
                  borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.06))',
                  fontSize: '0.875rem',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                  alignItems: 'baseline',
                }}
              >
                <strong>{c.templateName}</strong>
                <span style={{ color: 'var(--text-secondary)' }}>·</span>
                <span style={{ color: 'var(--text-secondary)' }}>{formatPriorDate(c.signedAt)} IST</span>
                {c.service?.name && (
                  <>
                    <span style={{ color: 'var(--text-secondary)' }}>·</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{c.service.name}</span>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => downloadConsentPdf(c)}
                  disabled={downloadingId === c.id}
                  title="Download signed consent PDF"
                  style={{
                    marginLeft: 'auto', background: 'transparent',
                    border: '1px solid var(--primary-color, var(--accent-color))',
                    color: 'var(--primary-color, var(--accent-color))',
                    padding: '0.2rem 0.6rem', borderRadius: 6, fontSize: '0.75rem',
                    cursor: downloadingId === c.id ? 'wait' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: '0.3rem',
                  }}
                >
                  <Download size={12} />
                  {downloadingId === c.id ? 'Downloading...' : 'PDF'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <h3 style={{ marginBottom: '1rem' }}>Capture consent</h3>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
        <div>
          <label style={labelStyle}>Template</label>
          <select value={templateName} onChange={(e) => setTemplateName(e.target.value)} style={inputStyle}>
            {templates.length > 0 ? (
              templates.map((t) => <option key={t.id} value={t.key}>{t.label}</option>)
            ) : (
              <>
                <option value="hair-transplant">Hair Transplant</option>
                <option value="botox-fillers">Botox / Fillers</option>
                <option value="laser">Laser Treatment</option>
                <option value="chemical-peel">Chemical Peel</option>
                <option value="general">General Procedure</option>
              </>
            )}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Service (optional)</label>
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={inputStyle}>
            <option value="">— none —</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      <section
        data-testid="consent-template-body"
        style={{
          marginBottom: '1rem',
          padding: '0.85rem 1rem',
          maxHeight: 240,
          overflowY: 'auto',
          background: 'var(--card-bg, rgba(0,0,0,0.04))',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: 8,
          fontSize: '0.85rem',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: '0.4rem' }}>
          {selectedTemplate?.label || templateName}
        </div>
        {selectedTemplate?.body ? (
          <div>{selectedTemplate.body}</div>
        ) : (
          <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            This template has no body text on file. Ask your administrator to
            add the consent wording (purpose, data categories, retention, jurisdiction)
            via Settings → Consent templates so DPDP §15 disclosures appear here.
          </div>
        )}
      </section>

      <div style={{ marginBottom: '1rem' }}>
        <label style={labelStyle}>Patient signature (sign below)</label>
        <canvas
          ref={canvasRef}
          width={600}
          height={180}
          style={{ width: '100%', maxWidth: 600, height: 180, background: 'var(--card-bg, rgba(0,0,0,0.04))', border: '2px dashed var(--accent-color, #C9A063)', borderRadius: 8, touchAction: 'none', cursor: 'crosshair' }}
          onMouseDown={startDraw}
          onMouseMove={draw}
          onMouseUp={endDraw}
          onMouseLeave={endDraw}
          onTouchStart={startDraw}
          onTouchMove={draw}
          onTouchEnd={endDraw}
        />
        <button type="button" onClick={clearSig} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', color: 'var(--text-secondary)', padding: '0.3rem 0.75rem', borderRadius: 8, cursor: 'pointer', fontSize: '0.75rem', marginTop: '0.5rem' }}>
          Clear signature
        </button>
      </div>

      <button
        type="submit"
        disabled={saving || !hasStrokes}
        title={!hasStrokes ? 'Patient must sign before saving' : ''}
        style={{
          padding: '0.55rem 1.25rem',
          background: hasStrokes ? 'var(--success-color)' : 'rgba(107,114,128,0.3)',
          color: '#fff', border: 'none', borderRadius: 8,
          cursor: hasStrokes && !saving ? 'pointer' : 'not-allowed',
          opacity: hasStrokes ? 1 : 0.6,
        }}
      >
        {saving ? 'Saving…' : 'Save consent'}
      </button>
    </form>
  );
}
