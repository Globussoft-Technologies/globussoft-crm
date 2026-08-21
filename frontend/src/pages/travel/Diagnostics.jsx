import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Compass,
  Filter,
  Plus,
  Trash2,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import CalendarRangePicker from "../../components/CalendarRangePicker";
import CountBadge from "../../components/CountBadge";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [10, 20, 50];
const MAX_PAGE_SIZE = 200;

function fmt(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function readPageParam(params) {
  return Math.max(1, parseInt(params.get("page") || "1", 10) || 1);
}

export default function Diagnostics() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";
  const [searchParams, setSearchParams] = useSearchParams();

  const page = readPageParam(searchParams);
  const [diagnostics, setDiagnostics] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [subBrand, setSubBrand] = useState(searchParams.get("subBrand") || "");
  const [classification, setClassification] = useState(
    searchParams.get("classification") || "",
  );
  const [fromDate, setFromDate] = useState(searchParams.get("fromDate") || "");
  const [toDate, setToDate] = useState(searchParams.get("toDate") || "");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [isCustomPageSize, setIsCustomPageSize] = useState(false);
  const [customPageSize, setCustomPageSize] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const reqIdRef = useRef(0);

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

  const pageCount = Math.max(1, Math.ceil((total || 0) / pageSize));
  const safePage = Math.min(page, pageCount);

  const load = useCallback(
    async ({ reset = false } = {}) => {
      const myReqId = ++reqIdRef.current;
      if (reset) {
        setLoading(true);
        setDiagnostics([]);
      }

      const qs = new URLSearchParams();
      if (subBrand) qs.set("subBrand", subBrand);
      if (classification) qs.set("classification", classification);
      if (fromDate) qs.set("fromDate", fromDate);
      if (toDate) qs.set("toDate", toDate);
      qs.set("limit", String(pageSize));
      qs.set("offset", String(Math.max(0, (page - 1) * pageSize)));

      try {
        const res = await fetchApi(`/api/travel/diagnostics?${qs.toString()}`);
        if (myReqId !== reqIdRef.current) return;
        const rows = Array.isArray(res?.diagnostics) ? res.diagnostics : [];
        setDiagnostics(rows);
        setSelectedIds(new Set());
        setTotal(Number(res?.total) || 0);
      } catch (e) {
        if (myReqId !== reqIdRef.current) return;
        notify.error(e?.body?.error || "Failed to load diagnostics");
        setDiagnostics([]);
        setSelectedIds(new Set());
        setTotal(0);
      } finally {
        if (myReqId === reqIdRef.current) {
          setLoading(false);
        }
      }
    },
    [classification, fromDate, notify, page, pageSize, subBrand, toDate],
  );

  useEffect(() => {
    load({ reset: true });
  }, [load, reloadTick]);

  useEffect(() => {
    if (total > 0 && page > pageCount) {
      updateParams({ page: pageCount }, { replace: true });
    }
  }, [page, pageCount, total, updateParams]);

  const reload = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

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

  const activeDiagnostics = useMemo(() => diagnostics, [diagnostics]);
  const selectedCount = selectedIds.size;
  const allVisibleSelected =
    activeDiagnostics.length > 0 &&
    activeDiagnostics.every((d) => selectedIds.has(d.id));

  const toggleSelected = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (activeDiagnostics.every((d) => next.has(d.id))) {
        activeDiagnostics.forEach((d) => next.delete(d.id));
      } else {
        activeDiagnostics.forEach((d) => next.add(d.id));
      }
      return next;
    });
  }, [activeDiagnostics]);

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    const ok = await notify.confirm({
      message: `Delete ${ids.length} selected diagnostic${ids.length === 1 ? "" : "s"}? This cannot be undone.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      setBulkDeleting(true);
      const res = await fetchApi("/api/travel/diagnostics/bulk", {
        method: "DELETE",
        body: JSON.stringify({ ids }),
      });
      notify.success(
        `Deleted ${Number(res?.deletedCount) || ids.length} diagnostic${ids.length === 1 ? "" : "s"}.`,
      );
      setSelectedIds(new Set());
      reload();
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to bulk delete diagnostics");
    } finally {
      setBulkDeleting(false);
    }
  }, [notify, reload, selectedIds]);

  return (
    <div
      style={{
        padding: 24,
        width: "100%",
        maxWidth: 1480,
        margin: "0 auto",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          marginBottom: 4,
        }}
      >
        <h1
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            margin: 0,
            fontSize: "1.75rem",
            fontWeight: 600,
            lineHeight: 1.15,
            flexWrap: "wrap",
          }}
        >
          <ClipboardCheck size={28} aria-hidden /> Diagnostics
          <CountBadge count={total} title={`${total.toLocaleString()} diagnostics`} />
        </h1>
        <div style={{ display: "flex", gap: 8 }}>
          {isAdmin && (
            <Link
              to="/travel/diagnostics/banks/new"
              style={ctaSecondary}
              aria-label="Create new diagnostic bank (admin)"
            >
              <Plus size={16} aria-hidden /> New bank
            </Link>
          )}
          <Link
            to="/travel/diagnostics/new"
            style={ctaPrimary}
            aria-label="Add new diagnostic entry"
          >
            <Compass size={16} aria-hidden /> Add diagnostic entry
          </Link>
        </div>
      </div>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        Weighted-scoring assessments classify leads into tiers before any quote
        is shown.
      </p>

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
          overflow: "visible",
          position: "relative",
          zIndex: 5,
        }}
      >
        <Filter
          size={16}
          aria-hidden
          style={{ color: "var(--text-secondary)" }}
        />
        <select
          value={subBrand}
          onChange={(e) => {
            setSubBrand(e.target.value);
            updateParams({ subBrand: e.target.value, page: 1 });
          }}
          style={selectStyle}
          aria-label="Filter by sub-brand"
        >
          {SUB_BRANDS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={classification}
          onChange={(e) => {
            setClassification(e.target.value);
            updateParams({ classification: e.target.value, page: 1 });
          }}
          style={selectStyle}
          aria-label="Filter by classification"
        >
          <option value="">All classifications</option>
          <option value="level_1">Level 1</option>
          <option value="level_2">Level 2</option>
          <option value="level_3">Level 3</option>
          <option value="level_4">Level 4</option>
        </select>
        <CalendarRangePicker
          value={{ from: fromDate, to: toDate }}
          onChange={(next) => {
            const nextFrom = next?.from || "";
            const nextTo = next?.to || "";
            setFromDate(nextFrom);
            setToDate(nextTo);
            updateParams({ fromDate: nextFrom, toDate: nextTo, page: 1 });
          }}
          label="All time"
        />
        <button
          type="button"
          onClick={reload}
          style={refreshBtn}
          aria-label="Reload list"
        >
          Refresh
        </button>
        {isAdmin && (
          <button
            type="button"
            onClick={handleBulkDelete}
            disabled={!selectedCount || bulkDeleting}
            style={{
              ...bulkDeleteBtn,
              opacity: !selectedCount || bulkDeleting ? 0.55 : 1,
              cursor: !selectedCount || bulkDeleting ? "not-allowed" : "pointer",
            }}
            aria-label="Delete selected diagnostics"
          >
            <Trash2 size={14} aria-hidden />
            {bulkDeleting ? "Deleting..." : `Delete selected${selectedCount ? ` (${selectedCount})` : ""}`}
          </button>
        )}
      </div>

      <div
        style={{
          background: "var(--surface-color)",
          borderRadius: 8,
          border: "1px solid var(--border-color)",
        }}
      >
        {loading && activeDiagnostics.length === 0 ? (
          <div style={empty}>Loading&hellip;</div>
        ) : activeDiagnostics.length === 0 ? (
          <div style={empty}>
            {isAdmin ? (
              "No diagnostics submitted yet."
            ) : (
              <>
                No diagnostics submitted yet. Click{" "}
                <strong>Add diagnostic entry</strong> to start.
              </>
            )}
          </div>
        ) : (
          <table
                aria-label="Diagnostics results"
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  tableLayout: "fixed",
                }}
              >
                <colgroup>
                  {isAdmin && <col style={{ width: "44px" }} />}
                  <col style={{ width: "150px" }} />
                  <col style={{ width: "120px" }} />
                  <col style={{ width: "190px" }} />
                  <col style={{ width: "90px" }} />
                  <col style={{ width: "120px" }} />
                  <col style={{ width: "90px" }} />
                </colgroup>
                <thead>
                  <tr>
                    {isAdmin && (
                      <th style={thCheckbox}>
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleSelectAllVisible}
                          aria-label="Select all visible diagnostics"
                        />
                      </th>
                    )}
                    <th style={th}>Submitted</th>
                    <th style={th}>Sub-brand</th>
                    <th style={th}>Contact</th>
                    <th style={th}>Score</th>
                    <th style={th}>Classification</th>
                    <th style={th}>Tier</th>
                  </tr>
                </thead>
                <tbody>
                  {activeDiagnostics.map((d) => {
                    const tier = (d.recommendedTier || "").toLowerCase();
                    const tierClass = ["entry", "primary", "premium"].includes(
                      tier,
                    )
                      ? `tier-badge tier-badge--${tier}`
                      : "tier-badge";
                    return (
                      <tr
                        key={d.id}
                        style={{ borderTop: "1px solid var(--border-light)" }}
                      >
                        {isAdmin && (
                          <td style={tdCheckbox}>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(d.id)}
                              onChange={() => toggleSelected(d.id)}
                              aria-label={`Select diagnostic #${d.id}`}
                            />
                          </td>
                        )}
                        <td style={td}>
                          <Link
                            to={`/travel/diagnostics/${d.id}`}
                            style={rowLink}
                            aria-label={`Open diagnostic #${d.id}`}
                          >
                            {fmt(d.createdAt)}
                          </Link>
                        </td>
                        <td style={td}>
                          <span style={brandBadge}>{d.subBrand}</span>
                        </td>
                        <td style={td}>
                          {d.contact?.name || d.contact?.email ? (
                            <span>
                              {d.contact.name || d.contact.email}
                              {d.contact.name && d.contact.email && (
                                <span
                                  style={{
                                    display: "block",
                                    fontSize: 11,
                                    color: "var(--text-secondary)",
                                  }}
                                >
                                  {d.contact.email}
                                </span>
                              )}
                            </span>
                          ) : d.contactId ? (
                            `#${d.contactId}`
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={td}>
                          {d.score !== null ? Number(d.score).toFixed(2) : "—"}
                        </td>
                        <td style={td}>
                          {d.classificationLabel || d.classification || "—"}
                        </td>
                        <td style={td}>
                          <span className={tierClass}>
                            {d.recommendedTier || "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
        )}
        {total > 0 && (
          <DiagnosticsPager
            total={total}
            page={safePage}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSizeAndReset}
            isCustomPageSize={isCustomPageSize}
            setIsCustomPageSize={setIsCustomPageSize}
            customPageSize={customPageSize}
            setCustomPageSize={setCustomPageSize}
          />
        )}
      </div>
    </div>
  );
}

