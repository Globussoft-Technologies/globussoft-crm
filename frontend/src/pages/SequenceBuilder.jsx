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
 *
 * S86 (PRD_TRAVEL_MARKETING_FLYER FR-3.5 / AC-6.5) — operator-facing flyer
 * picker for SequenceStep.attachmentRefsJson. Email + SMS step types render
 * an "Attach Flyer" picker (TravelFlyerTemplate list + 5-format selector
 * mirroring FlyerTemplates.jsx) that serialises to the route's
 * attachmentRefsJson contract (JSON-encoded `[{kind:'flyer',flyerId,format}]`
 * array; null when empty so the engine short-circuits). Pre-fills from the
 * persisted step on edit; non-flyer entries (kind:'file') are preserved on
 * round-trip. Backend chain: S19 (engine consumer ✅) → S85 (route forward ✅)
 * → this slice.
 */
import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Mail, MessageSquare, Clock, GitBranch, Plus, Trash2, ArrowLeft, Save, FileImage, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const KIND_META = {
  email: { icon: Mail, color: '#3b82f6', label: 'Email' },
  sms: { icon: MessageSquare, color: '#10b981', label: 'SMS' },
  wait: { icon: Clock, color: '#f59e0b', label: 'Wait' },
  condition: { icon: GitBranch, color: '#8b5cf6', label: 'Condition' },
};

// S86 — operator-facing flyer picker (PRD_TRAVEL_MARKETING_FLYER FR-3.5 / AC-6.5).
//
// Mirrors the canonical 5-format set from FlyerTemplates.jsx (RENDER_FORMATS).
// Engine consumer + route layer expect `format` to be one of these literals;
// changing a value here would break the resolveStepAttachments() call shape on
// the cron engine and reject as INVALID_ATTACHMENT_REFS at the route layer.
const FLYER_FORMAT_OPTIONS = [
  { format: 'pdf-a4', label: 'PDF — A4' },
  { format: 'pdf-a5', label: 'PDF — A5' },
  { format: 'png-square', label: 'Square PNG' },
  { format: 'png-portrait-ig', label: 'Instagram Story' },
  { format: 'png-landscape-fb', label: 'Facebook Cover' },
];

