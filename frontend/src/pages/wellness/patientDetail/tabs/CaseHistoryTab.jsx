import { useState } from 'react';
import { Stethoscope, FileText, FileSignature, ChevronDown, ChevronUp } from 'lucide-react';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../../../components/wellness/DateRangeFilter';
import { RxDetailModal } from '../shared/components';

// Strip every customer-facing reference to the Zylu POS — patient.source
// values like "zylu-import", inline "[ZYLU-#nnn]" markers, and visit-note
// strings like "Zylu booking #15029981". The data stays untouched at
// rest; we just don't render those tokens to the end user.
function scrubZylu(text) {
  if (!text || typeof text !== 'string') return text || '';
  let t = text.replace(/\bzylu\s+booking\s*#?\s*\d+\.?/gi, '').trim();
  t = t.replace(/\[\s*zylu-?#?\d+\s*\]/gi, '').trim();
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

const kindColor = (k) => ({ visit: 'var(--accent-color)', rx: '#a855f7', consent: '#10b981' })[k] || '#64748b';
const kindLabel = (k) => ({ visit: 'Visit', rx: 'Prescription', consent: 'Consent signed' })[k] || k;
const kindIcon = (k) => {
  const size = 14;
  if (k === 'visit') return <Stethoscope size={size} />;
  if (k === 'rx') return <FileText size={size} />;
  if (k === 'consent') return <FileSignature size={size} />;
  return null;
};

// #278 sub-issue 1: previously this only rendered the drug rows and silently
// dropped Instructions, which is clinically unsafe (e.g. "take after food",
// "stop if rash appears"). We now surface instructions below the drugs and
// truncate long bodies behind an expand/collapse toggle.
function RxSummary({ drugs, instructions }) {
  const [expanded, setExpanded] = useState(false);
  let parsed = [];
  try { parsed = typeof drugs === 'string' ? JSON.parse(drugs) : drugs; } catch { return <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{String(drugs).slice(0, 120)}</div>; }
  if (!Array.isArray(parsed)) return null;

  const instr = (instructions || '').trim();
  const longInstr = instr.length > 140;
  const shownInstr = !longInstr || expanded ? instr : `${instr.slice(0, 140)}…`;

  return (
    <>
      <ul style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, paddingLeft: '1rem' }}>
        {parsed.slice(0, 3).map((d, i) => (
          <li key={i}>{d.name} — {d.dosage}, {d.frequency}{d.duration ? `, ${d.duration}` : ''}</li>
        ))}
        {parsed.length > 3 && <li>+ {parsed.length - 3} more</li>}
      </ul>
      {instr && (
        <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Instructions:</strong> {shownInstr}
          {longInstr && (
            <button
              type="button"
              onClick={(ev) => { ev.stopPropagation(); setExpanded((v) => !v); }}
              style={{
                marginLeft: '0.4rem', background: 'transparent', border: 'none',
                color: 'var(--accent-color)', cursor: 'pointer', fontSize: '0.78rem',
                display: 'inline-flex', alignItems: 'center', gap: '0.15rem', padding: 0,
              }}
            >
              {expanded ? <>Show less <ChevronUp size={11} /></> : <>Show more <ChevronDown size={11} /></>}
            </button>
          )}
        </div>
      )}
    </>
  );
}

// ── Case history tab ──────────────────────────────────────────────
export default function CaseHistoryTab({ patient }) {
  // #278: clicking an Rx card pops a detail modal with all fields + PDF download.
  const [openRx, setOpenRx] = useState(null);
  const [filter, setFilter] = useState(EMPTY_DATE_FILTER);

  const allEvents = [
    ...patient.visits.map((v) => ({ kind: 'visit', date: v.visitDate, data: v })),
    ...patient.prescriptions.map((p) => ({ kind: 'rx', date: p.createdAt, data: p })),
    ...patient.consents.map((c) => ({ kind: 'consent', date: c.signedAt, data: c })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  const [rangeStart, rangeEnd] = resolveDateRange(filter);
  const events = (rangeStart && rangeEnd)
    ? allEvents.filter((e) => {
        const ts = new Date(e.date).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : allEvents;

  const filterBar = (
    <div
      className="glass"
      style={{
        padding: '0.6rem 0.85rem', display: 'flex', flexWrap: 'wrap',
        alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem',
      }}
    >
      <DateRangeFilter value={filter} onChange={setFilter} />
      <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
        {events.length === allEvents.length
          ? `${allEvents.length} event${allEvents.length === 1 ? '' : 's'}`
          : `${events.length} of ${allEvents.length} events`}
      </span>
    </div>
  );

  if (allEvents.length === 0) {
    return (
      <>
        {filterBar}
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No case history yet.</div>
      </>
    );
  }

  if (events.length === 0) {
    return (
      <>
        {filterBar}
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No case history in the selected range.</div>
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {filterBar}
      {events.map((e, i) => {
        const clickable = e.kind === 'rx';
        return (
          <div
            key={i}
            className="glass"
            onClick={clickable ? () => setOpenRx(e.data) : undefined}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onKeyDown={clickable ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpenRx(e.data); } } : undefined}
            title={clickable ? 'Click to view full prescription details' : undefined}
            style={{ padding: '1rem', display: 'flex', gap: '0.75rem', cursor: clickable ? 'pointer' : 'default' }}
          >
            <div style={{ width: 8, background: kindColor(e.kind), borderRadius: 4, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  {kindIcon(e.kind)}
                  <strong style={{ textTransform: 'capitalize' }}>{kindLabel(e.kind)}</strong>
                  {e.kind === 'visit' && e.data.service?.name && <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>— {e.data.service.name}</span>}
                  {e.kind === 'consent' && <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>— {e.data.templateName}</span>}
                </div>
                {/* #244: pin Asia/Kolkata so test browsers / users in non-IST
                    zones still see the visit's IST calendar day + time. Without
                    an explicit timeZone, toLocaleString uses the browser's local
                    zone and a UTC-clocked test browser pushed late-evening IST
                    visits to the next calendar day. */}
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{new Date(e.date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
              </div>
              {e.kind === 'visit' && (
                <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                  {scrubZylu(e.data.notes) || 'No notes'}
                  {e.data.amountCharged && <> • <strong style={{ color: 'var(--success-color)' }}>₹{Math.round(e.data.amountCharged).toLocaleString('en-IN')}</strong></>}
                </div>
              )}
              {e.kind === 'rx' && (
                // #278 (sub-issue 1): the timeline summary now also surfaces
                // Instructions inline (collapsible if long). Sub-issue 2's
                // modal still shows the full record on click.
                <RxSummary drugs={e.data.drugs} instructions={e.data.instructions} />
              )}
            </div>
          </div>
        );
      })}
      {openRx && (
        <RxDetailModal
          rx={openRx}
          patient={patient}
          onClose={() => setOpenRx(null)}
        />
      )}
    </div>
  );
}
