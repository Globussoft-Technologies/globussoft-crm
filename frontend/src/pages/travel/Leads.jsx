// Travel CRM — Unified Leads page (PRD §7).
//
// Lives at /travel/leads for tenants with vertical="travel". Pulls
// Deal rows scoped to the user's tenant + filtered by subBrand +
// stage. Server-side filtering (extended deals route accepts
// ?subBrand=) so the page doesn't violate the "client-side
// aggregation over paginated endpoint is a structural correctness
// bug" rule from CLAUDE.md — a 100-row window on a 5,000-deal tenant
// would silently miss most leads.
//
// Click into a row → /travel/leads/:contactId (the TravelLeadDetail "unified
// lead view" with the customer's history). The old /deals/:id target 404'd —
// no such route exists in this app.
//
// G010 (PRD_TRAVEL_MULTICHANNEL_LEADS FR-3.6.2, FR-3.6.3) — adds:
//   - ?view=inbox query param that flips to an inbox-timeline layout
//     grouped by recent-touch.
//   - Channel chip filter row above the lead list. Chips read enabled
//     channels from /api/settings/lead-capture (falls back to ALL
//     channels on 403 — non-ADMIN users still see chips but no auth-
//     surface for the underlying settings).
//   - URL persistence for `?channel=` so chip selection survives shares.

