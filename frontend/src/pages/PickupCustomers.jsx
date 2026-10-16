import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, Copy, ExternalLink, Eye, Link2, MapPin, Pencil, Plus, RefreshCw, Search, UserRound, WalletCards, X } from "lucide-react";
import PickupCustomerStatusDialog from "../components/PickupCustomerStatusDialog";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";
import {
  PICKUP_STAGE_LABELS,
  formatPickupStatus,
  formatPickupStatusDate,
  pickupTripStatusStyle,
} from "../utils/pickupCustomerStatus";
import "./PickupCustomers.css";

const PLOT_FIELDS = [
  ["Plot name", "name"], ["Plot number", "plotNumber"], ["Block", "block"],
  ["Reference code", "referenceCode"], ["Area", "area"], ["Area unit", "areaUnit"],
  ["Road width", "roadWidth"], ["Facing", "facing"], ["Property type", "propertyType"],
  ["Address", "address"], ["Price", "price", "money"], ["Availability", "availability"],
];

const formatMoney = (amount, currency = "INR") => {
  if (amount === null || amount === undefined || amount === "") return "Not available";
  const value = Number(amount);
  if (!Number.isFinite(value)) return String(amount);
  return new Intl.NumberFormat("en-IN", {
    style: "currency", currency: currency || "INR", maximumFractionDigits: 2,
  }).format(value);
};

const displayValue = (value) => {
  if (value === null || value === undefined || value === "") return "Not available";
  return String(value).replaceAll("_", " ");
};

const customerJourneyStatus = (customer) => customer.currentStatus || customer.status || "PENDING";

const remainingBookingBalance = (customer) => {
  const booking = customer?.booking;
  const totalAmount = Number(booking?.totalAmount);
  if (!Number.isFinite(totalAmount)) return Number(booking?.balance ?? 0);
  const successfulPayments = Array.isArray(customer?.payments)
    ? customer.payments.filter(
      (payment) => String(payment.status || "").toUpperCase() === "SUCCESS",
    )
    : [];
  const amountPaid = successfulPayments.reduce(
    (sum, payment) => sum + Number(payment.amount || 0),
    0,
  );
  return Math.max(0, totalAmount - amountPaid);
};

const customerJourneyBucket = (customer) => {
  if (!customer.currentStage) {
    if (customer.status === "PICKUP_LOCATION_CAPTURED") return "waiting";
    if (customer.status === "COMPLETED") return "completed";
    return "active";
  }
  if (customer.currentStatus === "TRANSACTION_COMPLETED") return "completed";
  if (customer.currentStage === "transport" && customer.currentStatus === "PICKUP_LOCATION_CAPTURED") return "waiting";
  return "active";
};

