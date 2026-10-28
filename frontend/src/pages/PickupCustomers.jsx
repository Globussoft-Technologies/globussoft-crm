import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BadgeIndianRupee, Building2, Copy, ExternalLink, Eye, Link2, MapPin, Pencil, Plus, RefreshCw, Search, UserRound, WalletCards, X } from "lucide-react";
import { AuthContext } from "../appContexts";
import PickupCustomerStatusDialog from "../components/PickupCustomerStatusDialog";
import PickupLocationSelect from "../components/PickupLocationSelect";
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

const DEFAULT_INITIAL_PAYMENT_PERCENT = 10;

const localDateTimeInputValue = (date = new Date()) => {
  const localTime = new Date(date.getTime() - (date.getTimezoneOffset() * 60_000));
  return localTime.toISOString().slice(0, 19);
};

const paymentAmountFromPercent = (balance, percent) => {
  const numericBalance = Number(balance);
  const numericPercent = Number(percent);
  if (!Number.isFinite(numericBalance) || !Number.isFinite(numericPercent)) return "";
  return String(Math.round((numericBalance * numericPercent / 100) * 100) / 100);
};

const suggestedInstallmentAmount = (balance, count) => {
  const numericBalance = Number(balance);
  const numericCount = Number(count);
  if (!Number.isFinite(numericBalance) || !Number.isInteger(numericCount) || numericCount < 1) return "";
  return String(Math.floor((numericBalance * 100) / numericCount) / 100);
};

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

const INSTALLMENT_STATUS_LABELS = {
  PLANNED: "Planned",
  PAYMENT_INITIATED: "Payment Initiated",
  LINK_CREATED: "Payment Initiated",
  PROCESSING: "Processing",
  PAID: "Paid",
  FAILED: "Failed",
  OVERDUE: "Overdue",
};

