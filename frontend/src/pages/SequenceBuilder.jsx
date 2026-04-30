/**
 * SequenceBuilder — explicit step-list editor (#9 rebuild).
 *
 * Lives at /sequences/:id/builder. Coexists with the legacy ReactFlow
 * canvas at /sequences (Sequences.jsx) — no migration required, both
 * paths are honoured by the engine.
 *
 * Each step is one of: email (links to an EmailTemplate), sms (free body),
 * wait (delayMinutes), condition (JSON clause-list, evaluated by the same
 * eventBus.evaluateCondition() the workflow engine uses).
 *
 * Functional > pretty: drag-handle visible but reordering is a v2 concern.
 */
import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Mail, MessageSquare, Clock, GitBranch, Plus, Trash2, ArrowLeft, Save } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const KIND_META = {
  email: { icon: Mail, color: '#3b82f6', label: 'Email' },
  sms: { icon: MessageSquare, color: '#10b981', label: 'SMS' },
  wait: { icon: Clock, color: '#f59e0b', label: 'Wait' },
  condition: { icon: GitBranch, color: '#8b5cf6', label: 'Condition' },
};

export default function SequenceBuilder() {
  const { id } = useParams();
  const notify = useNotify();
  const [sequence, setSequence] = useState(null);
  const [steps, setSteps] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [editing, setEditing] = useState(null); // currently-selected step row
  const [loading, setLoading] = useState(true);

  const sequenceId = parseInt(id, 10);

  const reload = async () => {
    setLoading(true);
    try {
      // #397: pass { silent: true } so a 404 (e.g. fresh sequence with no
      // steps yet, or non-admin viewer) doesn't surface a "Not found." toast
      // every time someone opens the builder. The .catch swallowing that
      // existed before only suppressed the throw — the global toast still
      // fired from inside fetchApi. silent stops the toast at the source.
      const [allSeq, stepsRes, tplRes] = await Promise.all([
        fetchApi('/api/sequences', { silent: true }).catch(() => []),
        fetchApi(`/api/sequences/${sequenceId}/steps`, { silent: true }).catch(() => []),
        fetchApi('/api/email-templates', { silent: true }).catch(() => []),
      ]);
      const seq = (Array.isArray(allSeq) ? allSeq : []).find(s => s.id === sequenceId);
      setSequence(seq || null);
      setSteps(Array.isArray(stepsRes) ? stepsRes : []);
      setTemplates(Array.isArray(tplRes) ? tplRes : (tplRes?.templates || []));
    } catch (err) {
      notify({ type: 'error', message: 'Failed to load sequence' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, [sequenceId]);

  const addStep = async (kind) => {
    try {
      const body = { kind, pauseOnReply: kind === 'email' || kind === 'sms' };
      if (kind === 'wait') body.delayMinutes = 60;
      if (kind === 'condition') body.conditionJson = '[{"field":"contact.status","op":"eq","value":"Lead"}]';
      const created = await fetchApi(`/api/sequences/${sequenceId}/steps`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      notify({ type: 'success', message: `Added ${KIND_META[kind].label} step` });
      await reload();
      setEditing(created);
    } catch (err) {
      notify({ type: 'error', message: `Failed to add step: ${err.message}` });
    }
  };

  const saveStep = async (patch) => {
    if (!editing) return;
    try {
      const updated = await fetchApi(`/api/sequences/steps/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      notify({ type: 'success', message: 'Step saved' });
      setEditing(updated);
      await reload();
    } catch (err) {
      notify({ type: 'error', message: `Save failed: ${err.message}` });
    }
  };

  const deleteStep = async (step) => {
    if (!confirm(`Delete step #${step.position} (${step.kind})?`)) return;
    try {
      await fetchApi(`/api/sequences/steps/${step.id}`, { method: 'DELETE' });
      if (editing?.id === step.id) setEditing(null);
      await reload();
    } catch (err) {
      notify({ type: 'error', message: `Delete failed: ${err.message}` });
    }
  };

  const toggleActive = async () => {
    if (!sequence) return;
    try {
      await fetchApi(`/api/sequences/${sequence.id}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !sequence.isActive }),
      });
      await reload();
    } catch (err) {
      notify({ type: 'error', message: `Toggle failed: ${err.message}` });
    }
  };

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!sequence) return (
    <div style={{ padding: 24 }}>
      <Link to="/sequences"><ArrowLeft size={16} /> Back</Link>
      <h2>Sequence not found</h2>
    </div>
  );

  return (
    <div style={{ padding: 24, color: 'var(--text-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Link to="/sequences" style={{ color: 'var(--text-secondary)' }}>
          <ArrowLeft size={16} />
        </Link>
        <h2 style={{ margin: 0, flex: 1 }}>{sequence.name}</h2>
        <button onClick={toggleActive} style={{
          background: sequence.isActive ? '#10b981' : '#6b7280',
          color: 'white', border: 'none', borderRadius: 6, padding: '6px 14px',
        }}>
          {sequence.isActive ? 'Active' : 'Inactive'}
        </button>
      </div>

      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
        Step-list builder. Replaces the synthesised drip emails with real
        EmailTemplate-bound steps. Engine pauses enrollment on reply when
        <strong> Pause on reply</strong> is enabled.
      </p>

      {/* #376: lightweight timeline preview so the owner can read the
          sequence top-to-bottom before activating. Plain rows, no graph
          rerender. Skipped when there are no steps yet. */}
      {steps.length > 0 && (
        <div style={{
          marginBottom: 16, padding: 12,
          background: 'var(--bg-secondary)', borderRadius: 8,
          border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Flow preview
          </div>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
            {steps.map((s, i) => {
              const meta = KIND_META[s.kind] || { label: s.kind };
              let summary = '';
              if (s.kind === 'email') {
                const subj = s.emailTemplate?.subject || s.emailTemplate?.name || 'no template';
                summary = `Email — "${subj}"`;
              } else if (s.kind === 'sms') {
                const body = (s.smsBody || '').slice(0, 50) || 'empty body';
                summary = `SMS — "${body}"`;
              } else if (s.kind === 'wait') {
                const mins = s.delayMinutes ?? 0;
                const days = mins / 1440;
                summary = days >= 1 ? `Wait ${days % 1 === 0 ? days : days.toFixed(1)}d` : `Wait ${mins}m`;
              } else if (s.kind === 'condition') {
                summary = 'Condition branch';
              } else {
                summary = meta.label;
              }
              return (
                <li key={s.id} style={{ color: 'var(--text-primary)' }}>
                  <strong>Step {i + 1}:</strong> {summary}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
        {/* Step list */}
        <div style={{ flex: '1 1 460px', minWidth: 320 }}>
          {steps.length === 0 && (
            <div style={{
              padding: 24, border: '2px dashed var(--border)',
              borderRadius: 8, color: 'var(--text-secondary)', textAlign: 'center',
            }}>
              No steps yet. Add one to get started.
            </div>
          )}

          {steps.map((s) => {
            const meta = KIND_META[s.kind] || { icon: Mail, color: '#888', label: s.kind };
            const Icon = meta.icon;
            const isEditing = editing?.id === s.id;
            return (
              <div
                key={s.id}
                onClick={() => setEditing(s)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: 12, marginBottom: 8,
                  background: 'var(--bg-secondary)',
                  borderRadius: 8, cursor: 'pointer',
                  borderLeft: `4px solid ${meta.color}`,
                  outline: isEditing ? '2px solid var(--accent)' : 'none',
                }}
              >
                <span style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }}>
                  #{s.position}
                </span>
                <Icon size={18} style={{ color: meta.color }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{meta.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {s.kind === 'email' && (s.emailTemplate?.name || 'No template selected')}
                    {s.kind === 'sms' && (s.smsBody?.slice(0, 60) || 'Empty body')}
                    {s.kind === 'wait' && `Wait ${s.delayMinutes ?? 0} min`}
                    {s.kind === 'condition' && (s.conditionJson ? 'Conditional branch' : 'No condition set')}
                  </div>
                </div>
                {(s.kind === 'email' || s.kind === 'sms') && (
                  <span style={{ fontSize: 11, color: s.pauseOnReply ? '#10b981' : '#6b7280' }}>
                    {s.pauseOnReply ? 'pause-on-reply' : 'no-pause'}
                  </span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); deleteStep(s); }}
                  style={{ background: 'transparent', color: '#ef4444', border: 'none', cursor: 'pointer' }}
                  aria-label="Delete step"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button onClick={() => addStep('email')} style={addBtn('#3b82f6')}>
              <Plus size={14} /> Email
            </button>
            <button onClick={() => addStep('sms')} style={addBtn('#10b981')}>
              <Plus size={14} /> SMS
            </button>
            <button onClick={() => addStep('wait')} style={addBtn('#f59e0b')}>
              <Plus size={14} /> Wait
            </button>
            <button onClick={() => addStep('condition')} style={addBtn('#8b5cf6')}>
              <Plus size={14} /> Condition
            </button>
          </div>
        </div>

        {/* Side panel */}
        {editing && (
          <StepEditor
            key={editing.id}
            step={editing}
            templates={templates}
            onSave={saveStep}
            onClose={() => setEditing(null)}
          />
        )}
      </div>
    </div>
  );
}

function addBtn(color) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: color, color: 'white', border: 'none',
    borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13,
  };
}

function StepEditor({ step, templates, onSave, onClose }) {
  const [draft, setDraft] = useState({
    emailTemplateId: step.emailTemplateId ?? '',
    smsBody: step.smsBody ?? '',
    delayMinutes: step.delayMinutes ?? 0,
    conditionJson: step.conditionJson ?? '',
    pauseOnReply: step.pauseOnReply ?? true,
  });

  const submit = () => {
    const patch = {};
    if (step.kind === 'email') {
      patch.emailTemplateId = draft.emailTemplateId === '' ? null : parseInt(draft.emailTemplateId, 10);
      patch.pauseOnReply = !!draft.pauseOnReply;
    } else if (step.kind === 'sms') {
      patch.smsBody = draft.smsBody;
      patch.pauseOnReply = !!draft.pauseOnReply;
    } else if (step.kind === 'wait') {
      // #375: reject non-numeric / negative delays at submit time. The
      // <input type=number> already filters most junk, but a user can paste
      // "tomorrow" or set a negative value via devtools — guard here so the
      // engine never receives NaN.
      const raw = String(draft.delayMinutes ?? '').trim();
      if (raw === '' || !/^\d+$/.test(raw)) {
        alert('Delay must be a non-negative whole number of minutes.');
        return;
      }
      const parsed = parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        alert('Delay must be a non-negative whole number of minutes.');
        return;
      }
      patch.delayMinutes = parsed;
    } else if (step.kind === 'condition') {
      patch.conditionJson = draft.conditionJson;
    }
    onSave(patch);
  };

  return (
    <div style={{
      flex: '0 0 360px', padding: 16,
      background: 'var(--bg-secondary)', borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>Edit step #{step.position}</h3>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>×</button>
      </div>

      {step.kind === 'email' && (
        <>
          <label style={lbl}>Email template</label>
          <select
            value={draft.emailTemplateId}
            onChange={e => setDraft({ ...draft, emailTemplateId: e.target.value })}
            style={inp}
          >
            <option value="">— None (skip step) —</option>
            {templates.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <label style={{ ...lbl, marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={draft.pauseOnReply}
              onChange={e => setDraft({ ...draft, pauseOnReply: e.target.checked })}
            />
            Pause enrollment on reply
          </label>
        </>
      )}

      {step.kind === 'sms' && (
        <>
          <label style={lbl}>SMS body</label>
          <textarea
            value={draft.smsBody}
            onChange={e => setDraft({ ...draft, smsBody: e.target.value })}
            style={{ ...inp, minHeight: 100 }}
            placeholder="Hi {{contact.name}}, …"
          />
          <label style={{ ...lbl, marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={draft.pauseOnReply}
              onChange={e => setDraft({ ...draft, pauseOnReply: e.target.checked })}
            />
            Pause enrollment on reply
          </label>
        </>
      )}

      {step.kind === 'wait' && (
        <>
          <label style={lbl}>Delay (minutes)</label>
          <input
            // #375: numeric-only input. step="1" + min="0" + inputMode prevent
            // free-text like "tomorrow" / "a bit later" from being typed; the
            // submit handler re-validates as a defence-in-depth.
            type="number" min="0" step="1" inputMode="numeric" pattern="[0-9]*"
            value={draft.delayMinutes}
            onChange={e => {
              const v = e.target.value;
              // strip anything that isn't a digit so paste of "tomorrow" is
              // visually rejected immediately
              if (v === '' || /^\d+$/.test(v)) setDraft({ ...draft, delayMinutes: v });
            }}
            style={inp}
          />
          <small style={{ color: 'var(--text-secondary)' }}>1440 = 24 hours, 10080 = 7 days</small>
        </>
      )}

      {step.kind === 'condition' && (
        <>
          <label style={lbl}>Condition JSON</label>
          <textarea
            value={draft.conditionJson}
            onChange={e => setDraft({ ...draft, conditionJson: e.target.value })}
            style={{ ...inp, minHeight: 140, fontFamily: 'monospace', fontSize: 12 }}
            placeholder='[{"field":"contact.status","op":"eq","value":"Lead"}]'
          />
          <small style={{ color: 'var(--text-secondary)' }}>
            Same eq/neq/gt/gte/lt/lte/in/nin/contains/startsWith ops as the workflow engine.
          </small>
        </>
      )}

      <button onClick={submit} style={{
        marginTop: 14, width: '100%',
        display: 'inline-flex', justifyContent: 'center', alignItems: 'center', gap: 6,
        background: 'var(--accent, #3b82f6)', color: 'white',
        border: 'none', borderRadius: 6, padding: '8px 14px', cursor: 'pointer',
      }}>
        <Save size={14} /> Save
      </button>
    </div>
  );
}

const lbl = { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, marginTop: 4 };
const inp = {
  width: '100%', padding: '6px 8px',
  background: 'var(--bg-primary)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 4, fontSize: 13,
};
