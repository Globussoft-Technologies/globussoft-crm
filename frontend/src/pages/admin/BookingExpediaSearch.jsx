/**
 * BookingExpediaSearch.jsx — operator-facing Booking.com / Expedia hotel search.
 *
 * Consumes /api/booking-expedia (backend route commit bb33cbe, tick #105 —
 * thin wrapper over backend/services/bookingExpediaClient.js). Endpoints:
 *   POST /api/booking-expedia/search
 *     Body: { provider = 'booking', subBrand?, destinationCity (required),
 *             checkInDate (required), checkOutDate (required),
 *             guests = 2, rooms = 1 }
 *     → 200 { stub, ..., hotels:[], note }                  (Phase 1)
 *     → 503 { error, code: "EXPEDIA_NOT_YET_ENABLED" }       (provider='expedia')
 *     → 402 { error, code: "BOOKING_EXPEDIA_BUDGET_EXCEEDED", spentCents, capCents }
 *     → 400 { error, code: "MISSING_DESTINATION" | "MISSING_CHECKIN" | "MISSING_CHECKOUT" }
 *   POST /api/booking-expedia/book                  (Phase 2 — 503 today)
 *   POST /api/booking-expedia/cancel/:bookingId     (Phase 2 — 503 today)
 *   GET  /api/booking-expedia/cap-status            (ADMIN-only)
 *     → 200 { spentCents, capCents, percent, withinCap, alertThreshold }
 *     → 402 { error, code: "BOOKING_EXPEDIA_BUDGET_EXCEEDED", spentCents, capCents }
 *
 * Phase 2 deferred-by-design: DC-1 RESOLVED 2026-05-24 — Booking.com first,
 * Expedia is Phase 2 demand-driven. The backend client throws
 * EXPEDIA_NOT_YET_ENABLED (503) for every provider='expedia' code path until
 * DC-4 flips the demand threshold. Per the tick #106 spec, the UI mounts in
 * a Phase-2-pending state by default — pointing the operator at the existing
 * cap helper + brand-kit readiness so when creds + Q11 land the page
 * activates without further changes. An optional /enabled probe lets a
 * future backend signal "live, render the search form" without a frontend
 * deploy.
 *
 * The search form is preserved BELOW the Phase-2-pending content (rendered
 * lazily via a "Show search form anyway" toggle) so QA can exercise the
 * 503 path against the real backend, and so the structural shape mirrors
 * RateHawkSearch.jsx for visual consistency. When Expedia goes live, the
 * Phase-2-pending block disappears and the form becomes the primary render.
 *
 * STUB-mode caveat: Booking.com (Phase 1) is itself stub-mode today —
 * backend/services/bookingExpediaClient.js searchHotels returns
 * { stub: true, hotels: [] } until the Q-cluster B6/C cred swap lands.
 * Same pattern as the other 3 cap-consumer UIs.
 *
 * Pattern mirror: cap-status pill + stub-mode banner + cap-exceeded banner
 * + filter row → fetch → render envelope all clone CallifiedCalls.jsx
 * (commit 7c7b88b) + RateHawkSearch.jsx (commit f4268c1) + AdsGPTReports.jsx
 * (commit 850391d). This is the 4th and FINAL cap-consumer UI completing
 * the wrapper-route series. Rule-of-3 extraction (cap-pill / stub-banner /
 * cap-exceeded-banner objects) is NOW primed — 4 byte-identical caller copies
 * exist; a follow-up tick can promote them to a shared
 * frontend/src/components/CapBanners.jsx in one shot.
 *
 * Access: ADMIN + MANAGER. /cap-status is ADMIN-only on the backend;
 * MANAGER users get a 403 there which is swallowed silently (no pill).
 */

import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  BedDouble,
  AlertCircle,
  Search,
  MapPin,
  Calendar,
  Users as UsersIcon,
  Clock,
  Palette,
  Settings,
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

