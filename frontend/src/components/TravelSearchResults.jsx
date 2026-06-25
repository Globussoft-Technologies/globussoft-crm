// Visual search-result cards for the travel quote tools (Quote Builder, and
// reusable elsewhere). Three exports:
//   - FlightResultsBoard — GDS-style timeline rows (airline chip · depart →
//     duration/stops → arrive · price · seats left · Add).
//   - HotelResultsGrid   — photo cards. Real hotel photo when the provider
//     (TBO) supplies a thumbnail; otherwise a keyless Wikipedia destination
//     photo (the city's gallery, distributed across cards for variety, then the
//     city lead image as a fallback). So even AI/sample hotels look visual.
//   - TransferResultsList — compact vehicle rows.
//
// Presentational: the parent owns the data + the onAdd handler (drops the
// result into the quote as a line). Inline styles to match the existing pages.

import { useState } from "react";
import { Plus, Star, Car, MapPin, Plane, Sparkles, Hotel as HotelIcon } from "lucide-react";
import { useDestinationPhoto, useDestinationGallery } from "../utils/destinationPhotos";
import { destinationTheme } from "../utils/destinationTheme";

// ── shared formatters ────────────────────────────────────────────────
function fmtClock(s) {
  if (!s) return "—";
  const dt = new Date(s);
  if (!Number.isFinite(dt.getTime())) return "—";
  return dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function dayOffset(dep, arr) {
  if (!dep || !arr) return 0;
  const a = new Date(dep); const b = new Date(arr);
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return 0;
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((db - da) / 86400000));
}
function fmtDuration(min) {
  if (min == null || !Number.isFinite(Number(min))) return null;
  const m = Number(min); const h = Math.floor(m / 60); const r = m % 60;
  return `${h}h${r ? ` ${r}m` : ""}`;
}
function stopsLabel(stops) {
  if (stops == null) return null;
  return stops === 0 ? "Non-stop" : `${stops} stop${stops > 1 ? "s" : ""}`;
}
function money(currency, n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `${currency || "INR"} ${Number(n).toLocaleString()}`;
}

// Deterministic brand-ish colour per airline code (no real logos bundled).
const AIRLINE_COLORS = ["#1e4d8c", "#1e8449", "#8a4b9c", "#b9550e", "#0e7c86", "#9c2b46", "#4b5d8c", "#5a6b1e"];
function airlineColor(code) {
  const s = String(code || "??");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return AIRLINE_COLORS[Math.abs(h) % AIRLINE_COLORS.length];
}
function airlineDotStyle(code, size = 30) {
  return {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: size, height: size, borderRadius: 6, flexShrink: 0,
    background: airlineColor(code), color: "#fff", fontWeight: 700, fontSize: size > 26 ? 11 : 10,
  };
}

