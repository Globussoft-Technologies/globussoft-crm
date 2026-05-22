// Travel CRM — Itinerary detail page.
//
// Mounts at /travel/itineraries/:id. Three sections:
//   1. Header bar — destination + status + sub-brand badge + admin/manager
//      action cluster (accept/reject/regen/share/PDF).
//   2. Draft summary — LLM-generated prose from
//      POST /api/travel/itineraries/:id/draft/regen (PRD §4.3 + §9.1).
//      Persisted on Itinerary.draftSummary; surfaced here so the third
//      LLM-router consumer becomes user-visible.
//   3. Items table — flight / hotel / transfer / activity / visa /
//      insurance rows with edit + delete (admin/manager). "Add item"
//      inline form.

import { useEffect, useState, useContext } from "react";
import { useParams } from "react-router-dom";
import {
  Map as MapIcon, Plane, Hotel, MapPin, Briefcase, FileText, Shield,
  Plus, Pencil, Trash2, X, Sparkles, Share2, Download, Check, XCircle, Copy,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";

const ITEM_TYPES = ["flight", "hotel", "transfer", "activity", "visa", "insurance"];

const ITEM_ICONS = {
  flight: Plane,
  hotel: Hotel,
  transfer: MapPin,
  activity: Briefcase,
  visa: FileText,
  insurance: Shield,
};

const STATUS_COLORS = {
  draft: { bg: "rgba(120,120,120,0.12)", color: "#5C6E82" },
  sent: { bg: "rgba(47,122,77,0.14)", color: "#2F7A4D" },
  revised: { bg: "rgba(200,154,78,0.16)", color: "#9A6F2E" },
  accepted: { bg: "rgba(38,88,85,0.16)", color: "#265855" },
  rejected: { bg: "rgba(168,50,63,0.14)", color: "#A8323F" },
  advance_paid: { bg: "rgba(200,154,78,0.22)", color: "#7A5419" },
  fully_paid: { bg: "rgba(38,88,85,0.22)", color: "#1F4644" },
};

const TIER_COLORS = {
  entry: { bg: "rgba(120,120,120,0.12)", color: "#5C6E82" },
  primary: { bg: "rgba(18,38,71,0.14)", color: "#122647" },
  premium: { bg: "rgba(200,154,78,0.22)", color: "#7A5419" },
};

const EMPTY_ITEM = {
  itemType: "flight",
  description: "",
  unitCost: "",
  markup: "",
  gstAmount: "",
  totalPrice: "",
  position: "",
  detailsJson: "",
  supplierId: "",
};

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

function fmtMoney(amt, currency = "INR") {
  if (amt == null || amt === "") return "—";
  const n = Number(amt);
  if (!Number.isFinite(n)) return "—";
  if (currency === "INR" && n >= 100000) {
    return `₹${(n / 100000).toFixed(2)}L`;
  }
  return `${currency === "INR" ? "₹" : currency + " "}${n.toLocaleString()}`;
}

function TierBadge({ tier }) {
  if (!tier) return <span style={{ color: "var(--text-secondary)" }}>—</span>;
  const tc = TIER_COLORS[tier] || { bg: "var(--subtle-bg)", color: "var(--text-secondary)" };
  return (
    <span style={{
      background: tc.bg, color: tc.color,
      padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: 0.5,
    }}>
      {tier}
    </span>
  );
}

function StatusBadge({ status }) {
  const sc = STATUS_COLORS[status] || { bg: "var(--subtle-bg)", color: "var(--text-secondary)" };
  return (
    <span style={{
      background: sc.bg, color: sc.color,
      padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: 0.5,
    }}>
      {status}
    </span>
  );
}

export default function ItineraryDetail() {
  const { id } = useParams();
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";
  const isManager = user?.role === "MANAGER";
  const canEdit = isAdmin || isManager;

  const [itin, setItin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [regenStub, setRegenStub] = useState(null); // { model, stub } from last regen
  const [shareUrl, setShareUrl] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newItem, setNewItem] = useState(EMPTY_ITEM);
  const [editing, setEditing] = useState(null);

  const load = () => {
    setLoading(true);
    fetchApi(`/api/travel/itineraries/${id}`)
      .then((res) => setItin(res))
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load itinerary");
        setItin(null);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const accept = async () => {
    if (!confirm("Mark this itinerary as accepted? This also fans out WebCheckin rows for every flight item.")) return;
    try {
      await fetchApi(`/api/travel/itineraries/${id}/accept`, { method: "POST", body: JSON.stringify({}) });
      notify.success("Itinerary accepted");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to accept itinerary");
    }
  };

  const reject = async () => {
    const reason = prompt("Reason for rejection? (optional, logged for audit):", "");
    if (reason === null) return; // user cancelled prompt
    try {
      await fetchApi(`/api/travel/itineraries/${id}/reject`, {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      });
      notify.success("Itinerary rejected");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to reject itinerary");
    }
  };

  const regenDraft = async () => {
    try {
      const res = await fetchApi(`/api/travel/itineraries/${id}/draft/regen`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setRegenStub({ model: res?.model, stub: Boolean(res?.stub) });
      notify.success("Draft regenerated");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to regenerate draft");
    }
  };

  const generateShare = async () => {
    try {
      const res = await fetchApi(`/api/travel/itineraries/${id}/share`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setShareUrl(res?.shareUrl || null);
      notify.success("Share link generated");
    } catch (e) {
      notify.error(e?.body?.error || "Failed to generate share link");
    }
  };

  const copyShare = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      notify.success("Copied to clipboard");
    } catch {
      notify.error("Copy failed — select + Ctrl+C the URL");
    }
  };

  const addItem = async () => {
    if (!newItem.itemType || !newItem.description.trim()) {
      notify.error("itemType + description required");
      return;
    }
    try {
      const body = {
        itemType: newItem.itemType,
        description: newItem.description,
      };
      if (newItem.position !== "") body.position = Number(newItem.position);
      if (newItem.detailsJson !== "") body.detailsJson = newItem.detailsJson;
      if (newItem.supplierId !== "") body.supplierId = Number(newItem.supplierId);
      if (newItem.unitCost !== "") body.unitCost = Number(newItem.unitCost);
      if (newItem.markup !== "") body.markup = Number(newItem.markup);
      if (newItem.gstAmount !== "") body.gstAmount = Number(newItem.gstAmount);
      if (newItem.totalPrice !== "") body.totalPrice = Number(newItem.totalPrice);
      await fetchApi(`/api/travel/itineraries/${id}/items`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify.success("Item added");
      setNewItem(EMPTY_ITEM);
      setAdding(false);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to add item");
    }
  };

  const saveItem = async () => {
    if (!editing) return;
    if (!editing.itemType || !editing.description?.trim()) {
      notify.error("itemType + description required");
      return;
    }
    try {
      const body = {
        itemType: editing.itemType,
        description: editing.description,
      };
      if (editing.position !== "" && editing.position != null) body.position = Number(editing.position);
      if (editing.detailsJson !== "" && editing.detailsJson != null) body.detailsJson = editing.detailsJson;
      if (editing.supplierId !== "" && editing.supplierId != null) body.supplierId = Number(editing.supplierId);
      if (editing.unitCost !== "" && editing.unitCost != null) body.unitCost = Number(editing.unitCost);
      if (editing.markup !== "" && editing.markup != null) body.markup = Number(editing.markup);
      if (editing.gstAmount !== "" && editing.gstAmount != null) body.gstAmount = Number(editing.gstAmount);
      if (editing.totalPrice !== "" && editing.totalPrice != null) body.totalPrice = Number(editing.totalPrice);
      await fetchApi(`/api/travel/itineraries/${id}/items/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      notify.success("Item saved");
      setEditing(null);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save item");
    }
  };

  const deleteItem = async (item) => {
    if (!confirm(`Delete "${item.description}"?`)) return;
    try {
      await fetchApi(`/api/travel/itineraries/${id}/items/${item.id}`, { method: "DELETE" });
      notify.success("Item deleted");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to delete item");
    }
  };

  if (loading) {
    return <div style={{ padding: 24 }}>Loading&hellip;</div>;
  }
  if (!itin) {
    return <div style={{ padding: 24 }}>Itinerary not found.</div>;
  }

  const status = itin.status || "draft";
  const isTerminal = status === "accepted" || status === "rejected";
  // PDF download uses a plain link; back-end accepts cookie OR bearer.
  // For bearer-only sessions, append token via query string would require a
  // server tweak — keep the link simple for now and document inline.
  const token = typeof getAuthToken === "function" ? getAuthToken() : null;
  const pdfHref = `/api/travel/itineraries/${id}/pdf${token ? `?_t=${encodeURIComponent(token)}` : ""}`;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
              <MapIcon size={28} aria-hidden /> {itin.destination || "Itinerary"}
            </h1>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
              <span style={{
                background: "var(--subtle-bg-3, var(--subtle-bg))", color: "var(--primary-color, var(--accent-color))",
                padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: 0.5,
              }}>
                {itin.subBrand}
              </span>
              <StatusBadge status={status} />
              <TierBadge tier={itin.productTier} />
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                {fmtDate(itin.startDate)} → {fmtDate(itin.endDate)}
              </span>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                Total: {fmtMoney(itin.totalAmount, itin.currency)}
              </span>
              {itin.updatedAt && (
                <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                  Updated {new Date(itin.updatedAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {canEdit && !isTerminal && (
              <>
                <button type="button" onClick={accept} style={primaryBtn} aria-label="Accept itinerary">
                  <Check size={14} /> Accept
                </button>
                <button type="button" onClick={reject} style={dangerBtn} aria-label="Reject itinerary">
                  <XCircle size={14} /> Reject
                </button>
              </>
            )}
            {canEdit && (
              <button type="button" onClick={regenDraft} style={secondaryBtn} aria-label="Regenerate draft summary">
                <Sparkles size={14} /> Regenerate draft
              </button>
            )}
            <button type="button" onClick={generateShare} style={secondaryBtn} aria-label="Generate share link">
              <Share2 size={14} /> Share link
            </button>
            <a href={pdfHref} target="_blank" rel="noreferrer" style={{ ...secondaryBtn, textDecoration: "none" }}>
              <Download size={14} /> PDF
            </a>
          </div>
        </div>
        {shareUrl && (
          <div style={{
            marginTop: 12, display: "flex", gap: 8, alignItems: "center",
            background: "var(--surface-color)", padding: 8, borderRadius: 6,
            border: "1px solid var(--border-color)",
          }}>
            <input
              type="text"
              readOnly
              value={shareUrl}
              aria-label="Share URL"
              style={{ ...input, flex: 1, fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
            />
            <button type="button" onClick={copyShare} style={iconBtn} aria-label="Copy share URL">
              <Copy size={16} />
            </button>
          </div>
        )}
      </header>

      <section style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Draft summary</h2>
          {regenStub && (
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              LLM: {regenStub.model || "—"}{regenStub.stub ? " (stub)" : ""}
            </span>
          )}
        </div>
        <div style={{
          background: "var(--surface-color)", padding: 16, borderRadius: 8,
          border: "1px solid var(--border-color)",
          whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5,
          color: itin.draftSummary ? "var(--text-primary)" : "var(--text-secondary)",
        }}>
          {itin.draftSummary || "No draft generated yet. Click Regenerate draft to create one."}
        </div>
      </section>

      <section>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Items</h2>
          {canEdit && !adding && (
            <button type="button" onClick={() => setAdding(true)} style={primaryBtn}>
              <Plus size={14} /> Add item
            </button>
          )}
        </div>

        {adding && (
          <div style={{ background: "var(--surface-color)", padding: 16, borderRadius: 8, border: "1px solid var(--border-color)", marginBottom: 16 }}>
            <ItemFields values={newItem} onChange={(patch) => setNewItem({ ...newItem, ...patch })} />
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button type="button" onClick={addItem} style={primaryBtn}>Save item</button>
              <button type="button" onClick={() => { setNewItem(EMPTY_ITEM); setAdding(false); }} style={secondaryBtn}>Cancel</button>
            </div>
          </div>
        )}

        <div style={{
          background: "var(--surface-color)", borderRadius: 8,
          border: "1px solid var(--border-color)", overflow: "hidden",
        }}>
          {!itin.items || itin.items.length === 0 ? (
            <div style={empty}>No items yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>#</th>
                  <th style={th}>Type</th>
                  <th style={th}>Description</th>
                  <th style={th}>Unit cost</th>
                  <th style={th}>Markup</th>
                  <th style={th}>Total</th>
                  {canEdit && <th style={th} colSpan={2}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {itin.items.map((item) => {
                  const Icon = ITEM_ICONS[item.itemType] || Briefcase;
                  return (
                    <tr key={item.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                      <td style={td}>{item.position}</td>
                      <td style={td}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <Icon size={14} aria-hidden style={{ color: "var(--text-secondary)" }} />
                          {item.itemType}
                        </span>
                      </td>
                      <td style={td}><strong>{item.description}</strong></td>
                      <td style={td}>{fmtMoney(item.unitCost, itin.currency)}</td>
                      <td style={td}>{fmtMoney(item.markup, itin.currency)}</td>
                      <td style={td}>{fmtMoney(item.totalPrice, itin.currency)}</td>
                      {canEdit && (
                        <>
                          <td style={{ ...td, width: 0 }}>
                            <button type="button" onClick={() => setEditing({ ...item })} style={iconBtn} aria-label={`Edit item ${item.description}`}>
                              <Pencil size={16} />
                            </button>
                          </td>
                          <td style={{ ...td, width: 0 }}>
                            <button type="button" onClick={() => deleteItem(item)} style={{ ...iconBtn, color: "var(--danger-color)" }} aria-label={`Delete item ${item.description}`}>
                              <Trash2 size={16} />
                            </button>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {editing && (
        <div
          role="dialog"
          aria-label="Edit item"
          onClick={() => setEditing(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface-color)", padding: 24, borderRadius: 12,
              maxWidth: 720, width: "100%", border: "1px solid var(--border-color)",
              maxHeight: "90vh", overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <strong>Edit item</strong>
              <button type="button" onClick={() => setEditing(null)} style={iconBtn} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <ItemFields values={editing} onChange={(patch) => setEditing({ ...editing, ...patch })} />
            <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setEditing(null)} style={secondaryBtn}>Cancel</button>
              <button type="button" onClick={saveItem} style={primaryBtn}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ItemFields({ values, onChange }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))" }}>
        <label style={fieldLabel}>
          Type
          <select value={values.itemType} onChange={(e) => onChange({ itemType: e.target.value })} style={input}>
            {ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label style={fieldLabel}>
          Position
          <input type="number" value={values.position ?? ""} onChange={(e) => onChange({ position: e.target.value })} style={input} placeholder="auto" />
        </label>
        <label style={fieldLabel}>
          Supplier ID
          <input type="number" value={values.supplierId ?? ""} onChange={(e) => onChange({ supplierId: e.target.value })} style={input} placeholder="—" />
        </label>
      </div>
      <label style={fieldLabel}>
        Description
        <input value={values.description ?? ""} onChange={(e) => onChange({ description: e.target.value })} style={input} placeholder="e.g. IndiGo 6E-237 BLR → MAA" />
      </label>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 140px), 1fr))" }}>
        <label style={fieldLabel}>
          Unit cost
          <input type="number" step="0.01" value={values.unitCost ?? ""} onChange={(e) => onChange({ unitCost: e.target.value })} style={input} />
        </label>
        <label style={fieldLabel}>
          Markup
          <input type="number" step="0.01" value={values.markup ?? ""} onChange={(e) => onChange({ markup: e.target.value })} style={input} />
        </label>
        <label style={fieldLabel}>
          GST amount
          <input type="number" step="0.01" value={values.gstAmount ?? ""} onChange={(e) => onChange({ gstAmount: e.target.value })} style={input} />
        </label>
        <label style={fieldLabel}>
          Total price
          <input type="number" step="0.01" value={values.totalPrice ?? ""} onChange={(e) => onChange({ totalPrice: e.target.value })} style={input} />
        </label>
      </div>
      <label style={fieldLabel}>
        Details JSON (optional, type-specific payload)
        <textarea
          value={values.detailsJson ?? ""}
          onChange={(e) => onChange({ detailsJson: e.target.value })}
          placeholder='e.g. {"pnr":"ABC123","cabin":"economy"}'
          style={{ ...input, minHeight: 80, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}
        />
      </label>
    </div>
  );
}

const input = {
  padding: "8px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)", color: "var(--text-primary)", fontSize: 13,
  width: "100%",
};
const fieldLabel = {
  display: "grid", gap: 4, fontSize: 11,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)",
};
const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 12,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--primary-color, var(--accent-color))", color: "#fff",
  border: "none", cursor: "pointer",
};
const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--surface-color)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const dangerBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--danger-color, #A8323F)", color: "#fff",
  border: "none", cursor: "pointer",
};
const iconBtn = {
  padding: 6, borderRadius: 4,
  background: "transparent", color: "var(--text-secondary)",
  border: "none", cursor: "pointer",
};
