import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, Edit3, PenLine, Plus, StickyNote, Trash2, X } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import EditContactModal from "../../components/EditContactModal";

const STAGES = ["Lead", "Prospect", "Customer"];
const TERMINAL_STAGES = ["Churned", "Junk"];
const RUPEE = "\u20B9";
const ARROW = "\u2192";
const formatDate = (value) => value ? new Date(value).toLocaleDateString() : "";
const formatDateTime = (value) => value ? new Date(value).toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const formatMoney = (value, currency = "INR") => value == null || value === "" ? "" : (currency === "INR" ? RUPEE : currency + " ") + Number(value).toLocaleString();
const formatStatus = (value) => value ? String(value).replaceAll("_", " ") : "";

export default function LeadDetail() {
  const { contactId } = useParams(); const location = useLocation(); const navigate = useNavigate();
  const notify = useNotify();
  const [contact, setContact] = useState(null); const [contactError, setContactError] = useState(""); const [trips, setTrips] = useState([]); const [quotes, setQuotes] = useState([]); const [itineraries, setItineraries] = useState([]); const [activities, setActivities] = useState([]); const [paidAmounts, setPaidAmounts] = useState({}); const [tab, setTab] = useState("Trips"); const [editing, setEditing] = useState(false); const [note, setNote] = useState(""); const [editingNoteId, setEditingNoteId] = useState(null);
  const noteInputRef = useRef(null);
  const backTo = location.state?.backTo || "/leads"; const backLabel = location.state?.backLabel || "Back to Leads";
  useEffect(() => {
    let mounted = true;
    setContact(null);
    setContactError("");
    setPaidAmounts({});

    const load = async () => {
      try {
        const [contactData, tripData, quoteData, itineraryData, activityData] = await Promise.all([
          fetchApi("/api/contacts/" + contactId),
          fetchApi("/api/travel/trips?contactId=" + contactId + "&limit=100&includeQuoteTrips=true").catch(() => ({ trips: [] })),
          fetchApi("/api/travel/quotes?contactId=" + contactId + "&limit=100").catch(() => ({ quotes: [] })),
          fetchApi("/api/travel/itineraries?contactId=" + contactId + "&limit=100").catch(() => ({ itineraries: [] })),
          fetchApi("/api/contacts/" + contactId + "/activities?limit=100").catch(() => ({ data: [] })),
        ]);
        if (!mounted) return;

        const linkedTrips = Array.isArray(tripData?.trips) ? tripData.trips : [];
        const contactEmail = String(contactData?.email || "").trim().toLowerCase();
        const paidEntries = await Promise.all(linkedTrips.map(async (trip) => {
          const isTeacher = Number(trip.teacherContactId) === Number(contactId);
          const instalmentsRequest = fetchApi(`/api/travel/trips/${trip.id}/instalments`, { silent: true })
            .then((response) => ({ ok: true, response }))
            .catch(() => ({ ok: false }));
          const participantsRequest = isTeacher
            ? Promise.resolve({ ok: true, response: { participants: [] } })
            : fetchApi(`/api/travel/trips/${trip.id}/participants`, { silent: true })
              .then((response) => ({ ok: true, response }))
              .catch(() => ({ ok: false }));
          const [instalmentsResult, participantsResult] = await Promise.all([instalmentsRequest, participantsRequest]);
          if (!instalmentsResult.ok || !Array.isArray(instalmentsResult.response?.instalments)) return null;

          const participantIds = isTeacher
            ? null
            : new Set((Array.isArray(participantsResult.response?.participants) ? participantsResult.response.participants : [])
              .filter((participant) => String(participant.parentEmail || "").trim().toLowerCase() === contactEmail)
              .map((participant) => Number(participant.id)));
          const paid = instalmentsResult.response.instalments.reduce((sum, instalment) => {
            if (participantIds && !participantIds.has(Number(instalment.participantId))) return sum;
            return sum + (Number(instalment.paidAmount) || 0);
          }, 0);
          return [`trip:${trip.id}`, paid];
        }));
        const itineraryRows = Array.isArray(itineraryData?.itineraries) ? itineraryData.itineraries : [];
        const itineraryEntries = itineraryRows
          .filter((itinerary) => itinerary.advancePaidAmount != null)
          .map((itinerary) => [`itinerary:${itinerary.id}`, Number(itinerary.advancePaidAmount) || 0]);

        setContact(contactData);
        setTrips(linkedTrips);
        setQuotes(Array.isArray(quoteData?.quotes) ? quoteData.quotes : []);
        setItineraries(itineraryRows);
        setActivities(Array.isArray(activityData?.data) ? activityData.data : []);
        setPaidAmounts(Object.fromEntries([...paidEntries.filter(Boolean), ...itineraryEntries]));
      } catch (error) {
        if (!mounted) return;
        setContactError(error?.body?.error || "Unable to load this lead.");
      }
    };

    load();
    return () => { mounted = false; };
  }, [contactId]);
  useEffect(() => {
    if (editingNoteId && tab === "Notes") noteInputRef.current?.focus();
  }, [editingNoteId, tab]);
  // Teachers manage the whole group, while student/parent contacts see their
  // individual amount. The API marks teacher-linked trips with teacherContactId.
  const allTrips = useMemo(() => trips.map((trip) => {
    const isTeacher = Number(trip.teacherContactId) === Number(contactId);
    return { ...trip, idLabel: trip.tripCode || trip.id, startDate: trip.departDate, endDate: trip.returnDate, value: isTeacher ? (trip.totalTripValue ?? trip.perStudentAmount ?? trip.pricePerStudent) : (trip.perStudentAmount ?? trip.pricePerStudent ?? trip.totalTripValue), paidAmount: paidAmounts[`trip:${trip.id}`] ?? null, type: "TMC" };
  }), [trips, contactId, paidAmounts]);
  const otherTrips = useMemo(() => quotes.map((quote) => ({
    id: `quote-${quote.id}`,
    idLabel: `Quote Q-${quote.id}`,
    destination: quote.destination || quote.title || (quote.subBrand ? `${String(quote.subBrand).toUpperCase()} travel` : "Travel quote"),
    startDate: quote.tripDate,
    endDate: null,
    value: quote.totalAmount,
    paidAmount: quote.paidAmount ?? quote.advancePaidAmount ?? null,
    currency: quote.currency,
    status: quote.status,
    type: quote.subBrand ? String(quote.subBrand).toUpperCase() : "Travel",
    isOtherTrip: true,
  })).concat(itineraries.map((itinerary) => ({
    id: `itinerary-${itinerary.id}`,
    idLabel: `Itinerary #${itinerary.id}`,
    destination: itinerary.destination || "Itinerary",
    startDate: itinerary.startDate,
    endDate: itinerary.endDate,
    value: itinerary.totalAmount,
    paidAmount: paidAmounts[`itinerary:${itinerary.id}`] ?? (itinerary.advancePaidAmount != null ? Number(itinerary.advancePaidAmount) || 0 : null),
    currency: itinerary.currency,
    status: itinerary.status,
    type: itinerary.subBrand ? String(itinerary.subBrand).toUpperCase() : "Itinerary",
    isOtherTrip: true,
  }))), [quotes, itineraries, paidAmounts]);
  const displayTrips = useMemo(() => [...allTrips, ...otherTrips], [allTrips, otherTrips]);
  const notes = activities.filter((activity) => activity.type === "Note");
  const totalValue = allTrips.reduce((sum, trip) => sum + (Number(trip.value) || 0), 0); const activeTrip = allTrips.find((trip) => !["completed", "cancelled"].includes(String(trip.status).toLowerCase())) || allTrips[0];
  const moveStage = async (stage) => { if (!contact || contact.status === stage) return; const updated = await fetchApi("/api/contacts/" + contact.id, { method: "PUT", body: JSON.stringify({ status: stage }) }); setContact((current) => ({ ...current, ...updated, status: updated?.status || stage })); };
  const addNote = async () => {
    const description = note.trim();
    if (!description) return;
    const endpoint = "/api/contacts/" + contact.id + "/activities";
    const response = await fetchApi(editingNoteId ? `${endpoint}/${editingNoteId}` : endpoint, {
      method: editingNoteId ? "PATCH" : "POST",
      body: JSON.stringify({ ...(editingNoteId ? {} : { type: "Note" }), description }),
    });
    if (editingNoteId) {
      setActivities((current) => current.map((item) => item.id === editingNoteId ? { ...item, ...response, description } : item));
    } else {
      const activity = response?.id ? response : { id: `local-note-${Date.now()}`, type: "Note", description, createdAt: new Date().toISOString() };
      setActivities((current) => [activity, ...current]);
    }
    setNote("");
    setEditingNoteId(null);
  };
  const editNote = (activity) => { setEditingNoteId(activity.id); setNote(activity.description || ""); setTab("Notes"); };
  const deleteNote = async (activity) => {
    const confirmed = await notify.confirm({
      message: "Delete this note?",
      confirmText: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    await fetchApi(`/api/contacts/${contact.id}/activities/${activity.id}`, { method: "DELETE" });
    setActivities((current) => current.filter((item) => item.id !== activity.id));
  };
  if (contactError) return <div className="travel-lead-detail-page"><div className="travel-lead-error" role="alert"><strong>{contactError}</strong><Link to={backTo}>Back to Leads</Link></div></div>;
  if (!contact) return <div className="travel-lead-detail-loading" role="status">Loading lead…</div>;
  const initials = String(contact.name || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); const stageIndex = STAGES.findIndex((stage) => stage.toLowerCase() === String(contact.status || "Lead").toLowerCase());
  const summary = [["Total trips", allTrips.length], ["Lifetime value", formatMoney(totalValue)], ["Upcoming", allTrips.filter((trip) => trip.startDate && new Date(trip.startDate) >= new Date()).length], ["Open quotes", quotes.length]];
  return <div className="travel-lead-detail-page">
    <Link className="travel-lead-back" to={backTo}><ArrowLeft size={14} /> {backLabel}</Link>
    <header className="travel-lead-header"><div className="travel-lead-identity"><div className="travel-lead-avatar">{initials}</div><div><h1>{contact.name || "Contact"}</h1><div className="travel-lead-subtitle">{contact.company || ""} · {contact.email || ""}</div></div><span className="travel-lead-badge">{contact.status || "Lead"}</span></div><div className="travel-lead-actions"><button className="travel-lead-button" type="button" onClick={() => setEditing(true)}><Edit3 size={14} /> Edit contact</button><button className="travel-lead-button" type="button" onClick={() => navigate("/travel/quotes/builder", { state: { contactId: contact.id } })}>Create quote</button><button className="travel-lead-button travel-lead-button-primary" type="button" onClick={() => navigate("/travel/trips", { state: { contactId: contact.id } })}><Plus size={15} /> New trip</button></div></header>
    <section className="travel-lead-card travel-lead-lifecycle-card"><div className="travel-lead-section-heading"><strong>Lifecycle stage</strong><span>Click a stage to move this travel lead</span></div><div className="travel-lead-lifecycle">{STAGES.map((stage, index) => <button type="button" key={stage} onClick={() => moveStage(stage)} className={`travel-lead-lifecycle-button${index === stageIndex ? " is-active" : ""}`}><span>Step {index + 1}</span><strong>{stage}</strong></button>)}<div className="travel-lead-lifecycle-terminals">{TERMINAL_STAGES.map((stage) => <button className="travel-lead-lifecycle-button" type="button" key={stage} onClick={() => moveStage(stage)}>{stage}</button>)}</div></div></section>
    <div className="travel-lead-content"><aside className="travel-lead-sidebar"><section className="travel-lead-card travel-lead-info-card"><h2>Contact information</h2>{[["Email", contact.email], ["Phone", contact.phone], ["Company", contact.company], ["Source", contact.source], ["Lead score", contact.aiScore != null ? contact.aiScore + "/100" : ""], ["Created", formatDate(contact.createdAt)]].map(([name, value]) => <div className="travel-lead-info-row" key={name}><span>{name}</span><strong>{value || "—"}</strong></div>)}<label className="travel-lead-assignee">Assigned to<select defaultValue={contact.assignedTo?.id || contact.assignedToId || ""}><option value="">Unassigned</option><option value={contact.assignedTo?.id || contact.assignedToId || "current"}>{contact.assignedTo?.name || "Current owner"}</option></select><ChevronDown size={15} /></label></section><section className="travel-lead-card travel-lead-summary-card"><h2>Trip summary</h2><div className="travel-lead-summary-grid">{summary.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></section></aside>
      <main className="travel-lead-main"><nav className="travel-lead-tabs">{["Trips", "Quotes", "Activity", "Notes"].map((name) => <button className={tab === name ? "is-active" : ""} type="button" key={name} onClick={() => setTab(name)}>{name}</button>)}</nav>
        {tab === "Trips" && <><TripHero trip={activeTrip} onViewTrip={() => navigate(`/travel/trips/${activeTrip.id}`, { state: { backTo: `/travel/leads/${contactId}`, backLabel: "Back to Lead" } })} /><section className="travel-lead-trips"><h2>All trips</h2><div className="travel-lead-table-wrap"><table><thead><tr>{["Trip", "Destination", "Dates", "Type", "Value", "Paid amount", "Status"].map((name) => <th key={name}>{name}</th>)}</tr></thead><tbody>{displayTrips.length ? displayTrips.map((trip) => <tr key={trip.id}><td><strong>{trip.idLabel}</strong></td><td>{trip.destination || ""}</td><td>{formatDate(trip.startDate)} {trip.endDate ? `${ARROW} ${formatDate(trip.endDate)}` : ""}</td><td>{trip.type}</td><td>{formatMoney(trip.value, trip.currency)}</td><td>{formatMoney(trip.paidAmount, trip.currency)}</td><td>{formatStatus(trip.status)}</td></tr>) : <tr><td colSpan="7">No travel trips linked to this contact.</td></tr>}</tbody></table></div></section></>}
        {tab === "Quotes" && quotes.map((quote) => <div className="travel-lead-empty-row" key={quote.id}>Quote Q-{quote.id} — {formatMoney(quote.totalAmount, quote.currency)} — {formatStatus(quote.status)}</div>)}
        {tab === "Activity" && activities.map((activity) => <div className="travel-lead-empty-row" key={activity.id}>{activity.type}: {activity.description || ""}</div>)}
        {tab === "Notes" && <section className="travel-lead-notes" aria-label="Notes">
          <div className="travel-lead-note-composer">
            <div className="travel-lead-note-input-wrap">
              <StickyNote size={20} aria-hidden />
              <input ref={noteInputRef} className={editingNoteId ? "is-editing" : ""} aria-label={editingNoteId ? "Edit note" : "Write a note"} value={note} onChange={(event) => setNote(event.target.value)} placeholder={editingNoteId ? "Editing this note..." : "Write a note about this contact..."} />
            </div>
            <button className="travel-lead-button travel-lead-button-primary travel-lead-add-note-button" type="button" onClick={addNote}>{editingNoteId ? "Save Note" : <><Plus size={19} aria-hidden /> Add Note</>}</button>
            {editingNoteId && <button className="travel-lead-note-cancel" type="button" onClick={() => { setEditingNoteId(null); setNote(""); }} aria-label="Cancel note edit"><X size={18} /></button>}
          </div>
          <div className="travel-lead-note-list">
            {notes.map((activity) => <article className="travel-lead-note-card" key={activity.id}>
              <div className="travel-lead-note-avatar">{String(contact.name || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</div>
              <div className="travel-lead-note-content"><div className="travel-lead-note-meta"><strong>{activity.user?.name || "You"}</strong><span>•</span><time>{formatDateTime(activity.createdAt)}</time></div><div>{activity.description || ""}</div></div>
              <div className="travel-lead-note-actions"><button type="button" aria-label={`Edit note ${activity.description || activity.id}`} onClick={() => editNote(activity)}><PenLine size={17} /></button><button type="button" aria-label={`Delete note ${activity.description || activity.id}`} onClick={() => deleteNote(activity)}><Trash2 size={17} /></button></div>
            </article>)}
            {!notes.length && <div className="travel-lead-empty-row">No notes yet.</div>}
          </div>
        </section>}
      </main></div>
    {editing && <EditContactModal contact={contact} customFieldDefs={[]} onClose={() => setEditing(false)} onSaved={(updated) => { setContact((current) => ({ ...current, ...updated })); setEditing(false); }} />}
  </div>;
}

function TripHero({ trip, onViewTrip }) {
  if (!trip) return <div className="travel-lead-card travel-lead-empty-row">No active travel trip yet. Create a quote or trip to start the journey.</div>;
  const current = String(trip.status || "").toLowerCase(); const progress = current === "completed" ? 4 : ["confirmed", "booked"].includes(current) ? 1 : 0; const steps = ["Quote accepted", "Booked", "Docs & visa", "Travelling", "Completed"];
  return <section className="travel-lead-card travel-lead-trip-hero"><button className="travel-lead-button travel-lead-itinerary-button" type="button" onClick={onViewTrip}>View trip</button><div className="travel-lead-trip-label">ACTIVE TRIP · {trip.idLabel}</div><h2>{trip.destination || "Travel trip"}</h2><div className="travel-lead-trip-meta">{formatDate(trip.startDate)} {ARROW} {formatDate(trip.endDate)} · {trip.type}</div><div className="travel-lead-trip-progress">{steps.map((step, index) => <div key={step}><div className={index <= progress ? "is-complete" : ""} /><small>{step}</small></div>)}</div><div className="travel-lead-trip-details"><span>Documents<strong>{trip.documentsConfigured ? "Configured" : "None configured"}</strong></span><span>Payment<strong>{trip.paymentPlan ? "Plan configured" : "Not configured"}</strong></span></div></section>;
}
