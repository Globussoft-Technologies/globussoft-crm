// Travel CRM — admin "Customer Reviews" page (2026-08-20).
//
// Lands at /travel/reviews. Lists submitted post-trip reviews for the tenant
// (sub-brand scoped server-side) from GET /api/travel/reviews. Supports
// client-side search, sub-brand + rating filters, sorting, pagination and
// shows the full review timestamp.

import {
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  MessageSquareText,
  RefreshCw,
  Search,
  Star,
  X,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { useActiveSubBrand } from "../../utils/subBrand";

const PRIMARY = "var(--primary-color, var(--accent-color, #122647))";

// Mirrors the fixed question set in backend/lib/travelReviewQuestions.js so the
// stored answer keys render with human labels.
const Q_LABELS = {
  rate_accommodation: "Accommodation & hotels",
  rate_transport: "Transportation & transfers",
  rate_activities: "Activities & sightseeing",
  rate_support: "Tour coordination & support",
  rate_value: "Value for money",
  recommend: "Would recommend?",
  rebook: "Book again?",
  loved_most: "Loved most",
  improve: "Could do better",
  highlight: "Memorable moment",
};
const RATING_IDS = ["rate_accommodation", "rate_transport", "rate_activities", "rate_support", "rate_value"];
const CHOICE_IDS = ["recommend", "rebook"];
const TEXT_IDS = ["loved_most", "improve", "highlight"];

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const RATING_OPTIONS = [
  { value: "", label: "All ratings" },
  { value: "5", label: "5 stars" },
  { value: "4", label: "4+ stars" },
  { value: "3", label: "3+ stars" },
  { value: "2", label: "2+ stars" },
  { value: "1", label: "1+ stars" },
];

const EXACT_RATING_OPTIONS = [
  { value: "", label: "Any exact rating" },
  { value: "5", label: "Exactly 5 stars" },
  { value: "4", label: "Exactly 4 stars" },
  { value: "3", label: "Exactly 3 stars" },
  { value: "2", label: "Exactly 2 stars" },
  { value: "1", label: "Exactly 1 star" },
];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "highest", label: "Highest rated" },
  { value: "lowest", label: "Lowest rated" },
];

const PAGE_SIZE_OPTIONS = [10, 20, 50];
const DEFAULT_PAGE_SIZE = 20;

