/**
 * CurriculumDocumentUpload.jsx — Admin UI for the AI curriculum-to-
 * itinerary matching feature (TMC sub-brand).
 *
 * Lets an admin upload a board curriculum PDF (CBSE/ICSE/IB/Cambridge
 * etc.) with metadata. The backend extracts learning objectives via an
 * LLM and indexes them into Qdrant so the public diagnostic form can
 * semantically match a school's stated curriculum against both the
 * curriculum objectives and the existing itinerary knowledge base.
 *
 * This is a NEW, ADDITIONAL path — entirely separate from the existing
 * manual/CSV TravelCurriculumMapping system that the rest of
 * CurriculumAdmin.jsx renders. This component does not read or write
 * anything related to that system.
 *
 * Backend contract (backend/routes/travel_curriculum.js — documents
 * sub-router, mounted at /api/travel-curriculum/documents; not modified
 * here, this file only consumes it):
 *
 *   POST   /api/travel-curriculum/documents           multipart upload
 *          fields: file (PDF), title, board, gradeBand,
 *                  subjects (JSON array string or comma-separated),
 *                  notes?, subBrand? (default "tmc")
 *          → 201 { document }
 *          errors: { error, code } — NO_FILE | INVALID_FILE_TYPE |
 *                  MISSING_FIELDS
 *
 *   GET    /api/travel-curriculum/documents?subBrand=  → { documents }
 *          (list items omit extractedObjectives)
 *
 *   GET    /api/travel-curriculum/documents/:id        → { document }
 *          (full extractedObjectives: [{text, subject, topicCode}])
 *
 *   POST   /api/travel-curriculum/documents/:id/reindex
 *          Re-embeds already-extracted objectives under whichever AI
 *          provider is currently active in AI Settings, without
 *          re-running LLM extraction. → { document }
 *          503 { error, code: "NO_EMBEDDING_PROVIDER" } — the error
 *          message is already human-readable, shown as-is.
 *
 *   DELETE /api/travel-curriculum/documents/:id        → 204
 *
 * Document.status: "processing" | "indexed" | "failed" — handled
 * defensively even though the POST call is synchronous (by the time the
 * response returns, status is already indexed/failed).
 *
 * File upload uses raw fetch + getAuthToken() (multipart bodies can't go
 * through fetchApi's JSON Content-Type default), matching the pattern in
 * DiagnosticPublicFormPanel.jsx's handleUpload. All other calls (list /
 * get / reindex / delete) use the shared fetchApi helper.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  FileText,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';

// Curriculum mapping (both the manual table and this AI upload flow) is a
// TMC-only feature today — schools inquire about school trips through TMC
// specifically, so there's no sub-brand choice to make here.
const CURRICULUM_SUB_BRAND = 'tmc';
const BOARD_SUGGESTIONS = ['CBSE', 'ICSE', 'IB', 'Cambridge', 'State Board', 'NIOS'];

const EMPTY_FORM = {
  title: '',
  board: '',
  gradeBand: '',
  subjects: '',
  notes: '',
};

// Backend code → user-friendly message. Falls back to the backend's own
// message where it's already human-readable (MISSING_FIELDS,
// NO_EMBEDDING_PROVIDER both name the actual problem).
function errorCodeToMessage(code, fallback) {
  switch (code) {
    case 'NO_FILE':
      return 'Please choose a PDF file to upload.';
    case 'INVALID_FILE_TYPE':
      return 'Only PDF files can be uploaded.';
    case 'MISSING_FIELDS':
      return fallback || 'Title, board, and grade band are required.';
    case 'NO_EMBEDDING_PROVIDER':
      return fallback || 'Embeddings require an OpenAI or Gemini key configured in AI Settings.';
    default:
      return fallback || 'Request failed';
  }
}

function statusBadgeStyle(status) {
  if (status === 'indexed') return { background: 'rgba(38, 128, 76, 0.16)', color: '#1F6B3E' };
  if (status === 'failed') return { background: 'rgba(168, 50, 63, 0.16)', color: '#A8323F' };
  return { background: 'rgba(200, 154, 78, 0.16)', color: '#9A6F2E' }; // processing
}

function statusLabel(status) {
  if (status === 'indexed') return 'Indexed';
  if (status === 'failed') return 'Failed';
  return 'Processing';
}

// Custom-styled suggestion dropdown for the Board field, replacing the
// native <input list>/<datalist> combo — datalist popups are rendered by
// the browser/OS directly and largely ignore app CSS (this is what caused
// the black-background, mismatched-color list a user reported), so we
// render our own list instead, matching the app's actual theme.
function BoardInput({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const query = String(value || '').trim().toLowerCase();
  const suggestions = query
    ? BOARD_SUGGESTIONS.filter((b) => b.toLowerCase().includes(query))
    : BOARD_SUGGESTIONS;

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="e.g. CBSE"
        style={input}
        required
        autoComplete="off"
        aria-label="Board"
      />
      {open && suggestions.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 'calc(100% + 4px)',
            zIndex: 30,
            maxHeight: 220,
            overflowY: 'auto',
            padding: 4,
            borderRadius: 8,
            border: '1px solid var(--border-color)',
            background: 'var(--surface-color)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
          }}
        >
          {suggestions.map((b) => (
            <button
              key={b}
              type="button"
              className="curriculum-board-option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(b); setOpen(false); }}
              style={{
                width: '100%',
                display: 'block',
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: 'var(--text-primary)',
                fontSize: 13,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {b}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function CurriculumDocumentUpload() {
  const notify = useNotify();

  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [file, setFile] = useState(null);
  const [formError, setFormError] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const [expandedId, setExpandedId] = useState(null);
  const [objectivesById, setObjectivesById] = useState({});
  const [objectivesLoadingId, setObjectivesLoadingId] = useState(null);
  const [reindexingId, setReindexingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await fetchApi(`/api/travel-curriculum/documents?subBrand=${CURRICULUM_SUB_BRAND}`, { silent: true });
      setDocuments(Array.isArray(res?.documents) ? res.documents : []);
    } catch (e) {
      setLoadError(e?.data?.error || e?.message || 'Failed to load curriculum documents');
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const resetForm = () => {
    setForm({ ...EMPTY_FORM });
    setFile(null);
    setFormError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onPickFile = (e) => {
    const picked = e.target.files?.[0] || null;
    setFile(picked);
  };

  const handleUpload = async (e) => {
    e.preventDefault();
    setFormError('');

    if (!file) {
      setFormError('Please choose a PDF file to upload.');
      return;
    }
    if (file.type && file.type !== 'application/pdf') {
      setFormError('Only PDF files can be uploaded.');
      return;
    }
    const title = form.title.trim();
    const board = form.board.trim();
    const gradeBand = form.gradeBand.trim();
    if (!title || !board || !gradeBand) {
      setFormError('Title, board, and grade band are required.');
      return;
    }

    const subjects = form.subjects
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', title);
      fd.append('board', board);
      fd.append('gradeBand', gradeBand);
      fd.append('subjects', JSON.stringify(subjects));
      if (form.notes.trim()) fd.append('notes', form.notes.trim());
      fd.append('subBrand', CURRICULUM_SUB_BRAND);

      const token = getAuthToken();
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch('/api/travel-curriculum/documents', {
        method: 'POST',
        body: fd,
        headers,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(errorCodeToMessage(body?.code, body?.error));
      }

      const body = await res.json();
      const doc = body?.document;
      if (doc?.status === 'failed') {
        notify.error(doc.errorMessage || 'The PDF was uploaded but curriculum extraction failed.');
      } else if (doc?.status === 'indexed') {
        notify.success(`"${doc.title}" indexed with ${doc.objectiveCount ?? 0} learning objective(s).`);
      } else {
        notify.success('Curriculum document uploaded. Processing…');
      }
      resetForm();
      await load();
    } catch (err) {
      const msg = err?.message || 'Upload failed';
      setFormError(msg);
      notify.error(msg);
    } finally {
      setUploading(false);
    }
  };

  const toggleObjectives = async (doc) => {
    if (expandedId === doc.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(doc.id);
    if (objectivesById[doc.id]) return; // already cached
    setObjectivesLoadingId(doc.id);
    try {
      const res = await fetchApi(`/api/travel-curriculum/documents/${doc.id}`, { silent: true });
      setObjectivesById((prev) => ({
        ...prev,
        [doc.id]: Array.isArray(res?.document?.extractedObjectives)
          ? res.document.extractedObjectives
          : [],
      }));
    } catch (e) {
      notify.error(e?.data?.error || e?.message || 'Failed to load extracted objectives');
      setExpandedId(null);
    } finally {
      setObjectivesLoadingId(null);
    }
  };

  const handleReindex = async (doc) => {
    setReindexingId(doc.id);
    try {
      const res = await fetchApi(`/api/travel-curriculum/documents/${doc.id}/reindex`, {
        method: 'POST',
        silent: true,
      });
      const updated = res?.document;
      notify.success(`"${doc.title}" reindexed${updated?.objectiveCount != null ? ` (${updated.objectiveCount} objectives)` : ''}.`);
      if (updated) {
        setDocuments((prev) => prev.map((d) => (d.id === doc.id ? { ...d, ...updated } : d)));
      } else {
        await load();
      }
    } catch (e) {
      const code = e?.data?.code || e?.code;
      const msg = code === 'NO_EMBEDDING_PROVIDER'
        ? (e?.data?.error || e?.message || errorCodeToMessage(code))
        : (e?.data?.error || e?.message || 'Reindex failed');
      notify.error(msg);
    } finally {
      setReindexingId(null);
    }
  };

  const handleDelete = (doc) => {
    // Native confirm for hard-stop destructive ops — mirrors the
    // established pattern in CurriculumAdmin.jsx's handleDelete.
    const ok = window.confirm(
      `Delete curriculum document "${doc.title}"?\n\nThis permanently removes the document and its indexed vectors from Qdrant.`,
    );
    if (!ok) return;
    setDeletingId(doc.id);
    fetchApi(`/api/travel-curriculum/documents/${doc.id}`, { method: 'DELETE', silent: true })
      .then(() => {
        notify.success('Curriculum document deleted.');
        setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
        setObjectivesById((prev) => {
          const next = { ...prev };
          delete next[doc.id];
          return next;
        });
        if (expandedId === doc.id) setExpandedId(null);
      })
      .catch((e) => {
        notify.error(e?.data?.error || e?.message || 'Delete failed');
      })
      .finally(() => setDeletingId(null));
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <style>{`
        .curriculum-board-option:hover {
          background: var(--hover-bg, rgba(99, 102, 241, 0.12)) !important;
        }
      `}</style>
      <section style={card}>
        <h2 style={cardTitle}>
          <FileText size={18} style={{ verticalAlign: -3, marginRight: 8 }} />
          Upload curriculum PDF
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: -8, marginBottom: 14 }}>
          Upload a board curriculum document. The system extracts learning
          objectives with AI and indexes them so the public diagnostic form
          can semantically match a school&rsquo;s stated curriculum against
          both these objectives and the existing itinerary knowledge base.
        </p>

        {formError && (
          <div role="alert" style={errorBanner}>
            <AlertTriangle size={14} /> {formError}
          </div>
        )}

        <form onSubmit={handleUpload} style={{ display: 'grid', gap: 12 }}>
          <div style={fieldGrid}>
            <label style={fieldLabel}>
              Title
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. CBSE Class 9-10 Social Science Curriculum"
                style={input}
                required
              />
            </label>

            <label style={fieldLabel}>
              {/* Same real-world value as "Curriculum" on the mapping table
                  above (CBSE / ICSE / IB / …) — labeled "Board" here only
                  because that's the term boards themselves use for their own
                  syllabus documents. Naming it explicitly avoids it reading
                  as a third, unrelated concept. */}
              Board (= &ldquo;Curriculum&rdquo; in the table above)
              <BoardInput value={form.board} onChange={(v) => setForm({ ...form, board: v })} />
            </label>

            <label style={fieldLabel}>
              Grade band
              <input
                type="text"
                value={form.gradeBand}
                onChange={(e) => setForm({ ...form, gradeBand: e.target.value })}
                placeholder="e.g. Class 9-10"
                style={input}
                required
              />
            </label>

          </div>

          <label style={fieldLabel}>
            Subjects
            <input
              type="text"
              value={form.subjects}
              onChange={(e) => setForm({ ...form, subjects: e.target.value })}
              placeholder="Comma-separated, e.g. Geography, History"
              style={input}
            />
            <span style={fieldHintText}>Comma-separated list of subjects covered by this document.</span>
          </label>

          <label style={fieldLabel}>
            Notes (optional)
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              placeholder="Any internal notes about this document"
              style={{ ...input, resize: 'vertical' }}
            />
          </label>

          <label style={fieldLabel}>
            PDF file
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={onPickFile}
              style={input}
              required
            />
            {file && (
              <span style={fieldHintText}>
                {file.name} ({Math.round(file.size / 1024)} KB)
              </span>
            )}
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" onClick={resetForm} style={secondaryBtn} disabled={uploading}>
              Clear
            </button>
            <button type="submit" style={uploading ? primaryBtnDisabled : primaryBtn} disabled={uploading}>
              <Upload size={14} /> {uploading ? 'Uploading & indexing…' : 'Upload & index'}
            </button>
          </div>
          {uploading && (
            <p style={{ color: 'var(--text-secondary)', fontSize: 12, textAlign: 'right', margin: 0 }}>
              This can take a little while — PDF extraction, LLM analysis, and embedding all run before the response returns.
            </p>
          )}
        </form>
      </section>

      <section style={card}>
        <div style={sectionHeader}>
          <h2 style={cardTitle}>Uploaded curriculum documents</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" onClick={load} style={secondaryBtn}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>

        {loadError && (
          <div role="alert" style={errorBanner}>
            <AlertTriangle size={14} /> {loadError}
          </div>
        )}

        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : documents.length === 0 ? (
          <div style={empty}>No curriculum documents uploaded yet.</div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {documents.map((doc) => {
              const isExpanded = expandedId === doc.id;
              const objectives = objectivesById[doc.id];
              return (
                <div key={doc.id} style={docCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 14 }}>{doc.title}</strong>
                        <span style={{ ...badge, ...statusBadgeStyle(doc.status) }}>
                          {statusLabel(doc.status)}
                        </span>
                      </div>
                      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                        {doc.board} &middot; {doc.gradeBand}
                        {Array.isArray(doc.subjects) && doc.subjects.length > 0 && (
                          <> &middot; {doc.subjects.join(', ')}</>
                        )}
                      </p>
                      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                        {doc.objectiveCount ?? 0} objective(s) &middot; uploaded {formatDate(doc.createdAt)}
                        {doc.indexedAt && <> &middot; indexed {formatDate(doc.indexedAt)}</>}
                      </p>
                      {doc.status === 'failed' && doc.errorMessage && (
                        <p style={{ margin: '6px 0 0', fontSize: 12, color: '#A8323F' }}>
                          <AlertTriangle size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
                          {doc.errorMessage}
                        </p>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                      <button
                        type="button"
                        onClick={() => toggleObjectives(doc)}
                        style={iconActionBtn}
                      >
                        {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        View extracted objectives
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReindex(doc)}
                        disabled={reindexingId === doc.id}
                        style={iconActionBtn}
                        title="Re-embed this document's objectives under the currently active AI provider"
                      >
                        <RefreshCw size={13} /> {reindexingId === doc.id ? 'Reindexing…' : 'Reindex'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(doc)}
                        disabled={deletingId === doc.id}
                        style={{ ...iconActionBtn, color: '#A8323F', borderColor: 'rgba(168,50,63,0.4)' }}
                      >
                        <Trash2 size={13} /> {deletingId === doc.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div style={objectivesPanel}>
                      {objectivesLoadingId === doc.id ? (
                        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>Loading objectives&hellip;</p>
                      ) : !objectives || objectives.length === 0 ? (
                        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
                          No extracted objectives to show.
                        </p>
                      ) : (
                        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
                          {objectives.map((obj, idx) => (
                            <li key={idx} style={objectiveRow}>
                              <span style={{ flex: 1 }}>{obj.text}</span>
                              {obj.subject && <span style={objectiveTag}>{obj.subject}</span>}
                              {obj.topicCode && <span style={objectiveTag}>{obj.topicCode}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

const card = {
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 10,
  padding: '18px 20px',
};

const cardTitle = {
  fontSize: 16,
  fontWeight: 600,
  margin: '0 0 14px',
  color: 'var(--text-primary)',
};

const sectionHeader = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 10,
  marginBottom: 14,
};

const fieldGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
  gap: 12,
};

const fieldLabel = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: 'var(--text-secondary)',
  fontWeight: 500,
};

const input = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--input-bg, var(--surface-color))',
  color: 'var(--text-primary)',
  fontSize: 14,
  fontFamily: 'inherit',
};

const fieldHintText = {
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontStyle: 'italic',
};

const primaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  borderRadius: 8,
  border: 'none',
  background: 'var(--primary-color, var(--accent-color))',
  color: 'var(--accent-text, #fff)',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
};

const primaryBtnDisabled = {
  ...primaryBtn,
  opacity: 0.6,
  cursor: 'not-allowed',
};

const secondaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--primary-color, var(--accent-color))',
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
};

const iconActionBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 8px',
  borderRadius: 4,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  fontSize: 12,
  cursor: 'pointer',
};

const badge = {
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
};

const errorBanner = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderRadius: 6,
  background: 'rgba(168,50,63,0.10)',
  border: '1px solid rgba(168,50,63,0.35)',
  color: '#A8323F',
  fontSize: 13,
  marginBottom: 12,
};

const empty = {
  padding: 24,
  textAlign: 'center',
  color: 'var(--text-secondary)',
  fontSize: 14,
};

const docCard = {
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  padding: 14,
  background: 'var(--bg-color, rgba(255,255,255,0.02))',
};

const objectivesPanel = {
  marginTop: 12,
  paddingTop: 12,
  borderTop: '1px solid var(--border-color)',
};

const objectiveRow = {
  display: 'flex',
  gap: 8,
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  fontSize: 13,
  color: 'var(--text-primary)',
  padding: '6px 8px',
  borderRadius: 6,
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
};

const objectiveTag = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  background: 'var(--bg-color, rgba(255,255,255,0.04))',
  border: '1px solid var(--border-color)',
  borderRadius: 999,
  padding: '2px 8px',
  whiteSpace: 'nowrap',
};
