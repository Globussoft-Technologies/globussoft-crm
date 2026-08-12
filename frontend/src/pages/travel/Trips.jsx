// Travel CRM — TMC trips list view.
//
// Lands at /travel/trips. Operator-facing list showing destination,
// dates, school, participant count, status. Click → /travel/trips/:id
// for the full operational view (participants, rooming, payment plan,
// instalments, microsite link).
//
// No creation flow here — trips spawn from the linked Deal in the sales
// pipeline (Day 7+ Deal-extension lands later).

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  Luggage,
  Filter,
  Plus,
  Users,
  Calendar as CalendarIcon,
  X,
  Trash2,
  Search,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import TopScrollSync from "../../components/TopScrollSync";
import TripPager from "./TripPager";

// School is captured as free-text so the operator doesn't have to pre-create
// a Contact row for every new school. The backend POST /api/travel/trips
// accepts `schoolName`, finds-or-creates a tenant Contact (subBrand="tmc")
// with that name, and uses its id as schoolContactId. Existing callers that
// still pass schoolContactId continue to work — both shapes are supported.

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

function localDateKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const EMPTY_FORM = {
  tripCode: "",
  destination: "",
  schoolName: "",
  departDate: "",
  returnDate: "",
  pricePerStudent: "",
  status: "confirmed",
};

const BRAND_LABEL = "TMC";
const SUB_BRAND_LABEL = "School trips";
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [10, 20, 50];
const MAX_PAGE_SIZE = 200;
const TRIPS_TABLE_MIN_WIDTH = 1640;

function readPageParam(params) {
  return Math.max(1, parseInt(params.get("page") || "1", 10) || 1);
}

