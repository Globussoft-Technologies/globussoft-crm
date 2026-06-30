// Public Travel Stall trip booking page (PRD §4.7 — 50%-advance flow).
//
// Lives at /trip/:shareToken (no auth). The advisor sends the lead a
// shareToken URL via WhatsApp/email; the lead lands here, reviews the
// itinerary, and pays the 50% deposit to lock the trip.
//
// Consumes the public endpoints from commit 8abf6f3:
//   GET  /api/travel/itineraries/public/:shareToken
//   POST /api/travel/itineraries/public/:shareToken/record-advance-payment
//
// Payment flow is currently demo-mode (no Razorpay/Stripe wiring until
// Q9 / payment-provider creds land). The "Pay" button POSTs to the
// record-advance endpoint with a generated reference; the page then
// re-fetches and shows the advance-paid state. The button label says
// "Pay" so the demo reflects the production UX — when the gateway
// wires in, this page only needs the button onClick swapped for the
// gateway's payment-intent helper.
//
// Uses raw fetch() (renders outside AuthContext shell), matching the
// pattern in TravelStallQuiz.jsx + wellness PublicBooking.jsx.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  AlertTriangle, Calendar, CheckCircle2, CreditCard, Globe, Hotel,
  Plane, RefreshCw, ShieldCheck, Ticket,
} from "lucide-react";
import { DestinationHero, DestinationSideRails } from "../../components/DestinationVisuals";

const ITEM_ICON = {
  flight: Plane,
  hotel: Hotel,
  transfer: Ticket,
  activity: Ticket,
  visa: ShieldCheck,
  insurance: ShieldCheck,
};

// A flight quote's destination is a route ("DEL→JED flights") that resolves to
// no photo. Map the arrival airport to its city so the hero/side-rails still
// get real destination visuals. Falls back to the raw string for anything else.
//
// Kept broad on purpose: the backend airport resolver (lib/airportResolver.js +
// the airport-iata LLM task) can turn ANY free-text place into an IATA code, so
// the arrival airport here can be far beyond the headline metros. This list
// mirrors that reach — all Indian airports the resolver knows plus the common
// Gulf/international ones — so the hero photo shows for real routes instead of
// degrading to the bare gradient. Anything still unmapped falls through to the
// themed gradient (graceful, never broken). Keep IATA codes UPPERCASE.
const IATA_CITY = {
  // ── India: metros + tier-2/3 (incl. Deoghar DGH, the case that regressed) ──
  DEL: "Delhi", BOM: "Mumbai", BLR: "Bangalore", MAA: "Chennai", HYD: "Hyderabad",
  CCU: "Kolkata", COK: "Kochi", GOI: "Goa", AMD: "Ahmedabad", PNQ: "Pune",
  JAI: "Jaipur", LKO: "Lucknow", CCJ: "Kozhikode", TRV: "Thiruvananthapuram",
  IXE: "Mangalore", NAG: "Nagpur", ATQ: "Amritsar", GAU: "Guwahati",
  VNS: "Varanasi", SXR: "Srinagar", DGH: "Deoghar", PAT: "Patna",
  BBI: "Bhubaneswar", IXR: "Ranchi", IXB: "Siliguri", IXC: "Chandigarh",
  IXJ: "Jammu", IXZ: "Port Blair", VTZ: "Visakhapatnam", RPR: "Raipur",
  IDR: "Indore", BHO: "Bhopal", UDR: "Udaipur", JDH: "Jodhpur", STV: "Surat",
  BDQ: "Vadodara", VGA: "Vijayawada", TIR: "Tirupati", HBX: "Hubli",
  IXM: "Madurai", CJB: "Coimbatore", TRZ: "Tiruchirappalli", IXA: "Agartala",
  GAY: "Gaya", DED: "Dehradun", IXL: "Leh", DIB: "Dibrugarh", IMF: "Imphal",
  // ── Gulf / Middle East (RFU Umrah + leisure) ──
  JED: "Jeddah", MED: "Medina", RUH: "Riyadh", DMM: "Dammam", DXB: "Dubai",
  AUH: "Abu Dhabi", SHJ: "Sharjah", DOH: "Doha", MCT: "Muscat", KWI: "Kuwait City",
  BAH: "Manama", AMM: "Amman", CAI: "Cairo",
  // ── Common international ──
  SIN: "Singapore", BKK: "Bangkok", KUL: "Kuala Lumpur", LHR: "London",
  CDG: "Paris", JFK: "New York", HND: "Tokyo", NRT: "Tokyo", CMB: "Colombo",
  KTM: "Kathmandu", MLE: "Maldives", DPS: "Bali", HKG: "Hong Kong",
  IST: "Istanbul", AYT: "Antalya", ZRH: "Zurich", FCO: "Rome", BCN: "Barcelona",
  AMS: "Amsterdam", FRA: "Frankfurt", SYD: "Sydney", MEL: "Melbourne",
};
function photoDestinationFor(destination) {
  const m = /[A-Z]{3}\s*(?:→|->|to)\s*([A-Z]{3})\s*flights?/i.exec(String(destination || ""));
  if (m) {
    const city = IATA_CITY[m[1].toUpperCase()];
    if (city) return city;
  }
  return destination;
}

