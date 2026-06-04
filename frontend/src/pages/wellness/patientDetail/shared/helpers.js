export const labelStyle = {
  display: 'block',
  fontSize: '0.75rem',
  color: 'var(--text-secondary)',
  marginBottom: '0.3rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

export const inputStyle = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  outline: 'none',
};

export const th = {
  textAlign: 'left',
  padding: '0.5rem 0.6rem',
  color: 'var(--text-secondary)',
  fontWeight: 500,
  fontSize: '0.78rem',
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

export const td = {
  padding: '0.5rem 0.6rem',
  verticalAlign: 'top',
};

export function computeAgeFromDob(dob) {
  if (!dob) return '';
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 ? String(age) : '';
}

export function sexLabel(g) {
  if (!g) return '';
  if (g === 'M') return 'Male';
  if (g === 'F') return 'Female';
  return g;
}

export function parseRxInstructions(raw) {
  const out = { zyluId: '', chiefComplaint: '', diagnosis: '', investigations: '', advice: '', status: '', notes: '' };
  if (!raw || typeof raw !== 'string') return out;
  const lines = raw.split(/\r?\n/);
  const leftover = [];
  let bucket = null;
  for (const line of lines) {
    const z = line.match(/^\s*\[ZYLU-#?(\d+)\]\s*$/i);
    if (z) { out.zyluId = z[1]; bucket = null; continue; }
    const m = line.match(/^\s*(chief complaint|diagnosis|investigations?|advice|advice\/referrals?|status|notes?)\s*:\s*(.*)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key.startsWith('chief')) { out.chiefComplaint = val; bucket = 'chiefComplaint'; }
      else if (key.startsWith('diagnosis')) { out.diagnosis = val; bucket = 'diagnosis'; }
      else if (key.startsWith('invest')) { out.investigations = val; bucket = 'investigations'; }
      else if (key.startsWith('advice')) { out.advice = val; bucket = 'advice'; }
      else if (key.startsWith('status')) { out.status = val; bucket = null; }
      else if (key.startsWith('note')) { out.notes = val; bucket = 'notes'; }
      continue;
    }
    if (bucket && line.trim()) {
      out[bucket] = (out[bucket] ? out[bucket] + '\n' : '') + line.trim();
    } else if (line.trim()) {
      leftover.push(line.trim());
    }
  }
  if (!out.notes && leftover.length) out.notes = leftover.join('\n');
  return out;
}
