import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Mail, Phone, MessageSquare, StickyNote, CheckSquare,
  Video, TrendingUp, Plus, MoreHorizontal, ChevronDown, ChevronLeft, ChevronRight,
  Calendar, FileText, Handshake, Pencil, Settings, Tag, X, Zap,
  Copy, Trash2, ListPlus, Download, BellOff, UserX, EyeOff, Eye, ListChecks, XCircle, Search,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatMoney } from '../utils/money';
import { formatDate, formatDateTime } from '../utils/date';
import { AuthContext } from '../appContexts';
import { PROFILE_TABS, SOCIAL_NETWORKS, buildOverviewSections, normalizeSocialUrl } from '../components/contact/contactProfileConfig';
import CustomizeFieldsDrawer, { ALL_OVERVIEW_FIELDS, DEFAULT_VISIBLE_FIELD_KEYS, normalizeVisibleKeys } from '../components/contact/CustomizeFieldsDrawer';
import { assignOwner, fetchActivities, fetchStaff, patchContact, postActivity } from '../components/contact/contactActions';
import { InlineField, Stars, Modal } from '../components/contact/ProfileWidgets';
import {
  ActivityModal, CallModal, DealModal, EmailModal, MeetingModal, SmsModal, TaskModal, WhatsappModal,
} from '../components/contact/ActionModals';
import {
  AccountsTab, ActivitiesTab, ConversationsTab, DealsTab, FilesTab, InsightsTab,
} from '../components/contact/ProfileTabs';
import ContactDetailsDrawer, { GENERIC_TAG_COLORS, dedupeTags, fallbackTagColor, normalizeTagRecords, tagKey, tagTextColor } from '../components/contact/ContactDetailsDrawer';
import CallifiedCallDialog from '../components/CallifiedCallDialog';
import CallifiedLeadCallDialog from '../components/CallifiedLeadCallDialog';
import Contacts from './Contacts';
import '../components/contact/ContactProfile.css';
import RichTextNotePreview from '../components/contact/RichTextNotePreview';

const EDITABLE_TYPES = new Set(['text', 'email', 'phone', 'url', 'number', 'date']);

const PIPELINE_SEGS = [
  {
    title: 'New',
    options: [
      { label: 'New', backend: 'Lead', negative: false },
    ],
  },
  {
    title: 'Contacted',
    options: [
      { label: 'Contacted', backend: 'Prospect', negative: false },
    ],
  },
  {
    title: 'Interested / Unqualified',
    options: [
      { label: 'Interested', backend: 'Prospect', negative: false },
      { label: 'Unqualified', backend: 'Junk', negative: true },
    ],
  },
  {
    title: 'Qualified / Lost',
    options: [
      { label: 'Qualified', backend: 'Customer', negative: false },
      { label: 'Lost', backend: 'Churned', negative: true },
    ],
  },
  {
    title: 'Won / Churned',
    options: [
      { label: 'Won', backend: 'Customer', negative: false },
      { label: 'Churned', backend: 'Churned', negative: true },
    ],
  },
];

const WELLNESS_PIPELINE_SEGS = [
  { title: 'New', options: [{ label: 'New', backend: 'Lead', negative: false }] },
  { title: 'Contacted', options: [{ label: 'Contacted', backend: 'Prospect', negative: false }] },
  { title: 'Consultation', options: [{ label: 'Consultation', backend: 'Prospect', negative: false }] },
  { title: 'Treatment Plan', options: [{ label: 'Treatment Plan', backend: 'Prospect', negative: false }] },
  { title: 'Active', options: [{ label: 'Active', backend: 'Customer', negative: false }] },
  { title: 'Completed', options: [{ label: 'Completed', backend: 'Customer', negative: false }] },
];

const TRAVEL_PIPELINE_SEGS = [
  { title: 'Contact', options: [{ label: 'Contact', backend: 'Lead', negative: false }] },
  { title: 'Lead', options: [{ label: 'Lead', backend: 'Prospect', negative: false }] },
  { title: 'Deal', options: [{ label: 'Deal', backend: 'Customer', negative: false }] },
  { title: 'Trip', options: [{ label: 'Trip', backend: 'Customer', negative: false }] },
  { title: 'Payment', options: [{ label: 'Payment', backend: 'Customer', negative: false }] },
];

const segOption = (label, segments = PIPELINE_SEGS) => {
  for (const seg of segments) {
    const found = seg.options.find((o) => o.label === label);
    if (found) return found;
  }
  return null;
};

const segIndexOf = (label, segments = PIPELINE_SEGS) => segments.findIndex((seg) => seg.options.some((o) => o.label === label));

const defaultStageFor = (status, wellness = false, travel = false) => {
  if (travel) {
    if (status === 'Prospect') return 'Lead';
    if (status === 'Customer') return 'Deal';
    return 'Contact';
  }
  if (wellness) {
    if (status === 'Customer') return 'Active';
    if (status === 'Prospect') return 'Contacted';
    return 'New';
  }
  if (status === 'Lead') return 'New';
  if (status === 'Prospect') return 'Contacted';
  if (status === 'Customer') return 'Qualified';
  if (status === 'Churned') return 'Churned';
  if (status === 'Junk') return 'Unqualified';
  return 'New';
};

const defaultVisibleFields = () => {
  const map = {};
  for (const f of ALL_OVERVIEW_FIELDS) map[f.key] = DEFAULT_VISIBLE_FIELD_KEYS.includes(f.key);
  return map;
};

const DEFAULT_PREFS = {
  scoring: true,
  blocks: true,
  timeline: true,
  showLifecycle: true,
  showSummary: true,
  showTags: true,
  visibleFields: defaultVisibleFields(),
  fieldOrder: [...DEFAULT_VISIBLE_FIELD_KEYS],
};

const loadPrefs = () => {
  const fresh = () => ({
    ...DEFAULT_PREFS,
    visibleFields: defaultVisibleFields(),
    fieldOrder: [...DEFAULT_VISIBLE_FIELD_KEYS],
  });
  try {
    const raw = JSON.parse(localStorage.getItem('cp-overview-prefs') || '{}');
    const visibleFields = { ...defaultVisibleFields(), ...(raw.visibleFields || {}) };
    const fieldOrder = Array.isArray(raw.fieldOrder) && raw.fieldOrder.length > 0
      ? normalizeVisibleKeys(raw.fieldOrder).filter((k) => visibleFields[k])
      : normalizeVisibleKeys(visibleFields);
    for (const f of ALL_OVERVIEW_FIELDS) {
      if (visibleFields[f.key] && !fieldOrder.includes(f.key)) fieldOrder.push(f.key);
    }
    return {
      ...DEFAULT_PREFS,
      ...raw,
      visibleFields,
      fieldOrder,
    };
  } catch (_e) {
    return fresh();
  }
};

const orderedVisibleKeys = (prefs) => {
  const order = Array.isArray(prefs.fieldOrder) ? prefs.fieldOrder : [];
  const out = order.filter((k) => prefs.visibleFields[k]);
  for (const f of ALL_OVERVIEW_FIELDS) {
    if (prefs.visibleFields[f.key] && !out.includes(f.key)) out.push(f.key);
  }
  return out;
};