// ── Flights ──────────────────────────────────────────────────────────
export function FlightResultsBoard({ results, currency = "INR", onAdd, addLabel = "Add" }) {
  if (!results || !results.length) return null;
  return (
    <div style={{ border: "1px solid var(--border-color)", borderRadius: 10, overflow: "hidden", marginTop: 8 }}>
      {results.map((o, i) => {
        const off = dayOffset(o.departAt, o.arriveAt);
        const nonStop = (o.stops ?? 0) === 0;
        const seats = o.seatsAvailable;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderTop: i === 0 ? "none" : "1px solid var(--border-color)", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, width: 150, minWidth: 0 }}>
              <span style={airlineDotStyle(o.airline)}>{String(o.airline || o.airlineName || "??").slice(0, 2).toUpperCase()}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.airlineName || o.airline}</div>
                {o.flightNumber && <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{o.flightNumber}</div>}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 180 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{fmtClock(o.departAt)}</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{o.from}</div>
              </div>
              <div style={{ flex: 1, minWidth: 48, textAlign: "center" }}>
                {fmtDuration(o.durationMinutes) && <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{fmtDuration(o.durationMinutes)}</div>}
                <div style={{ position: "relative", height: 2, borderRadius: 2, background: "var(--border-color)", margin: "5px 6px" }}>
                  {!nonStop && <span style={{ position: "absolute", left: "50%", top: -2, transform: "translateX(-50%)", width: 6, height: 6, borderRadius: "50%", background: "var(--text-secondary)" }} />}
                </div>
                <div style={{ fontSize: 11, color: nonStop ? "#1e8449" : "var(--text-secondary)" }}>{stopsLabel(o.stops)}</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>
                  {fmtClock(o.arriveAt)}{off > 0 && <sup style={{ fontSize: 9, color: "var(--danger-color)", marginLeft: 1 }}>+{off}</sup>}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{o.to}</div>
              </div>
            </div>
            <div style={{ width: 84, textAlign: "center", fontSize: 11, color: "var(--text-secondary)" }}>
              {o.fareClass && <div>{o.fareClass}</div>}
              {o.baggage && <div>{o.baggage}</div>}
            </div>
            <div style={{ width: 120, textAlign: "right" }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>{money(currency, o.fare)}</div>
              <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>per pax</div>
              {seats != null && (
                <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2, color: seats <= 4 ? "#c0392b" : "#1e8449" }}>
                  {seats <= 0 ? "Sold out" : `${seats} seat${seats === 1 ? "" : "s"} left`}
                </div>
              )}
            </div>
            <button type="button" onClick={() => onAdd && onAdd(o)} style={addBtn}>
              <Plus size={12} /> {addLabel}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Hotel photo with error-state fallback ────────────────────────────
// Renders the hotel image if src loads; shows the gradient placeholder if
// src is absent or fails. Using a component (vs. inline onError style hack)
// because React state is the only reliable way to swap rendered output after
// a network error fires — DOM-style display:none leaves the parent transparent.
function HotelCardPhoto({ src, alt, fallbackBg, iconSize = 22 }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: fallbackBg }}>
        <HotelIcon size={iconSize} aria-hidden style={{ color: "rgba(255,255,255,0.85)" }} />
      </div>
    );
  }
  return (
    <img src={src} alt={alt} loading="lazy"
      onError={() => setFailed(true)}
      style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  );
}

