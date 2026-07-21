import { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Bookmark, Pencil, Trash2, Save, X, Search } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

// ── SavedViewsBar — Contacts "Saved Views" (generic vertical only) ─────
//
// A named, FIXED list of hand-picked contact IDs — e.g. select 10 contacts
// via the existing search/filter/checkbox UI, click "Save as View", name it
// "Mohit Customers". The view's membership does NOT re-evaluate over time;
// it only changes when someone explicitly edits it. Backed by
// GET/POST/PUT/DELETE /api/contact-views (+ GET /:id/members).
//
// Tenant-shared read: every teammate sees every view in the dropdown, so a
// different salesperson can pick their own view too. Write-restricted:
// only the view's creator (or an ADMIN) sees the Edit/Delete icons on a
// given view — enforced both here (canModify per view) and server-side.
//
// Three entry points render from this one component:
//   1. The dropdown trigger button + popover — always visible, lets any
//      user select "All Contacts" or a saved view to filter the table.
//   2. "Save as View" — only rendered by the PARENT when selectedIds.length
//      > 0 (mirrors the existing bulk-assign bar's show/hide rule), opens a
//      small name-prompt to save the current checkbox selection.
//   3. The Edit modal (pencil icon on any view the user canModify) — a
//      full membership editor: search + per-contact checkboxes + Select
//      All / Deselect All, seeded with the view's current members, plus a
//      rename field. Saves both name + membership in one PUT.
//
// Props:
//   activeViewId, onSelectView(viewId | null)  — parent owns which view is
//     active so it can filter its own contacts list; null = "All Contacts".
//   selectedIds — the parent's current bulk-select checkbox array (Contacts.jsx's
//     `selectedContacts`), used as the membership when "Save as View" is used.
//   allContacts — the parent's full (unfiltered-by-view) contact list, e.g.
//     Contacts.jsx's `contacts` state — powers the Edit modal's checkbox
//     picker so a view can be edited independent of whatever's currently
//     selected/filtered in the main table.
//   onViewsChanged() — called after create/edit/delete so the parent can
//     react if needed (e.g. clear an active view that was just deleted).
export default function SavedViewsBar({ activeViewId, onSelectView, selectedIds, allContacts, onViewsChanged }) {
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [popoverPos, setPopoverPos] = useState(null);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [editModalView, setEditModalView] = useState(null); // the view object being edited, or null
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchApi("/api/contact-views");
      setViews(Array.isArray(data) ? data : []);
    } catch (_err) {
      setViews([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const computePos = () => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.bottom + 6,
      width: Math.max(260, rect.width),
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

  const activeView = views.find((v) => v.id === activeViewId) || null;

  const handleSelectView = (viewId) => {
    onSelectView?.(viewId);
    setOpen(false);
  };

  const handleSaveAsView = async () => {
    const trimmed = saveName.trim();
    if (!trimmed) { notify.error("Please enter a name for this view"); return; }
    setSaving(true);
    try {
      const created = await fetchApi("/api/contact-views", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, contactIds: selectedIds }),
      });
      notify.success(`Saved "${created.name}" (${created.memberCount} contact${created.memberCount !== 1 ? "s" : ""})`);
      setSavePromptOpen(false);
      setSaveName("");
      await load();
      onViewsChanged?.();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to save view");
    } finally {
      setSaving(false);
    }
  };

  const openEditModal = async (view) => {
    setOpen(false);
    try {
      const data = await fetchApi(`/api/contact-views/${view.id}/members`);
      setEditModalView({ ...view, memberIds: Array.isArray(data.contactIds) ? data.contactIds : [] });
    } catch (_err) {
      notify.error("Failed to load this view's contacts");
    }
  };

  const handleDelete = async (view) => {
    const ok = await notify.confirm({
      title: "Delete this view?",
      message: `"${view.name}" will be removed for everyone in your team. The contacts themselves are not affected.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/contact-views/${view.id}`, { method: "DELETE" });
      if (activeViewId === view.id) onSelectView?.(null);
      await load();
      onViewsChanged?.();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to delete view");
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
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
        <Bookmark size={15} />
        {activeView ? activeView.name : "All Contacts"}
        <ChevronDown size={14} />
      </button>

      {selectedIds.length > 0 && (
        <button
          type="button"
          onClick={() => { setSavePromptOpen(true); setSaveName(""); }}
          className="btn-secondary"
          style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", fontSize: "0.8rem", padding: "0.45rem 0.75rem" }}
          title="Save the currently-selected contacts as a named view"
        >
          <Save size={14} /> Save as View
        </button>
      )}

      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Saved views"
          style={{
            position: "fixed",
            ...popoverPos,
            zIndex: 1100,
            background: "var(--bg-color, #fff)",
            border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
            borderRadius: 10,
            boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          <button
            type="button"
            onClick={() => handleSelectView(null)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.6rem 0.85rem",
              fontSize: "0.88rem",
              fontWeight: activeViewId == null ? 600 : 400,
              background: activeViewId == null ? "var(--surface-hover, rgba(255,255,255,0.06))" : "transparent",
              border: "none",
              borderBottom: "1px solid var(--border-color)",
              color: "var(--text-primary)",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            All Contacts
          </button>

          {views.length === 0 && (
            <div style={{ padding: "0.75rem 0.85rem", fontSize: "0.82rem", color: "var(--text-secondary)" }}>
              No saved views yet. Select some contacts below, then &ldquo;Save as View.&rdquo;
            </div>
          )}

          {views.map((view) => (
            <div
              key={view.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                padding: "0.4rem 0.5rem 0.4rem 0.85rem",
                borderBottom: "1px solid var(--border-color)",
                background: activeViewId === view.id ? "var(--surface-hover, rgba(255,255,255,0.06))" : "transparent",
              }}
            >
              <button
                type="button"
                onClick={() => handleSelectView(view.id)}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  background: "none",
                  border: "none",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  textAlign: "left",
                  padding: "0.2rem 0",
                  fontWeight: activeViewId === view.id ? 600 : 400,
                }}
              >
                <span style={{ fontSize: "0.88rem" }}>{view.name}</span>
                <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>
                  {view.memberCount} contact{view.memberCount !== 1 ? "s" : ""} · by {view.createdByName}
                </span>
              </button>
              {view.canModify && (
                <>
                  <button type="button" onClick={() => openEditModal(view)} title="Edit view (rename, add/remove contacts)" style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", padding: "0.25rem" }}>
                    <Pencil size={14} />
                  </button>
                  <button type="button" onClick={() => handleDelete(view)} title="Delete" style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", padding: "0.25rem" }}>
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}

      {savePromptOpen && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "var(--overlay-bg)", backdropFilter: "blur(5px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1200 }}>
          <div className="card" style={{ padding: "1.5rem", width: "380px" }}>
            <h3 style={{ marginBottom: "0.25rem", fontSize: "1.05rem", fontWeight: "bold" }}>Save as View</h3>
            <p style={{ marginBottom: "1rem", fontSize: "0.82rem", color: "var(--text-secondary)" }}>
              {selectedIds.length} contact{selectedIds.length !== 1 ? "s" : ""} selected will be saved under this name. Anyone on your team can select it later.
            </p>
            <input
              autoFocus
              className="input-field"
              placeholder="e.g. Mohit Customers"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveAsView(); }}
              style={{ marginBottom: "1rem" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
              <button type="button" onClick={() => setSavePromptOpen(false)} style={{ background: "transparent", color: "var(--text-secondary)", border: "none", cursor: "pointer" }}>
                Cancel
              </button>
              <button type="button" onClick={handleSaveAsView} disabled={saving} className="btn-primary">
                {saving ? "Saving…" : "Save View"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editModalView && (
        <EditViewModal
          view={editModalView}
          allContacts={allContacts || []}
          onClose={() => setEditModalView(null)}
          onSaved={async () => {
            setEditModalView(null);
            await load();
            onViewsChanged?.();
          }}
        />
      )}
    </div>
  );
}

// ── EditViewModal — full membership editor ─────────────────────────────
// Seeded with the view's current member IDs. Search narrows the checkbox
// list; Select All / Deselect All operate on the CURRENTLY-FILTERED rows
// (matches standard "select all" semantics elsewhere in this app — e.g.
// the main table's header checkbox only selects what's currently visible),
// not the tenant's entire contact list. Saves name + membership together
// in one PUT.
function EditViewModal({ view, allContacts, onClose, onSaved }) {
  const notify = useNotify();
  const [name, setName] = useState(view.name);
  const [search, setSearch] = useState("");
  const [memberIds, setMemberIds] = useState(new Set(view.memberIds));
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return allContacts;
    return allContacts.filter((c) =>
      (c.name || "").toLowerCase().includes(term) ||
      (c.email || "").toLowerCase().includes(term) ||
      (c.company || "").toLowerCase().includes(term)
    );
  }, [allContacts, search]);

  const toggleOne = (id) => {
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => memberIds.has(c.id));

  const handleSelectAll = () => {
    setMemberIds((prev) => {
      const next = new Set(prev);
      filtered.forEach((c) => next.add(c.id));
      return next;
    });
  };

  const handleDeselectAll = () => {
    setMemberIds((prev) => {
      const next = new Set(prev);
      filtered.forEach((c) => next.delete(c.id));
      return next;
    });
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { notify.error("Please enter a name for this view"); return; }
    if (memberIds.size === 0) { notify.error("A view must contain at least one contact"); return; }
    setSaving(true);
    try {
      const body = { contactIds: [...memberIds] };
      if (trimmed !== view.name) body.name = trimmed;
      await fetchApi(`/api/contact-views/${view.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      notify.success(`Updated "${trimmed}"`);
      onSaved?.();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to update view");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "var(--overlay-bg)", backdropFilter: "blur(5px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1200 }}>
      <div className="card" style={{ padding: "1.5rem", width: "520px", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ fontSize: "1.1rem", fontWeight: "bold" }}>Edit View</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}>
            <X size={20} />
          </button>
        </div>

        <label style={{ fontSize: "0.78rem", color: "var(--text-secondary)", marginBottom: "0.3rem", display: "block" }}>View name</label>
        <input
          className="input-field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ marginBottom: "1rem" }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
          <div style={{ position: "relative", flex: 1 }}>
            <Search size={14} style={{ position: "absolute", left: "0.6rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-secondary)" }} />
            <input
              className="input-field"
              placeholder="Search contacts to add or remove…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ padding: "0.4rem 0.6rem 0.4rem 1.9rem", fontSize: "0.85rem" }}
            />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
          <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
            {memberIds.size} contact{memberIds.size !== 1 ? "s" : ""} in this view
          </span>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" onClick={handleSelectAll} disabled={allFilteredSelected} className="btn-secondary" style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}>
              Select All{search.trim() ? " (filtered)" : ""}
            </button>
            <button type="button" onClick={handleDeselectAll} className="btn-secondary" style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}>
              Deselect All{search.trim() ? " (filtered)" : ""}
            </button>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", border: "1px solid var(--border-color)", borderRadius: 8 }}>
          {filtered.length === 0 && (
            <div style={{ padding: "1rem", fontSize: "0.85rem", color: "var(--text-secondary)", textAlign: "center" }}>
              No contacts match &ldquo;{search}&rdquo;.
            </div>
          )}
          {filtered.map((c) => (
            <label
              key={c.id}
              style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border-color)", fontSize: "0.85rem", cursor: "pointer" }}
            >
              <input type="checkbox" checked={memberIds.has(c.id)} onChange={() => toggleOne(c.id)} />
              <span style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontWeight: 500 }}>{c.name}</span>
                <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{c.email || c.company || ""}</span>
              </span>
            </label>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1rem" }}>
          <button type="button" onClick={onClose} style={{ background: "transparent", color: "var(--text-secondary)", border: "none", cursor: "pointer" }}>
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className="btn-primary">
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
