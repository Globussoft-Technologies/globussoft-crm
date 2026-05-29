import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import {
  Search,
  Plus,
  Users,
  Phone,
  Mail,
  Pencil,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Tag as TagIcon,
  Filter,
  Trash2,
  Download,
  UserPlus,
  Tags as BulkTagIcon,
  Mail as MailIcon,
  Calendar as CalendarIcon,
  AtSign,
  Globe,
  FileText,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { SEARCH_DEBOUNCE_MS } from "../../utils/timing";
import { formatDate } from "../../utils/date";
import { DateRangeFilter, resolveDateRangeYmd, EMPTY_DATE_FILTER } from "../../components/wellness/DateRangeFilter";
import CsvImportExportToolbar from "../../components/wellness/CsvImportExportToolbar";

const SOURCE_OPTIONS = [
  { value: "walk-in", label: "Walk-in" },
  { value: "indiamart", label: "IndiaMART" },
  { value: "google-ad", label: "Google ad" },
  { value: "referral", label: "Referral" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "meta-ad", label: "Meta ad" },
  { value: "import-zylu", label: "Import (Zylu)" },
];
const GENDER_OPTIONS = [
  { value: "M", label: "Male" },
  { value: "F", label: "Female" },
  { value: "Other", label: "Other" },
];
// Lightweight palette for tags whose `color` is null — keyed by id so each
// tag gets a stable colour across renders without polluting the DB.
const TAG_PALETTE = [
  "#7c9b97",
  "#cd9481",
  "#9d8cb0",
  "#8aabd3",
  "#d4a06a",
  "#7fb18c",
  "#c688a3",
  "#8ac2c4",
];
function tagColour(tag) {
  if (tag?.color) return tag.color;
  const id = Number(tag?.id) || 0;
  return TAG_PALETTE[Math.abs(id) % TAG_PALETTE.length];
}

// Read multi-select list from a URLSearchParams instance — accepts either
// repeated entries or comma-joined; serializes back as a single
// comma-joined value to keep the URL short.
function readListParam(params, key) {
  const all = params.getAll(key);
  if (!all.length) return [];
  const out = [];
  const seen = new Set();
  for (const v of all) {
    for (const part of String(v).split(",")) {
      const s = part.trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

export default function Patients() {
  const notify = useNotify();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── URL-driven state ────────────────────────────────────────────────
  const q = searchParams.get("q") || "";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const sourceFilter = readListParam(searchParams, "source");
  const genderFilter = readListParam(searchParams, "gender");
  const tagFilter = readListParam(searchParams, "tags");
  const addedFrom = searchParams.get("addedFrom") || "";
  const addedTo = searchParams.get("addedTo") || "";

  // Update URL helper — preserves keys we don't touch.
  const updateParams = (patch, options = {}) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) {
        next.delete(k);
      } else if (Array.isArray(v)) {
        next.delete(k);
        next.set(k, v.join(","));
      } else {
        next.set(k, String(v));
      }
    }
    setSearchParams(next, options);
  };

  // ── Page-local state ────────────────────────────────────────────────
  // `q` and `page` are URL-driven (declared above from `searchParams`);
  // do NOT shadow them with local useState — the search bar and pager
  // both call setQ/setPage defined below as URL writers.
  const [patients, setPatients] = useState([]);
  const [total, setTotal] = useState(0);
  // Pagination — backend at /api/wellness/patients accepts ?limit (cap 200)
  // + ?offset and returns { patients, total }. `pageSize` stays local
  // (not in URL) so the dropdown choice persists per-tab without polluting
  // shareable links. `page` itself lives in the URL via setPage below.
  const [pageSize, setPageSize] = useState(20);
  // Custom-rows entry mode for the PatientPager dropdown. When the user
  // picks "Custom" from the rows-per-page select, the dropdown swaps to a
  // numeric input bounded to [1, 200] (the backend's hard limit cap).
  const [isCustomPageSize, setIsCustomPageSize] = useState(false);
  const [customPageSize, setCustomPageSize] = useState('');
  // #331-bug fix: form-create flag added so handleCreate can request a refresh
  // without re-introducing a stale-state read. The previous direct `load()`
  // call inside handleCreate re-fetched with whatever `q` the closure had
  // captured when the form was rendered, which raced against the debounced
  // search effect.
  const [reloadTick, setReloadTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [locations, setLocations] = useState([]);
  const [showFilters, setShowFilters] = useState(false);
  // Both create + edit go through the same modal (PatientCreateModal).
  // `editingPatient` carries the patient object when editing; null = create.
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingPatient, setEditingPatient] = useState(null);
  const [showBulkTagModal, setShowBulkTagModal] = useState(false);
  // Header "+ Add" dropdown (New patient / Bulk tag).
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef(null);
  useEffect(() => {
    if (!addMenuOpen) return undefined;
    const onDocClick = (e) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target)) setAddMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [addMenuOpen]);

  // Selection: persists across pagination within the session. Keyed by id.
  const [selected, setSelected] = useState(() => new Set());

  // Tags (tenant-wide list) + per-row popover state.
  const [allTags, setAllTags] = useState([]);
  const [tagPopover, setTagPopover] = useState(null); // { type: 'row', patientId } | { type: 'bulk-add' } | { type: 'bulk-remove' } | null

  // #331 fix preserved: ref-based current q + request-id discipline so
  // a slow empty-q fetch can't stomp on a fresh typed-query fetch.
  const qRef = useRef(q);
  useEffect(() => { qRef.current = q; }, [q]);
  const reqIdRef = useRef(0);
  const didMountRef = useRef(false);

  const load = (currentQ, currentPage = page, currentPageSize = pageSize) => {
    const myReqId = ++reqIdRef.current;
    setLoading(true);
    // Backend at /api/wellness/patients accepts ?limit (cap 200) + ?offset and
    // returns { patients, total }. Wire the URL to the current page-size
    // selection so changing the dropdown actually re-fetches a sliced window.
    const params = new URLSearchParams();
    if (currentQ) params.set("q", currentQ);
    params.set("limit", String(currentPageSize));
    params.set("offset", String(Math.max(0, (currentPage - 1) * currentPageSize)));
    const url = `/api/wellness/patients?${params.toString()}`;
    fetchApi(url)
      .then((d) => {
        if (myReqId !== reqIdRef.current) return;
        setPatients(d.patients || []);
        setTotal(d.total || 0);
      })
      .catch(() => {
        if (myReqId !== reqIdRef.current) return;
        setPatients([]);
        setTotal(0);
      })
      .finally(() => {
        if (myReqId !== reqIdRef.current) return;
        setLoading(false);
      });
  };

  // Snap back to page 1 whenever the search query OR page-size changes —
  // otherwise typing into the search box with `page=5` selected would
  // request offset=200 on a result set that may only have 3 matches and
  // render an empty table even though matches exist.
  useEffect(() => {
    setPage(1);
  }, [q, pageSize]);

  const loadTags = () => {
    fetchApi("/api/wellness/patients/tags")
      .then((d) => setAllTags(d.tags || []))
      .catch(() => setAllTags([]));
  };

  // Initial mount + when any list-affecting URL param changes.
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      load("", page, pageSize);
      return;
    }
    // #548: standardised on SEARCH_DEBOUNCE_MS (300ms) — was 250ms; pen-test
    // flagged drift between Patients (250) and Omnibar (300). One source of
    // truth in utils/timing.js.
    const t = setTimeout(() => load(qRef.current, page, pageSize), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, reloadTick, page, pageSize]);

  useEffect(() => {
    fetchApi("/api/wellness/locations").then(setLocations).catch(() => setLocations([]));
    loadTags();
  }, []);

  // Edit pencil opens the same modal as create, pre-filled with this
  // patient's data. PUT is performed by PatientCreateModal when its
  // `editPatient` prop is set.
  const startEdit = (patient) => {
    setEditingPatient(patient);
  };

  // ── Filter mutators (URL-driven) ─────────────────────────────────
  // The filter modal batches all filter changes into a single
  // updateParams call via its `onApply` hook, so per-field setters are
  // no longer needed at the page level — only `setQ` (search bar) and
  // `setPage` (pagination buttons) remain.
  const setQ = (val) => updateParams({ q: val, page: 1 });
  const setPage = (val) => updateParams({ page: val });

  const activeFilterCount =
    sourceFilter.length + genderFilter.length + tagFilter.length + (addedFrom ? 1 : 0) + (addedTo ? 1 : 0);

  // ── Row selection ─────────────────────────────────────────────────
  const toggleRow = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const pageIds = patients.map((p) => p.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPageSelected = pageIds.some((id) => selected.has(id));
  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  // ── Bulk operations ──────────────────────────────────────────────
  const bulkAddTag = async (tag) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    try {
      const res = await fetchApi(`/api/wellness/patients/tags/bulk`, {
        method: "POST",
        body: JSON.stringify({ patientIds: ids, tagIds: [tag.id] }),
      });
      notify.success(`Added "${tag.name}" to ${res?.assigned ?? 0} link(s)`);
      setTagPopover(null);
      setReloadTick((t) => t + 1);
    } catch (_err) { /* toasted */ }
  };
  const bulkRemoveTag = async (tag) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    try {
      // Raw fetch (not fetchApi) — fetchApi short-circuits every DELETE
      // response to `true` so we'd lose the actual `removed` count from
      // the response body.
      const token = getAuthToken();
      const resp = await fetch(`/api/wellness/patients/tags/bulk`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ patientIds: ids, tagIds: [tag.id] }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        notify.error(body?.error || `Remove failed (${resp.status})`);
        return;
      }
      notify.success(`Removed "${tag.name}" from ${body?.removed ?? 0} link(s)`);
      setTagPopover(null);
      setReloadTick((t) => t + 1);
    } catch (_err) { /* toasted */ }
  };

  // ── Bulk export of selected rows (CSV/XLSX) ──────────────────────
  const [bulkExportMenuOpen, setBulkExportMenuOpen] = useState(false);
  const bulkExportMenuRef = useRef(null);
  useEffect(() => {
    if (!bulkExportMenuOpen) return undefined;
    const onDocClick = (e) => {
      if (bulkExportMenuRef.current && !bulkExportMenuRef.current.contains(e.target)) {
        setBulkExportMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [bulkExportMenuOpen]);
  const exportSelected = async (format) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const params = new URLSearchParams();
    params.set("format", format);
    params.set("ids", ids.join(","));
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/wellness/patients/export?${params.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        notify.error(body.error || `Export failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `patients-selected-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      notify.success(`Exported ${ids.length} patient(s)`);
      setBulkExportMenuOpen(false);
    } catch (e) {
      notify.error(`Export failed: ${e.message}`);
    }
  };

  // ── Filters object passed to CsvImportExportToolbar (so its export
  //    + import always respects the active filters + search). ──────
  const toolbarFilters = useMemo(
    () => ({
      q: q || undefined,
      source: sourceFilter.length ? sourceFilter.join(",") : undefined,
      gender: genderFilter.length ? genderFilter.join(",") : undefined,
      tags: tagFilter.length ? tagFilter.join(",") : undefined,
      addedFrom: addedFrom || undefined,
      addedTo: addedTo || undefined,
    }),
    [q, sourceFilter, genderFilter, tagFilter, addedFrom, addedTo],
  );

  return (
    <div style={{ padding: "2rem", animation: "fadeIn 0.5s ease-out" }}>
      <header
        style={{
          marginBottom: "1.5rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: "var(--font-family)",
              fontSize: "1.75rem",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <Users size={24} /> Patients
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: "0.25rem" }}>
            {total.toLocaleString()} total
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <CsvImportExportToolbar
            entity="customers"
            label="Patients"
            filters={toolbarFilters}
            formats={["csv", "xlsx"]}
            endpoints={{
              export: "/api/wellness/patients/export",
              template: "/api/wellness/patients/import-template",
            }}
            onImported={() => setReloadTick((t) => t + 1)}
          />
          <div ref={addMenuRef} style={{ position: "relative" }}>
            <button
              onClick={() => setAddMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              style={primaryTealBtn}
            >
              <Plus size={16} /> Add <ChevronDown size={14} style={{ opacity: 0.9 }} />
            </button>
            {addMenuOpen && (
              <div role="menu" style={primaryMenuStyle}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setShowCreateModal(true);
                  }}
                  style={primaryMenuItem}
                >
                  <UserPlus size={15} style={{ flexShrink: 0 }} />
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.15 }}>
                    <strong style={{ fontSize: "0.9rem" }}>New patient</strong>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                      Create a single customer record
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setShowBulkTagModal(true);
                  }}
                  style={primaryMenuItem}
                >
                  <BulkTagIcon size={15} style={{ flexShrink: 0 }} />
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.15 }}>
                    <strong style={{ fontSize: "0.9rem" }}>Bulk tag</strong>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                      Add or remove tags across many customers
                    </span>
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Search bar + filter toggle.
          - opaque --surface-color background (instead of the .glass blur)
            so the input reads cleanly on both light & dark themes
          - 1px theme border that lifts to the primary color on focus,
            with a soft glow ring (3px teal-tinted box-shadow)
          - the Filters button is rendered as a sibling for cleaner
            separation from the input field itself */}
      <div
        style={{
          display: "flex",
          gap: "0.6rem",
          marginBottom: "1rem",
          alignItems: "stretch",
          flexWrap: "wrap",
        }}
      >
        {/* Icon-inside-input pattern: the <input> itself is the visible
            bar. The wellness theme already styles inputs with a border +
            bg + focus glow (see [wellness.css](theme/wellness.css)
            input/input:focus rules), so we let it own the appearance —
            no outer wrapper border, no double-shell. The magnifying
            glass and clear button are absolute-positioned inside the
            relative wrapper. */}
        <div style={{ flex: 1, minWidth: 260, position: "relative", display: "flex" }}>
          <Search
            size={16}
            color="var(--text-secondary)"
            style={{
              position: "absolute",
              left: 14,
              top: "50%",
              transform: "translateY(-50%)",
              pointerEvents: "none",
              flexShrink: 0,
            }}
            aria-hidden
          />
          <input
            placeholder="Search by name, phone, or email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{
              width: "100%",
              padding: q ? "0.65rem 2.5rem 0.65rem 2.4rem" : "0.65rem 0.85rem 0.65rem 2.4rem",
              borderRadius: 10,
              fontSize: "0.92rem",
              fontFamily: "inherit",
              // Fallback for generic vertical; wellness's `input` rule
              // overrides with `!important`. Either way the input ends
              // up with a proper themed border + bg.
              background: "var(--surface-color, #fff)",
              border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
              color: "var(--text-primary)",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ("")}
              title="Clear search"
              aria-label="Clear search"
              style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                background: "var(--subtle-bg, rgba(0,0,0,0.06))",
                border: "none",
                borderRadius: 999,
                color: "var(--text-secondary)",
                cursor: "pointer",
                padding: "0.2rem",
                display: "inline-flex",
                alignItems: "center",
                lineHeight: 1,
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowFilters(true)}
          aria-haspopup="dialog"
          aria-expanded={showFilters}
          aria-label="Open filters"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.45rem",
            padding: "0.55rem 1rem",
            background: activeFilterCount > 0
              ? "var(--primary-color, var(--accent-color))"
              : "var(--surface-color, #fff)",
            color: activeFilterCount > 0 ? "#fff" : "var(--text-primary)",
            border: `1px solid ${activeFilterCount > 0
              ? "var(--primary-color, var(--accent-color))"
              : "var(--border-color, rgba(0,0,0,0.12))"}`,
            borderRadius: 10,
            cursor: "pointer",
            fontSize: "0.88rem",
            fontWeight: 500,
            boxShadow: "var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.04))",
            transition: "background 0.15s ease, border-color 0.15s ease",
          }}
        >
          <Filter size={14} />
          Filters
          {activeFilterCount > 0 && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 18,
                height: 18,
                padding: "0 0.35rem",
                borderRadius: 999,
                background: "rgba(255,255,255,0.25)",
                color: "#fff",
                fontSize: "0.72rem",
                fontWeight: 600,
              }}
            >
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {showFilters && (
        <FilterModal
          onClose={() => setShowFilters(false)}
          initial={{
            source: sourceFilter,
            gender: genderFilter,
            addedFrom,
            addedTo,
            tags: tagFilter,
          }}
          allTags={allTags}
          onApply={(next) => {
            // Single URL write so we don't trip the debounced fetch four
            // times in quick succession (each `set...` already collapses
            // page back to 1).
            updateParams({
              source: next.source,
              gender: next.gender,
              tags: next.tags,
              addedFrom: next.addedFrom,
              addedTo: next.addedTo,
              page: 1,
            });
          }}
        />
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div
          role="region"
          aria-live="polite"
          aria-label={`${selected.size} patient(s) selected`}
          className="glass"
          style={{
            padding: "0.6rem 1rem",
            marginBottom: "1rem",
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            flexWrap: "wrap",
            borderRadius: 12,
            border: "1px solid var(--primary-color, var(--accent-color))",
            // .glass applies backdrop-filter which creates a stacking
            // context; without an explicit z-index, the table card below
            // (also .glass) paints over the Export Selected dropdown
            // because both contexts have an implicit z=auto and the
            // table is later in the DOM. Lift this bar above the table
            // so the dropdown can render on top.
            position: "relative",
            zIndex: 20,
          }}
        >
          <strong style={{ fontSize: "0.9rem" }}>{selected.size} selected</strong>
          <button type="button" onClick={() => setTagPopover({ type: "bulk-add" })} style={bulkBtnStyle}>
            <TagIcon size={14} /> Add Tag
          </button>
          <button type="button" onClick={() => setTagPopover({ type: "bulk-remove" })} style={bulkBtnStyle}>
            <Trash2 size={14} /> Remove Tag
          </button>
          <div ref={bulkExportMenuRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setBulkExportMenuOpen((v) => !v)}
              style={bulkBtnStyle}
              aria-haspopup="menu"
              aria-expanded={bulkExportMenuOpen}
            >
              <Download size={14} /> Export Selected <ChevronDown size={12} />
            </button>
            {bulkExportMenuOpen && (
              <div role="menu" style={dropdownMenuStyle}>
                <button type="button" role="menuitem" onClick={() => exportSelected("csv")} style={dropdownItemStyle}>CSV</button>
                <button type="button" role="menuitem" onClick={() => exportSelected("xlsx")} style={dropdownItemStyle}>Excel (XLSX)</button>
              </div>
            )}
          </div>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={clearSelection} style={{ ...iconBtnSmall, padding: "0.35rem 0.7rem" }}>
            Clear selection
          </button>

          {/* Bulk tag picker popovers */}
          {tagPopover?.type === "bulk-add" && (
            <TagPickerPopover
              allTags={allTags}
              onPick={bulkAddTag}
              onClose={() => setTagPopover(null)}
              onCreated={(newTag) => {
                setAllTags((prev) => (prev.some((t) => t.id === newTag.id) ? prev : [...prev, newTag].sort((a, b) => a.name.localeCompare(b.name))));
                return bulkAddTag(newTag);
              }}
              showCreate
              title="Add tag to selected"
            />
          )}
          {tagPopover?.type === "bulk-remove" && (
            <TagPickerPopover
              allTags={allTags}
              onPick={bulkRemoveTag}
              onClose={() => setTagPopover(null)}
              showCreate={false}
              title="Remove tag from selected"
            />
          )}
        </div>
      )}

      {loading && <div>Loading…</div>}

      {!loading && (
        <div className="glass" style={{ padding: 0, overflow: "visible" }}>
          <table className="stable-table" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <th style={{ ...thStyle, width: 38, paddingRight: 4 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all on page"
                    checked={allOnPageSelected}
                    ref={(el) => { if (el) el.indeterminate = !allOnPageSelected && someOnPageSelected; }}
                    onChange={togglePage}
                  />
                </th>
                <th style={{ ...thStyle, width: "22%" }}>Name</th>
                <th style={{ ...thStyle, width: "14%" }}>Phone</th>
                <th style={{ ...thStyle, width: "22%" }}>Email</th>
                <th style={{ ...thStyle, width: "10%" }}>Gender</th>
                <th style={{ ...thStyle, width: "14%" }}>Source</th>
                <th style={{ ...thStyle, width: "12%" }}>Added</th>
                <th style={{ ...thStyle, width: "6%", textAlign: "center" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => (
                <tr key={p.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ ...tdStyle, paddingRight: 4 }}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${p.name}`}
                      checked={selected.has(p.id)}
                      onChange={() => toggleRow(p.id)}
                    />
                  </td>
                  <td style={nameTdStyle} title={p.name}>
                    <Link to={`/wellness/patients/${p.id}`} style={{ color: "var(--accent-color)", textDecoration: "none", fontWeight: 500 }}>
                      {p.name}
                    </Link>
                  </td>
                  <td style={tdStyle}>
                    {p.phone && (
                      <span>
                        <Phone size={12} style={{ verticalAlign: "middle" }} /> {p.phone}
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    {p.email && (
                      <span>
                        <Mail size={12} style={{ verticalAlign: "middle" }} /> {p.email}
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>{p.gender || "—"}</td>
                  <td style={tdStyle}>{p.source || "—"}</td>
                  <td style={tdStyle}>
                    {formatDate(p.createdAt)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    <button
                      onClick={() => startEdit(p)}
                      title="Edit patient"
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--accent-color)",
                        cursor: "pointer",
                        padding: "0.25rem",
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      <Pencil size={16} />
                    </button>
                  </td>
                </tr>
              ))}
              {patients.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ ...tdStyle, textAlign: "center", color: "var(--text-secondary)" }}>
                    No patients match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <PatientPager
            total={total}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            isCustomPageSize={isCustomPageSize}
            setIsCustomPageSize={setIsCustomPageSize}
            customPageSize={customPageSize}
            setCustomPageSize={setCustomPageSize}
          />
        </div>
      )}

      {(showCreateModal || editingPatient) && (
        <PatientCreateModal
          key={editingPatient ? `edit-${editingPatient.id}` : "create"}
          locations={locations}
          editPatient={editingPatient}
          onClose={() => {
            setShowCreateModal(false);
            setEditingPatient(null);
          }}
          onCreated={() => {
            setShowCreateModal(false);
            setEditingPatient(null);
            if (!editingPatient) updateParams({ page: 1 });
            setReloadTick((t) => t + 1);
          }}
        />
      )}
      {showBulkTagModal && (
        <BulkTagModal
          allTags={allTags}
          onClose={() => setShowBulkTagModal(false)}
          onTagsChanged={() => {
            // The bulk modal mutates tags on patients; refresh the list so
            // the chips in the main table reflect the bulk action.
            setReloadTick((t) => t + 1);
          }}
          onTagCreated={(tag) => {
            setAllTags((prev) =>
              prev.some((t) => t.id === tag.id) ? prev : [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)),
            );
          }}
        />
      )}
    </div>
  );
}

// Pagination footer — Prev / numbered pages (windowed) / Next + items-per-
// page selector. Rendered below the table so it's always reachable even
// with a tall list. Hides itself when total fits within a single page.
function PatientPager({ total, page, pageSize, onPageChange, onPageSizeChange, isCustomPageSize, setIsCustomPageSize, customPageSize, setCustomPageSize }) {
  const pageCount = Math.max(1, Math.ceil((total || 0) / pageSize));
  const safePage = Math.min(page, pageCount);
  // Custom dropdown for the page-size selector — matches the Export
  // Selected menu shape (button + absolute popup) so the surface looks
  // theme-consistent across both verticals. Native <select> rendered the
  // <option> popup with the OS palette regardless of how the trigger was
  // styled, which clashed with the dark wellness theme.
  const [pageSizeMenuOpen, setPageSizeMenuOpen] = useState(false);
  const pageSizeMenuRef = useRef(null);
  const [hoveredOption, setHoveredOption] = useState(null);
  useEffect(() => {
    if (!pageSizeMenuOpen) return undefined;
    const onDocClick = (e) => {
      if (pageSizeMenuRef.current && !pageSizeMenuRef.current.contains(e.target)) {
        setPageSizeMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pageSizeMenuOpen]);
  const pages = useMemo(() => {
    // Compact window: always show 1, the current page ±2, and pageCount,
    // with ellipses where there's a gap. Keeps the bar narrow on long
    // lists (e.g. 600+ patients = 13+ pages of 50).
    const out = new Set([1, pageCount, safePage]);
    for (let i = Math.max(2, safePage - 2); i <= Math.min(pageCount - 1, safePage + 2); i++) {
      out.add(i);
    }
    const sorted = Array.from(out).sort((a, b) => a - b);
    const withGaps = [];
    sorted.forEach((p, i) => {
      if (i > 0 && p - sorted[i - 1] > 1) withGaps.push("…");
      withGaps.push(p);
    });
    return withGaps;
  }, [pageCount, safePage]);

  if (total === 0) return null;
  const start = (safePage - 1) * pageSize + 1;
  const end = Math.min(start + pageSize - 1, total);

  const pillBtn = (active, disabled) => ({
    minWidth: 32, height: 32, padding: "0 0.5rem",
    background: active ? "var(--primary-color, var(--accent-color))" : "transparent",
    color: active ? "#fff" : "var(--text-primary)",
    border: "1px solid var(--border-color, rgba(255,255,255,0.18))",
    borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "0.85rem", display: "inline-flex", alignItems: "center", justifyContent: "center",
    opacity: disabled ? 0.4 : 1,
  });

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center", justifyContent: "space-between", padding: "0.85rem 1rem", borderTop: "1px solid var(--border-color, rgba(255,255,255,0.08))", fontSize: "0.85rem" }}>
      <div style={{ color: "var(--text-secondary)" }}>
        Showing <strong style={{ color: "var(--text-primary)" }}>{start}–{end}</strong> of <strong style={{ color: "var(--text-primary)" }}>{total}</strong> patients
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
        <label style={{ color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
          Per page:
          {isCustomPageSize ? (
            <>
              <input
                type="number"
                min="1"
                max="200"
                value={customPageSize}
                onChange={(e) => {
                  // Backend caps ?limit at 200; clamp the input to the same
                  // range so a typo can't fire a request that gets silently
                  // truncated server-side.
                  const raw = parseInt(e.target.value, 10);
                  const val = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : '';
                  setCustomPageSize(val);
                  if (val) onPageSizeChange(val);
                }}
                placeholder="1-200"
                autoFocus
                title="Enter a number between 1 and 200"
                style={{ width: 80, padding: "0.3rem 0.5rem", borderRadius: 6, border: "1px solid var(--border-color, rgba(255,255,255,0.18))", background: "var(--surface-color, rgba(255,255,255,0.04))", color: "var(--text-primary)" }}
              />
              <button
                type="button"
                onClick={() => { setIsCustomPageSize(false); setCustomPageSize(''); }}
                style={{ padding: "0.3rem 0.55rem", borderRadius: 6, border: "1px solid var(--border-color, rgba(255,255,255,0.18))", background: "var(--surface-color, rgba(255,255,255,0.04))", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.85rem" }}
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
                <span>{[10, 20, 50].includes(pageSize) ? pageSize : 'Custom'}</span>
                <ChevronDown size={12} style={{ opacity: 0.7 }} />
              </button>
              {pageSizeMenuOpen && (
                <div
                  role="menu"
                  style={{
                    ...dropdownMenuStyle,
                    // Pager lives at the bottom of the table, so open the menu
                    // upward to avoid clipping below the viewport. Anchored to
                    // the trigger button's left edge.
                    top: "auto",
                    bottom: "calc(100% + 4px)",
                    right: "auto",
                    left: 0,
                    minWidth: 110,
                  }}
                >
                  {[10, 20, 50].map((n) => {
                    const active = pageSize === n;
                    const hovered = hoveredOption === String(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        role="menuitem"
                        onClick={() => { onPageSizeChange(n); setPageSizeMenuOpen(false); }}
                        onMouseEnter={() => setHoveredOption(String(n))}
                        onMouseLeave={() => setHoveredOption(null)}
                        style={{
                          ...dropdownItemStyle,
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
                    onClick={() => { setIsCustomPageSize(true); setCustomPageSize(''); setPageSizeMenuOpen(false); }}
                    onMouseEnter={() => setHoveredOption('custom')}
                    onMouseLeave={() => setHoveredOption(null)}
                    style={{
                      ...dropdownItemStyle,
                      background: hoveredOption === 'custom'
                        ? "var(--surface-color, rgba(255,255,255,0.06))"
                        : "transparent",
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
        {pages.map((p, i) => (
          p === "…"
            ? <span key={`gap-${i}`} style={{ color: "var(--text-secondary)", padding: "0 0.2rem" }}>…</span>
            : <button
                key={p}
                type="button"
                onClick={() => onPageChange(p)}
                aria-current={p === safePage ? "page" : undefined}
                style={pillBtn(p === safePage, false)}
              >
                {p}
              </button>
        ))}
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

// ── Reusable tag picker popover ─────────────────────────────────────
function TagPickerPopover({ allTags, onPick, onClose, onCreated, onCreate, excludeIds = [], showCreate = true, title }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) onClose();
    };
    const keyHandler = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  const trimmed = query.trim();
  const filtered = allTags
    .filter((t) => !excludeIds.includes(t.id))
    .filter((t) => !trimmed || t.name.toLowerCase().includes(trimmed.toLowerCase()));
  const exactMatch = trimmed && filtered.some((t) => t.name.toLowerCase() === trimmed.toLowerCase());

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={title || "Tag picker"}
      style={tagPopoverStyle}
    >
      <div style={{ padding: "0.5rem 0.6rem", borderBottom: "1px solid var(--border-color, rgba(0,0,0,0.08))" }}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search or create…"
          aria-label="Search tags"
          style={{
            width: "100%",
            background: "var(--surface-color, #fff)",
            border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
            borderRadius: 6,
            color: "var(--text-primary)",
            padding: "0.35rem 0.55rem",
            fontSize: "0.85rem",
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (filtered.length && !exactMatch && trimmed === "") return;
              if (filtered[0] && (!trimmed || filtered[0].name.toLowerCase() === trimmed.toLowerCase())) {
                onPick(filtered[0]);
              } else if (showCreate && trimmed && !exactMatch && onCreate) {
                onCreate(trimmed);
              }
            }
          }}
        />
      </div>
      <div style={{ maxHeight: 200, overflowY: "auto", padding: "0.25rem" }}>
        {filtered.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t)}
            style={{ ...tagOptionStyle, display: "flex", alignItems: "center", gap: "0.4rem" }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 4, background: tagColour(t) }} />
            {t.name}
          </button>
        ))}
        {filtered.length === 0 && !trimmed && (
          <div style={{ padding: "0.5rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
            No tags yet.
          </div>
        )}
        {showCreate && trimmed && !exactMatch && (
          <button
            type="button"
            onClick={() => {
              if (onCreate) onCreate(trimmed);
              else if (onCreated) onCreated({ name: trimmed });
            }}
            style={{ ...tagOptionStyle, color: "var(--primary-color, var(--accent-color))" }}
          >
            + Create “{trimmed}”
          </button>
        )}
      </div>
    </div>
  );
}

// ── Reusable multi-select chip list ─────────────────────────────────
// ── FilterModal — popup with dropdown selectors for each filter ────
// Holds a DRAFT copy of the active filters; nothing commits until the
// user clicks "Apply". Cancel / outside-click / Esc discards the draft.
function FilterModal({ onClose, initial, allTags, onApply }) {
  const [draft, setDraft] = useState({
    source: initial.source || [],
    gender: initial.gender || [],
    // Existing addedFrom/addedTo URL params reconstruct as a custom-preset filter
    // so the picker re-opens on the user's current selection.
    dateFilter: (initial.addedFrom || initial.addedTo)
      ? { preset: 'custom', start: initial.addedFrom || '', end: initial.addedTo || '' }
      : EMPTY_DATE_FILTER,
    tags: initial.tags || [],
  });
  const hasDateFilter = draft.dateFilter && draft.dateFilter.preset !== 'all';
  const activeCount =
    draft.source.length +
    draft.gender.length +
    draft.tags.length +
    (hasDateFilter ? 1 : 0);
  const reset = () =>
    setDraft({ source: [], gender: [], dateFilter: EMPTY_DATE_FILTER, tags: [] });
  const apply = () => {
    const [addedFrom, addedTo] = resolveDateRangeYmd(draft.dateFilter);
    onApply({
      source: draft.source,
      gender: draft.gender,
      addedFrom: addedFrom || "",
      addedTo: addedTo || "",
      tags: draft.tags,
    });
    onClose();
  };
  return (
    <ModalShell
      title="Filter customers"
      onClose={onClose}
      width={560}
      footer={
        <>
          <span style={{ marginRight: "auto", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            {activeCount} filter{activeCount === 1 ? "" : "s"} active
          </span>
          <button
            type="button"
            onClick={reset}
            disabled={activeCount === 0}
            style={{
              background: "transparent",
              border: "none",
              color: activeCount === 0
                ? "var(--text-tertiary, var(--text-secondary))"
                : "var(--primary-color, var(--accent-color))",
              cursor: activeCount === 0 ? "default" : "pointer",
              fontSize: "0.85rem",
              fontWeight: 500,
              padding: "0.35rem 0.6rem",
              borderRadius: 6,
              opacity: activeCount === 0 ? 0.55 : 1,
            }}
          >
            Reset
          </button>
          <button type="button" onClick={onClose} style={iconBtnSmall}>Cancel</button>
          <button
            type="button"
            onClick={apply}
            style={{ ...primaryTealBtn, padding: "0.55rem 1.25rem" }}
          >
            Apply
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
        <FilterFieldRow label="Source" icon={<Globe size={14} />}>
          <MultiSelectDropdown
            options={SOURCE_OPTIONS}
            selected={draft.source}
            onChange={(v) => setDraft({ ...draft, source: v })}
            placeholder="All sources"
          />
        </FilterFieldRow>
        <FilterFieldRow label="Gender" icon={<UserPlus size={14} />}>
          <MultiSelectDropdown
            options={GENDER_OPTIONS}
            selected={draft.gender}
            onChange={(v) => setDraft({ ...draft, gender: v })}
            placeholder="Any gender"
          />
        </FilterFieldRow>
        <FilterFieldRow label="Added date" icon={<CalendarIcon size={14} />}>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <DateRangeFilter
              value={draft.dateFilter}
              onChange={(next) => setDraft({ ...draft, dateFilter: next })}
              label={null}
            />
          </div>
        </FilterFieldRow>
        <FilterFieldRow label="Tags" icon={<TagIcon size={14} />}>
          <MultiSelectDropdown
            options={allTags.map((t) => ({ value: String(t.id), label: t.name, color: tagColour(t) }))}
            selected={draft.tags}
            onChange={(v) => setDraft({ ...draft, tags: v })}
            placeholder="Any tag"
            searchable
            chipColours
          />
        </FilterFieldRow>
      </div>
    </ModalShell>
  );
}

function FilterFieldRow({ label, icon, children }) {
  return (
    <div>
      <div style={{ ...filterLabelStyle, marginBottom: "0.45rem", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

// ── MultiSelectDropdown — trigger button + checkbox-list popover ───
// Open/close is local state; close on outside-click / Esc. Optional
// `searchable` adds a filter input on top of the list (used by Tags).
// `chipColours` renders a small color dot next to each option (used by
// Tags so the user can recognise their own labels visually).
//
// The popover renders with `position: fixed` and coordinates computed
// from the trigger's bounding rect. Two reasons:
//   1. The dropdown lives inside a modal whose body has `overflow:auto`
//      — with `position:absolute` the popover gets clipped at the
//      modal's bottom edge (the user had to scroll inside the modal
//      to reveal the Tags list).
//   2. The popover auto-flips upward when there's not enough room
//      below the trigger — so the last filter in the modal can show
//      its full list without forcing the modal to scroll at all.
function MultiSelectDropdown({ options, selected, onChange, placeholder, searchable = false, chipColours = false }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [popoverPos, setPopoverPos] = useState(null);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  // The popover is rendered via createPortal to document.body (see the
  // big comment near the popover render). It is therefore NOT a DOM
  // descendant of wrapRef, so the outside-click handler needs its own
  // ref to recognise clicks-on-popover as "inside".
  const popoverRef = useRef(null);

  // Compute fixed-positioned coordinates from the trigger's rect.
  //
  // Auto-flip heuristic (revised):
  //   * Open UPWARD if the trigger's vertical center sits in the
  //     bottom ~45% of the viewport AND there's at least POPOVER_MIN
  //     room above.
  //   * Otherwise open downward.
  //
  // The previous heuristic ("only flip up when spaceBelow < 160px")
  // didn't work inside a modal — the popover can flow outside the
  // modal into the dim backdrop area, so `spaceBelow` was always
  // plenty even when the popover ended up visually awkward (cut off
  // at the modal bottom edge / overlapping the page below). Biasing
  // by trigger position relative to the viewport gives the result
  // the user expects: a filter at the bottom of the modal opens up.
  //
  // maxHeight is clamped to the available space minus 12 px viewport
  // breathing room so the popover never bleeds past the viewport.
  const POPOVER_DESIRED = 320;
  const POPOVER_MIN = 160;
  const computePos = () => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    const vpH = window.innerHeight;
    const spaceBelow = vpH - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const triggerCenterY = rect.top + rect.height / 2;
    const inLowerHalf = triggerCenterY > vpH * 0.55;
    const openUp = inLowerHalf && spaceAbove >= POPOVER_MIN;
    const available = openUp ? spaceAbove : spaceBelow;
    const maxH = Math.max(POPOVER_MIN, Math.min(available, POPOVER_DESIRED));
    if (openUp) {
      return {
        left: rect.left,
        bottom: vpH - rect.top + 6,
        width: rect.width,
        maxHeight: maxH,
      };
    }
    return {
      left: rect.left,
      top: rect.bottom + 6,
      width: rect.width,
      maxHeight: maxH,
    };
  };

  useEffect(() => {
    if (!open) return undefined;
    setPopoverPos(computePos());
    const recompute = () => setPopoverPos(computePos());
    const onDoc = (e) => {
      // Popover is portalled to document.body, so it's NOT a DOM
      // descendant of wrapRef. Check both refs.
      const insideWrap = wrapRef.current && wrapRef.current.contains(e.target);
      const insidePopover = popoverRef.current && popoverRef.current.contains(e.target);
      if (!insideWrap && !insidePopover) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", recompute);
    // Capture-phase scroll listener catches ANY scroll — page, modal
    // body, any nested overflow:auto container — and keeps the popover
    // glued to the trigger as it moves.
    window.addEventListener("scroll", recompute, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [open]);

  const toggle = (value) => {
    if (selected.includes(value)) onChange(selected.filter((v) => v !== value));
    else onChange([...selected, value]);
  };

  // Summary shown inside the trigger.
  let summary;
  if (selected.length === 0) {
    summary = <span style={{ color: "var(--text-tertiary, var(--text-secondary))" }}>{placeholder}</span>;
  } else if (selected.length === 1) {
    const lone = options.find((o) => o.value === selected[0]);
    summary = lone ? lone.label : "1 selected";
  } else {
    summary = `${selected.length} selected`;
  }

  const filtered = searchable && search.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(search.trim().toLowerCase()))
    : options;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          ...modalInputStyle,
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          cursor: "pointer",
          textAlign: "left",
          minHeight: 42,
          padding: "0.55rem 0.8rem",
        }}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary}
        </span>
        {selected.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onChange([]); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange([]); } }}
            aria-label="Clear selection"
            title="Clear selection"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0.15rem",
              borderRadius: 999,
              background: "var(--subtle-bg, rgba(0,0,0,0.04))",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            <X size={12} />
          </span>
        )}
        <ChevronDown size={14} style={{ color: "var(--text-secondary)", transition: "transform 0.12s ease", transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          role="listbox"
          style={{
            position: "fixed",
            ...popoverPos,
            // Above the modal overlay (z=1000). Portalled to document.body
            // (see comment at the top of the component) so it escapes the
            // modal's `.glass` backdrop-filter — that backdrop-filter
            // creates a containing block for position:fixed descendants
            // per CSS spec, which is why the previous in-place render
            // came out invisible / off-screen.
            zIndex: 1100,
            // IMPORTANT: --bg-color (not --surface-color). In dark
            // wellness, --surface-color is rgba(30,38,40,0.6) — 60%
            // transparent — which makes the popover see-through and
            // illegible against the modal's form fields behind it.
            // --bg-color is opaque in BOTH themes.
            background: "var(--bg-color, #fff)",
            border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
            borderRadius: 10,
            boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {searchable && (
            <div style={{ padding: "0.5rem 0.6rem", borderBottom: "1px solid var(--border-color, rgba(0,0,0,0.08))" }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                aria-label="Search options"
                style={{
                  width: "100%",
                  padding: "0.35rem 0.55rem",
                  border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
                  borderRadius: 6,
                  background: "var(--surface-color, #fff)",
                  color: "var(--text-primary)",
                  fontSize: "0.85rem",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          )}
          <div style={{ overflowY: "auto", padding: "0.25rem 0", flex: 1, minHeight: 0 }}>
            {filtered.length === 0 && (
              <div style={{ padding: "0.6rem 0.8rem", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                {searchable && search.trim() ? "No matches." : "No options."}
              </div>
            )}
            {filtered.map((opt) => {
              const isSelected = selected.includes(opt.value);
              return (
                <label
                  key={opt.value}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.55rem",
                    padding: "0.45rem 0.8rem",
                    cursor: "pointer",
                    fontSize: "0.88rem",
                    color: "var(--text-primary)",
                    background: isSelected ? "var(--subtle-bg, rgba(0,0,0,0.04))" : "transparent",
                    transition: "background 0.1s ease",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(opt.value)}
                    aria-label={opt.label}
                  />
                  {chipColours && opt.color && (
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: opt.color, flexShrink: 0 }} />
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{opt.label}</span>
                </label>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────
const thStyle = {
  textAlign: "left",
  padding: "0.75rem 1rem",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--text-secondary)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const tdStyle = {
  padding: "0.75rem 1rem",
  fontSize: "0.9rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const nameTdStyle = { ...tdStyle, maxWidth: 220 };
const iconBtnSmall = {
  background: "var(--subtle-bg, rgba(0,0,0,0.04))",
  border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
  borderRadius: 6,
  color: "var(--text-secondary)",
  cursor: "pointer",
  padding: "0.25rem 0.4rem",
  display: "inline-flex",
  alignItems: "center",
  flexShrink: 0,
  fontSize: "0.8rem",
};
const filterLabelStyle = {
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--text-secondary)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: "0.5rem",
  display: "inline-flex",
  alignItems: "center",
};
const paginationBtn = (disabled) => ({
  display: "flex",
  alignItems: "center",
  gap: "0.25rem",
  padding: "0.5rem 1rem",
  background: disabled ? "transparent" : "var(--subtle-bg, rgba(0,0,0,0.04))",
  border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
  borderRadius: 8,
  cursor: disabled ? "not-allowed" : "pointer",
  color: disabled ? "var(--text-secondary)" : "var(--text-primary)",
  fontSize: "0.85rem",
  opacity: disabled ? 0.5 : 1,
});
const bulkBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0.4rem 0.75rem",
  background: "var(--subtle-bg, rgba(0,0,0,0.04))",
  border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
  borderRadius: 8,
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: "0.85rem",
};
const tagChipStyle = (colour) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.2rem",
  padding: "0.15rem 0.45rem",
  borderRadius: 999,
  background: `${colour}33`,
  color: "var(--text-primary)",
  border: `1px solid ${colour}66`,
  fontSize: "0.75rem",
  whiteSpace: "nowrap",
});
// Variant rendered as a real <button> so clicks toggle the tag into
// the BulkTagModal's selectedTags. Selected state gets a heavier
// outline + brighter fill + a tick so the user can see what's marked
// for the next Add / Remove operation.
const inRowChipBtnStyle = (colour, isSelected) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
  padding: isSelected ? "0.15rem 0.5rem" : "0.15rem 0.45rem",
  borderRadius: 999,
  background: isSelected ? `${colour}66` : `${colour}22`,
  color: "var(--text-primary)",
  border: isSelected ? `2px solid ${colour}` : `1px solid ${colour}55`,
  fontSize: "0.75rem",
  fontWeight: isSelected ? 600 : 400,
  whiteSpace: "nowrap",
  cursor: "pointer",
  outline: "none",
  transition: "background 0.12s ease, border-color 0.12s ease",
});
const chipRemoveStyle = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  opacity: 0.7,
};
const overflowChipStyle = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0.15rem 0.45rem",
  borderRadius: 999,
  background: "var(--subtle-bg, rgba(0,0,0,0.06))",
  color: "var(--text-secondary)",
  fontSize: "0.75rem",
  cursor: "default",
};
const tagPopoverStyle = {
  position: "absolute",
  top: "100%",
  left: 0,
  marginTop: 6,
  zIndex: 200,
  minWidth: 220,
  // --bg-color (not --surface-color) — see comment on the MultiSelect
  // dropdown popover: --surface-color is translucent in dark wellness.
  background: "var(--bg-color, #fff)",
  border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
  borderRadius: 10,
  boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
};
const tagOptionStyle = {
  width: "100%",
  textAlign: "left",
  padding: "0.4rem 0.6rem",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "var(--text-primary)",
  fontSize: "0.85rem",
  borderRadius: 6,
};
const dropdownMenuStyle = {
  position: "absolute",
  top: "calc(100% + 4px)",
  right: 0,
  minWidth: 160,
  // --bg-color: opaque in both themes (--surface-color is translucent
  // in dark wellness, which makes menu items hard to read).
  background: "var(--bg-color, #fff)",
  border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
  borderRadius: 8,
  boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
  padding: "0.25rem",
  zIndex: 100,
  display: "flex",
  flexDirection: "column",
};
const dropdownItemStyle = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  background: "transparent",
  color: "var(--text-primary, inherit)",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.85rem",
};

// ── Primary (teal) dropdown button styles ──────────────────────────
// Per the wellness-theme standing rule, primary CTAs read from
// --primary-color (teal in wellness; falls back to --accent-color in
// generic). This keeps the "Add" button on-brand in both verticals.
const primaryTealBtn = {
  display: "flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0.5rem 1rem",
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 500,
};
const primaryMenuStyle = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  minWidth: 240,
  // --bg-color: opaque in both themes (--surface-color is translucent
  // in dark wellness, which makes "New patient" / "Bulk tag" items
  // hard to read against the page behind them).
  background: "var(--bg-color, #fff)",
  border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
  borderRadius: 10,
  boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
  padding: "0.4rem",
  zIndex: 200,
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
};
const primaryMenuItem = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  textAlign: "left",
  padding: "0.55rem 0.7rem",
  background: "transparent",
  color: "var(--text-primary)",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
};

// ── Modal shell (reused by both create + bulk-tag modals) ──────────
// Theme-adaptive: we let the `.glass` class supply the background
// (translucent white in light mode, translucent dark teal in dark
// mode — both already defined in [theme/wellness.css](src/theme/wellness.css))
// and never set an inline background or `color` here. Borders + the
// header/footer separators use `--border-color` which also adapts.
function ModalShell({ title, onClose, children, footer, width = 560 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Page-scroll lock while the modal is mounted.
  //
  // The app shell layout (components/Layout.jsx) uses
  //   .app-shell { overflow:hidden; height:100vh }
  //   <main>     { flex:1; overflowY:auto }   ← React inline style
  // — so the actual scrollable element is <main>, NOT <body>.
  //
  // IMPORTANT: we save/restore the LONGHAND properties (overflowY +
  // overflowX) rather than the `overflow` shorthand. Setting the
  // shorthand on a node whose inline style only has the longhand
  // (`overflowY:auto`) wipes that longhand when the shorthand is
  // cleared on cleanup — leaving <main> with no overflow rule at
  // all and the page stuck un-scrollable until refresh. Touching
  // longhands keeps the shorthand untouched and vice-versa.
  useEffect(() => {
    const mainEl = document.querySelector("main");
    const html = document.documentElement;
    const body = document.body;
    const targets = [mainEl, html, body].filter(Boolean);
    const prev = targets.map((el) => ({
      el,
      overflowY: el.style.overflowY,
      overflowX: el.style.overflowX,
    }));
    targets.forEach((el) => {
      el.style.overflowY = "hidden";
      el.style.overflowX = "hidden";
    });
    return () => {
      prev.forEach(({ el, overflowY, overflowX }) => {
        el.style.overflowY = overflowY;
        el.style.overflowX = overflowX;
      });
    };
  }, []);
  // Portal the modal out to document.body. The app's <main> element
  // gets `transform: translateY(0)` (from .animate-fade-in's `forwards`
  // fill-mode in index.css) which, per CSS spec, creates a containing
  // block for `position: fixed` descendants — so an in-place modal
  // gets positioned relative to <main>'s scrolled content, not the
  // viewport. When <main> is scrolled (e.g. user clicked Edit on a
  // row near the bottom of the list), the modal renders far above
  // the visible area and only the footer slice is visible.
  // Rendering through document.body escapes the transformed ancestor.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "1rem",
      }}
    >
      <div
        className="glass"
        style={{
          width: "100%",
          maxWidth: width,
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: 14,
          // .glass already sets border + background; keep `border` here as a
          // no-op fallback so a future theme without .glass still renders.
          border: "1px solid var(--border-color, rgba(0,0,0,0.1))",
          boxShadow: "var(--shadow-lg, 0 24px 60px rgba(0,0,0,0.25))",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "1rem 1.25rem",
            borderBottom: "1px solid var(--border-color, rgba(0,0,0,0.08))",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600, color: "var(--text-primary)" }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              padding: "0.25rem",
              display: "inline-flex",
            }}
          >
            <X size={18} />
          </button>
        </header>
        <div style={{ padding: "1.25rem", overflow: "auto", flex: 1, color: "var(--text-primary)" }}>{children}</div>
        {footer && (
          <footer
            style={{
              padding: "0.85rem 1.25rem",
              borderTop: "1px solid var(--border-color, rgba(0,0,0,0.08))",
              display: "flex",
              gap: "0.6rem",
              justifyContent: "flex-end",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── Create-customer modal ──────────────────────────────────────────
function PatientCreateModal({ locations, onClose, onCreated, editPatient = null }) {
  const notify = useNotifyFromModal();
  const isEdit = !!editPatient;
  const INDIAN_MOBILE_RE = /^(\+91)?[6-9]\d{9}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const toE164OnBlur = (raw) => {
    if (!raw) return raw;
    const cleaned = String(raw).replace(/[\s\-()]/g, "");
    if (cleaned.startsWith("+91") && /^\+91[6-9]\d{9}$/.test(cleaned)) return cleaned;
    if (/^91[6-9]\d{9}$/.test(cleaned)) return "+" + cleaned;
    if (/^[6-9]\d{9}$/.test(cleaned)) return "+91" + cleaned;
    return raw;
  };

  // Date fields come back from the API as ISO strings; <input type="date">
  // needs YYYY-MM-DD. Strip the time half.
  const toDateInput = (val) => {
    if (!val) return "";
    if (typeof val === "string") return val.slice(0, 10);
    try { return new Date(val).toISOString().slice(0, 10); } catch { return ""; }
  };

  const [form, setForm] = useState(() => editPatient ? {
    name: editPatient.name || "",
    phone: editPatient.phone || "",
    email: editPatient.email || "",
    gender: editPatient.gender || "",
    taxType: editPatient.taxType || "",
    source: editPatient.source || "walk-in",
    instagramHandle: editPatient.instagramHandle || "",
    dob: toDateInput(editPatient.dob),
    anniversary: toDateInput(editPatient.anniversary),
    notes: editPatient.notes || "",
    locationId: editPatient.locationId || locations[0]?.id || "",
  } : {
    name: "",
    phone: "",
    email: "",
    gender: "",
    taxType: "",
    source: "walk-in",
    instagramHandle: "",
    dob: "",
    anniversary: "",
    notes: "",
    locationId: locations[0]?.id || "",
  });
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const trimmedName = (form.name || "").trim();
    if (trimmedName.length < 1) { notify.error("Full name is required"); return; }
    const phoneClean = (form.phone || "").trim().replace(/[\s\-()]/g, "");
    if (!phoneClean) { notify.error("Phone is required"); return; }
    if (!INDIAN_MOBILE_RE.test(phoneClean)) {
      notify.error("Enter a valid Indian mobile (10 digits, starting 6-9; +91 optional).");
      return;
    }
    const emailRaw = (form.email || "").trim();
    if (emailRaw && !EMAIL_RE.test(emailRaw)) {
      notify.error("Enter a valid email address (e.g. customer@example.com).");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        name: trimmedName,
        phone: form.phone,
        email: emailRaw || null,
        gender: form.gender || null,
        taxType: form.taxType || null,
        source: form.source || null,
        instagramHandle: form.instagramHandle ? form.instagramHandle.trim().replace(/^@/, "") : null,
        dob: form.dob || null,
        anniversary: form.anniversary || null,
        notes: form.notes || null,
        locationId: form.locationId ? parseInt(form.locationId) : null,
      };
      if (isEdit) {
        await fetchApi(`/api/wellness/patients/${editPatient.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        notify.success(`Customer "${trimmedName}" updated`);
      } else {
        await fetchApi("/api/wellness/patients", { method: "POST", body: JSON.stringify(payload) });
        notify.success(`Customer "${trimmedName}" added`);
      }
      onCreated();
    } catch (_err) { /* toast fired by fetchApi */ }
    finally { setSubmitting(false); }
  };

  return (
    <ModalShell
      title={isEdit ? "Edit customer" : "Create customer"}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button type="button" onClick={onClose} style={iconBtnSmall}>Cancel</button>
          <button
            type="submit"
            form="patient-create-form"
            disabled={submitting}
            style={{ ...primaryTealBtn, padding: "0.55rem 1.25rem", opacity: submitting ? 0.6 : 1 }}
          >
            {submitting
              ? (isEdit ? "Saving…" : "Adding…")
              : (isEdit ? "Save changes" : "Add customer")}
          </button>
        </>
      }
    >
      <form id="patient-create-form" onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <FormField label="Phone number" required icon={<Phone size={14} />}>
          <input
            type="tel"
            inputMode="tel"
            required
            value={form.phone}
            placeholder="+91 9876543210"
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            onBlur={(e) => setForm({ ...form, phone: toE164OnBlur(e.target.value) })}
            style={modalInputStyle}
          />
        </FormField>
        <FormField label="Full name" required icon={<UserPlus size={14} />}>
          <input
            required
            value={form.name}
            placeholder="John Doe"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={modalInputStyle}
          />
        </FormField>
        <FormField label="Gender">
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {[
              { value: "M", label: "Male" },
              { value: "F", label: "Female" },
              { value: "Other", label: "Other" },
            ].map((g) => (
              <button
                key={g.value}
                type="button"
                onClick={() => setForm({ ...form, gender: g.value })}
                aria-pressed={form.gender === g.value}
                style={{
                  flex: "1 1 90px",
                  padding: "0.7rem 0.5rem",
                  borderRadius: 10,
                  border: `1px solid ${form.gender === g.value ? "var(--primary-color, var(--accent-color))" : "var(--border-color, rgba(0,0,0,0.12))"}`,
                  background: form.gender === g.value ? "var(--primary-color, var(--accent-color))" : "var(--subtle-bg, rgba(0,0,0,0.02))",
                  color: form.gender === g.value ? "#fff" : "var(--text-primary)",
                  cursor: "pointer",
                  fontWeight: 500,
                  fontSize: "0.9rem",
                }}
              >
                {g.label}
              </button>
            ))}
          </div>
        </FormField>
        <FormField label="Email" icon={<MailIcon size={14} />}>
          <input
            type="email"
            value={form.email}
            placeholder="customer@example.com"
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            style={modalInputStyle}
          />
        </FormField>
        <FormField label="Tax type">
          <div style={{ display: "flex", gap: "1rem", paddingTop: 4 }}>
            {[
              { value: "individual", label: "Individual" },
              { value: "business", label: "Business" },
            ].map((t) => (
              <label key={t.value} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", fontSize: "0.9rem" }}>
                <input
                  type="radio"
                  name="taxType"
                  value={t.value}
                  checked={form.taxType === t.value}
                  onChange={() => setForm({ ...form, taxType: t.value })}
                />
                {t.label}
              </label>
            ))}
          </div>
        </FormField>
        <FormField label="Instagram handle" icon={<AtSign size={14} />}>
          <input
            value={form.instagramHandle}
            placeholder="@yourhandle"
            onChange={(e) => setForm({ ...form, instagramHandle: e.target.value })}
            style={modalInputStyle}
          />
        </FormField>
        <FormField label="Lead source" icon={<Globe size={14} />}>
          <select
            value={form.source}
            onChange={(e) => setForm({ ...form, source: e.target.value })}
            style={modalInputStyle}
          >
            <option value="walk-in">Walk-in</option>
            <option value="referral">Referral</option>
            <option value="website-form">Website form</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="instagram">Instagram</option>
            <option value="meta-ad">Meta ad</option>
            <option value="google-ad">Google ad</option>
            <option value="indiamart">IndiaMART</option>
          </select>
        </FormField>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: "1rem" }}>
          <FormField label="Date of birth" icon={<CalendarIcon size={14} />}>
            <input
              type="date"
              value={form.dob}
              onChange={(e) => setForm({ ...form, dob: e.target.value })}
              style={modalInputStyle}
            />
          </FormField>
          <FormField label="Date of anniversary" icon={<CalendarIcon size={14} />}>
            <input
              type="date"
              value={form.anniversary}
              onChange={(e) => setForm({ ...form, anniversary: e.target.value })}
              style={modalInputStyle}
            />
          </FormField>
        </div>
        {locations.length > 1 && (
          <FormField label="Clinic">
            <select
              value={form.locationId}
              onChange={(e) => setForm({ ...form, locationId: e.target.value })}
              style={modalInputStyle}
            >
              <option value="">Select clinic</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </FormField>
        )}
        <FormField label="Notes" icon={<FileText size={14} />}>
          <textarea
            value={form.notes}
            placeholder="Add any context, allergies, preferences…"
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            style={{ ...modalInputStyle, minHeight: 80, resize: "vertical", fontFamily: "inherit" }}
          />
        </FormField>
      </form>
    </ModalShell>
  );
}