export default function Trips() {
  const notify = useNotify();
  const location = useLocation();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const page = readPageParam(searchParams);
  const [status, setStatus] = useState(searchParams.get("status") || "");
  const [search, setSearch] = useState(searchParams.get("search") || "");
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [isCustomPageSize, setIsCustomPageSize] = useState(false);
  const [customPageSize, setCustomPageSize] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const reqIdRef = useRef(0);
  const fromReports = searchParams.get("from") === "reports";
  const tripsListPath = `${location.pathname}${location.search}`;
  const today = localDateKey();

  const updateParams = useCallback(
    (patch, options = {}) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(patch)) {
        if (
          value === null ||
          value === undefined ||
          value === "" ||
          (Array.isArray(value) && !value.length)
        ) {
          next.delete(key);
        } else {
          next.set(key, String(value));
        }
      }
      setSearchParams(next, options);
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    const nextStatus = searchParams.get("status") || "";
    const nextSearch = searchParams.get("search") || "";
    setStatus((current) => (current === nextStatus ? current : nextStatus));
    setSearch((current) => (current === nextSearch ? current : nextSearch));
  }, [searchParams]);

  const pageCount = Math.max(1, Math.ceil((total || 0) / pageSize));
  const safePage = Math.min(page, pageCount);
  const hasActiveFilters = Boolean(status || search.trim());

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setCreating(true);
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    if (
      !form.tripCode.trim() ||
      !form.destination.trim() ||
      !form.schoolName.trim() ||
      !form.departDate ||
      !form.returnDate
    ) {
      notify.error(
        "Trip code, destination, school, depart + return dates required",
      );
      return;
    }
    if (form.departDate < today || form.returnDate < today) {
      notify.error("Depart and return dates must be today or later.");
      return;
    }
    if (form.returnDate < form.departDate) {
      notify.error("Return date must be on or after depart date.");
      return;
    }
    setSaving(true);
    try {
      const body = {
        tripCode: form.tripCode.trim(),
        destination: form.destination.trim(),
        schoolName: form.schoolName.trim(),
        departDate: form.departDate,
        returnDate: form.returnDate,
        status: form.status,
      };
      if (form.pricePerStudent)
        body.pricePerStudent = Number(form.pricePerStudent);
      await fetchApi("/api/travel/trips", {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify.success("Trip created");
      setCreating(false);
      setReloadTick((t) => t + 1);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to create trip");
    } finally {
      setSaving(false);
    }
  };

  const load = useCallback(
    async ({ reset = false } = {}) => {
      const myReqId = ++reqIdRef.current;
      if (reset) {
        setLoading(true);
        setTrips([]);
      } else {
        setLoading(true);
      }
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (search.trim()) qs.set("search", search.trim());
      qs.set("limit", String(pageSize));
      qs.set("offset", String(Math.max(0, (page - 1) * pageSize)));

      try {
        const res = await fetchApi(`/api/travel/trips?${qs.toString()}`);
        if (myReqId !== reqIdRef.current) return;
        const rows = Array.isArray(res?.trips) ? res.trips : [];
        setTrips(rows);
        setTotal(Number(res?.total) || 0);
      } catch (e) {
        if (myReqId !== reqIdRef.current) return;
        notify.error(e?.body?.error || "Failed to load trips");
        setTrips([]);
        setTotal(0);
      } finally {
        if (myReqId === reqIdRef.current) {
          setLoading(false);
        }
      }
    },
    [page, pageSize, search, status, notify],
  );

  useEffect(() => {
    load({ reset: true });
  }, [load, reloadTick]);

  useEffect(() => {
    if (total > 0 && page > pageCount) {
      updateParams({ page: pageCount }, { replace: true });
    }
  }, [page, pageCount, total, updateParams]);

  const handleStatusChange = (nextStatus) => {
    setStatus(nextStatus);
    updateParams({ status: nextStatus, page: 1 }, { replace: true });
  };

  const handleSearchChange = (value) => {
    setSearch(value);
    updateParams({ search: value, page: 1 }, { replace: true });
  };

  const setPage = useCallback(
    (nextPage) => {
      updateParams({ page: nextPage });
    },
    [updateParams],
  );

  const setPageSizeAndReset = useCallback(
    (nextPageSize) => {
      setPageSize(nextPageSize);
      updateParams({ page: 1 });
    },
    [updateParams],
  );

  // Track which trip is currently being deleted so we can disable its
  // row's trash button (prevents double-click race) without disabling
  // siblings.
  const [deletingId, setDeletingId] = useState(null);

  // DELETE /api/travel/trips/:id is ADMIN-only on the server
  // (requirePermission("trips","delete")). The route cascades through
  // participants, rooming, payment plan, microsite, document
  // requirements, AND PendingTripRegistration drafts via the schema's
  // onDelete:Cascade — so the confirmation copy MUST flag that. A
  // wrongly-deleted trip cannot be recovered without restoring the
  // mysqldump backup.
  const remove = async (t) => {
    const ok = await notify.confirm({
      title: "Delete trip",
      message:
        `Permanently delete "${t.tripCode}" — ${t.destination}?\n\n` +
        "This will also delete every participant, room assignment, payment-plan row, " +
        "instalment payment, document requirement, microsite, landing page, and " +
        "pending registration linked to this trip.\n\n" +
        "This cannot be undone.",
      confirmText: "Delete trip",
      destructive: true,
    });
    if (!ok) return;
    setDeletingId(t.id);
    // Toast before the network call fires so the operator sees
    // immediate feedback that the action is in progress — useful
    // because the cascade can take a moment on trips with many
    // participants.
    notify.info(`Deleting trip ${t.tripCode}…`);
    try {
      await fetchApi(`/api/travel/trips/${t.id}`, { method: "DELETE" });
      notify.success(`Trip ${t.tripCode} deleted`);
      load({ reset: true });
    } catch (e) {
      // The route returns 403 RBAC_DENIED for non-ADMIN callers; surface
      // the server-side message so the operator knows it's a perms issue
      // rather than a network problem.
      notify.error(e?.body?.error || "Failed to delete trip");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1480, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          {fromReports && (
            <Link
              to="/travel/reports"
              style={{ ...backLink, marginBottom: 10 }}
            >
              Back to reports
            </Link>
          )}
          <h1
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: 0,
              marginBottom: 4,
            }}
          >
            <Luggage size={28} aria-hidden /> TMC Trips
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
            School educational trips. Operational view per trip — participants,
            rooming, payment plan, microsite — lives on the detail page.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          style={primaryBtn}
          aria-label="Create a new trip"
        >
          <Plus size={14} /> New Trip
        </button>
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
          background: "var(--surface-color)",
          padding: 12,
          borderRadius: 8,
          border: "1px solid var(--border-color)",
          marginBottom: 16,
        }}
      >
        <Filter
          size={16}
          aria-hidden
          style={{ color: "var(--text-secondary)" }}
        />
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
          }}
        >
          <Search
            size={14}
            aria-hidden
            style={{
              position: "absolute",
              left: 8,
              color: "var(--text-secondary)",
              pointerEvents: "none",
            }}
          />
          <input
            type="search"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search trip code or destination…"
            aria-label="Search trips"
            style={{ ...selectStyle, paddingLeft: 28, minWidth: 240 }}
          />
        </div>
        <select
          value={status}
          onChange={(e) => handleStatusChange(e.target.value)}
          style={selectStyle}
          aria-label="Filter by status"
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => load({ reset: true })}
          style={refreshBtn}
          aria-label="Reload list"
        >
          Refresh
        </button>
      </div>

      <div
        style={{
          background: "var(--surface-color)",
          borderRadius: 8,
          border: "1px solid var(--border-color)",
        }}
      >
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : trips.length === 0 ? (
          <div style={empty}>
            {hasActiveFilters
              ? "No trips match the current filters."
              : "No trips yet. New trips spawn from the linked Deal in the sales pipeline."}
          </div>
        ) : (
          <>
            <TopScrollSync forceScrollbar>
              <table
                style={{
                  width: "100%",
                  minWidth: TRIPS_TABLE_MIN_WIDTH,
                  borderCollapse: "collapse",
                  tableLayout: "fixed",
                }}
              >
                <colgroup>
                  <col style={{ width: 190 }} />
                  <col style={{ width: 280 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 240 }} />
                  <col style={{ width: 250 }} />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 160 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 80 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={th}>Trip code</th>
                    <th style={th}>Destination</th>
                    <th style={th}>Brand</th>
                    <th style={th}>Sub-brand</th>
                    <th style={th}>Dates</th>
                    <th style={th}>School</th>
                    <th style={th}>Participants</th>
                    <th style={th}>Per-student</th>
                    <th style={th}>Status</th>
                    <th
                      style={{ ...th, width: 60, textAlign: "right" }}
                      aria-label="Actions"
                    ></th>
                  </tr>
                </thead>
                <tbody>
                  {trips.map((t) => {
                    const sc = STATUS_COLORS[t.status] || {
                      bg: "var(--subtle-bg)",
                      color: "var(--text-secondary)",
                    };
                    return (
                      <tr
                        key={t.id}
                        style={{ borderTop: "1px solid var(--border-light)" }}
                      >
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <Link
                            to={`/travel/trips/${t.id}`}
                            state={{
                              backTo: tripsListPath,
                              backLabel: fromReports
                                ? "Back to reports results"
                                : "Back to trips",
                            }}
                            style={{
                              color: "var(--primary-color)",
                              textDecoration: "none",
                              fontWeight: 600,
                            }}
                          >
                            {t.tripCode}
                          </Link>
                        </td>
                        <td style={{ ...td, minWidth: 0 }}>{t.destination}</td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <span style={brandBadge}>{BRAND_LABEL}</span>
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          {SUB_BRAND_LABEL}
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            <CalendarIcon size={12} aria-hidden />
                            {fmt(t.departDate)} ? {fmt(t.returnDate)}
                          </span>
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          {t.schoolName ||
                            (t.schoolContactId
                              ? `School #${t.schoolContactId}`
                              : "?")}
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            <Users size={12} aria-hidden />
                            {t._count?.participants ?? 0}
                          </span>
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          {fmtMoney(t.pricePerStudent)}
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              background: sc.bg,
                              color: sc.color,
                              padding: "2px 8px",
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 600,
                              textTransform: "uppercase",
                              letterSpacing: 0.5,
                            }}
                          >
                            {t.status}
                          </span>
                        </td>
                        <td
                          style={{
                            ...td,
                            textAlign: "right",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => remove(t)}
                            disabled={deletingId === t.id}
                            aria-label={`Delete trip ${t.tripCode}`}
                            title="Delete trip"
                            style={{
                              background: "transparent",
                              border: "1px solid var(--border-color)",
                              borderRadius: 6,
                              padding: "4px 6px",
                              color: "#A8323F",
                              cursor: deletingId === t.id ? "wait" : "pointer",
                              opacity: deletingId === t.id ? 0.5 : 1,
                              display: "inline-flex",
                              alignItems: "center",
                            }}
                          >
                            <Trash2 size={14} aria-hidden />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TopScrollSync>
            <TripPager
              total={total}
              page={safePage}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={setPageSizeAndReset}
              isCustomPageSize={isCustomPageSize}
              setIsCustomPageSize={setIsCustomPageSize}
              customPageSize={customPageSize}
              setCustomPageSize={setCustomPageSize}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              maxPageSize={MAX_PAGE_SIZE}
              entityLabel="trips"
            />
          </>
        )}
      </div>
      {creating && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) setCreating(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "1rem",
          }}
        >
          <form
            onSubmit={submitCreate}
            className="card"
            role="dialog"
            aria-modal="true"
            style={drawerStyle}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
                New Trip
              </h2>
              <button
                type="button"
                onClick={() => setCreating(false)}
                aria-label="Close"
                style={iconBtn}
              >
                <X size={16} />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={fieldLabel}>
                Trip code
                <input
                  required
                  type="text"
                  value={form.tripCode}
                  onChange={(e) =>
                    setForm({ ...form, tripCode: e.target.value })
                  }
                  style={inputStyle}
                  placeholder='e.g. "TMC-AND-2026-MUMBAI-G7"'
                />
              </label>
              <label style={fieldLabel}>
                Destination
                <input
                  required
                  type="text"
                  value={form.destination}
                  onChange={(e) =>
                    setForm({ ...form, destination: e.target.value })
                  }
                  style={inputStyle}
                  placeholder="Andaman"
                />
              </label>
              <label style={fieldLabel}>
                School
                <input
                  required
                  type="text"
                  value={form.schoolName}
                  onChange={(e) =>
                    setForm({ ...form, schoolName: e.target.value })
                  }
                  style={inputStyle}
                  placeholder='e.g. "DPS North" or "Bharat Public School"'
                  maxLength={200}
                />
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ ...fieldLabel, flex: 1 }}>
                  Depart date
                  <input
                    required
                    type="date"
                    value={form.departDate}
                    onChange={(e) =>
                      setForm({ ...form, departDate: e.target.value })
                    }
                    style={inputStyle}
                    min={today}
                  />
                </label>
                <label style={{ ...fieldLabel, flex: 1 }}>
                  Return date
                  <input
                    required
                    type="date"
                    value={form.returnDate}
                    onChange={(e) =>
                      setForm({ ...form, returnDate: e.target.value })
                    }
                    style={inputStyle}
                    min={form.departDate || today}
                  />
                </label>
              </div>
              <label style={fieldLabel}>
                Per-student price (optional)
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={form.pricePerStudent}
                  onChange={(e) =>
                    setForm({ ...form, pricePerStudent: e.target.value })
                  }
                  style={inputStyle}
                  placeholder="0"
                />
              </label>
              <label style={fieldLabel}>
                Status
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                  style={inputStyle}
                >
                  {STATUSES.filter((s) => s.value).map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 20,
              }}
            >
              <button
                type="button"
                onClick={() => setCreating(false)}
                style={refreshBtn}
              >
                Cancel
              </button>
              <button type="submit" disabled={saving} style={primaryBtn}>
                {saving ? "Creating…" : "Create Trip"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const selectStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  minWidth: 160,
  fontSize: 13,
};
const backLink = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 13,
  color: "var(--text-secondary)",
  textDecoration: "none",
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
};
const refreshBtn = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  fontSize: 13,
  cursor: "pointer",
};
const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "var(--accent-text, #fff)",
  border: "1px solid var(--primary-color, var(--accent-color))",
  cursor: "pointer",
};
// Centred modal — mirrors the Itineraries + Staff add-staff-member pattern.
// `.card` (set on the form element) supplies border-radius, border, blur
// and lifted shadow; we force opaque `--bg-color` here so the panel
// doesn't read as glassmorphic over the page content behind it.
const drawerStyle = {
  background: "var(--bg-color)",
  color: "var(--text-primary)",
  width: "100%",
  maxWidth: 480,
  maxHeight: "90vh",
  overflowY: "auto",
  padding: "1.5rem",
};
const iconBtn = {
  background: "transparent",
  border: "none",
  color: "var(--text-secondary)",
  cursor: "pointer",
  padding: 4,
};
const fieldLabel = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--text-secondary)",
  fontWeight: 500,
};
const inputStyle = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--input-bg, var(--surface-color))",
  color: "var(--text-primary)",
  fontSize: 14,
};
const empty = {
  padding: 32,
  textAlign: "center",
  color: "var(--text-secondary)",
  fontSize: 14,
};
const brandBadge = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  background: "rgba(91,110,225,0.14)",
  color: "var(--primary-color)",
};
const th = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  position: "sticky",
  top: 0,
  zIndex: 3,
  background: "var(--modal-bg, var(--bg-color))",
  backgroundColor: "var(--modal-bg, var(--bg-color))",
  backgroundClip: "padding-box",
  boxShadow: "inset 0 -1px 0 var(--border-color)",
  opacity: 1,
  backgroundImage: "none",
  isolation: "isolate",
  backdropFilter: "none",
  whiteSpace: "nowrap",
};
const td = {
  minWidth: 0,
  padding: "10px 12px",
  fontSize: 14,
  color: "var(--text-primary)",
  verticalAlign: "middle",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
