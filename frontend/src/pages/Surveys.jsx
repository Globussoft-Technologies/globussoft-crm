import React, { useState, useEffect } from 'react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { ClipboardList, Send, Plus, BarChart3, X, ArrowLeft, MessageSquare, Users, Download, ListChecks, Trash2, GripVertical } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';

const TYPE_COLORS = {
  NPS:     { bg: 'rgba(59,130,246,0.12)',  color: '#3b82f6' },
  CSAT:    { bg: 'rgba(16,185,129,0.12)',  color: '#10b981' },
  CUSTOM:  { bg: 'rgba(139,92,246,0.12)',  color: '#8b5cf6' },
  PRODUCT: { bg: 'rgba(234,179,8,0.12)',   color: '#eab308' },
  SERVICE: { bg: 'rgba(244,114,182,0.12)', color: '#f472b6' },
  DOCTOR:  { bg: 'rgba(20,184,166,0.12)',  color: '#14b8a6' },
};

// Multi-question types own a child SurveyQuestion list. NPS / CSAT are
// the legacy single-question types and route through the existing
// /respond/:token flow + SurveyResponse table.
const MULTI_QUESTION_TYPES = new Set(['PRODUCT', 'SERVICE', 'DOCTOR', 'CUSTOM']);

// Canonical UI labels for the 6 question field types — keep these in
// sync with the VALID_FIELD_TYPES list in backend/routes/surveys.js.
const FIELD_TYPES = [
  { value: 'TEXT',     label: 'Text — short answer' },
  { value: 'TEXTAREA', label: 'Textarea — long answer' },
  { value: 'SELECT',   label: 'Select — dropdown choice' },
  { value: 'RATE',     label: 'Rate — numeric scale' },
  { value: 'RADIO',    label: 'Radio — single choice' },
  { value: 'YES_NO',   label: 'Yes / No — boolean' },
];

// Maps Survey.type → which entity list to fetch + how to filter it
// to the admin-meaningful subset. Used by RelatedEntityPicker below.
//   endpoint       tenant-scoped GET that returns a list of rows
//   nameField      which row field carries the display label
//   secondaryField optional — surfaced as a subtitle on the option
//   filter         optional client-side filter for rows that came back
const RELATED_ENTITY_LOOKUP = {
  PRODUCT: {
    endpoint: '/api/wellness/products',
    nameField: 'name',
    secondaryField: 'sku',
    label: 'product',
  },
  SERVICE: {
    endpoint: '/api/wellness/services',
    nameField: 'name',
    secondaryField: 'category',
    label: 'service',
  },
  DOCTOR: {
    endpoint: '/api/staff',
    nameField: 'name',
    secondaryField: 'email',
    label: 'doctor',
    // Staff endpoint returns every user — narrow to doctors.
    filter: (row) => row.wellnessRole === 'doctor',
  },
};

function TypeBadge({ type }) {
  const t = TYPE_COLORS[type] || TYPE_COLORS.CUSTOM;
  return (
    <span style={{
      padding: '0.2rem 0.6rem',
      borderRadius: '999px',
      fontSize: '0.7rem',
      fontWeight: 700,
      background: t.bg,
      color: t.color,
      letterSpacing: '0.04em',
    }}>{type}</span>
  );
}

function npsColor(score) {
  if (score === null || score === undefined) return 'var(--text-secondary)';
  if (score >= 50) return '#10b981';
  if (score >= 0) return '#f59e0b';
  return '#ef4444';
}

function avgColor(avg) {
  if (avg >= 7) return '#10b981';
  if (avg >= 4) return '#f59e0b';
  return '#ef4444';
}

