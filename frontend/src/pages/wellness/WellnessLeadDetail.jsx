import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Activity, ArrowLeft, CalendarDays, ChevronDown, ClipboardList, Edit3, FileText,
  HeartPulse, Mail, Phone, Plus, StickyNote, UserRound,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';
import { formatDate, formatDateTime } from '../../utils/date';
import EditContactModal from '../../components/EditContactModal';
import ContactDetailsDrawer from '../../components/contact/ContactDetailsDrawer';
import './WellnessLeadDetail.css';

const WELLNESS_STAGES = [
  { key: 'new', status: 'Lead', label: 'New', kind: 'primary' },
  { key: 'contacted', status: 'Prospect', label: 'Contacted', kind: 'primary' },
  { key: 'interested', status: 'Prospect', label: 'Interested', kind: 'primary' },
  { key: 'qualified', status: 'Prospect', label: 'Qualified', kind: 'primary' },
  { key: 'booked', status: 'Customer', label: 'Booked', kind: 'primary' },
  { key: 'active_patient', status: 'Customer', label: 'Active Patient', kind: 'primary' },
  { key: 'not_interested', status: 'Churned', label: 'Not Interested', kind: 'alternative', choiceFor: 'interested' },
  { key: 'not_qualified', status: 'Churned', label: 'Not Qualified', kind: 'alternative', choiceFor: 'qualified' },
  { key: 'lost_lead', status: 'Churned', label: 'Lost Lead', kind: 'alternative', choiceFor: 'booked' },
];
const WELLNESS_PRIMARY_STAGES = WELLNESS_STAGES.filter((stage) => stage.kind === 'primary');
const WELLNESS_ALTERNATIVE_STAGES = WELLNESS_STAGES.filter((stage) => stage.kind === 'alternative');
const WELLNESS_STAGE_BY_KEY = new Map(WELLNESS_STAGES.map((stage) => [stage.key, stage]));

const getList = (value) => Array.isArray(value) ? value : [];
const getApiList = (value, key) => Array.isArray(value)
  ? value
  : getList(value?.[key] || value?.users || value?.data);