// Lazily inject the Razorpay checkout SDK once. Resolves true when
// window.Razorpay is available, false if the script fails to load (offline /
// blocked). Idempotent — re-uses the already-loaded global on repeat calls.
const RAZORPAY_SDK_SRC = "https://checkout.razorpay.com/v1/checkout.js";
function loadRazorpayScript() {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(false);
    if (window.Razorpay) return resolve(true);
    const existing = document.querySelector(`script[src="${RAZORPAY_SDK_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(true));
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const s = document.createElement("script");
    s.src = RAZORPAY_SDK_SRC;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

export default function TripBooking() {
  const { shareToken } = useParams();
  const [itin, setItin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState("");
  // "Choose one" flight quotes: which option the customer picked (item id).
  const [selectedId, setSelectedId] = useState(null);
  // Collect-at-accept travel dates: the customer states/confirms preferred
  // dates before paying (quick-quote itineraries often have none).
  const [startInput, setStartInput] = useState("");
  const [endInput, setEndInput] = useState("");
  const [savingDates, setSavingDates] = useState(false);
  const [datesSaved, setDatesSaved] = useState(false);
  const [datesError, setDatesError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setLoadError("");
    fetch(`/api/travel/itineraries/public/${encodeURIComponent(shareToken || "")}`)
      .then(async (r) => {
        if (r.ok) return r.json();
        const body = await r.json().catch(() => ({}));
        if (body?.code === "NOT_SHARED") throw new Error("This trip is not yet ready to share. Please check back shortly.");
        if (r.status === 404) throw new Error("We couldn't find a trip with this link.");
        throw new Error(body.error || "Could not load the trip.");
      })
      .then(setItin)
      .catch((e) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, [shareToken]);

  useEffect(load, [load]);

  // Auto-select when a flight quote has exactly one option (nothing to choose).
  useEffect(() => {
    if (itin?.optionsMode) {
      const opts = (itin.items || []).filter((i) => i.itemType === "flight");
      if (opts.length === 1) setSelectedId(opts[0].id);
    }
  }, [itin]);

  // Prefill the travel-date inputs from the itinerary (if the advisor set any).
  useEffect(() => {
    if (!itin) return;
    if (itin.startDate) setStartInput(String(itin.startDate).slice(0, 10));
    if (itin.endDate) setEndInput(String(itin.endDate).slice(0, 10));
  }, [itin]);

  // Collect-at-accept: save the customer's preferred travel dates + notify the
  // advisor. Best-effort; surfaces an inline error on failure.
  const saveDates = async () => {
    if (!startInput) { setDatesError("Please pick your preferred start date."); return; }
    if (endInput && endInput < startInput) { setDatesError("End date can't be before the start date."); return; }
    setSavingDates(true);
    setDatesError("");
    try {
      const r = await fetch(
        `/api/travel/itineraries/public/${encodeURIComponent(shareToken)}/preferred-dates`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startDate: startInput, endDate: endInput || undefined }),
        },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || "Could not save your dates. Please try again.");
      }
      setDatesSaved(true);
      setItin((prev) => (prev ? { ...prev, startDate: startInput, endDate: endInput || prev.endDate } : prev));
    } catch (e) {
      setDatesError(e.message);
    } finally {
      setSavingDates(false);
    }
  };

  // PRD §4.7 — real Razorpay checkout (advance OR balance). Flow:
  //   1. POST create-payment-order → server mints a Razorpay order using the
  //      platform keys from env and returns { orderId, amount, currency, keyId }.
  //   2. Open the Razorpay checkout modal with that order.
  //   3. On success the modal returns a signed { order_id, payment_id,
  //      signature }; POST verify-payment → server validates the signature +
  //      refetches the captured amount + advances the itinerary state.
  //   4. Re-fetch to show the new paid state.
  const startPayment = async (kind, itineraryItemId) => {
    if (!itin) return;
    setPaying(true);
    setPayError("");
    try {
      const sdkReady = await loadRazorpayScript();
      if (!sdkReady) {
        throw new Error("Could not load the payment gateway. Check your connection and retry.");
      }

      const orderRes = await fetch(
        `/api/travel/itineraries/public/${encodeURIComponent(shareToken)}/create-payment-order`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, ...(itineraryItemId ? { itineraryItemId } : {}) }),
        },
      );
      const order = await orderRes.json().catch(() => ({}));
      if (!orderRes.ok) {
        throw new Error(order.error || "Could not start payment. Please try again.");
      }

      await new Promise((resolve, reject) => {
        const rzp = new window.Razorpay({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          order_id: order.orderId,
          name: itin.tenantName || "Travel Stall",
          description: `${kind === "balance" ? "Balance payment" : "Advance payment"} — ${itin.destination || "Trip"}`,
          // PRD §4.7 — redirect-based methods (Netbanking, UPI intent, some
          // 3DS cards) cannot finish inside the modal. Provide a callback URL
          // so Razorpay redirects back here after the bank page; the success
          // page forwards the signature to verify-payment. Non-redirect card
          // payments continue to use the handler below for an inline finish.
          callback_url: `${window.location.origin}/p/itinerary/${encodeURIComponent(shareToken)}/payment-success`,
          callback_method: "get",
          handler: async (resp) => {
            try {
              const vr = await fetch(
                `/api/travel/itineraries/public/${encodeURIComponent(shareToken)}/verify-payment`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    razorpay_order_id: resp.razorpay_order_id,
                    razorpay_payment_id: resp.razorpay_payment_id,
                    razorpay_signature: resp.razorpay_signature,
                    ...(itineraryItemId ? { itineraryItemId } : {}),
                  }),
                },
              );
              const vbody = await vr.json().catch(() => ({}));
              if (!vr.ok) throw new Error(vbody.error || "Payment verification failed.");
              resolve();
            } catch (err) {
              reject(err);
            }
          },
          modal: {
            // User closed the modal without paying — soft cancel, no error toast.
            ondismiss: () => reject(new Error("__cancelled__")),
          },
          theme: { color: "#C89A4E" },
        });
        rzp.on("payment.failed", (resp) => {
          reject(new Error(resp?.error?.description || "Payment failed. Please try again."));
        });
        rzp.open();
      });

      load(); // re-fetch to show the new paid state
    } catch (e) {
      if (e.message !== "__cancelled__") setPayError(e.message);
    } finally {
      setPaying(false);
    }
  };

  const payAdvance = () => startPayment("advance", itin?.optionsMode ? selectedId : undefined);
  const payBalance = () => startPayment("balance");

  if (loading) return <Shell><p style={{ color: "#5a6275" }}>Loading your trip…</p></Shell>;
  if (loadError) {
    return (
      <Shell>
        <div style={errorBox} role="alert">
          <AlertTriangle size={18} aria-hidden style={{ marginRight: 8, verticalAlign: -3 }} />
          {loadError}
        </div>
        <button type="button" onClick={load} style={secondaryBtn}>
          <RefreshCw size={14} aria-hidden /> Try again
        </button>
      </Shell>
    );
  }
  if (!itin) return null;

  // "Choose one" flight quote derived state. The customer picks one of the
  // alternative flight options; total + advance reflect that pick, and the
  // advance payment is taken against it (create-payment-order sets the total).
  const optionsMode = !!itin.optionsMode;
  const flightOptions = optionsMode ? itin.items.filter((i) => i.itemType === "flight") : [];
  const selected = flightOptions.find((o) => String(o.id) === String(selectedId)) || null;
  const displayTotal = optionsMode ? (selected ? Number(selected.totalPrice) : null) : itin.totalAmount;
  const displayAdvance = optionsMode
    ? (selected ? Math.round(Number(selected.totalPrice) * (itin.advanceRatio || 0) * 100) / 100 : null)
    : itin.advanceDue;
  // Flight quotes' destination is a route ("DEL→JED flights") with no photo —
  // resolve the arrival city so the hero/rails still show real visuals.
  const photoDest = photoDestinationFor(itin.destination);
  const hasDates = !!(itin.startDate || itin.endDate);

  return (
    <Shell tenantName={itin.tenantName}>
      {/* Culture photos filling the wide side gutters on desktop (Wikipedia,
          keyless). Hidden on narrow screens; never overlaps the card. */}
      <DestinationSideRails destination={itin.destination} photoDestination={photoDest} />
      {/* Destination hero — themed gradient + cultural motif + real photo,
          all auto-swapping with the destination. */}
      <DestinationHero destination={itin.destination} photoDestination={photoDest}>
        {hasDates && (
          <>
            <Calendar size={14} aria-hidden style={{ verticalAlign: -2, marginRight: 4 }} />
            {fmtDate(itin.startDate)} &mdash; {fmtDate(itin.endDate)}
            {" · "}
          </>
        )}
        <StatusBadge status={itin.status} />
      </DestinationHero>

      {/* Travel dates — editable before payment, locked (read-only) after. */}
      <section aria-labelledby="dates-heading" style={datesCard}>
        <h2 id="dates-heading" style={{ ...sectionHeading, marginTop: 0 }}>
          <Calendar size={16} aria-hidden style={{ verticalAlign: -3, marginRight: 6 }} />
          Your travel dates
        </h2>
        {(itin.status === "advance_paid" || itin.status === "fully_paid") ? (
          /* Locked after payment — show confirmed dates, prompt advisor contact for changes */
          <div>
            <p style={{ fontSize: 13, color: "#1e8449", margin: "0 0 8px", fontWeight: 500 }}>
              ✓ Dates confirmed and locked with your booking.
            </p>
            {hasDates ? (
              <p style={{ fontSize: 14, color: "#1a1f2e", margin: 0 }}>
                {fmtDate(itin.startDate)}{itin.endDate ? ` — ${fmtDate(itin.endDate)}` : ""}
              </p>
            ) : (
              <p style={{ fontSize: 13, color: "#5a6275", margin: 0 }}>
                No dates set — contact your advisor to confirm travel dates.
              </p>
            )}
            <p style={{ fontSize: 12, color: "#5a6275", margin: "8px 0 0" }}>
              Need to change your dates? Please contact your advisor directly.
            </p>
          </div>
        ) : (
          /* Editable before payment */
          <>
            <p style={{ fontSize: 13, color: "#5a6275", margin: "0 0 12px" }}>
              {datesSaved
                ? "Thanks! Your advisor has your preferred dates and will confirm availability."
                : hasDates ? "Confirm your dates or update them before paying." : "Tell us your preferred dates so we can lock the right fares before you pay."}
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#5a6275" }}>
                Start date
                <input type="date" value={startInput} onChange={(e) => { setStartInput(e.target.value); setDatesSaved(false); }} style={dateInput} aria-label="Preferred start date" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#5a6275" }}>
                End date (optional)
                <input type="date" value={endInput} min={startInput || undefined} onChange={(e) => { setEndInput(e.target.value); setDatesSaved(false); }} style={dateInput} aria-label="Preferred end date" />
              </label>
              <button type="button" onClick={saveDates} disabled={savingDates || datesSaved} style={{ ...secondaryBtn, opacity: savingDates || datesSaved ? 0.6 : 1 }}>
                {datesSaved ? "Dates saved ✓" : savingDates ? "Saving…" : "Save dates"}
              </button>
            </div>
            {datesError && <p style={{ fontSize: 12, color: "#b3261e", margin: "8px 0 0" }}>{datesError}</p>}
          </>
        )}
      </section>

      {optionsMode ? (
        <section aria-labelledby="items-heading">
          <h2 id="items-heading" style={sectionHeading}>Choose your flight</h2>
          <p style={{ fontSize: 13, color: "#5a6275", margin: "0 0 12px" }}>
            Select one option, then pay {Math.round((itin.advanceRatio || 0) * 100)}% to confirm.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 24px", display: "grid", gap: 10 }}>
            {flightOptions.map((item) => {
              const checked = String(selectedId) === String(item.id);
              const details = flightDetails(item);
              return (
                <li key={item.id}>
                  <label
                    style={{
                      ...itemRow, alignItems: "flex-start", cursor: "pointer",
                      borderColor: checked ? "#122647" : "#e5e7ee",
                      boxShadow: checked ? "0 0 0 2px rgba(18,38,71,0.18)" : "none",
                    }}
                  >
                    <input
                      type="radio"
                      name="flight-option"
                      checked={checked}
                      onChange={() => setSelectedId(item.id)}
                      aria-label={`Select ${item.description}`}
                      style={{ marginTop: 3, accentColor: "#122647", flexShrink: 0 }}
                    />
                    <Plane size={18} aria-hidden style={{ color: "#122647", flexShrink: 0, marginTop: 1 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{item.description}</div>
                      {details.length > 0 && <div style={detailMeta}>{details.join("  ·  ")}</div>}
                    </div>
                    {item.totalPrice != null && (
                      <div style={{ fontWeight: 700, color: "#122647", whiteSpace: "nowrap" }}>
                        {fmtMoney(item.totalPrice, itin.currency)}
                      </div>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <section aria-labelledby="items-heading">
          <h2 id="items-heading" style={sectionHeading}>Your trip includes</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 24px", display: "grid", gap: 10 }}>
            {itin.items.map((item) => {
              const Icon = ITEM_ICON[item.itemType] || Ticket;
              const details = flightDetails(item);
              return (
                <li key={item.id} style={{ ...itemRow, alignItems: "flex-start" }}>
                  <Icon size={18} aria-hidden style={{ color: "#122647", flexShrink: 0, marginTop: 1 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{item.description}</div>
                    <div style={{ fontSize: 12, color: "#7a8294", textTransform: "uppercase", letterSpacing: 0.5 }}>
                      {item.itemType}
                    </div>
                    {details.length > 0 && <div style={detailMeta}>{details.join("  ·  ")}</div>}
                  </div>
                  {item.totalPrice != null && (
                    <div style={{ fontWeight: 600, color: "#122647" }}>
                      {fmtMoney(item.totalPrice, itin.currency)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section style={costBox} aria-labelledby="cost-heading">
        <h2 id="cost-heading" style={{ ...sectionHeading, marginTop: 0 }}>Trip cost</h2>
        <Line
          label="Total"
          value={displayTotal != null ? fmtMoney(displayTotal, itin.currency) : "Select an option above"}
          bold
        />
        <Line
          label={`Advance (${Math.round((itin.advanceRatio || 0) * 100)}%)`}
          value={displayAdvance != null ? fmtMoney(displayAdvance, itin.currency) : "—"}
        />
        {itin.advancePaid > 0 && (
          <Line label="Paid so far" value={fmtMoney(itin.advancePaid, itin.currency)} positive />
        )}
        {itin.balanceDue > 0 && itin.advancePaid > 0 && (
          <Line label="Balance due" value={fmtMoney(itin.balanceDue, itin.currency)} bold />
        )}
      </section>

      {payError && <div role="alert" style={errorBox}>{payError}</div>}

      <PaymentCTA
        itin={itin}
        paying={paying}
        optionsMode={optionsMode}
        advanceAmount={displayAdvance}
        payDisabled={optionsMode ? !selected : itin.advanceDue <= 0}
        onPayAdvance={payAdvance}
        onPayBalance={payBalance}
      />

      {itin.pdfUrl && (
        <p style={{ marginTop: 18, textAlign: "center" }}>
          <a href={itin.pdfUrl} target="_blank" rel="noreferrer" style={{ color: "#122647", fontWeight: 600 }}>
            Download itinerary PDF
          </a>
        </p>
      )}

      {/* Once a payment is recorded, the customer can pull their receipt /
          invoice (rendered on-demand from the current payment state). */}
      {itin.advancePaid > 0 && (
        <p style={{ marginTop: itin.pdfUrl ? 8 : 18, textAlign: "center" }}>
          <a
            href={`/api/travel/itineraries/public/${encodeURIComponent(shareToken)}/receipt`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "#122647", fontWeight: 600 }}
          >
            Download payment receipt
          </a>
        </p>
      )}

      <p style={fineprint}>
        Secure payment. We&rsquo;ll email a receipt to the address on file.
      </p>
    </Shell>
  );
}

// ─── Payment CTA (state-machine) ─────────────────────────────────────

function PaymentCTA({ itin, paying, onPayAdvance, onPayBalance, optionsMode, advanceAmount, payDisabled }) {
  if (itin.status === "fully_paid") {
    return (
      <div style={successBox} role="status">
        <CheckCircle2 size={20} aria-hidden style={{ color: "#2ecc71" }} />
        <span><strong>Fully paid.</strong> Your trip is locked in. We&rsquo;ll send pre-trip details closer to departure.</span>
      </div>
    );
  }
  if (itin.status === "advance_paid") {
    return (
      <>
        <div style={successBox} role="status">
          <CheckCircle2 size={20} aria-hidden style={{ color: "#2ecc71" }} />
          <span><strong>Advance received.</strong> Your trip is confirmed. Settle the balance any time before departure.</span>
        </div>
        {itin.balanceDue > 0 && itin.onlinePaymentEnabled && (
          <button
            type="button"
            onClick={onPayBalance}
            disabled={paying}
            style={{ ...primaryBtn, opacity: paying ? 0.6 : 1, cursor: paying ? "wait" : "pointer" }}
          >
            <CreditCard size={16} aria-hidden />
            {paying ? "Processing…" : `Pay balance · ${fmtMoneyCompact(itin.balanceDue, itin.currency)}`}
          </button>
        )}
        {itin.balanceDue > 0 && !itin.onlinePaymentEnabled && (
          <div style={infoBox} role="status">Your advisor will share payment details for the balance.</div>
        )}
      </>
    );
  }
  if (itin.status === "rejected") {
    return (
      <div style={errorBox} role="alert">
        This trip was cancelled. Please contact your advisor for next steps.
      </div>
    );
  }
  // sent / accepted / revised / draft (draft is filtered server-side
  // already, but the branch is harmless).
  // Online pay is only offered when the agency has configured its own payment
  // gateway (itin.onlinePaymentEnabled). Otherwise the advisor arranges payment
  // offline — we never route customer money through the platform account.
  if (!itin.onlinePaymentEnabled) {
    return (
      <div style={infoBox} role="status">
        Your advisor will share payment details to confirm this trip.
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onPayAdvance}
      disabled={paying || payDisabled}
      style={{
        ...primaryBtn,
        opacity: (paying || payDisabled) ? 0.6 : 1,
        cursor: paying ? "wait" : (payDisabled ? "not-allowed" : "pointer"),
      }}
    >
      <CreditCard size={16} aria-hidden />
      {paying
        ? "Processing…"
        : optionsMode && advanceAmount == null
          ? "Select an option to continue"
          : `Pay ${Math.round((itin.advanceRatio || 0) * 100)}% to confirm · ${fmtMoneyCompact(advanceAmount, itin.currency)}`}
    </button>
  );
}

// ─── Shell + helpers ─────────────────────────────────────────────────

function Shell({ children, tenantName }) {
  return (
    <div style={page}>
      <div style={card}>
        <div style={brand}>
          <Globe size={18} aria-hidden style={{ color: "#122647" }} />
          <strong>{tenantName || "Travel Stall"}</strong>
        </div>
        {children}
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    sent: { label: "Quote sent", bg: "#eaf2fb", fg: "#1e4d8c" },
    accepted: { label: "Accepted", bg: "#e8f6ee", fg: "#1e8449" },
    revised: { label: "Revised", bg: "#fff3e0", fg: "#b76b00" },
    advance_paid: { label: "Advance paid", bg: "#e8f6ee", fg: "#1e8449" },
    fully_paid: { label: "Fully paid", bg: "#e8f6ee", fg: "#1e8449" },
    rejected: { label: "Cancelled", bg: "#fdecea", fg: "#922b21" },
  };
  const meta = map[status] || { label: status, bg: "#eee", fg: "#444" };
  return (
    <span style={{
      padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
      background: meta.bg, color: meta.fg, textTransform: "uppercase", letterSpacing: 0.5,
    }}>{meta.label}</span>
  );
}

function Line({ label, value, bold, positive }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between",
      padding: "8px 0", borderTop: "1px solid #ece6da", fontSize: 14,
    }}>
      <span style={{ color: "#5a6275" }}>{label}</span>
      <span style={{
        fontWeight: bold ? 700 : 500,
        color: positive ? "#1e8449" : "#1c2233",
      }}>{value}</span>
    </div>
  );
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// Date + time for flight departure/arrival (e.g. "2 Aug, 6:10 PM").
function fmtDateTime(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Pull the human-readable flight details (times / class / baggage) out of the
// item's detailsJson so the customer sees timing + baggage, not just a code.
// detailsJson is set by the flight quick-quote (airline/flightNumber/fareClass/
// route/departAt/arriveAt/baggage) and is already on the public projection.
function flightDetails(item) {
  let d = {};
  try {
    d = item.detailsJson
      ? (typeof item.detailsJson === "string" ? JSON.parse(item.detailsJson) : item.detailsJson)
      : {};
  } catch { d = {}; }
  const parts = [];
  const dep = fmtDateTime(d.departAt);
  const arr = fmtDateTime(d.arriveAt);
  if (dep) parts.push(`Departs ${dep}`);
  if (arr) parts.push(`Arrives ${arr}`);
  if (d.fareClass) parts.push(String(d.fareClass));
  if (d.baggage) parts.push(`Baggage: ${d.baggage}`);
  return parts;
}

function fmtMoney(n, currency = "INR") {
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${Number(n).toLocaleString("en-IN")}`;
  }
}