// Parse the persisted SequenceStep.attachmentRefsJson into a local array of
// `{kind:'flyer', flyerId, format}` entries. Tolerant: a null / empty /
// malformed payload yields []. Non-flyer entries (kind:'file', etc.) are
// preserved so we don't silently drop them on round-trip.
function parseAttachmentRefs(raw) {
  if (raw == null || raw === '') return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

export default function SequenceBuilder() {
  const { id } = useParams();
  const notify = useNotify();
  const [sequence, setSequence] = useState(null);
  const [steps, setSteps] = useState([]);
  const [templates, setTemplates] = useState([]);
  // S86 — flyer templates pool for the operator's flyer-picker. Fetched once
  // on mount; silent on 404 (non-travel tenants have no flyers) so the UI
  // gracefully degrades to a "no flyers available" picker rather than toasting.
  const [flyerTemplates, setFlyerTemplates] = useState([]);
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
      // S86: parallel-fetch flyer templates so the email/sms step editor can
      // populate the flyer-picker dropdown. Endpoint returns
      // `{templates:[...], total, limit, offset}` — unwrap defensively.
      const [allSeq, stepsRes, tplRes, flyerRes] = await Promise.all([
        fetchApi('/api/sequences', { silent: true }).catch(() => []),
        fetchApi(`/api/sequences/${sequenceId}/steps`, { silent: true }).catch(() => []),
        fetchApi('/api/email-templates', { silent: true }).catch(() => []),
        fetchApi('/api/travel/flyer-templates', { silent: true }).catch(() => ({ templates: [] })),
      ]);
      const seq = (Array.isArray(allSeq) ? allSeq : []).find(s => s.id === sequenceId);
      setSequence(seq || null);
      setSteps(Array.isArray(stepsRes) ? stepsRes : []);
      setTemplates(Array.isArray(tplRes) ? tplRes : (tplRes?.templates || []));
      // Unwrap either {templates:[...]} envelope (canonical) or a bare array
      // (defensive — older proxy / mocked shapes).
      const flyers = Array.isArray(flyerRes) ? flyerRes : (flyerRes?.templates || []);
      setFlyerTemplates(flyers);
    } catch (err) {
      notify.error('Failed to load sequence');
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
      notify.success(`Added ${KIND_META[kind].label} step`);
      await reload();
      setEditing(created);
    } catch (err) {
      notify.error(`Failed to add step: ${err.message}`);
    }
  };

  const saveStep = async (patch) => {
    if (!editing) return;
    try {
      const updated = await fetchApi(`/api/sequences/steps/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      notify.success('Step saved');
      setEditing(updated);
      await reload();
    } catch (err) {
      notify.error(`Save failed: ${err.message}`);
    }
  };

  const deleteStep = async (step) => {
    if (!(await notify.confirm({
      message: `Delete step #${step.position} (${step.kind})?`,
      destructive: true,
      confirmText: 'Delete',
    }))) return;
    try {
      await fetchApi(`/api/sequences/steps/${step.id}`, { method: 'DELETE' });
      if (editing?.id === step.id) setEditing(null);
      await reload();
    } catch (err) {
      notify.error(`Delete failed: ${err.message}`);
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
      notify.error(`Toggle failed: ${err.message}`);
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
            flyerTemplates={flyerTemplates}
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

function StepEditor({ step, templates, flyerTemplates = [], onSave, onClose }) {
  const notify = useNotify();
  const [draft, setDraft] = useState({
    emailTemplateId: step.emailTemplateId ?? '',
    smsBody: step.smsBody ?? '',
    delayMinutes: step.delayMinutes ?? 0,
    conditionJson: step.conditionJson ?? '',
    pauseOnReply: step.pauseOnReply ?? true,
  });

  // S86 — flyer attachments local state. Pre-fill from the step's persisted
  // attachmentRefsJson (parseAttachmentRefs tolerates null/empty/malformed),
  // serialise back on submit. Non-flyer kinds (e.g. {kind:'file', url:'…'})
  // are preserved on round-trip so the operator UI doesn't drop them.
  const [attachments, setAttachments] = useState(() =>
    parseAttachmentRefs(step.attachmentRefsJson),
  );
  const [showFlyerPicker, setShowFlyerPicker] = useState(false);
  const [pickerFlyerId, setPickerFlyerId] = useState('');
  const [pickerFormat, setPickerFormat] = useState('pdf-a4');

  const addFlyerAttachment = () => {
    if (!pickerFlyerId) {
      notify.error('Pick a flyer template first.');
      return;
    }
    const flyerIdNum = parseInt(pickerFlyerId, 10);
    if (!Number.isFinite(flyerIdNum)) {
      notify.error('Invalid flyer template selection.');
      return;
    }
    // Duplicate-prevention: same flyer+format can't be added twice. Operators
    // who legitimately want two copies of the same flyer in different formats
    // get two entries; same flyer+format twice is a no-op.
    const dup = attachments.some(
      (a) => a.kind === 'flyer' && a.flyerId === flyerIdNum && a.format === pickerFormat,
    );
    if (dup) {
      notify.error('That flyer + format is already attached.');
      return;
    }
    setAttachments((prev) => [
      ...prev,
      { kind: 'flyer', flyerId: flyerIdNum, format: pickerFormat },
    ]);
    // Reset picker state but keep the panel open so multi-flyer adds stay quick.
    setPickerFlyerId('');
    setPickerFormat('pdf-a4');
  };

  const removeAttachment = (idx) => {
    setAttachments((prev) => prev.filter((_a, i) => i !== idx));
  };

  // Map a flyer attachment back to its template name for the row label.
  // Falls back to "Flyer #<id>" if the template was deleted or the user
  // doesn't have visibility (sub-brand narrowing).
  const flyerNameById = (id) => {
    const found = flyerTemplates.find((t) => t.id === id);
    return found?.name || `Flyer #${id}`;
  };
  const formatLabelByValue = (val) => {
    const found = FLYER_FORMAT_OPTIONS.find((f) => f.format === val);
    return found?.label || val;
  };

  const submit = () => {
    const patch = {};
    if (step.kind === 'email') {
      patch.emailTemplateId = draft.emailTemplateId === '' ? null : parseInt(draft.emailTemplateId, 10);
      patch.pauseOnReply = !!draft.pauseOnReply;
      // S86: serialise flyer attachments back into the route's attachmentRefsJson
      // contract (JSON-encoded string, null when empty so the engine short-circuits
      // resolveStepAttachments cleanly).
      patch.attachmentRefsJson = attachments.length === 0 ? null : JSON.stringify(attachments);
    } else if (step.kind === 'sms') {
      patch.smsBody = draft.smsBody;
      patch.pauseOnReply = !!draft.pauseOnReply;
      patch.attachmentRefsJson = attachments.length === 0 ? null : JSON.stringify(attachments);
    } else if (step.kind === 'wait') {
      // #375: reject non-numeric / negative delays at submit time. The
      // <input type=number> already filters most junk, but a user can paste
      // "tomorrow" or set a negative value via devtools — guard here so the
      // engine never receives NaN.
      const raw = String(draft.delayMinutes ?? '').trim();
      if (raw === '' || !/^\d+$/.test(raw)) {
        notify.error('Delay must be a non-negative whole number of minutes.');
        return;
      }
      const parsed = parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        notify.error('Delay must be a non-negative whole number of minutes.');
        return;
      }
      patch.delayMinutes = parsed;
    } else if (step.kind === 'condition') {
      patch.conditionJson = draft.conditionJson;
    }
    onSave(patch);
  };

  // S86 — flyer-picker section: renders the attachments list, the picker
  // panel (template dropdown + format selector + Add button), and a per-row
  // remove-X. Reused in the email + sms branches; not rendered for wait or
  // condition (engine's resolveStepAttachments() doesn't fire on those).
  const renderFlyerPickerSection = () => (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <FileImage size={14} style={{ color: 'var(--text-secondary)' }} />
        <span style={{ ...lbl, marginBottom: 0, marginTop: 0, flex: 1 }}>Flyer attachments</span>
        <button
          type="button"
          onClick={() => setShowFlyerPicker((s) => !s)}
          data-testid="toggle-flyer-picker"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'transparent', border: '1px solid var(--border)',
            color: 'var(--text-primary)', borderRadius: 4,
            padding: '3px 8px', cursor: 'pointer', fontSize: 12,
          }}
        >
          <Plus size={12} /> {showFlyerPicker ? 'Close' : 'Attach Flyer'}
        </button>
      </div>

      {/* Currently-attached flyers list */}
      {attachments.length === 0 && !showFlyerPicker && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
          No flyer attachments. Click 'Attach Flyer' to add one.
        </div>
      )}
      {attachments.length > 0 && (
        <ul
          data-testid="attached-flyers-list"
          style={{ listStyle: 'none', padding: 0, margin: '0 0 8px 0', display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          {attachments.map((a, idx) => (
            <li
              key={`${a.kind}-${a.flyerId ?? a.url ?? idx}-${a.format ?? ''}-${idx}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 8px',
                background: 'var(--bg-primary)', borderRadius: 4,
                fontSize: 12,
              }}
            >
              <FileImage size={12} style={{ color: '#3b82f6' }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.kind === 'flyer'
                  ? `${flyerNameById(a.flyerId)} — ${formatLabelByValue(a.format)}`
                  : `${a.kind} — ${a.url || a.filename || ''}`}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(idx)}
                aria-label="Remove attachment"
                data-testid={`remove-attachment-${idx}`}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 0 }}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Picker panel — flyer template dropdown + format selector + Add */}
      {showFlyerPicker && (
        <div
          data-testid="flyer-picker-panel"
          style={{ marginTop: 8, padding: 8, background: 'var(--bg-primary)', borderRadius: 4 }}
        >
          <label style={lbl}>Flyer template</label>
          <select
            value={pickerFlyerId}
            onChange={(e) => setPickerFlyerId(e.target.value)}
            data-testid="flyer-template-select"
            style={inp}
          >
            <option value="">— Pick a flyer —</option>
            {flyerTemplates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {flyerTemplates.length === 0 && (
            <small style={{ color: 'var(--text-secondary)', display: 'block', marginTop: 4 }}>
              No flyer templates available for this tenant.
            </small>
          )}

          <label style={{ ...lbl, marginTop: 8 }}>Format</label>
          <select
            value={pickerFormat}
            onChange={(e) => setPickerFormat(e.target.value)}
            data-testid="flyer-format-select"
            style={inp}
            disabled={!pickerFlyerId}
          >
            {FLYER_FORMAT_OPTIONS.map((f) => (
              <option key={f.format} value={f.format}>{f.label}</option>
            ))}
          </select>

          <button
            type="button"
            onClick={addFlyerAttachment}
            data-testid="add-flyer-attachment-btn"
            style={{
              marginTop: 8, width: '100%',
              display: 'inline-flex', justifyContent: 'center', alignItems: 'center', gap: 4,
              background: '#3b82f6', color: 'white',
              border: 'none', borderRadius: 4, padding: '6px 10px', cursor: 'pointer', fontSize: 12,
            }}
          >
            <Plus size={12} /> Add Attachment
          </button>
        </div>
      )}
    </div>
  );

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
          {renderFlyerPickerSection()}
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
          {renderFlyerPickerSection()}
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
