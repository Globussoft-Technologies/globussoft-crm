import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  Brain,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardCheck,
  Compass,
  Eye,
  Filter,
  Plus,
  Trash2,
  ArrowUpDown,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import CalendarRangePicker from "../../components/CalendarRangePicker";
import CountBadge from "../../components/CountBadge";
import { useActiveSubBrand } from "../../utils/subBrand";

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
const TIER_SORT_ORDER = { entry: 0, primary: 1, premium: 2 };

function fmt(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function readPageParam(params) {
  return Math.max(1, parseInt(params.get("page") || "1", 10) || 1);
}

function ContactCell({ contact, contactId }) {
  const hasName = Boolean(contact?.name);
  const hasEmail = Boolean(contact?.email);
  const hasPhone = Boolean(contact?.phone);

  let primary = null;
  if (hasName) primary = contact.name;
  else if (hasEmail) primary = contact.email;
  else if (contactId) primary = `#${contactId}`;

  let secondary = null;
  if (hasName) {
    secondary = contact.email || contact.phone || null;
  } else if (hasEmail && (hasPhone || contactId)) {
    secondary = contact.phone || `#${contactId}`;
  }

  if (!primary) {
    return <span style={{ color: "var(--text-secondary)" }}>—</span>;
  }

  const content = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        minWidth: 0,
      }}
    >
      <span
        style={contactPrimaryStyle}
        title={primary}
      >
        {primary}
      </span>
      {secondary && (
        <span
          style={contactSecondaryStyle}
          title={secondary}
        >
          {secondary}
        </span>
      )}
    </div>
  );

  if (contactId) {
    return (
      <Link
        to={`/contacts/${contactId}`}
        style={contactLinkStyle}
        aria-label={`Open contact #${contactId}`}
      >
        {content}
      </Link>
    );
  }

  return content;
}

function readPageSizeParam(params) {
  const value = parseInt(params.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10);
  return Math.min(MAX_PAGE_SIZE, Math.max(1, value || DEFAULT_PAGE_SIZE));
}

