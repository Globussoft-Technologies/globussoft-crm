import React, { useState, useEffect, useContext, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';
import { usePermissions } from '../hooks/usePermissions';
import { accessibleSubBrands, subBrandShortLabel } from '../utils/travelSubBrand';
import { useActiveSubBrand } from '../utils/subBrand';
import { CheckCircle2, Phone, Calendar, Search, Plus, AlertTriangle, Clock, Flame, X, ChevronDown, Eye, Edit3, Trash2, Save, UserRound } from 'lucide-react';
import TagPickerPopover from './wellness/patients/TagPickerPopover';
import { tagChipStyle, chipRemoveStyle, modalInputStyle, filterLabelStyle } from './wellness/patients/styles';
import { tagColour } from './wellness/patients/constants';

const PRIORITY_CONFIG = {
  Critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: '#ef4444', pulse: true },
  High:     { color: '#f97316', bg: 'rgba(249,115,22,0.08)', border: '#f97316', pulse: false },
  Medium:   { color: '#3b82f6', bg: 'rgba(59,130,246,0.08)', border: '#3b82f6', pulse: false },
  Low:      { color: '#64748b', bg: 'rgba(100,116,139,0.08)', border: '#475569', pulse: false },
};

// #296: backend (or a stale workflow) can hand us values like CRITICAL_OMG
// that aren't in the canonical enum. Map known cases case-insensitively, then
// fall back to "Other" so the UI never shows a screaming all-caps badge.
const PRIORITY_LABELS = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' };

function normalizePriority(raw) {
  if (!raw) return 'Medium';
  const upper = String(raw).toUpperCase();
  if (PRIORITY_LABELS[upper]) return PRIORITY_LABELS[upper];
  // Common backend variant, e.g. 'CRITICAL_OMG' → "Critical"
  for (const key of Object.keys(PRIORITY_LABELS)) {
    if (upper.startsWith(key)) return PRIORITY_LABELS[key];
  }
  return 'Other';
}