function DiagnosticsPager({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  isCustomPageSize,
  setIsCustomPageSize,
  customPageSize,
  setCustomPageSize,
}) {
  const pageCount = Math.max(1, Math.ceil((total || 0) / pageSize));
  const safePage = Math.min(page, pageCount);
  const [pageSizeMenuOpen, setPageSizeMenuOpen] = useState(false);
  const pageSizeMenuRef = useRef(null);
  const [hoveredOption, setHoveredOption] = useState(null);

  useEffect(() => {
    if (!pageSizeMenuOpen) return undefined;
    const onDocClick = (e) => {
      if (
        pageSizeMenuRef.current &&
        !pageSizeMenuRef.current.contains(e.target)
      ) {
        setPageSizeMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pageSizeMenuOpen]);

  const pages = useMemo(() => {
    const out = new Set([1, pageCount, safePage]);
    for (
      let i = Math.max(2, safePage - 2);
      i <= Math.min(pageCount - 1, safePage + 2);
      i += 1
    ) {
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

  const start = (safePage - 1) * pageSize + 1;
  const end = Math.min(start + pageSize - 1, total);

  const pillBtn = (active, disabled) => ({
    minWidth: 32,
    height: 32,
    padding: "0 0.5rem",
    background: active
      ? "var(--primary-color, var(--accent-color))"
      : "transparent",
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
      data-testid="diagnostics-pager"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "0.75rem",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0.85rem 1rem",
        borderTop: "1px solid var(--border-color, rgba(255,255,255,0.08))",
        fontSize: "0.85rem",
      }}
    >
      <div style={{ color: "var(--text-secondary)" }}>
        Showing{" "}
        <strong style={{ color: "var(--text-primary)" }}>
          {start}–{end}
        </strong>{" "}
        of{" "}
        <strong style={{ color: "var(--text-primary)" }}>
          {total}
        </strong>{" "}
        diagnostics
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
          flexWrap: "wrap",
        }}
      >
        <label
          style={{
            color: "var(--text-secondary)",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
          }}
        >
          Per page:
          {isCustomPageSize ? (
            <>
              <input
                type="number"
                min="1"
                max={MAX_PAGE_SIZE}
                value={customPageSize}
                onChange={(e) => {
                  const raw = parseInt(e.target.value, 10);
                  const val = Number.isFinite(raw)
                    ? Math.min(Math.max(raw, 1), MAX_PAGE_SIZE)
                    : "";
                  setCustomPageSize(val);
                  if (val) onPageSizeChange(val);
                }}
                placeholder={`1-${MAX_PAGE_SIZE}`}
                autoFocus
                title={`Enter a number between 1 and ${MAX_PAGE_SIZE}`}
                style={{
                  width: 80,
                  padding: "0.3rem 0.5rem",
                  borderRadius: 6,
                  border: "1px solid var(--border-color, rgba(255,255,255,0.18))",
                  background: "var(--surface-color, rgba(255,255,255,0.04))",
                  color: "var(--text-primary)",
                }}
              />
              <button
                type="button"
                onClick={() => {
                  setIsCustomPageSize(false);
                  setCustomPageSize("");
                }}
                style={{
                  padding: "0.3rem 0.55rem",
                  borderRadius: 6,
                  border: "1px solid var(--border-color, rgba(255,255,255,0.18))",
                  background: "var(--surface-color, rgba(255,255,255,0.04))",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                }}
              >
                Back
              </button>
            </>
          ) : (
            <div ref={pageSizeMenuRef} style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => setPageSizeMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={pageSizeMenuOpen}
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
                <span>
                  {PAGE_SIZE_OPTIONS.includes(pageSize) ? pageSize : "Custom"}
                </span>
                <ChevronDown size={12} style={{ opacity: 0.7 }} />
              </button>
              {pageSizeMenuOpen && (
                <div
                  role="menu"
                  style={{
                    position: "absolute",
                    top: "auto",
                    bottom: "calc(100% + 4px)",
                    left: 0,
                    minWidth: 110,
                    background: "var(--surface-color, rgba(255,255,255,0.04))",
                    border: "1px solid var(--border-color, rgba(255,255,255,0.18))",
                    borderRadius: 8,
                    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.18)",
                    padding: 4,
                    zIndex: 30,
                  }}
                >
                  {PAGE_SIZE_OPTIONS.map((n) => {
                    const active = pageSize === n;
                    const hovered = hoveredOption === String(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          onPageSizeChange(n);
                          setPageSizeMenuOpen(false);
                        }}
                        onMouseEnter={() => setHoveredOption(String(n))}
                        onMouseLeave={() => setHoveredOption(null)}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "0.45rem 0.7rem",
                          border: "none",
                          borderRadius: 6,
                          cursor: "pointer",
                          background: active
                            ? "var(--primary-color, var(--accent-color))"
                            : hovered
                              ? "var(--surface-color, rgba(255,255,255,0.06))"
                              : "transparent",
                          color: active ? "#fff" : "var(--text-primary, inherit)",
                        }}
                      >
                        {n}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsCustomPageSize(true);
                      setCustomPageSize("");
                      setPageSizeMenuOpen(false);
                    }}
                    onMouseEnter={() => setHoveredOption("custom")}
                    onMouseLeave={() => setHoveredOption(null)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "0.45rem 0.7rem",
                      border: "none",
                      borderRadius: 6,
                      cursor: "pointer",
                      background:
                        hoveredOption === "custom"
                          ? "var(--surface-color, rgba(255,255,255,0.06))"
                          : "transparent",
                      color: "var(--text-primary, inherit)",
                    }}
                  >
                    Custom
                  </button>
                </div>
              )}
            </div>
          )}
        </label>
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
            <span
              key={`gap-${i}`}
              style={{ color: "var(--text-secondary)", padding: "0 0.2rem" }}
            >
              ...
            </span>
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
          ),
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