function PickupLocationLink({ address, customerName }) {
  if (!address?.trim()) return <span className="pickup-muted">Not captured</span>;
  return (
    <a
      className="pickup-location-link"
      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.trim())}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open pickup location for ${customerName || "customer"} in Google Maps`}
    >
      <MapPin size={15} aria-hidden="true" /><span>{address}</span>
    </a>
  );
}

function DetailTable({ label, rows }) {
  return (
    <div className="pickup-detail-table-wrap">
      <table className="pickup-detail-table" aria-label={label}>
        <tbody>{rows.map(([name, value]) => <tr key={name}><th scope="row">{name}</th><td>{value || "Not available"}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function PaymentTable({ label, payments }) {
  return (
    <div className="pickup-payment-table-wrap">
      <table className="pickup-payment-table" aria-label={label}>
        <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Reference</th><th>Status</th></tr></thead>
        <tbody>{payments.map((payment) => (
          <tr key={payment.id}>
            <td>{formatPickupStatusDate(payment.paidAt || payment.createdAt)}</td>
            <td>{formatMoney(payment.amount, payment.currency)}</td>
            <td>{displayValue(payment.gateway)}</td>
            <td>{displayValue(payment.gatewayId || payment.transactionRef)}</td>
            <td><span className="pickup-payment-status">{displayValue(payment.status)}</span></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function PaymentSection({ customer, selectedPlot, plannedInstallments, onGeneratePayment, onAddInstallment, onInitiateInstallment }) {
  const payments = Array.isArray(customer.payments) ? customer.payments : [];
  const firstSuccessfulPayment = payments.find(
    (payment) => String(payment.status || "").toUpperCase() === "SUCCESS",
  );
  const initialPayment = firstSuccessfulPayment
    ? [firstSuccessfulPayment]
    : payments.slice(0, 1);
  const installments = firstSuccessfulPayment
    ? payments.filter((payment) => payment.id !== firstSuccessfulPayment.id)
    : payments.slice(1);
  const booking = customer.booking;
  const balance = remainingBookingBalance(customer);
  const initialPaymentCompleted = Boolean(firstSuccessfulPayment);
  const canGeneratePayment = Boolean(booking && selectedPlot && balance > 0);
  return (
    <div className="pickup-payment-sections">
      <section className="pickup-detail-section" aria-labelledby="initial-deposit-heading">
        <div className="pickup-section-heading pickup-section-heading-with-action"><span className="pickup-section-icon"><WalletCards size={17} /></span><div><h3 id="initial-deposit-heading">Initial deposit</h3><p>The first payment recorded for this plot booking.</p></div>{canGeneratePayment && !initialPaymentCompleted && <button type="button" className="btn-primary pickup-generate-payment" onClick={onGeneratePayment}><Link2 size={15} /> Generate payment</button>}</div>
        {initialPayment.length ? <PaymentTable label="Initial deposit payment" payments={initialPayment} /> : (
          <div className="pickup-payment-empty"><strong>Initial deposit not recorded</strong><span>{booking ? `${formatMoney(booking.balance ?? booking.totalAmount)} currently outstanding.` : "Payment details will appear after a plot booking is created."}</span></div>
        )}
      </section>
      <section className="pickup-detail-section" aria-labelledby="future-installments-heading">
        <div className="pickup-section-heading pickup-section-heading-with-action"><span className="pickup-section-icon"><WalletCards size={17} /></span><div><h3 id="future-installments-heading">Future installments</h3><p>Every payment after the initial deposit is listed here.</p></div>{canGeneratePayment && initialPaymentCompleted && <button type="button" className="btn-primary pickup-generate-payment" onClick={onAddInstallment}><Plus size={15} /> Add installment</button>}</div>
        {plannedInstallments.length > 0 && <table className="pickup-detail-table" aria-label="Planned installments"><thead><tr><th>Month</th><th>Year</th><th>Amount</th><th>Action</th></tr></thead><tbody>{plannedInstallments.map((installment) => <tr key={installment.id}><td>{installment.monthLabel}</td><td>{installment.year}</td><td>{formatMoney(installment.amount)}</td><td><button type="button" className="btn-primary" onClick={() => onInitiateInstallment(installment)}><Link2 size={14} /> Initiate payment</button></td></tr>)}</tbody></table>}
        {installments.length ? <><div className="pickup-payment-balance"><span>Remaining installment balance</span><strong>{formatMoney(balance)}</strong></div><PaymentTable label="Future installment payments" payments={installments} /></> : (
          <div className="pickup-payment-empty"><strong>{balance > 0 ? "No installment has been recorded yet" : "No future installments due"}</strong><span>{balance > 0 ? `${formatMoney(balance)} remains on this booking.` : "Any later installment will appear here as a table row."}</span></div>
        )}
      </section>
    </div>
  );
}

function CustomerDetails({ customer, plannedInstallments, onEdit, onAssignPlots, onViewAssignedPlots, onViewStatus, onGeneratePayment, onAddInstallment, onInitiateInstallment }) {
  const brokerStatus = String(customer.workflow?.broker?.status || '').toUpperCase();
  const currentStage = String(customer.currentStage || '').toUpperCase();
  const currentStatus = String(customer.currentStatus || '').toUpperCase();
  const legacyStatus = String(customer.status || '').toUpperCase();
  const transportWorkflowStatus = String(customer.workflow?.transport?.status || '').toUpperCase();
  const transportStageActive = currentStage === 'TRANSPORT'
    || currentStatus.includes('TRANSPORT')
    || legacyStatus.includes('TRANSPORT')
    || (transportWorkflowStatus && !['PLOT_SELECTED', 'RESERVED', 'BOOKED'].includes(brokerStatus));
  const bookingConfirmed = customer.booking && String(customer.booking.status || '').toUpperCase() !== 'PLOT_ASSIGNED';
  const plotSelectionConfirmed = !transportStageActive && (Boolean(bookingConfirmed)
    || ['PLOT_SELECTED', 'RESERVED', 'BOOKED', 'PAYMENT_RECEIVED', 'SOLD'].includes(brokerStatus)
    || String(customer.currentStatus || '').toUpperCase() === 'PLOT_SELECTED');
  const selectedPlot = plotSelectionConfirmed ? (customer.selectedPlot || customer.assignedPlot) : null;
  const customerAssignedPlotIds = Array.isArray(customer.customerAssignedPlotIds)
    ? new Set(customer.customerAssignedPlotIds.map(Number))
    : null;
  const assignedPlots = (customer.assignedPlots?.length ? customer.assignedPlots : (customer.assignedPlot ? [customer.assignedPlot] : []))
    .filter((plot) => !customerAssignedPlotIds || customerAssignedPlotIds.has(Number(plot.id)));
  const journeyStatus = customerJourneyStatus(customer);
  const customerRows = [
    ["Customer name", customer.contact?.name], ["Phone", customer.contact?.phone],
    ["Email", customer.contact?.email], ["Company", customer.contact?.company],
    ["CRM status", customer.contact?.status], ["Interested plot area", customer.contact?.interestedPlotArea],
    ["Pickup location", <PickupLocationLink key="pickup" address={customer.pickupAddress} customerName={customer.contact?.name} />],
    ["Transport person", customer.workflow?.transport?.assignee?.name || customer.transportPerson?.name],
    ["Sales Executive", customer.workflow?.broker?.assignee?.name],
    ["Current status", `${PICKUP_STAGE_LABELS[customer.currentStage] || "Transport"}: ${formatPickupStatus(customer.currentStatus || customer.status)}`],
  ];
  const plotRows = (assignedPlot) => PLOT_FIELDS.map(([label, key, type]) => [label, type === "money" ? formatMoney(assignedPlot?.[key]) : displayValue(assignedPlot?.[key])]);
  return (
    <article className="pickup-customer-detail" data-testid="selected-customer-details">
      <header className="pickup-detail-header">
        <div className="pickup-customer-title"><span className="pickup-customer-avatar"><UserRound size={22} /></span><div><p>Selected customer</p><h2>{customer.contact?.name || "Customer"}</h2><span style={pickupTripStatusStyle(journeyStatus)}>{formatPickupStatus(journeyStatus)}</span></div></div>
        <div className="pickup-detail-actions">
          <button type="button" className="btn-secondary" onClick={onEdit} aria-label={`Edit ${customer.contact?.name || "customer"} pickup location`}><Pencil size={14} /> Edit pickup</button>
          {assignedPlots.length ? <button type="button" className="btn-secondary" onClick={onViewAssignedPlots} aria-label={`View plots for ${customer.contact?.name || "customer"}`}><Eye size={14} /> View plots</button> : <button type="button" className="btn-secondary" onClick={onAssignPlots} aria-label={`Assign plots to ${customer.contact?.name || "customer"}`}><Plus size={14} /> Assign plots</button>}
          <button type="button" className="btn-secondary" onClick={onViewStatus} aria-label={`View all status for ${customer.contact?.name || "customer"}`}><Eye size={14} /> Full workflow</button>
        </div>
      </header>
      <section className="pickup-detail-section" aria-labelledby="customer-details-heading">
        <div className="pickup-section-heading"><span className="pickup-section-icon"><UserRound size={17} /></span><div><h3 id="customer-details-heading">Customer details</h3><p>Contact and live workflow information.</p></div></div>
        <DetailTable label="Selected customer details" rows={customerRows} />
      </section>
      <section className="pickup-detail-section" aria-labelledby="plot-details-heading">
        <div className="pickup-section-heading"><span className="pickup-section-icon"><Building2 size={17} /></span><div><h3 id="plot-details-heading">Selected plot details</h3><p>Complete plot information linked to this customer.</p></div></div>
        {selectedPlot ? <div className="pickup-assigned-plot">
          <div className="pickup-view-plot-row">
            <h4>{selectedPlot.plotNumber ? `Plot ${selectedPlot.plotNumber}` : selectedPlot.name || "Selected plot"}</h4>
          </div>
          <DetailTable label="Selected plot details" rows={plotRows(selectedPlot)} />
        </div> : <div className="pickup-payment-empty"><strong>No plot selected</strong><span>Plot details will appear after the Sales Executive confirms a selection.</span></div>}
      </section>
      <PaymentSection customer={customer} selectedPlot={selectedPlot} plannedInstallments={plannedInstallments} onGeneratePayment={onGeneratePayment} onAddInstallment={onAddInstallment} onInitiateInstallment={onInitiateInstallment} />
    </article>
  );
}

export default function PickupCustomers() {
  const notify = useNotify();
  const [customers, setCustomers] = useState([]);
  const [plots, setPlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [viewingCustomer, setViewingCustomer] = useState(null);
  const [viewingAssignedPlots, setViewingAssignedPlots] = useState(null);
  const [editAddress, setEditAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [assigningCustomer, setAssigningCustomer] = useState(null);
  const [selectedPlotIds, setSelectedPlotIds] = useState([]);
  const [selectedPlotName, setSelectedPlotName] = useState("");
  const [assigningPlots, setAssigningPlots] = useState(false);
  const [paymentCustomer, setPaymentCustomer] = useState(null);
  const [installmentCustomer, setInstallmentCustomer] = useState(null);
  const [plannedInstallments, setPlannedInstallments] = useState({});
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [generatedPaymentLink, setGeneratedPaymentLink] = useState("");
  const [paymentForm, setPaymentForm] = useState({
    amount: "",
    installmentId: null,
    method: "payment_link",
    paidAt: new Date().toISOString().slice(0, 10),
    transactionRef: "",
  });
  const [installmentForm, setInstallmentForm] = useState({ month: "", year: "", amount: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchApi("/api/pickup-plot-inventory/customer-pickups");
      const rows = Array.isArray(response?.customers) ? response.customers : [];
      setCustomers(rows);
      setPlots(Array.isArray(response?.plots) ? response.plots : []);
      setSelectedCustomerId((current) => rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
    } catch (error) {
      notify.error(error.message || "Could not load customer pickup status.");
    } finally { setLoading(false); }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const visibleCustomers = useMemo(() => customers.filter((row) => {
    if (status !== "all" && customerJourneyBucket(row) !== status) return false;
    const needle = search.trim().toLowerCase();
    return !needle || [row.contact?.name, row.contact?.phone, row.contact?.email, row.contact?.company, row.pickupAddress, row.contact?.interestedPlotArea, row.assignedPlot?.name].some((value) => String(value || "").toLowerCase().includes(needle));
  }), [customers, search, status]);
  const selectedCustomer = visibleCustomers.find((row) => row.id === selectedCustomerId) || visibleCustomers[0] || null;

  // Keep the client-side guard because older endpoint responses may also
  // contain reserved/sold rows, but normalize imported status labels before
  // comparing them. A case-sensitive check made genuinely available plots
  // disappear from this dialog.
  const availablePlots = useMemo(() => plots.filter((plot) => (
    String(plot.availability || "").trim().toUpperCase() === "AVAILABLE"
    && String(plot.plotNumber || "").trim()
  )), [plots]);
  const availablePlotNames = useMemo(() => [...new Map(availablePlots.map((plot) => (
    [String(plot.name || "").trim().toLowerCase(), String(plot.name || "").trim()]
  ))).values()].filter(Boolean), [availablePlots]);
  const plotNameOptions = useMemo(() => {
    if (!selectedPlotName || availablePlotNames.some((name) => name.toLowerCase() === selectedPlotName.toLowerCase())) {
      return availablePlotNames;
    }
    return [selectedPlotName, ...availablePlotNames];
  }, [availablePlotNames, selectedPlotName]);
  const assignedPlotIds = useMemo(() => new Set(
    (assigningCustomer?.customerAssignedPlotIds || []).map(Number).filter(Number.isInteger),
  ), [assigningCustomer]);
  const assignablePlots = useMemo(() => {
    const byNumber = new Map();
    availablePlots
      .filter((plot) => String(plot.name || "").trim().toLowerCase() === selectedPlotName.trim().toLowerCase())
      .forEach((plot) => {
        const number = String(plot.plotNumber || "").trim().toLowerCase();
        if (!byNumber.has(number)) byNumber.set(number, plot);
      });
    return [...byNumber.values()];
  }, [availablePlots, selectedPlotName]);

  const openEdit = (row) => { setEditingCustomer(row); setEditAddress(row.pickupAddress || ""); };
  const openPlotAssignment = (row) => {
    const assignedName = String(row.assignedPlots?.[0]?.name || "").trim();
    const firstAvailableName = availablePlotNames[0] || "";
    const assignedNameHasAvailablePlots = availablePlotNames.some((name) => (
      name.toLowerCase() === assignedName.toLowerCase()
    ));
    setAssigningCustomer(row);
    setSelectedPlotName(assignedNameHasAvailablePlots ? assignedName : firstAvailableName);
    setSelectedPlotIds([]);
  };
  const assignPlots = async (event) => {
    event.preventDefault();
    if (!assigningCustomer?.contact?.id || !selectedPlotIds.length) return;
    setAssigningPlots(true);
    try {
      await fetchApi(`/api/pickup-plot-inventory/customer-pickups/${assigningCustomer.contact.id}/plots`, {
        method: "POST",
        body: JSON.stringify({ plotSiteIds: selectedPlotIds }),
      });
      notify.success(`${selectedPlotIds.length} plot${selectedPlotIds.length === 1 ? "" : "s"} assigned.`);
      setAssigningCustomer(null);
      setSelectedPlotIds([]);
      setSelectedPlotName("");
      await load();
    } catch (error) {
      notify.error(error.message || "Could not assign the selected plots.");
    } finally { setAssigningPlots(false); }
  };
  const openPayment = (row, installment = null) => {
    const remainingBalance = remainingBookingBalance(row);
    setPaymentCustomer(row);
    setGeneratedPaymentLink("");
    setPaymentForm({
      amount: String(installment?.amount ?? remainingBalance),
      installmentId: installment?.id ?? null,
      method: "payment_link",
      paidAt: new Date().toISOString().slice(0, 10),
      transactionRef: "",
    });
  };
  const openInstallment = (row) => {
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    setInstallmentCustomer(row);
    setInstallmentForm({
      month: String(nextMonth.getMonth() + 1),
      year: String(nextMonth.getFullYear()),
      amount: "",
    });
  };
  const addInstallment = (event) => {
    event.preventDefault();
    if (!installmentCustomer?.booking?.id) return;
    const amount = Number(installmentForm.amount);
    const balance = remainingBookingBalance(installmentCustomer);
    if (!Number.isFinite(amount) || amount <= 0 || amount > balance) {
      notify.error("Installment amount must be within the remaining balance.");
      return;
    }
    const month = Number(installmentForm.month);
    const year = Number(installmentForm.year);
    const installment = {
      id: `${installmentCustomer.booking.id}-${Date.now()}`,
      month,
      monthLabel: new Intl.DateTimeFormat("en-IN", { month: "long" }).format(new Date(year, month - 1, 1)),
      year,
      amount,
    };
    setPlannedInstallments((current) => ({
      ...current,
      [installmentCustomer.booking.id]: [...(current[installmentCustomer.booking.id] || []), installment],
    }));
    setInstallmentCustomer(null);
    notify.success("Installment added. Initiate payment when ready.");
  };
  const generatePayment = async (event) => {
    event.preventDefault();
    if (!paymentCustomer?.contact?.id) return;
    setPaymentSaving(true);
    try {
      const body = {
        amount: Number(paymentForm.amount),
        method: paymentForm.method,
        plotBookingId: paymentCustomer.booking?.id,
        ...(paymentForm.method === "payment_link" ? {} : {
          paidAt: new Date(`${paymentForm.paidAt}T12:00:00`).toISOString(),
          transactionRef: paymentForm.transactionRef,
        }),
      };
      const result = await fetchApi(`/api/pickup-plot-inventory/customer-pickups/${paymentCustomer.contact.id}/initial-payment`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (result?.url) {
        setGeneratedPaymentLink(result.url);
        if (paymentForm.installmentId && paymentCustomer.booking?.id) {
          setPlannedInstallments((current) => ({
            ...current,
            [paymentCustomer.booking.id]: (current[paymentCustomer.booking.id] || []).filter((row) => row.id !== paymentForm.installmentId),
          }));
        }
        notify.success("Payment link generated. Share it with the customer.");
      } else {
        const hasSuccessfulPayment = paymentCustomer.payments?.some(
          (payment) => String(payment.status || "").toUpperCase() === "SUCCESS",
        );
        notify.success(hasSuccessfulPayment ? "Installment payment recorded." : "Initial payment recorded.");
        setPaymentCustomer(null);
      }
      await load();
    } catch (error) {
      notify.error(error.message || "Could not generate the payment.");
    } finally { setPaymentSaving(false); }
  };
  const copyPaymentLink = async () => {
    try {
      await navigator.clipboard.writeText(generatedPaymentLink);
      notify.success("Payment link copied.");
    } catch (_error) {
      notify.error("Copy was not available. Select and copy the link manually.");
    }
  };
  const savePickupLocation = async (event) => {
    event.preventDefault(); setSaving(true);
    try {
      await fetchApi(`/api/pickup-plot-inventory/customer-pickups/${editingCustomer.contact.id}`, {
        method: "PUT",
        body: JSON.stringify({ pickupAddress: editAddress, sourceTranscriptId: editingCustomer.sourceTranscriptId || null, sourceExcerpt: editingCustomer.sourceExcerpt || null }),
      });
      notify.success("Pickup location updated."); setEditingCustomer(null); await load();
    } catch (error) { notify.error(error.message || "Could not update the pickup location."); }
    finally { setSaving(false); }
  };

  const isInstallmentPayment = Boolean(paymentCustomer?.payments?.some(
    (payment) => String(payment.status || "").toUpperCase() === "SUCCESS",
  ));
  const paymentBalance = paymentCustomer
    ? remainingBookingBalance(paymentCustomer)
    : 0;

  return (
    <main className="pickup-customers-page" data-testid="pickup-customers-page">
      <header className="pickup-page-header"><div><h1><MapPin size={28} /> Customer Status</h1><p>Select a customer to review their plot, deposit, and installment details.</p></div><button type="button" className="btn-secondary pickup-refresh" onClick={load} disabled={loading}><RefreshCw size={15} /> Refresh</button></header>
      <div className="pickup-master-detail">
        <aside className="card pickup-customer-directory" aria-label="Customer directory">
          <div className="pickup-directory-toolbar">
            <label><Search size={15} aria-hidden="true" /><input className="input-field" type="search" aria-label="Search customer status" placeholder="Search customers..." value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <select className="input-field" aria-label="Filter customer trip status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="waiting">Awaiting assignment</option><option value="active">Active trips</option><option value="completed">Completed</option></select>
          </div>
          <div className="pickup-directory-scroll" data-testid="pickup-customers-table-scroll">
            <table className="pickup-customer-table" aria-label="Customer list">
              <thead><tr><th>Customer</th><th>Contact</th><th>Status</th></tr></thead>
              <tbody>
                {visibleCustomers.map((row) => { const selected = row.id === selectedCustomer?.id; const journeyStatus = customerJourneyStatus(row); return <tr key={row.id} className={selected ? "is-selected" : ""} onClick={() => setSelectedCustomerId(row.id)}><td><button type="button" onClick={() => setSelectedCustomerId(row.id)} aria-pressed={selected}>{row.contact?.name || "Customer"}</button><small>{row.assignedPlot?.name || row.contact?.interestedPlotArea || "No plot selected"}</small></td><td>{row.contact?.phone || row.contact?.email || "Not available"}</td><td><span style={pickupTripStatusStyle(journeyStatus)}>{formatPickupStatus(journeyStatus)}</span></td></tr>; })}
                {!visibleCustomers.length && <tr><td colSpan="3" className="pickup-empty-cell">No customer records match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
        </aside>
        <section className="card pickup-detail-pane" aria-live="polite">
          {loading ? <div className="pickup-detail-placeholder">Loading customer details…</div> : selectedCustomer ? <CustomerDetails key={selectedCustomer.id} customer={selectedCustomer} plannedInstallments={plannedInstallments[selectedCustomer.booking?.id] || []} onEdit={() => openEdit(selectedCustomer)} onAssignPlots={() => openPlotAssignment(selectedCustomer)} onViewAssignedPlots={() => setViewingAssignedPlots(selectedCustomer)} onViewStatus={() => setViewingCustomer(selectedCustomer)} onGeneratePayment={() => openPayment(selectedCustomer)} onAddInstallment={() => openInstallment(selectedCustomer)} onInitiateInstallment={(installment) => openPayment(selectedCustomer, installment)} /> : <div className="pickup-detail-placeholder"><UserRound size={34} /><strong>Select a customer</strong><span>Their details will appear here.</span></div>}
        </section>
      </div>
      {editingCustomer && <div role="presentation" className="pickup-modal-backdrop"><form role="dialog" aria-modal="true" aria-labelledby="edit-pickup-title" className="card pickup-edit-dialog" onSubmit={savePickupLocation}><div className="pickup-dialog-header"><h2 id="edit-pickup-title">Edit pickup location</h2><button type="button" className="btn-secondary" aria-label="Close edit pickup location" onClick={() => setEditingCustomer(null)}><X size={17} /></button></div><p className="pickup-muted">{editingCustomer.contact?.name || "Customer"}</p><label className="pickup-edit-label">Pickup location<textarea className="input-field" aria-label="Pickup location" required rows="4" value={editAddress} onChange={(event) => setEditAddress(event.target.value)} /></label><div className="pickup-dialog-actions"><button type="button" className="btn-secondary" onClick={() => setEditingCustomer(null)}>Cancel</button><button type="submit" className="btn-primary" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button></div></form></div>}
      {assigningCustomer && (
        <div role="presentation" className="pickup-modal-backdrop">
          <form role="dialog" aria-modal="true" aria-labelledby="assign-plots-title" className="card pickup-edit-dialog pickup-plot-dialog" onSubmit={assignPlots}>
            <div className="pickup-dialog-header"><div><h2 id="assign-plots-title">Assign plots</h2><p className="pickup-muted">{assigningCustomer.contact?.name || "Customer"}</p></div><button type="button" className="btn-secondary" aria-label="Close assign plots" onClick={() => setAssigningCustomer(null)}><X size={17} /></button></div>
            <p className="pickup-plot-help">Choose one Plot / Site name, then select one or more different plot numbers. Reserved and sold plots are hidden.</p>
            <label className="pickup-edit-label">Plot / Site
              <select
                className="input-field"
                aria-label="Plot or site name"
                value={selectedPlotName}
                disabled={assigningPlots}
                onChange={(event) => { setSelectedPlotName(event.target.value); setSelectedPlotIds([]); }}
              >
                {plotNameOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <div className="pickup-plot-options" role="group" aria-label="Plots to assign">
              {assignablePlots.map((plotOption) => {
                const alreadyAssigned = assignedPlotIds.has(Number(plotOption.id));
                const checked = selectedPlotIds.includes(Number(plotOption.id));
                return <label key={plotOption.id} className="pickup-plot-option"><input type="checkbox" checked={alreadyAssigned || checked} disabled={alreadyAssigned || assigningPlots} onChange={(event) => setSelectedPlotIds((current) => event.target.checked ? [...current, Number(plotOption.id)] : current.filter((id) => id !== Number(plotOption.id)))} /><span><strong>Plot {plotOption.plotNumber}</strong><small>{plotOption.name}{plotOption.block ? ` · Block ${plotOption.block}` : ""}{alreadyAssigned ? " · Already assigned" : ""}</small></span></label>;
              })}
              {!assignablePlots.length && <div className="pickup-payment-empty"><strong>No available plot numbers</strong><span>All plot numbers for this Plot / Site are reserved, sold, inactive, or unavailable.</span></div>}
            </div>
            <div className="pickup-dialog-actions"><button type="button" className="btn-secondary" onClick={() => setAssigningCustomer(null)}>Cancel</button><button type="submit" className="btn-primary" disabled={!selectedPlotIds.length || assigningPlots}>{assigningPlots ? "Assigning…" : selectedPlotIds.length ? `Assign ${selectedPlotIds.length} plot${selectedPlotIds.length === 1 ? "" : "s"}` : "Assign plots"}</button></div>
          </form>
        </div>
      )}
      {paymentCustomer && (
        <div role="presentation" className="pickup-modal-backdrop">
          <form role="dialog" aria-modal="true" aria-labelledby="generate-payment-title" className="card pickup-edit-dialog pickup-payment-dialog" onSubmit={generatePayment}>
            <div className="pickup-dialog-header">
              <div><h2 id="generate-payment-title">{isInstallmentPayment ? "Generate installment payment" : "Generate initial payment"}</h2><p className="pickup-muted">{paymentCustomer.contact?.name} · {paymentCustomer.booking?.bookingNumber}</p></div>
              <button type="button" className="btn-secondary" aria-label="Close generate payment" onClick={() => setPaymentCustomer(null)}><X size={17} /></button>
            </div>
            {generatedPaymentLink ? (
              <div className="pickup-generated-link">
                <strong>Payment link ready</strong>
                <p>Customer can pay using UPI, card, or net banking.</p>
                <input className="input-field" aria-label="Generated payment link" readOnly value={generatedPaymentLink} />
                <div className="pickup-dialog-actions">
                  <button type="button" className="btn-secondary" onClick={copyPaymentLink}><Copy size={15} /> Copy link</button>
                  <a className="btn-primary" href={generatedPaymentLink} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open link</a>
                </div>
              </div>
            ) : (
              <>
                <div className="pickup-payment-balance"><span>{isInstallmentPayment ? "Remaining installment balance" : "Outstanding balance"}</span><strong>{formatMoney(paymentBalance)}</strong></div>
                <label className="pickup-edit-label">{isInstallmentPayment ? "Installment amount" : "Payment amount"}<input className="input-field" aria-label={isInstallmentPayment ? "Installment payment amount" : "Initial payment amount"} type="number" min="0.01" step="0.01" max={paymentBalance} required readOnly={Boolean(paymentForm.installmentId)} value={paymentForm.amount} onChange={(event) => setPaymentForm((current) => ({ ...current, amount: event.target.value }))} /></label>
                <label className="pickup-edit-label">Payment option<select className="input-field" aria-label={isInstallmentPayment ? "Installment payment option" : "Initial payment option"} value={paymentForm.method} onChange={(event) => setPaymentForm((current) => ({ ...current, method: event.target.value }))}><option value="payment_link">Online payment link (UPI / Card / Net banking)</option><option value="upi">Record UPI payment</option><option value="cash">Record cash payment</option><option value="card">Record card payment</option><option value="bank_transfer">Record bank transfer</option><option value="cheque">Record cheque payment</option></select></label>
                {paymentForm.method !== "payment_link" && <div className="pickup-payment-manual-fields"><label className="pickup-edit-label">Payment date<input className="input-field" aria-label={isInstallmentPayment ? "Installment payment date" : "Initial payment date"} type="date" required value={paymentForm.paidAt} onChange={(event) => setPaymentForm((current) => ({ ...current, paidAt: event.target.value }))} /></label><label className="pickup-edit-label">Transaction reference<input className="input-field" aria-label={isInstallmentPayment ? "Installment payment reference" : "Initial payment reference"} required placeholder="UTR, receipt, or cheque number" value={paymentForm.transactionRef} onChange={(event) => setPaymentForm((current) => ({ ...current, transactionRef: event.target.value }))} /></label></div>}
                <div className="pickup-dialog-actions"><button type="button" className="btn-secondary" onClick={() => setPaymentCustomer(null)}>Cancel</button><button type="submit" className="btn-primary" disabled={paymentSaving}>{paymentSaving ? "Generating…" : paymentForm.method === "payment_link" ? "Generate link" : "Record payment"}</button></div>
              </>
            )}
          </form>
        </div>
      )}
      {installmentCustomer && (
        <div role="presentation" className="pickup-modal-backdrop">
          <form role="dialog" aria-modal="true" aria-labelledby="add-installment-title" className="card pickup-edit-dialog pickup-payment-dialog" onSubmit={addInstallment}>
            <div className="pickup-dialog-header"><div><h2 id="add-installment-title">Add installment</h2><p className="pickup-muted">Choose the month, year, and amount.</p></div><button type="button" className="btn-secondary" aria-label="Close add installment" onClick={() => setInstallmentCustomer(null)}><X size={17} /></button></div>
            <div className="pickup-payment-balance"><span>Remaining balance</span><strong>{formatMoney(remainingBookingBalance(installmentCustomer))}</strong></div>
            <div className="pickup-payment-manual-fields">
              <label className="pickup-edit-label">Month<select className="input-field" aria-label="Installment month" value={installmentForm.month} onChange={(event) => setInstallmentForm((current) => ({ ...current, month: event.target.value }))}>{Array.from({ length: 12 }, (_, index) => index + 1).map((month) => <option key={month} value={month}>{new Intl.DateTimeFormat("en-IN", { month: "long" }).format(new Date(2026, month - 1, 1))}</option>)}</select></label>
              <label className="pickup-edit-label">Year<select className="input-field" aria-label="Installment year" value={installmentForm.year} onChange={(event) => setInstallmentForm((current) => ({ ...current, year: event.target.value }))}>{Array.from({ length: 11 }, (_, index) => new Date().getFullYear() + index).map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
            </div>
            <label className="pickup-edit-label">Installment amount<input className="input-field" aria-label="New installment amount" type="number" min="0.01" step="0.01" max={remainingBookingBalance(installmentCustomer)} required value={installmentForm.amount} onChange={(event) => setInstallmentForm((current) => ({ ...current, amount: event.target.value }))} /></label>
            <div className="pickup-dialog-actions"><button type="button" className="btn-secondary" onClick={() => setInstallmentCustomer(null)}>Cancel</button><button type="submit" className="btn-primary">Add installment</button></div>
          </form>
        </div>
      )}
      {viewingAssignedPlots && (
        <div role="presentation" className="pickup-modal-backdrop">
          <section role="dialog" aria-modal="true" aria-labelledby="view-assigned-plots-title" className="card pickup-edit-dialog pickup-assigned-plots-dialog">
            <div className="pickup-dialog-header"><div><h2 id="view-assigned-plots-title">Assigned plots</h2><p className="pickup-muted">{viewingAssignedPlots.contact?.name || "Customer"}</p></div><button type="button" className="btn-secondary" aria-label="Close assigned plots" onClick={() => setViewingAssignedPlots(null)}><X size={17} /></button></div>
            <div className="pickup-assigned-plot-list" aria-label="Assigned plot list">
              {(viewingAssignedPlots.assignedPlots?.length ? viewingAssignedPlots.assignedPlots : [viewingAssignedPlots.assignedPlot]).filter(Boolean).map((assignedPlot) => <div className="pickup-assigned-plot-item" key={assignedPlot.id}><span>{assignedPlot.name || "Unnamed plot"}</span><strong>{assignedPlot.plotNumber ? `Plot ${assignedPlot.plotNumber}` : "Plot number unavailable"}</strong></div>)}
            </div>
          </section>
        </div>
      )}
      {viewingCustomer && <PickupCustomerStatusDialog customer={viewingCustomer} onClose={() => setViewingCustomer(null)} />}
    </main>
  );
}