// ── Hotels ───────────────────────────────────────────────────────────
export function HotelResultsGrid({ results, currency = "INR", city, onAdd, addLabel = "Add to quote" }) {
  // One Wikipedia gallery + lead photo per city (keyless). Distributed across
  // cards so each hotel shows a DIFFERENT real city photo when the provider
  // gives no thumbnail — visual variety without bundling hotel imagery.
  const gallery = useDestinationGallery(city || "");
  const lead = useDestinationPhoto(city || "");
  const theme = destinationTheme(city || "");
  if (!results || !results.length) return null;
  return (
    <div style={{ display: "grid", gap: 12, marginTop: 8, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 270px), 1fr))" }}>
      {results.map((h, i) => {
        const galleryPhoto = gallery.length ? gallery[i % gallery.length]?.url : null;
        const photo = h.thumbnail || galleryPhoto || lead || null;
        const stars = h.starRating ? Math.max(0, Math.min(5, Math.round(h.starRating))) : 0;
        return (
          <div key={i} style={hotelCard}>
            <div style={hotelPhotoWrap}>
              <HotelCardPhoto src={photo} alt={h.name || "Hotel"} fallbackBg={theme.gradient} iconSize={28} />
              <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(10,16,30,0.62), transparent 58%)" }} />
              {stars > 0 && (
                <div style={hotelStarBadge}>
                  {Array.from({ length: stars }, (_, k) => <Star key={k} size={11} fill="#f5c518" stroke="#f5c518" />)}
                </div>
              )}
              {h.refundable === true && <span style={hotelRefundBadge}>Refundable</span>}
              {h.rating != null && Number.isFinite(Number(h.rating)) && (
                <span style={hotelRatingBadge}>
                  <Star size={10} fill="#f5c518" stroke="#f5c518" /> {Number(h.rating).toFixed(1)}
                </span>
              )}
            </div>
            <div style={{ padding: "11px 13px", display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
              <strong style={{ fontSize: 14.5, lineHeight: 1.25, fontWeight: 700, letterSpacing: 0.1 }}>{h.name || "Hotel"}</strong>
              {(h.area || h.address) && (
                <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 4 }}>
                  <MapPin size={11} aria-hidden /> <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.area || h.address}</span>
                </div>
              )}
              {(h.roomType || h.board) && (
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {[h.roomType, h.board].filter(Boolean).join(" · ")}
                </div>
              )}
              <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 8, paddingTop: 6 }}>
                <div>
                  {h.ratePerNight != null && (
                    <div style={{ fontWeight: 800, fontSize: 15 }}>{money(currency, h.ratePerNight)}<span style={{ fontWeight: 400, fontSize: 10, color: "var(--text-secondary)" }}> /night</span></div>
                  )}
                  {h.totalRate != null && (
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{money(currency, h.totalRate)} total</div>
                  )}
                </div>
                <button type="button" onClick={() => onAdd && onAdd(h)} style={addBtn}>
                  <Plus size={12} /> {addLabel}
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Transfers ────────────────────────────────────────────────────────
export function TransferResultsList({ results, currency = "INR", onAdd, addLabel = "Add" }) {
  if (!results || !results.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      {results.map((t, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border-color)" }}>
          <span style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0, background: "rgba(14,124,134,0.14)", color: "#0e7c86", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <Car size={18} aria-hidden />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ fontSize: 13 }}>{t.vehicle || "Transfer"}</strong>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
              {[t.from && t.to && `${t.from} → ${t.to}`, t.durationMinutes && `~${t.durationMinutes} min`, t.note].filter(Boolean).join("  ·  ")}
            </div>
          </div>
          <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: "nowrap" }}>{money(currency, t.price)}</div>
          <button type="button" onClick={() => onAdd && onAdd(t)} style={addBtn}>
            <Plus size={12} /> {addLabel}
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Suggested itinerary (visual review of the 1-click Suggest output) ──
// A nexus-style panel: flights + per-city hotel cards with real imagery, a
// price summary, and Change flight / Change hotel controls. The parent owns the
// `suggestion` shape and the onChange* handlers (which re-sync the Line Items):
//   suggestion = {
//     currency, pax, adults,
//     flights:   [{ fromLabel, toLabel, options:[flight], selectedIdx }],
//     transfers: [{ fromLabel, toLabel, options:[transfer], selectedIdx }],
//     stays:     [{ city, nights, options:[hotel], selectedIdx }],
//   }

// Compact one-line flight render (chosen leg + alternative rows).
function FlightLine({ o, currency }) {
  const off = dayOffset(o.departAt, o.arriveAt);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={airlineDotStyle(o.airline, 26)}>{String(o.airline || o.airlineName || "??").slice(0, 2).toUpperCase()}</span>
      <div style={{ minWidth: 86 }}>
        <div style={{ fontWeight: 700, fontSize: 12.5 }}>{o.airlineName || o.airline}</div>
        {o.flightNumber && <div style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{o.flightNumber}</div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12 }}>
        <strong>{fmtClock(o.departAt)}</strong>
        <span style={{ color: "var(--text-secondary)" }}>{o.from}</span>
        <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>— {[fmtDuration(o.durationMinutes), stopsLabel(o.stops)].filter(Boolean).join(" · ")} →</span>
        <strong>{fmtClock(o.arriveAt)}{off > 0 && <sup style={{ fontSize: 9, color: "var(--danger-color)" }}>+{off}</sup>}</strong>
        <span style={{ color: "var(--text-secondary)" }}>{o.to}</span>
      </div>
      <div style={{ marginLeft: "auto", fontWeight: 800 }}>{money(currency, o.fare)}<span style={{ fontWeight: 400, fontSize: 10, color: "var(--text-secondary)" }}> /pax</span></div>
    </div>
  );
}

function SuggestedFlightLeg({ leg, currency, onSelect }) {
  const [open, setOpen] = useState(false);
  const sel = leg.options[leg.selectedIdx] || leg.options[0];
  if (!sel) return null;
  return (
    <div style={suggCard}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 12.5 }}>{leg.fromLabel} → {leg.toLabel}</strong>
        {leg.options.length > 1 && (
          <button type="button" onClick={() => setOpen(!open)} style={changeBtn}>{open ? "Close" : `Change flight (${leg.options.length})`}</button>
        )}
      </div>
      <FlightLine o={sel} currency={currency} />
      {open && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {leg.options.map((o, i) => (i === leg.selectedIdx ? null : (
            <div key={i} style={altRow}>
              <div style={{ flex: 1, minWidth: 0 }}><FlightLine o={o} currency={currency} /></div>
              <button type="button" onClick={() => { onSelect(i); setOpen(false); }} style={selectBtn}>Select</button>
            </div>
          )))}
        </div>
      )}
    </div>
  );
}

function hotelStars(h) {
  return h.starRating ? Math.max(0, Math.min(5, Math.round(h.starRating))) : 0;
}