function Stars({ value, size = 16 }) {
  const v = Number(value) || 0;
  return (
    <span style={{ display: "inline-flex", gap: 1, verticalAlign: "middle" }} aria-label={`${v} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={size}
          aria-hidden
          fill={n <= v ? "#F5B301" : "none"}
          color={n <= v ? "#F5B301" : "var(--text-secondary,#94a3b8)"}
        />
      ))}
    </span>
  );
}

const fmtDateTime = (d) => (d ? new Date(d).toLocaleString() : "—");
// Theme-safe surface — uses the travel theme's --surface-color / --text-* so it
// reads correctly in BOTH light and dark mode.
const card = {
  background: "var(--surface-color, #fff)",
  border: "1px solid var(--border-color, var(--border-light, #e2e8f0))",
  borderRadius: 12,
  padding: 18,
  marginBottom: 14,
  color: "var(--text-primary)",
  boxShadow: "var(--shadow-sm)",
};

function readIntParam(params, key, fallback) {
  const raw = params.get(key);
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export default function Reviews() {
  const notify = useNotify();
  const { activeSubBrand } = useActiveSubBrand();
  const [searchParams, setSearchParams] = useSearchParams();

  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pageSizeMenuOpen, setPageSizeMenuOpen] = useState(false);

  const search = searchParams.get("search") || "";
  const requestedSubBrand = searchParams.get("subBrand");
  const subBrand = requestedSubBrand === "all"
    ? ""
    : requestedSubBrand || activeSubBrand || "";
  const minRating = searchParams.get("minRating") || "";
  const rating = searchParams.get("rating") || "";
  const sort = searchParams.get("sort") || "newest";
  const page = Math.max(1, readIntParam(searchParams, "page", 1));
  const pageSize = Math.min(200, Math.max(1, readIntParam(searchParams, "pageSize", DEFAULT_PAGE_SIZE)));

  const updateParams = (patch) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(patch).forEach(([key, value]) => {
      if (value === "" || value === null || value === undefined) {
        next.delete(key);
      } else {
        next.set(key, String(value));
      }
    });
    setSearchParams(next, { replace: true });
  };

  const load = () => {
    setLoading(true);
    fetchApi("/api/travel/reviews")
      .then((res) => setReviews(Array.isArray(res?.reviews) ? res.reviews : []))
      .catch((e) => { notify.error(e?.body?.error || "Failed to load reviews"); setReviews([]); })
      .finally(() => setLoading(false));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    let out = reviews;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) =>
        (r.destination || "").toLowerCase().includes(q) ||
        (r.contactName || "").toLowerCase().includes(q) ||
        (r.contactEmail || "").toLowerCase().includes(q) ||
        (r.contactPhone || "").toLowerCase().includes(q)
      );
    }
    if (subBrand) {
      out = out.filter((r) => r.subBrand === subBrand);
    }
    if (minRating) {
      const min = Number(minRating);
      out = out.filter((r) => (r.overallRating || 0) >= min);
    }
    if (rating) {
      out = out.filter((r) => Number(r.overallRating) === Number(rating));
    }
    out = [...out].sort((a, b) => {
      if (sort === "newest") return new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0);
      if (sort === "oldest") return new Date(a.submittedAt || 0) - new Date(b.submittedAt || 0);
      if (sort === "highest") return (b.overallRating || 0) - (a.overallRating || 0);
      if (sort === "lowest") return (a.overallRating || 0) - (b.overallRating || 0);
      return 0;
    });
    return out;
  }, [reviews, search, subBrand, minRating, rating, sort]);

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pageReviews = filtered.slice(start, start + pageSize);

  useEffect(() => {
    if (page > pageCount && pageCount > 0) {
      const next = new URLSearchParams(searchParams);
      next.set("page", String(pageCount));
      setSearchParams(next, { replace: true });
    }
  }, [page, pageCount, searchParams, setSearchParams]);

  const rated = reviews.filter((r) => typeof r.overallRating === "number");
  const avg = rated.length ? (rated.reduce((s, r) => s + r.overallRating, 0) / rated.length) : 0;

  const hasFilters = search || subBrand || minRating || rating || sort !== "newest";

  const setPage = (nextPage) => updateParams({ page: nextPage });
  const setPageSizeAndReset = (next) => updateParams({ pageSize: next, page: 1 });

  const clearFilters = () => {
    updateParams({ search: "", subBrand: activeSubBrand || "", minRating: "", rating: "", sort: "", page: "", pageSize: "" });
  };

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 8 }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
          <MessageSquareText size={26} aria-hidden /> Customer Reviews
        </h1>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid var(--border-light,#d1d5db)",
            background: "transparent",
            cursor: loading ? "not-allowed" : "pointer",
            fontWeight: 600,
            opacity: loading ? 0.6 : 1,
          }}
        >
          <RefreshCw size={15} aria-hidden /> Refresh
        </button>
      </div>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        Post-trip feedback from your customers.{" "}
        {rated.length > 0 && (
          <strong>
            {reviews.length} review{reviews.length !== 1 ? "s" : ""} · average <Stars value={Math.round(avg)} /> {avg.toFixed(1)}/5
          </strong>
        )}
      </p>

      {/* Filters */}
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
        <Filter size={16} aria-hidden style={{ color: "var(--text-secondary)" }} />

        <div style={{ position: "relative", minWidth: 200, flex: "1 1 220px" }}>
          <Search
            size={14}
            aria-hidden
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-secondary)",
              pointerEvents: "none",
            }}
          />
          <input
            type="text"
            value={search}
            onChange={(e) => updateParams({ search: e.target.value, page: 1 })}
            placeholder="Search destination, name, email, phone…"
            aria-label="Search reviews"
            style={{
              width: "100%",
              padding: "7px 10px 7px 34px",
              borderRadius: 6,
              border: "1px solid var(--border-color)",
              background: "var(--bg-color)",
              color: "var(--text-primary)",
              fontSize: 13,
              boxSizing: "border-box",
            }}
          />
        </div>

        <select
          value={subBrand}
          onChange={(e) => updateParams({ subBrand: e.target.value || "all", page: 1 })}
          aria-label="Filter by sub-brand"
          style={selectStyle}
        >
          {SUB_BRANDS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <select
          value={minRating}
          onChange={(e) => updateParams({ minRating: e.target.value, page: 1 })}
          aria-label="Filter by minimum rating"
          style={selectStyle}
        >
          {RATING_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>

        <select
          value={rating}
          onChange={(e) => updateParams({ rating: e.target.value, page: 1 })}
          aria-label="Filter reviews by star rating"
          style={selectStyle}
        >
          {EXACT_RATING_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(e) => updateParams({ sort: e.target.value })}
          aria-label="Sort reviews"
          style={selectStyle}
        >
          {SORT_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "7px 12px",
              borderRadius: 6,
              border: "1px solid var(--border-color)",
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: 13,
            }}
            aria-label="Clear filters"
          >
            <X size={13} aria-hidden /> Clear
          </button>
        )}
      </div>

      {loading && <p style={{ color: "var(--text-secondary)" }}>Loading…</p>}
      {!loading && pageReviews.length === 0 && (
        <div style={{ ...card, textAlign: "center", color: "var(--text-secondary)" }}>
          {hasFilters
            ? "No reviews match your filters."
            : "No reviews yet. Customers are asked for a review after their trip ends."}
        </div>
      )}

      {!loading && pageReviews.map((r) => {
        const a = r.answers || {};
        return (
          <div key={r.id} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.destination || "Trip"}
                </div>
                {/* WHO left the review — name + contact, so the advisor can follow up. */}
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginTop: 3 }}>
                  {r.contactName || `Contact #${r.contactId}`}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2, display: "flex", flexWrap: "wrap", gap: "0 12px" }}>
                  {r.subBrand && (
                    <span style={{ textTransform: "uppercase", letterSpacing: 0.5 }}>
                      {r.subBrand}
                    </span>
                  )}
                  {r.contactEmail && <span>{r.contactEmail}</span>}
                  {r.contactPhone && <span>{r.contactPhone}</span>}
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <Clock size={12} aria-hidden /> {fmtDateTime(r.submittedAt)}
                  </span>
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <Stars value={r.overallRating} size={20} />
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.overallRating}/5 overall</div>
              </div>
            </div>

            {/* Ratings */}
            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: "6px 18px" }}>
              {RATING_IDS.filter((id) => a[id] != null).map((id) => (
                <div key={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                  <span style={{ color: "var(--text-secondary)" }}>{Q_LABELS[id]}</span>
                  <Stars value={a[id]} size={14} />
                </div>
              ))}
            </div>

            {/* Loyalty choices */}
            {CHOICE_IDS.some((id) => a[id]) && (
              <div style={{ marginTop: 10, display: "flex", gap: 18, flexWrap: "wrap" }}>
                {CHOICE_IDS.filter((id) => a[id]).map((id) => (
                  <span key={id} style={{ fontSize: 13 }}>
                    <span style={{ color: "var(--text-secondary)" }}>{Q_LABELS[id]} </span>
                    <strong style={{ color: PRIMARY }}>{a[id]}</strong>
                  </span>
                ))}
              </div>
            )}

            {/* Free text */}
            {TEXT_IDS.filter((id) => a[id]).map((id) => (
              <div key={id} style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{Q_LABELS[id]}</div>
                <div style={{ fontSize: 14, fontStyle: "italic", color: "var(--text-primary)", borderLeft: `3px solid ${PRIMARY}`, paddingLeft: 10, marginTop: 2 }}>“{a[id]}”</div>
              </div>
            ))}
          </div>
        );
      })}

      {/* Pagination */}
      {!loading && total > 0 && (
        <ReviewsPager
          total={total}
          page={safePage}
          pageSize={pageSize}
          pageSizeMenuOpen={pageSizeMenuOpen}
          setPageSizeMenuOpen={setPageSizeMenuOpen}
          onPageChange={setPage}
          onPageSizeChange={setPageSizeAndReset}
        />
      )}
    </div>
  );
}