export default function Surveys() {
  const notify = useNotify();
  const [surveys, setSurveys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  // Form state carries fields for both legacy (NPS/CSAT/CUSTOM) and
  // multi-question (PRODUCT/SERVICE/DOCTOR/CUSTOM) shapes. The Create
  // modal conditionally shows the relevant inputs based on `type`.
  const [form, setForm] = useState({
    name: '', type: 'NPS', question: '',
    title: '', relatedEntityId: '',
  });
  // Question builder modal — opened from the "Manage Questions" button on
  // a multi-question survey row. `builderSurvey` is the survey we're
  // editing; null means the modal is closed.
  const [builderSurvey, setBuilderSurvey] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState(null); // survey object
  const [stats, setStats] = useState(null);
  const [responses, setResponses] = useState([]);
  // v3.7.17 — multi-question detail view loads the SurveyAnswer rows
  // grouped by submissionId via GET /:id/answers. Null when the
  // selected survey is legacy NPS/CSAT/CUSTOM (those use `responses`
  // above).
  const [submissions, setSubmissions] = useState(null);
  const [showSendModal, setShowSendModal] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [selectedContactIds, setSelectedContactIds] = useState([]);
  const [contactSearch, setContactSearch] = useState('');
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState('');

  const loadSurveys = async () => {
    setLoading(true);
    try {
      const data = await fetchApi('/api/surveys');
      setSurveys(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Failed to load surveys', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSurveys(); }, []);

  const openSurvey = async (s) => {
    setSelected(s);
    setStats(null);
    setResponses([]);
    setSubmissions(null);
    const isMulti = MULTI_QUESTION_TYPES.has(s.type);
    try {
      if (isMulti) {
        // Multi-question surveys live in SurveyAnswer (grouped by
        // submissionId) — the NPS aggregate / responses endpoints don't
        // apply. Use GET /:id/answers for the per-submission breakdown.
        const data = await fetchApi(`/api/surveys/${s.id}/answers`);
        setSubmissions(data?.submissions || []);
        setStats({
          count: data?.submissionCount || 0,
          answerCount: data?.answerCount || 0,
        });
      } else {
        // #613: prefer the richer /aggregate (count/avg/NPS/promoter-passive-detractor
        // split + distribution); fall back to legacy /stats if older backend.
        let agg = null;
        try { agg = await fetchApi(`/api/surveys/${s.id}/aggregate`); }
        catch { agg = await fetchApi(`/api/surveys/${s.id}/stats`); }
        const rs = await fetchApi(`/api/surveys/${s.id}/responses`);
        // Normalize the legacy /stats shape (distribution is plain array of counts)
        // into the /aggregate shape so the chart renderer downstream is consistent.
        let distribution = agg?.distribution;
        if (Array.isArray(distribution) && typeof distribution[0] === 'number') {
          distribution = distribution.map((count, score) => ({ score, count }));
        }
        setStats({ ...agg, distribution });
        setResponses(Array.isArray(rs) ? rs : []);
      }
    } catch (e) {
      console.error('Failed to load survey detail', e);
    }
  };

  const exportCsv = async () => {
    if (!selected) return;
    try {
      // The CSV endpoint returns text/csv directly. fetchApi auto-bears the JWT
      // but expects JSON; bypass it for the file download.
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/surveys/${selected.id}/export.csv`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selected.name.replace(/[^a-z0-9-_]+/gi, '_')}-responses.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('CSV export failed', err);
      notify.error('Failed to export CSV');
    }
  };

  const closeSurvey = () => {
    setSelected(null);
    setStats(null);
    setResponses([]);
  };

  const createSurvey = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    const isMulti = MULTI_QUESTION_TYPES.has(form.type);
    // Legacy types still require the single-question text; multi-question
    // types collect questions in the builder after Create succeeds.
    if (!isMulti && !form.question.trim()) return;
    if (isMulti && !form.title.trim()) return;
    setSubmitting(true);
    try {
      // #381: explicitly set isActive=true on creation so the survey is
      // immediately visible to the patient-facing wellness portal preview,
      // which filters by `isActive`. Without this flag the backend default
      // applies, but some downstream consumers (portal preview) were missing
      // surveys created before the default was added.
      const body = {
        name: form.name.trim(),
        type: form.type,
        isActive: true,
      };
      if (isMulti) {
        body.title = form.title.trim();
        if (form.relatedEntityId && String(form.relatedEntityId).trim()) {
          body.relatedEntityId = parseInt(form.relatedEntityId, 10);
        }
      } else {
        body.question = form.question.trim();
      }
      const created = await fetchApi('/api/surveys', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setShowCreate(false);
      setForm({ name: '', type: 'NPS', question: '', title: '', relatedEntityId: '' });
      await loadSurveys();
      // For multi-question types, jump straight into the Question
      // Builder so the admin can wire up the questions without an extra
      // click chain.
      if (isMulti && created?.id) {
        setBuilderSurvey(created);
      }
    } catch (err) {
      console.error('Failed to create survey', err);
    } finally {
      setSubmitting(false);
    }
  };

  const deleteSurvey = async (id, e) => {
    e.stopPropagation();
    if (!await notify.confirm('Delete this survey and all its responses?')) return;
    try {
      await fetchApi(`/api/surveys/${id}`, { method: 'DELETE' });
      await loadSurveys();
    } catch (err) {
      console.error('Delete failed', err);
    }
  };

  const openSendModal = async () => {
    setShowSendModal(true);
    setSelectedContactIds([]);
    setSendMessage('');
    setContactSearch('');
    // Fetch contacts + patients in parallel. Patients are wellness-only;
    // a 403 / empty response there just means the tenant doesn't have
    // the wellness vertical enabled, so we tolerate either failure mode
    // without blocking the contact list.
    //
    // Endpoint quirks (do NOT change to bare arrays — both endpoints
    // serve other callers that depend on the existing shape):
    //   /api/contacts            → bare array, default limit 100 (cap 500)
    //   /api/wellness/patients   → { patients, total }, default limit 50 (cap 200)
    // We push both to their respective caps so the modal isn't silently
    // truncating the newest few rows for tenants with larger populations.
    // For tenants past those caps (>200 patients) the in-modal search
    // input lets the admin still find a specific row by name; a future
    // pass should wire the search to the backend `?q=` instead of
    // filtering client-side.
    const [contactsResult, patientsResult] = await Promise.allSettled([
      fetchApi('/api/contacts?limit=500'),
      fetchApi('/api/wellness/patients?limit=200'),
    ]);

    const merged = [];
    if (contactsResult.status === 'fulfilled') {
      const rows = Array.isArray(contactsResult.value) ? contactsResult.value : [];
      for (const c of rows) {
        merged.push({
          _kind: 'contact',
          id: c.id,
          name: c.name || '',
          email: c.email || '',
          subtitle: c.company || c.email || '',
        });
      }
    } else {
      console.error('Failed to load contacts', contactsResult.reason);
    }
    if (patientsResult.status === 'fulfilled') {
      // /api/wellness/patients returns { patients, total }. We also
      // tolerate the bare-array and { items } shapes in case the
      // endpoint shape ever shifts (or a test mock returns one of
      // those forms).
      const v = patientsResult.value;
      const rows = Array.isArray(v)
        ? v
        : Array.isArray(v?.patients) ? v.patients
        : Array.isArray(v?.items) ? v.items
        : [];
      for (const p of rows) {
        merged.push({
          _kind: 'patient',
          id: p.id,
          name: p.name || '',
          email: p.email || '',
          subtitle: p.phone || p.email || '',
        });
      }
    }
    // No console.error on patientsResult rejection — it's normal for
    // non-wellness tenants (404/403 on the route). Show what we have.
    setContacts(merged);
  };

  // Selection state is a list of { kind, id } pairs so two rows with
  // the same numeric id (e.g. contact #5 and patient #5) don't collide.
  // Stored under the existing selectedContactIds state name to minimize
  // churn elsewhere in the component.
  const toggleContact = (kind, id) => {
    setSelectedContactIds(prev =>
      prev.find(p => p.kind === kind && p.id === id)
        ? prev.filter(p => !(p.kind === kind && p.id === id))
        : [...prev, { kind, id }]
    );
  };

  const sendSurvey = async () => {
    if (!selected || selectedContactIds.length === 0) return;
    setSending(true);
    setSendMessage('');
    try {
      const contactIds = selectedContactIds.filter(s => s.kind === 'contact').map(s => s.id);
      const patientIds = selectedContactIds.filter(s => s.kind === 'patient').map(s => s.id);
      const body = {};
      if (contactIds.length) body.contactIds = contactIds;
      if (patientIds.length) body.patientIds = patientIds;
      const res = await fetchApi(`/api/surveys/${selected.id}/send`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // Aggregate per-recipient failure reasons so the admin sees WHY a
      // send was skipped. Previously the toast read "Sent to 0 of 1
      // recipients." with no explanation — the most common cause is the
      // backend's MAILGUN_API_KEY env var being unset (every send is a
      // log-only no-op) and there was no way to tell that from the UI.
      const attempted = res.attempted ?? selectedContactIds.length;
      const sent = res.sentCount ?? 0;
      const failed = attempted - sent;
      const reasonCounts = {};
      for (const r of (res.results || [])) {
        if (r.sent) continue;
        const reason = r.reason || 'unknown_error';
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      }
      let detail = '';
      if (failed > 0 && Object.keys(reasonCounts).length > 0) {
        const friendly = {
          no_api_key:    'SendGrid not configured on the server — set SENDGRID_API_KEY in backend/.env',
          no_email:      'recipient has no email on file',
          unknown_error: 'unknown error',
        };
        const parts = Object.entries(reasonCounts).map(
          ([k, n]) => `${n} × ${friendly[k] || k}`,
        );
        detail = ` (${failed} skipped: ${parts.join('; ')})`;
      }
      setSendMessage(`Sent to ${sent} of ${attempted} recipients.${detail}`);
      await loadSurveys();
    } catch (err) {
      console.error('Send failed', err);
      setSendMessage('Failed to send survey.');
    } finally {
      setSending(false);
    }
  };

  const filteredContacts = contacts.filter(c => {
    if (!contactSearch.trim()) return true;
    const q = contactSearch.toLowerCase();
    return (c.name || '').toLowerCase().includes(q) ||
           (c.email || '').toLowerCase().includes(q) ||
           (c.subtitle || '').toLowerCase().includes(q);
  });

  // ── Detail view ──────────────────────────────────────────────
  if (selected) {
    // Multi-question surveys (PRODUCT/SERVICE/DOCTOR/CUSTOM) get a
    // different detail layout — NPS-style "Avg score" and "Score
    // distribution" don't apply when answers are per-question text /
    // chips / ratings, not a single 0-10 score. Render the
    // submissions list instead. The Send Survey modal markup is
    // duplicated lower in this `if (selected)` block — pull a fragment
    // wrap around the MQ detail so the modal renders on top.
    if (MULTI_QUESTION_TYPES.has(selected.type)) {
      return (
        <>
          <MultiQuestionDetail
            survey={selected}
            stats={stats}
            submissions={submissions}
            onBack={closeSurvey}
            onSend={openSendModal}
            onExport={exportCsv}
          />
          {showSendModal && (
            <SendSurveyModal
              selected={selected}
              contactSearch={contactSearch}
              setContactSearch={setContactSearch}
              filteredContacts={filteredContacts}
              selectedContactIds={selectedContactIds}
              toggleContact={toggleContact}
              sending={sending}
              sendMessage={sendMessage}
              sendSurvey={sendSurvey}
              onClose={() => setShowSendModal(false)}
            />
          )}
        </>
      );
    }
    // Distribution may be either the legacy [count0..count10] array or the
    // /aggregate-shape [{score, count}, ...]. Normalize to {score, count}.
    const rawDist = stats?.distribution || [];
    const distData = rawDist.map((entry, i) => {
      if (entry && typeof entry === 'object') return { score: String(entry.score), count: entry.count };
      return { score: String(i), count: Number(entry) || 0 };
    });
    return (
      <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.4s ease-out' }}>
        <button
          onClick={closeSurvey}
          className="btn-secondary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}
        >
          <ArrowLeft size={16} /> Back to Surveys
        </button>

        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
          <div>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <ClipboardList size={26} color="var(--accent-color)" /> {selected.name}
            </h1>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              <TypeBadge type={selected.type} /> &nbsp; {selected.question}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={exportCsv} className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              <Download size={16} /> Export CSV
            </button>
            <button onClick={openSendModal} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              <Send size={16} /> Send Survey
            </button>
          </div>
        </header>

        {/* Stats summary */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.25rem', marginBottom: '1.5rem' }}>
          <div className="card" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Responses</span>
              <Users size={18} color="var(--accent-color)" />
            </div>
            <div style={{ fontSize: '2rem', fontWeight: 'bold' }}>{stats?.count ?? 0}</div>
          </div>
          <div className="card" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Avg Score</span>
              <BarChart3 size={18} color="#f59e0b" />
            </div>
            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: avgColor(stats?.avgScore || 0) }}>
              {(stats?.avgScore ?? 0).toFixed(2)}
            </div>
          </div>
          {selected.type === 'NPS' ? (
            <div className="card" style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>NPS Score</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>-100 to +100</span>
              </div>
              <div style={{ fontSize: '2rem', fontWeight: 'bold', color: npsColor(stats?.npsScore) }}>
                {stats?.npsScore ?? 0}
              </div>
            </div>
          ) : (
            <div className="card" style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Survey Type</span>
              </div>
              <div style={{ fontSize: '2rem', fontWeight: 'bold' }}>
                <TypeBadge type={selected.type} />
              </div>
            </div>
          )}
        </div>

        {/* NPS bucket breakdown — only shown for NPS surveys with responses.
            Renders the promoter/passive/detractor split that drives the NPS
            score: P 9-10, neutral 7-8, D 0-6. */}
        {selected.type === 'NPS' && (stats?.count ?? 0) > 0 && (
          <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
            <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '1rem' }}>NPS Breakdown</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
              {[
                { label: 'Promoters', count: stats?.promoters ?? 0, color: '#10b981', hint: '9–10' },
                { label: 'Passives', count: stats?.passives ?? 0, color: '#f59e0b', hint: '7–8' },
                { label: 'Detractors', count: stats?.detractors ?? 0, color: '#ef4444', hint: '0–6' },
              ].map(b => {
                const total = stats?.count || 1;
                const pct = Math.round((b.count / total) * 100);
                return (
                  <div key={b.label} style={{ padding: '0.75rem 1rem', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid var(--border-color)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{b.label}</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{b.hint}</span>
                    </div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 700, color: b.color }}>{b.count}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{pct}% of responses</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Response form preview */}
        <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <MessageSquare size={18} color="var(--accent-color)" /> Response Form Preview
          </h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>{selected.question}</p>
          {selected.type === 'CSAT' ? (
            <div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginBottom: '0.5rem' }}>
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} disabled style={{
                    width: '48px', height: '48px', borderRadius: '8px',
                    border: '1px solid var(--border-color)', background: 'var(--surface-color, rgba(255,255,255,0.04))',
                    color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 600, cursor: 'not-allowed',
                  }}>{n}</button>
                ))}
              </div>
              {/* #380: anchor labels for the CSAT 1-5 scale */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)', maxWidth: '280px', margin: '0 auto' }}>
                <span>Very Dissatisfied</span>
                <span>Very Satisfied</span>
              </div>
            </div>
          ) : selected.type === 'NPS' ? (
            <div>
              <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                  <button key={n} disabled style={{
                    width: '40px', height: '40px', borderRadius: '6px',
                    border: '1px solid var(--border-color)', background: 'var(--surface-color, rgba(255,255,255,0.04))',
                    color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 600, cursor: 'not-allowed',
                  }}>{n}</button>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                <span>Not at all likely</span>
                <span>Extremely likely</span>
              </div>
            </div>
          ) : (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>Custom survey — free-form response.</p>
          )}
        </div>

        {/* Distribution chart */}
        <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <BarChart3 size={18} color="var(--accent-color)" /> Score Distribution
          </h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={distData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="score" tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} />
              <YAxis tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)' }}
                formatter={(v) => [`${v} responses`, 'Count']}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {distData.map((entry, i) => {
                  const score = Number(entry.score);
                  const color = score >= 9 ? '#10b981' : score >= 7 ? '#f59e0b' : '#ef4444';
                  return <Cell key={i} fill={color} fillOpacity={0.85} />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Responses table */}
        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <MessageSquare size={18} color="var(--accent-color)" /> Recent Responses
          </h3>
          {responses.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>No responses yet. Send the survey to get started.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                    <th style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Contact</th>
                    <th style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Score</th>
                    <th style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Comment</th>
                    <th style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {responses.map(r => (
                    <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '0.6rem 0.5rem' }}>
                        {r.contact ? (
                          <div>
                            <div style={{ fontWeight: 500 }}>{r.contact.name}</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{r.contact.email}</div>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-secondary)' }}>Anonymous</span>
                        )}
                      </td>
                      <td style={{ padding: '0.6rem 0.5rem' }}>
                        <span style={{
                          padding: '0.2rem 0.6rem',
                          borderRadius: '999px',
                          background: r.score >= 9 ? 'rgba(16,185,129,0.12)' : r.score >= 7 ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)',
                          color: r.score >= 9 ? '#10b981' : r.score >= 7 ? '#f59e0b' : '#ef4444',
                          fontWeight: 600,
                        }}>{r.score}</span>
                      </td>
                      <td style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', maxWidth: '320px' }}>
                        {r.comment || <em style={{ opacity: 0.6 }}>—</em>}
                      </td>
                      <td style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {new Date(r.respondedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Send modal */}
        {showSendModal && (
          <div style={modalOverlay} onClick={() => !sending && setShowSendModal(false)}>
            <div className="card" style={{ ...modalCard, width: 'min(620px, 92vw)' }} onClick={e => e.stopPropagation()}>
              <div style={modalHeader}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Send size={18} /> Send "{selected.title || selected.name}"
                </h3>
                <button onClick={() => setShowSendModal(false)} disabled={sending} style={iconBtn} aria-label="Close send survey dialog"><X size={18} /></button>
              </div>
              <input
                type="text"
                value={contactSearch}
                onChange={e => setContactSearch(e.target.value)}
                placeholder="Search by name, email, or phone..."
                style={inputStyle}
              />
              <div style={{
                maxHeight: '320px',
                overflowY: 'auto',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                marginTop: '0.75rem',
              }}>
                {filteredContacts.length === 0 ? (
                  <p style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem', margin: 0 }}>No recipients found.</p>
                ) : filteredContacts.map(c => {
                  // Selection key is composite (kind + id) so a Contact and
                  // Patient with the same numeric id don't collide.
                  const checked = !!selectedContactIds.find(
                    (s) => s.kind === c._kind && s.id === c.id,
                  );
                  const badge = c._kind === 'patient'
                    ? { label: 'PATIENT', bg: 'rgba(20,184,166,0.18)', color: '#14b8a6' }
                    : { label: 'CONTACT', bg: 'rgba(59,130,246,0.18)', color: '#3b82f6' };
                  return (
                    <label
                      key={`${c._kind}-${c.id}`}
                      data-testid={`recipient-row-${c._kind}-${c.id}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem',
                        padding: '0.6rem 0.85rem',
                        cursor: 'pointer',
                        borderBottom: '1px solid var(--border-color)',
                        background: checked ? 'rgba(59,130,246,0.08)' : 'transparent',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleContact(c._kind, c.id)}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {c.name || '(no name)'}
                          </span>
                          <span style={{
                            padding: '0.1rem 0.45rem',
                            borderRadius: 999,
                            fontSize: '0.62rem',
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            background: badge.bg,
                            color: badge.color,
                            flexShrink: 0,
                          }}>
                            {badge.label}
                          </span>
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          {c.email || 'no email'} {c.subtitle ? `• ${c.subtitle}` : ''}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
              <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {selectedContactIds.length} selected
              </div>
              {sendMessage && (
                <div style={{
                  marginTop: '0.75rem',
                  padding: '0.6rem 0.9rem',
                  background: 'rgba(34,197,94,0.08)',
                  border: '1px solid rgba(34,197,94,0.2)',
                  borderRadius: '8px',
                  color: 'var(--success-color)',
                  fontSize: '0.85rem',
                }}>{sendMessage}</div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
                <button className="btn-secondary" onClick={() => setShowSendModal(false)} disabled={sending}>Close</button>
                <button
                  className="btn-primary"
                  onClick={sendSurvey}
                  disabled={sending || selectedContactIds.length === 0}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
                >
                  <Send size={16} /> {sending ? 'Sending...' : `Send to ${selectedContactIds.length}`}
                </button>
              </div>
            </div>
          </div>
        )}

        <style>{`
          @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        `}</style>
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────
  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <ClipboardList size={28} color="var(--accent-color)" /> NPS/CSAT Surveys
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Measure customer satisfaction and loyalty with email-delivered surveys.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Plus size={16} /> Create Survey
        </button>
      </header>

      {loading ? (
        <p style={{ color: 'var(--text-secondary)' }}>Loading surveys...</p>
      ) : surveys.length === 0 ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
          <ClipboardList size={48} color="var(--text-secondary)" style={{ opacity: 0.5, marginBottom: '1rem' }} />
          <h3 style={{ fontWeight: 600, marginBottom: '0.5rem' }}>No surveys yet</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Create your first NPS or CSAT survey to start collecting feedback.
          </p>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '1.25rem',
        }}>
          {surveys.map(s => (
            <div
              key={s.id}
              className="card"
              onClick={() => openSurvey(s)}
              style={{ padding: '1.5rem', cursor: 'pointer', position: 'relative', transition: 'transform 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
              onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '0.25rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.name}
                  </h3>
                  <TypeBadge type={s.type} />
                </div>
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  {MULTI_QUESTION_TYPES.has(s.type) && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setBuilderSurvey(s); }}
                      title="Manage questions"
                      aria-label={`Manage questions for ${s.name}`}
                      data-testid={`manage-questions-${s.id}`}
                      style={{ ...iconBtn, color: 'var(--text-secondary)' }}
                    >
                      <ListChecks size={16} />
                    </button>
                  )}
                  <button
                    onClick={(e) => deleteSurvey(s.id, e)}
                    title="Delete"
                    aria-label={`Delete survey ${s.name}`}
                    style={{ ...iconBtn, color: 'var(--text-secondary)' }}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem', minHeight: '2.5em' }}>
                {MULTI_QUESTION_TYPES.has(s.type)
                  ? (s.title || `${s.questionCount || 0} question${s.questionCount === 1 ? '' : 's'}`)
                  : s.question}
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Responses</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{s.responseCount || 0}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  {s.type === 'NPS' ? (
                    <>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>NPS</div>
                      <div style={{ fontSize: '1.25rem', fontWeight: 700, color: npsColor(s.npsScore) }}>
                        {s.responseCount ? (s.npsScore ?? 0) : '—'}
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Avg</div>
                      <div style={{ fontSize: '1.25rem', fontWeight: 700, color: avgColor(s.avgScore || 0) }}>
                        {s.responseCount ? (s.avgScore ?? 0).toFixed(1) : '—'}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div style={modalOverlay} onClick={() => !submitting && setShowCreate(false)}>
          <form className="card" style={{ ...modalCard, width: 'min(520px, 92vw)' }} onClick={e => e.stopPropagation()} onSubmit={createSurvey}>
            <div style={modalHeader}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Create Survey</h3>
              <button type="button" onClick={() => setShowCreate(false)} disabled={submitting} style={iconBtn} aria-label="Close create survey dialog"><X size={18} /></button>
            </div>
            <label style={labelStyle}>Name</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Q2 Customer Satisfaction"
              style={inputStyle}
            />
            <label style={labelStyle}>Type</label>
            <select
              value={form.type}
              onChange={e => setForm({ ...form, type: e.target.value })}
              style={inputStyle}
              data-testid="survey-type-select"
            >
              <optgroup label="Single-question scoring">
                <option value="NPS">NPS — Net Promoter Score (0-10)</option>
                <option value="CSAT">CSAT — Customer Satisfaction</option>
              </optgroup>
              <optgroup label="Multi-question review form">
                <option value="PRODUCT">Product review</option>
                <option value="SERVICE">Service review</option>
                <option value="DOCTOR">Doctor review</option>
                <option value="CUSTOM">Custom multi-question</option>
              </optgroup>
            </select>
            {MULTI_QUESTION_TYPES.has(form.type) ? (
              <>
                <label style={labelStyle}>Form title</label>
                <input
                  type="text"
                  required
                  value={form.title}
                  onChange={e => setForm({ ...form, title: e.target.value })}
                  placeholder="e.g. Acne Scar Treatment — Patient Feedback"
                  style={inputStyle}
                  data-testid="survey-title-input"
                />
                {form.type === 'CUSTOM' ? (
                  <p style={{
                    margin: '0.75rem 0 0',
                    fontSize: '0.78rem',
                    color: 'var(--text-secondary)',
                  }}>
                    Custom multi-question forms aren't tied to a specific
                    product / service / doctor. Skip straight to the
                    questions after Create.
                  </p>
                ) : (
                  <RelatedEntityPicker
                    surveyType={form.type}
                    value={form.relatedEntityId}
                    onChange={(id) => setForm({ ...form, relatedEntityId: id })}
                  />
                )}
                <p style={{
                  marginTop: '0.75rem',
                  fontSize: '0.78rem',
                  color: 'var(--text-secondary)',
                }}>
                  After creating, you'll be taken to the question builder to add the review questions.
                </p>
              </>
            ) : (
              <>
                <label style={labelStyle}>Question</label>
                <textarea
                  required
                  value={form.question}
                  onChange={e => setForm({ ...form, question: e.target.value })}
                  placeholder="How likely are you to recommend us to a friend or colleague?"
                  rows={3}
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                  data-testid="survey-question-textarea"
                />
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)} disabled={submitting}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={submitting} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                <Plus size={16} /> {submitting ? 'Creating...' : 'Create Survey'}
              </button>
            </div>
          </form>
        </div>
      )}

      {builderSurvey && (
        <QuestionBuilder
          survey={builderSurvey}
          onClose={() => setBuilderSurvey(null)}
          onChange={loadSurveys}
        />
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}

// ── Related-entity picker (name-driven dropdown) ──────────────────
//
// Lazy-fetches the matching entity list when a multi-question Survey
// type is selected in the Create modal, then surfaces a dropdown keyed
// by display name. The admin picks "Pilgrim Face Wash" instead of
// guessing what `42` means; we still POST the numeric id to the server.
//
// Endpoint + name-field mapping lives in RELATED_ENTITY_LOOKUP above.
// CUSTOM has no entity (no picker shown).
//
// Cache is per-tab-session (module-level Map). Re-fetches if the user
// opens a different Survey type that hits a different endpoint, but
// re-opening the same type reuses the resolved list.
const _relatedEntityCache = new Map();

export function __clearRelatedEntityCacheForTests() {
  _relatedEntityCache.clear();
}

async function loadRelatedEntities(surveyType) {
  const cfg = RELATED_ENTITY_LOOKUP[surveyType];
  if (!cfg) return [];
  if (_relatedEntityCache.has(surveyType)) return _relatedEntityCache.get(surveyType);
  const promise = (async () => {
    try {
      const rows = await fetchApi(cfg.endpoint);
      const list = Array.isArray(rows)
        ? rows
        : Array.isArray(rows?.items) ? rows.items : [];
      const filtered = cfg.filter ? list.filter(cfg.filter) : list;
      return filtered.map((r) => ({
        id: r.id,
        name: r[cfg.nameField] || `#${r.id}`,
        // Secondary field can be a scalar OR an object (e.g. Product.category
        // is { id, name }). Resolve both shapes.
        secondary:
          cfg.secondaryField && r[cfg.secondaryField] != null
            ? (typeof r[cfg.secondaryField] === 'object'
                ? r[cfg.secondaryField].name
                : r[cfg.secondaryField])
            : undefined,
      }));
    } catch (err) {
      // Drop the cached promise so the next render re-tries.
      _relatedEntityCache.delete(surveyType);
      throw err;
    }
  })();
  _relatedEntityCache.set(surveyType, promise);
  return promise;
}

function RelatedEntityPicker({ surveyType, value, onChange }) {
  const cfg = RELATED_ENTITY_LOOKUP[surveyType];
  const [options, setOptions] = useState(null); // null = loading, [] = empty list, [...] = loaded
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!cfg) {
      setOptions([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setOptions(null);
    setError(null);
    loadRelatedEntities(surveyType)
      .then((rows) => { if (!cancelled) setOptions(rows); })
      .catch((err) => { if (!cancelled) { setError(err); setOptions([]); } });
    return () => { cancelled = true; };
  }, [surveyType, cfg]);

  if (!cfg) return null;

  return (
    <>
      <label style={labelStyle}>
        Related {cfg.label}
        <span style={{ marginLeft: '0.5rem', textTransform: 'none', letterSpacing: 0, color: 'var(--text-muted, #6b7280)' }}>
          (optional)
        </span>
      </label>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? parseInt(e.target.value, 10) : '')}
        style={inputStyle}
        disabled={options === null}
        data-testid="survey-related-entity-select"
      >
        <option value="">
          {options === null
            ? `Loading ${cfg.label}s…`
            : `— Select a ${cfg.label} —`}
        </option>
        {(options || []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
            {o.secondary ? ` — ${o.secondary}` : ''}
          </option>
        ))}
      </select>
      {options !== null && options.length === 0 && !error && (
        <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
          No {cfg.label}s found in this tenant. {surveyType === 'DOCTOR'
            ? 'Add a user with wellnessRole=doctor first.'
            : `Add a ${cfg.label} from the ${cfg.label}s page first.`}
        </p>
      )}
      {error && (
        <p style={{ fontSize: '0.78rem', color: 'var(--danger-color, #ef4444)', marginTop: '0.4rem' }}>
          Couldn't load {cfg.label}s. {surveyType === 'PRODUCT' || surveyType === 'DOCTOR'
            ? 'You need ADMIN or MANAGER access.'
            : 'Try again in a moment.'}
        </p>
      )}
    </>
  );
}

// ── Send Survey modal (reusable across detail flavors) ──────────────
//
// Extracted from the inline JSX in the legacy detail block so the
// multi-question detail view (which is rendered via an early-return
// branch) can also surface the modal. Pure presentational — all state
// + handlers come in as props.
function SendSurveyModal({
  selected,
  contactSearch,
  setContactSearch,
  filteredContacts,
  selectedContactIds,
  toggleContact,
  sending,
  sendMessage,
  sendSurvey,
  onClose,
}) {
  return (
    <div style={modalOverlay} onClick={() => !sending && onClose()}>
      <div className="card" style={{ ...modalCard, width: 'min(620px, 92vw)' }} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeader}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Send size={18} /> Send "{selected.title || selected.name}"
          </h3>
          <button onClick={onClose} disabled={sending} style={iconBtn} aria-label="Close send survey dialog">
            <X size={18} />
          </button>
        </div>
        <input
          type="text"
          value={contactSearch}
          onChange={(e) => setContactSearch(e.target.value)}
          placeholder="Search by name, email, or phone..."
          style={inputStyle}
        />
        <div
          style={{
            maxHeight: '320px',
            overflowY: 'auto',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            marginTop: '0.75rem',
          }}
        >
          {filteredContacts.length === 0 ? (
            <p style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem', margin: 0 }}>
              No recipients found.
            </p>
          ) : (
            filteredContacts.map((c) => {
              const checked = !!selectedContactIds.find(
                (s) => s.kind === c._kind && s.id === c.id,
              );
              const badge =
                c._kind === 'patient'
                  ? { label: 'PATIENT', bg: 'rgba(20,184,166,0.18)', color: '#14b8a6' }
                  : { label: 'CONTACT', bg: 'rgba(59,130,246,0.18)', color: '#3b82f6' };
              return (
                <label
                  key={`${c._kind}-${c.id}`}
                  data-testid={`recipient-row-${c._kind}-${c.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '0.6rem 0.85rem',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--border-color)',
                    background: checked ? 'rgba(59,130,246,0.08)' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleContact(c._kind, c.id)}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.name || '(no name)'}
                      </span>
                      <span
                        style={{
                          padding: '0.1rem 0.45rem',
                          borderRadius: 999,
                          fontSize: '0.62rem',
                          fontWeight: 700,
                          letterSpacing: '0.04em',
                          background: badge.bg,
                          color: badge.color,
                          flexShrink: 0,
                        }}
                      >
                        {badge.label}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {c.email || 'no email'} {c.subtitle ? `• ${c.subtitle}` : ''}
                    </div>
                  </div>
                </label>
              );
            })
          )}
        </div>
        <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {selectedContactIds.length} selected
        </div>
        {sendMessage && (
          <div
            style={{
              marginTop: '0.75rem',
              padding: '0.6rem 0.9rem',
              background: 'rgba(34,197,94,0.08)',
              border: '1px solid rgba(34,197,94,0.2)',
              borderRadius: '8px',
              color: 'var(--success-color)',
              fontSize: '0.85rem',
            }}
          >
            {sendMessage}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
          <button className="btn-secondary" onClick={onClose} disabled={sending}>
            Close
          </button>
          <button
            className="btn-primary"
            onClick={sendSurvey}
            disabled={sending || selectedContactIds.length === 0}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
          >
            <Send size={16} /> {sending ? 'Sending...' : `Send to ${selectedContactIds.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Multi-question detail view ────────────────────────────────────
//
// Replaces the NPS-style detail page (Avg score / Score distribution /
// NPS bucket split) for surveys whose answers live in SurveyAnswer
// rather than SurveyResponse. Shows three tiles (submissions count,
// total answers, type badge) and one stacked card per submission with
// every answered question + the respondent's answer inlined.
function MultiQuestionDetail({ survey, stats, submissions, onBack, onSend, onExport }) {
  const loading = submissions === null;
  const count = stats?.count || 0;
  const answerCount = stats?.answerCount || 0;
  // Clicking a submission card opens the detail modal. State lives
  // inside the detail view so the modal closes when the admin
  // navigates back to the survey list (and stays scoped per-survey).
  const [openSubmission, setOpenSubmission] = useState(null);
  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.4s ease-out' }}>
      <button
        onClick={onBack}
        className="btn-secondary"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}
      >
        <ArrowLeft size={16} /> Back to Surveys
      </button>

      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <ClipboardList size={26} color="var(--accent-color)" />
            {survey.title || survey.name}
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            <TypeBadge type={survey.type} />
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={onExport} className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <Download size={16} /> Export CSV
          </button>
          <button onClick={onSend} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <Send size={16} /> Send Survey
          </button>
        </div>
      </header>

      {/* Multi-question summary tiles. NPS-specific tiles (Avg / NPS /
          Score Distribution) are intentionally absent — those metrics
          don't apply to text / chip / yes-no answers. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.25rem', marginBottom: '1.5rem' }}>
        <div className="card" style={{ padding: '1.5rem' }} data-testid="mq-submissions-tile">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Submissions</span>
            <Users size={18} color="var(--accent-color)" />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 'bold' }}>{count}</div>
        </div>
        <div className="card" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Total answers</span>
            <MessageSquare size={18} color="#f59e0b" />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 'bold' }}>{answerCount}</div>
        </div>
        <div className="card" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Survey Type</span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 'bold' }}>
            <TypeBadge type={survey.type} />
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: '1.5rem' }}>
        <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <MessageSquare size={18} color="var(--accent-color)" /> Submissions
        </h3>
        {loading && (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Loading submissions…</p>
        )}
        {!loading && submissions.length === 0 && (
          <p data-testid="mq-no-submissions" style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            No submissions yet. Send the survey to get started.
          </p>
        )}
        {!loading && submissions.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }} data-testid="mq-submissions-list">
            {submissions.map((s, i) => {
              const r = s.recipient;
              const recipientLabel = r
                ? `${r.name || '(no name)'} · ${r.kind === 'patient' ? 'Patient' : 'Contact'}`
                : 'Anonymous respondent';
              return (
                <button
                  type="button"
                  key={s.submissionId || `legacy-${i}`}
                  data-testid={`mq-submission-${i}`}
                  onClick={() => setOpenSubmission({ submission: s, index: i })}
                  style={{
                    textAlign: 'left',
                    width: '100%',
                    padding: '1rem 1.1rem',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 8,
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    transition: 'background 0.12s, transform 0.12s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.02)'; }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Submission #{submissions.length - i}
                      {s.submissionId == null && (
                        <span style={{ marginLeft: '0.4rem', color: 'var(--text-muted, #6b7280)', textTransform: 'none' }}>
                          (legacy)
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {s.submittedAt ? new Date(s.submittedAt).toLocaleString() : ''}
                    </span>
                  </div>
                  <div style={{
                    fontSize: '0.92rem',
                    fontWeight: 500,
                    marginBottom: '0.55rem',
                    color: r ? 'var(--text-primary)' : 'var(--text-muted, #6b7280)',
                  }}>
                    {recipientLabel}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {s.answers.length} {s.answers.length === 1 ? 'answer' : 'answers'} — click to view details
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {openSubmission && (
        <SubmissionDetailModal
          submission={openSubmission.submission}
          index={openSubmission.index}
          submissionsCount={submissions ? submissions.length : 0}
          onClose={() => setOpenSubmission(null)}
        />
      )}
    </div>
  );
}

// ── Submission detail modal ───────────────────────────────────────
//
// Opens when an admin clicks a submission card in MultiQuestionDetail.
// Shows the respondent's recipient info (Contact or Patient — name,
// email, phone, company) followed by the full question/answer rundown.
// Anonymous submissions (legacy or staff-recorded) skip the recipient
// card and show only the answers.
function SubmissionDetailModal({ submission, index, submissionsCount, onClose }) {
  const r = submission.recipient;
  const badge =
    r?.kind === 'patient'
      ? { label: 'PATIENT', bg: 'rgba(20,184,166,0.18)', color: '#14b8a6' }
      : r?.kind === 'contact'
        ? { label: 'CONTACT', bg: 'rgba(59,130,246,0.18)', color: '#3b82f6' }
        : null;
  return (
    <div style={modalOverlay} onClick={onClose} data-testid="mq-submission-detail-modal">
      <div className="card" style={{ ...modalCard, width: 'min(640px, 95vw)' }} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeader}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>
            Submission #{submissionsCount - index}
            {submission.submissionId == null && (
              <span style={{ marginLeft: '0.5rem', color: 'var(--text-muted, #6b7280)', fontSize: '0.78rem', fontWeight: 400 }}>
                (legacy)
              </span>
            )}
          </h3>
          <button onClick={onClose} style={iconBtn} aria-label="Close submission detail"><X size={18} /></button>
        </div>

        {/* Submitted-at line */}
        <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          Submitted {submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : '—'}
        </p>

        {/* Recipient card — name, badge, contact methods. Hidden when
            there's no recipient (legacy rows, staff-recorded via
            /:id/submit). */}
        {r ? (
          <div
            data-testid="mq-submission-recipient-card"
            style={{
              padding: '0.85rem 1rem',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid var(--border-color)',
              borderRadius: 8,
              marginBottom: '1.1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.45rem' }}>
              <strong style={{ fontSize: '1rem' }}>{r.name || '(no name)'}</strong>
              {badge && (
                <span style={{
                  padding: '0.1rem 0.5rem',
                  borderRadius: 999,
                  fontSize: '0.62rem',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  background: badge.bg,
                  color: badge.color,
                }}>
                  {badge.label}
                </span>
              )}
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(80px, max-content) 1fr',
              columnGap: '0.85rem',
              rowGap: '0.25rem',
              fontSize: '0.85rem',
            }}>
              {r.email && (
                <>
                  <div style={{ color: 'var(--text-secondary)' }}>Email</div>
                  <div data-testid="recipient-email">{r.email}</div>
                </>
              )}
              {r.phone && (
                <>
                  <div style={{ color: 'var(--text-secondary)' }}>Phone</div>
                  <div data-testid="recipient-phone">{r.phone}</div>
                </>
              )}
              {r.company && (
                <>
                  <div style={{ color: 'var(--text-secondary)' }}>Company</div>
                  <div>{r.company}</div>
                </>
              )}
            </div>
          </div>
        ) : (
          <p
            data-testid="mq-submission-anonymous"
            style={{
              padding: '0.7rem 0.9rem',
              fontSize: '0.82rem',
              color: 'var(--text-muted, #6b7280)',
              fontStyle: 'italic',
              marginBottom: '1.1rem',
              border: '1px dashed var(--border-color)',
              borderRadius: 8,
            }}
          >
            No recipient information stored for this submission.
          </p>
        )}

        {/* Answers grid — question on the left, answer on the right.
            Skipped answers (null / empty) render as a muted placeholder
            so the layout stays consistent across all questions. */}
        <h4 style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.6rem' }}>
          Answers
        </h4>
        <div
          data-testid="mq-submission-answers"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(180px, max-content) 1fr',
            columnGap: '1rem',
            rowGap: '0.55rem',
          }}
        >
          {submission.answers.map((a) => (
            <React.Fragment key={a.questionId}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>{a.question}</div>
              <div style={{ fontSize: '0.92rem', color: 'var(--text-primary)' }}>
                {a.answer == null || a.answer === '' ? (
                  <span style={{ color: 'var(--text-muted, #6b7280)' }}>(skipped)</span>
                ) : (
                  a.answer
                )}
              </div>
            </React.Fragment>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Question Builder ──────────────────────────────────────────────
//
// Modal-scoped editor for a Survey's child SurveyQuestion rows. Loads
// existing questions on mount via GET /:id/questions, lets the admin
// add / edit / delete one question at a time, and persists each via
// the matching REST endpoint. Field-type-specific inputs (options for
// SELECT/RADIO, min/max for RATE, read-only chips for YES_NO, nothing
// for TEXT/TEXTAREA) match the validation rules on the server.
function QuestionBuilder({ survey, onClose, onChange }) {
  const notify = useNotify();
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // { id?, question, fieldType, options, minRating, maxRating, order, isRequired, isActive }
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const rows = await fetchApi(`/api/surveys/${survey.id}/questions`);
      setQuestions(Array.isArray(rows) ? rows : []);
    } catch (err) {
      console.error('Failed to load questions', err);
      setQuestions([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [survey.id]);

  const startAdd = () => {
    setFormError('');
    setEditing({
      question: '',
      fieldType: 'TEXT',
      options: [],
      minRating: 1,
      maxRating: 5,
      order: questions.length,
      isRequired: true,
      isActive: true,
    });
  };

  const startEdit = (q) => {
    setFormError('');
    setEditing({
      id: q.id,
      question: q.question,
      fieldType: q.fieldType,
      options: Array.isArray(q.options) ? q.options : [],
      minRating: q.minRating ?? 1,
      maxRating: q.maxRating ?? 5,
      order: q.order,
      isRequired: q.isRequired,
      isActive: q.isActive,
    });
  };

  // Client-side preflight that mirrors the server's validateQuestionBody
  // so the user gets immediate feedback before we round-trip. Returns
  // null on success or a human-readable error string.
  const validate = (e) => {
    if (!e.question.trim()) return 'Question text is required.';
    if (!FIELD_TYPES.some(f => f.value === e.fieldType)) return 'Pick a valid field type.';
    if (e.fieldType === 'SELECT' || e.fieldType === 'RADIO') {
      const trimmed = (e.options || []).map(o => String(o).trim());
      if (trimmed.length === 0 || trimmed.every(o => !o)) return 'Add at least one option.';
      if (trimmed.some(o => !o)) return 'Options cannot be empty.';
      const lc = trimmed.map(o => o.toLowerCase());
      if (new Set(lc).size !== lc.length) return 'Options must be unique.';
    }
    if (e.fieldType === 'RATE') {
      if (!Number.isInteger(e.minRating) || e.minRating < 0) return 'Min rating must be a non-negative integer.';
      if (!Number.isInteger(e.maxRating) || e.maxRating > 100) return 'Max rating must be ≤ 100.';
      if (e.maxRating <= e.minRating) return 'Max rating must be greater than min rating.';
    }
    return null;
  };

  const saveEditing = async () => {
    const err = validate(editing);
    if (err) { setFormError(err); return; }
    setFormError('');
    setSaving(true);
    try {
      const body = {
        question: editing.question.trim(),
        fieldType: editing.fieldType,
        order: editing.order,
        isRequired: editing.isRequired,
        isActive: editing.isActive,
      };
      if (editing.fieldType === 'SELECT' || editing.fieldType === 'RADIO') {
        body.options = editing.options.map(o => o.trim()).filter(o => o);
      }
      if (editing.fieldType === 'RATE') {
        body.minRating = editing.minRating;
        body.maxRating = editing.maxRating;
      }
      if (editing.id) {
        await fetchApi(`/api/surveys/questions/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await fetchApi(`/api/surveys/${survey.id}/questions`, { method: 'POST', body: JSON.stringify(body) });
      }
      setEditing(null);
      await load();
      if (onChange) onChange();
    } catch (err) {
      console.error('Save question failed', err);
      setFormError(err?.data?.errors?.[0]?.code || 'Failed to save question.');
    } finally {
      setSaving(false);
    }
  };

  const removeQuestion = async (q) => {
    if (!await notify.confirm(`Delete this question? "${q.question.slice(0, 60)}"`)) return;
    try {
      await fetchApi(`/api/surveys/questions/${q.id}`, { method: 'DELETE' });
      await load();
      if (onChange) onChange();
    } catch (err) {
      console.error('Delete question failed', err);
    }
  };

  // Options editor: one inline row per option, with delete + add.
  const updateOption = (i, val) => {
    const next = [...(editing.options || [])];
    next[i] = val;
    setEditing({ ...editing, options: next });
  };
  const addOption = () => setEditing({ ...editing, options: [...(editing.options || []), ''] });
  const removeOption = (i) => {
    const next = (editing.options || []).filter((_, idx) => idx !== i);
    setEditing({ ...editing, options: next });
  };

  return (
    <div style={modalOverlay} onClick={onClose} data-testid="question-builder-modal">
      <div className="card" style={{ ...modalCard, width: 'min(720px, 95vw)' }} onClick={e => e.stopPropagation()}>
        <div style={modalHeader}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>
            Question Builder — {survey.title || survey.name}
          </h3>
          <button type="button" onClick={onClose} style={iconBtn} aria-label="Close question builder"><X size={18} /></button>
        </div>

        {loading ? (
          <p style={{ color: 'var(--text-secondary)' }}>Loading questions…</p>
        ) : (
          <>
            {questions.length === 0 && !editing && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                No questions yet. Click <strong>Add question</strong> to create the first one.
              </p>
            )}

            {questions.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
                {questions.map((q) => (
                  <div
                    key={q.id}
                    data-testid={`question-row-${q.id}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.75rem',
                      padding: '0.75rem 1rem',
                      background: 'var(--surface-color, rgba(255,255,255,0.04))',
                      border: '1px solid var(--border-color)',
                      borderRadius: 8,
                    }}
                  >
                    <GripVertical size={14} color="var(--text-secondary)" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.9rem', fontWeight: 500 }}>{q.question}</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                        {q.fieldType}
                        {q.fieldType === 'RATE' && ` · ${q.minRating}–${q.maxRating}`}
                        {(q.fieldType === 'SELECT' || q.fieldType === 'RADIO') && ` · ${(q.options || []).length} options`}
                        {q.isRequired && ' · required'}
                        {!q.isActive && ' · inactive'}
                      </div>
                    </div>
                    <button onClick={() => startEdit(q)} className="btn-secondary" style={{ fontSize: '0.78rem', padding: '0.35rem 0.7rem' }}>Edit</button>
                    <button onClick={() => removeQuestion(q)} title="Delete question" aria-label={`Delete question ${q.id}`} style={{ ...iconBtn, color: 'var(--danger-color, #ef4444)' }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!editing && (
              <button
                type="button"
                className="btn-primary"
                onClick={startAdd}
                data-testid="add-question-btn"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
              >
                <Plus size={14} /> Add question
              </button>
            )}

            {editing && (
              <div style={{ marginTop: '0.5rem', padding: '1rem', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                <label style={labelStyle}>Question text</label>
                <input
                  type="text"
                  value={editing.question}
                  onChange={e => setEditing({ ...editing, question: e.target.value })}
                  placeholder="e.g. How satisfied are you with the treatment?"
                  style={inputStyle}
                  data-testid="question-text-input"
                />

                <label style={labelStyle}>Field type</label>
                <select
                  value={editing.fieldType}
                  onChange={e => setEditing({ ...editing, fieldType: e.target.value })}
                  style={inputStyle}
                  data-testid="question-fieldtype-select"
                >
                  {FIELD_TYPES.map(ft => <option key={ft.value} value={ft.value}>{ft.label}</option>)}
                </select>

                {(editing.fieldType === 'SELECT' || editing.fieldType === 'RADIO') && (
                  <div data-testid="options-section">
                    <label style={labelStyle}>Options</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      {(editing.options || []).map((opt, i) => (
                        <div key={i} style={{ display: 'flex', gap: '0.4rem' }}>
                          <input
                            type="text"
                            value={opt}
                            onChange={e => updateOption(i, e.target.value)}
                            placeholder={`Option ${i + 1}`}
                            style={{ ...inputStyle, marginTop: 0 }}
                            data-testid={`option-input-${i}`}
                          />
                          <button
                            type="button"
                            onClick={() => removeOption(i)}
                            aria-label={`Remove option ${i + 1}`}
                            style={{ ...iconBtn, color: 'var(--danger-color, #ef4444)' }}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={addOption}
                      data-testid="add-option-btn"
                      style={{ marginTop: '0.5rem', fontSize: '0.78rem', padding: '0.35rem 0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                    >
                      <Plus size={12} /> Add option
                    </button>
                  </div>
                )}

                {editing.fieldType === 'RATE' && (
                  <div data-testid="rating-section" style={{ display: 'flex', gap: '0.75rem' }}>
                    <div style={{ flex: 1 }}>
                      <label style={labelStyle}>Min rating</label>
                      <input
                        type="number"
                        value={editing.minRating}
                        onChange={e => setEditing({ ...editing, minRating: parseInt(e.target.value, 10) })}
                        style={inputStyle}
                        data-testid="min-rating-input"
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={labelStyle}>Max rating</label>
                      <input
                        type="number"
                        value={editing.maxRating}
                        onChange={e => setEditing({ ...editing, maxRating: parseInt(e.target.value, 10) })}
                        style={inputStyle}
                        data-testid="max-rating-input"
                      />
                    </div>
                  </div>
                )}

                {editing.fieldType === 'YES_NO' && (
                  <div data-testid="yesno-section" style={{ marginTop: '0.75rem' }}>
                    <label style={labelStyle}>Options (auto-set)</label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      {['True', 'False'].map(o => (
                        <span key={o} style={{
                          padding: '0.3rem 0.7rem',
                          borderRadius: 999,
                          background: 'var(--input-bg)',
                          border: '1px solid var(--border-color)',
                          fontSize: '0.8rem',
                        }}>{o}</span>
                      ))}
                    </div>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
                      Yes/No options are fixed and cannot be edited.
                    </p>
                  </div>
                )}

                <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={editing.isRequired}
                      onChange={e => setEditing({ ...editing, isRequired: e.target.checked })}
                      data-testid="is-required-checkbox"
                    />
                    Required
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={editing.isActive}
                      onChange={e => setEditing({ ...editing, isActive: e.target.checked })}
                      data-testid="is-active-checkbox"
                    />
                    Active
                  </label>
                  <div style={{ flex: 1 }} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}>
                    Order
                    <input
                      type="number"
                      value={editing.order}
                      onChange={e => setEditing({ ...editing, order: parseInt(e.target.value, 10) || 0 })}
                      style={{ ...inputStyle, marginTop: 0, width: 80 }}
                      data-testid="question-order-input"
                    />
                  </label>
                </div>

                {formError && (
                  <p data-testid="question-form-error" style={{ color: 'var(--danger-color, #ef4444)', fontSize: '0.82rem', marginTop: '0.75rem' }}>
                    {formError}
                  </p>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.75rem' }}>
                  <button type="button" className="btn-secondary" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={saveEditing}
                    disabled={saving}
                    data-testid="save-question-btn"
                  >
                    {saving ? 'Saving…' : (editing.id ? 'Save changes' : 'Add question')}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const modalOverlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  backdropFilter: 'blur(4px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: '1rem',
};
const modalCard = {
  padding: '1.5rem',
  maxHeight: '90vh',
  overflowY: 'auto',
};
const modalHeader = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '1rem',
};
const labelStyle = {
  display: 'block',
  fontSize: '0.8rem',
  color: 'var(--text-secondary)',
  marginTop: '0.75rem',
  marginBottom: '0.35rem',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
const inputStyle = {
  width: '100%',
  padding: '0.6rem 0.8rem',
  background: 'var(--surface-color, rgba(255,255,255,0.04))',
  border: '1px solid var(--border-color)',
  borderRadius: '8px',
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  outline: 'none',
  boxSizing: 'border-box',
};
const iconBtn = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  padding: '0.25rem',
  borderRadius: '4px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};