function PriorityBadge({ priority }) {
  const normalized = normalizePriority(priority);
  const cfg = PRIORITY_CONFIG[normalized] || PRIORITY_CONFIG.Medium;
  return (
    <span style={{
      padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}33`,
    }}>
      {normalized === 'Critical' && '🔴 '}
      {normalized === 'High' && '🟠 '}
      {normalized === 'Medium' && '🔵 '}
      {normalized === 'Low' && '⚪ '}
      {normalized}
    </span>
  );
}

function isOverdue(task) {
  return task.dueDate && task.status === 'Pending' && new Date(task.dueDate) < new Date();
}

// #608: warn when the user is creating a task with a due date that is already
// in the past. We don't block — some workflows legitimately back-fill a task
// to record it after the fact — but the form should make it loud so the user
// doesn't accidentally inflate the Overdue counter on the dashboard.
function isPastDate(localDateTimeStr) {
  if (!localDateTimeStr) return false;
  const picked = new Date(localDateTimeStr);
  if (Number.isNaN(picked.getTime())) return false;
  return picked.getTime() < Date.now();
}

function formatDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Tags + description are encoded together in the Task.notes field so the
// schema needs no migration. Format: JSON prefix sentinel + envelope.
// Falls back gracefully for old plain-text notes.
const NOTES_TAG = '__task_meta__';
function encodeNotes(tagIds, description, resolutionNote = '') {
  if ((!tagIds || tagIds.length === 0) && !resolutionNote) return description || null;
  return `${NOTES_TAG}${JSON.stringify({ t: tagIds || [], d: description || '', r: resolutionNote || '' })}`;
}
function decodeNotes(raw) {
  if (!raw) return { tagIds: [], description: '', resolutionNote: '' };
  if (!raw.startsWith(NOTES_TAG)) return { tagIds: [], description: raw, resolutionNote: '' };
  try {
    const { t, d, r } = JSON.parse(raw.slice(NOTES_TAG.length));
    return { tagIds: Array.isArray(t) ? t : [], description: d || '', resolutionNote: r || '' };
  } catch {
    return { tagIds: [], description: raw, resolutionNote: '' };
  }
}

// Activity kind + visit result. Both are optional — leaving Type blank keeps
// the pre-existing "plain task" behaviour. "Meeting" / "Site Visit" are what
// the Lead Reports meetings-and-visits and visited-but-not-booked reports read
// (see backend/lib/leadReportMetrics.js).
const TASK_TYPES = ['Task', 'Call', 'Meeting', 'Site Visit', 'Follow Up'];
// Allowlist for the `?type=` deep-link param — an unrecognised value falls
// back to a blank type rather than putting an unsaveable string in the form
// (the backend rejects anything outside ALLOWED_TASK_TYPES with a 400).
const ALLOWED_DEEPLINK_TYPES = TASK_TYPES;
const TASK_OUTCOMES = [
  { value: '', label: 'No outcome yet' },
  { value: 'booked', label: 'Booked' },
  { value: 'interested', label: 'Interested' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'reschedule', label: 'Reschedule' },
  { value: 'no_show', label: 'No show' },
];
const VISIT_TYPES = ['Meeting', 'Site Visit'];

// Queue filters. All client-side: GET /api/tasks already returns the tenant's
// queue in one payload, so filtering here is instant and costs no round-trip.
const EMPTY_FILTERS = {
  q: '',
  priority: '',
  type: '',
  assignee: '',
  due: '',
  overdueOnly: false,
};

const DUE_FILTERS = [
  { value: '', label: 'Any due date' },
  { value: 'today', label: 'Due today' },
  { value: 'week', label: 'Due in 7 days' },
  { value: 'nodate', label: 'No due date' },
];

const EMPTY_FORM = {
  title: '',
  status: 'Pending',
  priority: 'Medium',
  type: '',
  outcome: '',
  dueDate: '',
  completedAt: '',
  assignedToId: '',
  tagIds: [],
  description: '',
  resolutionNote: '',
};

export default function Tasks() {
  const notify = useNotify();
  const { hasPermission, isReady: permsReady } = usePermissions();
  const [tasks, setTasks] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [staff, setStaff] = useState([]);
  const [allTags, setAllTags] = useState([]);
  const [newTask, setNewTask] = useState(EMPTY_FORM);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const tagAnchorRef = useRef(null);

  // Travel vertical only: the "Assign to" dropdown lists STAFF (agents), scoped
  // to the active sub-brand so e.g. an RFU-only operator isn't offered TMC
  // agents. Generic / wellness tenants don't render the staff dropdown at all,
  // so their Tasks form is unchanged.
  const { tenant, user } = useContext(AuthContext) || {};
  const isTravel = tenant?.vertical === 'travel';
  const isWellness = tenant?.vertical === 'wellness';
  const role = String(user?.role || '').toUpperCase();
  const currentUserId = user?.userId || user?.id || null;
  const roleFallbackCanManage = ['ADMIN', 'MANAGER', 'OWNER'].includes(role);
  const canCreateTasks = roleFallbackCanManage || !permsReady || hasPermission('tasks', 'write');
  const canUpdateTasks = roleFallbackCanManage || !permsReady || hasPermission('tasks', 'update') || hasPermission('tasks', 'write');
  const canDeleteTasks = roleFallbackCanManage || (permsReady && hasPermission('tasks', 'delete'));
  const { activeSubBrand } = useActiveSubBrand();
  const assignableStaff = !isTravel
    ? staff
    : (activeSubBrand
        ? staff.filter((s) => accessibleSubBrands(s).includes(activeSubBrand))
        : staff);
  // #893: the Enqueue Activity form used to sit inline above the queue,
  // eating vertical real-estate and inviting accidental typing. Mirror the
  // c031ba0 pattern: header "+ Create Task" CTA opens this drawer; close on
  // X / ESC / outside-click; submit handler is preserved verbatim.
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [creating, setCreating] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);
  const [editingTask, setEditingTask] = useState(false);
  const [editTask, setEditTask] = useState(EMPTY_FORM);

  useEffect(() => { loadData(); }, []);

  // Deep link: `/tasks?create=1&type=Site%20Visit` opens the create drawer with
  // the type pre-selected. The Lead Reports "Meetings & Visits" report links
  // here — that report reads Tasks, so without an entry point it dead-ends on
  // an empty state with no way to add the thing it is reporting on.
  // The params are stripped once consumed so a refresh (or a back-nav) doesn't
  // silently re-open the drawer over whatever the user is doing.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('create') !== '1') return;
    const requestedType = searchParams.get('type') || '';
    setNewTask((prev) => ({
      ...prev,
      type: ALLOWED_DEEPLINK_TYPES.includes(requestedType) ? requestedType : '',
    }));
    setCreating(true);
    const next = new URLSearchParams(searchParams);
    next.delete('create');
    next.delete('type');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Load tenant tags from the wellness patients/tags endpoint so the tag
  // picker in the Add Todo modal reuses the same tag set as patients.
  useEffect(() => {
    if (!isWellness) return;
    // GET /patients/tags returns { tags: [...] }
    fetchApi('/api/wellness/patients/tags')
      .then((d) => setAllTags(Array.isArray(d?.tags) ? d.tags : []))
      .catch(() => {});
  }, [isWellness]);

  // Travel + wellness: load the staff roster for the "Assign to" dropdown.
  // Wellness tasks also persist assignees in Task.userId, so feeding the
  // picker with contacts writes the wrong FK and can 500 on save.
  // Fail-soft (own catch) so a staff-list permission error never blocks the
  // task queue; generic tenants keep the historical contacts-based picker.
  useEffect(() => {
    if (!isTravel && !isWellness) return;
    fetchApi('/api/staff')
      .then((d) => setStaff(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [isTravel, isWellness]);

  // #893: ESC closes the drawer to match the c031ba0 Travel-page convention.
  useEffect(() => {
    if (!creating && !selectedTask) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (creating) { setCreating(false); setShowTagPicker(false); }
      if (selectedTask) { setSelectedTask(null); setEditingTask(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creating, selectedTask]);

  const loadData = async () => {
    try {
      const [t, c] = await Promise.all([
        fetchApi('/api/tasks'),
        fetchApi('/api/contacts'),
      ]);
      setTasks(Array.isArray(t) ? t : []);
      setContacts(Array.isArray(c) ? c : []);
    } catch (err) {
      console.error(err);
    }
  };

  const openCreate = () => {
    setNewTask(EMPTY_FORM);
    setShowTagPicker(false);
    setCreating(true);
  };

  const closeCreate = () => {
    setCreating(false);
    setShowTagPicker(false);
  };

  const createTask = async (e) => {
    e.preventDefault();
    try {
      // #313: <input type="datetime-local"> returns a wall-clock string
      // ("2026-05-20T15:30") with no timezone. Sending it bare to the server
      // makes Node `new Date(...)` interpret it as UTC, and the IST display
      // path then adds +5:30, breaking the round-trip. Convert via the
      // browser's local Date so the saved value is a real ISO timestamp.
      const payload = {
        title: newTask.title,
        status: newTask.status,
        priority: newTask.priority,
        // Optional — omitted entirely when blank so the POST body matches the
        // pre-existing shape for anyone who doesn't use the new fields.
        type: newTask.type || undefined,
        outcome: newTask.outcome || undefined,
        dueDate: newTask.dueDate ? new Date(newTask.dueDate).toISOString() : null,
        // Tags + description are packed into the notes field using a sentinel
        // prefix so no schema migration is needed.
        notes: encodeNotes(newTask.tagIds, newTask.description, newTask.resolutionNote),
        contactId: newTask.contactId || undefined,
        // Backend reads `targetUserId` → Task.userId (stripDangerous deletes a
        // raw `userId` from the body). Only send when an assignee was picked.
        targetUserId: newTask.assignedToId || undefined,
      };
      await fetchApi('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
      setNewTask(EMPTY_FORM);
      setCreating(false);
      setShowTagPicker(false);
      loadData();
      // #625: invalidate sidebar counters so the My Tasks badge bumps.
      window.dispatchEvent(new CustomEvent('sidebar:counts-changed'));
    } catch (err) {
      notify.error('Failed to create task');
    }
  };

  const markComplete = async (taskOrId) => {
    const task = typeof taskOrId === 'object' ? taskOrId : tasks.find((t) => t.id === taskOrId) || selectedTask;
    const id = typeof taskOrId === 'object' ? taskOrId.id : taskOrId;
    const decoded = decodeNotes(task?.notes || '');
    const resolutionNote = await notify.prompt({
      title: 'Resolve task',
      message: 'Add a short resolution note before marking this task complete.',
      defaultValue: decoded.resolutionNote || '',
      placeholder: 'What was done / outcome?',
      confirmText: 'Resolve',
    });
    if (resolutionNote === null) return;
    try {
      const notes = encodeNotes(decoded.tagIds, decoded.description, String(resolutionNote || '').trim());
      const updated = await fetchApi(`/api/tasks/${id}/complete`, {
        method: 'PUT',
        body: JSON.stringify({ notes }),
      });
      if (selectedTask?.id === id) {
        setSelectedTask(updated || { ...selectedTask, status: 'Completed', notes });
      }
      await loadData();
      window.dispatchEvent(new CustomEvent('sidebar:counts-changed'));
      notify.success('Task resolved');
    } catch (err) {
      console.error(err);
      notify.error('Failed to resolve task');
    }
  };

  const handleTagPick = (tag) => {
    if (newTask.tagIds.includes(tag.id)) return;
    setNewTask((prev) => ({ ...prev, tagIds: [...prev.tagIds, tag.id] }));
    setShowTagPicker(false);
  };

  const handleTagCreate = async (name) => {
    try {
      // POST /patients/tags returns { tag: {id,name,color}, created: bool }
      const res = await fetchApi('/api/wellness/patients/tags', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (res?.tag) {
        setAllTags((prev) => {
          if (prev.find((t) => t.id === res.tag.id)) return prev;
          return [...prev, res.tag];
        });
        setNewTask((prev) => ({
          ...prev,
          tagIds: prev.tagIds.includes(res.tag.id)
            ? prev.tagIds
            : [...prev.tagIds, res.tag.id],
        }));
      }
    } catch {
      notify.error('Failed to create tag');
    }
    setShowTagPicker(false);
  };

  const removeTag = (tagId) => {
    setNewTask((prev) => ({ ...prev, tagIds: prev.tagIds.filter((id) => id !== tagId) }));
  };

  const assigneeName = (task) => task?.user?.name || task?.user?.email || 'Unassigned';
  const canResolveTask = (task) => canUpdateTasks || (task?.userId && Number(task.userId) === Number(currentUserId));

  const openTaskDetails = (task) => {
    const decoded = decodeNotes(task.notes);
    setSelectedTask(task);
    setEditingTask(false);
    setEditTask({
      title: task.title || '',
      status: task.status || 'Pending',
      priority: normalizePriority(task.priority),
      type: task.type || '',
      outcome: task.outcome || '',
      dueDate: formatDateTimeLocal(task.dueDate),
      completedAt: '',
      assignedToId: task.userId ? String(task.userId) : '',
      tagIds: decoded.tagIds,
      description: decoded.description,
      resolutionNote: decoded.resolutionNote,
    });
  };

  const closeTaskDetails = () => {
    setSelectedTask(null);
    setEditingTask(false);
  };

  const saveTaskChanges = async () => {
    if (!selectedTask) return;
    try {
      const payload = {
        title: editTask.title,
        status: editTask.status,
        priority: editTask.priority,
        // Sent as null (not undefined) so clearing the field on an existing
        // task actually clears the stored column.
        type: editTask.type || null,
        outcome: editTask.outcome || null,
        dueDate: editTask.dueDate ? new Date(editTask.dueDate).toISOString() : null,
        notes: encodeNotes(editTask.tagIds, editTask.description, editTask.resolutionNote),
        targetUserId: editTask.assignedToId || '',
      };
      const updated = await fetchApi(`/api/tasks/${selectedTask.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setSelectedTask(updated);
      setEditingTask(false);
      await loadData();
      window.dispatchEvent(new CustomEvent('sidebar:counts-changed'));
      notify.success('Task updated');
    } catch (err) {
      console.error(err);
      notify.error('Failed to update task');
    }
  };

  const deleteTask = async () => {
    if (!selectedTask) return;
    const ok = await notify.confirm({
      title: 'Delete task?',
      message: `Delete "${selectedTask.title}" from the queue?`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/tasks/${selectedTask.id}`, { method: 'DELETE' });
      closeTaskDetails();
      await loadData();
      window.dispatchEvent(new CustomEvent('sidebar:counts-changed'));
      notify.success('Task deleted');
    } catch (err) {
      console.error(err);
      notify.error('Failed to delete task');
    }
  };

  const selectedTags = allTags.filter((t) => newTask.tagIds.includes(t.id));

  const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  // Unfiltered splits. The counter chips read from these so they always show
  // the true queue size — a chip that shrank to match its own filter would
  // make it impossible to tell what clearing the filter would bring back.
  const allActiveTasks = tasks
    .filter(t => t.status !== 'Completed')
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99));
  const allCompletedTasks = tasks.filter(t => t.status === 'Completed');

  const criticalCount = allActiveTasks.filter(t => normalizePriority(t.priority) === 'Critical').length;
  const highCount = allActiveTasks.filter(t => normalizePriority(t.priority) === 'High').length;
  const overdueCount = allActiveTasks.filter(isOverdue).length;

  // ── Filtering ──────────────────────────────────────────────────────
  const matchesFilters = (t) => {
    if (filters.priority && normalizePriority(t.priority) !== filters.priority) return false;
    if (filters.overdueOnly && !isOverdue(t)) return false;

    if (filters.type) {
      const type = t.type || '';
      // `__none` finds the legacy rows written before Type existed — the ones
      // the visit reports can only match on their title.
      if (filters.type === '__none' ? Boolean(type) : type !== filters.type) return false;
    }

    if (filters.assignee) {
      const uid = t.userId ? String(t.userId) : 'unassigned';
      if (uid !== filters.assignee) return false;
    }

    if (filters.due) {
      if (filters.due === 'nodate') {
        if (t.dueDate) return false;
      } else {
        if (!t.dueDate) return false;
        const due = new Date(t.dueDate);
        if (Number.isNaN(due.getTime())) return false;
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const endOfToday = new Date(startOfToday.getTime() + 86_400_000 - 1);
        if (filters.due === 'today' && (due < startOfToday || due > endOfToday)) return false;
        if (filters.due === 'week' && (due < startOfToday || due > new Date(startOfToday.getTime() + 7 * 86_400_000))) return false;
      }
    }

    if (filters.q) {
      const needle = filters.q.trim().toLowerCase();
      const decoded = decodeNotes(t.notes);
      const haystack = [
        t.title,
        decoded.description,
        decoded.resolutionNote,
        t.contact?.name,
        t.contact?.email,
        t.user?.name,
        t.type,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    return true;
  };

  const activeTasks = allActiveTasks.filter(matchesFilters);
  const completedTasks = allCompletedTasks.filter(matchesFilters);

  const filtersActive = Boolean(
    filters.q || filters.priority || filters.type || filters.assignee || filters.due || filters.overdueOnly,
  );
  const clearFilters = () => setFilters(EMPTY_FILTERS);
  const togglePriority = (p) =>
    setFilters((f) => ({ ...f, priority: f.priority === p ? '' : p }));
  const toggleOverdue = () => setFilters((f) => ({ ...f, overdueOnly: !f.overdueOnly }));

  // Assignee options come from the queue itself rather than /api/staff — that
  // endpoint is only loaded for the travel vertical, and deriving them here
  // guarantees every option actually matches at least one row.
  const assigneeOptions = Array.from(
    tasks.reduce((map, t) => {
      const id = t.userId ? String(t.userId) : 'unassigned';
      if (!map.has(id)) {
        map.set(id, t.user?.name || t.user?.email || (t.userId ? `User #${t.userId}` : 'Unassigned'));
      }
      return map;
    }, new Map()),
  ).sort((a, b) => String(a[1]).localeCompare(String(b[1])));

  // Priority color for the priority select dropdown value
  const priorityColor = {
    Critical: '#ef4444',
    High: '#f97316',
    Medium: '#3b82f6',
    Low: '#64748b',
  }[newTask.priority] || '#3b82f6';

  return (
    <div className="tasks-page" style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Flame size={26} color="var(--accent-color)" /> Agent Task Queue
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Prioritized daily follow-ups and outbound activity directives.
          </p>
        </div>
        {canCreateTasks && (
        <button
          id="open-create-task-btn"
          type="button"
          onClick={openCreate}
          aria-label="Create a new task"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '0.65rem 1.1rem', borderRadius: 6, fontWeight: 600, fontSize: '0.875rem',
            background: 'var(--primary-color, var(--accent-color))',
            color: 'var(--accent-text, #fff)',
            border: '1px solid var(--primary-color, var(--accent-color))',
            cursor: 'pointer',
          }}
        >
          <Plus size={14} /> Create Task
        </button>
        )}
      </header>

      {/* Counter chips double as one-click filters — the number you want to act
          on is the thing you click. Counts stay unfiltered so the chips always
          describe the whole queue, not the slice currently on screen. */}
      {allActiveTasks.length > 0 && (
        <div className="tasks-chips" role="group" aria-label="Filter the queue">
          {criticalCount > 0 && (
            <button
              type="button"
              className={`tasks-chip tasks-chip--critical${filters.priority === 'Critical' ? ' is-active' : ''}`}
              aria-pressed={filters.priority === 'Critical'}
              onClick={() => togglePriority('Critical')}
            >
              🔴 {criticalCount} Critical
            </button>
          )}
          {highCount > 0 && (
            <button
              type="button"
              className={`tasks-chip tasks-chip--high${filters.priority === 'High' ? ' is-active' : ''}`}
              aria-pressed={filters.priority === 'High'}
              onClick={() => togglePriority('High')}
            >
              🟠 {highCount} High
            </button>
          )}
          {overdueCount > 0 && (
            <button
              type="button"
              className={`tasks-chip tasks-chip--overdue${filters.overdueOnly ? ' is-active' : ''}`}
              aria-pressed={filters.overdueOnly}
              onClick={toggleOverdue}
            >
              <AlertTriangle size={12} /> {overdueCount} Overdue
            </button>
          )}
          <button
            type="button"
            className={`tasks-chip${!filtersActive ? ' is-active' : ''}`}
            aria-pressed={!filtersActive}
            onClick={clearFilters}
          >
            {allActiveTasks.length} total pending
          </button>
        </div>
      )}

      {/* Filter bar */}
      {tasks.length > 0 && (
        <div className="tasks-filterbar">
          <label className="tasks-filterbar__search">
            <Search size={14} />
            <input
              type="search"
              aria-label="Search tasks"
              placeholder="Search title, notes, client…"
              value={filters.q}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            />
          </label>

          <select
            aria-label="Filter by priority"
            className="input-field"
            value={filters.priority}
            onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}
          >
            <option value="">Any priority</option>
            <option value="Critical">Critical</option>
            <option value="High">High</option>
            <option value="Medium">Medium</option>
            <option value="Low">Low</option>
          </select>

          <select
            aria-label="Filter by type"
            className="input-field"
            value={filters.type}
            onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
          >
            <option value="">Any type</option>
            {TASK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            <option value="__none">No type set</option>
          </select>

          <select
            aria-label="Filter by due date"
            className="input-field"
            value={filters.due}
            onChange={(e) => setFilters((f) => ({ ...f, due: e.target.value }))}
          >
            {DUE_FILTERS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>

          {assigneeOptions.length > 1 && (
            <select
              aria-label="Filter by assignee"
              className="input-field"
              value={filters.assignee}
              onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}
            >
              <option value="">Anyone</option>
              {assigneeOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}

          {filtersActive && (
            <>
              <span className="tasks-filterbar__count">
                {activeTasks.length} of {allActiveTasks.length} shown
              </span>
              <button type="button" className="tasks-filterbar__clear" onClick={clearFilters}>
                <X size={13} /> Clear
              </button>
            </>
          )}
        </div>
      )}

      {/* #893: Queue + Completed are now the full width. The Enqueue Activity
         form lives in the drawer below, opened by the header CTA. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>

        {/* Active Queue */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Phone size={20} color="var(--danger-color)" /> Active Priority Queue
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {activeTasks.length === 0 ? (
              // "Nothing matched" and "nothing to do" are different states —
              // showing "Excellent work" over a filter that hid everything is a
              // lie the user then has to debug.
              allActiveTasks.length > 0 ? (
                <p id="empty-filtered-msg" style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
                  No tasks match these filters.{' '}
                  <button type="button" className="tasks-filterbar__clear" onClick={clearFilters}>
                    <X size={13} /> Clear filters
                  </button>
                </p>
              ) : (
                <p id="empty-queue-msg" style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
                  Queue is empty. Excellent work.
                </p>
              )
            ) : activeTasks.map(t => {
              const cfg = PRIORITY_CONFIG[t.priority] || PRIORITY_CONFIG.Medium;
              const overdue = isOverdue(t);
              const decoded = decodeNotes(t.notes);
              return (
                <div key={t.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '1.25rem', background: cfg.bg,
                  borderLeft: `4px solid ${cfg.border}`, borderRadius: '0 8px 8px 0',
                  transition: '0.2s', position: 'relative',
                  boxShadow: t.priority === 'Critical' ? `0 0 12px ${cfg.color}22` : 'none',
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem', flexWrap: 'wrap' }}>
                      <h4 style={{ fontWeight: '600', fontSize: '1rem', margin: 0 }}>{t.title}</h4>
                      <PriorityBadge priority={t.priority} />
                      {overdue && (
                        <span style={{ padding: '0.15rem 0.5rem', borderRadius: '4px', fontSize: '0.7rem', fontWeight: 'bold', background: 'rgba(239,68,68,0.15)', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <AlertTriangle size={10} /> OVERDUE
                        </span>
                      )}
                    </div>
                    {t.contact && (
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem', margin: '0 0 0.2rem' }}>
                        <Search size={12} /> {t.contact.name} • {t.contact.email}
                      </p>
                    )}
                    {t.dueDate && (
                      <p style={{ fontSize: '0.8rem', color: overdue ? '#ef4444' : 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
                        <Clock size={12} /> {new Date(t.dueDate).toLocaleString()}
                      </p>
                    )}
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem', margin: '0.2rem 0 0' }}>
                      <UserRound size={12} /> Assigned to {assigneeName(t)}
                    </p>
                    {decoded.description && (
                      <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: '0.45rem 0 0', maxWidth: 760, lineHeight: 1.45 }}>
                        {decoded.description.length > 170 ? `${decoded.description.slice(0, 170).trimEnd()}...` : decoded.description}
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', marginLeft: '1rem', flexShrink: 0 }}>
                    <button
                      onClick={() => openTaskDetails(t)}
                      className="btn-secondary"
                      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 0.9rem', fontSize: '0.8rem', position: 'relative', zIndex: 10, pointerEvents: 'all' }}
                    >
                      <Eye size={14} /> Details
                    </button>
                    {canResolveTask(t) && (
                    <button
                      onClick={() => markComplete(t)}
                      className="btn-secondary"
                      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'var(--success-color)', color: '#fff', border: 'none', padding: '0.5rem 0.9rem', fontSize: '0.8rem', position: 'relative', zIndex: 10, pointerEvents: 'all' }}
                    >
                      <CheckCircle2 size={14} /> Resolve
                    </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Completed Log */}
        <div className="card" style={{ padding: '2rem', opacity: 0.75 }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <CheckCircle2 size={20} color="var(--success-color)" /> Completed Log
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {completedTasks.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>No completed tasks yet.</p>
            ) : completedTasks.slice(0, 8).map(t => {
              const decoded = decodeNotes(t.notes);
              return (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', padding: '0.65rem 1rem', background: 'rgba(255,255,255,0.01)', borderRadius: '4px' }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ textDecoration: 'line-through', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{t.title}</span>
                  {decoded.resolutionNote && (
                    <p style={{ margin: '0.25rem 0 0', color: 'var(--text-secondary)', fontSize: '0.78rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 720 }}>
                      Note: {decoded.resolutionNote}
                    </p>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--success-color)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <CheckCircle2 size={10} /> Resolved
                  </span>
                  <button type="button" onClick={() => openTaskDetails(t)} className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0.35rem 0.65rem', fontSize: '0.75rem' }}>
                    <Eye size={12} /> Details
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        </div>

      </div>


      {selectedTask && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeTaskDetails(); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.62)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Task details"
            style={{
              background: 'var(--bg-color, #f5f0e8)',
              color: 'var(--text-primary)',
              width: '100%',
              maxWidth: 620,
              maxHeight: '92vh',
              overflowY: 'auto',
              padding: '1.5rem',
              borderRadius: 16,
              boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
              <div style={{ flex: 1 }}>
                <p style={{ margin: '0 0 0.25rem', color: 'var(--text-secondary)', fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Task details</p>
                {editingTask ? (
                  <input
                    value={editTask.title}
                    onChange={(e) => setEditTask({ ...editTask, title: e.target.value })}
                    style={{ ...modalInputStyle, fontSize: '1.05rem', fontWeight: 700 }}
                  />
                ) : (
                  <h2 style={{ margin: 0, fontSize: '1.25rem' }}>{selectedTask.title}</h2>
                )}
              </div>
              <button
                type="button"
                onClick={closeTaskDetails}
                aria-label="Close"
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', borderRadius: 6 }}
              >
                <X size={18} />
              </button>
            </div>

            {editingTask ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                    Status
                    <select value={editTask.status} onChange={(e) => setEditTask({ ...editTask, status: e.target.value })} style={modalInputStyle}>
                      <option value="Pending">Pending</option>
                      <option value="In Progress">In Progress</option>
                      <option value="Completed">Completed</option>
                      <option value="Cancelled">Cancelled</option>
                    </select>
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                    Priority
                    <select value={editTask.priority} onChange={(e) => setEditTask({ ...editTask, priority: e.target.value })} style={modalInputStyle}>
                      <option value="Critical">Critical</option>
                      <option value="High">High</option>
                      <option value="Medium">Medium</option>
                      <option value="Low">Low</option>
                    </select>
                  </label>
                </div>
                {/* Type + Outcome — Outcome stays disabled until the task is a
                    Meeting / Site Visit, matching the create form. Logging the
                    outcome here is what moves a client off the Lead Reports
                    "visited but did not book" recovery queue. */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                    Type
                    <select value={editTask.type} onChange={(e) => setEditTask({ ...editTask, type: e.target.value })} style={modalInputStyle}>
                      <option value="">General task</option>
                      {TASK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                    Outcome
                    <select
                      value={editTask.outcome}
                      disabled={!VISIT_TYPES.includes(editTask.type)}
                      onChange={(e) => setEditTask({ ...editTask, outcome: e.target.value })}
                      style={modalInputStyle}
                    >
                      {TASK_OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: isTravel ? '1fr 1fr' : '1fr', gap: '0.75rem' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                    Due date
                    <input type="datetime-local" value={editTask.dueDate} onChange={(e) => setEditTask({ ...editTask, dueDate: e.target.value })} style={modalInputStyle} />
                  </label>
                  {isTravel && (
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                      Reassign to
                      <select value={editTask.assignedToId} onChange={(e) => setEditTask({ ...editTask, assignedToId: e.target.value })} style={modalInputStyle}>
                        <option value="">Unassigned</option>
                        {assignableStaff.map((s) => {
                          const brands = accessibleSubBrands(s);
                          const scope = brands.length && brands.length < 4 ? ` (${brands.map(subBrandShortLabel).join('/')})` : '';
                          return <option key={s.id} value={s.id}>{s.name}{scope}</option>;
                        })}
                      </select>
                    </label>
                  )}
                </div>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                  Description
                  <textarea
                    rows="7"
                    value={editTask.description}
                    onChange={(e) => setEditTask({ ...editTask, description: e.target.value })}
                    style={{ ...modalInputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                  Resolution note
                  <textarea
                    rows="4"
                    value={editTask.resolutionNote}
                    onChange={(e) => setEditTask({ ...editTask, resolutionNote: e.target.value })}
                    placeholder="Visible after the task is resolved"
                    style={{ ...modalInputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }}
                  />
                </label>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                  <PriorityBadge priority={selectedTask.priority} />
                  <span style={{ padding: '0.2rem 0.6rem', borderRadius: 999, fontSize: '0.72rem', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>{selectedTask.status}</span>
                  <span style={{ padding: '0.2rem 0.6rem', borderRadius: 999, fontSize: '0.72rem', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <UserRound size={12} /> {assigneeName(selectedTask)}
                  </span>
                </div>
                {selectedTask.dueDate && (
                  <p style={{ margin: 0, color: isOverdue(selectedTask) ? '#ef4444' : 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                    <Clock size={14} /> {new Date(selectedTask.dueDate).toLocaleString()}
                  </p>
                )}
                {selectedTask.contact && (
                  <p style={{ margin: 0, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                    <Search size={14} /> {selectedTask.contact.name}{selectedTask.contact.email ? ` - ${selectedTask.contact.email}` : ''}
                  </p>
                )}
                <section style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                  <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>Description</h3>
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.55, color: 'var(--text-secondary)' }}>
                    {decodeNotes(selectedTask.notes).description || 'No description added.'}
                  </p>
                </section>
                {decodeNotes(selectedTask.notes).resolutionNote && (
                  <section style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                    <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>Resolution note</h3>
                    <p style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.55, color: 'var(--text-secondary)' }}>
                      {decodeNotes(selectedTask.notes).resolutionNote}
                    </p>
                  </section>
                )}
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', paddingTop: '0.25rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {canDeleteTasks && (
                  <button type="button" onClick={deleteTask} className="btn-secondary" style={{ color: '#ef4444', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Trash2 size={14} /> Delete
                  </button>
                )}
                {canResolveTask(selectedTask) && selectedTask.status !== 'Completed' && !editingTask && (
                  <button type="button" onClick={() => markComplete(selectedTask)} className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <CheckCircle2 size={14} /> Resolve
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {editingTask ? (
                  <>
                    <button type="button" onClick={() => setEditingTask(false)} className="btn-secondary">Cancel</button>
                    <button type="button" onClick={saveTaskChanges} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Save size={14} /> Save
                    </button>
                  </>
                ) : canUpdateTasks ? (
                  <button type="button" onClick={() => setEditingTask(true)} className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Edit3 size={14} /> Edit
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Todo modal — matches the reference design */}
      {creating && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeCreate(); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
        >
          <form
            onSubmit={createTask}
            style={{
              background: 'var(--bg-color, #f5f0e8)',
              color: 'var(--text-primary)',
              width: '100%',
              maxWidth: 500,
              maxHeight: '92vh',
              overflowY: 'auto',
              padding: '1.5rem',
              borderRadius: 16,
              boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>Add Todo</h2>
              <button
                type="button"
                onClick={closeCreate}
                aria-label="Close"
                style={{
                  background: 'transparent', border: 'none', color: 'var(--text-secondary)',
                  cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', borderRadius: 6,
                }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Task Name */}
            <input
              id="task-title-input"
              type="text"
              required
              placeholder="Task Name"
              value={newTask.title}
              onChange={e => setNewTask({ ...newTask, title: e.target.value })}
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '0.65rem 0.9rem', fontSize: '0.95rem', fontWeight: 500,
                background: 'var(--surface-color, #fff)',
                border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
                borderRadius: 8, color: 'var(--text-primary)', outline: 'none',
              }}
            />

            {/* Status + Priority — two equal columns, label left of select */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              {/* Status */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, color: 'var(--text-secondary)' }}>
                  <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="3" />
                </svg>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', flexShrink: 0, whiteSpace: 'nowrap' }}>Status:</span>
                <select
                  id="task-status-select"
                  value={newTask.status}
                  onChange={e => setNewTask({ ...newTask, status: e.target.value })}
                  style={{
                    flex: 1, minWidth: 0, padding: '0.38rem 0.5rem',
                    fontSize: '0.82rem', fontWeight: 600, borderRadius: 7,
                    background: newTask.status === 'Pending'
                      ? 'var(--text-primary, #1a1a2e)'
                      : newTask.status === 'Completed'
                        ? 'rgba(34,197,94,0.12)'
                        : 'rgba(59,130,246,0.12)',
                    color: newTask.status === 'Pending'
                      ? 'var(--bg-color, #fff)'
                      : newTask.status === 'Completed'
                        ? '#16a34a'
                        : '#2563eb',
                    border: '1px solid var(--border-color, rgba(0,0,0,0.15))',
                    outline: 'none', cursor: 'pointer',
                  }}
                >
                  <option value="Pending">Pending</option>
                  <option value="Completed">Completed</option>
                  <option value="In Progress">In Progress</option>
                </select>
              </div>

              {/* Priority */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, color: 'var(--text-secondary)' }}>
                  <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
                </svg>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', flexShrink: 0, whiteSpace: 'nowrap' }}>Priority:</span>
                <select
                  id="task-priority-select"
                  value={newTask.priority}
                  onChange={e => setNewTask({ ...newTask, priority: e.target.value })}
                  style={{
                    flex: 1, minWidth: 0, padding: '0.38rem 0.5rem',
                    fontSize: '0.82rem', fontWeight: 600, borderRadius: 7,
                    background: 'transparent',
                    color: priorityColor,
                    border: `1px solid ${priorityColor}66`,
                    outline: 'none', cursor: 'pointer',
                  }}
                >
                  <option value="">Select Priority</option>
                  <option value="Critical">Critical</option>
                  <option value="High">High</option>
                  <option value="Medium">Medium</option>
                  <option value="Low">Low</option>
                </select>
              </div>
            </div>

            {/* Type + Outcome. Type is what promotes a task into the Lead
                Reports meetings-and-site-visits queue; Outcome is only offered
                once the task is a Meeting / Site Visit, since it means nothing
                on a plain to-do. Both optional — blank keeps the old shape. */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', flexShrink: 0, whiteSpace: 'nowrap' }}>Type:</span>
                <select
                  id="task-type-select"
                  aria-label="Task type"
                  value={newTask.type}
                  onChange={e => setNewTask({ ...newTask, type: e.target.value })}
                  style={{
                    flex: 1, minWidth: 0, padding: '0.38rem 0.5rem', fontSize: '0.82rem',
                    borderRadius: 7, background: 'transparent', color: 'var(--text-primary)',
                    border: '1px solid var(--border-color, rgba(0,0,0,0.15))', outline: 'none', cursor: 'pointer',
                  }}
                >
                  <option value="">General task</option>
                  {TASK_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', flexShrink: 0, whiteSpace: 'nowrap' }}>Outcome:</span>
                <select
                  id="task-outcome-select"
                  aria-label="Visit outcome"
                  value={newTask.outcome}
                  disabled={!VISIT_TYPES.includes(newTask.type)}
                  onChange={e => setNewTask({ ...newTask, outcome: e.target.value })}
                  style={{
                    flex: 1, minWidth: 0, padding: '0.38rem 0.5rem', fontSize: '0.82rem',
                    borderRadius: 7, background: 'transparent',
                    color: VISIT_TYPES.includes(newTask.type) ? 'var(--text-primary)' : 'var(--text-secondary)',
                    border: '1px solid var(--border-color, rgba(0,0,0,0.15))', outline: 'none',
                    cursor: VISIT_TYPES.includes(newTask.type) ? 'pointer' : 'not-allowed',
                  }}
                >
                  {TASK_OUTCOMES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>

            {/* Due At + Completed At — stacked label above input, two columns */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              {/* Due At */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', minWidth: 0 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                  <Calendar size={12} style={{ flexShrink: 0 }} />
                  Due At:
                </label>
                <input
                  type="datetime-local"
                  value={newTask.dueDate}
                  onChange={e => setNewTask({ ...newTask, dueDate: e.target.value })}
                  aria-describedby={isPastDate(newTask.dueDate) ? 'task-duedate-warning' : undefined}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    padding: '0.42rem 0.6rem', fontSize: '0.8rem',
                    border: isPastDate(newTask.dueDate)
                      ? '1px solid #f59e0b'
                      : '1px solid var(--border-color, rgba(0,0,0,0.15))',
                    borderRadius: 7,
                    background: 'var(--surface-color, #fff)',
                    color: 'var(--text-primary)',
                    outline: 'none',
                  }}
                />
              </div>

              {/* Completed At */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', minWidth: 0 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                  <Calendar size={12} style={{ flexShrink: 0 }} />
                  Completed At:
                </label>
                <input
                  type="datetime-local"
                  value={newTask.completedAt}
                  onChange={e => setNewTask({ ...newTask, completedAt: e.target.value })}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    padding: '0.42rem 0.6rem', fontSize: '0.8rem',
                    border: '1px solid var(--border-color, rgba(0,0,0,0.15))',
                    borderRadius: 7,
                    background: 'var(--surface-color, #fff)',
                    color: 'var(--text-primary)',
                    outline: 'none',
                  }}
                />
              </div>
            </div>

            {isPastDate(newTask.dueDate) && (
              <p
                id="task-duedate-warning"
                data-testid="task-past-date-warning"
                style={{ margin: '-0.25rem 0 0', fontSize: '0.75rem', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
              >
                <AlertTriangle size={12} /> This task will be created already overdue.
              </p>
            )}

            {/* Assignees — label + full-width select */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                </svg>
                Assignees:
              </label>
              <select
                value={newTask.assignedToId}
                onChange={e => setNewTask({ ...newTask, assignedToId: e.target.value })}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '0.5rem 0.75rem', fontSize: '0.875rem',
                  border: '1px solid var(--border-color, rgba(0,0,0,0.15))',
                  borderRadius: 8,
                  background: 'var(--surface-color, #fff)',
                  color: 'var(--text-primary)',
                  outline: 'none', cursor: 'pointer',
                }}
              >
                <option value="">Select Assignees</option>
                {(isTravel || isWellness)
                  ? assignableStaff.map(s => {
                      const brands = accessibleSubBrands(s);
                      const scope = brands.length && brands.length < 4
                        ? ` · ${brands.map(subBrandShortLabel).join('/')}`
                        : '';
                      return <option key={s.id} value={s.id}>{s.name}{scope}</option>;
                    })
                  : contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)
                }
              </select>
            </div>

            {/* Tags — only on wellness tenants; mirrors the BulkTagModal pattern exactly:
                dropdown button → TagPickerPopover → chip strip below */}
            {isWellness && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                <span style={{ ...filterLabelStyle, fontSize: '0.78rem' }}>Tags:</span>
                <div ref={tagAnchorRef} style={{ position: 'relative' }}>
                  {/* Dropdown trigger — same shape as BulkTagModal's tag select button */}
                  <button
                    type="button"
                    onClick={() => setShowTagPicker((v) => !v)}
                    aria-haspopup="dialog"
                    aria-expanded={showTagPicker}
                    style={{
                      ...modalInputStyle,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      cursor: 'pointer',
                      textAlign: 'left',
                      minHeight: 40,
                      borderRadius: 8,
                    }}
                  >
                    <span style={{ flex: 1, color: newTask.tagIds.length ? 'var(--text-primary)' : 'var(--text-secondary)', fontSize: '0.875rem' }}>
                      {newTask.tagIds.length ? `${newTask.tagIds.length} tag(s) selected` : 'Select tags…'}
                    </span>
                    <ChevronDown size={14} color="var(--text-secondary)" />
                  </button>

                  {/* Popover — same TagPickerPopover used in patients */}
                  {showTagPicker && (
                    <TagPickerPopover
                      allTags={allTags}
                      onPick={(tag) => {
                        if (!newTask.tagIds.includes(tag.id)) {
                          setNewTask((prev) => ({ ...prev, tagIds: [...prev.tagIds, tag.id] }));
                        } else {
                          setNewTask((prev) => ({ ...prev, tagIds: prev.tagIds.filter((id) => id !== tag.id) }));
                        }
                      }}
                      onCreate={handleTagCreate}
                      onClose={() => setShowTagPicker(false)}
                      showCreate
                      title="Pick tags"
                    />
                  )}
                </div>

                {/* Chip strip below the dropdown — same as BulkTagModal's selected tag chips */}
                {selectedTags.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.25rem' }}>
                    {selectedTags.map((t) => (
                      <span key={t.id} style={tagChipStyle(tagColour(t))}>
                        {t.name}
                        <button
                          type="button"
                          onClick={() => removeTag(t.id)}
                          aria-label={`Remove ${t.name}`}
                          style={chipRemoveStyle}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Description */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                Description:
              </label>
              <textarea
                rows="4"
                placeholder="Write description or notes here..."
                value={newTask.description}
                onChange={e => setNewTask({ ...newTask, description: e.target.value })}
                style={{
                  width: '100%', boxSizing: 'border-box', resize: 'vertical',
                  padding: '0.6rem 0.75rem', fontSize: '0.875rem',
                  border: '1px solid var(--border-color, rgba(0,0,0,0.15))',
                  borderRadius: 8,
                  background: 'var(--surface-color, #fff)',
                  color: 'var(--text-primary)',
                  outline: 'none', fontFamily: 'inherit',
                }}
              />
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '0.25rem' }}>
              <button
                id="assign-task-btn"
                type="submit"
                style={{
                  padding: '0.6rem 2.25rem', borderRadius: 8, fontWeight: 600, fontSize: '0.9rem',
                  background: 'var(--text-primary, #1a1a2e)', color: 'var(--bg-color, #fff)',
                  border: 'none', cursor: 'pointer', letterSpacing: '0.01em',
                }}
              >
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        /* #480 / #893: with the form moved to a drawer the main grid is now a single column.
           Keep the mobile padding adjustment in place so the page still breathes on narrow
           viewports; the drawer itself is full-width on mobile via maxWidth: 520 + width: 100%. */
        @media (max-width: 768px) {
          .tasks-page { padding: 1rem !important; }
          .tasks-page .card { padding: 1.25rem !important; }
          .tasks-page h3 { white-space: normal !important; }
        }
      `}</style>
    </div>
  );
}