function isEmpty(v) {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function timeAgo(v) {
  if (!v) return null;
  const d = new Date(v).getTime();
  if (Number.isNaN(d)) return null;
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const days = Math.floor(s / 86400);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return formatDate(v);
}

function linkDisplay(raw, type, onClick) {
  if (isEmpty(raw)) return undefined;
  if (type === 'email') return <a href={`mailto:${raw}`} onClick={onClick}>{String(raw)}</a>;
  if (type === 'phone') return <a href={`tel:${String(raw).replace(/\s/g, '')}`}>{String(raw)}</a>;
  if (type === 'url') {
    const href = /^https?:\/\//i.test(String(raw)) ? String(raw) : `https://${String(raw)}`;
    return <a href={href} target="_blank" rel="noopener noreferrer">{String(raw)}</a>;
  }
  return undefined;
}

function ReadValue({ contact, field, onEmailClick }) {
  const raw = field.value !== undefined ? field.value : contact[field.key === 'tags' ? 'tags' : field.key];
  if (isEmpty(raw)) return <span style={{ color: 'var(--text-secondary)' }}>Not available</span>;
  if (field.type === 'email' || field.type === 'phone' || field.type === 'url') return <span>{linkDisplay(raw, field.type, field.type === 'email' ? onEmailClick : undefined)}</span>;
  if (field.type === 'date') return <span>{formatDate(raw)}</span>;
  if (field.type === 'datetime') return <span>{formatDateTime(raw)}</span>;
  if (field.type === 'relative') return <span>{timeAgo(raw) || formatDate(raw)}</span>;
  if (field.type === 'money') return <span>{formatMoney(raw)}</span>;
  if (field.type === 'boolean') return <span>{raw ? 'Yes' : 'No'}</span>;
  if (field.type === 'status') return <span className="cp-pill">{String(raw)}</span>;
  if (field.type === 'tags') {
    const arr = Array.isArray(raw) ? raw : [raw];
    return <span>{arr.map((t) => <span key={String(t)} className="cp-chip">{String(t)}</span>)}</span>;
  }
  return <span>{String(raw)}</span>;
}

export default function ContactDetail() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const notify = useNotify();
  const { tenant } = useContext(AuthContext);
  const isWellness = tenant?.vertical === 'wellness';
  const isTravel = tenant?.vertical === 'travel';
  const isGeneric = !isWellness && !isTravel;
  const lifecycleSegments = isWellness ? WELLNESS_PIPELINE_SEGS : isTravel ? TRAVEL_PIPELINE_SEGS : PIPELINE_SEGS;
  const defaultListPath = location.pathname.startsWith('/leads/') ? '/leads' : '/contacts';
  const requestedBackTo = location.state?.returnTo || location.state?.backTo;
  const closePath = typeof requestedBackTo === 'string'
    && requestedBackTo.startsWith('/')
    && !requestedBackTo.startsWith('//')
    ? requestedBackTo
    : defaultListPath;
  const listPath = closePath;
  const closeLabel = typeof (location.state?.returnLabel || location.state?.backLabel) === 'string'
    ? (location.state.returnLabel || location.state.backLabel)
    : `Back to ${defaultListPath === '/leads' ? 'Leads' : 'Contacts'}`;
  const closeProfile = () => navigate(closePath, { replace: Boolean(requestedBackTo) });
  const [contact, setContact] = useState(null);
  const [overviewActivities, setOverviewActivities] = useState([]);
  const [overviewActivityPage, setOverviewActivityPage] = useState(1);
  const [overviewActivityTotal, setOverviewActivityTotal] = useState(0);
  const [overviewActivityTotalPages, setOverviewActivityTotalPages] = useState(1);
  const [overviewActivitiesLoading, setOverviewActivitiesLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [staff, setStaff] = useState([]);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteComposerOpen, setNoteComposerOpen] = useState(false);
  const [noteFormatting, setNoteFormatting] = useState({});
  const noteComposerRef = useRef(null);
  const [tagDraft, setTagDraft] = useState('');
  const [tagSaving, setTagSaving] = useState(false);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [tagCatalog, setTagCatalog] = useState([]);
  const [tagCatalogLoading, setTagCatalogLoading] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [pendingTags, setPendingTags] = useState([]);
  const [tagSelectionSaving, setTagSelectionSaving] = useState(false);
  const [tagMutationError, setTagMutationError] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState(GENERIC_TAG_COLORS[0]);
  const [tagCreating, setTagCreating] = useState(false);
  const [tagColorSaving, setTagColorSaving] = useState('');
  const [modal, setModal] = useState(null);
  const [genericCallLead, setGenericCallLead] = useState(null);
  const [activitiesRefreshKey, setActivitiesRefreshKey] = useState(0);
  const [wellnessCallTarget, setWellnessCallTarget] = useState(null);
  const [activityPreset, setActivityPreset] = useState('Note');
  const [dealModal, setDealModal] = useState({ open: false, deal: null });
  const [stageSel, setStageSel] = useState(null);
  const [openSeg, setOpenSeg] = useState(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [isCustomizing, setIsCustomizing] = useState(false);
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);
  const [overviewEditOpen, setOverviewEditOpen] = useState(false);
  const [overviewEdit, setOverviewEdit] = useState({ lifecycle: 'Lead', status: 'Lead' });
  const [overviewEditSaving, setOverviewEditSaving] = useState(false);
  const [navExpanded, setNavExpanded] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [seqPicker, setSeqPicker] = useState(false);
  const [sequences, setSequences] = useState([]);
  const [seqLoading, setSeqLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [socEdit, setSocEdit] = useState(null);
  const [socDraft, setSocDraft] = useState('');
  const notesRef = useRef(null);
  const noteInputRef = useRef(null);
  const moreRef = useRef(null);
  const contactTagManagerEnabled = isGeneric;

  useEffect(() => {
    if (!contactTagManagerEnabled) return undefined;
    let active = true;
    setTagCatalogLoading(true);
    fetchApi('/api/contacts/tags', { silent: true }).then((data) => {
      if (active) setTagCatalog(normalizeTagRecords(data));
    }).catch(() => {
      if (active) setTagMutationError('Could not load tags.');
    }).finally(() => {
      if (active) setTagCatalogLoading(false);
    });
    return () => { active = false; };
  }, [contactTagManagerEnabled]);

  const openWellnessBooking = () => {
    if (!isWellness) return;
    const params = new URLSearchParams({
      contactId: String(contact.id),
      returnTo: `/contacts/${contact.id}?tab=deals`,
    });
    if (contact.patientId) params.set('patientId', String(contact.patientId));
    navigate(`/wellness/book-appointment?${params.toString()}`);
  };

  const loadContact = useCallback(() => {
    setLoading(true);
    fetchApi(`/api/contacts/${id}`)
      .then((data) => { setContact(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    setContact(null);
    setOverviewActivityPage(1);
    setActiveTab(new URLSearchParams(location.search).get('tab') === 'deals' ? 'deals' : 'overview');
    setSummaryOpen(true);
    setModal(null);
    setDealModal({ open: false, deal: null });
    setStageSel(null);
    setOpenSeg(null);
    setTagDraft('');
    setMoreOpen(false);
    setSeqPicker(false);
    setConfirmAction(null);
    loadContact();
    fetchStaff().then(setStaff);
  }, [id, location.search, loadContact]);

  const overviewContactId = contact?.id;
  const overviewActivityRefreshId = contact?.activities?.[0]?.id;
  const overviewNoteActivities = overviewActivities.filter((activity) => activity.type === 'Note');

  useEffect(() => {
    if (!overviewContactId) return undefined;
    let cancelled = false;
    setOverviewActivitiesLoading(true);
    fetchActivities(overviewContactId, overviewActivityPage, 5)
      .then((result) => {
        if (cancelled) return;
        setOverviewActivities(result.data);
        setOverviewActivityTotal(result.total);
        setOverviewActivityTotalPages(result.totalPages);
      })
      .catch(() => {
        if (cancelled) return;
        setOverviewActivities([]);
        setOverviewActivityTotal(0);
        setOverviewActivityTotalPages(1);
      })
      .finally(() => { if (!cancelled) setOverviewActivitiesLoading(false); });
    return () => { cancelled = true; };
  }, [overviewContactId, overviewActivityRefreshId, overviewActivityPage]);

  useEffect(() => {
    if (!moreOpen) return undefined;
    const onDown = (e) => { if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    if (modal || dealModal.open || seqPicker || confirmAction || isCustomizing) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') navigate(closePath); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, dealModal.open, seqPicker, confirmAction, isCustomizing, navigate, closePath]);

  useEffect(() => {
    if (!isCustomizing) { setFieldPickerOpen(false); }
  }, [isCustomizing]);

  const patchField = useCallback(async (data) => {
    const prev = contact;
    setContact({ ...contact, ...data });
    try {
      const updated = await patchContact(id, data);
      setContact(updated);
      // The update response is a flat Contact row. Reload after a status
      // change so the newly-created lifecycle activity is available to the
      // separate Activities tab immediately.
      if (Object.prototype.hasOwnProperty.call(data, 'status') && prev.status !== updated.status) {
        await loadContact();
      }
      notify.success('Saved.');
    } catch {
      setContact(prev);
      notify.error('Could not save changes.');
      throw new Error('save failed');
    }
  }, [contact, id, loadContact, notify]);

  const changeStatus = async (status) => {
    if (!contact || contact.status === status) return;
    const prev = contact.status;
    setContact({ ...contact, status });
    try {
      const updated = await patchContact(id, { status });
      setContact(updated);
      await loadContact();
      notify.success(`Status changed to ${status}.`);
    } catch {
      setContact({ ...contact, status: prev });
      notify.error('Could not update status.');
    }
  };

  const changeOwner = async (userId) => {
    const prev = contact.assignedToId ?? null;
    const next = userId === '' ? null : parseInt(userId, 10);
    setContact({ ...contact, assignedToId: next });
    try {
      const updated = await assignOwner(id, next);
      setContact((c) => ({ ...c, assignedTo: updated.assignedTo, assignedToId: updated.assignedToId ?? next }));
      notify.success('Owner updated.');
    } catch {
      setContact({ ...contact, assignedToId: prev });
      notify.error('Could not update owner.');
    }
  };

  const pickStage = (label) => {
    setOpenSeg(null);
    setStageSel(label);
    const opt = segOption(label, lifecycleSegments);
    if (opt) changeStatus(opt.backend);
  };

  const persistPrefs = (next) => {
    try {
      localStorage.setItem('cp-overview-prefs', JSON.stringify(next));
    } catch (_e) {
      notify.error('Could not save preference.');
    }
  };

  const togglePref = (key) => {
    setPrefs((p) => {
      const next = { ...p, [key]: !p[key] };
      persistPrefs(next);
      return next;
    });
  };

  const saveVisibleFields = (orderedKeys) => {
    const clean = normalizeVisibleKeys(orderedKeys);
    const visibleFields = defaultVisibleFields();
    for (const k of clean) visibleFields[k] = true;
    setPrefs((p) => {
      const next = { ...p, visibleFields, fieldOrder: clean };
      persistPrefs(next);
      return next;
    });
    setFieldPickerOpen(false);
  };

  const goNeighbor = async (dir) => {
    try {
      const list = await fetchApi('/api/contacts?limit=200', { silent: true });
      const arr = Array.isArray(list) ? list : list?.data || [];
      const idx = arr.findIndex((c) => String(c.id) === String(id));
      const target = idx >= 0 ? arr[idx + dir] : null;
      if (target) {
        navigate(`/contacts/${target.id}`, { state: location.state });
      } else {
        notify.info(dir > 0 ? 'This is the last contact.' : 'This is the first contact.');
      }
    } catch {
      notify.error('Could not load contacts.');
    }
  };

  const refresh = useCallback(() => loadContact(), [loadContact]);

  const sections = useMemo(() => (contact ? buildOverviewSections(contact) : []), [contact]);
  const extraSections = sections.filter((s) => s.title !== 'Summary');
  const meetings = useMemo(() => (contact?.activities || []).filter((a) => a.type === 'Meeting'), [contact]);
  const lastTouch = useMemo(
    () => (contact?.activities || []).find((a) => ['Call', 'Email', 'Meeting'].includes(a.type)) || null,
    [contact],
  );
  const deals = contact?.deals || [];
  const appointments = contact?.appointments || [];
  const tags = Array.isArray(contact?.tags) ? contact.tags : [];
  const wellnessTagRecords = [...tagCatalog, ...tags
    .filter((tag) => !tagCatalog.some((record) => tagKey(record.name) === tagKey(tag)))
    .map((name) => ({ name: String(name), color: fallbackTagColor(name) }))];
  const filteredWellnessTags = wellnessTagRecords.filter((record) => !tagSearch.trim() || record.name.toLowerCase().includes(tagSearch.trim().toLowerCase()));
  const authorOf = (a) => staff.find((u) => String(u.id) === String(a.userId))?.name
    || (a.userId ? `User #${a.userId}` : 'System');

  const closeMore = () => setMoreOpen(false);

  const downloadJson = (filename, data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  };

  const handleClone = async () => {
    closeMore();
    try {
      // Cloning is an explicit user action, so intentionally bypass the
      // normal duplicate preflight and preserve the source contact values.
      const cloneStamp = Date.now().toString(36);
      const cloneEmail = isGeneric
        ? contact.email
        : (contact.email && contact.email.includes('@') ? contact.email.replace('@', `+clone-${cloneStamp}@`) : `clone-${cloneStamp}@placeholder.local`);
      const created = await fetchApi(`/api/contacts${isGeneric ? '?force=true' : ''}`, {
        method: 'POST',
        body: JSON.stringify({
          name: `${contact.name} (Copy)`,
          email: cloneEmail,
          phone: isGeneric ? contact.phone || undefined : undefined,
          company: contact.company || undefined,
          title: contact.title || undefined,
          status: contact.status || 'Lead',
          source: contact.source || undefined,
          tags: tags.length ? tags : undefined,
        }),
      });
      notify.success('Contact cloned.');
      if (created?.id) navigate(`/contacts/${created.id}`);
    } catch { /* fetchApi surfaces the error toast */ }
  };

  const askDelete = () => {
    closeMore();
    setConfirmAction({
      key: 'delete',
      title: `Delete ${contact.name}?`,
      body: 'The contact will be moved to trash. You can restore it later from the contacts list.',
      confirmLabel: 'Delete',
    });
  };

  const askForget = () => {
    closeMore();
    setConfirmAction({
      key: 'forget',
      title: `Forget ${contact.name}?`,
      body: 'This permanently erases personal data (messages, calls, consent records) and anonymizes the contact per GDPR. This cannot be undone.',
      confirmLabel: 'Forget',
    });
  };

  const runConfirmAction = async () => {
    const key = confirmAction?.key;
    setConfirmAction(null);
    try {
      if (key === 'delete') {
        await fetchApi(`/api/contacts/${contact.id}`, { method: 'DELETE' });
        notify.success('Contact deleted.');
        navigate(listPath);
      } else if (key === 'forget') {
        await fetchApi(`/api/gdpr/contact/${contact.id}`, { method: 'DELETE' });
        notify.success('Contact data erased (GDPR).');
        navigate(listPath);
      }
    } catch { /* fetchApi surfaces the error toast */ }
  };

  const openSeqPicker = async () => {
    closeMore();
    setSeqPicker(true);
    setSeqLoading(true);
    try {
      const list = await fetchApi('/api/sequences?fields=summary', { silent: true });
      setSequences(Array.isArray(list) ? list : []);
    } catch {
      setSequences([]);
    } finally {
      setSeqLoading(false);
    }
  };

  const enrollInSequence = async (seq) => {
    try {
      await fetchApi(`/api/sequences/${seq.id}/enroll`, {
        method: 'POST',
        body: JSON.stringify({ contactId: contact.id }),
      });
      notify.success(`Added to sequence "${seq.name}".`);
      setSeqPicker(false);
    } catch { /* fetchApi surfaces the error toast (e.g. already enrolled) */ }
  };

  const handleExport = async () => {
    closeMore();
    try {
      const data = await fetchApi(`/api/gdpr/export/contact/${contact.id}`, { method: 'POST' });
      downloadJson(`contact-${contact.id}-export.json`, data);
      notify.success('Contact data exported.');
    } catch { /* fetchApi surfaces the error toast (Admin/Manager only) */ }
  };

  const handleUnsubscribe = async () => {
    closeMore();
    try {
      await fetchApi('/api/gdpr/consent', {
        method: 'POST',
        body: JSON.stringify({ contactId: contact.id, type: 'email', granted: false, source: 'contact-profile-menu' }),
      });
      notify.success('Contact unsubscribed from marketing emails.');
    } catch { /* fetchApi surfaces the error toast */ }
  };

  const openAction = (kind) => {
    if (kind === 'email' && !contact.email) {
      notify.error('Add an email address before composing.');
      return;
    }
    if (kind === 'call' && isGeneric && !contact.phone) {
      notify.error('Phone number is required to make a call.');
      return;
    }
    if (kind === 'call' && isGeneric) {
      setGenericCallLead(contact);
      return;
    }
    if ((kind === 'call' || kind === 'sms' || kind === 'whatsapp') && !contact.phone) {
      notify.error('Add a phone number first.');
      return;
    }
    if (kind === 'email' && isTravel) {
      navigate(`/inbox?travelComposeTo=${encodeURIComponent(contact.email)}`);
      return;
    }
    if (kind === 'email' && isWellness) {
      const returnTo = `${location.pathname}${location.search}${location.hash}`;
      navigate(`/inbox?wellnessComposeTo=${encodeURIComponent(contact.email)}&wellnessComposeReturnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (kind === 'meeting' && isTravel) {
      navigate(`/inbox?travelScheduleContactId=${encodeURIComponent(contact.id)}`);
      return;
    }
    if (kind === 'meeting' && isWellness) {
      const returnTo = `${location.pathname}${location.search}${location.hash}`;
      navigate(`/inbox?wellnessScheduleContactId=${encodeURIComponent(contact.id)}&wellnessScheduleReturnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (kind === 'task' && isTravel) {
      const returnTo = `${location.pathname}${location.search}${location.hash}`;
      navigate(`/tasks?create=1&contactId=${encodeURIComponent(contact.id)}&returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    setModal(kind);
  };

  const openTravelEmail = (event) => {
    if (!isTravel && !isWellness) return;
    event.preventDefault();
    openAction('email');
  };

  const openContactCall = () => {
    if (isGeneric) {
      if (!contact?.phone) {
        notify.error('Phone number is required to make a call.');
        return;
      }
      setGenericCallLead(contact);
      return;
    }
    if (!isWellness) {
      openAction('call');
      return;
    }
    const appointment = appointments[0];
    if (!appointment) {
      notify.info('No appointment available.');
      return;
    }
    setWellnessCallTarget(appointment);
  };

  const openContactDeal = () => {
    if (isTravel) {
      const returnTo = `/contacts/${contact.id}?tab=deals`;
      navigate(`/travel/pipeline?newDeal=1&contactId=${encodeURIComponent(contact.id)}&returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (isWellness) {
      openWellnessBooking();
      return;
    }
    setDealModal({ open: true, deal: null });
  };

  const focusNotes = () => {
    setNoteComposerOpen(true);
    setTimeout(() => noteComposerRef.current?.focus(), 60);
  };

  const saveContactDetailsField = useCallback(async (field, value) => {
    if (field.custom) {
      const customFields = { [field.key]: value };
      const updated = await patchContact(id, { customFields });
      setContact({ ...updated, customFields: { ...(contact.customFields || {}), ...customFields } });
      notify.success('Saved.');
      return;
    }
    if (field.key === 'firstName' || field.key === 'lastName') {
      const parts = String(contact.name || '').trim().split(/\s+/).filter(Boolean);
      const first = field.key === 'firstName' ? value : (contact.firstName || parts[0] || '');
      const last = field.key === 'lastName' ? value : (contact.lastName || parts.slice(1).join(' '));
      await patchField({ name: [first, last].filter(Boolean).join(' ') });
      return;
    }
    await patchField({ [field.key]: value });
  }, [contact, id, notify, patchField]);

  const handleContactDetailsAction = (action) => {
    if (action === 'see-all-details') { setActiveTab('details'); return; }
    if (action === 'manage-fields') { setIsCustomizing(true); return; }
    if (['email', 'call', 'sms'].includes(action)) openAction(action);
    if (action === 'note') focusNotes();
    if (action === 'task' || action === 'meeting') openAction(action);
    if (action === 'activities') { setActivityPreset('Call'); setModal('activity'); }
    if (action === 'deal') setDealModal({ open: true, deal: null });
  };

  const formatNote = (command, value = null) => {
    noteComposerRef.current?.focus();
    if (typeof document.execCommand === 'function') document.execCommand(command, false, value);
    const isActive = typeof document.queryCommandState === 'function'
      ? document.queryCommandState(command)
      : false;
    setNoteFormatting((current) => ({ ...current, [command]: isActive }));
  };

  useEffect(() => {
    if (!noteComposerOpen) return undefined;
    const updateFormatting = () => {
      if (!noteComposerRef.current?.contains(document.activeElement)) return;
      const commands = ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter'];
      const queryCommandState = (command) => (
        typeof document.queryCommandState === 'function' ? document.queryCommandState(command) : false
      );
      setNoteFormatting(Object.fromEntries(commands.map((command) => [command, queryCommandState(command)])));
    };
    document.addEventListener('selectionchange', updateFormatting);
    return () => document.removeEventListener('selectionchange', updateFormatting);
  }, [noteComposerOpen]);

  const handleRichNoteSave = async () => {
    const body = noteComposerRef.current?.innerText?.trim()
      || noteComposerRef.current?.textContent?.trim()
      || '';
    if (!body) return;
    setNoteSaving(true);
    try {
      const activity = await postActivity(id, { type: 'Note', description: body });
      notify.success('Note added.');
      setNoteComposerOpen(false);
      if (noteComposerRef.current) noteComposerRef.current.innerHTML = '';
      setContact((current) => current
        ? { ...current, activities: [activity, ...(current.activities || [])] }
        : current);
    } catch {
      notify.error('Failed to add note.');
    } finally {
      setNoteSaving(false);
    }
  };

  const handleAddTag = async (e) => {
    e.preventDefault();
    const t = tagDraft.trim();
    if (!t || tags.includes(t)) {
      setTagDraft('');
      return;
    }
    setTagSaving(true);
    try {
      await patchField({ tags: [...tags, t] });
      setTagDraft('');
    } finally {
      setTagSaving(false);
    }
  };

  const openWellnessTagPicker = () => {
    setPendingTags(dedupeTags(tags));
    setTagSearch('');
    setNewTagName('');
    setNewTagColor(GENERIC_TAG_COLORS[0]);
    setTagMutationError('');
    setTagPickerOpen(true);
  };

  const toggleWellnessTag = (nameValue) => {
    setPendingTags((current) => current.some((tag) => tagKey(tag) === tagKey(nameValue))
      ? current.filter((tag) => tagKey(tag) !== tagKey(nameValue))
      : [...current, nameValue]);
  };

  const applyWellnessTags = async () => {
    setTagSelectionSaving(true);
    try {
      await patchField({ tags: dedupeTags(pendingTags) });
      setTagPickerOpen(false);
    } catch {
      setTagMutationError('Could not save tags.');
    } finally {
      setTagSelectionSaving(false);
    }
  };

  const removeWellnessTag = async (nameValue) => {
    setTagSaving(true);
    try {
      await patchField({ tags: tags.filter((tag) => tagKey(tag) !== tagKey(nameValue)) });
    } finally {
      setTagSaving(false);
    }
  };

  const createWellnessTag = async () => {
    const nameValue = newTagName.trim();
    if (!nameValue || tagCatalog.some((record) => tagKey(record.name) === tagKey(nameValue))) {
      setTagMutationError(nameValue ? 'That tag already exists.' : 'Enter a tag name.');
      return;
    }
    setTagCreating(true);
    try {
      const created = await fetchApi('/api/contacts/tags', {
        method: 'POST',
        body: JSON.stringify({ name: nameValue, color: newTagColor }),
      });
      const record = normalizeTagRecords([created])[0] || { name: nameValue, color: newTagColor };
      setTagCatalog((current) => [...current, record]);
      setPendingTags((current) => [...current, record.name]);
      setNewTagName('');
      setTagMutationError('');
    } catch {
      setTagMutationError('Could not create tag.');
    } finally {
      setTagCreating(false);
    }
  };

  const changeWellnessTagColor = async (nameValue, color) => {
    const key = tagKey(nameValue);
    const previous = tagCatalog;
    setTagColorSaving(key);
    setTagCatalog((current) => current.map((record) => tagKey(record.name) === key ? { ...record, color } : record));
    try {
      await fetchApi(`/api/contacts/tags/${encodeURIComponent(nameValue)}`, {
        method: 'PATCH',
        body: JSON.stringify({ color }),
      });
    } catch {
      setTagCatalog(previous);
      setTagMutationError('Could not update tag color.');
    } finally {
      setTagColorSaving('');
    }
  };

  const shell = (content) => (
    <div className="cp-slide-root">
      <div className="cp-slide-bg"><Contacts /></div>
      <div className="cp-backdrop" onClick={closeProfile} aria-hidden="true" />
      <aside className="cp-slide-panel" aria-label="Contact profile">
        <button type="button" className="cp-slide-close" onClick={closeProfile} aria-label="Close profile" title={closeLabel}>
          <X size={15} />
        </button>
        <div className="cp-slide-scroll">
          <div className="cp-wrap">
            {content}
          </div>
        </div>
      </aside>
    </div>
  );

  if (loading) return shell(<p style={{ color: 'var(--text-secondary)' }}>Loading contact…</p>);
  if (!contact) {
    return shell(
      <div className="cp-soon"><h3>Contact not found</h3><button className="cp-action-btn" onClick={() => navigate(closePath)}>{closeLabel}</button></div>,
    );
  }

  const fitStars = Math.max(0, Math.min(5, Math.round((Number(contact.aiScore) || 0) / 20)));
  const ownerName = contact.assignedTo?.name || contact.assignedTo?.email || null;

  const saveSocLink = async (e, network) => {
    e.preventDefault();
    const clean = normalizeSocialUrl(socDraft);
    if (!clean) {
      notify.error('Enter a valid URL.');
      return;
    }
    setSocEdit(null);
    setSocDraft('');
    try {
      await patchField({ [network.key]: clean });
    } catch { /* patchField surfaces the error toast */ }
  };
  const activeStage = stageSel && (isTravel || segOption(stageSel, lifecycleSegments)?.backend === contact.status)
    ? stageSel
    : defaultStageFor(contact.status, isWellness, isTravel);
  const activeSeg = segIndexOf(activeStage, lifecycleSegments);
  const activeNegative = Boolean(segOption(activeStage, lifecycleSegments)?.negative);

  const openOverviewEditor = () => {
    const lifecycle = isWellness
      ? defaultStageFor(contact.status, true)
      : isTravel
        ? (contact.status === 'Customer' ? 'Customer' : contact.status === 'Prospect' ? 'Sales Qualified Lead' : 'Lead')
        : (contact.status === 'Customer'
        ? 'Customer'
        : contact.status === 'Prospect'
          ? 'Sales Qualified Lead'
          : 'Lead');
    setOverviewEdit({ lifecycle, status: contact.status || 'Lead' });
    setOverviewEditOpen(true);
  };

  const saveOverviewEditor = async () => {
    setOverviewEditSaving(true);
    try {
      const updated = await patchContact(id, { status: overviewEdit.status });
      setContact(updated);
      await loadContact();
      setStageSel(isTravel
        ? activeStage
        : defaultStageFor(updated.status, isWellness, isTravel));
      setOverviewEditOpen(false);
      notify.success('Saved.');
    } catch {
      notify.error('Could not save changes.');
    } finally {
      setOverviewEditSaving(false);
    }
  };

  const renderField = (f) => {
    if (f.key === '__owner') {
      return (
        <select className="cp-input" value={contact.assignedToId ?? ''} onChange={(e) => changeOwner(e.target.value)} aria-label={isWellness ? 'Treatment owner' : 'Sales owner'}>
          <option value="">Unassigned</option>
          {staff.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
        </select>
      );
    }
    const raw = contact[f.key === 'tags' ? 'tags' : f.key];
    if (EDITABLE_TYPES.has(f.type)) {
      return (
        <InlineField
          value={raw ?? ''}
          display={linkDisplay(raw, f.type, f.type === 'email' ? openTravelEmail : undefined)}
          type={f.type === 'phone' ? 'text' : f.type}
          onSave={(v) => patchField({ [f.key]: v })}
        />
      );
    }
    return <ReadValue contact={contact} field={f} onEmailClick={openTravelEmail} />;
  };

  const overviewText = (raw) => (isEmpty(raw) ? (
    <span style={{ color: 'var(--text-secondary)' }}>Not available</span>
  ) : (
    <span>{String(raw)}</span>
  ));

  const renderOverviewField = (key) => {
    const configuredLabel = (ALL_OVERVIEW_FIELDS.find((f) => f.key === key) || {}).label || key;
    const label = isWellness && key === 'owner' ? 'Assigned staff' : configuredLabel;
    const cell = (value) => (
      <div className="cp-field" key={key}>
        <div className="cp-label">{label}</div>
        <div className="cp-value">{value}</div>
      </div>
    );
    if (key === 'location') {
      const locationValue = contact.stateCode ?? contact.billingStateCode ?? '';
      return cell(
        <InlineField
          value={locationValue}
          display={locationValue || <span style={{ color: 'var(--text-secondary)' }}>Not available</span>}
          onSave={(v) => patchField({ stateCode: v })}
          placeholder="Enter location"
        />,
      );
    }
    if (key === 'phone') {
      return cell(
        <InlineField
          value={contact.phone ?? ''}
          display={linkDisplay(contact.phone, 'phone')}
          type="text"
          onSave={(v) => patchField({ phone: v })}
        />,
      );
    }
    if (key === 'company') {
      return cell(
        <button type="button" className="cp-link-btn" onClick={() => setActiveTab('accounts')}>
          {contact.company || 'Click to add'}
        </button>,
      );
    }
    if (key === 'owner') {
      return cell(
        <select className="cp-input" value={contact.assignedToId ?? ''} onChange={(e) => changeOwner(e.target.value)} aria-label={isWellness ? 'Treatment owner' : 'Sales owner'}>
          <option value="">Unassigned</option>
          {staff.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
        </select>,
      );
    }
    if (key === 'email') {
      return cell(
        <InlineField
          value={contact.email ?? ''}
          display={linkDisplay(contact.email, 'email', openTravelEmail)}
          type="text"
          onSave={(v) => patchField({ email: v })}
        />,
      );
    }
    if (key === 'createdAt') {
      return cell(timeAgo(contact.createdAt) || formatDate(contact.createdAt));
    }
    const nameParts = String(contact.name || '').split(' ').filter(Boolean);
    const extra = {
      firstName: contact.firstName ?? nameParts[0] ?? null,
      lastName: contact.lastName ?? (nameParts.length > 1 ? nameParts.slice(1).join(' ') : null),
      jobTitle: contact.title,
      workPhone: contact.workPhone,
      keyword: contact.keyword,
      note: contact.note,
      medium: contact.medium ?? contact.source,
      description: contact.description,
      monthlyBudget: contact.monthlyBudget,
    };
    if (key === 'website') {
      const raw = contact.website;
      return cell(isEmpty(raw) ? <span style={{ color: 'var(--text-secondary)' }}>Not available</span> : <span>{linkDisplay(raw, 'url')}</span>);
    }
    if (key === 'workPhone') {
      const raw = extra.workPhone;
      return cell(isEmpty(raw) ? <span style={{ color: 'var(--text-secondary)' }}>Not available</span> : <span>{linkDisplay(raw, 'phone')}</span>);
    }
    if (key === 'monthlyBudget') {
      const raw = extra.monthlyBudget;
      if (isEmpty(raw)) return cell(<span style={{ color: 'var(--text-secondary)' }}>Not available</span>);
      const num = Number(raw);
      return cell(Number.isFinite(num) ? <span>{formatMoney(num)}</span> : <span>{String(raw)}</span>);
    }
    if (key === 'messenger') {
      const raw = contact.telegram ?? contact.whatsapp ?? contact.teams ?? contact.messenger;
      return cell(overviewText(raw));
    }
    if (key === 'medium') {
      const raw = contact.medium ?? contact.source;
      return cell(
        <InlineField
          value={raw ?? ''}
          display={overviewText(raw)}
          onSave={(v) => patchField({ source: v })}
        />,
      );
    }
    if (key === 'adPlatform') {
      const raw = contact.advertisingPlatform ?? contact.adPlatform;
      const customKey = Object.keys(contact.customFields || {}).find((k) => ['advertising_platform', 'advertisingPlatform', 'ad_platform'].includes(k)) || 'advertising_platform';
      return cell(
        <InlineField
          value={raw ?? ''}
          display={overviewText(raw)}
          onSave={(v) => patchField({ customFields: { [customKey]: v } })}
        />,
      );
    }
    if (key === 'utmSource') return cell(overviewText(contact.utmSource));
    if (key === 'utmMedium') return cell(overviewText(contact.utmMedium));
    if (key === 'utmCampaign') return cell(overviewText(contact.utmCampaign));
    if (Object.prototype.hasOwnProperty.call(extra, key)) return cell(overviewText(extra[key]));
    return cell(overviewText(contact[key]));
  };

  const renderSection = (section) => {
    const visible = section.fields.filter((f) => {
      if (f.type === 'hidden') return false;
      if (f.key === '__owner') return true;
      if (EDITABLE_TYPES.has(f.type)) return true;
      return !isEmpty(contact[f.key === 'tags' ? 'tags' : f.key]);
    });
    if (visible.length === 0) return null;
    return (
      <div className="cp-card" key={section.title}>
        <h3>{section.title}</h3>
        <div className="cp-grid">
          {visible.map((f) => (
            <div className="cp-field" key={f.key + f.label}>
              <div className="cp-label">{f.label}</div>
              <div className="cp-value">{renderField(f)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return shell(
    <>
      <div className="cp-header">
        <div className="cp-avatar">{(contact.name || '?').charAt(0).toUpperCase()}</div>
        <div className="cp-header-main">
          <h1 className="cp-name">
            <InlineField value={contact.name} onSave={(v) => patchField({ name: v })} />
          </h1>
          {(contact.title || contact.company) && (
            <p className="cp-sub">{[contact.title, contact.company].filter(Boolean).join(' • ')}</p>
          )}
          <div className="cp-contact-line">
            {contact.email && <a href={`mailto:${contact.email}`} onClick={openTravelEmail}>{contact.email}</a>}
            {contact.phone && <a href={`tel:${String(contact.phone).replace(/\s/g, '')}`}>{contact.phone}</a>}
            {ownerName && <span>Owner: {ownerName}</span>}
          </div>
          <div className="cp-socials" style={{ marginTop: '0.5rem' }}>
            {SOCIAL_NETWORKS.map((n) => {
              const Icon = n.icon;
              const url = contact[n.key];
              const editing = socEdit === n.key;
              return (
                <div key={n.key} className="cp-soc-wrap">
                  {url ? (
                    <a className="cp-soc" style={{ color: n.color }} href={url} target="_blank" rel="noreferrer" title={`${n.label}: ${url}`} aria-label={`${n.label} profile`}>
                      <Icon size={15} />
                    </a>
                  ) : (
                    <button type="button" className="cp-soc cp-soc-off" onClick={() => { setSocEdit(editing ? null : n.key); setSocDraft(''); }} title={`Add ${n.label} link`} aria-label={`Add ${n.label} link`} aria-expanded={editing}>
                      <Icon size={15} />
                    </button>
                  )}
                  {editing && !url && (
                    <form className="cp-soc-pop" onSubmit={(e) => saveSocLink(e, n)}>
                      <input
                        className="cp-input"
                        value={socDraft}
                        onChange={(e) => setSocDraft(e.target.value)}
                        placeholder={n.placeholder}
                        aria-label={`${n.label} URL`}
                        autoFocus
                      />
                      <div className="cp-btn-row">
                        <button type="button" className="cp-action-btn" onClick={() => setSocEdit(null)}>Cancel</button>
                        <button type="submit" className="cp-action-btn cp-action-primary">Save</button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="cp-header-mid">
          <div className="cp-score-block">
            <div className="cp-label">Score</div>
            <div className="cp-score-val">{Number(contact.aiScore) || 0}</div>
          </div>
          <div className="cp-score-block">
            <div className="cp-label">Customer fit</div>
            <Stars value={fitStars} />
            {!isGeneric && <button type="button" className="cp-link-btn" onClick={() => setActiveTab('ai-insights')}>Show key scoring factors</button>}
          </div>
        </div>
        <div className="cp-header-right">
          <button type="button" className="cp-action-btn" onClick={() => setActiveTab('details')}><FileText size={13} /> See all details</button>
          <div className="cp-nav-btns">
            <button type="button" className="cp-action-btn" onClick={() => goNeighbor(-1)} title="Previous contact" aria-label="Previous contact"><ChevronLeft size={14} /></button>
            <button type="button" className="cp-action-btn" onClick={() => goNeighbor(1)} title="Next contact" aria-label="Next contact"><ChevronRight size={14} /></button>
          </div>
        </div>
      </div>

      <div className="cp-actions-bar">
        {contact.email && <button type="button" className="cp-action-btn" onClick={() => openAction('email')}><Mail size={13} /> Email</button>}
        {!isTravel && (isGeneric || contact.phone) && <button type="button" className="cp-action-btn" onClick={openContactCall}><Phone size={13} /> Call</button>}
        <button type="button" className="cp-action-btn" onClick={focusNotes}><StickyNote size={13} /> Note</button>
        <button type="button" className="cp-action-btn" onClick={() => (isWellness ? navigate('/tasks') : openAction('task'))}><CheckSquare size={13} /> Task</button>
        <button type="button" className="cp-action-btn" onClick={() => openAction('meeting')}><Video size={13} /> Meeting</button>
        <button type="button" className="cp-action-btn" onClick={() => { setActivityPreset('Call'); setModal('activity'); }}><TrendingUp size={13} /> {isWellness ? 'Care activities' : 'Sales activities'}</button>
        <button type="button" className="cp-action-btn cp-action-primary" onClick={openContactDeal}><Plus size={13} /> {isWellness ? 'Add appointment' : 'Add deal'}</button>
        {!isWellness && !isTravel && contact.phone && <button type="button" className="cp-action-btn" onClick={() => openAction('sms')}><MessageSquare size={13} /> SMS</button>}
        <div className="cp-more-wrap" ref={moreRef}>
          <button type="button" className="cp-action-btn" onClick={() => setMoreOpen((o) => !o)} title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded={moreOpen}><MoreHorizontal size={13} /></button>
          {moreOpen && (
            <div className="cp-more-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { closeMore(); setActiveTab('details'); }}><Pencil size={13} /> Edit</button>
              <button type="button" role="menuitem" onClick={handleClone}><Copy size={13} /> Clone</button>
              <button type="button" role="menuitem" className="neg" onClick={askDelete}><Trash2 size={13} /> Delete</button>
              {!isTravel && <button type="button" role="menuitem" onClick={openSeqPicker}><ListPlus size={13} /> Add to sequence</button>}
              <button type="button" role="menuitem" onClick={handleExport}><Download size={13} /> Export</button>
              {!isTravel && <button type="button" role="menuitem" onClick={handleUnsubscribe}><BellOff size={13} /> Unsubscribe</button>}
              <button type="button" role="menuitem" className="neg" onClick={askForget}><UserX size={13} /> Forget</button>
            </div>
          )}
        </div>
      </div>

      <div className="cp-layout">
        <nav
          className={`cp-side${navExpanded ? ' expanded' : ''}`}
          aria-label="Contact sections"
          aria-expanded={navExpanded}
          onMouseEnter={() => setNavExpanded(true)}
          onMouseLeave={() => setNavExpanded(false)}
          onFocus={() => setNavExpanded(true)}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setNavExpanded(false); }}
        >
          {PROFILE_TABS.map((t) => {
            const Icon = t.icon;
            const tabLabel = isWellness && t.key === 'details'
              ? 'Patient details'
              : isWellness && t.key === 'deals'
                ? 'Appointments'
                : t.label;
            return (
              <button
                key={t.key}
                type="button"
                className={`cp-nav-item${activeTab === t.key ? ' active' : ''}`}
                onClick={(e) => { setActiveTab(t.key); setNavExpanded(false); e.currentTarget.blur(); }}
                title={tabLabel}
              >
                <Icon size={15} /> <span className="cp-nav-label">{tabLabel}</span>
              </button>
            );
          })}
        </nav>

        <div className="cp-main">
          {activeTab === 'overview' && (
            <div className={`cp-ov-card${isCustomizing ? ' cp-customizing' : ''}`}>
              <div className="cp-ov-head">
                <h2>Overview</h2>
                <div className="cp-ov-head-actions">
                  {isCustomizing ? (
                    <>
                      {!isTravel && <button type="button" className="cp-action-btn cp-action-primary" onClick={() => { persistPrefs(prefs); setIsCustomizing(false); }}>Apply</button>}
                      <button type="button" className="cp-action-btn" onClick={() => setIsCustomizing(false)}><XCircle size={13} /> Cancel customization</button>
                    </>
                  ) : (
                    <button type="button" className="cp-action-btn" onClick={() => setIsCustomizing(true)}><Settings size={13} /> Customize overview</button>
                  )}
                </div>
              </div>
              {overviewEditOpen && (
                <div className="cp-overview-editor" role="dialog" aria-label="Edit overview">
                  <label className="cp-form-row">
                    <span className="cp-form-label">Lifecycle stage</span>
                    <select
                      className="cp-input"
                      value={overviewEdit.lifecycle}
                      onChange={(e) => {
                        const lifecycle = e.target.value;
                        const status = isTravel
                          ? ({ Lead: 'Lead', 'Sales Qualified Lead': 'Prospect', Customer: 'Customer' }[lifecycle] || 'Lead')
                          : isWellness
                          ? ({ New: 'Lead', Contacted: 'Prospect', Consultation: 'Prospect', 'Treatment Plan': 'Prospect', Active: 'Customer', Completed: 'Customer' }[lifecycle] || 'Lead')
                          : (lifecycle === 'Lead' ? 'Lead' : lifecycle === 'Sales Qualified Lead' ? 'Prospect' : 'Customer');
                        setOverviewEdit({ lifecycle, status });
                      }}
                    >
                      {!isTravel && <option value="Lead">Lead</option>}
                      {isTravel ? (
                        <>
                          <option value="Lead">Lead</option>
                          <option value="Sales Qualified Lead">Sales Qualified Lead</option>
                          <option value="Customer">Customer</option>
                        </>
                      ) : isWellness ? (
                        <>
                          <option value="Contacted">Contacted</option>
                          <option value="Consultation">Consultation</option>
                          <option value="Treatment Plan">Treatment Plan</option>
                          <option value="Active">Active</option>
                          <option value="Completed">Completed</option>
                        </>
                      ) : (
                        <>
                          <option value="Sales Qualified Lead">Sales Qualified Lead</option>
                          <option value="Customer">Customer</option>
                        </>
                      )}
                    </select>
                  </label>
                  <label className="cp-form-row">
                    <span className="cp-form-label">Status</span>
                    <select
                      className="cp-input"
                      value={overviewEdit.status}
                        onChange={(e) => {
                          setOverviewEdit((current) => ({ ...current, status: e.target.value }));
                        }}
                    >
                      {isTravel ? (
                        <>
                          <option value="Lead">Contact</option>
                          <option value="Prospect">Lead</option>
                          <option value="Customer">Deal</option>
                          <option value="Customer">Trip</option>
                          <option value="Customer">Payment</option>
                        </>
                      ) : (
                        <>
                          <option value="Lead">New</option>
                          <option value="Prospect">Contacted</option>
                          <option value="Customer">Qualified</option>
                          <option value="Junk">Unqualified</option>
                          <option value="Churned">Churned</option>
                        </>
                      )}
                    </select>
                  </label>
                  <div className="cp-btn-row">
                    <button type="button" className="cp-action-btn" onClick={() => setOverviewEditOpen(false)} disabled={overviewEditSaving}>Cancel</button>
                    <button type="button" className="cp-action-btn cp-action-primary" onClick={saveOverviewEditor} disabled={overviewEditSaving}>{overviewEditSaving ? 'Saving…' : 'Save'}</button>
                  </div>
                </div>
              )}
              {isCustomizing ? (
                <div className="cp-custom-box" aria-label="Lifecycle stage customization">
                  <button type="button" className="cp-custom-pill" onClick={() => togglePref('showLifecycle')}>
                    {prefs.showLifecycle ? <EyeOff size={12} /> : <Eye size={12} />}
                    {prefs.showLifecycle ? 'Hide Lifecycle stage' : 'Show Lifecycle stage'}
                  </button>
                  <div className="cp-custom-skel cp-custom-skel-bar" aria-hidden="true" />
                </div>
              ) : prefs.showLifecycle ? (
              <div className="cp-lifecycle-row">
                <div className="cp-lifecycle-left">
                  <div className="cp-lifecycle-label">
                    <div className="cp-label">Lifecycle stage</div>
                    <button type="button" className="cp-action-btn cp-lifecycle-edit" onClick={openOverviewEditor} aria-label="Edit lifecycle stage and status" title="Edit lifecycle stage and status"><Pencil size={13} /></button>
                  </div>
                  <div className="cp-lifecycle-current">{activeStage}</div>
                </div>
                <div className="cp-lifecycle-right">
                  <div className="cp-label">Status</div>
                  <div className="cp-pipeline" role="group" aria-label="Lifecycle stage">
                    {lifecycleSegments.map((seg, i) => (
                      <div className="cp-chev-wrap" key={seg.title}>
                        {seg.options.length === 1 ? (
                          <button
                            type="button"
                            title={`Move to ${seg.title}`}
                            onClick={() => pickStage(seg.options[0].label)}
                            className={`cp-chev${i < activeSeg ? ' done' : ''}${i === activeSeg ? ' current' : ''}`}
                          >{seg.title}</button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => setOpenSeg(openSeg === i ? null : i)}
                              className={`cp-chev${i < activeSeg ? ' done' : ''}${i === activeSeg ? ' current' : ''}${i === activeSeg && activeNegative ? ' lost' : ''}`}
                            >{seg.title} <ChevronDown size={12} /></button>
                            {openSeg === i && (
                              <div className="cp-chev-menu">
                                {seg.options.map((o) => (
                                  <button key={o.label} type="button" className={o.negative ? 'neg' : ''} onClick={() => pickStage(o.label)}>{o.label}</button>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              ) : null}
              <div className="cp-ov-body">
                <div className="cp-ov-main">
                  {isCustomizing ? (
                    <>
                      <div className="cp-custom-box" aria-label="Contact summary customization">
                        <button type="button" className="cp-custom-pill" onClick={() => togglePref('showSummary')}>
                          {prefs.showSummary ? <EyeOff size={12} /> : <Eye size={12} />}
                          {prefs.showSummary ? 'Hide contact Summary' : 'Show contact Summary'}
                        </button>
                        <div className="cp-custom-skel-row" aria-hidden="true">
                          <span className="cp-custom-skel cp-custom-skel-chip" />
                          <span className="cp-custom-skel cp-custom-skel-chip" />
                          <span className="cp-custom-skel cp-custom-skel-chip" />
                        </div>
                      </div>
                      <div className="cp-custom-box" aria-label="Tags customization">
                        <button type="button" className="cp-custom-pill" onClick={() => togglePref('showTags')}>
                          {prefs.showTags ? <EyeOff size={12} /> : <Eye size={12} />}
                          {prefs.showTags ? 'Hide Tags' : 'Show Tags'}
                        </button>
                        <div className="cp-custom-skel-row" aria-hidden="true">
                          <span className="cp-custom-skel cp-custom-skel-chip" />
                          <span className="cp-custom-skel cp-custom-skel-chip" />
                          <span className="cp-custom-skel cp-custom-skel-chip" />
                          <span className="cp-custom-skel cp-custom-skel-chip" />
                        </div>
                      </div>
                      <div className="cp-custom-box" aria-label="Fields customization">
                        <div className="cp-custom-pill-wrap">
                          <button type="button" className="cp-custom-pill" onClick={() => setFieldPickerOpen(true)}>
                            <ListChecks size={12} /> Select the fields to show here
                          </button>
                        </div>
                        <div className="cp-custom-fields-grid" aria-hidden="true">
                          {[0, 1, 2].map((col) => (
                            <div key={col} className="cp-custom-fields-col">
                              <span className="cp-custom-skel cp-custom-skel-label" />
                              <span className="cp-custom-skel cp-custom-skel-line" />
                              <span className="cp-custom-skel cp-custom-skel-label" />
                              <span className="cp-custom-skel cp-custom-skel-line" />
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                  <button type="button" className="cp-summary-bar" onClick={() => setSummaryOpen((o) => !o)} aria-expanded={summaryOpen}>
                    <span className="cp-summary-title"><Tag size={13} /> Summary</span>
                    <ChevronDown size={15} className={summaryOpen ? 'cp-flip' : ''} />
                  </button>
                  {prefs.showSummary && summaryOpen && (
                    <>
                      {prefs.showTags && (
                      <div className={`cp-tags-row${tagPickerOpen ? ' cp-tags-row-picker-open' : ''}`} onClick={(event) => { if (contactTagManagerEnabled && !event.target.closest('button, input')) openWellnessTagPicker(); }}>
                        <Tag size={13} />
                        {tags.length === 0 && <button type="button" className="cp-link-btn" onClick={openWellnessTagPicker}>Click to add tags</button>}
                        {tags.map((t) => { const record = wellnessTagRecords.find((item) => tagKey(item.name) === tagKey(t)); const color = record?.color || fallbackTagColor(t); return <span key={String(t)} className="cp-chip" style={{ background: color, color: tagTextColor(color), borderColor: color }}>{String(t)}<button type="button" aria-label={`Remove tag ${String(t)}`} onClick={() => removeWellnessTag(t)} disabled={tagSaving}>×</button></span>; })}
                        {!contactTagManagerEnabled && <form onSubmit={handleAddTag} className="cp-tag-form">
                          <input
                            className="cp-tag-input"
                            value={tagDraft}
                            onChange={(e) => setTagDraft(e.target.value)}
                            placeholder={tags.length === 0 ? '' : 'Add tag'}
                            aria-label="Add tag"
                          />
                          {tagDraft.trim() && (
                            <button type="submit" className="cp-link-btn" disabled={tagSaving}>{tagSaving ? 'Adding…' : 'Add'}</button>
                          )}
                        </form>}
                        {tags.length > 0 && <button type="button" className="cp-link-btn" onClick={openWellnessTagPicker}>+ Add tag</button>}
                        {tagPickerOpen && (
                          <div className="cd-tag-picker cp-contact-tag-picker" role="dialog" aria-label="Tag selector">
                            <div className="cd-tag-picker-head"><strong>Add tags</strong><button type="button" className="cd-tag-picker-close" onClick={() => setTagPickerOpen(false)} aria-label="Close tag selector"><X size={14} /></button></div>
                            <label className="cd-tag-picker-search"><Search size={13} /><input value={tagSearch} onChange={(e) => setTagSearch(e.target.value)} placeholder="Search tags" aria-label="Search tags" /></label>
                            <div className="cd-tag-picker-list" role="listbox" aria-multiselectable="true">
                              {tagCatalogLoading ? <div className="cd-tag-picker-message">Loading tags...</div> : filteredWellnessTags.length ? filteredWellnessTags.map((record) => { const selected = pendingTags.some((tag) => tagKey(tag) === tagKey(record.name)); return <div className={`cd-tag-option${selected ? ' is-selected' : ''}`} key={record.name}>
                                <button type="button" role="option" aria-selected={selected} onClick={() => toggleWellnessTag(record.name)}><span className="cd-tag-option-check">{selected ? '✓' : ''}</span><span className="cd-tag-chip" style={{ background: record.color, borderColor: record.color, color: tagTextColor(record.color) }}>{record.name}</span></button>
                                <label className="cd-tag-color"><input type="color" value={record.color} onChange={(e) => changeWellnessTagColor(record.name, e.target.value)} disabled={tagColorSaving === tagKey(record.name)} aria-label={`Change color for ${record.name}`} /></label>
                              </div>; }) : <div className="cd-tag-picker-message">No tags available.</div>}
                            </div>
                            <form className="cd-create-tag" onSubmit={(e) => { e.preventDefault(); createWellnessTag(); }}><strong>Create new tag</strong><div className="cd-create-tag-row"><input value={newTagName} onChange={(e) => setNewTagName(e.target.value)} placeholder="Tag name" aria-label="Add tag" /><input type="color" value={newTagColor} onChange={(e) => setNewTagColor(e.target.value)} aria-label="New tag color" /><button type="submit" disabled={tagCreating}>{tagCreating ? 'Creating...' : 'Create'}</button></div></form>
                            {tagMutationError && <div className="cd-tag-picker-error" role="alert">{tagMutationError}</div>}
                            <div className="cd-tag-picker-actions"><button type="button" className="cd-tag-picker-cancel" onClick={() => setTagPickerOpen(false)}>Cancel</button><button type="button" className="cd-tag-picker-apply" onClick={applyWellnessTags} disabled={tagSelectionSaving || tagCreating}>{tagSelectionSaving ? 'Applying...' : 'Apply tags'}</button></div>
                          </div>
                        )}
                      </div>
                      )}
                      <div className="cp-info-grid">
                        {(() => {
                          const keys = orderedVisibleKeys(prefs);
                          if (keys.length === 0) {
                            return (
                              <div className="cp-info-col">
                                <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                                  No fields selected. Use Customize overview to choose fields.
                                </span>
                              </div>
                            );
                          }
                          const cols = [[], [], []];
                          keys.forEach((k, i) => cols[i % 3].push(k));
                          return cols.map((colKeys, ci) => (
                            <div className="cp-info-col" key={ci}>
                              {colKeys.map((k) => renderOverviewField(k))}
                            </div>
                          ));
                        })()}
                      </div>
                    </>
                  )}
                  {prefs.blocks && (
                    <div className="cp-blocks">
                      <div className="cp-block">
                        <span className="cp-block-icon teal"><Handshake size={16} /></span>
                        <div>
                          {(isWellness ? appointments.length === 0 : deals.length === 0) ? (
                            <p>{isWellness ? 'No open appointments associated with' : 'No open deals associated with'} {contact.name}.</p>
                          ) : (
                            isWellness
                              ? appointments.slice(0, 1).map((appointment) => (
                                <div className="cp-row" key={appointment.id}>
                                  <span style={{ flex: 1, fontWeight: 600 }}>{appointment.serviceName || 'General appointment'}</span>
                                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>{formatDate(appointment.appointmentDate)}</span>
                                </div>
                              ))
                              : deals.map((d) => (
                                <div className="cp-row" key={d.id}>
                                  <button type="button" onClick={() => setDealModal({ open: true, deal: d })} className="cp-link-btn" style={{ fontWeight: 600 }}>{d.title}</button>
                                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{formatMoney(d.amount, { currency: d.currency })}</span>
                                </div>
                              ))
                          )}
                          <button type="button" className="cp-link-btn" onClick={openContactDeal}><Plus size={12} /> {isWellness ? 'Add appointment' : 'Add deal'}</button>
                        </div>
                      </div>
                      <div className="cp-block">
                        <span className="cp-block-icon purple"><Calendar size={16} /></span>
                        <div>
                          {meetings.length === 0 ? (
                            <p>No upcoming meetings with {contact.name}.</p>
                          ) : (
                            meetings.slice(0, 3).map((m) => (
                              <div className="cp-row" key={m.id}>
                                <span style={{ flex: 1 }}>{m.description}</span>
                                <span style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>{timeAgo(m.createdAt)}</span>
                              </div>
                            ))
                          )}
                          <button type="button" className="cp-link-btn" onClick={() => openAction('meeting')}><Plus size={12} /> Add meeting</button>
                        </div>
                      </div>
                      <div className="cp-block">
                        <span className="cp-block-icon orange"><Mail size={16} /></span>
                        <div>
                          {lastTouch ? (
                            <p>Last contacted {timeAgo(lastTouch.createdAt)} via {lastTouch.type.toLowerCase()}.</p>
                          ) : (
                            <p>{contact.name} hasn&rsquo;t been contacted yet.</p>
                          )}
                          <p>
                            <button type="button" className="cp-link-btn" onClick={() => openAction('email')}><Mail size={12} /> Send email</button>
                            <span style={{ color: 'var(--text-secondary)', margin: '0 0.4rem' }}>·</span>
                            <button type="button" className="cp-link-btn" onClick={openContactCall}><Phone size={12} /> Make call</button>
                          </p>
                        </div>
                      </div>
                      {!isWellness && !isTravel && (
                        <div className="cp-block">
                          <span className="cp-block-icon blue"><Zap size={16} /></span>
                          <div>
                            <p>{contact.name} is not part of any sales sequence.</p>
                            <Link to="/sequences" className="cp-link-btn"><Plus size={12} /> Add to a sequence</Link>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                    </>
                  )}
                </div>
                {!isCustomizing && prefs.timeline && (
                  <aside className="cp-ov-side" ref={notesRef}>
                    <form className="cp-note-yellow" onSubmit={(e) => { e.preventDefault(); focusNotes(); }}>
                      <textarea
                        ref={noteInputRef}
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        placeholder="Add a note..."
                        rows={3}
                        onFocus={() => setNoteComposerOpen(true)}
                      />
                      {noteDraft.trim() && (
                        <button type="submit" className="cp-action-btn cp-action-primary" disabled={noteSaving}>
                          {noteSaving ? 'Adding…' : 'Add note'}
                        </button>
                      )}
                    </form>
                    <div className="cp-timeline">
                      {overviewActivitiesLoading ? (
                        <div className="cp-empty">Loading activity...</div>
                      ) : overviewNoteActivities.map((a) => (
                        <div key={a.id} className="cp-timeline-entry">
                          <div className="cp-timeline-title" style={!isWellness && !isTravel ? { whiteSpace: 'pre-wrap' } : undefined}>
                            {a.type}{a.description ? ' / ' : ''}
                            {a.description && isGeneric && ['Email', 'Note'].includes(a.type) ? <RichTextNotePreview value={a.description} /> : a.description || null}
                          </div>
                          <div className="cp-timeline-meta"><Pencil size={11} /> {authorOf(a)} <span>•</span> {timeAgo(a.createdAt)}</div>
                        </div>
                      ))}
                      {!overviewActivitiesLoading && overviewNoteActivities.length === 0 && (
                        <div className="cp-empty">No activity yet.</div>
                      )}
                    </div>
                    {overviewNoteActivities.length > 0 && overviewActivityTotal > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginTop: '0.65rem' }}>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.68rem' }}>
                          Showing {((overviewActivityPage - 1) * 5) + 1} - {Math.min(overviewActivityPage * 5, overviewActivityTotal)} of {overviewActivityTotal}
                        </span>
                        <div style={{ display: 'flex', gap: '0.25rem' }}>
                          <button type="button" className="cp-filter" aria-label="Previous overview activities" disabled={overviewActivityPage <= 1} onClick={() => setOverviewActivityPage((current) => Math.max(1, current - 1))}><ChevronLeft size={12} /></button>
                          <button type="button" className="cp-filter" aria-label="Next overview activities" disabled={overviewActivityPage >= overviewActivityTotalPages} onClick={() => setOverviewActivityPage((current) => Math.min(overviewActivityTotalPages, current + 1))}><ChevronRight size={12} /></button>
                        </div>
                      </div>
                    )}
                  </aside>
                )}
              </div>
            </div>
          )}

          {activeTab === 'details' && <ContactDetailsDrawer inline contact={contact} staff={staff} hideSms={isTravel || isWellness} genericTagsEnabled={isGeneric} onOwnerChange={changeOwner} onFieldSave={saveContactDetailsField} onAction={handleContactDetailsAction} />}
          {activeTab === 'conversations' && <ConversationsTab contact={contact} contactId={id} hideSms={isTravel || isWellness} onOpenAction={openAction} richText={!isWellness && !isTravel} />}
          {activeTab === 'activities' && <ActivitiesTab contact={contact} staff={staff} onAddActivity={() => { setActivityPreset('Note'); setModal('activity'); }} richText={!isWellness && !isTravel} refreshKey={activitiesRefreshKey} />}
          {activeTab === 'accounts' && <AccountsTab contact={contact} refresh={refresh} patchField={patchField} isTravel={isTravel} />}
          {activeTab === 'deals' && <DealsTab contact={contact} refresh={refresh} isWellness={isWellness} isTravel={isTravel} onOpenAppointment={openWellnessBooking} onOpenTravelDeal={openContactDeal} onOpenDeal={(deal) => setDealModal({ open: true, deal })} />}
          {activeTab === 'ai-insights' && <InsightsTab contactId={id} />}
          {activeTab === 'files' && <FilesTab contactId={id} />}
        </div>
      </div>

      {modal === 'email' && <EmailModal contact={contact} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'call' && !isGeneric && <CallModal contact={contact} onClose={() => setModal(null)} onDone={refresh} />}
      {isGeneric && genericCallLead && (
        <CallifiedLeadCallDialog
          lead={genericCallLead}
          onClose={() => setGenericCallLead(null)}
          onCalled={() => {
            notify.success('Call initiated successfully.');
            setActivitiesRefreshKey((current) => current + 1);
            refresh();
          }}
        />
      )}
      {wellnessCallTarget && (
        <CallifiedCallDialog
          customer={{ name: contact.name, phone: contact.phone, subtitle: wellnessCallTarget.serviceName || null }}
          endpoints={{
            context: `/api/wellness/callified/visits/${wellnessCallTarget.id}/context`,
            campaigns: '/api/wellness/callified/campaigns',
            aiCall: `/api/wellness/callified/visits/${wellnessCallTarget.id}/ai-call`,
            manualCall: `/api/wellness/callified/visits/${wellnessCallTarget.id}/manual-call`,
          }}
          onClose={() => setWellnessCallTarget(null)}
        />
      )}
      {modal === 'sms' && <SmsModal contact={contact} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'whatsapp' && <WhatsappModal contact={contact} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'task' && <TaskModal contact={contact} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'meeting' && <MeetingModal contact={contact} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'activity' && <ActivityModal contact={contact} presetType={activityPreset} onClose={() => setModal(null)} onDone={refresh} />}
      {noteComposerOpen && (
        <div className="cp-overlay cp-note-overlay" onClick={() => setNoteComposerOpen(false)} role="dialog" aria-modal="true" aria-label="Add note">
          <div className="cp-note-composer" onClick={(e) => e.stopPropagation()}>
            <div className="cp-modal-head">
              <h3>Add note</h3>
              <button type="button" className="cp-icon-btn" onClick={() => setNoteComposerOpen(false)} aria-label="Close"><X size={16} /></button>
            </div>
            <div className="cp-note-related">Contact: <strong>{contact.name}</strong></div>
            <div
              ref={noteComposerRef}
              className="cp-note-editor"
              contentEditable
              suppressContentEditableWarning
              data-placeholder="Start typing your note..."
              role="textbox"
              aria-label="Note content"
            />
            <div className="cp-note-toolbar" aria-label="Note formatting">
              <select aria-label="Font size" defaultValue="3" onChange={(e) => formatNote('fontSize', e.target.value)}>
                <option value="2">12</option><option value="3">14</option><option value="4">16</option><option value="5">18</option>
              </select>
              <button type="button" className={noteFormatting.bold ? 'active' : ''} onClick={() => formatNote('bold')} aria-label="Bold" aria-pressed={Boolean(noteFormatting.bold)}><strong>B</strong></button>
              <button type="button" className={noteFormatting.italic ? 'active' : ''} onClick={() => formatNote('italic')} aria-label="Italic" aria-pressed={Boolean(noteFormatting.italic)}><em>I</em></button>
              <button type="button" className={noteFormatting.underline ? 'active' : ''} onClick={() => formatNote('underline')} aria-label="Underline" aria-pressed={Boolean(noteFormatting.underline)}><u>U</u></button>
              <button type="button" className={noteFormatting.insertUnorderedList ? 'active' : ''} onClick={() => formatNote('insertUnorderedList')} aria-label="Bulleted list" aria-pressed={Boolean(noteFormatting.insertUnorderedList)}>•≡</button>
              <button type="button" className={noteFormatting.insertOrderedList ? 'active' : ''} onClick={() => formatNote('insertOrderedList')} aria-label="Numbered list" aria-pressed={Boolean(noteFormatting.insertOrderedList)}>1≡</button>
              <button type="button" className={noteFormatting.justifyLeft ? 'active' : ''} onClick={() => formatNote('justifyLeft')} aria-label="Align left" aria-pressed={Boolean(noteFormatting.justifyLeft)}>≡</button>
              <button type="button" className={noteFormatting.justifyCenter ? 'active' : ''} onClick={() => formatNote('justifyCenter')} aria-label="Align center" aria-pressed={Boolean(noteFormatting.justifyCenter)}>☰</button>
            </div>
            <div className="cp-btn-row">
              <button type="button" className="cp-action-btn" onClick={() => setNoteComposerOpen(false)}>Cancel</button>
              <button type="button" className="cp-action-btn cp-action-primary" onClick={handleRichNoteSave} disabled={noteSaving}>{noteSaving ? 'Saving…' : 'Done'}</button>
            </div>
          </div>
        </div>
      )}
      {fieldPickerOpen && (
        <CustomizeFieldsDrawer
          visibleKeys={orderedVisibleKeys(prefs)}
          onSave={saveVisibleFields}
          onClose={() => setFieldPickerOpen(false)}
        />
      )}
      {dealModal.open && <DealModal contact={contact} deal={dealModal.deal} onClose={() => setDealModal({ open: false, deal: null })} onDone={refresh} />}
      {seqPicker && (
        <Modal title={isWellness ? 'Add to estimate' : 'Add to sequence'} onClose={() => setSeqPicker(false)}>
          {seqLoading ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Loading {isWellness ? 'estimates' : 'sequences'}…</p>
          ) : sequences.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No {isWellness ? 'estimates' : 'sequences'} yet. Create one under {isWellness ? 'Finance → Estimates' : 'Marketing → Sequences'}.</p>
          ) : (
            <div className="cp-seq-list">
              {sequences.map((s) => (
                <button key={s.id} type="button" className="cp-seq-item" onClick={() => enrollInSequence(s)}>
                  <span>{s.name}</span>
                  {s.isActive === false && <span className="cp-chip">Paused</span>}
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
      {confirmAction && (
        <Modal title={confirmAction.title} onClose={() => setConfirmAction(null)}>
          <p style={{ fontSize: '0.85rem', margin: '0 0 1rem' }}>{confirmAction.body}</p>
          <div className="cp-btn-row">
            <button type="button" className="cp-action-btn" onClick={() => setConfirmAction(null)}>Cancel</button>
            <button type="button" className="cp-action-btn cp-action-primary" onClick={runConfirmAction}>{confirmAction.confirmLabel}</button>
          </div>
        </Modal>
      )}
    </>,
  );
}
