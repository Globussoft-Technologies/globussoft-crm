import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Search,
  Plus,
  Users,
  Phone,
  Mail,
  Pencil,
  X,
  ChevronDown,
  Tag as TagIcon,
  Filter,
  Trash2,
  Download,
  UserPlus,
  Tags as BulkTagIcon,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { SEARCH_DEBOUNCE_MS } from "../../utils/timing";
import { formatDate } from "../../utils/date";
import CsvImportExportToolbar from "../../components/wellness/CsvImportExportToolbar";
import PageHeader from "../../components/PageHeader";

import PatientPager from "./patients/PatientPager";
import TagPickerPopover from "./patients/TagPickerPopover";
import FilterModal from "./patients/FilterModal";
import PatientCreateModal from "./patients/PatientCreateModal";
import BulkTagModal from "./patients/BulkTagModal";

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

  // Tracks the in-flight row id for the delete button so we can disable +
  // visually mute that single row's trash icon while the DELETE
  // round-trips, without locking the rest of the table.
  const [deletingId, setDeletingId] = useState(null);
  // Soft-delete a single patient via DELETE /api/wellness/patients/:id.
  // ADMIN-only on the backend (others get a 403 toast); we still show the
  // button to everyone because role isn't surfaced into this page and a
  // 403 toast is acceptable feedback. The endpoint returns 409 if the
  // patient is already soft-deleted, which we surface verbatim.
  const deletePatient = async (patient) => {
    const ok = await notify.confirm(
      `Delete customer "${patient.name}"? Their visits and history will be hidden but kept for audit.`
    );
    if (!ok) return;
    setDeletingId(patient.id);
    try {
      await fetchApi(`/api/wellness/patients/${patient.id}`, { method: 'DELETE' });
      notify.success(`Customer "${patient.name}" deleted`);
      // Drop the deleted row from the current selection set so bulk
      // actions can't target an id that no longer exists in the list.
      setSelected((prev) => {
        if (!prev.has(patient.id)) return prev;
        const next = new Set(prev);
        next.delete(patient.id);
        return next;
      });
      setReloadTick((t) => t + 1);
    } catch (e) {
      notify.error(e?.data?.error || e?.message || 'Failed to delete customer');
    } finally {
      setDeletingId(null);
    }
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
      <PageHeader
        icon={Users}
        title="Patients"
        count={total}
        description={total === 1 ? "patient on record" : "patients on record"}
      >
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
      </PageHeader>

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
                {/* Fixed px width — 6% was too narrow on a typical viewport
                    (~65px), truncating the "ACTIONS" header to "ACTIO..." and
                    clipping the Edit/Delete icons. The clipped icon fragments
                    rendered as visual "..." after the icons. overflow:visible
                    + textOverflow:clip prevents the .stable-table CSS rule
                    (which sets overflow:hidden + text-overflow:ellipsis on
                    every td) from reintroducing the artifact. */}
                <th style={{ ...thStyle, width: 110, textAlign: "center", overflow: "visible", textOverflow: "clip" }}>Actions</th>
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
                  <td style={{ ...tdStyle, textAlign: "center", overflow: "visible", textOverflow: "clip" }}>
                    <div style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center" }}>
                      <button
                        onClick={() => startEdit(p)}
                        title="Edit patient"
                        aria-label={`Edit ${p.name}`}
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
                      <button
                        onClick={() => deletePatient(p)}
                        disabled={deletingId === p.id}
                        title="Delete patient"
                        aria-label={`Delete ${p.name}`}
                        data-testid={`patient-delete-${p.id}`}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--danger-color, #ef4444)",
                          cursor: deletingId === p.id ? "not-allowed" : "pointer",
                          opacity: deletingId === p.id ? 0.5 : 1,
                          padding: "0.25rem",
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
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