// Provider options. Booking is Phase 1 (live behind a cred-blocked stub);
// Expedia is Phase 2 deferred-by-design and will 503 on the backend until
// DC-4 flips. The select stays visible so the contract is discoverable.
const PROVIDER_OPTIONS = [
  { value: "booking", label: "Booking.com (Phase 1)" },
  { value: "expedia", label: "Expedia (Phase 2 — pending)" },
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

export default function BookingExpediaSearch() {
  const notify = useNotify();

  // Phase-2 readiness probe (GET /enabled). Backend doesn't ship the
  // endpoint today — a 404 / network error means "stay in Phase-2-pending
  // mode." When backend lands the probe and returns { enabled: true,
  // phase: 1 }, the Phase-2-pending banner collapses and the search form
  // becomes the primary render automatically.
  const [enabled, setEnabled] = useState(null); // null = loading, true/false = resolved
  const [enabledLoading, setEnabledLoading] = useState(true);
  const [enabledPhase, setEnabledPhase] = useState(2); // 2 = pending, 1 = live

  // Cap-status (loaded on mount; ADMIN-only on backend so MANAGER gets 403
  // and we render no pill at all rather than an error toast).
  const [capStatus, setCapStatus] = useState(null);
  const [capStatusLoading, setCapStatusLoading] = useState(true);

  // Filter state.
  const [provider, setProvider] = useState("booking");
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

  // Operator toggle to expose the search form even when in Phase-2-pending
  // mode — lets QA exercise the 503 EXPEDIA_NOT_YET_ENABLED path + the
  // Booking stub path against the live backend without a code change.
  const [showFormAnyway, setShowFormAnyway] = useState(false);

  // Load enabled + cap-status on mount. Both calls are tolerant: missing
  // /enabled endpoint → stay Phase-2-pending; 403 on /cap-status → silent.
  useEffect(() => {
    let cancelled = false;
    setEnabledLoading(true);
    setCapStatusLoading(true);

    fetchApi("/api/booking-expedia/enabled")
      .then((res) => {
        if (cancelled) return;
        setEnabled(Boolean(res?.enabled));
        if (res?.phase != null) setEnabledPhase(Number(res.phase) || 2);
      })
      .catch((err) => {
        if (cancelled) return;
        // 404 (endpoint not yet shipped) or any other error → stay in
        // Phase-2-pending mode. Body may indicate phase: 2 + reason —
        // surface phase if present.
        if (err?.body?.phase != null) {
          setEnabledPhase(Number(err.body.phase) || 2);
        }
        setEnabled(false);
      })
      .finally(() => {
        if (!cancelled) setEnabledLoading(false);
      });

    fetchApi("/api/booking-expedia/cap-status")
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
            "[BookingExpediaSearch] cap-status load failed:",
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
        provider,
        destinationCity: destinationCity.trim(),
        checkInDate,
        checkOutDate,
        guests: Number(guests) || 2,
        rooms: Number(rooms) || 1,
      };
      if (subBrand) body.subBrand = subBrand;
      const res = await fetchApi("/api/booking-expedia/search", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setSearchResult(res);
    } catch (err) {
      if (
        err?.status === 402 &&
        err?.body?.code === "BOOKING_EXPEDIA_BUDGET_EXCEEDED"
      ) {
        setCapExceeded({
          spentCents: err.body.spentCents,
          capCents: err.body.capCents,
        });
        setSearchResult(null);
        return;
      }
      if (
        err?.status === 503 &&
        err?.body?.code === "EXPEDIA_NOT_YET_ENABLED"
      ) {
        notify.info(
          "Expedia is Phase 2 — pending DC-4 demand threshold + Q11 vendor handover.",
        );
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
  const inPhase2Pending = !enabledLoading && enabled === false;

  return (
    <div
      style={{
        padding: "2rem",
        height: "100%",
        overflowY: "auto",
        animation: "fadeIn 0.4s ease-out",
      }}
    >
      {/* Header row — rendered on BOTH the Phase-2-pending and the live
          paths so the cap pill is always visible (cap helper is wired
          today even though Expedia code paths 503). */}
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
            <BedDouble
              size={26}
              color="var(--primary-color, var(--accent-color))"
              aria-hidden
            />{" "}
            Booking.com / Expedia
          </h1>
          <p
            style={{
              color: "var(--text-secondary)",
              marginTop: 4,
              fontSize: "0.9rem",
              maxWidth: 720,
            }}
          >
            Direct-API hotel search across Booking.com (Phase 1) and Expedia
            (Phase 2 — pending). Cap helper is shared across both providers.
          </p>
        </div>
        {/* Cap-status pill (ADMIN-only; silent for MANAGER) */}
        {capStatusLoading ? null : (
          <CapStatusPill cap={capStatus} testid="booking-expedia-cap-pill" />
        )}
      </header>

      {/* Phase-2-pending state — full-page banner pointing operators at the
          pre-configuration surfaces (tenant cap + brand kit asset readiness)
          so when DC-4 flips + Q11 lands the page activates without churn. */}
      {inPhase2Pending && !showFormAnyway && (
        <div
          className="card"
          style={{
            padding: "2.5rem 2rem",
            textAlign: "center",
            color: "var(--text-secondary)",
            maxWidth: 720,
            margin: "1rem auto 2rem",
          }}
          data-testid="booking-expedia-phase2-pending-state"
        >
          <Clock
            size={32}
            style={{
              opacity: 0.7,
              marginBottom: 12,
              color: "var(--primary-color, var(--accent-color))",
            }}
            aria-hidden
          />
          <div
            style={{
              fontWeight: 600,
              fontSize: "1.1rem",
              marginBottom: 8,
              color: "var(--text-primary)",
            }}
          >
            Booking.com / Expedia integration — Phase {enabledPhase}
          </div>
          <div
            style={{
              fontSize: "0.92rem",
              marginBottom: 18,
              lineHeight: 1.55,
              maxWidth: 560,
              margin: "0 auto 18px",
            }}
          >
            API access pending vendor handover (Q11 — Booking.com / Expedia
            partner onboarding per <code>docs/CREDS_TRACKER.md</code> Cat 1).
            The cap helper is already wired so when creds land, this page
            activates without further changes. The shared per-tenant budget
            cap protects against runaway spend across both providers.
          </div>
          <div
            style={{
              display: "flex",
              gap: 10,
              justifyContent: "center",
              flexWrap: "wrap",
              marginBottom: 16,
            }}
          >
            <RouterLink
              to="/admin/tenant-settings"
              style={ctaLink}
              data-testid="booking-expedia-tenant-settings-link"
            >
              <Settings size={13} aria-hidden /> Pre-configure cap
            </RouterLink>
            <RouterLink
              to="/admin/brand-kits"
              style={ctaLink}
              data-testid="booking-expedia-brand-kits-link"
            >
              <Palette size={13} aria-hidden /> Brand kit readiness
            </RouterLink>
          </div>
          <button
            type="button"
            onClick={() => setShowFormAnyway(true)}
            style={ghostBtn}
            data-testid="booking-expedia-show-form-btn"
          >
            Show search form anyway (will return 503 for Expedia)
          </button>
        </div>
      )}

      {/* Search form — rendered on the live path AND when the operator has
          opted in via "Show form anyway." When backend ships the /enabled
          endpoint and returns { enabled: true }, this becomes the primary
          render automatically. */}
      {(!inPhase2Pending || showFormAnyway) && (
        <>
          {/* Cap-exceeded banner — fires when search returns 402 */}
          <CapExceededBanner
            cap={capExceeded}
            providerLabel="Booking/Expedia"
            testid="booking-expedia-cap-exceeded-banner"
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
            <div style={filterField}>
              <label htmlFor="booking-expedia-provider" style={filterLabel}>
                Provider
              </label>
              <select
                id="booking-expedia-provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                style={selectStyle}
                data-testid="booking-expedia-filter-provider"
              >
                {PROVIDER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ ...filterField, flex: "1 1 220px", minWidth: 200 }}>
              <label
                htmlFor="booking-expedia-destination"
                style={filterLabel}
              >
                Destination city{" "}
                <span style={{ color: "#f43f5e" }}>*</span>
              </label>
              <input
                id="booking-expedia-destination"
                type="text"
                value={destinationCity}
                onChange={(e) => setDestinationCity(e.target.value)}
                placeholder="e.g. Mecca, Paris, Bangkok"
                style={inputStyle}
                data-testid="booking-expedia-filter-destination"
              />
            </div>
            <div style={filterField}>
              <label htmlFor="booking-expedia-checkin" style={filterLabel}>
                Check-in <span style={{ color: "#f43f5e" }}>*</span>
              </label>
              <input
                id="booking-expedia-checkin"
                type="date"
                value={checkInDate}
                onChange={(e) => setCheckInDate(e.target.value)}
                style={inputStyle}
                data-testid="booking-expedia-filter-checkin"
              />
            </div>
            <div style={filterField}>
              <label htmlFor="booking-expedia-checkout" style={filterLabel}>
                Check-out <span style={{ color: "#f43f5e" }}>*</span>
              </label>
              <input
                id="booking-expedia-checkout"
                type="date"
                value={checkOutDate}
                onChange={(e) => setCheckOutDate(e.target.value)}
                style={inputStyle}
                data-testid="booking-expedia-filter-checkout"
              />
            </div>
            <div style={filterField}>
              <label htmlFor="booking-expedia-guests" style={filterLabel}>
                Guests
              </label>
              <input
                id="booking-expedia-guests"
                type="number"
                min={1}
                max={20}
                value={guests}
                onChange={(e) => setGuests(e.target.value)}
                style={{ ...inputStyle, width: 80 }}
                data-testid="booking-expedia-filter-guests"
              />
            </div>
            <div style={filterField}>
              <label htmlFor="booking-expedia-rooms" style={filterLabel}>
                Rooms
              </label>
              <input
                id="booking-expedia-rooms"
                type="number"
                min={1}
                max={10}
                value={rooms}
                onChange={(e) => setRooms(e.target.value)}
                style={{ ...inputStyle, width: 80 }}
                data-testid="booking-expedia-filter-rooms"
              />
            </div>
            <div style={filterField}>
              <label htmlFor="booking-expedia-subbrand" style={filterLabel}>
                Sub-brand
              </label>
              <select
                id="booking-expedia-subbrand"
                value={subBrand}
                onChange={(e) => setSubBrand(e.target.value)}
                style={selectStyle}
                data-testid="booking-expedia-filter-subbrand"
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
              data-testid="booking-expedia-search-btn"
            >
              <Search size={14} aria-hidden />
              {searchLoading ? "Searching…" : "Search hotels"}
            </button>
          </div>

          {/* Stub-mode banner — surfaces when backend client is still pre-cred */}
          {searchResult?.stub && (
            <StubModeBanner testid="booking-expedia-stub-banner">
              <strong>Stub-mode response</strong> (Q-cluster B6/C cred pending)
              — Booking.com partner onboarding is the Phase 1 unblock; real
              hotel inventory will populate once the swap is done. The
              dashboard layout and contract won&apos;t change.
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
              Searching Booking.com / Expedia inventory&hellip;
            </div>
          ) : capExceeded ? null : !searchResult ? (
            <div
              className="card"
              style={{
                padding: "3rem 2rem",
                textAlign: "center",
                color: "var(--text-secondary)",
              }}
              data-testid="booking-expedia-empty-state"
            >
              <AlertCircle
                size={28}
                style={{ opacity: 0.5, marginBottom: 10 }}
                aria-hidden
              />
              <div style={{ fontWeight: 600 }}>No search performed yet.</div>
              <div style={{ fontSize: "0.9rem", marginTop: "0.5rem" }}>
                Enter a destination + dates + click &quot;Search hotels&quot;
                to query Booking.com inventory. Expedia (Phase 2) returns 503
                until DC-4 flips the demand threshold.
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
                data-testid="booking-expedia-search-summary"
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={providerBadge}>
                    {searchResult.provider || provider}
                  </span>
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
                  data-testid="booking-expedia-no-hotels"
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
                  data-testid="booking-expedia-hotel-list"
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
        </>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Hotel card — minimal renderer for a single hotel from the search results.
 * Forward-looking — copes with whatever subset of fields the real client
 * returns once the cred swap lands. Mirrors RateHawkSearch HotelCard.
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
      data-testid="booking-expedia-hotel-card"
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
 * Styles — match RateHawkSearch.jsx / CallifiedCalls.jsx / AdsGPTReports.jsx
 * verbatim for visual consistency across cap-consumer admin pages. The
 * cap-pill / stub-banner / cap-exceeded-banner shapes are inlined byte-
 * identical here — this is the 4th caller, so a follow-up tick can now
 * extract them to a shared frontend/src/components/CapBanners.jsx and
 * retrofit all 4 callers in one shot.
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
const ghostBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  fontWeight: 500,
  fontSize: 12,
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px dashed var(--border-color)",
  cursor: "pointer",
};
const ctaLink = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  textDecoration: "none",
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
const providerBadge = {
  display: "inline-block",
  padding: "3px 10px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  background: "rgba(99, 102, 241, 0.18)",
  color: "var(--text-primary)",
  border: "1px solid rgba(99, 102, 241, 0.45)",
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
