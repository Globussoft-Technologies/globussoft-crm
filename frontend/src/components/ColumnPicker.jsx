import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, Search } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

// ── ColumnPicker — "Customize table" column-visibility popover ─────
//
// Generic-vertical-only feature (Settings > Lead Fields' sibling — this is
// the "which columns show" picker, Freshsales-style). Backed by
// GET/PUT /api/table-column-prefs/:tableKey. Personal per-user preference
// — every user picks their own layout, nothing here is admin-gated.
//
// Structurally mirrors MultiSelectDropdown.jsx's portal + fixed-position +
// outside-click pattern, but with its own Apply/Reset footer (rather than
// live-apply-on-toggle) so a user can freely check/uncheck several columns
// before committing — matches the reference screenshot's "Apply" button.
//
// tableKey: "leads" | "contacts". onColumnsChange(visibleKeys: string[])
// fires after a successful save, so the parent table re-renders with the
// new column set immediately (no extra round-trip — the parent already
// has availableColumns cached from the initial GET this component does).
export default function ColumnPicker({ tableKey, onColumnsChange }) {
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [available, setAvailable] = useState([]); // [{key, label}]
  const [draftVisible, setDraftVisible] = useState([]); // working set while the popover is open
  const [popoverPos, setPopoverPos] = useState(null);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const loadedOnce = useRef(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchApi(`/api/table-column-prefs/${tableKey}`);
      setAvailable(Array.isArray(data.availableColumns) ? data.availableColumns : []);
      setDraftVisible(Array.isArray(data.visible) ? data.visible : []);
      onColumnsChange?.(Array.isArray(data.visible) ? data.visible : []);
      loadedOnce.current = true;
    } catch (_err) {
      // Best-effort — a failed load just means the table falls back to
      // whatever the parent's default column set is; not worth a toast for
      // a preference-loading hiccup.
    } finally {
      setLoading(false);
    }
  };

  // Load once on mount so the parent table gets the saved column set
  // immediately, even before the user ever opens the picker.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey]);

  const computePos = () => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    const vpH = window.innerHeight;
    const spaceBelow = vpH - rect.bottom - 12;
    return {
      right: window.innerWidth - rect.right,
      top: rect.bottom + 6,
      width: 320,
      maxHeight: Math.max(200, Math.min(spaceBelow, 420)),
    };
  };

  useEffect(() => {
    if (!open) return undefined;
    setPopoverPos(computePos());
    const recompute = () => setPopoverPos(computePos());
    const onDoc = (e) => {
      const insideWrap = wrapRef.current && wrapRef.current.contains(e.target);
      const insidePopover = popoverRef.current && popoverRef.current.contains(e.target);
      if (!insideWrap && !insidePopover) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [open]);

  const toggleColumn = (key) => {
    setDraftVisible((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const handleApply = async () => {
    setSaving(true);
    try {
      const data = await fetchApi(`/api/table-column-prefs/${tableKey}`, {
        method: "PUT",
        body: JSON.stringify({ visible: draftVisible }),
      });
      const saved = Array.isArray(data.visible) ? data.visible : draftVisible;
      setDraftVisible(saved);
      onColumnsChange?.(saved);
      setOpen(false);
    } catch (err) {
      notify.error(err?.message || "Failed to save column preferences");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    // Reset to "every builtin column visible" — matches the backend's own
    // no-saved-row default, computed client-side here from `available`
    // (no separate endpoint needed; this list doesn't include custom-field
    // keys, matching the backend default).
    setDraftVisible(available.filter((c) => !c.key.startsWith("cf_")).map((c) => c.key));
  };

  const filtered = search.trim()
    ? available.filter((c) => c.label.toLowerCase().includes(search.trim().toLowerCase()))
    : available;

  const shown = filtered.filter((c) => draftVisible.includes(c.key));
  const hidden = filtered.filter((c) => !draftVisible.includes(c.key));

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn-secondary"
        disabled={loading}
        aria-haspopup="true"
        aria-expanded={open}
        style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}
      >
        <SlidersHorizontal size={15} /> Customize table
      </button>
      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Customize table columns"
          style={{
            position: "fixed",
            ...popoverPos,
            zIndex: 1100,
            background: "var(--bg-color, #fff)",
            border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
            borderRadius: 10,
            boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ padding: "0.6rem 0.75rem", borderBottom: "1px solid var(--border-color)" }}>
            <div style={{ position: "relative" }}>
              <Search size={14} style={{ position: "absolute", left: "0.6rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-secondary)" }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search fields"
                aria-label="Search columns"
                className="input-field"
                style={{ padding: "0.4rem 0.6rem 0.4rem 1.9rem", fontSize: "0.85rem" }}
              />
            </div>
          </div>
          <div style={{ overflowY: "auto", flex: 1, minHeight: 0, padding: "0.5rem 0" }}>
            {shown.length > 0 && (
              <>
                <div style={{ padding: "0.3rem 0.75rem", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Shown in table
                </div>
                {shown.map((c) => {
                  const isLocked = c.key === "name";
                  return (
                    <label
                      key={c.key}
                      style={{ display: "flex", alignItems: "center", gap: "0.55rem", padding: "0.4rem 0.75rem", fontSize: "0.88rem", cursor: isLocked ? "default" : "pointer", opacity: isLocked ? 0.7 : 1 }}
                    >
                      <input type="checkbox" checked disabled={isLocked} onChange={() => toggleColumn(c.key)} />
                      {c.label}
                    </label>
                  );
                })}
              </>
            )}
            {hidden.length > 0 && (
              <>
                <div style={{ padding: "0.6rem 0.75rem 0.3rem", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Fields not shown in table
                </div>
                {hidden.map((c) => (
                  <label
                    key={c.key}
                    style={{ display: "flex", alignItems: "center", gap: "0.55rem", padding: "0.4rem 0.75rem", fontSize: "0.88rem", cursor: "pointer" }}
                  >
                    <input type="checkbox" checked={false} onChange={() => toggleColumn(c.key)} />
                    {c.label}
                  </label>
                ))}
              </>
            )}
            {filtered.length === 0 && (
              <div style={{ padding: "0.75rem", fontSize: "0.85rem", color: "var(--text-secondary)" }}>No matching fields.</div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", padding: "0.6rem 0.75rem", borderTop: "1px solid var(--border-color)" }}>
            <button type="button" onClick={handleReset} disabled={saving} className="btn-secondary" style={{ fontSize: "0.8rem", padding: "0.4rem 0.8rem" }}>
              Reset
            </button>
            <button type="button" onClick={handleApply} disabled={saving} className="btn-primary" style={{ fontSize: "0.8rem", padding: "0.4rem 0.8rem" }}>
              {saving ? "Saving…" : "Apply"}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
