/**
 * RateHawkSearch.jsx — operator-facing RateHawk hotel-inventory search.
 *
 * Consumes /api/ratehawk (backend route commit be67789, tick #103 — thin
 * wrapper over backend/services/ratehawkClient.js). Endpoints:
 *   POST /api/ratehawk/search
 *     Body: { subBrand?, destinationCity, checkInDate, checkOutDate,
 *             guests = 2, rooms = 1 }
 *     → 200 { stub, tenantId, subBrand, destinationCity, checkInDate,
 *             checkOutDate, guests, rooms, hotels:[], note }
 *     → 402 { error, code: "RATEHAWK_BUDGET_EXCEEDED", spentCents, capCents }
 *     → 400 { error, code: "MISSING_DESTINATION" | "MISSING_CHECKIN" | "MISSING_CHECKOUT" }
 *   GET /api/ratehawk/cap-status   (ADMIN-only)
 *     → 200 { spentCents, capCents, percent, withinCap, alertThreshold }
 *     → 402 { error, code: "RATEHAWK_BUDGET_EXCEEDED", spentCents, capCents }
 *
 * STUB-mode caveat: the backend client is in stub mode (Q19 cred-blocked
 * per docs/CREDS_TRACKER.md Cat 1 — RateHawk partner onboarding). Today
 * every search response carries `stub: true` + a `note`. When the cred
 * swap lands (single-point in backend/services/ratehawkClient.js
 * `searchHotels` body), this UI continues to work unchanged — the stub
 * banner just stops rendering and the `hotels[]` array populates with
 * real inventory.
 *
 * Pattern mirror: cap-status pill + stub-mode banner + cap-exceeded banner
 * + filter row → fetch → render envelope all clone AdsGPTReports.jsx
 * (commit 850391d, tick #103). The book / cancel surfaces are NOT shipped
 * yet — they require a real hotelId from search results, which today is
 * always empty in stub mode. They'll land as a follow-up slice once real
 * hotel inventory populates.
 *
 * Access: ADMIN + MANAGER (operator search, not tenant-config). The
 * /cap-status call is ADMIN-only on the backend; MANAGER users get a 403
 * there which is swallowed silently (the cap-status pill simply does not
 * render).
 */