function SuggestedStay({ stay, currency, onSelect }) {
  const [open, setOpen] = useState(false);
  const gallery = useDestinationGallery(stay.city || "");
  const lead = useDestinationPhoto(stay.city || "");
  const theme = destinationTheme(stay.city || "");
  const sel = stay.options[stay.selectedIdx] || stay.options[0];
  if (!sel) return null;
  const photoFor = (h, idx) => h.thumbnail || (gallery.length ? gallery[idx % gallery.length]?.url : null) || lead || null;
  return (
    <div style={suggCard}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Stay in {stay.city} · {stay.nights} night{stay.nights === 1 ? "" : "s"}</strong>
        {stay.options.length > 1 && (
          <button type="button" onClick={() => setOpen(!open)} style={changeBtn}>{open ? "Close" : `Change hotel (${stay.options.length})`}</button>
        )}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ width: 138, height: 100, borderRadius: 10, overflow: "hidden", flexShrink: 0, position: "relative" }}>
          <HotelCardPhoto src={photoFor(sel, stay.selectedIdx)} alt={sel.name || "Hotel"} fallbackBg={theme.gradient} iconSize={24} />
        </div>
        <div style={{ flex: 1, minWidth: 170 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>
            {sel.name}
            {hotelStars(sel) > 0 && <span style={{ marginLeft: 6 }}>{Array.from({ length: hotelStars(sel) }, (_, k) => <Star key={k} size={11} fill="#f5c518" stroke="#f5c518" style={{ verticalAlign: -1 }} />)}</span>}
          </div>
          {(sel.area || sel.address) && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{sel.area || sel.address}</div>}
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{[sel.roomType, sel.board, sel.refundable === true && "Refundable"].filter(Boolean).join(" · ")}</div>
          <div style={{ marginTop: 6, fontWeight: 800, fontSize: 14 }}>{money(currency, sel.totalRate != null ? sel.totalRate : sel.ratePerNight)}<span style={{ fontWeight: 400, fontSize: 10, color: "var(--text-secondary)" }}> total</span></div>
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 10, display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 210px), 1fr))" }}>
          {stay.options.map((h, i) => (i === stay.selectedIdx ? null : (
            <div key={i} style={hotelCard}>
              <div style={{ position: "relative", height: 88 }}>
                <HotelCardPhoto src={photoFor(h, i)} alt={h.name || "Hotel"} fallbackBg={theme.gradient} iconSize={20} />
              </div>
              <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
                <strong style={{ fontSize: 12.5, lineHeight: 1.25 }}>{h.name}</strong>
                <div style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{[hotelStars(h) > 0 && `${hotelStars(h)}★`, h.roomType].filter(Boolean).join(" · ")}</div>
                <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, paddingTop: 4 }}>
                  <span style={{ fontWeight: 800, fontSize: 12.5 }}>{money(currency, h.totalRate != null ? h.totalRate : h.ratePerNight)}</span>
                  <button type="button" onClick={() => { onSelect(i); setOpen(false); }} style={selectBtn}>Select</button>
                </div>
              </div>
            </div>
          )))}
        </div>
      )}
    </div>
  );
}

