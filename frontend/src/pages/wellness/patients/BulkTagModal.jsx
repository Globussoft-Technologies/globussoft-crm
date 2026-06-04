import { useState, useRef, useEffect } from "react";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Trash2,
  Plus,
  X,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../../utils/api";
import { useNotify } from "../../../utils/notify";
import { SEARCH_DEBOUNCE_MS } from "../../../utils/timing";
import ModalShell from "./ModalShell";
import TagPickerPopover from "./TagPickerPopover";
import {
  filterLabelStyle,
  paginationBtn,
  bulkBtnStyle,
  tagChipStyle,
  inRowChipBtnStyle,
  chipRemoveStyle,
  overflowChipStyle,
  modalInputStyle,
  primaryTealBtn,
  iconBtnSmall,
} from "./styles";
import { tagColour } from "./constants";

// ── Bulk-customer-tagging modal ─────────────────────────────────────
// Two-pane: paginated customer list (50/page) + tag multi-select. Bottom
// actions: Remove Tags / Add Tags. Selection persists across pages.
export default function BulkTagModal({ allTags, onClose, onTagsChanged, onTagCreated }) {
  const notify = useNotify();
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