import { useEffect, useState } from "react";
import {
  Hotel,
  AlertCircle,
  Search,
  MapPin,
  Calendar,
  Users as UsersIcon,
  BedDouble,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { formatMoney } from "../../utils/money";
import { SUB_BRAND_IDS, subBrandLabel } from "../../utils/travelSubBrand";
import {
  CapStatusPill,
  StubModeBanner,
  CapExceededBanner,
} from "../../components/CapBanners";

// Sub-brand options — "(no sub-brand)" maps to the tenant-wide bucket.
const SUB_BRAND_OPTIONS = [
  { value: "", label: "All sub-brands" },
  ...SUB_BRAND_IDS.map((id) => ({ value: id, label: subBrandLabel(id) })),
];

// Default check-in: 7 days from today. Check-out: +3 nights. ISO yyyy-mm-dd
// for native <input type="date">.
function defaultCheckIn() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

function defaultCheckOut() {
  const d = new Date();
  d.setDate(d.getDate() + 10);
  return d.toISOString().slice(0, 10);
}

export default function RateHawkSearch() {
  const notify = useNotify();

  // Cap-status (loaded on mount; ADMIN-only on backend so MANAGER gets 403
  // and we render no pill at all rather than an error toast).
  const [capStatus, setCapStatus] = useState(null);
  const [capStatusLoading, setCapStatusLoading] = useState(true);

  // Filter state.
  const [subBrand, setSubBrand] = useState("");
  const [destinationCity, setDestinationCity] = useState("");
  const [checkInDate, setCheckInDate] = useState(defaultCheckIn());
  const [checkOutDate, setCheckOutDate] = useState(defaultCheckOut());
  const [guests, setGuests] = useState(2);
  const [rooms, setRooms] = useState(1);

  // Search-result state.
  const [searchResult, setSearchResult] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [capExceeded, setCapExceeded] = useState(null); // { spentCents, capCents } when 402

  // Load cap-status on mount. Swallow 403 silently (MANAGER role).
  useEffect(() => {
    let cancelled = false;
    setCapStatusLoading(true);
    fetchApi("/api/ratehawk/cap-status")
      .then((res) => {
        if (cancelled) return;
        setCapStatus(res);
      })
      .catch((err) => {
        if (cancelled) return;
        // 402 → cap already exceeded; surface in the pill as 100%.
        if (err?.status === 402 && err?.body) {
          setCapStatus({
            spentCents: err.body.spentCents,
            capCents: err.body.capCents,
            percent: 1,
            withinCap: false,
            alertThreshold: true,
          });
          return;
        }
        // 403 → MANAGER role; render no pill (silent).
        if (err?.status !== 403) {
          console.warn(
            "[RateHawkSearch] cap-status load failed:",
            err?.message,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setCapStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = async () => {
    if (!destinationCity.trim()) {
      notify.error("Destination city is required");
      return;
    }
    if (!checkInDate) {
      notify.error("Check-in date is required");
      return;
    }
    if (!checkOutDate) {
      notify.error("Check-out date is required");
      return;
    }

    setSearchLoading(true);
    setCapExceeded(null);
    try {
      const body = {
        destinationCity: destinationCity.trim(),
        checkInDate,
        checkOutDate,
        guests: Number(guests) || 2,
        rooms: Number(rooms) || 1,
      };
      if (subBrand) body.subBrand = subBrand;
      const res = await fetchApi("/api/ratehawk/search", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setSearchResult(res);
    } catch (err) {
      if (
        err?.status === 402 &&
        err?.body?.code === "RATEHAWK_BUDGET_EXCEEDED"
      ) {
        setCapExceeded({
          spentCents: err.body.spentCents,
          capCents: err.body.capCents,
        });
        setSearchResult(null);
        return;
      }
      const msg = err?.body?.error || err?.message || "Failed to search hotels";
      notify.error(msg);
      setSearchResult(null);
    } finally {
      setSearchLoading(false);
    }
  };

  const hotels = Array.isArray(searchResult?.hotels) ? searchResult.hotels : [];

  return (
    <div
      style={{
        padding: "2rem",
        height: "100%",
        overflowY: "auto",
        animation: "fadeIn 0.4s ease-out",
      }}
    >
      {/* Header row */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h1
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: 0,
              fontSize: "1.75rem",
              fontWeight: 600,
            }}
          >
            <Hotel
              size={26}
              color="var(--primary-color, var(--accent-color))"
              aria-hidden
            />{" "}
            RateHawk Hotel Search
          </h1>
          <p
            style={{
              color: "var(--text-secondary)",
              marginTop: 4,
              fontSize: "0.9rem",
              maxWidth: 720,
            }}
          >
            Search hotel inventory across the RateHawk aggregator (Booking.com
            / Expedia / others).
          </p>
        </div>
        {/* Cap-status pill (ADMIN-only; silent for MANAGER) */}
        {capStatusLoading ? null : (
          <CapStatusPill cap={capStatus} testid="ratehawk-cap-pill" />
        )}
      </header>

      {/* Cap-exceeded banner — fires when search returns 402 */}
      <CapExceededBanner
        cap={capExceeded}
        providerLabel="RateHawk"
        testid="ratehawk-cap-exceeded-banner"
      />

      {/* Filter bar */}
      <div
        className="glass"
        style={{
          padding: 12,
          marginBottom: 16,
          display: "flex",
          alignItems: "flex-end",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ ...filterField, flex: "1 1 220px", minWidth: 200 }}>
          <label htmlFor="ratehawk-destination" style={filterLabel}>
            Destination city <span style={{ color: "#f43f5e" }}>*</span>
          </label>
          <input
            id="ratehawk-destination"
            type="text"
            value={destinationCity}
            onChange={(e) => setDestinationCity(e.target.value)}
            placeholder="e.g. Mecca, Paris, Bangkok"
            style={inputStyle}
            data-testid="ratehawk-filter-destination"
          />
        </div>
        <div style={filterField}>
          <label htmlFor="ratehawk-checkin" style={filterLabel}>
            Check-in <span style={{ color: "#f43f5e" }}>*</span>
          </label>
          <input
            id="ratehawk-checkin"
            type="date"
            value={checkInDate}
            onChange={(e) => setCheckInDate(e.target.value)}
            style={inputStyle}
            data-testid="ratehawk-filter-checkin"
          />
        </div>
        <div style={filterField}>
          <label htmlFor="ratehawk-checkout" style={filterLabel}>
            Check-out <span style={{ color: "#f43f5e" }}>*</span>
          </label>
          <input
            id="ratehawk-checkout"
            type="date"
            value={checkOutDate}
            onChange={(e) => setCheckOutDate(e.target.value)}
            style={inputStyle}
            data-testid="ratehawk-filter-checkout"
          />
        </div>
        <div style={filterField}>
          <label htmlFor="ratehawk-guests" style={filterLabel}>
            Guests
          </label>
          <input
            id="ratehawk-guests"
            type="number"
            min={1}
            max={20}
            value={guests}
            onChange={(e) => setGuests(e.target.value)}
            style={{ ...inputStyle, width: 80 }}
            data-testid="ratehawk-filter-guests"
          />
        </div>
        <div style={filterField}>
          <label htmlFor="ratehawk-rooms" style={filterLabel}>
            Rooms
          </label>
          <input
            id="ratehawk-rooms"
            type="number"
            min={1}
            max={10}
            value={rooms}
            onChange={(e) => setRooms(e.target.value)}
            style={{ ...inputStyle, width: 80 }}
            data-testid="ratehawk-filter-rooms"
          />
        </div>
        <div style={filterField}>
          <label htmlFor="ratehawk-subbrand" style={filterLabel}>
            Sub-brand
          </label>
          <select
            id="ratehawk-subbrand"
            value={subBrand}
            onChange={(e) => setSubBrand(e.target.value)}
            style={selectStyle}
            data-testid="ratehawk-filter-subbrand"
          >
            {SUB_BRAND_OPTIONS.map((o) => (
              <option key={o.value || "__all__"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={runSearch}
          disabled={searchLoading}
          style={primaryBtn}
          data-testid="ratehawk-search-btn"
        >
          <Search size={14} aria-hidden />
          {searchLoading ? "Searching…" : "Search hotels"}
        </button>
      </div>

      {/* Stub-mode banner — surfaces when backend client is still pre-cred */}
      {searchResult?.stub && (
        <StubModeBanner testid="ratehawk-stub-banner">
          <strong>Stub-mode response</strong> (Q19 cred pending) — RateHawk
          partner onboarding is the unblock; real hotel inventory will populate
          once the swap is done. The dashboard layout and contract won&apos;t
          change.
        </StubModeBanner>
      )}

      {/* Search result area */}
      {searchLoading ? (
        <div
          className="card"
          style={{
            padding: "3rem",
            textAlign: "center",
            color: "var(--text-secondary)",
          }}
        >
          Searching RateHawk inventory&hellip;
        </div>
      ) : capExceeded ? null : !searchResult ? (
        <div
          className="card"
          style={{
            padding: "3rem 2rem",
            textAlign: "center",
            color: "var(--text-secondary)",
          }}
          data-testid="ratehawk-empty-state"
        >
          <AlertCircle
            size={28}
            style={{ opacity: 0.5, marginBottom: 10 }}
            aria-hidden
          />
          <div style={{ fontWeight: 600 }}>No search performed yet.</div>
          <div style={{ fontSize: "0.9rem", marginTop: "0.5rem" }}>
            Enter a destination + dates + click &quot;Search hotels&quot; to
            query RateHawk inventory.
          </div>
        </div>
      ) : (
        <div>
          {/* Search summary */}
          <div
            className="card"
            style={{
              padding: "1rem 1.25rem",
              marginBottom: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
            }}
            data-testid="ratehawk-search-summary"
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              <span style={summaryChip}>
                <MapPin size={13} aria-hidden />{" "}
                {searchResult.destinationCity || destinationCity}
              </span>
              <span style={summaryChip}>
                <Calendar size={13} aria-hidden />{" "}
                {searchResult.checkInDate || checkInDate} &rarr;{" "}
                {searchResult.checkOutDate || checkOutDate}
              </span>
              <span style={summaryChip}>
                <UsersIcon size={13} aria-hidden />{" "}
                {searchResult.guests || guests} guests
              </span>
              <span style={summaryChip}>
                <BedDouble size={13} aria-hidden />{" "}
                {searchResult.rooms || rooms} rooms
              </span>
              {searchResult.subBrand && (
                <span style={subBrandBadge}>
                  {subBrandLabel(searchResult.subBrand)}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {hotels.length} hotel{hotels.length === 1 ? "" : "s"} returned
            </div>
          </div>

          {/* Hotel list */}
          {hotels.length === 0 ? (
            <div
              className="card"
              style={{
                padding: "2rem",
                textAlign: "center",
                color: "var(--text-secondary)",
                fontSize: 13,
              }}
              data-testid="ratehawk-no-hotels"
            >
              No hotels returned for this query
              {searchResult.stub ? " (expected in stub mode)" : ""}.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
                gap: 12,
              }}
              data-testid="ratehawk-hotel-list"
            >
              {hotels.map((h, idx) => (
                <HotelCard key={h.hotelId || h.id || idx} hotel={h} />
              ))}
            </div>
          )}

          {/* Optional note from backend (e.g. stub explanation) */}
          {searchResult.note && (
            <p
              style={{
                marginTop: 16,
                marginBottom: 0,
                fontSize: "0.82rem",
                color: "var(--text-secondary)",
                fontStyle: "italic",
              }}
            >
              {searchResult.note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Hotel card — minimal renderer for a single hotel from the search results.
 *
 * Hotel shape (when real-mode lands): { hotelId, name, address, starRating,
 * priceFromCents, currency, thumbnailUrl, rooms[] }. Stub mode never
 * populates the array, so the renderer below is forward-looking — it copes
 * with whatever subset of fields the real client returns.
 * ──────────────────────────────────────────────────────────────────────── */
function HotelCard({ hotel }) {
  const price =
    hotel.priceFromCents != null
      ? formatMoney(Number(hotel.priceFromCents) / 100, {
          currency: hotel.currency || "USD",
        })
      : null;
  return (
    <div
      className="card"
      style={{
        padding: "1rem 1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
      }}
      data-testid="ratehawk-hotel-card"
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: "1rem", minWidth: 0 }}>
          {hotel.name || hotel.hotelName || "Unnamed hotel"}
        </div>
        {hotel.starRating != null && (
          <span style={starBadge}>{Number(hotel.starRating).toFixed(1)}★</span>
        )}
      </div>
      {hotel.address && (
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {hotel.address}
        </div>
      )}
      {price && (
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {price}{" "}
          <span
            style={{
              fontSize: 11,
              fontWeight: 400,
              color: "var(--text-secondary)",
            }}
          >
            / night (from)
          </span>
        </div>
      )}
      {hotel.hotelId && (
        <div
          style={{
            fontSize: 10,
            color: "var(--text-secondary)",
            fontFamily: "monospace",
          }}
        >
          {hotel.hotelId}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Styles — match AdsGPTReports.jsx for visual consistency across cap-
 * consumer admin pages.
 * ──────────────────────────────────────────────────────────────────────── */
const inputStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color, rgba(255,255,255,0.05))",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
};
const selectStyle = {
  ...inputStyle,
  background: "var(--surface-color)",
  minWidth: 160,
};
const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "none",
  cursor: "pointer",
};
const filterField = { display: "flex", flexDirection: "column", gap: 4 };
const filterLabel = {
  fontSize: 11,
  color: "var(--text-secondary)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const subBrandBadge = {
  display: "inline-block",
  padding: "3px 10px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  background: "rgba(255,255,255,0.08)",
  color: "var(--text-primary)",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const summaryChip = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "3px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 500,
  background: "rgba(255,255,255,0.05)",
  color: "var(--text-primary)",
};
const starBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  background: "rgba(245, 158, 11, 0.18)",
  color: "#f59e0b",
  border: "1px solid rgba(245, 158, 11, 0.5)",
  whiteSpace: "nowrap",
};