export function SuggestedItinerary({ suggestion, onChangeFlight, onChangeStay }) {
  if (!suggestion) return null;
  const { flights = [], stays = [], transfers = [] } = suggestion;
  if (!flights.length && !stays.length && !transfers.length) return null;
  const currency = suggestion.currency || "INR";
  const adults = Math.max(1, suggestion.adults || 1);
  const pax = Math.max(1, suggestion.pax || adults);
  // Preview total — the authoritative figure is the Line Items subtotal below.
  let total = 0;
  for (const leg of flights) { const o = leg.options[leg.selectedIdx]; if (o && o.fare != null) total += Number(o.fare) * pax; }
  for (const tr of transfers) { const t = tr.options[tr.selectedIdx]; if (t && t.price != null) total += Number(t.price); }
  for (const st of stays) { const h = st.options[st.selectedIdx]; if (h) total += Number(h.totalRate != null ? h.totalRate : (Number(h.ratePerNight) || 0) * (st.nights || 1)) || 0; }
  const perAdult = Math.round(total / adults);
  return (
    <section className="glass" aria-label="Suggested itinerary" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}><Sparkles size={16} aria-hidden /> Suggested itinerary</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "4px 0 0" }}>Review the picks — change any flight or hotel. Selections sync to the Line Items below.</p>
        </div>
        <div style={priceSummary}>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 2 }}>Price summary</div>
          <div style={{ fontSize: 12, display: "flex", justifyContent: "space-between", gap: 18 }}><span>Per adult</span><strong>{money(currency, perAdult)}</strong></div>
          <div style={{ fontSize: 14, display: "flex", justifyContent: "space-between", gap: 18, marginTop: 2 }}><span>Total</span><strong>{money(currency, total)}</strong></div>
        </div>
      </div>
      {flights.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={groupTitle}><Plane size={14} aria-hidden /> Flights</div>
          {flights.map((leg, i) => <SuggestedFlightLeg key={i} leg={leg} currency={currency} onSelect={(optIdx) => onChangeFlight && onChangeFlight(i, optIdx)} />)}
        </div>
      )}
      {stays.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={groupTitle}><HotelIcon size={14} aria-hidden /> Hotels</div>
          {stays.map((st, i) => <SuggestedStay key={i} stay={st} currency={currency} onSelect={(optIdx) => onChangeStay && onChangeStay(i, optIdx)} />)}
        </div>
      )}
      {transfers.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={groupTitle}><Car size={14} aria-hidden /> Transfers</div>
          {transfers.map((tr, i) => {
            const t = tr.options[tr.selectedIdx] || tr.options[0];
            if (!t) return null;
            return (
              <div key={i} style={suggCard}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, background: "rgba(14,124,134,0.14)", color: "#0e7c86", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Car size={16} aria-hidden /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong style={{ fontSize: 12.5 }}>{t.vehicle || "Transfer"}</strong>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{tr.fromLabel} → {tr.toLabel}{t.durationMinutes ? ` · ~${t.durationMinutes} min` : ""}</div>
                  </div>
                  <strong>{money(currency, t.price)}</strong>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── styles ───────────────────────────────────────────────────────────
const addBtn = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "6px 11px", borderRadius: 6, fontWeight: 700, fontSize: 12,
  background: "#1e8449", color: "#fff", border: "none", cursor: "pointer",
  whiteSpace: "nowrap", flexShrink: 0,
};
const hotelCard = {
  display: "flex", flexDirection: "column",
  border: "1px solid var(--border-color)", borderRadius: 14, overflow: "hidden",
  background: "var(--surface-color)",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 6px 16px rgba(0,0,0,0.06)",
};
const hotelPhotoWrap = {
  position: "relative", height: 140, width: "100%",
  background: "var(--subtle-bg, rgba(148,163,184,0.18))",
};
const hotelStarBadge = {
  position: "absolute", top: 8, left: 8, display: "flex", gap: 1,
  background: "rgba(10,16,30,0.55)", padding: "3px 6px", borderRadius: 20,
};
const hotelRatingBadge = {
  position: "absolute", bottom: 8, left: 8, display: "inline-flex", alignItems: "center", gap: 3,
  background: "rgba(10,16,30,0.62)", color: "#fff", fontSize: 11, fontWeight: 700,
  padding: "3px 8px", borderRadius: 20,
};
const hotelRefundBadge = {
  position: "absolute", top: 8, right: 8, fontSize: 10, fontWeight: 700,
  color: "#0b6b3a", background: "#d5f3e1", padding: "2px 7px", borderRadius: 20,
};
const suggCard = {
  border: "1px solid var(--border-color)", borderRadius: 10,
  padding: "10px 12px", marginTop: 8, background: "var(--surface-color)",
};
const groupTitle = {
  fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6,
  color: "var(--text-secondary)", marginBottom: 2,
};
const changeBtn = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "4px 10px", borderRadius: 6, fontWeight: 600, fontSize: 11.5,
  background: "transparent", color: "var(--accent-color)",
  border: "1px solid var(--border-color)", cursor: "pointer", whiteSpace: "nowrap",
};
const selectBtn = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "5px 11px", borderRadius: 6, fontWeight: 700, fontSize: 11.5,
  background: "#1e8449", color: "#fff", border: "none", cursor: "pointer",
  whiteSpace: "nowrap", flexShrink: 0,
};
const altRow = {
  display: "flex", alignItems: "center", gap: 10,
  padding: "7px 9px", borderRadius: 8, border: "1px solid var(--border-color)",
  background: "var(--bg-color)",
};
const priceSummary = {
  minWidth: 200, padding: "10px 14px", borderRadius: 10,
  border: "1px solid var(--border-color)", background: "var(--bg-color)",
};
