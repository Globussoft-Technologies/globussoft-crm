import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Plus, Users, Phone, Mail } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

export default function Patients() {
  const notify = useNotify();
  const [patients, setPatients] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  // #331-bug fix: form-create flag added so handleCreate can request a refresh
  // without re-introducing a stale-state read. The previous direct `load()`
  // call inside handleCreate re-fetched with whatever `q` the closure had
  // captured when the form was rendered, which raced against the debounced
  // search effect.
  const [reloadTick, setReloadTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [locations, setLocations] = useState([]);
  const [form, setForm] = useState({ name: '', phone: '', email: '', gender: '', source: 'walk-in', locationId: '' });

  // #331: search box dropped the first character of a fresh query.
  //
  // Root cause: two interacting issues.
  //  1. On mount, the debounced fetch effect ran with q=''. Under React 18
  //     StrictMode (and dev double-invoke) this scheduled a no-op
  //     "fetch all patients" request that completed AFTER the user's first
  //     keystroke fetch. The second response overwrote the filtered list,
  //     re-rendered the table as "No patients found" because the
  //     subsequent typed-query fetch had already updated `loading=false`
  //     and `patients=[]` was the most recent server reply for an
  //     in-flight cancelled request whose stale resolution still landed.
  //  2. The `load` closure captured `q` at definition time. By the time
  //     the timer fired, `q` could be one keystroke behind the input
  //     value because re-renders re-create `load`, but the timer ID being
  //     cleaned up was the one captured by the OUTER useEffect — fine
  //     for cancellation, but the bound `load` that did get called still
  //     used the latest q. The actual cause was (1) — the racing empty
  //     fetch — but to be safe we also (a) read `q` via a ref so the
  //     timer body always sees the current value, (b) tag each fetch
  //     with a request id and ignore stale responses, and (c) skip the
  //     no-op empty-string fetch on initial mount.
  const qRef = useRef(q);
  useEffect(() => { qRef.current = q; }, [q]);
  const reqIdRef = useRef(0);
  const didMountRef = useRef(false);

  const load = (currentQ) => {
    const myReqId = ++reqIdRef.current;
    setLoading(true);
    const url = currentQ ? `/api/wellness/patients?q=${encodeURIComponent(currentQ)}` : '/api/wellness/patients';
    fetchApi(url)
      .then((d) => {
        // Drop stale responses — a slow empty-query fetch must not stomp
        // on a fresher typed-query fetch.
        if (myReqId !== reqIdRef.current) return;
        setPatients(d.patients);
        setTotal(d.total);
      })
      .catch(() => {
        if (myReqId !== reqIdRef.current) return;
        setPatients([]);
        setTotal(0);
      })
      .finally(() => {
        if (myReqId !== reqIdRef.current) return;
        setLoading(false);
      });
  };

  useEffect(() => {
    // First mount: do exactly one immediate load with empty q so the table
    // populates, but don't go through the debounced path that races with
    // the user's first keystroke.
    if (!didMountRef.current) {
      didMountRef.current = true;
      load('');
      return;
    }
    const t = setTimeout(() => load(qRef.current), 250);
    return () => clearTimeout(t);
  }, [q, reloadTick]);

  useEffect(() => {
    fetchApi('/api/wellness/locations').then(setLocations).catch(() => setLocations([]));
  }, []);

  // #108: phone may be optional, but if present must look like a real phone number
  // (10–15 digits after stripping +, -, spaces, parens). Pre-fix the form accepted
  // arbitrary text like "abc123notaphone".
  const isValidPhone = (p) => {
    if (!p || !p.trim()) return true; // optional
    const digits = p.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15;
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    // #337: reject whitespace-only names. The HTML `required` attribute on
    // the input only checks `value.length >= 1`, so "   " sails through.
    // Trim before any other validation so we also normalise the saved name.
    const trimmedName = (form.name || '').trim();
    if (trimmedName.length < 1) {
      notify.error('Name is required');
      return;
    }
    if (!isValidPhone(form.phone)) {
      notify.error('Phone number is invalid. Enter 10–15 digits (formatting characters like +, -, spaces, and parentheses are allowed).');
      return;
    }
    try {
      const payload = { ...form, name: trimmedName, locationId: form.locationId ? parseInt(form.locationId) : null };
      await fetchApi('/api/wellness/patients', { method: 'POST', body: JSON.stringify(payload) });
      notify.success(`Patient "${trimmedName}" added`);
      setForm({ name: '', phone: '', email: '', gender: '', source: 'walk-in', locationId: locations[0]?.id || '' });
      setShowAdd(false);
      // #331: bump reloadTick instead of calling load() directly so the
      // debounced effect handles the refresh consistently and reads the
      // latest q via the ref.
      setReloadTick((t) => t + 1);
    } catch (_err) { /* fetchApi already toasted */ }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-family)', fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Users size={24} /> Patients
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{total.toLocaleString()} total</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
        >
          <Plus size={16} /> {showAdd ? 'Cancel' : 'New patient'}
        </button>
      </header>

      {showAdd && (
        <form onSubmit={handleCreate} className="glass" style={{ padding: '1rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
          <input placeholder="Name *" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={inputStyle} />
          <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={inputStyle} />
          <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} style={inputStyle}>
            <option value="">Gender</option>
            <option value="M">Male</option>
            <option value="F">Female</option>
            <option value="Other">Other</option>
          </select>
          {/* #317: option `value` is the canonical lowercase / kebab-case
              enum that matches the DB. Display labels stay human-readable.
              Pre-fix, mixed casing between this form ("Referral") and what
              the backend stored ("referral") meant the source filter dropdown
              showed two distinct entries for the same logical source and
              filtered patients incorrectly. Keeping a single source of truth
              here prevents the divergence from re-emerging. */}
          <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} style={inputStyle}>
            <option value="walk-in">Walk-in</option>
            <option value="referral">Referral</option>
            <option value="website-form">Website form</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="instagram">Instagram</option>
            <option value="meta-ad">Meta ad</option>
            <option value="google-ad">Google ad</option>
            <option value="indiamart">IndiaMART</option>
          </select>
          {locations.length > 1 && (
            <select value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })} style={inputStyle}>
              <option value="">Select clinic</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
          <button type="submit" style={{ padding: '0.55rem 1rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Save</button>
        </form>
      )}

      <div className="glass" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Search size={16} color="var(--text-secondary)" />
        <input
          placeholder="Search by name, phone, or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '0.9rem' }}
        />
      </div>

      {loading && <div>Loading…</div>}

      {!loading && (
        <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
          {/* #229: table-layout: fixed prevents a single very long patient name
              from blowing the column widths and pushing later columns offscreen.
              Combined with the ellipsis style on the name cell. */}
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <th style={{ ...thStyle, width: '22%' }}>Name</th>
                <th style={{ ...thStyle, width: '15%' }}>Phone</th>
                <th style={{ ...thStyle, width: '23%' }}>Email</th>
                <th style={{ ...thStyle, width: '10%' }}>Gender</th>
                <th style={{ ...thStyle, width: '15%' }}>Source</th>
                <th style={{ ...thStyle, width: '15%' }}>Added</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={nameTdStyle} title={p.name}>
                    <Link to={`/wellness/patients/${p.id}`} style={{ color: 'var(--accent-color)', textDecoration: 'none', fontWeight: 500 }}>
                      {p.name}
                    </Link>
                  </td>
                  <td style={tdStyle}>{p.phone && <span><Phone size={12} style={{ verticalAlign: 'middle' }} /> {p.phone}</span>}</td>
                  <td style={tdStyle}>{p.email && <span><Mail size={12} style={{ verticalAlign: 'middle' }} /> {p.email}</span>}</td>
                  <td style={tdStyle}>{p.gender || '—'}</td>
                  <td style={tdStyle}>{p.source || '—'}</td>
                  <td style={tdStyle}>{new Date(p.createdAt).toLocaleDateString('en-IN')}</td>
                </tr>
              ))}
              {patients.length === 0 && (
                <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>No patients match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const thStyle = { textAlign: 'left', padding: '0.75rem 1rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' };
const tdStyle = { padding: '0.75rem 1rem', fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
// #229: name cell ellipses long names so they don't blow out the table layout.
const nameTdStyle = { ...tdStyle, maxWidth: 220 };
const inputStyle = { padding: '0.55rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' };