function ReviewsPager({
  total,
  page,
  pageSize,
  pageSizeMenuOpen,
  setPageSizeMenuOpen,
  onPageChange,
  onPageSizeChange,
}) {
  const pageCount = Math.max(1, Math.ceil((total || 0) / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize + 1;
  const end = Math.min(start + pageSize - 1, total);

  const pages = useMemo(() => {
    const out = new Set([1, pageCount, safePage]);
    for (let i = Math.max(2, safePage - 2); i <= Math.min(pageCount - 1, safePage + 2); i += 1) {
      out.add(i);
    }
    const sorted = Array.from(out).sort((a, b) => a - b);
    const withGaps = [];
    sorted.forEach((p, i) => {
      if (i > 0 && p - sorted[i - 1] > 1) withGaps.push("...");
      withGaps.push(p);
    });
    return withGaps;
  }, [pageCount, safePage]);

  const pillBtn = (active, disabled) => ({
    minWidth: 32,
    height: 32,
    padding: "0 0.5rem",
    background: active ? PRIMARY : "transparent",
    color: active ? "#fff" : "var(--text-primary)",
    border: "1px solid var(--border-color, rgba(255,255,255,0.18))",
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "0.85rem",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    opacity: disabled ? 0.4 : 1,
  });

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "0.75rem",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0.85rem 0",
        fontSize: "0.85rem",
      }}
    >
      <div style={{ color: "var(--text-secondary)" }}>
        Showing{" "}
        <strong style={{ color: "var(--text-primary)" }}>{start}–{end}</strong>{" "}
        of{" "}
        <strong style={{ color: "var(--text-primary)" }}>{total}</strong>{" "}
        review{total !== 1 ? "s" : ""}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
        <PageSizeMenu
          pageSize={pageSize}
          open={pageSizeMenuOpen}
          setOpen={setPageSizeMenuOpen}
          onChange={onPageSizeChange}
        />
        <button
          type="button"
          onClick={() => onPageChange(safePage - 1)}
          disabled={safePage <= 1}
          aria-label="Previous page"
          style={pillBtn(false, safePage <= 1)}
        >
          <ChevronLeft size={14} />
        </button>
        {pages.map((p, i) =>
          p === "..." ? (
            <span key={`gap-${i}`} style={{ color: "var(--text-secondary)", padding: "0 0.2rem" }}>…</span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              aria-current={p === safePage ? "page" : undefined}
              style={pillBtn(p === safePage, false)}
            >
              {p}
            </button>
          )
        )}
        <button
          type="button"
          onClick={() => onPageChange(safePage + 1)}
          disabled={safePage >= pageCount}
          aria-label="Next page"
          style={pillBtn(false, safePage >= pageCount)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

function PageSizeMenu({ pageSize, open, setOpen, onChange }) {
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.4rem",
          padding: "0.3rem 0.55rem",
          borderRadius: 6,
          border: "1px solid var(--border-color, rgba(255,255,255,0.18))",
          background: "var(--surface-color, rgba(255,255,255,0.04))",
          color: "var(--text-primary)",
          fontSize: "0.85rem",
          cursor: "pointer",
          minWidth: 70,
        }}
      >
        <span>{pageSize}</span>
        <ChevronDown size={12} style={{ opacity: 0.7 }} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: 0,
            minWidth: 90,
            background: "var(--surface-color, rgba(255,255,255,0.04))",
            border: "1px solid var(--border-color, rgba(255,255,255,0.18))",
            borderRadius: 8,
            boxShadow: "0 10px 28px rgba(0, 0, 0, 0.18)",
            padding: 4,
            zIndex: 30,
          }}
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              role="menuitem"
              onClick={() => { onChange(n); setOpen(false); }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "0.45rem 0.7rem",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
                background: pageSize === n ? PRIMARY : "transparent",
                color: pageSize === n ? "#fff" : "var(--text-primary, inherit)",
              }}
            >
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const selectStyle = {
  padding: "7px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)",
  color: "var(--text-primary)",
  minWidth: 150,
  fontSize: 13,
  cursor: "pointer",
};
