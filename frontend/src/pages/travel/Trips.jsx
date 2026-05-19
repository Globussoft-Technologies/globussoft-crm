// Travel CRM — TMC trips list view.
//
// Lands at /travel/trips. Operator-facing list showing destination,
// dates, school, participant count, status. Click → /travel/trips/:id
// for the full operational view (participants, rooming, payment plan,
// instalments, microsite link).
//
// No creation flow here — trips spawn from the linked Deal in the sales
// pipeline (Day 7+ Deal-extension lands later).

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Luggage, Filter, Users, Calendar as CalendarIcon } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "confirmed", label: "Confirmed" },
  { value: "in-trip", label: "In trip" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_COLORS = {
  confirmed: { bg: "rgba(47,122,77,0.14)", color: "#2F7A4D" },
  "in-trip": { bg: "rgba(200,154,78,0.18)", color: "#9A6F2E" },
  completed: { bg: "rgba(38,88,85,0.16)", color: "#265855" },
  cancelled: { bg: "rgba(168,50,63,0.14)", color: "#A8323F" },
};

function fmt(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

function fmtMoney(amt, currency = "INR") {
  if (amt == null) return "—";
  const n = Number(amt);
  if (!Number.isFinite(n)) return "—";
  if (currency === "INR" && n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  return `${currency === "INR" ? "₹" : currency + " "}${n.toLocaleString()}`;
}

export default function Trips() {
  const notify = useNotify();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    qs.set("limit", "100");
    fetchApi(`/api/travel/trips?${qs.toString()}`)
      .then((res) => setTrips(Array.isArray(res?.trips) ? res.trips : []))
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load trips");
        setTrips([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, marginBottom: 4 }}>
        <Luggage size={28} aria-hidden /> TMC Trips
      </h1>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        School educational trips. Operational view per trip — participants, rooming,
        payment plan, microsite — lives on the detail page.
      </p>

      <div style={{
        display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center",
        background: "var(--surface-color)", padding: 12, borderRadius: 8,
        border: "1px solid var(--border-color)", marginBottom: 16,
      }}>
        <Filter size={16} aria-hidden style={{ color: "var(--text-secondary)" }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle} aria-label="Filter by status">
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <button type="button" onClick={load} style={refreshBtn} aria-label="Reload list">Refresh</button>
      </div>

      <div style={{
        background: "var(--surface-color)", borderRadius: 8,
        border: "1px solid var(--border-color)", overflow: "hidden",
      }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : trips.length === 0 ? (
          <div style={empty}>
            No trips yet. New trips spawn from the linked Deal in the sales pipeline.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Trip code</th>
                <th style={th}>Destination</th>
                <th style={th}>Dates</th>
                <th style={th}>School</th>
                <th style={th}>Participants</th>
                <th style={th}>Per-student</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((t) => {
                const sc = STATUS_COLORS[t.status] || { bg: "var(--subtle-bg)", color: "var(--text-secondary)" };
                return (
                  <tr key={t.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                    <td style={td}>
                      <Link to={`/travel/trips/${t.id}`} style={{ color: "var(--primary-color)", textDecoration: "none", fontWeight: 600 }}>
                        {t.tripCode}
                      </Link>
                    </td>
                    <td style={td}>{t.destination}</td>
                    <td style={td}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <CalendarIcon size={12} aria-hidden />
                        {fmt(t.departDate)} → {fmt(t.returnDate)}
                      </span>
                    </td>
                    <td style={td}>#{t.schoolContactId}</td>
                    <td style={td}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <Users size={12} aria-hidden />
                        {t._count?.participants ?? 0}
                      </span>
                    </td>
                    <td style={td}>{fmtMoney(t.pricePerStudent)}</td>
                    <td style={td}>
                      <span style={{
                        background: sc.bg, color: sc.color,
                        padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: 0.5,
                      }}>
                        {t.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const selectStyle = {
  padding: "6px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  minWidth: 160, fontSize: 13,
};
const refreshBtn = {
  padding: "6px 12px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  fontSize: 13, cursor: "pointer",
};
const empty = {
  padding: 32, textAlign: "center",
  color: "var(--text-secondary)", fontSize: 14,
};
const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 12,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};
const td = {
  padding: "10px 12px", fontSize: 14,
  color: "var(--text-primary)",
};
