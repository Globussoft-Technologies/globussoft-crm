import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, Edit3, Plus } from "lucide-react";
import { fetchApi } from "../../utils/api";
import EditContactModal from "../../components/EditContactModal";

const STAGES = ["Lead", "Prospect", "Customer"];
const TERMINAL_STAGES = ["Churned", "Junk"];
const RUPEE = "\u20B9";
const ARROW = "\u2192";
const formatDate = (value) => value ? new Date(value).toLocaleDateString() : "";
const formatMoney = (value, currency = "INR") => value == null || value === "" ? "" : (currency === "INR" ? RUPEE : currency + " ") + Number(value).toLocaleString();
const formatStatus = (value) => value ? String(value).replaceAll("_", " ") : "";

export default function LeadDetail() {
  const { contactId } = useParams(); const location = useLocation(); const navigate = useNavigate();
  const [contact, setContact] = useState(null); const [contactError, setContactError] = useState(""); const [trips, setTrips] = useState([]); const [quotes, setQuotes] = useState([]); const [itineraries, setItineraries] = useState([]); const [activities, setActivities] = useState([]); const [tab, setTab] = useState("Trips"); const [editing, setEditing] = useState(false); const [note, setNote] = useState("");
  const backTo = location.state?.backTo || "/leads"; const backLabel = location.state?.backLabel || "Back to Leads";
  useEffect(() => { let mounted = true; setContact(null); setContactError(""); Promise.all([fetchApi("/api/contacts/" + contactId), fetchApi("/api/travel/trips?contactId=" + contactId + "&limit=100&includeQuoteTrips=true").catch(() => ({ trips: [] })), fetchApi("/api/travel/quotes?contactId=" + contactId + "&limit=100").catch(() => ({ quotes: [] })), fetchApi("/api/travel/itineraries?contactId=" + contactId + "&limit=100").catch(() => ({ itineraries: [] })), fetchApi("/api/contacts/" + contactId + "/activities?limit=100").catch(() => ({ data: [] }))]).then(([contactData, tripData, quoteData, itineraryData, activityData]) => { if (!mounted) return; setContact(contactData); setTrips(Array.isArray(tripData?.trips) ? tripData.trips : []); setQuotes(Array.isArray(quoteData?.quotes) ? quoteData.quotes : []); setItineraries(Array.isArray(itineraryData?.itineraries) ? itineraryData.itineraries : []); setActivities(Array.isArray(activityData?.data) ? activityData.data : []); }).catch((error) => { if (!mounted) return; setContactError(error?.body?.error || "Unable to load this lead."); }); return () => { mounted = false; }; }, [contactId]);
  // Teachers manage the whole group, while student/parent contacts see their
  // individual amount. The API marks teacher-linked trips with teacherContactId.
  const allTrips = useMemo(() => trips.map((trip) => {
    const isTeacher = Number(trip.teacherContactId) === Number(contactId);
    return { ...trip, idLabel: trip.tripCode || trip.id, startDate: trip.departDate, endDate: trip.returnDate, value: isTeacher ? (trip.totalTripValue ?? trip.perStudentAmount ?? trip.pricePerStudent) : (trip.perStudentAmount ?? trip.pricePerStudent ?? trip.totalTripValue), type: "TMC" };
  }), [trips, contactId]);
  const otherTrips = useMemo(() => quotes.map((quote) => ({
    id: `quote-${quote.id}`,
    idLabel: `Quote Q-${quote.id}`,
    destination: quote.destination || quote.title || (quote.subBrand ? `${String(quote.subBrand).toUpperCase()} travel` : "Travel quote"),
    startDate: quote.tripDate,
    endDate: null,
    value: quote.totalAmount,
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
    currency: itinerary.currency,
    status: itinerary.status,
    type: itinerary.subBrand ? String(itinerary.subBrand).toUpperCase() : "Itinerary",
    isOtherTrip: true,
  }))), [quotes, itineraries]);
  const displayTrips = useMemo(() => [...allTrips, ...otherTrips], [allTrips, otherTrips]);
  const totalValue = allTrips.reduce((sum, trip) => sum + (Number(trip.value) || 0), 0); const activeTrip = allTrips.find((trip) => !["completed", "cancelled"].includes(String(trip.status).toLowerCase())) || allTrips[0];
  const moveStage = async (stage) => { if (!contact || contact.status === stage) return; const updated = await fetchApi("/api/contacts/" + contact.id, { method: "PUT", body: JSON.stringify({ status: stage }) }); setContact((current) => ({ ...current, ...updated, status: updated?.status || stage })); };
  const addNote = async () => { if (!note.trim()) return; await fetchApi("/api/contacts/" + contact.id + "/activities", { method: "POST", body: JSON.stringify({ type: "Note", description: note.trim() }) }); setNote(""); };
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
        {tab === "Trips" && <><TripHero trip={activeTrip} onViewItinerary={() => navigate(activeTrip?.itineraryId ? "/travel/itineraries/" + activeTrip.itineraryId : "/travel/itineraries")} /><section className="travel-lead-trips"><h2>All trips</h2><div className="travel-lead-table-wrap"><table><thead><tr>{["Trip", "Destination", "Dates", "Type", "Value", "Status"].map((name) => <th key={name}>{name}</th>)}</tr></thead><tbody>{displayTrips.length ? displayTrips.map((trip) => <tr key={trip.id}><td><strong>{trip.idLabel}</strong></td><td>{trip.destination || ""}</td><td>{formatDate(trip.startDate)} {trip.endDate ? `${ARROW} ${formatDate(trip.endDate)}` : ""}</td><td>{trip.type}</td><td>{formatMoney(trip.value, trip.currency)}</td><td>{formatStatus(trip.status)}</td></tr>) : <tr><td colSpan="6">No travel trips linked to this contact.</td></tr>}</tbody></table></div></section></>}
        {tab === "Quotes" && quotes.map((quote) => <div className="travel-lead-empty-row" key={quote.id}>Quote Q-{quote.id} — {formatMoney(quote.totalAmount, quote.currency)} — {formatStatus(quote.status)}</div>)}
        {tab === "Activity" && activities.map((activity) => <div className="travel-lead-empty-row" key={activity.id}>{activity.type}: {activity.description || ""}</div>)}
        {tab === "Notes" && <div className="travel-lead-notes"><textarea value={note} onChange={(event) => setNote(event.target.value)} /><button className="travel-lead-button travel-lead-button-primary" type="button" onClick={addNote}>Add note</button></div>}
      </main></div>
    {editing && <EditContactModal contact={contact} customFieldDefs={[]} onClose={() => setEditing(false)} onSaved={(updated) => { setContact((current) => ({ ...current, ...updated })); setEditing(false); }} />}
  </div>;
}