// Compact form for buttons: "₹50,000" not "₹50,000.00".
function fmtMoneyCompact(n, currency = "INR") {
  if (n == null) return "—";
  if (currency === "INR") return `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  return fmtMoney(n, currency);
}

// ─── Styles ──────────────────────────────────────────────────────────
// Travel Stall theme (PRD Q22 placeholder): navy #122647 + warm gold
// #C89A4E on cream #fbf7f0. Matches TravelStallQuiz.jsx.

const page = {
  minHeight: "100vh",
  background: "#fbf7f0",
  padding: "32px 16px",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  color: "#1c2233",
};
const card = {
  maxWidth: 680, margin: "0 auto",
  background: "#fff", borderRadius: 16, padding: "28px 28px 32px",
  boxShadow: "0 8px 32px rgba(18, 38, 71, 0.08)",
  border: "1px solid #ece6da",
};
const brand = {
  display: "flex", alignItems: "center", gap: 8, fontSize: 14,
  color: "#122647", marginBottom: 20,
  borderBottom: "1px solid #ece6da", paddingBottom: 14,
};
const sectionHeading = { fontSize: 17, margin: "18px 0 12px" };
const datesCard = {
  background: "#f7f3eb", border: "1px solid #ece6da", borderRadius: 12,
  padding: "16px 18px", margin: "0 0 22px",
};
const dateInput = {
  padding: "8px 10px", borderRadius: 8, border: "1px solid #d8d2c4",
  background: "#fff", color: "#122647", fontSize: 14,
};
const itemRow = {
  display: "flex", alignItems: "center", gap: 12,
  padding: "12px 14px", border: "1px solid #e5e7ee",
  borderRadius: 10, background: "#fff",
};
const detailMeta = {
  fontSize: 12, color: "#5a6275", marginTop: 4, lineHeight: 1.5,
};
const costBox = {
  marginTop: 4, padding: "16px 18px",
  background: "#f7f3eb", borderRadius: 12, border: "1px solid #ece6da",
};
const primaryBtn = {
  marginTop: 20, width: "100%", padding: "14px 18px",
  background: "#122647", color: "#fff", border: "none", borderRadius: 8,
  fontSize: 15, fontWeight: 600,
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
};
const secondaryBtn = {
  marginTop: 12, padding: "10px 16px",
  background: "transparent", color: "#122647",
  border: "1px solid #122647", borderRadius: 8,
  fontSize: 14, fontWeight: 600,
  display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
};
const errorBox = {
  marginTop: 16, padding: "10px 14px",
  background: "#fdecea", border: "1px solid #f5b7b1",
  color: "#922b21", borderRadius: 8, fontSize: 14,
};
const successBox = {
  marginTop: 16, padding: "14px 16px",
  background: "#e8f6ee", border: "1px solid #b7e4c7",
  color: "#1e6e3a", borderRadius: 10, fontSize: 14,
  display: "flex", alignItems: "center", gap: 10,
};
const infoBox = {
  marginTop: 16, padding: "12px 16px",
  background: "#eef2f8", border: "1px solid #cdd7e6",
  color: "#3b4a63", borderRadius: 10, fontSize: 14,
};
const fineprint = {
  textAlign: "center", color: "#7a8294",
  fontSize: 12, marginTop: 14,
};