const ctaPrimary = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 14,
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  textDecoration: "none",
  border: "none",
};

const ctaSecondary = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 14,
  background: "var(--surface-color)",
  color: "var(--primary-color)",
  textDecoration: "none",
  border: "1px solid var(--primary-color)",
};

const selectStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  minWidth: 160,
  fontSize: 13,
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

const bulkDeleteBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid rgba(239, 68, 68, 0.45)",
  background: "rgba(127, 29, 29, 0.18)",
  color: "#fca5a5",
  fontSize: 13,
};

const empty = {
  padding: 32,
  textAlign: "center",
  color: "var(--text-secondary)",
  fontSize: 14,
};

const th = {
  position: "sticky",
  top: 0,
  zIndex: 3,
  textAlign: "left",
  padding: "8px 10px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  background: "var(--modal-bg, var(--bg-color))",
  boxShadow: "inset 0 -1px 0 var(--border-color)",
  whiteSpace: "nowrap",
};

const thCheckbox = {
  ...th,
  width: 44,
  textAlign: "center",
  padding: "8px 6px",
};

const td = {
  padding: "10px 12px",
  fontSize: 14,
  color: "var(--text-primary)",
  minWidth: 0,
};

const tdCheckbox = {
  ...td,
  width: 44,
  textAlign: "center",
  padding: "10px 6px",
};

const brandBadge = {
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  background: "var(--subtle-bg-3)",
  color: "var(--primary-color)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const rowLink = {
  color: "var(--primary-color, var(--accent-color))",
  textDecoration: "none",
  fontWeight: 500,
};
