/**
 * CurriculumAdmin.jsx — ADMIN-only CRUD admin page for the TMC
 * Curriculum Mappings catalogue (Phase 1/PC-1..PC-5 resolved tick #181;
 * backend route shipped tick #180 commit 6d5919a8).
 *
 * Consumes /api/travel-curriculum (route at backend/routes/travel_curriculum.js
 * — 5 endpoints: list / get / create / update / soft-delete). The
 * backend gates POST / PUT / DELETE on ADMIN role; GET is verifyToken-
 * only. This page mirrors that contract: the New / Edit / Delete CTAs
 * are hidden for non-ADMIN users.
 *
 * Backend contract pinned (per backend/routes/travel_curriculum.js):
 *   GET    /api/travel-curriculum?curriculum&grade&subject&isActive
 *                            &limit&offset
 *          → { mappings:[…], total, limit, offset }
 *   GET    /api/travel-curriculum/:id     → single mapping
 *   POST   /api/travel-curriculum         → 201 created (ADMIN-only)
 *          body: { curriculum, grade, subject, learningOutcome?,
 *                  destinationId?, destinationLabel?, fitScore?,
 *                  fitRationale?, isActive? }
 *   PUT    /api/travel-curriculum/:id     → 200 updated (ADMIN-only)
 *   DELETE /api/travel-curriculum/:id     → 200 soft-deleted, isActive=false
 *
 * Error codes mapped to user-friendly messages (per route header):
 *   CURRICULUM_NOT_FOUND       → "Mapping no longer exists (refresh)"
 *   CURRICULUM_DUPLICATE       → "A mapping with that (curriculum,
 *                                 grade, subject, learning outcome)
 *                                 combination already exists"
 *   INVALID_FIT_SCORE          → "Fit score must be an integer 1-100"
 *   INVALID_DESTINATION_ID     → "Destination id must be an integer"
 *   MISSING_FIELDS             → backend's message (names the field)
 *   EMPTY_BODY                 → "No updatable fields provided"
 *   INVALID_ID                 → "Invalid mapping id"
 *   RBAC_DENIED                → "Only admins can modify curriculum mappings"
 *
 * Sub-brand context: TMC-implicit (school-trip pitch deck mappings).
 * Backend scopes by req.user.tenantId with no sub-brand discriminator
 * in the TravelCurriculumMapping model, so no sub-brand selector is
 * rendered on this page.
 *
 * FitScore badge colors via CSS classes (per Itineraries.jsx tick #116
 * className-not-inline-hex pattern + CLAUDE.md theme rule). The classes
 * are defined inline at the bottom of the module via a <style> block;
 * the wellness theme + generic theme both pick them up unchanged.
 *
 *   green  ≥ 80   strong fit
 *   amber  50-79  moderate fit
 *   red    < 50   weak fit
 *
 * Path: frontend/src/pages/travel/CurriculumAdmin.jsx — sibling to
 * Itineraries.jsx / Trips.jsx / SuppliersAdmin.jsx etc. in the Phase 1
 * Travel folder (NOT under visa/, since this is TMC vertical not Visa
 * Sure).
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { GraduationCap, Plus, Edit2, Trash2, X, AlertTriangle, Sparkles } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';
import TopScrollSync from '../../components/TopScrollSync';

// learningOutcome max length matches schema (prisma/schema.prisma —
// TravelCurriculumMapping.learningOutcome is VarChar(300)).
const LEARNING_OUTCOME_MAX = 300;
const PAGE_SIZE = 10;

// Common curriculum tokens the academic-team curates. The backend
// accepts arbitrary non-empty strings; the dropdown is a suggestion
// list. Operators can free-type other values via the input + datalist.
const CURRICULUM_SUGGESTIONS = [
  'CBSE',
  'ICSE',
  'IB',
  'Cambridge',
  'State Board',
  'NIOS',
];

const EMPTY_FORM = {
  academicYear: '',
  curriculum: '',
  grade: '',
  subject: '',
  learningOutcomeCode: '',
  learningOutcome: '',
  destinationId: '',
  destinationLabel: '',
  fitScore: 50,
  confidenceScore: 50,
  fitRationale: '',
  isActive: true,
};

const EMPTY_PROPOSAL_FORM = {
  academicYear: '',
  curriculum: '',
  grade: '',
  subject: '',
  learningOutcomeCode: '',
  learningOutcome: '',
};

// Backend code → user-friendly message map. Returns the backend's own
// message as a fallback (it's already human-readable for MISSING_FIELDS).
function errorCodeToMessage(code, fallback) {
  switch (code) {
    case 'CURRICULUM_NOT_FOUND':
      return 'Curriculum mapping no longer exists (refresh the page)';
    case 'CURRICULUM_DUPLICATE':
      return 'A mapping with that (curriculum, grade, subject, learning outcome) combination already exists for this tenant';
    case 'INVALID_FIT_SCORE':
      return 'Fit score must be a whole number between 1 and 100';
    case 'INVALID_DESTINATION_ID':
      return 'Destination id must be a whole number';
    case 'INVALID_CONFIDENCE_SCORE':
      return 'Confidence score must be a whole number between 0 and 100';
    case 'MISSING_FIELDS':
      return fallback || 'Curriculum, grade, and subject are required';
    case 'EMPTY_BODY':
      return 'No updatable fields provided';
    case 'INVALID_ID':
      return 'Invalid mapping id';
    case 'RBAC_DENIED':
      return 'Only admins can modify curriculum mappings';
    default:
      return fallback || 'Request failed';
  }
}

function fitScoreClass(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'curriculum-fit-amber';
  if (score >= 80) return 'curriculum-fit-green';
  if (score >= 50) return 'curriculum-fit-amber';
  return 'curriculum-fit-red';
}

function FitScoreBadge({ score }) {
  if (score == null) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  return (
    <span className={`curriculum-fit-score ${fitScoreClass(score)}`}>
      {score}
    </span>
  );
}

// Truncate long learning-outcome strings for the table cell. We retain
// the full text in a title attribute so hover surfaces the original.
function truncate(text, max = 80) {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

export default function CurriculumAdmin() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN';

  const [mappings, setMappings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  // Filter state.
  const [filterAcademicYear, setFilterAcademicYear] = useState('');
  const [filterCurriculum, setFilterCurriculum] = useState('');
  const [filterGrade, setFilterGrade] = useState('');
  const [filterSubject, setFilterSubject] = useState('');
  const [filterIsActive, setFilterIsActive] = useState('all'); // all | true | false

  const [proposalPanelOpen, setProposalPanelOpen] = useState(false);
  const [proposals, setProposals] = useState([]);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [proposalError, setProposalError] = useState('');
  const [proposalForm, setProposalForm] = useState(EMPTY_PROPOSAL_FORM);
  const [proposalSubmitting, setProposalSubmitting] = useState(false);
  const [selectedProposalIds, setSelectedProposalIds] = useState([]);

  // Modal state.
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const listRef = useRef(null);
  const mappingsRef = useRef([]);
  const loadingRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);

  useEffect(() => {
    mappingsRef.current = mappings;
  }, [mappings]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    loadingMoreRef.current = loadingMore;
  }, [loadingMore]);

  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const buildQuery = useCallback(() => {
    const qs = new URLSearchParams();
    if (filterAcademicYear.trim()) qs.set('academicYear', filterAcademicYear.trim());
    if (filterCurriculum.trim()) qs.set('curriculum', filterCurriculum.trim());
    if (filterGrade.trim()) qs.set('grade', filterGrade.trim());
    if (filterSubject.trim()) qs.set('subject', filterSubject.trim());
    if (filterIsActive !== 'all') qs.set('isActive', filterIsActive);
    return qs.toString();
  }, [filterAcademicYear, filterCurriculum, filterGrade, filterSubject, filterIsActive]);

  const load = useCallback(async ({ reset = false } = {}) => {
    const startOffset = reset ? 0 : offsetRef.current;

    if (reset) {
      setLoading(true);
      setLoadingMore(false);
      setLoadError('');
      setMappings([]);
      mappingsRef.current = [];
      setOffset(0);
      setHasMore(true);
      offsetRef.current = 0;
      hasMoreRef.current = true;
      if (listRef.current) listRef.current.scrollTop = 0;
    } else {
      if (loadingRef.current || loadingMoreRef.current || !hasMoreRef.current) return;
      setLoadingMore(true);
    }

    const qs = new URLSearchParams(buildQuery());
    if (startOffset > 0) {
      qs.set('limit', String(PAGE_SIZE));
      qs.set('offset', String(startOffset));
    }
    const queryString = qs.toString();
    const url = `/api/travel-curriculum${queryString ? `?${queryString}` : ''}`;
    try {
      const res = await fetchApi(url);
      const rows = Array.isArray(res?.mappings) ? res.mappings : [];
      const totalCount = Number.isFinite(Number(res?.total)) ? Number(res.total) : rows.length;
      const nextMappings = reset ? rows : [...mappingsRef.current, ...rows];
      const nextOffset = startOffset + rows.length;
      const nextHasMore = Number.isFinite(totalCount)
        ? nextOffset < totalCount
        : rows.length === PAGE_SIZE;

      mappingsRef.current = nextMappings;
      setMappings(nextMappings);
      setOffset(nextOffset);
      setHasMore(nextHasMore);
      offsetRef.current = nextOffset;
      hasMoreRef.current = nextHasMore;
    } catch (e) {
      setLoadError(e?.message || 'Failed to load curriculum mappings');
      if (reset) {
        setMappings([]);
        mappingsRef.current = [];
        setOffset(0);
        setHasMore(false);
        offsetRef.current = 0;
        hasMoreRef.current = false;
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [buildQuery]);

  useEffect(() => {
    load({ reset: true });
  }, [load]);

  const handleListScroll = useCallback((e) => {
    const el = e.currentTarget;
    if (!el || loadingRef.current || loadingMoreRef.current || !hasMoreRef.current) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 72) {
      load({ reset: false });
    }
  }, [load]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || loading || loadingMore || !hasMore) return;
    if (el.scrollHeight <= el.clientHeight + 72) load({ reset: false });
  }, [mappings, hasMore, loading, loadingMore, load]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (m) => {
    setEditingId(m.id);
    setForm({
      academicYear: m.academicYear || '',
      curriculum: m.curriculum || '',
      grade: m.grade || '',
      subject: m.subject || '',
      learningOutcomeCode: m.learningOutcomeCode || '',
      learningOutcome: m.learningOutcome || '',
      destinationId: m.destinationId == null ? '' : String(m.destinationId),
      destinationLabel: m.destinationLabel || '',
      fitScore: m.fitScore == null ? 50 : m.fitScore,
      confidenceScore: m.confidenceScore == null ? 50 : m.confidenceScore,
      fitRationale: m.fitRationale || '',
      isActive: m.isActive !== false,
    });
    setFormError(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setFormError(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    setFormError(null);

    // Client-side gates mirroring backend MISSING_FIELDS /
    // INVALID_FIT_SCORE / INVALID_DESTINATION_ID checks. Backend remains
    // the source of truth.
    const curriculum = (form.curriculum || '').trim();
    const grade = (form.grade || '').trim();
    const subject = (form.subject || '').trim();
    if (!curriculum) {
      setFormError({ field: 'curriculum', message: 'Curriculum is required' });
      return;
    }
    if (!grade) {
      setFormError({ field: 'grade', message: 'Grade is required' });
      return;
    }
    if (!subject) {
      setFormError({ field: 'subject', message: 'Subject is required' });
      return;
    }

    // learningOutcome ≤ 300 chars (mirrors @db.VarChar(300) on the
    // schema — see prisma/schema.prisma:TravelCurriculumMapping).
    const learningOutcome = (form.learningOutcome || '').trim();
    if (learningOutcome.length > LEARNING_OUTCOME_MAX) {
      setFormError({
        field: 'learningOutcome',
        message: `Learning outcome must be ${LEARNING_OUTCOME_MAX} characters or fewer`,
      });
      return;
    }

    // fitScore: integer 1..100 (backend's assertValidFitScore).
    const fitScoreNum = Number(form.fitScore);
    if (!Number.isInteger(fitScoreNum) || fitScoreNum < 1 || fitScoreNum > 100) {
      setFormError({
        field: 'fitScore',
        message: 'Fit score must be a whole number between 1 and 100',
      });
      return;
    }

    // destinationId: optional integer (backend's assertValidDestinationId).
    let destinationId = null;
    if (form.destinationId !== '' && form.destinationId != null) {
      const idNum = Number(form.destinationId);
      if (!Number.isInteger(idNum)) {
        setFormError({ field: 'destinationId', message: 'Destination id must be a whole number' });
        return;
      }
      destinationId = idNum;
    }

    const confidenceScoreNum = Number(form.confidenceScore);
    if (!Number.isInteger(confidenceScoreNum) || confidenceScoreNum < 0 || confidenceScoreNum > 100) {
      setFormError({
        field: 'confidenceScore',
        message: 'Confidence score must be a whole number between 0 and 100',
      });
      return;
    }

    const body = {
      academicYear: (form.academicYear || '').trim() || null,
      curriculum,
      grade,
      subject,
      learningOutcomeCode: (form.learningOutcomeCode || '').trim() || null,
      learningOutcome: learningOutcome || null,
      destinationId,
      destinationLabel: (form.destinationLabel || '').trim() || null,
      fitScore: fitScoreNum,
      confidenceScore: confidenceScoreNum,
      fitRationale: (form.fitRationale || '').trim() || null,
      isActive: Boolean(form.isActive),
    };

    setSubmitting(true);
    try {
      const url = editingId
        ? `/api/travel-curriculum/${editingId}`
        : '/api/travel-curriculum';
      const method = editingId ? 'PUT' : 'POST';
      await fetchApi(url, {
        method,
        body: JSON.stringify(body),
        silent: true,
      });
      notify.success(editingId ? 'Curriculum mapping updated' : 'Curriculum mapping created');
      closeModal();
      load();
    } catch (err) {
      const code = err?.code || err?.data?.code;
      const backendMsg = err?.data?.error || err?.message || 'Save failed';
      const userMsg = errorCodeToMessage(code, backendMsg);
      let field = null;
      switch (code) {
        case 'INVALID_FIT_SCORE':
          field = 'fitScore';
          break;
        case 'INVALID_DESTINATION_ID':
          field = 'destinationId';
          break;
        case 'INVALID_CONFIDENCE_SCORE':
          field = 'confidenceScore';
          break;
        case 'MISSING_FIELDS':
          field = null;
          break;
        case 'CURRICULUM_DUPLICATE':
          field = null;
          break;
        default:
          field = null;
      }
      setFormError({ field, code: code || null, message: userMsg });
      notify.error(userMsg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = (m) => {
    if (!isAdmin) return;
    // Wellness pattern (per CLAUDE.md): native confirm for hard-stop ops.
    // Curriculum mappings are soft-deleted (set isActive=false) so the
    // wording names that explicitly — preserves the diagnostic engine's
    // audit-trail references per backend route header.
    const ok = window.confirm(
      `Deactivate curriculum mapping "${m.curriculum} / ${m.grade} / ${m.subject}"?\n\nThis is a soft delete — the mapping will be marked inactive but kept in the audit history for the diagnostic engine.`,
    );
    if (!ok) return;
    fetchApi(`/api/travel-curriculum/${m.id}`, { method: 'DELETE', silent: true })
      .then(() => {
        notify.success('Curriculum mapping deactivated');
        load();
      })
      .catch((err) => {
        const code = err?.code || err?.data?.code;
        const userMsg = errorCodeToMessage(code, err?.message || 'Delete failed');
        notify.error(userMsg);
      });
  };

  const loadProposals = async () => {
    setProposalLoading(true);
    setProposalError('');
    try {
      const res = await fetchApi('/api/travel-curriculum/proposals?reviewStatus=pending');
      setProposals(Array.isArray(res?.proposals) ? res.proposals : []);
    } catch (e) {
      setProposalError(e?.message || 'Failed to load curriculum proposals');
      setProposals([]);
    } finally {
      setProposalLoading(false);
    }
  };

  const toggleProposalPanel = async () => {
    const next = !proposalPanelOpen;
    setProposalPanelOpen(next);
    if (next) await loadProposals();
  };

  const submitProposalGeneration = async (e) => {
    e.preventDefault();
    setProposalError('');
    const curriculum = proposalForm.curriculum.trim();
    const grade = proposalForm.grade.trim();
    const subject = proposalForm.subject.trim();
    const learningOutcome = proposalForm.learningOutcome.trim();
    if (!curriculum || !grade || !subject || !learningOutcome) {
      setProposalError('Curriculum, grade, subject, and learning outcome are required for proposal generation.');
      return;
    }
    setProposalSubmitting(true);
    try {
      await fetchApi('/api/travel-curriculum/proposals/generate', {
        method: 'POST',
        body: JSON.stringify({
          academicYear: proposalForm.academicYear.trim() || null,
          curriculum,
          grade,
          subject,
          learningOutcomeCode: proposalForm.learningOutcomeCode.trim() || null,
          learningOutcome,
        }),
        silent: true,
      });
      notify.success('Curriculum proposals generated');
      setProposalForm(EMPTY_PROPOSAL_FORM);
      await loadProposals();
    } catch (err) {
      const msg = err?.data?.error || err?.message || 'Proposal generation failed';
      setProposalError(msg);
      notify.error(msg);
    } finally {
      setProposalSubmitting(false);
    }
  };

  const approveProposal = async (id) => {
    try {
      await fetchApi(`/api/travel-curriculum/proposals/${id}/approve`, { method: 'POST', silent: true });
      notify.success('Proposal approved');
      setSelectedProposalIds((prev) => prev.filter((value) => value !== id));
      await Promise.all([load(), loadProposals()]);
    } catch (err) {
      notify.error(err?.data?.error || err?.message || 'Approve failed');
    }
  };

  const rejectProposal = async (id) => {
    try {
      await fetchApi(`/api/travel-curriculum/proposals/${id}/reject`, { method: 'POST', silent: true });
      notify.success('Proposal rejected');
      setSelectedProposalIds((prev) => prev.filter((value) => value !== id));
      await loadProposals();
    } catch (err) {
      notify.error(err?.data?.error || err?.message || 'Reject failed');
    }
  };

  const bulkApproveSelected = async () => {
    if (selectedProposalIds.length === 0) return;
    try {
      await fetchApi('/api/travel-curriculum/proposals/bulk-approve', {
        method: 'POST',
        body: JSON.stringify({ ids: selectedProposalIds }),
        silent: true,
      });
      notify.success('Selected proposals approved');
      setSelectedProposalIds([]);
      await Promise.all([load(), loadProposals()]);
    } catch (err) {
      notify.error(err?.data?.error || err?.message || 'Bulk approve failed');
    }
  };

  const bulkApproveHighConfidence = async () => {
    try {
      await fetchApi('/api/travel-curriculum/proposals/bulk-approve', {
        method: 'POST',
        body: JSON.stringify({ minConfidence: 80 }),
        silent: true,
      });
      notify.success('High-confidence proposals approved');
      setSelectedProposalIds([]);
      await Promise.all([load(), loadProposals()]);
    } catch (err) {
      notify.error(err?.data?.error || err?.message || 'Bulk approve failed');
    }
  };

  const toggleProposalSelection = (id) => {
    setSelectedProposalIds((prev) => (
      prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]
    ));
  };

  return (
    <div style={{ padding: 24, width: "100%", maxWidth: 1480, margin: '0 auto', boxSizing: 'border-box' }}>
      {/* Inline style block for the fit-score badge classes. Keeps the
          theme-friendly color values in one place + avoids spraying
          hex codes through inline styles (per Itineraries.jsx pattern). */}
      <style>{`
        .curriculum-fit-score {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 600;
          min-width: 32px;
          text-align: center;
        }
        .curriculum-fit-green {
          background: rgba(38, 128, 76, 0.16);
          color: #1F6B3E;
        }
        .curriculum-fit-amber {
          background: rgba(200, 154, 78, 0.16);
          color: #9A6F2E;
        }
        .curriculum-fit-red {
          background: rgba(168, 50, 63, 0.16);
          color: #A8323F;
        }
      `}</style>

      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h1
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              margin: 0,
              marginBottom: 4,
            }}
          >
            <GraduationCap size={28} aria-hidden /> Curriculum Mappings
          </h1>
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            TMC school-trip pitch-deck mappings &mdash; curriculum &times; grade &times;
            subject &rarr; destination. Drives the diagnostic engine&apos;s
            recommendation surface for advisors pitching to school decision-makers.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {isAdmin && (
            <button
              type="button"
              onClick={toggleProposalPanel}
              style={refreshBtn}
            >
              <Sparkles size={14} /> {proposalPanelOpen ? 'Hide Proposal Review' : 'Open Proposal Review'}
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={openCreate}
              style={primaryBtn}
              aria-label="Create a new curriculum mapping"
              data-testid="curriculum-mapping-new"
            >
              <Plus size={14} /> New Mapping
            </button>
          )}
        </div>
      </header>

      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          alignItems: 'center',
          background: 'var(--surface-color)',
          padding: 12,
          borderRadius: 8,
          border: '1px solid var(--border-color)',
          marginBottom: 16,
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          Academic year
          <input
            type="text"
            value={filterAcademicYear}
            onChange={(e) => setFilterAcademicYear(e.target.value)}
            placeholder="e.g. 2026-27"
            style={{ ...inputStyle, minWidth: 110 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          Curriculum
          <select
            value={filterCurriculum}
            onChange={(e) => setFilterCurriculum(e.target.value)}
            aria-label="Filter by curriculum"
            style={selectStyle}
            data-testid="curriculum-filter-curriculum"
          >
            <option value="">All curricula</option>
            {CURRICULUM_SUGGESTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          Grade
          <input
            type="text"
            value={filterGrade}
            onChange={(e) => setFilterGrade(e.target.value)}
            placeholder="e.g. 9"
            aria-label="Filter by grade"
            style={{ ...inputStyle, minWidth: 80, width: 90 }}
            data-testid="curriculum-filter-grade"
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          Subject
          <input
            type="text"
            value={filterSubject}
            onChange={(e) => setFilterSubject(e.target.value)}
            placeholder="e.g. History"
            aria-label="Filter by subject"
            style={{ ...inputStyle, minWidth: 140 }}
            data-testid="curriculum-filter-subject"
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          Active
          <select
            value={filterIsActive}
            onChange={(e) => setFilterIsActive(e.target.value)}
            aria-label="Filter by active state"
            style={selectStyle}
            data-testid="curriculum-filter-active"
          >
            <option value="all">All</option>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
          </select>
        </label>
      </div>

      {proposalPanelOpen && (
        <div
          style={{
            background: 'var(--surface-color)',
            borderRadius: 8,
            border: '1px solid var(--border-color)',
            padding: 16,
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <div>
              <h2 style={{ margin: 0, marginBottom: 4, fontSize: 18 }}>Proposal Review</h2>
              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>
                Generate suggestions, review confidence scores, and bulk-approve strong mappings.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={bulkApproveHighConfidence} style={refreshBtn}>
                Approve 80%+
              </button>
              <button type="button" onClick={bulkApproveSelected} style={primaryBtn} disabled={selectedProposalIds.length === 0}>
                Approve selected
              </button>
            </div>
          </div>

          <form
            onSubmit={submitProposalGeneration}
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}
          >
            <label style={fieldLabel}>
              Academic year
              <input
                type="text"
                value={proposalForm.academicYear}
                onChange={(e) => setProposalForm({ ...proposalForm, academicYear: e.target.value })}
                placeholder="2026-27"
                style={inputStyle}
              />
            </label>
            <label style={fieldLabel}>
              Curriculum
              <input
                type="text"
                value={proposalForm.curriculum}
                onChange={(e) => setProposalForm({ ...proposalForm, curriculum: e.target.value })}
                style={inputStyle}
              />
            </label>
            <label style={fieldLabel}>
              Grade
              <input
                type="text"
                value={proposalForm.grade}
                onChange={(e) => setProposalForm({ ...proposalForm, grade: e.target.value })}
                style={inputStyle}
              />
            </label>
            <label style={fieldLabel}>
              Subject
              <input
                type="text"
                value={proposalForm.subject}
                onChange={(e) => setProposalForm({ ...proposalForm, subject: e.target.value })}
                style={inputStyle}
              />
            </label>
            <label style={fieldLabel}>
              Outcome code
              <input
                type="text"
                value={proposalForm.learningOutcomeCode}
                onChange={(e) => setProposalForm({ ...proposalForm, learningOutcomeCode: e.target.value })}
                style={inputStyle}
              />
            </label>
            <label style={{ ...fieldLabel, gridColumn: '1 / -1' }}>
              Learning outcome
              <textarea
                value={proposalForm.learningOutcome}
                onChange={(e) => setProposalForm({ ...proposalForm, learningOutcome: e.target.value })}
                rows={3}
                style={inputStyle}
              />
            </label>
            <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" style={primaryBtn} disabled={proposalSubmitting}>
                {proposalSubmitting ? 'Generating...' : 'Generate proposals'}
              </button>
            </div>
          </form>

          {proposalError && <div role="alert" style={errorBanner}>{proposalError}</div>}

          {proposalLoading ? (
            <div style={empty}>Loading proposals...</div>
          ) : proposals.length === 0 ? (
            <div style={empty}>No pending proposals yet.</div>
          ) : (
            <TopScrollSync>
              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: '5%' }}>Sel</th>
                    <th style={{ ...th, width: '10%' }}>Year</th>
                    <th style={{ ...th, width: '10%' }}>Curriculum</th>
                    <th style={{ ...th, width: '8%' }}>Grade</th>
                    <th style={{ ...th, width: '10%' }}>Subject</th>
                    <th style={{ ...th, width: '18%' }}>Outcome</th>
                    <th style={{ ...th, width: '14%' }}>Destination</th>
                    <th style={{ ...th, width: '7%' }}>Fit</th>
                    <th style={{ ...th, width: '8%' }}>Conf.</th>
                    <th style={{ ...th, width: '10%' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.map((proposal) => (
                    <tr key={proposal.id} style={{ borderTop: '1px solid var(--border-light)' }}>
                      <td style={td}>
                        <input
                          type="checkbox"
                          checked={selectedProposalIds.includes(proposal.id)}
                          onChange={() => toggleProposalSelection(proposal.id)}
                        />
                      </td>
                      <td style={td}>{proposal.academicYear || <span style={{ color: 'var(--text-secondary)' }}>&mdash;</span>}</td>
                      <td style={td}>{proposal.curriculum}</td>
                      <td style={td}>{proposal.grade}</td>
                      <td style={td}>{proposal.subject}</td>
                      <td style={td} title={proposal.learningOutcome || ''}>{truncate(proposal.learningOutcome, 70)}</td>
                      <td style={td}>
                        {proposal.destinationLabel || (proposal.destinationId != null
                          ? `#${proposal.destinationId}`
                          : <span style={{ color: 'var(--text-secondary)' }}>&mdash;</span>)}
                      </td>
                      <td style={td}><FitScoreBadge score={proposal.fitScore} /></td>
                      <td style={td}>{proposal.confidenceScore == null ? <span style={{ color: 'var(--text-secondary)' }}>&mdash;</span> : `${proposal.confidenceScore}%`}</td>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button type="button" style={iconActionBtn} onClick={() => approveProposal(proposal.id)}>
                            Approve
                          </button>
                          <button
                            type="button"
                            style={{ ...iconActionBtn, color: '#A8323F', borderColor: 'rgba(168,50,63,0.4)' }}
                            onClick={() => rejectProposal(proposal.id)}
                          >
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TopScrollSync>
          )}
        </div>
      )}

      {loadError && (
        <div role="alert" style={errorBanner}>
          <AlertTriangle size={16} /> {loadError}
          <button onClick={() => load({ reset: true })} type="button" style={{ ...refreshBtn, marginLeft: 'auto' }}>
            Retry
          </button>
        </div>
      )}

      <div
        style={{
          background: 'var(--surface-color)',
          borderRadius: 8,
          border: '1px solid var(--border-color)',
          overflow: 'visible',
        }}
      >
        {loading && mappings.length === 0 ? (
          <div style={empty}>Loading&hellip;</div>
        ) : mappings.length === 0 ? (
          <div style={empty}>
            No curriculum mappings match the current filters. Add a mapping
            with &ldquo;New Mapping&rdquo; or clear the filters to widen the search.
          </div>
        ) : (
          <div
            ref={listRef}
            data-testid="curriculum-admin-table-scroll"
            onScroll={handleListScroll}
            style={{ maxHeight: '60vh', overflowY: 'auto', overflowX: 'hidden' }}
          >
          <TopScrollSync disabled>
          <table data-testid="curriculum-mapping-table" style={{ width: '100%', minWidth: '1480px', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr style={{ position: "sticky", top: 0, background: "#fff", zIndex: 10 }}>
                <th style={{ ...th, width: '8%' }}>Year</th>
                <th style={{ ...th, width: '10%' }}>Curriculum</th>
                <th style={{ ...th, width: '6%' }}>Grade</th>
                <th style={{ ...th, width: '8%' }}>Subject</th>
                <th style={{ ...th, width: '7%' }}>Code</th>
                <th style={{ ...th, width: '19%' }}>Learning outcome</th>
                <th style={{ ...th, width: '17%' }}>Destination</th>
                <th style={{ ...th, width: '5%' }}>Fit</th>
                <th style={{ ...th, width: '5%' }}>Conf.</th>
                <th style={{ ...th, width: '5%' }}>Active</th>
                {isAdmin && <th style={{ ...th, width: '15%' }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.id} style={{ borderTop: '1px solid var(--border-light)' }} data-testid={`curriculum-mapping-row-${m.id}`}>
                  <td style={td}>{m.academicYear || <span style={{ color: 'var(--text-secondary)' }}>&mdash;</span>}</td>
                  <td style={td}><strong>{m.curriculum}</strong></td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{m.grade}</td>
                  <td style={td}>{m.subject}</td>
                  <td style={td}>{m.learningOutcomeCode || <span style={{ color: 'var(--text-secondary)' }}>&mdash;</span>}</td>
                  <td style={td} title={m.learningOutcome || ''}>
                    {m.learningOutcome
                      ? truncate(m.learningOutcome, 80)
                      : <span style={{ color: 'var(--text-secondary)' }}>&mdash;</span>}
                  </td>
                  <td style={td}>
                    {m.destinationLabel || (m.destinationId != null
                      ? `#${m.destinationId}`
                      : <span style={{ color: 'var(--text-secondary)' }}>&mdash;</span>)}
                  </td>
                  <td style={td}><FitScoreBadge score={m.fitScore} /></td>
                  <td style={td}>{m.confidenceScore == null ? <span style={{ color: 'var(--text-secondary)' }}>&mdash;</span> : `${m.confidenceScore}%`}</td>
                  <td style={td}>
                    {m.isActive ? 'Yes' : <span style={{ color: 'var(--text-secondary)' }}>No</span>}
                  </td>
                  {isAdmin && (
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => openEdit(m)}
                          style={iconActionBtn}
                          aria-label={`Edit mapping ${m.id}`}
                          data-testid={`curriculum-mapping-edit-${m.id}`}
                        >
                          <Edit2 size={14} /> Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(m)}
                          style={{ ...iconActionBtn, color: '#A8323F', borderColor: 'rgba(168,50,63,0.4)' }}
                          aria-label={`Delete mapping ${m.id}`}
                          data-testid={`curriculum-mapping-delete-${m.id}`}
                        >
                          <Trash2 size={14} /> Delete
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </TopScrollSync>
          {loadingMore && (
            <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text-secondary)', borderTop: '1px solid var(--border-light)' }}>
              Loading more&hellip;
            </div>
          )}
          {!loadingMore && hasMore && <div data-testid="curriculum-admin-scroll-sentinel" style={{ height: 1 }} />}
          </div>
        )}
      </div>

      {modalOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <form
            onSubmit={submit}
            className="card"
            style={drawerStyle}
            aria-labelledby="curriculum-mapping-modal-title"
            noValidate
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 id="curriculum-mapping-modal-title" style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
                {editingId ? 'Edit Curriculum Mapping' : 'New Curriculum Mapping'}
              </h2>
              <button type="button" onClick={closeModal} aria-label="Close" style={iconBtn}>
                <X size={16} />
              </button>
            </div>

            {formError && !formError.field && (
              <div role="alert" style={errorBanner}>
                {formError.message}
                {formError.code && (
                  <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 11 }}>[{formError.code}]</span>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={fieldLabel}>
                Academic year
                <input
                  type="text"
                  value={form.academicYear}
                  onChange={(e) => setForm({ ...form, academicYear: e.target.value })}
                  placeholder="e.g. 2026-27"
                  style={inputStyle}
                />
              </label>

              <label style={fieldLabel}>
                Curriculum
                <input
                  type="text"
                  value={form.curriculum}
                  onChange={(e) => setForm({ ...form, curriculum: e.target.value })}
                  list="curriculum-form-suggestions"
                  placeholder="e.g. CBSE"
                  aria-invalid={formError?.field === 'curriculum' ? 'true' : undefined}
                  required
                  style={inputStyle}
                  data-testid="curriculum-form-curriculum"
                />
                <datalist id="curriculum-form-suggestions">
                  {CURRICULUM_SUGGESTIONS.map((c) => <option key={c} value={c} />)}
                </datalist>
                {formError?.field === 'curriculum' && (
                  <span style={fieldErrorText} role="alert">{formError.message}</span>
                )}
              </label>

              <label style={fieldLabel}>
                Grade
                <input
                  type="text"
                  value={form.grade}
                  onChange={(e) => setForm({ ...form, grade: e.target.value })}
                  placeholder="e.g. 9"
                  aria-invalid={formError?.field === 'grade' ? 'true' : undefined}
                  required
                  style={inputStyle}
                  data-testid="curriculum-form-grade"
                />
                {formError?.field === 'grade' && (
                  <span style={fieldErrorText} role="alert">{formError.message}</span>
                )}
              </label>

              <label style={fieldLabel}>
                Subject
                <input
                  type="text"
                  value={form.subject}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                  placeholder="e.g. History"
                  aria-invalid={formError?.field === 'subject' ? 'true' : undefined}
                  required
                  style={inputStyle}
                  data-testid="curriculum-form-subject"
                />
                {formError?.field === 'subject' && (
                  <span style={fieldErrorText} role="alert">{formError.message}</span>
                )}
              </label>

              <label style={fieldLabel}>
                Learning outcome code
                <input
                  type="text"
                  value={form.learningOutcomeCode}
                  onChange={(e) => setForm({ ...form, learningOutcomeCode: e.target.value })}
                  placeholder="e.g. CBSE-HIS-9-3"
                  style={inputStyle}
                />
              </label>

              <label style={fieldLabel}>
                Learning outcome
                <textarea
                  value={form.learningOutcome}
                  onChange={(e) => setForm({ ...form, learningOutcome: e.target.value })}
                  placeholder="e.g. Mughal architecture &mdash; field trip linkage to Agra/Delhi monuments"
                  rows={3}
                  maxLength={LEARNING_OUTCOME_MAX}
                  aria-invalid={formError?.field === 'learningOutcome' ? 'true' : undefined}
                  style={inputStyle}
                  data-testid="curriculum-form-learning-outcome"
                />
                <span style={fieldHintText}>
                  {form.learningOutcome.length}/{LEARNING_OUTCOME_MAX} characters
                </span>
                {formError?.field === 'learningOutcome' && (
                  <span style={fieldErrorText} role="alert">{formError.message}</span>
                )}
              </label>

              <label style={fieldLabel}>
                Destination label
                <input
                  type="text"
                  value={form.destinationLabel}
                  onChange={(e) => setForm({ ...form, destinationLabel: e.target.value })}
                  placeholder="e.g. Agra + Delhi heritage circuit"
                  style={inputStyle}
                  data-testid="curriculum-form-destination-label"
                />
                <span style={fieldHintText}>
                  Human-readable destination name surfaced in the advisor pitch deck.
                </span>
              </label>

              <label style={fieldLabel}>
                Destination id (optional)
                <input
                  type="number"
                  value={form.destinationId}
                  onChange={(e) => setForm({ ...form, destinationId: e.target.value })}
                  placeholder="e.g. 42"
                  aria-invalid={formError?.field === 'destinationId' ? 'true' : undefined}
                  style={inputStyle}
                  data-testid="curriculum-form-destination-id"
                />
                <span style={fieldHintText}>
                  Foreign key to TmcTrip when the mapping resolves to a curated trip
                  template; leave blank if not yet linked.
                </span>
                {formError?.field === 'destinationId' && (
                  <span style={fieldErrorText} role="alert">{formError.message}</span>
                )}
              </label>

              <label style={fieldLabel}>
                Fit score (1-100)
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={form.fitScore}
                  onChange={(e) => setForm({ ...form, fitScore: e.target.value === '' ? '' : Number(e.target.value) })}
                  aria-invalid={formError?.field === 'fitScore' ? 'true' : undefined}
                  required
                  style={inputStyle}
                  data-testid="curriculum-form-fit-score"
                />
                <span style={fieldHintText}>
                  Higher score &rarr; stronger alignment between curriculum/grade/subject
                  and destination. 80+ surfaces as &ldquo;strong fit&rdquo; in the pitch UI.
                </span>
                {formError?.field === 'fitScore' && (
                  <span style={fieldErrorText} role="alert">{formError.message}</span>
                )}
              </label>

              <label style={fieldLabel}>
                Confidence score (0-100)
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={form.confidenceScore}
                  onChange={(e) => setForm({ ...form, confidenceScore: e.target.value === '' ? '' : Number(e.target.value) })}
                  aria-invalid={formError?.field === 'confidenceScore' ? 'true' : undefined}
                  style={inputStyle}
                />
                {formError?.field === 'confidenceScore' && (
                  <span style={fieldErrorText} role="alert">{formError.message}</span>
                )}
              </label>

              <label style={fieldLabel}>
                Fit rationale
                <textarea
                  value={form.fitRationale}
                  onChange={(e) => setForm({ ...form, fitRationale: e.target.value })}
                  placeholder="Why this destination supports the learning outcome (free-text advisor talking points)"
                  rows={3}
                  style={inputStyle}
                  data-testid="curriculum-form-fit-rationale"
                />
              </label>

              <label style={{ ...fieldLabel, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  data-testid="curriculum-form-active"
                />
                Active (uncheck to soft-disable without deleting)
              </label>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <button type="button" onClick={closeModal} style={refreshBtn}>
                Cancel
              </button>
              <button type="submit" disabled={submitting} style={primaryBtn} data-testid="curriculum-form-submit">
                {submitting ? 'Saving…' : editingId ? 'Save changes' : 'Create mapping'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const selectStyle = {
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  minWidth: 140,
  fontSize: 13,
};

const inputStyle = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--input-bg, var(--surface-color))',
  color: 'var(--text-primary)',
  fontSize: 14,
};

const refreshBtn = {
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  fontSize: 13,
  cursor: 'pointer',
};

const primaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: 'var(--primary-color, var(--accent-color))',
  color: 'var(--accent-text, #fff)',
  border: '1px solid var(--primary-color, var(--accent-color))',
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

const iconBtn = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  padding: 4,
};

// Centred modal — mirrors the travel/Leads.jsx New Travel Lead pattern.
// `.card` (set on the form element) supplies border-radius, border, blur
// and lifted shadow; we force opaque `--bg-color` here so the panel
// doesn't read as glassmorphic over the page content behind it.
const drawerStyle = {
  background: 'var(--bg-color)',
  color: 'var(--text-primary)',
  width: '100%',
  maxWidth: 480,
  maxHeight: '90vh',
  overflowY: 'auto',
  padding: 24,
};

const fieldLabel = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: 'var(--text-secondary)',
  fontWeight: 500,
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
  marginBottom: 16,
};

const fieldErrorText = {
  color: '#A8323F',
  fontSize: 11,
  fontWeight: 500,
  marginTop: 2,
};

const fieldHintText = {
  color: 'var(--text-secondary)',
  fontSize: 11,
  marginTop: 2,
  fontStyle: 'italic',
};

const empty = {
  padding: 32,
  textAlign: 'center',
  color: 'var(--text-secondary)',
  fontSize: 14,
};

const th = {
  position: 'sticky',
  top: 0,
  zIndex: 10,
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border-color)',
  background: 'var(--bg-color)',
  backgroundClip: 'padding-box',
  boxShadow: 'inset 0 -1px 0 var(--border-color)',
};

const td = {
  padding: '10px 12px',
  fontSize: 14,
  color: 'var(--text-primary)',
  wordWrap: 'break-word',
  overflowWrap: 'break-word',
  whiteSpace: 'normal',
};