const installmentStatusLabel = (status) => INSTALLMENT_STATUS_LABELS[String(status || "PLANNED").toUpperCase()] || displayValue(status);

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
      <table className="pickup-detail-table pickup-plot-leads-table pickup-plot-no-row-hover" aria-label={label}>
        <tbody>{rows.map(([name, value]) => <tr key={name}><th scope="row">{name}</th><td>{value || "Not available"}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function PaymentAction({ payment }) {
  const status = String(payment.status || "").toUpperCase();
  if (["PENDING", "PAYMENT_INITIATED", "LINK_CREATED", "PROCESSING"].includes(status) && payment.paymentLinkUrl) {
    return <a className="btn-secondary" href={payment.paymentLinkUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open payment link</a>;
  }
  if (status === "SUCCESS" && payment.receiptUrl) {
    return <a className="btn-secondary" href={payment.receiptUrl} target="_blank" rel="noreferrer"><Eye size={14} /> View receipt</a>;
  }
  return <span className="pickup-muted">No action</span>;
}

function PaymentTable({ label, payments, scrollable = false, showActions = false }) {
  return (
    <div className={`pickup-payment-table-wrap${scrollable ? " pickup-payment-history-wrap" : ""}`}>
      <table className="pickup-payment-table pickup-plot-leads-table pickup-plot-no-row-hover" aria-label={label}>
        <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Reference</th><th>Status</th>{showActions && <th>Action</th>}</tr></thead>
        <tbody>{payments.map((payment) => (
          <tr key={payment.id}>
            <td>{formatPickupStatusDate(payment.paidAt || payment.createdAt)}</td>
            <td>{formatMoney(payment.amount, payment.currency)}</td>
            <td>{displayValue(payment.gateway)}</td>
            <td>{String(payment.gateway || "").toLowerCase() === "cash" ? "-" : (payment.gatewayId || payment.transactionRef ? displayValue(payment.gatewayId || payment.transactionRef) : "-")}</td>
            <td><span className="pickup-payment-status">{displayValue(payment.status)}</span></td>
            {showActions && <td className="pickup-payment-action"><PaymentAction payment={payment} /></td>}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function InstallmentAction({ installment, onInitiate }) {
  const status = String(installment.status || "PLANNED").toUpperCase();
  if (["PLANNED", "OVERDUE"].includes(status)) {
    return <button type="button" className="btn-primary" onClick={() => onInitiate(installment)}><Link2 size={14} /> Initiate payment</button>;
  }
  if (status === "FAILED") {
    return <button type="button" className="btn-primary" onClick={() => onInitiate(installment)}><RefreshCw size={14} /> Retry payment</button>;
  }
  if (["PAYMENT_INITIATED", "LINK_CREATED", "PROCESSING"].includes(status) && installment.paymentLinkUrl) {
    return <a className="btn-secondary" href={installment.paymentLinkUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open payment link</a>;
  }
  if (status === "PAID" && installment.receiptUrl) {
    return <a className="btn-secondary" href={installment.receiptUrl} target="_blank" rel="noreferrer"><Eye size={14} /> View receipt</a>;
  }
  return <span className="pickup-muted">{status === "PAID" ? "Paid" : "No action"}</span>;
}

function CommissionSection({ customer, updatingId, onUpdateStatus, onUpdateRate }) {
  const commissions = Array.isArray(customer.commissions) ? customer.commissions : [];
  const [rates, setRates] = useState({});
  const [commissionHistoryOpen, setCommissionHistoryOpen] = useState(false);
  const successfulPayments = (Array.isArray(customer.payments) ? customer.payments : []).filter(
    (payment) => String(payment.status || "").toUpperCase() === "SUCCESS",
  );
  const hasSuccessfulPayment = successfulPayments.length > 0;
  const configuredRate = customer.workflow?.broker?.assignee?.commissionPercent;
  const commissionRate = Number(configuredRate == null ? 10 : configuredRate);
  const displayedCommissions = commissions.map((commission) => {
    const status = String(commission.status || "EARNED").toUpperCase();
    const displayedRate = status === "EARNED"
      ? Number(rates[commission.id] ?? commission.commissionPercent)
      : Number(commission.commissionPercent || 0);
    const commissionAmount = Number(commission.eligibleAmount || 0) * (Number.isFinite(displayedRate) ? displayedRate : 0) / 100;
    let remaining = commissionAmount;
    const allocations = (commission.allocations || []).map((allocation) => {
      const grossAmount = Number(allocation.grossAmount || 0);
      const commissionDeduction = Math.min(grossAmount, remaining);
      remaining = Math.max(0, remaining - commissionDeduction);
      return { ...allocation, commissionDeduction, netPaymentAmount: Math.max(0, grossAmount - commissionDeduction) };
    });
    return {
      ...commission,
      displayedRate,
      commissionAmount,
      commissionDeducted: commissionAmount - remaining,
      commissionOutstanding: remaining,
      allocations,
    };
  });
  const totals = displayedCommissions.reduce((result, row) => ({
    commission: result.commission + Number(row.commissionAmount || 0),
    deducted: result.deducted + Number(row.commissionDeducted || 0),
    outstanding: result.outstanding + Number(row.commissionOutstanding || 0),
  }), { commission: 0, deducted: 0, outstanding: 0 });
  const commissionHistory = displayedCommissions.flatMap((commission) => (
    (commission.allocations || []).map((allocation) => ({ commission, allocation }))
  ));
  return (
    <section className="pickup-detail-section" aria-labelledby="commission-tracking-heading">
      <div className="pickup-section-heading pickup-section-heading-with-action"><span className="pickup-section-icon"><BadgeIndianRupee size={17} /></span><div><h3 id="commission-tracking-heading">Commission tracking</h3><p>Admin-only commission on the total deal amount, deducted across successful payments in sequence.</p></div>{hasSuccessfulPayment && commissions.length > 0 && <button type="button" className="btn-secondary" onClick={() => setCommissionHistoryOpen(true)}><Eye size={14} /> Commission history</button>}</div>
      {commissions.length ? <>
        <div className="pickup-payment-balance"><span>Total commission: <strong>{formatMoney(totals.commission)}</strong></span><span>Deducted: <strong>{formatMoney(totals.deducted)}</strong></span><span>Remaining to deduct: <strong>{formatMoney(totals.outstanding)}</strong></span></div>
        <div className="pickup-payment-table-wrap"><table className="pickup-payment-table pickup-plot-leads-table pickup-plot-no-row-hover" aria-label="Plot commission ledger" style={{ minWidth: 1080 }}>
          <thead><tr><th>Sales Executive</th><th>Total deal</th><th>Commission %</th><th>Total commission</th><th>Deducted</th><th>Remaining</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{displayedCommissions.map((commission) => { const status = String(commission.status || "EARNED").toUpperCase(); return <tr key={commission.id}>
            <td>{commission.brokerName || customer.workflow?.broker?.assignee?.name || "Sales Executive"}</td>
            <td style={{ whiteSpace: "nowrap" }}><strong>{formatMoney(commission.eligibleAmount, commission.currency)}</strong><small className="pickup-muted" style={{ display: "block" }}>Full deal amount</small></td>
            <td>{status === "EARNED" ? <div className="pickup-commission-rate-control"><input className="input-field" type="number" min="0" max="100" step="0.01" aria-label={`Commission percentage for ${commission.brokerName || "Sales Executive"}`} value={rates[commission.id] ?? commission.commissionPercent} onChange={(event) => setRates((current) => ({ ...current, [commission.id]: event.target.value }))} /><span aria-hidden="true">%</span><button type="button" className="btn-secondary" disabled={updatingId === commission.id || !Number.isFinite(commission.displayedRate) || commission.displayedRate < 0 || commission.displayedRate > 100} onClick={() => onUpdateRate(commission.id, commission.displayedRate)}>Save</button></div> : `${Number(commission.commissionPercent || 0)}%`}</td>
            <td style={{ whiteSpace: "nowrap" }}><strong>{formatMoney(commission.commissionAmount, commission.currency)}</strong><small className="pickup-muted" style={{ display: "block", minWidth: 210 }}>{formatMoney(commission.eligibleAmount, commission.currency)} × {Number.isFinite(commission.displayedRate) ? commission.displayedRate : 0}%</small></td>
            <td style={{ whiteSpace: "nowrap" }}>{formatMoney(commission.commissionDeducted, commission.currency)}</td>
            <td style={{ whiteSpace: "nowrap" }}>{formatMoney(commission.commissionOutstanding, commission.currency)}</td>
            <td><span className="pickup-payment-status">{displayValue(status)}</span></td>
            <td>{status === "EARNED" ? <button type="button" className="btn-secondary" disabled={updatingId === commission.id || Number(commission.commissionOutstanding || 0) > 0} title={Number(commission.commissionOutstanding || 0) > 0 ? "Commission must be fully deducted before approval" : undefined} onClick={() => onUpdateStatus(commission.id, "APPROVED")}>Approve</button> : status === "APPROVED" ? <button type="button" className="btn-primary" disabled={updatingId === commission.id} onClick={() => onUpdateStatus(commission.id, "PAID")}>Mark paid</button> : <span className="pickup-muted">No action</span>}</td>
          </tr>; })}</tbody>
        </table></div>
      </> : <div className="pickup-payment-empty"><strong>No commission earned yet</strong><span>{commissionRate > 0 ? `${commissionRate}% will accrue automatically when a payment succeeds.` : "Set a commission percentage for the assigned Sales Executive to start tracking."}</span></div>}
      {commissionHistoryOpen && createPortal(<div role="presentation" className="pickup-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCommissionHistoryOpen(false); }}><div role="dialog" aria-modal="true" aria-labelledby="commission-history-dialog-title" className="card pickup-edit-dialog pickup-history-dialog"><div className="pickup-dialog-header"><div><h2 id="commission-history-dialog-title">Commission history</h2><p className="pickup-muted">Commission deductions from each successful payment.</p></div><button type="button" className="btn-secondary" aria-label="Close commission history" onClick={() => setCommissionHistoryOpen(false)}><X size={17} /></button></div><div className="pickup-payment-table-wrap"><table className="pickup-payment-table pickup-plot-leads-table pickup-plot-no-row-hover" aria-label="Commission history"><thead><tr><th>Payment date</th><th>Gross payment</th><th>Commission deducted</th><th>Net after commission</th></tr></thead><tbody>{commissionHistory.length ? commissionHistory.map(({ commission, allocation }) => <tr key={`${commission.id}-${allocation.paymentId}`}><td>{formatPickupStatusDate(allocation.paidAt)}</td><td>{formatMoney(allocation.grossAmount, commission.currency)}</td><td>{formatMoney(allocation.commissionDeduction, commission.currency)}</td><td>{formatMoney(allocation.netPaymentAmount, commission.currency)}</td></tr>) : <tr><td colSpan="4" className="pickup-empty-cell">No commission deductions recorded yet.</td></tr>}</tbody></table></div></div></div>, document.body)}
    </section>
  );
}

function PaymentSection({ customer, selectedPlot, isAdmin, commissionUpdatingId, onUpdateCommission, onUpdateCommissionRate, onGeneratePayment, onAddInstallment, onInitiateInstallment }) {
  const [paymentHistoryOpen, setPaymentHistoryOpen] = useState(false);
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
  const plannedInstallments = Array.isArray(customer.installments) ? customer.installments : [];
  const booking = customer.booking;
  const balance = remainingBookingBalance(customer);
  const initialPaymentCompleted = Boolean(firstSuccessfulPayment);
  const canGeneratePayment = Boolean(booking && selectedPlot && balance > 0);
  return (
    <div className="pickup-payment-sections">
      <section className="pickup-detail-section" aria-labelledby="initial-deposit-heading">
        <div className="pickup-section-heading pickup-section-heading-with-action"><span className="pickup-section-icon"><WalletCards size={17} /></span><div><h3 id="initial-deposit-heading">Initial deposit</h3><p>The first payment recorded for this plot booking.</p></div>{canGeneratePayment && !initialPaymentCompleted && <button type="button" className="btn-primary pickup-generate-payment" onClick={onGeneratePayment}><Link2 size={15} /> Generate payment</button>}</div>
        {initialPayment.length ? <PaymentTable label="Initial deposit payment" payments={initialPayment} showActions /> : (
          <div className="pickup-payment-empty"><strong>Initial deposit not recorded</strong><span>{booking ? `${formatMoney(booking.balance ?? booking.totalAmount)} currently outstanding.` : "Payment details will appear after a plot booking is created."}</span></div>
        )}
      </section>
      <section className="pickup-detail-section" aria-labelledby="future-installments-heading">
        <div className="pickup-section-heading pickup-section-heading-with-action"><span className="pickup-section-icon"><WalletCards size={17} /></span><div><h3 id="future-installments-heading">Future installments</h3><p>Every payment after the initial deposit is listed here.</p></div><div className="pickup-section-actions">{initialPaymentCompleted && <button type="button" className="btn-secondary" onClick={() => setPaymentHistoryOpen(true)}><Eye size={14} /> Payment history</button>}{canGeneratePayment && initialPaymentCompleted && plannedInstallments.length === 0 && <button type="button" className="btn-primary pickup-generate-payment" onClick={onAddInstallment}><Plus size={15} /> Add installment</button>}</div></div>
        {plannedInstallments.length > 0 && <div className="pickup-installment-table-wrap"><table className="pickup-installment-table pickup-plot-leads-table pickup-plot-no-row-hover" aria-label="Planned installments"><thead><tr><th>Installment</th><th>Due Date</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead><tbody>{plannedInstallments.map((installment) => { const installmentStatus = String(installment.status || "PLANNED").toUpperCase(); return <tr key={installment.id}><td>#{installment.sequenceNumber}</td><td>{new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(installment.dueDate))}</td><td>{formatMoney(installment.amount)}</td><td><span className="pickup-payment-status" data-status={installmentStatus}>{installmentStatusLabel(installmentStatus)}</span></td><td><InstallmentAction installment={installment} onInitiate={onInitiateInstallment} /></td></tr>; })}</tbody></table></div>}
        {installments.length ? <div className="pickup-payment-balance"><span>Remaining installment balance</span><strong>{formatMoney(balance)}</strong></div> : (
          <div className="pickup-payment-empty"><strong>{balance > 0 ? "No installment has been recorded yet" : "No future installments due"}</strong><span>{balance > 0 ? `${formatMoney(balance)} remains on this booking.` : "Any later installment will appear here as a table row."}</span></div>
        )}
      </section>
      {paymentHistoryOpen && createPortal(<div role="presentation" className="pickup-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaymentHistoryOpen(false); }}><div role="dialog" aria-modal="true" aria-labelledby="payment-history-dialog-title" className="card pickup-edit-dialog pickup-history-dialog"><div className="pickup-dialog-header"><div><h2 id="payment-history-dialog-title">Future installment payment history</h2><p className="pickup-muted">Payments recorded after the initial deposit.</p></div><button type="button" className="btn-secondary" aria-label="Close payment history" onClick={() => setPaymentHistoryOpen(false)}><X size={17} /></button></div><PaymentTable label="Future installment payment history" payments={installments} scrollable />{!installments.length && <p className="pickup-muted">No future installment payment has been recorded yet.</p>}</div></div>, document.body)}
      {isAdmin && customer.booking && <CommissionSection customer={customer} updatingId={commissionUpdatingId} onUpdateStatus={onUpdateCommission} onUpdateRate={onUpdateCommissionRate} />}
    </div>
  );
}

function CustomerDetails({ customer, isAdmin, commissionUpdatingId, onUpdateCommission, onUpdateCommissionRate, onEdit, onAssignPlots, onViewAssignedPlots, onViewStatus, onGeneratePayment, onAddInstallment, onInitiateInstallment }) {
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
    ["Pickup time", formatPickupStatusDate(customer.workflow?.transport?.pickupAt || customer.workflow?.transport?.scheduledPickupAt || customer.pickupAt || customer.scheduledPickupAt)],
    ["Site visit / drop-off time", formatPickupStatusDate(customer.workflow?.transport?.dropOffAt || customer.workflow?.transport?.scheduledDropOffAt || customer.dropOffAt || customer.scheduledDropOffAt)],
    ["Sales Executive", customer.workflow?.broker?.assignee?.name],
    ["Current status", `${PICKUP_STAGE_LABELS[customer.currentStage] || "Transport"}: ${formatPickupStatus(customer.currentStatus || customer.status)}`],
  ];
  const plotRows = (assignedPlot) => PLOT_FIELDS.map(([label, key, type]) => [label, type === "money" ? formatMoney(assignedPlot?.[key]) : displayValue(assignedPlot?.[key])]);
  return (
    <article className="pickup-customer-detail" data-testid="selected-customer-details">
      <header className="pickup-detail-header">
        <div className="pickup-customer-title"><span className="pickup-customer-avatar"><UserRound size={22} /></span><div><p>Selected customer</p><h2>{customer.contact?.name || "Customer"}</h2><span style={pickupTripStatusStyle(journeyStatus)}>{formatPickupStatus(journeyStatus)}</span></div></div>
        <div className="pickup-detail-actions">
          <button type="button" className="btn-secondary" onClick={onEdit} aria-label={`${customer.pickupAddress ? "Edit" : "Assign"} ${customer.contact?.name || "customer"} pickup location`} title={customer.pickupAddress ? "Edit pickup" : "Assign pickup"}>{customer.pickupAddress ? <Pencil size={14} /> : <Plus size={14} />}<span className="pickup-action-label">{customer.pickupAddress ? "Edit pickup" : "Assign pickup"}</span></button>
          {assignedPlots.length ? <button type="button" className="btn-secondary" onClick={onViewAssignedPlots} aria-label={`View plots for ${customer.contact?.name || "customer"}`} title="View plots"><Eye size={14} /><span className="pickup-action-label">View plots</span></button> : <button type="button" className="btn-secondary" onClick={onAssignPlots} aria-label={`Assign plots to ${customer.contact?.name || "customer"}`} title="Assign plots"><Plus size={14} /><span className="pickup-action-label">Assign plots</span></button>}
          <button type="button" className="btn-secondary" onClick={onViewStatus} aria-label={`View all status for ${customer.contact?.name || "customer"}`} title="Full workflow"><Eye size={14} /><span className="pickup-action-label">Full workflow</span></button>
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
      <PaymentSection customer={customer} selectedPlot={selectedPlot} isAdmin={isAdmin} commissionUpdatingId={commissionUpdatingId} onUpdateCommission={onUpdateCommission} onUpdateCommissionRate={onUpdateCommissionRate} onGeneratePayment={onGeneratePayment} onAddInstallment={onAddInstallment} onInitiateInstallment={onInitiateInstallment} />
    </article>
  );
}

export default function PickupCustomers() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";
  const [customers, setCustomers] = useState([]);
  const [plots, setPlots] = useState([]);
  const [pickupLocations, setPickupLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [viewingCustomer, setViewingCustomer] = useState(null);
  const [viewingAssignedPlots, setViewingAssignedPlots] = useState(null);
  const [changingPlotAssignment, setChangingPlotAssignment] = useState(null);
  const [editingPlotName, setEditingPlotName] = useState("");
  const [originalEditingPlotName, setOriginalEditingPlotName] = useState("");
  const [replacementPlotIds, setReplacementPlotIds] = useState([]);
  const [changingPlot, setChangingPlot] = useState(false);
  const [editAddress, setEditAddress] = useState("");
  const [selectedPickupLocationId, setSelectedPickupLocationId] = useState("");
  const [saving, setSaving] = useState(false);
  const [assigningCustomer, setAssigningCustomer] = useState(null);
  const [selectedPlotIds, setSelectedPlotIds] = useState([]);
  const [selectedPlotName, setSelectedPlotName] = useState("");
  const [assigningPlots, setAssigningPlots] = useState(false);
  const [paymentCustomer, setPaymentCustomer] = useState(null);
  const [installmentCustomer, setInstallmentCustomer] = useState(null);
  const [installmentSaving, setInstallmentSaving] = useState(false);
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [commissionUpdatingId, setCommissionUpdatingId] = useState(null);
  const [generatedPaymentLink, setGeneratedPaymentLink] = useState("");
  const [paymentForm, setPaymentForm] = useState({
    amount: "",
    amountMode: "minimum",
    percentage: String(DEFAULT_INITIAL_PAYMENT_PERCENT),
    installmentId: null,
    method: "payment_link",
    paidAt: localDateTimeInputValue(),
    transactionRef: "",
  });
  const [installmentForm, setInstallmentForm] = useState({ frequency: "MONTHLY", paymentCount: "1", firstPaymentDate: "", amount: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchApi("/api/pickup-plot-inventory/customer-pickups");
      const rows = Array.isArray(response?.customers) ? response.customers : [];
      setCustomers(rows);
      setPlots(Array.isArray(response?.plots) ? response.plots : []);
      setPickupLocations(Array.isArray(response?.pickupLocations) ? response.pickupLocations : []);
      setSelectedCustomerId((current) => rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
    } catch (error) {
      notify.error(error.message || "Could not load customer pickup status.");
    } finally { setLoading(false); }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const updateCommissionStatus = async (commissionId, nextStatus) => {
    setCommissionUpdatingId(commissionId);
    try {
      await fetchApi(`/api/pickup-plot-inventory/commissions/${commissionId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      notify.success(nextStatus === "APPROVED" ? "Commission approved." : "Commission marked as paid.");
      await load();
    } catch (error) {
      notify.error(error.message || "Could not update the commission.");
    } finally {
      setCommissionUpdatingId(null);
    }
  };

  const updateCommissionRate = async (commissionId, commissionPercent) => {
    setCommissionUpdatingId(commissionId);
    try {
      await fetchApi(`/api/pickup-plot-inventory/commissions/${commissionId}/rate`, {
        method: "PATCH",
        body: JSON.stringify({ commissionPercent }),
      });
      notify.success("Commission percentage updated.");
      await load();
    } catch (error) {
      notify.error(error.message || "Could not update the commission percentage.");
    } finally {
      setCommissionUpdatingId(null);
    }
  };

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
  const replacementAssignedPlotIds = useMemo(() => new Set(
    (
      changingPlotAssignment?.customer?.customerAssignedPlotIds
      || changingPlotAssignment?.customer?.assignedPlots?.map((plot) => plot.id)
      || []
    ).map(Number).filter(Number.isInteger),
  ), [changingPlotAssignment]);
  const editingPlotNameOptions = useMemo(() => [...new Map([
    ...(changingPlotAssignment?.customer?.assignedPlots?.length
      ? changingPlotAssignment.customer.assignedPlots
      : [changingPlotAssignment?.customer?.assignedPlot].filter(Boolean)),
    ...availablePlots,
  ].map((plot) => [String(plot.name || "").trim().toLowerCase(), String(plot.name || "").trim()])).values()].filter(Boolean), [availablePlots, changingPlotAssignment]);
  const replacementPlotChoices = useMemo(() => {
    if (!changingPlotAssignment?.customer) return [];
    const uniquePlots = new Map();
    availablePlots.forEach((plot) => {
      if (String(plot.name || "").trim().toLowerCase() !== editingPlotName.trim().toLowerCase()) return;
      const key = `${String(plot.name || "").trim().toLowerCase()}::${String(plot.plotNumber || "").trim().toLowerCase()}`;
      if (!uniquePlots.has(key) && !replacementAssignedPlotIds.has(Number(plot.id))) uniquePlots.set(key, plot);
    });
    return [...uniquePlots.values()]
      .sort((left, right) => String(left.plotNumber || "").localeCompare(
        String(right.plotNumber || ""),
        undefined,
        { numeric: true, sensitivity: "base" },
      ))
      .map((plot) => ({ plot, canSelect: true }));
  }, [availablePlots, changingPlotAssignment, editingPlotName, replacementAssignedPlotIds]);
  const editingAssignedPlotIds = useMemo(() => (
    changingPlotAssignment?.customer?.assignedPlots?.length
      ? changingPlotAssignment.customer.assignedPlots
      : [changingPlotAssignment?.customer?.assignedPlot].filter(Boolean)
  ).filter((plot) => String(plot.name || "").trim().toLowerCase() === editingPlotName.trim().toLowerCase()).map((plot) => Number(plot.id)), [changingPlotAssignment, editingPlotName]);
  const allEditingAssignedPlotIds = useMemo(() => (
    changingPlotAssignment?.customer?.assignedPlots?.length
      ? changingPlotAssignment.customer.assignedPlots
      : [changingPlotAssignment?.customer?.assignedPlot].filter(Boolean)
  ).map((plot) => Number(plot.id)), [changingPlotAssignment]);
  const editingComparisonIds = editingPlotName.trim().toLowerCase() !== originalEditingPlotName.trim().toLowerCase()
    ? allEditingAssignedPlotIds
    : editingAssignedPlotIds;
  const hasEditingPlotChanges = editingComparisonIds.length !== replacementPlotIds.length
    || editingComparisonIds.some((id) => !replacementPlotIds.includes(id));
  const openEdit = (row) => {
    const currentAddress = String(row.pickupAddress || "").trim().toLowerCase();
    const currentLocation = pickupLocations.find((location) => (
      String(location.address || "").trim().toLowerCase() === currentAddress
    ));
    setEditingCustomer(row);
    setEditAddress(currentLocation?.address || "");
    setSelectedPickupLocationId(currentLocation ? String(currentLocation.id) : "");
  };
  const selectPickupLocation = (locationId) => {
    const selectedLocation = pickupLocations.find((location) => String(location.id) === String(locationId));
    setSelectedPickupLocationId(locationId);
    setEditAddress(selectedLocation?.address || "");
  };
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
  const openAssignedPlotsEditor = (customer) => {
    const assignedPlots = (customer.assignedPlots?.length
      ? customer.assignedPlots
      : [customer.assignedPlot]).filter(Boolean);
    const firstEditablePlot = assignedPlots.find((plot) => (
      plot.id
      && String(plot.availability || "").trim().toUpperCase() !== "SOLD"
    ));
    if (!firstEditablePlot || customer.transportPerson) return;
    setViewingAssignedPlots(null);
    setChangingPlotAssignment({ customer });
    const firstPlotName = String(firstEditablePlot.name || "").trim() || availablePlotNames[0] || "";
    setEditingPlotName(firstPlotName);
    setOriginalEditingPlotName(firstPlotName);
    setReplacementPlotIds(assignedPlots.filter((plot) => String(plot.name || "").trim().toLowerCase() === firstPlotName.toLowerCase()).map((plot) => Number(plot.id)));
  };
  const closePlotReplacement = () => {
    if (changingPlot) return;
    setChangingPlotAssignment(null);
    setEditingPlotName("");
    setOriginalEditingPlotName("");
    setReplacementPlotIds([]);
  };
  const toggleReplacementPlot = (plotId, checked) => {
    const numericId = Number(plotId);
    setReplacementPlotIds((current) => (
      checked ? [...current, numericId] : current.filter((id) => id !== numericId)
    ));
  };
  const replaceAssignedPlot = async (event) => {
    event.preventDefault();
    const customer = changingPlotAssignment?.customer;
    const allAssignedPlots = (customer?.assignedPlots?.length ? customer.assignedPlots : [customer?.assignedPlot]).filter(Boolean);
    const changingPlotType = editingPlotName.trim().toLowerCase() !== originalEditingPlotName.trim().toLowerCase();
    const selectedTypeAssignedPlots = allAssignedPlots
      .filter((plot) => String(plot.name || "").trim().toLowerCase() === editingPlotName.trim().toLowerCase());
    const assignedIds = selectedTypeAssignedPlots.map((plot) => Number(plot.id));
    const additionalPlots = replacementPlotChoices
      .filter(({ plot }) => replacementPlotIds.includes(Number(plot.id)) && !assignedIds.includes(Number(plot.id)))
      .map(({ plot }) => plot);
    const removedPlots = (changingPlotType ? allAssignedPlots : selectedTypeAssignedPlots)
      .filter((plot) => !replacementPlotIds.includes(Number(plot.id)));
    if (!customer?.contact?.id || (!additionalPlots.length && !removedPlots.length)) return;
    const customerName = customer.contact.name || "this customer";
    const addedNumbers = additionalPlots.map((plot) => `Plot ${plot.plotNumber || "number unavailable"}`).join(", ");
    const removedNumbers = removedPlots.map((plot) => `Plot ${plot.plotNumber || "number unavailable"}`).join(", ");
    const confirmed = await notify.confirm({
      title: "Confirm plot assignments",
      message: `Are you sure you want to update ${customerName}'s ${editingPlotName} plots?${addedNumbers ? ` Assign ${addedNumbers}.` : ""}${removedNumbers ? ` Deselect ${removedNumbers}.` : ""}`,
      confirmText: "Save changes",
      cancelText: "Edit",
    });
    if (!confirmed) return;
    setChangingPlot(true);
    try {
      for (const plot of removedPlots) {
        await fetchApi(`/api/pickup-plot-inventory/customer-pickups/${customer.contact.id}/plots/${plot.id}`, {
          method: "DELETE",
        });
      }
      const plotsBySite = new Map();
      additionalPlots.forEach((plot) => {
        const key = String(plot.name || "").trim().toLowerCase();
        plotsBySite.set(key, [...(plotsBySite.get(key) || []), Number(plot.id)]);
      });
      for (const plotSiteIds of plotsBySite.values()) {
        await fetchApi(`/api/pickup-plot-inventory/customer-pickups/${customer.contact.id}/plots`, {
          method: "POST",
          body: JSON.stringify({ plotSiteIds }),
        });
      }
      notify.success("Plot assignments updated.");
      setChangingPlotAssignment(null);
      setEditingPlotName("");
      setOriginalEditingPlotName("");
      setReplacementPlotIds([]);
      await load();
    } catch (error) {
      notify.error(error?.body?.error || error?.message || "Could not assign the selected plots.");
    } finally {
      setChangingPlot(false);
    }
  };
  const assignPlots = async (event) => {
    event.preventDefault();
    if (!assigningCustomer?.contact?.id || !selectedPlotIds.length) return;
    const selectedPlots = assignablePlots.filter((plot) => selectedPlotIds.includes(Number(plot.id)));
    const plotNumbers = selectedPlots.map((plot) => `Plot ${plot.plotNumber}`).join(", ");
    const customerName = assigningCustomer.contact.name || "this customer";
    const confirmed = await notify.confirm({
      title: "Confirm plot assignment",
      message: `Are you sure you want to assign ${plotNumbers || `${selectedPlotIds.length} selected plot${selectedPlotIds.length === 1 ? "" : "s"}`} from ${selectedPlotName} to ${customerName}?`,
      confirmText: "Assign plots",
      cancelText: "Edit",
    });
    if (!confirmed) return;
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
      amount: String(installment?.amount ?? paymentAmountFromPercent(remainingBalance, DEFAULT_INITIAL_PAYMENT_PERCENT)),
      amountMode: installment ? "installment" : "minimum",
      percentage: String(DEFAULT_INITIAL_PAYMENT_PERCENT),
      installmentId: installment?.id ?? null,
      method: "payment_link",
      paidAt: localDateTimeInputValue(),
      transactionRef: "",
    });
  };
  const openInstallment = (row) => {
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const balance = remainingBookingBalance(row);
    setInstallmentCustomer(row);
    setInstallmentForm({
      frequency: "MONTHLY",
      paymentCount: "1",
      firstPaymentDate: nextMonth.toISOString().slice(0, 10),
      amount: suggestedInstallmentAmount(balance, 1),
    });
  };
  const updateInstallmentCount = (value) => {
    const paymentCount = Number(value);
    setInstallmentForm((current) => ({
      ...current,
      paymentCount: value,
      amount: suggestedInstallmentAmount(remainingBookingBalance(installmentCustomer), paymentCount),
    }));
  };
  const addInstallment = async (event) => {
    event.preventDefault();
    if (!installmentCustomer?.booking?.id) return;
    const amount = Number(installmentForm.amount);
    const paymentCount = Number(installmentForm.paymentCount);
    const balance = remainingBookingBalance(installmentCustomer);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(paymentCount) || paymentCount < 1 || amount * paymentCount > balance) {
      notify.error("The complete installment schedule must be within the remaining balance.");
      return;
    }
    setInstallmentSaving(true);
    try {
      await fetchApi(`/api/pickup-plot-inventory/customer-pickups/${installmentCustomer.contact.id}/installments`, {
        method: "POST",
        body: JSON.stringify({
          plotBookingId: installmentCustomer.booking.id,
          frequency: installmentForm.frequency,
          paymentCount,
          firstPaymentDate: installmentForm.firstPaymentDate,
          amount,
        }),
      });
      setInstallmentCustomer(null);
      notify.success(`${paymentCount} installment${paymentCount === 1 ? "" : "s"} scheduled in sequence.`);
      await load();
    } catch (error) {
      notify.error(error.message || "Could not create the installment schedule.");
    } finally {
      setInstallmentSaving(false);
    }
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
        ...(paymentForm.installmentId ? { installmentId: paymentForm.installmentId } : {}),
        ...(paymentForm.method === "payment_link" ? {} : {
          paidAt: new Date(paymentForm.paidAt).toISOString(),
          ...(paymentForm.transactionRef.trim() ? { transactionRef: paymentForm.transactionRef.trim() } : {}),
        }),
      };
      const result = await fetchApi(`/api/pickup-plot-inventory/customer-pickups/${paymentCustomer.contact.id}/initial-payment`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const paymentLinkUrl = result?.url || result?.paymentLinkUrl || result?.shortUrl;
      if (paymentForm.method === "payment_link" && paymentLinkUrl) {
        setGeneratedPaymentLink(paymentLinkUrl);
        notify.success("Payment link generated. Share it with the customer.");
      } else if (paymentForm.method === "payment_link") {
        notify.error("Razorpay did not return a payment link. Please check the payment gateway configuration and try again.");
      } else if (result?.mode === "recorded" || result?.payment?.status === "SUCCESS") {
        const hasSuccessfulPayment = paymentCustomer.payments?.some(
          (payment) => String(payment.status || "").toUpperCase() === "SUCCESS",
        );
        notify.success(hasSuccessfulPayment ? "Installment payment recorded." : "Initial payment recorded.");
        setPaymentCustomer(null);
      } else {
        notify.error("The payment could not be recorded. Please try again.");
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
  const updateInitialPaymentMode = (amountMode) => {
    setPaymentForm((current) => ({
      ...current,
      amountMode,
      amount: amountMode === "full"
        ? String(paymentBalance)
        : paymentAmountFromPercent(paymentBalance, current.percentage),
    }));
  };
  const updateInitialPaymentPercentage = (percentage) => {
    setPaymentForm((current) => ({
      ...current,
      amountMode: "minimum",
      percentage,
      amount: percentage === "" ? "" : paymentAmountFromPercent(paymentBalance, percentage),
    }));
  };
  const updateInitialPaymentAmount = (amount) => {
    const numericAmount = Number(amount);
    const percentage = amount !== "" && paymentBalance > 0 && Number.isFinite(numericAmount)
      ? String(Math.round((numericAmount / paymentBalance * 100) * 100) / 100)
      : "";
    setPaymentForm((current) => ({ ...current, amountMode: "minimum", amount, percentage }));
  };

  return (
    <main className="pickup-customers-page" data-testid="pickup-customers-page">
      <header className="pickup-page-header"><div><h1><MapPin size={28} /> Customer Status</h1><p>Select a customer to review their plot, deposit, and installment details.</p></div><button type="button" className="btn-secondary pickup-refresh" onClick={load} disabled={loading}><RefreshCw size={15} /> Refresh</button></header>
      <div className="pickup-master-detail">
        <aside className="card pickup-plot-table-scroll pickup-customer-directory" aria-label="Customer directory">
          <div className="pickup-directory-toolbar">
            <label style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, padding: '0 12px', border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--input-bg)' }}>
              <Search size={15} aria-hidden="true" style={{ flex: '0 0 15px', color: 'var(--text-secondary)' }} />
              <input className="input-field" type="text" aria-label="Search customer status" placeholder="Search customers..." value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: '100%', minWidth: 0, flex: '1 1 auto', height: 40, padding: 0, textIndent: 0, border: 0, outline: 0, background: 'transparent', boxShadow: 'none' }} />
            </label>
            <select className="input-field" aria-label="Filter customer trip status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="waiting">Awaiting assignment</option><option value="active">Active trips</option><option value="completed">Completed</option></select>
          </div>
          <div className="pickup-directory-scroll" data-testid="pickup-customers-table-scroll">
            <table className="pickup-customer-table pickup-plot-leads-table pickup-plot-no-row-hover" aria-label="Customer list">
              <thead><tr><th>Customer</th><th>Contact</th><th>Status</th></tr></thead>
              <tbody>
                {visibleCustomers.map((row) => { const selected = row.id === selectedCustomer?.id; const journeyStatus = customerJourneyStatus(row); return <tr key={row.id} className={selected ? "is-selected" : ""} onClick={() => setSelectedCustomerId(row.id)}><td><button type="button" onClick={() => setSelectedCustomerId(row.id)} aria-pressed={selected}>{row.contact?.name || "Customer"}</button><small>{row.assignedPlot?.name || row.contact?.interestedPlotArea || "No plot selected"}</small></td><td>{row.contact?.phone || row.contact?.email || "Not available"}</td><td><span style={pickupTripStatusStyle(journeyStatus)}>{formatPickupStatus(journeyStatus)}</span></td></tr>; })}
                {!visibleCustomers.length && <tr><td colSpan="3" className="pickup-empty-cell">No customer records match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
        </aside>
        <section className="card pickup-plot-table-scroll pickup-detail-pane" aria-live="polite">
          {loading ? <div className="pickup-detail-placeholder">Loading customer details…</div> : selectedCustomer ? <CustomerDetails key={selectedCustomer.id} customer={selectedCustomer} isAdmin={isAdmin} commissionUpdatingId={commissionUpdatingId} onUpdateCommission={updateCommissionStatus} onUpdateCommissionRate={updateCommissionRate} onEdit={() => openEdit(selectedCustomer)} onAssignPlots={() => openPlotAssignment(selectedCustomer)} onViewAssignedPlots={() => setViewingAssignedPlots(selectedCustomer)} onViewStatus={() => setViewingCustomer(selectedCustomer)} onGeneratePayment={() => openPayment(selectedCustomer)} onAddInstallment={() => openInstallment(selectedCustomer)} onInitiateInstallment={(installment) => openPayment(selectedCustomer, installment)} /> : <div className="pickup-detail-placeholder"><UserRound size={34} /><strong>Select a customer</strong><span>Their details will appear here.</span></div>}
        </section>
      </div>
      {editingCustomer && <div role="presentation" className="pickup-modal-backdrop"><form role="dialog" aria-modal="true" aria-labelledby="edit-pickup-title" className="card pickup-edit-dialog" onSubmit={savePickupLocation}><div className="pickup-dialog-header"><h2 id="edit-pickup-title">{editingCustomer.pickupAddress ? "Edit pickup location" : "Assign pickup location"}</h2><button type="button" className="btn-secondary" aria-label="Close pickup location dialog" onClick={() => setEditingCustomer(null)}><X size={17} /></button></div><p className="pickup-muted">{editingCustomer.contact?.name || "Customer"}</p><label className="pickup-edit-label">Pickup location<PickupLocationSelect value={selectedPickupLocationId} onChange={selectPickupLocation} options={pickupLocations} disabled={saving} ariaLabel="Pickup location" /></label>{pickupLocations.length === 0 && <p className="pickup-muted">No active pickup locations are available. Add one in Pickup Inventory first.</p>}<div className="pickup-dialog-actions"><button type="button" className="btn-secondary" onClick={() => setEditingCustomer(null)}>Cancel</button><button type="submit" className="btn-primary" disabled={saving || !selectedPickupLocationId}>{saving ? "Saving…" : editingCustomer.pickupAddress ? "Save changes" : "Assign pickup"}</button></div></form></div>}
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
                {!isInstallmentPayment && <fieldset className="pickup-payment-choice"><legend>Initial payment amount</legend><label><input type="radio" name="initial-payment-mode" value="minimum" checked={paymentForm.amountMode === "minimum"} onChange={() => updateInitialPaymentMode("minimum")} /><span><strong>Minimum payment</strong><small>Choose a percentage or enter the amount directly.</small></span></label><label><input type="radio" name="initial-payment-mode" value="full" checked={paymentForm.amountMode === "full"} onChange={() => updateInitialPaymentMode("full")} /><span><strong>Full payment</strong><small>Pay the complete outstanding balance.</small></span></label></fieldset>}
                {!isInstallmentPayment && paymentForm.amountMode === "minimum" ? <div className="pickup-initial-payment-fields"><label className="pickup-edit-label">Minimum percentage<div className="pickup-percentage-input"><input className="input-field" aria-label="Initial payment percentage" type="number" min="0.01" max="100" step="0.01" required value={paymentForm.percentage} onChange={(event) => updateInitialPaymentPercentage(event.target.value)} /><span aria-hidden="true">%</span></div></label><label className="pickup-edit-label">Payment amount<input className="input-field" aria-label="Initial payment amount" type="number" min="0.01" step="0.01" max={paymentBalance} required value={paymentForm.amount} onChange={(event) => updateInitialPaymentAmount(event.target.value)} /></label></div> : <label className="pickup-edit-label">{isInstallmentPayment ? "Installment amount" : "Payment amount"}<input className="input-field" aria-label={isInstallmentPayment ? "Installment payment amount" : "Initial payment amount"} type="number" min="0.01" step="0.01" max={paymentBalance} required readOnly={Boolean(paymentForm.installmentId) || (!isInstallmentPayment && paymentForm.amountMode === "full")} value={paymentForm.amount} onChange={(event) => isInstallmentPayment ? setPaymentForm((current) => ({ ...current, amount: event.target.value })) : updateInitialPaymentAmount(event.target.value)} /></label>}
                <label className="pickup-edit-label">Payment option<select className="input-field" aria-label={isInstallmentPayment ? "Installment payment option" : "Initial payment option"} value={paymentForm.method} onChange={(event) => setPaymentForm((current) => ({ ...current, method: event.target.value, transactionRef: "" }))}><option value="payment_link">Online payment link (UPI / Card / Net banking)</option><option value="cash">Record cash payment</option></select></label>
                {paymentForm.method === "cash" && <label className="pickup-edit-label">Payment date and time<input className="input-field" aria-label={isInstallmentPayment ? "Installment payment date and time" : "Initial payment date and time"} type="datetime-local" step="1" required value={paymentForm.paidAt} onChange={(event) => setPaymentForm((current) => ({ ...current, paidAt: event.target.value }))} /></label>}
                <div className="pickup-dialog-actions"><button type="button" className="btn-secondary" onClick={() => setPaymentCustomer(null)}>Cancel</button><button type="submit" className="btn-primary" disabled={paymentSaving}>{paymentSaving ? "Generating…" : paymentForm.method === "payment_link" ? "Generate link" : "Record payment"}</button></div>
              </>
            )}
          </form>
        </div>
      )}
      {installmentCustomer && (
        <div role="presentation" className="pickup-modal-backdrop">
          <form role="dialog" aria-modal="true" aria-labelledby="add-installment-title" className="card pickup-edit-dialog pickup-payment-dialog" onSubmit={addInstallment}>
            <div className="pickup-dialog-header"><div><h2 id="add-installment-title">Create installment plan</h2><p className="pickup-muted">Choose the frequency and date. The suggested amount is calculated from the remaining balance.</p></div><button type="button" className="btn-secondary" aria-label="Close add installment" onClick={() => setInstallmentCustomer(null)}><X size={17} /></button></div>
            <div className="pickup-payment-balance"><span>Remaining balance</span><strong>{formatMoney(remainingBookingBalance(installmentCustomer))}</strong></div>
            <div className="pickup-payment-manual-fields">
              <label className="pickup-edit-label">Payment frequency<select className="input-field" aria-label="Installment frequency" value={installmentForm.frequency} onChange={(event) => setInstallmentForm((current) => ({ ...current, frequency: event.target.value }))}><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly</option><option value="HALF_YEARLY">Half-Yearly</option><option value="YEARLY">Yearly</option></select></label>
              <label className="pickup-edit-label">Number of installments<input className="input-field" aria-label="Number of installments" type="number" min="1" max="120" step="1" required value={installmentForm.paymentCount} onChange={(event) => updateInstallmentCount(event.target.value)} /></label>
              <label className="pickup-edit-label">First payment date<input className="input-field" aria-label="First payment date" type="date" required value={installmentForm.firstPaymentDate} onChange={(event) => setInstallmentForm((current) => ({ ...current, firstPaymentDate: event.target.value }))} /></label>
            </div>
            <label className="pickup-edit-label">Amount per installment<input className="input-field" aria-label="Amount per installment" type="number" min="0.01" step="0.01" max={remainingBookingBalance(installmentCustomer)} required value={installmentForm.amount} onChange={(event) => setInstallmentForm((current) => ({ ...current, amount: event.target.value }))} /><small className="pickup-muted">Suggested: remaining balance ÷ number of installments. You can change this amount.</small></label>
            <div className="pickup-payment-balance"><span>Schedule total</span><strong>{formatMoney(Number(installmentForm.amount || 0) * Number(installmentForm.paymentCount || 0))}</strong></div>
            <div className="pickup-dialog-actions"><button type="button" className="btn-secondary" onClick={() => setInstallmentCustomer(null)}>Cancel</button><button type="submit" className="btn-primary" disabled={installmentSaving}>{installmentSaving ? "Creating…" : "Create schedule"}</button></div>
          </form>
        </div>
      )}
      {viewingAssignedPlots && (
        <div role="presentation" className="pickup-modal-backdrop">
          <section role="dialog" aria-modal="true" aria-labelledby="view-assigned-plots-title" className="card pickup-edit-dialog pickup-assigned-plots-dialog">
            <div className="pickup-dialog-header"><div><h2 id="view-assigned-plots-title">Assigned plots</h2><p className="pickup-muted">{viewingAssignedPlots.contact?.name || "Customer"}</p></div><div className="pickup-assigned-plots-header-actions">{!viewingAssignedPlots.transportPerson && (viewingAssignedPlots.assignedPlots?.length ? viewingAssignedPlots.assignedPlots : [viewingAssignedPlots.assignedPlot]).filter(Boolean).some((plot) => plot.id && String(plot.availability || "").trim().toUpperCase() !== "SOLD") && <button type="button" className="btn-secondary" aria-label={`Edit assigned plots for ${viewingAssignedPlots.contact?.name || "customer"}`} onClick={() => openAssignedPlotsEditor(viewingAssignedPlots)}><Pencil size={13} /> Edit</button>}<button type="button" className="btn-secondary" aria-label="Close assigned plots" onClick={() => setViewingAssignedPlots(null)}><X size={17} /></button></div></div>
            <div className="pickup-assigned-plot-list" aria-label="Assigned plot list">
              {(viewingAssignedPlots.assignedPlots?.length ? viewingAssignedPlots.assignedPlots : [viewingAssignedPlots.assignedPlot]).filter(Boolean).map((assignedPlot) => <div className="pickup-assigned-plot-item" key={assignedPlot.id}><span>{assignedPlot.name || "Unnamed plot"}</span><strong>{assignedPlot.plotNumber ? `Plot ${assignedPlot.plotNumber}` : "Plot number unavailable"}</strong></div>)}
            </div>
          </section>
        </div>
      )}
      {changingPlotAssignment && (
        <div role="presentation" className="pickup-modal-backdrop">
          <form role="dialog" aria-modal="true" aria-labelledby="edit-assigned-plot-title" className="card pickup-edit-dialog pickup-plot-dialog" onSubmit={replaceAssignedPlot}>
            <div className="pickup-dialog-header"><div><h2 id="edit-assigned-plot-title">Edit assigned plot</h2><p className="pickup-muted">{changingPlotAssignment.customer.contact?.name || "Customer"}</p></div><button type="button" className="btn-secondary" aria-label="Close edit assigned plot" onClick={closePlotReplacement} disabled={changingPlot}><X size={17} /></button></div>
            <p className="pickup-plot-help">
              Select or deselect plots for this Plot / Site. Choosing a different Plot / Site replaces the previous assignments.
            </p>
            <label className="pickup-edit-label">Plot / Site
              <select className="input-field" aria-label="Edit plot or site name" value={editingPlotName} disabled={changingPlot} onChange={(event) => { const name = event.target.value; setEditingPlotName(name); setReplacementPlotIds((changingPlotAssignment.customer.assignedPlots || []).filter((plot) => String(plot.name || "").trim().toLowerCase() === name.trim().toLowerCase()).map((plot) => Number(plot.id))); }}>
                {editingPlotNameOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <div className="pickup-plot-options" role="group" aria-label="Assigned and available plots">
              {(changingPlotAssignment.customer.assignedPlots?.length ? changingPlotAssignment.customer.assignedPlots : [changingPlotAssignment.customer.assignedPlot]).filter((assignedPlot) => assignedPlot && String(assignedPlot.name || "").trim().toLowerCase() === editingPlotName.trim().toLowerCase()).map((assignedPlot) => {
                const checked = replacementPlotIds.includes(Number(assignedPlot.id));
                const locked = String(assignedPlot.availability || "").trim().toUpperCase() === "SOLD";
                return <label key={assignedPlot.id} className={`pickup-plot-option${locked ? " is-unavailable" : ""}`}><input type="checkbox" value={assignedPlot.id} checked={checked} disabled={changingPlot || locked} onChange={(event) => toggleReplacementPlot(assignedPlot.id, event.target.checked)} /><span><strong>Plot {assignedPlot.plotNumber || "number unavailable"}</strong><small>{assignedPlot.name || "Unnamed plot"}{assignedPlot.block ? ` · Block ${assignedPlot.block}` : ""} · {locked ? "Sold" : "Assigned"}</small></span></label>;
              })}
              {replacementPlotChoices.filter(({ canSelect }) => canSelect).map(({ plot: plotOption }) => {
                const checked = replacementPlotIds.includes(Number(plotOption.id));
                return <label key={plotOption.id} className="pickup-plot-option"><input type="checkbox" value={plotOption.id} checked={checked} disabled={changingPlot} onChange={(event) => toggleReplacementPlot(plotOption.id, event.target.checked)} /><span><strong>Plot {plotOption.plotNumber}</strong><small>{plotOption.name}{plotOption.block ? ` · Block ${plotOption.block}` : ""} · Available</small></span></label>;
              })}
              {!replacementPlotChoices.some(({ canSelect }) => canSelect) && <div className="pickup-payment-empty"><strong>No additional plots available</strong><span>Every available plot is already assigned or unavailable.</span></div>}
            </div>
            <div className="pickup-dialog-actions"><button type="button" className="btn-secondary" onClick={closePlotReplacement} disabled={changingPlot}>Cancel</button><button type="submit" className="btn-primary" disabled={!hasEditingPlotChanges || changingPlot}>{changingPlot ? "Saving…" : "Save changes"}</button></div>
          </form>
        </div>
      )}
      {viewingCustomer && <PickupCustomerStatusDialog customer={viewingCustomer} onClose={() => setViewingCustomer(null)} />}
    </main>
  );
}