// Small helper that re-exposes useNotify inside the modal components
// (they're top-level here, so they need their own hook call).
function useNotifyFromModal() {
  return useNotify();
}

function FormField({ label, required, icon, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", color: "var(--text-secondary)", fontWeight: 500 }}>
        {required && <span style={{ color: "#e57373" }}>*</span>}
        {icon}
        {label}
      </span>
      {children}
    </label>
  );
}

const modalInputStyle = {
  width: "100%",
  padding: "0.6rem 0.8rem",
  // Theme-adaptive: surface-color is white in light wellness, dark-teal-tint
  // in dark wellness. Border picks the same adaptive token. The wellness
  // theme also has an `[data-vertical="wellness"] input { ... !important }`
  // rule that wins anyway, but we keep the inline values sane for both
  // themes + generic vertical.
  background: "var(--surface-color, #fff)",
  border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
  borderRadius: 8,
  color: "var(--text-primary)",
  fontSize: "0.92rem",
  outline: "none",
  boxSizing: "border-box",
};

// ── Bulk-customer-tagging modal ─────────────────────────────────────
// Two-pane: paginated customer list (50/page) + tag multi-select. Bottom
// actions: Remove Tags / Add Tags. Selection persists across pages.
function BulkTagModal({ allTags, onClose, onTagsChanged, onTagCreated }) {
  const notify = useNotifyFromModal();
  const PAGE = 50;
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedPatients, setSelectedPatients] = useState(() => new Set());
  const [selectedTags, setSelectedTags] = useState(() => new Set());
  const [acting, setActing] = useState(false);
  const [showTagPicker, setShowTagPicker] = useState(false);
  // Bumped after a successful bulk op so the modal's own row list
  // refetches (the chip strip on each row reflects current state).
  const [reloadTick, setReloadTick] = useState(0);
  const tagPickerRef = useRef(null);

  // Debounce search input.
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedQ(q.trim()); setPage(1); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  // Fetch customers page.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    params.set("limit", String(PAGE));
    params.set("offset", String((page - 1) * PAGE));
    setLoading(true);
    fetchApi(`/api/wellness/patients?${params.toString()}`)
      .then((d) => {
        if (cancelled) return;
        setRows(d.patients || []);
        setTotal(d.total || 0);
      })
      .catch(() => { if (!cancelled) { setRows([]); setTotal(0); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [page, debouncedQ, reloadTick]);

  // Close tag picker on outside click.
  useEffect(() => {
    if (!showTagPicker) return undefined;
    const onDoc = (e) => {
      if (tagPickerRef.current && !tagPickerRef.current.contains(e.target)) setShowTagPicker(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showTagPicker]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE));
  const pageIds = rows.map((r) => r.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedPatients.has(id));
  const someOnPageSelected = pageIds.some((id) => selectedPatients.has(id));
  const togglePageAll = () => {
    setSelectedPatients((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });
  };
  const togglePatient = (id) => {
    setSelectedPatients((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleTag = (tagId) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  };

  const performBulk = async (op) => {
    const patientIds = Array.from(selectedPatients);
    const tagIds = Array.from(selectedTags);
    if (!patientIds.length) { notify.error("Select at least one customer"); return; }
    if (!tagIds.length) { notify.error("Select at least one tag"); return; }
    setActing(true);
    try {
      if (op === "add") {
        const res = await fetchApi(`/api/wellness/patients/tags/bulk`, {
          method: "POST",
          body: JSON.stringify({ patientIds, tagIds }),
        });
        notify.success(`Added tag(s) — ${res?.assigned ?? 0} new link(s)`);
      } else {
        // fetchApi short-circuits every DELETE response to `true` (see
        // api.js:200) so the JSON body with the `removed` count gets
        // discarded. Use raw fetch here so we can show the real number
        // AND surface a precise failure if the request 4xx/5xxs.
        const token = getAuthToken();
        const resp = await fetch(`/api/wellness/patients/tags/bulk`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ patientIds, tagIds }),
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          notify.error(body?.error || `Remove failed (${resp.status})`);
          return;
        }
        notify.success(`Removed tag(s) — ${body?.removed ?? 0} link(s)`);
      }
      onTagsChanged();
      // Clear the tag selection (the action's done) and refetch the
      // modal's row list so each customer's chip strip reflects the
      // new state — pre-fix the user had to close + reopen to see
      // tags actually disappear after a remove.
      setSelectedTags(new Set());
      setReloadTick((t) => t + 1);
    } catch (_err) { /* toasted */ }
    finally { setActing(false); }
  };

  const selectedTagObjects = allTags.filter((t) => selectedTags.has(t.id));

  return (
    <ModalShell
      title="Bulk customer tagging"
      onClose={onClose}
      width={920}
      footer={
        <>
          <span style={{ marginRight: "auto", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            {selectedPatients.size} customer(s) · {selectedTags.size} tag(s) selected
          </span>
          <button type="button" onClick={onClose} style={iconBtnSmall}>Cancel</button>
          <button
            type="button"
            onClick={() => performBulk("remove")}
            disabled={acting || !selectedPatients.size || !selectedTags.size}
            style={{
              ...bulkBtnStyle,
              opacity: acting || !selectedPatients.size || !selectedTags.size ? 0.5 : 1,
              border: "1px solid #e57373",
              color: "#e57373",
            }}
          >
            <Trash2 size={14} /> Remove tags
          </button>
          <button
            type="button"
            onClick={() => performBulk("add")}
            disabled={acting || !selectedPatients.size || !selectedTags.size}
            style={{
              ...primaryTealBtn,
              padding: "0.5rem 1.25rem",
              opacity: acting || !selectedPatients.size || !selectedTags.size ? 0.6 : 1,
            }}
          >
            <Plus size={14} /> Add tags
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0, color: "var(--text-secondary)", fontSize: "0.88rem" }}>
        Select multiple customers and tags, then add or remove tags in bulk. Selection
        persists as you page through the list.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "1.25rem", alignItems: "start" }}>
        {/* ── Customers pane ──────────────────────────────── */}
        <div>
          <div style={{ ...filterLabelStyle, marginBottom: "0.5rem" }}>Customers</div>
          {/* Icon-inside-input search bar (same pattern as the main page).
              No wrapper border — wellness's input rule supplies the
              border + bg + focus glow, so we don't double-shell. */}
          <div style={{ position: "relative", marginBottom: "0.6rem" }}>
            <Search
              size={14}
              color="var(--text-secondary)"
              style={{
                position: "absolute",
                left: 12,
                top: "50%",
                transform: "translateY(-50%)",
                pointerEvents: "none",
              }}
              aria-hidden
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or phone…"
              style={{
                width: "100%",
                padding: "0.5rem 0.75rem 0.5rem 2.1rem",
                borderRadius: 10,
                fontSize: "0.9rem",
                fontFamily: "inherit",
                background: "var(--surface-color, #fff)",
                border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
                color: "var(--text-primary)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.3rem 0", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              checked={allOnPageSelected}
              ref={(el) => { if (el) el.indeterminate = !allOnPageSelected && someOnPageSelected; }}
              onChange={togglePageAll}
            />
            Select all on page
          </label>
          <div
            style={{
              maxHeight: 360,
              overflowY: "auto",
              border: "1px solid var(--border-color, rgba(0,0,0,0.08))",
              borderRadius: 10,
              background: "var(--subtle-bg, rgba(0,0,0,0.02))",
            }}
          >
            {loading && (
              <div style={{ padding: "1rem", color: "var(--text-secondary)", fontSize: "0.85rem" }}>Loading…</div>
            )}
            {!loading && rows.length === 0 && (
              <div style={{ padding: "1rem", color: "var(--text-secondary)", fontSize: "0.85rem" }}>No customers match.</div>
            )}
            {!loading && rows.map((p) => {
              const checked = selectedPatients.has(p.id);
              return (
                <div
                  key={p.id}
                  // Using <div> rather than <label> because we have
                  // interactive chip buttons inside; with a <label>
                  // the browser delegates the label click to the
                  // <input>, double-firing alongside the chip's own
                  // onClick. Manual row-click handler skips the chip
                  // case via the closest("[data-tag-chip]") guard.
                  onClick={(e) => {
                    if (e.target.closest("[data-tag-chip]")) return;
                    togglePatient(p.id);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "0.6rem",
                    padding: "0.5rem 0.7rem",
                    borderBottom: "1px solid var(--border-color, rgba(0,0,0,0.06))",
                    background: checked ? "rgba(38,88,85,0.18)" : "transparent",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => togglePatient(p.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${p.name || "customer"}`}
                    style={{ marginTop: 4 }}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem", minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: "0.9rem", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name || "(unnamed)"}
                    </span>
                    <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>{p.phone || "—"}</span>
                    {Array.isArray(p.tags) && p.tags.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", marginTop: "0.2rem" }}>
                        {p.tags.slice(0, 6).map((t) => {
                          const isTagSelected = selectedTags.has(t.id);
                          return (
                            <button
                              key={t.id}
                              type="button"
                              data-tag-chip="1"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleTag(t.id);
                              }}
                              title={isTagSelected ? `Deselect ${t.name}` : `Select ${t.name}`}
                              style={inRowChipBtnStyle(tagColour(t), isTagSelected)}
                            >
                              {isTagSelected && <span aria-hidden style={{ fontSize: "0.7rem" }}>✓</span>}
                              {t.name}
                            </button>
                          );
                        })}
                        {p.tags.length > 6 && (
                          <span style={overflowChipStyle}>+{p.tags.length - 6}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {/* Pagination */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "0.6rem", gap: "0.5rem", flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-secondary)", fontSize: "0.78rem" }}>
              {total === 0 ? "0 of 0" : `${(page - 1) * PAGE + 1}–${Math.min(page * PAGE, total)} of ${total.toLocaleString()}`}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                style={paginationBtn(page <= 1)}
                aria-label="Previous page"
              >
                <ChevronLeft size={14} />
              </button>
              <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                {page} / {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                style={paginationBtn(page >= totalPages)}
                aria-label="Next page"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </div>

        {/* ── Tags pane ──────────────────────────────────── */}
        <div>
          <div style={{ ...filterLabelStyle, marginBottom: "0.5rem" }}>Tags</div>
          <div ref={tagPickerRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setShowTagPicker((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={showTagPicker}
              style={{
                ...modalInputStyle,
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                cursor: "pointer",
                textAlign: "left",
                minHeight: 44,
              }}
            >
              <span style={{ flex: 1, color: selectedTags.size ? "var(--text-primary)" : "var(--text-secondary)" }}>
                {selectedTags.size ? `${selectedTags.size} tag(s) selected` : "Select tags…"}
              </span>
              <ChevronDown size={14} />
            </button>
            {showTagPicker && (
              <TagPickerPopover
                allTags={allTags}
                onPick={(tag) => toggleTag(tag.id)}
                onCreated={(tag) => { if (onTagCreated) onTagCreated(tag); toggleTag(tag.id); }}
                onCreate={async (name) => {
                  try {
                    const res = await fetchApi("/api/wellness/patients/tags", {
                      method: "POST",
                      body: JSON.stringify({ name }),
                    });
                    if (res?.tag) {
                      if (onTagCreated) onTagCreated(res.tag);
                      toggleTag(res.tag.id);
                    }
                  } catch (_err) { /* toasted */ }
                }}
                onClose={() => setShowTagPicker(false)}
                showCreate
                title="Pick tags"
              />
            )}
          </div>

          {selectedTagObjects.length > 0 && (
            <div style={{ marginTop: "0.75rem", display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
              {selectedTagObjects.map((t) => (
                <span key={t.id} style={tagChipStyle(tagColour(t))}>
                  {t.name}
                  <button
                    type="button"
                    onClick={() => toggleTag(t.id)}
                    aria-label={`Remove ${t.name} from selection`}
                    style={chipRemoveStyle}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <p style={{ marginTop: "1rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
            Tip: choose multiple tags and apply them in one shot. &ldquo;Remove tags&rdquo; only affects
            customers that currently have the selected tags.
          </p>
        </div>
      </div>
    </ModalShell>
  );
}