const fetchLinkedPatients = async (contactId) => {
  const pageSize = 200;
  const loadPage = (offset) => fetchApi(
    `/api/wellness/patients?contactId=${encodeURIComponent(contactId)}&fields=summary&limit=${pageSize}&offset=${offset}`,
    { silent: true },
  );
  const firstPage = await loadPage(0);
  const firstPatients = getList(firstPage?.patients);
  const total = Math.max(firstPatients.length, Number(firstPage?.total) || 0);
  if (firstPatients.length >= total) return firstPatients;
  const additionalPages = await Promise.all(
    Array.from({ length: Math.ceil(total / pageSize) - 1 }, (_, index) => loadPage((index + 1) * pageSize)),
  );
  return [...firstPatients, ...additionalPages.flatMap((page) => getList(page?.patients))];
};
const getInitials = (value) => String(value || '?').trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const display = (value) => value === null || value === undefined || value === '' ? '—' : String(value);
export default function WellnessLeadDetail() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const notify = useNotify();
  const { hasPermission, isReady: permissionsReady } = usePermissions();
  const canAssignOwner = permissionsReady && (hasPermission('contacts', 'update') || hasPermission('leads', 'update'));
  const [contact, setContact] = useState(null);
  const [patients, setPatients] = useState([]);
  const [locations, setLocations] = useState([]);
  const [staff, setStaff] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [patientsLoading, setPatientsLoading] = useState(true);
  const [patientAccessError, setPatientAccessError] = useState('');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedStage, setSelectedStage] = useState('');
  const [openStageMenu, setOpenStageMenu] = useState('');
  const [editing, setEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const loadRequestRef = useRef(0);

  const defaultListPath = location.pathname.startsWith('/contacts/') ? '/contacts' : '/leads';
  const backTo = location.state?.returnTo || location.state?.backTo || `${defaultListPath}${location.search || ''}`;
  const fallbackStage = contact?.status === 'Customer'
    ? (patients.length ? 'active_patient' : 'booked')
    : contact?.status === 'Prospect'
      ? 'contacted'
      : contact?.status === 'Churned'
        ? 'lost_lead'
        : contact?.status === 'Junk'
          ? 'not_qualified'
          : 'new';
  const storedStage = WELLNESS_STAGE_BY_KEY.has(contact?.lifecycleStageKey) ? contact.lifecycleStageKey : fallbackStage;
  const currentStage = selectedStage || storedStage;
  const currentStageLabel = WELLNESS_STAGE_BY_KEY.get(currentStage)?.label || 'New';
  const currentPrimaryIndex = WELLNESS_PRIMARY_STAGES.findIndex((stage) => stage.key === currentStage);
  const currentAlternative = WELLNESS_ALTERNATIVE_STAGES.find((stage) => stage.key === currentStage);
  const completedThrough = currentAlternative
    ? WELLNESS_PRIMARY_STAGES.findIndex((stage) => stage.key === currentAlternative.choiceFor)
    : currentPrimaryIndex;
  const noteActivities = useMemo(() => activities.filter((item) => item.type === 'Note'), [activities]);
  const otherActivities = useMemo(() => activities.filter((item) => item.type !== 'Note'), [activities]);
  const appointments = useMemo(() => getList(contact?.appointments).slice().sort((a, b) => new Date(a.appointmentDate) - new Date(b.appointmentDate)), [contact?.appointments]);

  useEffect(() => {
    if (!openStageMenu) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!event.target.closest?.('.wellness-lead-stage-segment')) setOpenStageMenu('');
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpenStageMenu('');
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [openStageMenu]);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setPatientsLoading(true);
    setError('');
    setPatientAccessError('');
    const [contactResult, patientsResult, locationsResult, staffResult] = await Promise.allSettled([
      fetchApi(`/api/contacts/${id}`),
      fetchLinkedPatients(id),
      fetchApi('/api/wellness/locations', { silent: true }),
      fetchApi('/api/staff?fields=summary', { silent: true }),
    ]);
    if (requestId !== loadRequestRef.current) return;
    if (contactResult.status === 'fulfilled') {
      const nextContact = contactResult.value;
      setContact(nextContact);
      setActivities(getList(nextContact?.activities));
    } else {
      setContact(null);
      setError(contactResult.reason?.body?.error || 'Unable to load this lead.');
    }
    if (patientsResult.status === 'fulfilled') {
      const nextPatients = getList(patientsResult.value);
      setPatients(nextPatients);
    } else {
      setPatients([]);
      setPatientAccessError(patientsResult.reason?.body?.error || 'Patient records are unavailable for your account.');
    }
    setLocations(locationsResult.status === 'fulfilled' ? getApiList(locationsResult.value, 'locations') : []);
    setStaff(staffResult.status === 'fulfilled' ? getApiList(staffResult.value, 'staff') : []);
    setLoading(false);
    setPatientsLoading(false);
  }, [id]);

  useEffect(() => {
    setContact(null);
    setPatients([]);
    setSelectedStage('');
    const requestedTab = new URLSearchParams(location.search).get('tab');
    const normalizedTab = requestedTab === 'deals' ? 'appointments' : requestedTab;
    setActiveTab(['overview', 'details', 'patients', 'appointments', 'activity', 'notes'].includes(normalizedTab) ? normalizedTab : 'overview');
    load();
    return () => { loadRequestRef.current += 1; };
  }, [id, location.search, load]);

  const updateStage = async (stage) => {
    if (!contact || savingStatus) return;
    const previousStage = currentStage;
    if (
      currentStage === stage.key &&
      contact.lifecycleStageKey === stage.key &&
      contact.status === stage.status
    ) return;
    setSelectedStage(stage.key);
    setSavingStatus(true);
    try {
      const updated = await fetchApi(`/api/contacts/${contact.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          status: stage.status,
          lifecycleStageKey: stage.key,
          ...(stage.status === 'Churned' ? { lifecycleTransitionReason: `Patient journey status: ${stage.label}` } : {}),
        }),
      });
      setContact((current) => ({ ...current, ...updated, status: updated?.status || stage.status, lifecycleStageKey: updated?.lifecycleStageKey || stage.key }));
      if (stage.status === 'Customer') {
        const linkedPatients = await fetchLinkedPatients(id).catch(() => null);
        if (linkedPatients) {
          const nextPatients = getList(linkedPatients);
          setPatients(nextPatients);
        }
      }
      notify.success('Lead stage updated.');
    } catch (requestError) {
      setSelectedStage(previousStage);
      notify.error(requestError?.body?.error || 'Unable to update the lead stage.');
    } finally {
      setSavingStatus(false);
    }
  };

  const addNote = async (event) => {
    event.preventDefault();
    const description = noteDraft.trim();
    if (!description || savingNote) return;
    setSavingNote(true);
    try {
      const result = await fetchApi(`/api/contacts/${contact.id}/activities`, {
        method: 'POST',
        body: JSON.stringify({ type: 'Note', description }),
      });
      const saved = result?.id ? result : {
        id: `note-${Date.now()}`,
        type: 'Note',
        description,
        createdAt: new Date().toISOString(),
      };
      setActivities((current) => [saved, ...current]);
      setNoteDraft('');
      notify.success('Note added.');
    } catch (requestError) {
      notify.error(requestError?.body?.error || 'Unable to save the note.');
    } finally {
      setSavingNote(false);
    }
  };

  const saveContactDetailsField = async (field, value) => {
    let patch;
    if (field.custom) {
      patch = { customFields: { [field.key]: value } };
    } else if (field.key === 'firstName' || field.key === 'lastName') {
      const parts = String(contact.name || '').trim().split(/\s+/).filter(Boolean);
      const firstName = field.key === 'firstName' ? value : (contact.firstName || parts[0] || '');
      const lastName = field.key === 'lastName' ? value : (contact.lastName || parts.slice(1).join(' '));
      patch = { name: [firstName, lastName].filter(Boolean).join(' ') };
    } else if (field.key === 'tags') {
      patch = { tags: value };
    } else {
      patch = { [field.key]: value };
    }
    try {
      const updated = await fetchApi(`/api/contacts/${contact.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setContact((current) => ({
        ...current,
        ...updated,
        ...(patch.customFields ? { customFields: { ...(current?.customFields || {}), ...patch.customFields } } : {}),
      }));
      notify.success('Lead details saved.');
    } catch (requestError) {
      notify.error(requestError?.body?.error || 'Could not save lead details.');
      throw requestError;
    }
  };

  const changeOwner = async (assignedToId) => {
    const nextId = assignedToId ? Number(assignedToId) : null;
    try {
      const updated = await fetchApi(`/api/contacts/${contact.id}/assign`, {
        method: 'PUT',
        body: JSON.stringify({ assignedToId: nextId }),
      });
      setContact((current) => ({ ...current, ...updated }));
      notify.success('Assigned staff updated.');
    } catch (requestError) {
      notify.error(requestError?.body?.error || 'Could not update assigned staff.');
      throw requestError;
    }
  };

  const handleDetailsAction = (action) => {
    if (action === 'note') setActiveTab('notes');
    else if (action === 'activities') setActiveTab('activity');
    else if (action === 'task') navigate('/tasks');
    else if (action === 'email' && contact.email) window.location.href = `mailto:${contact.email}`;
    else if (action === 'call' && contact.phone) window.location.href = `tel:${contact.phone}`;
  };

  if (loading) return <div className="wellness-lead-state" role="status">Loading lead profile…</div>;
  if (error || !contact) {
    return (
      <div className="wellness-lead-state" role="alert">
        <strong>{error || 'Lead not found.'}</strong>
        <Link to={backTo}><ArrowLeft size={14} /> Back to Leads</Link>
      </div>
    );
  }

  const tabItems = [
    { id: 'overview', label: 'Overview', icon: UserRound },
    { id: 'details', label: 'All details', icon: FileText },
    { id: 'patients', label: `Patient records${patients.length ? ` (${patients.length})` : ''}`, icon: HeartPulse },
    { id: 'appointments', label: 'Appointments', icon: CalendarDays },
    { id: 'activity', label: 'Activity', icon: Activity },
    { id: 'notes', label: 'Notes', icon: StickyNote },
  ];

  return (
    <main className="wellness-lead-page">
      <Link className="wellness-lead-back" to={backTo} state={location.state}>
        <ArrowLeft size={15} /> Back to Leads
      </Link>

      <header className="wellness-lead-header">
        <div className="wellness-lead-identity">
          <div className="wellness-lead-avatar" aria-hidden="true">{getInitials(contact.name)}</div>
          <div className="wellness-lead-heading">
            <div className="wellness-lead-eyebrow">Wellness lead profile</div>
            <h1>{contact.name || 'Patient lead'}</h1>
            <div className="wellness-lead-subtitle">
              {contact.email && <a href={`mailto:${contact.email}`}><Mail size={13} /> {contact.email}</a>}
              {contact.phone && <a href={`tel:${contact.phone}`}><Phone size={13} /> {contact.phone}</a>}
              {!contact.email && !contact.phone && <span>Contact details not provided</span>}
            </div>
          </div>
          <span className="wellness-lead-status">{currentStageLabel}</span>
        </div>
        <div className="wellness-lead-actions">
          <button className="wellness-lead-button" type="button" onClick={() => setEditing(true)}><Edit3 size={15} /> Edit lead</button>
          {contact.email && <a className="wellness-lead-button" href={`mailto:${contact.email}`}><Mail size={15} /> Email</a>}
        </div>
      </header>

      <section className="wellness-lead-card wellness-lead-lifecycle" aria-label="Lead lifecycle">
        <div className="wellness-lead-section-heading">
          <div><strong>Patient journey</strong><span>Update this lead’s current stage</span></div>
          {savingStatus && <span role="status">Saving…</span>}
        </div>
        <div className="wellness-lead-flow" role="group" aria-label="Patient journey stages">
          <div className="wellness-lead-primary-flow">
            {WELLNESS_PRIMARY_STAGES.map((stage, index) => {
              const alternative = WELLNESS_ALTERNATIVE_STAGES.find((item) => item.choiceFor === stage.key);
              const selectedAlternative = currentAlternative?.choiceFor === stage.key ? currentAlternative : null;
              const isCurrent = currentStage === stage.key || Boolean(selectedAlternative);
              const isComplete = currentAlternative ? index <= completedThrough : index < currentPrimaryIndex;
              const menuOpen = openStageMenu === stage.key;
              return (
                <div
                  className={`wellness-lead-stage-segment${isCurrent ? ' is-current' : ''}${isComplete ? ' is-complete' : ''}${menuOpen ? ' is-menu-open' : ''}`}
                  key={stage.key}
                  style={{ zIndex: menuOpen ? 20 : index + 1 }}
                >
                  <button
                    type="button"
                    className="wellness-lead-stage-main"
                    aria-current={isCurrent ? 'step' : undefined}
                    disabled={savingStatus}
                    onClick={() => { setOpenStageMenu(''); updateStage(stage); }}
                  >
                    <span>{stage.label}</span>
                    {selectedAlternative && <small>{selectedAlternative.label}</small>}
                  </button>
                  {alternative && (
                    <div className="wellness-lead-stage-menu-anchor">
                      <button
                        type="button"
                        className="wellness-lead-stage-menu-toggle"
                        aria-label={`Choose status for ${stage.label}`}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        disabled={savingStatus}
                        onClick={() => setOpenStageMenu((current) => current === stage.key ? '' : stage.key)}
                      >
                        <ChevronDown size={13} />
                      </button>
                      {menuOpen && (
                        <div className="wellness-lead-stage-menu" role="menu" aria-label={`Choose status for ${stage.label}`}>
                          <span>Choose status</span>
                          {[stage, alternative].map((option) => (
                            <button
                              type="button"
                              role="menuitem"
                              key={option.key}
                              aria-current={currentStage === option.key ? 'step' : undefined}
                              disabled={savingStatus}
                              onClick={() => { setOpenStageMenu(''); updateStage(option); }}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <div className="wellness-lead-workspace">
        <aside className="wellness-lead-sidebar">
          <section className="wellness-lead-card wellness-lead-contact-card">
            <h2>Lead information</h2>
            <InfoRow label="Email" value={contact.email} />
            <InfoRow label="Phone" value={contact.phone} />
            <InfoRow label="Treatment interest" value={contact.treatmentOfInterest} />
            <InfoRow label="Preferred clinic" value={locations.find((item) => Number(item.id) === Number(contact.preferredLocationId))?.name || (contact.preferredLocationId ? `Clinic #${contact.preferredLocationId}` : null)} />
            <InfoRow label="Preferred practitioner" value={staff.find((item) => Number(item.id) === Number(contact.preferredPractitionerId))?.name || (contact.preferredPractitionerId ? `Practitioner #${contact.preferredPractitionerId}` : null)} />
            <InfoRow label="Source" value={contact.source} />
            <InfoRow label="Assigned staff" value={contact.assignedTo?.name || contact.assignedTo?.email} />
            <InfoRow label="Company" value={contact.company} />
            <InfoRow label="Job title" value={contact.title} />
            <InfoRow label="First touch" value={contact.firstTouchSource} />
            <InfoRow label="Last touch" value={contact.lastTouchSource} />
            <InfoRow label="Created" value={formatDate(contact.createdAt)} />
            <InfoRow label="Lead score" value={contact.aiScore != null ? `${contact.aiScore}/100` : null} />
          </section>
          <section className="wellness-lead-card wellness-lead-summary-card">
            <h2>Patient summary</h2>
            <div className="wellness-lead-summary-grid">
              <SummaryTile label="Linked records" value={patientsLoading ? '…' : patients.length} />
              <SummaryTile label="Upcoming appointments" value={appointments.length} />
              <SummaryTile label="Patient status" value={currentStageLabel} />
              <SummaryTile label="Lead score" value={contact.aiScore != null ? `${contact.aiScore}/100` : '—'} />
            </div>
          </section>
        </aside>

        <section className="wellness-lead-card wellness-lead-main-card">
          <nav className="wellness-lead-tabs" aria-label="Lead details">
            {tabItems.map(({ id: tabId, label, icon: Icon }) => (
              <button key={tabId} className={activeTab === tabId ? 'is-active' : ''} type="button" onClick={() => setActiveTab(tabId)}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </nav>

          {activeTab === 'overview' && (
            <div className="wellness-lead-tab-content">
              <section className="wellness-lead-overview-block">
                <div className="wellness-lead-block-heading"><div><span className="wellness-lead-overline">Wellness intake</span><h2>Lead summary</h2></div><button className="wellness-lead-link-button" type="button" onClick={() => setEditing(true)}>Edit details</button></div>
                <div className="wellness-lead-overview-grid">
                  <InfoCard label="Treatment of interest" value={contact.treatmentOfInterest} />
                  <InfoCard label="Email" value={contact.email} />
                  <InfoCard label="Phone" value={contact.phone} />
                  <InfoCard label="Source" value={contact.source} />
                  <InfoCard label="Assigned staff" value={contact.assignedTo?.name || contact.assignedTo?.email} />
                  <InfoCard label="Preferred clinic" value={locations.find((item) => Number(item.id) === Number(contact.preferredLocationId))?.name || (contact.preferredLocationId ? `Clinic #${contact.preferredLocationId}` : null)} />
                  <InfoCard label="Preferred practitioner" value={staff.find((item) => Number(item.id) === Number(contact.preferredPractitionerId))?.name || (contact.preferredPractitionerId ? `Practitioner #${contact.preferredPractitionerId}` : null)} />
                  <InfoCard label="First touch" value={contact.firstTouchSource} />
                  <InfoCard label="Last touch" value={contact.lastTouchSource} />
                  <InfoCard label="Created" value={formatDateTime(contact.createdAt)} />
                </div>
              </section>

              <section className="wellness-lead-overview-block">
                <div className="wellness-lead-block-heading"><div><span className="wellness-lead-overline">Linked clinical records</span><h2>Patients</h2></div></div>
                {patientsLoading ? <div className="wellness-lead-empty">Loading linked patient records…</div> : patients.length ? (
                  <div className="wellness-lead-patient-list">
                    {patients.slice(0, 3).map((patient) => <PatientMiniCard key={patient.id} patient={patient} onOpen={() => setActiveTab('patients')} />)}
                    {patients.length > 3 && <p className="wellness-lead-muted">And {patients.length - 3} more linked patient records.</p>}
                  </div>
                ) : (
                  <div className="wellness-lead-empty">No patient record is linked to this lead yet. Linked patient charts will appear here.</div>
                )}
                {patientAccessError && <p className="wellness-lead-inline-error" role="alert">{patientAccessError}</p>}
              </section>

              <section className="wellness-lead-overview-block">
                <div className="wellness-lead-block-heading"><div><span className="wellness-lead-overline">Care schedule</span><h2>Next appointments</h2></div><button className="wellness-lead-link-button" type="button" onClick={() => setActiveTab('appointments')}><CalendarDays size={14} /> View appointments</button></div>
                <AppointmentList appointments={appointments.slice(0, 4)} contactName={contact.name} patients={patients} />
              </section>
            </div>
          )}

          {activeTab === 'details' && (
            <div className="wellness-lead-tab-content wellness-lead-full-details">
              <ContactDetailsDrawer inline contact={contact} staff={staff} locations={locations} hideSms hideAppointmentActions wellnessLeadView onOwnerChange={canAssignOwner ? changeOwner : undefined} onFieldSave={saveContactDetailsField} onAction={handleDetailsAction} />
            </div>
          )}

          {activeTab === 'patients' && (
            <div className="wellness-lead-tab-content">
              <div className="wellness-lead-block-heading"><div><span className="wellness-lead-overline">Patient record overview</span><h2>Linked patients</h2></div><span className="wellness-lead-record-count">{patientsLoading ? 'Loading…' : `${patients.length} record${patients.length === 1 ? '' : 's'}`}</span></div>
              {patientAccessError && <div className="wellness-lead-inline-error" role="alert">{patientAccessError}</div>}
              {patientsLoading ? <div className="wellness-lead-empty">Loading patient records…</div> : patients.length ? (
                <>
                  <div className="wellness-lead-record-list">
                    {patients.map((patient) => (
                      <article className="wellness-lead-record-card" key={patient.id}>
                        <div className="wellness-lead-patient-avatar">{getInitials(patient.displayName || patient.name)}</div>
                        <div className="wellness-lead-record-main">
                          <strong>{patient.displayName || patient.name || 'Patient'}</strong>
                          <span>{patient.source ? `Source: ${patient.source}` : 'Linked patient record'}{patient.lastVisitDate ? ` · Last visit ${formatDate(patient.lastVisitDate)}` : ''}</span>
                        </div>
                        <Link className="wellness-lead-button" to={`/wellness/patients/${patient.id}`}><FileText size={14} /> Open patient chart</Link>
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <div className="wellness-lead-empty wellness-lead-empty-panel"><HeartPulse size={24} /><strong>No linked patient records</strong><span>Linked patient summaries will appear here. Full clinical details remain available from the patient directory.</span><Link to="/wellness/patients">Open patient directory</Link></div>
              )}
            </div>
          )}

          {activeTab === 'appointments' && (
            <div className="wellness-lead-tab-content">
              <div className="wellness-lead-block-heading"><div><span className="wellness-lead-overline">Care schedule</span><h2>Upcoming appointments</h2></div></div>
              <AppointmentList appointments={appointments} contactName={contact.name} patients={patients} />
              {patients.length > 0 && <p className="wellness-lead-muted">Completed visits and the full visit history are available in each patient’s chart under Patient records.</p>}
            </div>
          )}

          {activeTab === 'activity' && (
            <div className="wellness-lead-tab-content">
              <div className="wellness-lead-block-heading"><div><span className="wellness-lead-overline">Lead history</span><h2>Activities</h2></div></div>
              <ActivityList activities={otherActivities} />
            </div>
          )}

          {activeTab === 'notes' && (
            <div className="wellness-lead-tab-content">
              <div className="wellness-lead-block-heading"><div><span className="wellness-lead-overline">Care team notes</span><h2>Notes</h2></div></div>
              <form className="wellness-lead-note-composer" onSubmit={addNote}>
                <label className="wellness-lead-sr-only" htmlFor="wellness-lead-note">Add a note</label>
                <textarea id="wellness-lead-note" rows={3} value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Add a note about this lead or follow-up…" />
                <button className="wellness-lead-button wellness-lead-button-primary" type="submit" disabled={!noteDraft.trim() || savingNote}>{savingNote ? 'Saving…' : <><Plus size={15} /> Add note</>}</button>
              </form>
              <ActivityList activities={noteActivities} empty="No notes have been added yet." />
            </div>
          )}
        </section>
      </div>

      {editing && <EditContactModal contact={contact} customFieldDefs={[]} onClose={() => setEditing(false)} onSaved={(updated) => { setContact((current) => ({ ...current, ...updated })); setEditing(false); }} />}
    </main>
  );
}

function InfoRow({ label, value }) {
  return <div className="wellness-lead-info-row"><span>{label}</span><strong>{display(value)}</strong></div>;
}

function InfoCard({ label, value }) {
  return <div className="wellness-lead-info-card"><span>{label}</span><strong>{display(value)}</strong></div>;
}

function SummaryTile({ label, value }) {
  return <div className="wellness-lead-summary-tile"><span>{label}</span><strong>{value}</strong></div>;
}

function PatientMiniCard({ patient, onOpen }) {
  const context = [
    patient.source ? `Source: ${patient.source}` : null,
    patient.lastVisitDate ? `Last visit: ${formatDate(patient.lastVisitDate)}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <button className="wellness-lead-patient-mini" type="button" onClick={onOpen} aria-label={`Open chart for ${patient.displayName || patient.name || 'patient'}`}>
      <div className="wellness-lead-patient-avatar">{getInitials(patient.displayName || patient.name)}</div>
      <div className="wellness-lead-patient-mini-main">
        <strong>{patient.displayName || patient.name || 'Patient'}</strong>
        <span>{context || 'View linked patient record'}</span>
      </div>
    </button>
  );
}

function AppointmentList({ appointments, contactName, patients = [] }) {
  if (!appointments.length) return <div className="wellness-lead-empty">No upcoming appointments for {contactName}.</div>;
  return (
    <div className="wellness-lead-appointment-list">
      {appointments.map((appointment) => {
        const patient = patients.find((item) => Number(item.id) === Number(appointment.patientId));
        const patientName = patient?.displayName || patient?.name;
        return (
          <article className="wellness-lead-appointment" key={appointment.id}>
            <div className="wellness-lead-appointment-icon"><CalendarDays size={17} /></div>
            <div className="wellness-lead-appointment-main"><strong>{appointment.serviceName || 'General appointment'}</strong><span>{patientName ? `${patientName} · ` : ''}{appointment.doctorName || 'Practitioner pending'} · {formatDateTime(appointment.appointmentDate)}</span>{appointment.reason && <small>{appointment.reason}</small>}</div>
            <span className="wellness-lead-appointment-status">{display(appointment.status)}</span>
          </article>
        );
      })}
    </div>
  );
}

function ActivityList({ activities, empty = 'No activities recorded yet.' }) {
  if (!activities.length) return <div className="wellness-lead-empty">{empty}</div>;
  return (
    <div className="wellness-lead-activity-list">
      {activities.map((activity) => (
        <article className="wellness-lead-activity" key={activity.id}>
          <div className="wellness-lead-activity-icon">{activity.type === 'Note' ? <StickyNote size={16} /> : <ClipboardList size={16} />}</div>
          <div><strong>{activity.type || 'Activity'}</strong><p>{activity.description || 'No description'}</p><small>{activity.user?.name || activity.user?.email || 'System'} · {formatDateTime(activity.createdAt)}</small></div>
        </article>
      ))}
    </div>
  );
}