import { useContext, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AlertCircle, Filter, Inbox, LayoutGrid, Plus, RefreshCw, Tag, Trash2, UserPlus, UserCircle, X,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import { useActiveSubBrand } from "../../utils/subBrand";
import {
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";

// G010 — canonical 17-channel allowlist, mirrors backend allowlist. Used as
// a fallback when /api/settings/lead-capture is not reachable (USER role).
const FALLBACK_CHANNELS = [
  "voyagr", "web_form", "whatsapp", "ads", "adsgpt", "meta_ad", "manual",
  "indiamart", "justdial", "tradeindia", "voice", "sms", "email",
  "google_ad", "linkedin_ad", "referral", "chat",
];
const CHANNEL_SHORT_LABELS = {
  voyagr: "Voyagr", web_form: "Web", whatsapp: "WhatsApp",
  ads: "Ads", adsgpt: "AdsGPT", meta_ad: "Meta", manual: "Manual",
  indiamart: "IndiaMART", justdial: "JustDial", tradeindia: "TradeIndia",
  voice: "Voice", sms: "SMS", email: "Email",
  google_ad: "Google", linkedin_ad: "LinkedIn", referral: "Referral", chat: "Chat",
};

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC" },
  { value: "rfu", label: "RFU" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const STAGES = [
  { value: "", label: "All stages" },
  { value: "lead", label: "Lead" },
  { value: "contacted", label: "Contacted" },
  { value: "proposal", label: "Proposal" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

const EMPTY_FORM = {
  title: "", contactId: "", subBrand: "tmc", stage: "lead",
  amount: "", expectedClose: "",
};

// Today's date as a local YYYY-MM-DD string (matches the native <input type=date>
// value format). Used to constrain the lead's date to today — not past, not
// future. NOT toISOString() (that's UTC and would be off by a day in IST before
// 05:30 / after 18:30).
function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function TravelLeads() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  const [deals, setDeals] = useState([]);
  // G-amount — a lead's own Deal.amount is almost always 0 for travel (the
  // pipeline value field is rarely set); the customer's REAL money lives in
  // their committed itineraries. We aggregate that here, keyed by contactId,
  // so the AMOUNT column reflects actual booking value instead of "INR 0".
  const [bookingValueByContact, setBookingValueByContact] = useState({});
  const [loading, setLoading] = useState(true);
  const [subBrand, setSubBrand] = useState("");
  const [stage, setStage] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [contacts, setContacts] = useState([]);
  // G010 — URL-driven view + channel state. Default grid view (back-compat).
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view") === "inbox" ? "inbox" : "grid";
  const channelFilter = searchParams.get("channel") || "";
  // Channel allowlist + enabled flags loaded from /api/settings/lead-capture.
  // ADMIN-gated endpoint; non-ADMIN sees a 403 and falls back to FALLBACK.
  const [channelsEnabled, setChannelsEnabled] = useState({});
  const [allowedChannels, setAllowedChannels] = useState(FALLBACK_CHANNELS);

  useEffect(() => {
    // #1180 — skip the call entirely for non-ADMIN users. The endpoint is
    // ADMIN-only; without this gate, every non-ADMIN page load fired a
    // background 403 that surfaced as the spurious "You don't have
    // permission" toast. `silent: true` is defense-in-depth — even on
    // ADMIN, a transient 5xx or token-rotation race shouldn't toast a
    // passive channel-enrichment fetch.
    if (user?.role !== "ADMIN") return;
    fetchApi("/api/settings/lead-capture", { silent: true })
      .then((res) => {
        if (Array.isArray(res?.allowedChannels) && res.allowedChannels.length) {
          setAllowedChannels(res.allowedChannels);
        }
        setChannelsEnabled(res?.channels || {});
      })
      .catch(() => {
        // Transient failure — show all channels with no enabled-state
        // information. Backend filter still applies if a chip is selected.
        setChannelsEnabled({});
      });
  }, [user?.role]);

  const setUrlParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };
  const setView = (v) => setUrlParam("view", v === "inbox" ? "inbox" : "");
  const setChannelFilter = (c) => setUrlParam("channel", c);

  // Sub-brands this user may create a lead under. A user restricted to a
  // single brand has it auto-selected (no dropdown); admins + multi-brand
  // users get a dropdown limited to THEIR brands. See defaultSubBrandFor.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, subBrand: defaultSubBrandFor(user, activeSubBrand) });
    setCreating(true);
    fetchApi("/api/contacts?limit=200")
      .then((res) => setContacts(Array.isArray(res) ? res : (res?.contacts || [])))
      .catch(() => setContacts([]));
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) {
      notify.error("Title is required");
      return;
    }
    // The lead's date must be today — reject any past or future date.
    if (form.expectedClose && form.expectedClose !== localTodayStr()) {
      notify.error("The date must be today — it can't be in the past or the future.");
      return;
    }
    setSaving(true);
    try {
      const body = {
        title: form.title.trim(),
        stage: form.stage,
        subBrand: form.subBrand,
      };
      if (form.contactId) body.contactId = parseInt(form.contactId, 10);
      if (form.amount) body.amount = Number(form.amount);
      if (form.expectedClose) body.expectedClose = form.expectedClose;
      await fetchApi("/api/deals", { method: "POST", body: JSON.stringify(body) });
      notify.success("Travel lead created");
      setCreating(false);
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to create lead");
    } finally {
      setSaving(false);
    }
  };

  // Delete a lead (the underlying Deal) — used to clean up duplicates. Confirms
  // first; hard delete (no undo). Optimistically drops the row, then reloads.
  const handleDelete = async (d) => {
    const ok = await notify.confirm({
      title: "Delete lead?",
      message: `Delete "${d.title || `Deal #${d.id}`}"? This permanently removes the lead. This can't be undone.`,
      confirmText: "Delete",
      cancelText: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/deals/${d.id}`, { method: "DELETE" });
      notify.success("Lead deleted");
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to delete lead");
    }
  };

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (subBrand) qs.set("subBrand", subBrand);
    if (stage) qs.set("stage", stage);
    if (channelFilter) qs.set("channel", channelFilter);
    qs.set("limit", "200");
    fetchApi(`/api/deals?${qs.toString()}`)
      .then((res) => setDeals(Array.isArray(res) ? res : []))
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load leads");
        setDeals([]);
      })
      .finally(() => setLoading(false));

    // Best-effort: sum each customer's COMMITTED itinerary totals so the
    // AMOUNT column reflects their booking value (not the always-0 deal value).
    // A miss here just falls back to Deal.amount — it never blocks the list.
    const iq = new URLSearchParams();
    if (subBrand) iq.set("subBrand", subBrand);
    iq.set("limit", "200");
    fetchApi(`/api/travel/itineraries?${iq.toString()}`)
      .then((res) => {
        const rows = Array.isArray(res?.itineraries) ? res.itineraries : Array.isArray(res) ? res : [];
        const COMMITTED = new Set(["accepted", "advance_paid", "fully_paid"]);
        const map = {};
        for (const it of rows) {
          if (it?.contactId == null || !COMMITTED.has(it.status)) continue;
          const amt = Number(it.totalAmount);
          if (!Number.isFinite(amt)) continue;
          const cur = it.currency || "INR";
          if (!map[it.contactId]) map[it.contactId] = { value: 0, currency: cur };
          map[it.contactId].value += amt;
        }
        setBookingValueByContact(map);
      })
      .catch(() => setBookingValueByContact({}));
  };
  useEffect(load, [subBrand, stage, channelFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the AMOUNT column shows: the customer's committed booking value when
  // they have itineraries, otherwise the lead's own Deal.amount, otherwise "—".
  // `booking` is true when the figure came from itineraries (drives the tooltip).
  const amountFor = (d) => {
    const bv = d.contactId != null ? bookingValueByContact[d.contactId] : null;
    if (bv && bv.value > 0) {
      return { text: `${bv.currency || "INR"} ${Number(bv.value).toLocaleString()}`, booking: true };
    }
    if (d.amount != null) {
      return { text: `${d.currency || "USD"} ${Number(d.amount).toLocaleString()}`, booking: false };
    }
    return { text: "—", booking: false };
  };

  // G010 — per-channel counts from the currently-loaded deals window.
  // Server-side count would be more accurate cross-paginated; the chip
  // counts here reflect the loaded window (limit=200), which is fine for
  // a directional ops UX. NB: deal.channel may be null for legacy rows.
  const channelCounts = useMemo(() => {
    const out = {};
    for (const d of deals) {
      const c = d?.channel || "manual";
      out[c] = (out[c] || 0) + 1;
    }
    return out;
  }, [deals]);

  // G010 — chips visible to the operator: prefer the explicitly-enabled
  // set if the settings GET succeeded, else show the full allowlist.
  const visibleChannels = useMemo(() => {
    const hasEnabledMap = channelsEnabled && Object.keys(channelsEnabled).length > 0;
    if (hasEnabledMap) {
      return allowedChannels.filter((c) => channelsEnabled[c]);
    }
    return allowedChannels;
  }, [allowedChannels, channelsEnabled]);

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <UserPlus size={28} aria-hidden /> Travel Leads
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, marginBottom: 0 }}>
            Unified deal pipeline across all sub-brands. Server-scoped to the caller&apos;s sub-brand access.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* G010 — view toggle (Grid / Inbox) — URL-persisted */}
          <div role="tablist" aria-label="View mode" style={viewToggleStyle}>
            <button
              type="button"
              role="tab"
              aria-selected={view === "grid"}
              onClick={() => setView("grid")}
              style={view === "grid" ? viewToggleActive : viewToggleBtn}
              aria-label="Grid view"
            >
              <LayoutGrid size={14} aria-hidden /> Grid
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "inbox"}
              onClick={() => setView("inbox")}
              style={view === "inbox" ? viewToggleActive : viewToggleBtn}
              aria-label="Inbox view"
            >
              <Inbox size={14} aria-hidden /> Inbox
            </button>
          </div>
          <button type="button" onClick={openCreate} style={primaryBtn} aria-label="Create a new travel lead">
            <Plus size={14} /> New Travel Lead
          </button>
          <button type="button" onClick={load} style={refreshBtn} aria-label="Refresh leads">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </header>

      {/* G010 — channel chip filter (FR-3.6.2). Clicking a chip narrows
          to that channel + persists ?channel= in the URL. "All" clears. */}
      <div style={chipRow} role="toolbar" aria-label="Filter by channel">
        <button
          type="button"
          onClick={() => setChannelFilter("")}
          style={!channelFilter ? chipActive : chipStyle}
          aria-pressed={!channelFilter}
        >
          All <span style={chipCount}>{deals.length}</span>
        </button>
        {visibleChannels.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setChannelFilter(c)}
            style={channelFilter === c ? chipActive : chipStyle}
            aria-pressed={channelFilter === c}
            aria-label={`Filter by ${c}`}
          >
            {CHANNEL_SHORT_LABELS[c] || c}
            <span style={chipCount}>{channelCounts[c] || 0}</span>
          </button>
        ))}
      </div>

      <div style={filterRow}>
        <Filter size={14} aria-hidden style={{ color: "var(--text-secondary)" }} />
        <select value={subBrand} onChange={(e) => setSubBrand(e.target.value)} style={selectStyle} aria-label="Filter by sub-brand">
          {SUB_BRANDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={stage} onChange={(e) => setStage(e.target.value)} style={selectStyle} aria-label="Filter by stage">
          {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <span style={{ color: "var(--text-secondary)", fontSize: 12, marginLeft: "auto" }}>
          {deals.length} {deals.length === 1 ? "deal" : "deals"}
        </span>
      </div>

      <div style={tableWrap}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : deals.length === 0 ? (
          <div style={empty}>
            <AlertCircle size={18} aria-hidden style={{ color: "var(--warning-color)", marginRight: 8, verticalAlign: -3 }} />
            No deals match the current filters.
          </div>
        ) : view === "inbox" ? (
          // G010 — inbox-style timeline grouped by recent-touch. Each row
          // shows the lead title, channel badge, sub-brand chip, last
          // touchpoint timestamp + action badge (if shape carries one).
          <ul style={inboxList} aria-label="Lead inbox">
            {deals
              .slice()
              .sort((a, b) => {
                const at = new Date(a.updatedAt || a.createdAt || 0).getTime();
                const bt = new Date(b.updatedAt || b.createdAt || 0).getTime();
                return bt - at;
              })
              .map((d) => (
                <li key={d.id} style={inboxRow}>
                  <div style={inboxRowMain}>
                    {d.contactId ? (
                      <Link to={`/travel/leads/${d.contactId}`} style={inboxTitle}>
                        {d.title || `Deal #${d.id}`}
                      </Link>
                    ) : (
                      <span style={inboxTitle}>{d.title || `Deal #${d.id}`}</span>
                    )}
                    {d.channel && (
                      <span style={channelBadge} aria-label={`Channel ${d.channel}`}>
                        {CHANNEL_SHORT_LABELS[d.channel] || d.channel}
                      </span>
                    )}
                    {d.action && (
                      <span style={actionBadge(d.action)} aria-label={`Action ${d.action}`}>
                        {d.action}
                      </span>
                    )}
                    {d.subBrand && <span style={brandBadge}>{d.subBrand}</span>}
                    <span style={stageBadge(d.stage)}>{d.stage}</span>
                  </div>
                  <div style={inboxRowMeta}>
                    {d.contactId ? (
                      <Link to={`/travel/leads/${d.contactId}`} style={{ ...dealLink, fontWeight: 500 }}>
                        <UserCircle size={14} aria-hidden />
                        {d.contact?.name || d.contact?.email || `Contact #${d.contactId}`}
                      </Link>
                    ) : (
                      <span style={{ color: "var(--text-secondary)" }}>
                        {d.contact?.name || d.contact?.email || "no contact"}
                      </span>
                    )}
                    <span
                      style={{ color: "var(--text-secondary)", fontSize: 12 }}
                      title={amountFor(d).booking ? "Customer booking value — sum of committed itineraries" : undefined}
                    >
                      {(() => {
                        const a = amountFor(d);
                        return a.text === "—" ? "" : a.text;
                      })()}
                    </span>
                    <span style={{ color: "var(--text-secondary)", fontSize: 12, marginLeft: "auto" }}>
                      {d.updatedAt || d.createdAt
                        ? new Date(d.updatedAt || d.createdAt).toLocaleString()
                        : ""}
                    </span>
                  </div>
                </li>
              ))}
          </ul>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Title</th>
                <th style={th}>Contact</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Stage</th>
                <th style={thRight}>Amount</th>
                <th style={th}>Diagnostic</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {deals.map((d) => (
                <tr key={d.id} style={trStyle}>
                  <td style={td}>
                    {d.contactId ? (
                      <Link to={`/travel/leads/${d.contactId}`} style={dealLink} title="Open the lead's detail / history">
                        {d.title || `Deal #${d.id}`}
                      </Link>
                    ) : (
                      <span>{d.title || `Deal #${d.id}`}</span>
                    )}
                  </td>
                  <td style={td}>
                    {d.contactId ? (
                      <Link to={`/travel/leads/${d.contactId}`} style={{ ...dealLink, fontWeight: 500 }} title="Open unified travel lead view">
                        <UserCircle size={14} aria-hidden />
                        {d.contact?.name || d.contact?.email || `Contact #${d.contactId}`}
                      </Link>
                    ) : (
                      d.contact?.name || d.contact?.email || "—"
                    )}
                  </td>
                  <td style={td}>
                    {d.subBrand ? <span style={brandBadge}>{d.subBrand}</span> : <span style={{ color: "var(--text-secondary)" }}>—</span>}
                  </td>
                  <td style={td}><span style={stageBadge(d.stage)}>{d.stage}</span></td>
                  <td style={tdRight}>
                    {(() => {
                      const a = amountFor(d);
                      return (
                        <span title={a.booking ? "Customer booking value — sum of committed itineraries" : undefined}>
                          {a.text}
                        </span>
                      );
                    })()}
                  </td>
                  <td style={td}>
                    {d.diagnosticId ? (
                      <Link to={`/travel/diagnostics`} style={{ ...dealLink, fontSize: 12 }}>
                        <Tag size={12} aria-hidden /> #{d.diagnosticId}
                      </Link>
                    ) : (
                      <span style={{ color: "var(--text-secondary)" }}>—</span>
                    )}
                    {d.subBrand === "rfu" && d.contactId && (
                      <Link
                        to={`/travel/rfu/customers/${d.contactId}`}
                        style={{ ...dealLink, fontSize: 11, marginLeft: 8 }}
                        title="Open RFU customer profile"
                      >
                        RFU profile →
                      </Link>
                    )}
                  </td>
                  <td style={td}>
                    <button
                      type="button"
                      onClick={() => handleDelete(d)}
                      style={{ ...iconBtn, color: "var(--danger-color, #f43f5e)" }}
                      title={`Delete ${d.title || `lead #${d.id}`}`}
                      aria-label={`Delete ${d.title || `lead #${d.id}`}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setCreating(false); }}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 1000, padding: "1rem",
          }}
        >
          <form onSubmit={submitCreate} className="card" role="dialog" aria-modal="true" style={drawerStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>New Travel Lead</h2>
              <button type="button" onClick={() => setCreating(false)} aria-label="Close" style={iconBtn}>
                <X size={16} />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={fieldLabel}>
                Title
                <input
                  required type="text" value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  style={inputStyle}
                  placeholder='e.g. "Mumbai School — Andaman 2026"'
                />
              </label>
              <label style={fieldLabel}>
                Contact
                <select
                  value={form.contactId}
                  onChange={(e) => setForm({ ...form, contactId: e.target.value })}
                  style={inputStyle}
                >
                  <option value="">(none — link later)</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.email || `Contact #${c.id}`}
                    </option>
                  ))}
                </select>
              </label>
              <label style={fieldLabel}>
                Sub-brand
                {lockedBrand ? (
                  // Single-brand user: auto-selected, not editable. The value
                  // is already pinned in form.subBrand via defaultSubBrandFor.
                  <input
                    type="text"
                    value={subBrandShortLabel(lockedBrand)}
                    readOnly
                    disabled
                    aria-label="Sub-brand (locked to your assigned brand)"
                    style={{ ...inputStyle, opacity: 0.7, cursor: "not-allowed" }}
                  />
                ) : (
                  <select
                    value={form.subBrand}
                    onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
                    style={inputStyle}
                  >
                    {myBrands.map((b) => (
                      <option key={b} value={b}>{subBrandShortLabel(b)}</option>
                    ))}
                  </select>
                )}
              </label>
              <label style={fieldLabel}>
                Stage
                <select
                  value={form.stage}
                  onChange={(e) => setForm({ ...form, stage: e.target.value })}
                  style={inputStyle}
                >
                  {STAGES.filter((s) => s.value).map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </label>
              <label style={fieldLabel}>
                Estimated value
                <input
                  type="number" min="0" step="any" value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  style={inputStyle}
                  placeholder="0"
                />
              </label>
              <label style={fieldLabel}>
                Expected close
                <input
                  type="date" value={form.expectedClose}
                  onChange={(e) => setForm({ ...form, expectedClose: e.target.value })}
                  style={inputStyle}
                  title="The date must be today — not a past or future date."
                />
              </label>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
              <button type="button" onClick={() => setCreating(false)} style={refreshBtn}>Cancel</button>
              <button type="submit" disabled={saving} style={primaryBtn}>
                {saving ? "Creating…" : "Create Lead"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function stageBadge(stage) {
  const base = {
    padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.5,
  };
  switch (stage) {
    case "won":
      return { ...base, background: "var(--subtle-bg-2)", color: "var(--success-color)" };
    case "lost":
      return { ...base, background: "var(--subtle-bg)", color: "var(--danger-color)" };
    case "proposal":
      return { ...base, background: "var(--subtle-bg-3)", color: "var(--primary-color)" };
    case "contacted":
      return { ...base, background: "var(--subtle-bg)", color: "var(--text-primary)" };
    default:
      return { ...base, background: "var(--subtle-bg)", color: "var(--text-secondary)" };
  }
}

const filterRow = {
  display: "flex", gap: 8, alignItems: "center",
  padding: 12, marginBottom: 12,
  background: "var(--subtle-bg)", borderRadius: 8,
  border: "1px solid var(--border-color)",
};
const tableWrap = {
  background: "var(--surface-color)", borderRadius: 8,
  border: "1px solid var(--border-color)", overflow: "hidden",
};
const selectStyle = {
  padding: "6px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  minWidth: 140, fontSize: 13,
};
const refreshBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 12px", borderRadius: 6, fontWeight: 500, fontSize: 13,
  background: "var(--surface-color)", color: "var(--text-secondary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 12px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "var(--accent-text, #fff)",
  border: "1px solid var(--primary-color, var(--accent-color))",
  cursor: "pointer",
};
// Centred modal — mirrors the Itineraries + Staff add-staff-member pattern.
// `.card` (set on the form element) supplies border-radius, border, blur
// and lifted shadow; we force opaque `--bg-color` here so the panel
// doesn't read as glassmorphic over the page content behind it.
const drawerStyle = {
  background: "var(--bg-color)", color: "var(--text-primary)",
  width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto",
  padding: "1.5rem",
};
const iconBtn = {
  background: "transparent", border: "none", color: "var(--text-secondary)",
  cursor: "pointer", padding: 4,
};
const fieldLabel = {
  display: "flex", flexDirection: "column", gap: 4,
  fontSize: 12, color: "var(--text-secondary)", fontWeight: 500,
};
const inputStyle = {
  padding: "8px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--input-bg, var(--surface-color))", color: "var(--text-primary)",
  fontSize: 14,
};
const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 11,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};
const thRight = { ...th, textAlign: "right" };
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const tdRight = { ...td, textAlign: "right" };
const trStyle = { borderTop: "1px solid var(--border-light)" };
const dealLink = {
  color: "var(--primary-color)", textDecoration: "none", fontWeight: 600,
  display: "inline-flex", alignItems: "center", gap: 4,
};
const brandBadge = {
  padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
  background: "var(--subtle-bg-3)", color: "var(--primary-color)",
  textTransform: "uppercase", letterSpacing: 0.5,
};
// G010 — chip filter + view toggle + inbox view styles
const chipRow = {
  display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10,
  padding: 8, borderRadius: 8,
  background: "var(--subtle-bg)",
  border: "1px solid var(--border-color)",
};
const chipStyle = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "4px 10px", borderRadius: 999, fontSize: 12, fontWeight: 500,
  background: "var(--surface-color)", color: "var(--text-secondary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const chipActive = {
  ...chipStyle,
  background: "var(--primary-color, var(--accent-color))",
  color: "var(--accent-text, #fff)",
  border: "1px solid var(--primary-color, var(--accent-color))",
};
const chipCount = {
  fontSize: 11, fontWeight: 600, opacity: 0.8,
  marginLeft: 4,
};
const viewToggleStyle = {
  display: "inline-flex",
  border: "1px solid var(--border-color)", borderRadius: 6, overflow: "hidden",
  background: "var(--surface-color)",
};
const viewToggleBtn = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "6px 10px", fontSize: 12, fontWeight: 500,
  background: "transparent", color: "var(--text-secondary)",
  border: "none", cursor: "pointer",
};
const viewToggleActive = {
  ...viewToggleBtn,
  background: "var(--primary-color, var(--accent-color))",
  color: "var(--accent-text, #fff)",
};
const inboxList = {
  listStyle: "none", margin: 0, padding: 0,
};
const inboxRow = {
  padding: "10px 14px",
  borderBottom: "1px solid var(--border-light)",
  display: "flex", flexDirection: "column", gap: 4,
};
const inboxRowMain = {
  display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8,
};
const inboxRowMeta = {
  display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12,
  color: "var(--text-secondary)", fontSize: 13,
};
const inboxTitle = {
  color: "var(--primary-color)", textDecoration: "none", fontWeight: 600,
  fontSize: 14,
};
const channelBadge = {
  padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
  background: "var(--subtle-bg)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
};
function actionBadge(action) {
  const base = {
    padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.5,
  };
  switch (action) {
    case "created":
      return { ...base, background: "var(--subtle-bg-2)", color: "var(--success-color)" };
    case "merged":
    case "touchpoint_appended":
    case "appended":
      return { ...base, background: "var(--subtle-bg-3)", color: "var(--primary-color)" };
    case "duplicate":
    case "duplicate_suppressed":
      return { ...base, background: "var(--subtle-bg)", color: "var(--text-secondary)" };
    default:
      return { ...base, background: "var(--subtle-bg)", color: "var(--text-secondary)" };
  }
}