function TripHero({ trip, onViewItinerary }) {
  if (!trip) return <div className="travel-lead-card travel-lead-empty-row">No active travel trip yet. Create a quote or trip to start the journey.</div>;
  const current = String(trip.status || "").toLowerCase(); const progress = current === "completed" ? 4 : ["confirmed", "booked"].includes(current) ? 1 : 0; const steps = ["Quote accepted", "Booked", "Docs & visa", "Travelling", "Completed"];
  return <section className="travel-lead-card travel-lead-trip-hero"><button className="travel-lead-button travel-lead-itinerary-button" type="button" onClick={onViewItinerary}>View itinerary</button><div className="travel-lead-trip-label">ACTIVE TRIP · {trip.idLabel}</div><h2>{trip.destination || "Travel trip"}</h2><div className="travel-lead-trip-meta">{formatDate(trip.startDate)} {ARROW} {formatDate(trip.endDate)} · {trip.type}</div><div className="travel-lead-trip-progress">{steps.map((step, index) => <div key={step}><div className={index <= progress ? "is-complete" : ""} /><small>{step}</small></div>)}</div><div className="travel-lead-trip-details"><span>Documents<strong>{trip.documentsConfigured ? "Configured" : "None configured"}</strong></span><span>Payment<strong>{trip.paymentPlan ? "Plan configured" : "Not configured"}</strong></span></div></section>;
}