export default function Diagnostics() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";
  const { activeSubBrand } = useActiveSubBrand();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = readPageParam(searchParams);
  const [diagnostics, setDiagnostics] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [subBrand, setSubBrand] = useState(
    searchParams.get("subBrand") === "all"
      ? ""
      : searchParams.get("subBrand") || activeSubBrand || "",
  );
  const [classification, setClassification] = useState(
    searchParams.get("classification") || "",
  );
  const [fromDate, setFromDate] = useState(searchParams.get("fromDate") || "");
  const [toDate, setToDate] = useState(searchParams.get("toDate") || "");
  const [pageSize, setPageSize] = useState(() => readPageSizeParam(searchParams));
  const [isCustomPageSize, setIsCustomPageSize] = useState(false);
  const [customPageSize, setCustomPageSize] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [sortKey, setSortKey] = useState(() => searchParams.get("sortBy") || null);
  const [sortDirection, setSortDirection] = useState(() => {
    const value = searchParams.get("sortOrder");
    return value === "asc" || value === "desc" ? value : null;
  });

  const reqIdRef = useRef(0);
  const seenDiagnosticIdsRef = useRef(new Set());
  const initialLoadDoneRef = useRef(false);

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
      if (subBrand && subBrand !== "all") qs.set("subBrand", subBrand);
      if (classification) qs.set("classification", classification);
      if (fromDate) qs.set("fromDate", fromDate);
      if (toDate) qs.set("toDate", toDate);
      if (sortKey) {
        qs.set("sortBy", sortKey);
        qs.set("sortOrder", sortDirection || "asc");
      }
      qs.set("limit", String(pageSize));
      qs.set("offset", String(Math.max(0, (page - 1) * pageSize)));

      try {
        const res = await fetchApi(`/api/travel/diagnostics?${qs.toString()}`);
        if (myReqId !== reqIdRef.current) return;
        const rows = Array.isArray(res?.diagnostics) ? res.diagnostics : [];
        const currentIds = new Set(rows.map((d) => d.id));
        if (initialLoadDoneRef.current) {
          const newIds = rows.filter((d) => !seenDiagnosticIdsRef.current.has(d.id));
          if (newIds.length > 0) {
            notify.info(
              `${newIds.length} new diagnostic submission${newIds.length === 1 ? "" : "s"}`,
            );
          }
        }
        currentIds.forEach((id) => seenDiagnosticIdsRef.current.add(id));
        initialLoadDoneRef.current = true;
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
    [classification, fromDate, notify, page, pageSize, sortDirection, sortKey, subBrand, toDate],
  );

  useEffect(() => {
    load({ reset: true });
  }, [load, reloadTick]);

  useEffect(() => {
    if (import.meta.env?.MODE === "test") return undefined;
    const id = setInterval(() => {
      load();
    }, 30000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (total > 0 && page > pageCount) {
      updateParams({ page: pageCount }, { replace: true });
    }
  }, [page, pageCount, total, updateParams]);

  useEffect(() => {
    if (searchParams.has("subBrand")) return;
    setSubBrand(activeSubBrand || "");
  }, [activeSubBrand, searchParams]);

  useEffect(() => {
    if (location.pathname !== "/travel/diagnostics") return;
    try {
      window.sessionStorage.setItem(
        "travel.diagnostics.lastListUrl",
        `${location.pathname}${location.search}`,
      );
    } catch {
      // Ignore storage failures; the URL still carries the active filters.
    }
  }, [location.pathname, location.search]);

  const reload = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  const resetFilters = useCallback(() => {
    const nextSubBrand = activeSubBrand || "";
    setSubBrand(nextSubBrand);
    setClassification("");
    setFromDate("");
    setToDate("");
    setPageSize(DEFAULT_PAGE_SIZE);
    setIsCustomPageSize(false);
    setCustomPageSize("");
    setSortKey(null);
    setSortDirection(null);
    updateParams({
      subBrand: nextSubBrand,
      classification: null,
      fromDate: null,
      toDate: null,
      sortBy: null,
      sortOrder: null,
      pageSize: null,
      page: 1,
    });
    setReloadTick((t) => t + 1);
  }, [activeSubBrand, updateParams]);

  const setPage = useCallback(
    (nextPage) => {
      updateParams({ page: nextPage });
    },
    [updateParams],
  );

  const setPageSizeAndReset = useCallback(
    (nextPageSize) => {
      setPageSize(nextPageSize);
      updateParams({ page: 1, pageSize: nextPageSize });
    },
    [updateParams],
  );

  const activeDiagnostics = useMemo(() => {
    if (!sortKey) return diagnostics;

    const valueFor = (diagnostic) => {
      if (sortKey === "submitted") return new Date(diagnostic.createdAt || 0).getTime();
      if (sortKey === "subBrand") return String(diagnostic.subBrand || "").toLowerCase();
      if (sortKey === "contact") {
        return String(
          diagnostic.contact?.name ||
          diagnostic.contact?.email ||
          diagnostic.contactId ||
          "",
        ).toLowerCase();
      }
      if (sortKey === "score") return diagnostic.score == null ? null : Number(diagnostic.score);
      if (sortKey === "classification") {
        return String(diagnostic.classificationLabel || diagnostic.classification || "").toLowerCase();
      }
      if (sortKey === "tier") {
        const tier = String(diagnostic.recommendedTier || "").toLowerCase();
        return tier ? (TIER_SORT_ORDER[tier] ?? Number.MAX_SAFE_INTEGER) : null;
      }
      return "";
    };

    return [...diagnostics].sort((leftDiagnostic, rightDiagnostic) => {
      const left = valueFor(leftDiagnostic);
      const right = valueFor(rightDiagnostic);
      const leftEmpty = left === null || left === "" || Number.isNaN(left);
      const rightEmpty = right === null || right === "" || Number.isNaN(right);
      if (leftEmpty || rightEmpty) {
        if (leftEmpty && rightEmpty) return 0;
        return leftEmpty ? 1 : -1;
      }
      const comparison = typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right));
      return sortDirection === "desc" ? -comparison : comparison;
    });
  }, [diagnostics, sortDirection, sortKey]);

  const toggleSort = useCallback((key) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDirection("asc");
      updateParams({ sortBy: key, sortOrder: "asc", page: 1 });
      return;
    }

    if (sortDirection === "asc") {
      setSortDirection("desc");
      updateParams({ sortBy: key, sortOrder: "desc", page: 1 });
      return;
    }

    setSortKey(null);
    setSortDirection(null);
    updateParams({ sortBy: null, sortOrder: null, page: 1 });
  }, [sortDirection, sortKey, updateParams]);

  const sortButton = (key, label) => {
    const active = sortKey === key;
    const direction = active ? sortDirection : null;
    const Icon = direction === "asc" ? ChevronUp : direction === "desc" ? ChevronDown : ArrowUpDown;
    const sortStateLabel = !active ? "default" : direction === "desc" ? "descending" : "ascending";
    return (
      <button
        type="button"
        onClick={() => toggleSort(key)}
        aria-label={`Sort ${label} ${sortStateLabel}`}
        style={{
          ...sortButtonStyle,
          ...(active ? sortButtonActiveStyle : null),
        }}
      >
        <span>{label}</span>
        <Icon size={14} aria-hidden />
      </button>
    );
  };
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
      setSelectionMode(false);
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
        className="diagnostics-filter-bar"
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
          <Link
            to="/travel/trip-knowledge"
            style={ctaSecondary}
            aria-label="Manage brochure knowledge base"
            title="Connect Google Drive and manage brochure PDFs so AI-powered diagnostics can recommend trips from your catalog"
          >
            <Brain size={16} aria-hidden /> Travel Knowledge
          </Link>
          {isAdmin && (
            <Link
              to="/travel/diagnostics/banks/new"
              style={ctaSecondary}
              aria-label="Create new diagnostic bank (admin)"
            >
              <Plus size={16} aria-hidden /> Diagnostic settings
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
          padding: 14,
          borderRadius: 12,
          border: "1px solid var(--border-color)",
          marginBottom: 16,
          overflow: "visible",
          position: "relative",
          zIndex: 5,
          boxShadow: "0 10px 28px rgba(15, 23, 42, 0.04)",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
            flex: "1 1 auto",
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
              updateParams({ subBrand: e.target.value || "all", page: 1 });
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
            width={148}
            height={32}
            compact
          />
          <button
            type="button"
            onClick={resetFilters}
            style={resetBtn}
            aria-label="Reset filters"
          >
            Reset filters
          </button>
          <button
            type="button"
            onClick={reload}
            style={resetBtn}
            aria-label="Reload list"
          >
            Refresh
          </button>
        </div>
        {isAdmin && (
          <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
            <button
              type="button"
              onClick={() => {
                setSelectionMode((enabled) => {
                  if (enabled) setSelectedIds(new Set());
                  return !enabled;
                });
              }}
              style={resetBtn}
              aria-label={selectionMode ? "Done selecting diagnostics" : "Select diagnostics"}
            >
              {selectionMode ? "Done" : "Select diagnostics"}
            </button>
            {selectionMode && (
              <>
                <button
                  type="button"
                  onClick={toggleSelectAllVisible}
                  style={resetBtn}
                  aria-label="Select all visible diagnostics"
                >
                  {allVisibleSelected ? "Clear visible" : "Select all visible"}
                </button>
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
              </>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          background: "var(--surface-color)",
          borderRadius: "8px",
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
                className="diagnostics-table"
                aria-label="Diagnostics results"
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  tableLayout: "fixed",
                }}
              >
                <colgroup>
                  {isAdmin && selectionMode && <col style={{ width: "44px" }} />}
                  <col style={{ width: "160px" }} />
                  <col style={{ width: "260px" }} />
                  <col style={{ width: "110px" }} />
                  <col style={{ width: "140px" }} />
                  <col style={{ width: "100px" }} />
                  <col style={{ width: "80px" }} />
                  <col style={{ width: "60px" }} />
                </colgroup>
                <thead>
                  <tr>
                    {isAdmin && selectionMode && (
                      <th style={thCheckbox} aria-sort="none">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleSelectAllVisible}
                          aria-label="Select all visible diagnostics"
                        />
                      </th>
                    )}
                    <th style={th} aria-sort={sortKey === "submitted" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortButton("submitted", "Submitted")}</th>
                    <th style={th} aria-sort={sortKey === "contact" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortButton("contact", "Contact")}</th>
                    <th style={th} aria-sort={sortKey === "subBrand" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortButton("subBrand", "Sub-brand")}</th>
                    <th style={th} aria-sort={sortKey === "classification" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortButton("classification", "Classification")}</th>
                    <th style={th} aria-sort={sortKey === "tier" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortButton("tier", "Tier")}</th>
                    <th style={th} aria-sort={sortKey === "score" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortButton("score", "Score")}</th>
                    <th style={{ ...th, textAlign: "center" }}>
                      <span style={visuallyHidden}>Actions</span>
                    </th>
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
                        className="diagnostics-row"
                        style={{ borderTop: "1px solid var(--border-light)" }}
                      >
                        {isAdmin && selectionMode && (
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
                          <ContactCell contact={d.contact} contactId={d.contactId} />
                        </td>
                        <td style={td}>
                          <span style={brandBadge}>{d.subBrand}</span>
                        </td>
                        <td style={td}>
                          {d.classificationLabel || d.classification || "—"}
                        </td>
                        <td style={td}>
                          <span
                            className={tierClass}
                            style={diagnosticsTierBadgeStyle}
                          >
                            {d.recommendedTier || "—"}
                          </span>
                        </td>
                        <td style={td}>
                          {d.score !== null ? Number(d.score).toFixed(2) : "—"}
                        </td>
                        <td style={{ ...td, textAlign: "center" }}>
                          <Link
                            to={`/travel/diagnostics/${d.id}`}
                            className="diagnostics-view-btn"
                            style={viewIconBtn}
                            title="View diagnostic"
                            aria-label={`View diagnostic #${d.id}`}
                          >
                            <Eye size={16} aria-hidden />
                          </Link>
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
  ...ctaPrimary,
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
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

const resetBtn = {
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
  padding: "10px 10px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontWeight: 700,
  color: "var(--text-primary)",
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

const sortButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 6,
  width: "100%",
  padding: "4px 8px",
  border: "none",
  borderRadius: 999,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  textTransform: "inherit",
  letterSpacing: "inherit",
  cursor: "pointer",
  textAlign: "left",
  transition: "background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease",
};

const sortButtonActiveStyle = {
  color: "var(--primary-color)",
};

const td = {
  padding: "10px 12px",
  fontSize: 14,
  color: "var(--text-primary)",
  minWidth: 0,
  verticalAlign: "top",
};

const diagnosticsTierBadgeStyle = {
  minWidth: 78,
  justifyContent: "center",
  display: "inline-flex",
  alignItems: "center",
  boxShadow: "0 1px 1px rgba(15, 23, 42, 0.04)",
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

const visuallyHidden = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const viewIconBtn = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: 6,
  color: "var(--text-secondary)",
  background: "transparent",
  border: "1px solid var(--border-color)",
  textDecoration: "none",
};

const contactLinkStyle = {
  color: "inherit",
  textDecoration: "none",
  display: "block",
};

const contactPrimaryStyle = {
  fontWeight: 500,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const contactSecondaryStyle = {
  fontSize: 12,
  color: "var(--text-secondary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};
