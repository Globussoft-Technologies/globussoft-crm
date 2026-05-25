// Travel CRM — Quote Builder (operator-facing single-quote-detail page).
//
// Mounts at /travel/quotes/builder/:id?  (id optional)
//   - no :id     → "new quote" mode, empty draft
//   - :id        → "edit quote" mode, hydrates from GET /api/travel/quotes/:id
//
// Distinct from QuotesAdmin (/travel/quotes-admin) — that page is the CRUD
// list; THIS page is the line-items builder a sales op uses to compose a
// single quote with multiple lines + supplier/pricing-rule context +
// header-action surface (save / send / duplicate / download PDF).
//
// PRD: docs/PRD_TRAVEL_QUOTE_BUILDER.md §3 functional requirements (Arc 2
// #900 slice 2). Backend slice 1 (Agent A) lands new endpoints same tick:
//   POST   /api/travel/quotes/:id/duplicate    → 201 cloned quote
//   GET    /api/travel/quotes/:id/pdf          → PDF stream
// Cascade tolerance: the buttons gracefully degrade on 404 if Agent A's
// commit hasn't merged yet at the time this page loads on demo.
//
// Backend contracts already live (commit b02c091, QuotesAdmin shipped):
//   GET    /api/travel/quotes/:id          → 200 { id, contactId, status,
//                                            totalAmount, currency, ... }
//                                          | 404 NOT_FOUND
//   POST   /api/travel/quotes              → 201 created
//   PUT    /api/travel/quotes/:id          → 200 updated
//
// RBAC: ADMIN/MANAGER write (same as QuotesAdmin). USER role sees the
// RoleGuard locked-panel (#768 canonical denial). The route in App.jsx
// wraps the page in RoleGuard allow={["ADMIN","MANAGER"]} so USER never
// reaches the page body.
//
// Initial slice scope (intentionally limited — additive to QuotesAdmin):
//   - Header (quote # + status badge + contact-id picker)
//   - Line-items table with add/inline-edit/remove rows
//   - Totals panel (subtotal / discount / tax / grand total)
//   - Action cluster (Save Draft, Send, Duplicate, Download PDF)
//
// Future slices (NOT in this commit):
//   - Supplier-picker per line (Agent A backend contract pending)
//   - Pricing-rules preview pane (per-rule discount surface)
//   - PDF preview iframe
//   - Send-to-customer email composition

import { useEffect, useState, useContext } from "react";
import { useParams } from "react-router-dom";
import { Calculator, Plus, Trash2, Save, Send, Copy, Download } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";

const STATUS_BG = {
  Draft: "rgba(148, 163, 184, 0.18)",
  Sent: "rgba(59, 130, 246, 0.18)",
  Accepted: "rgba(34, 197, 94, 0.18)",
  Rejected: "rgba(244, 63, 94, 0.18)",
};
const STATUS_COLOR = {
  Draft: "var(--text-secondary)",
  Sent: "#3b82f6",
  Accepted: "var(--success-color, #22c55e)",
  Rejected: "var(--danger-color, #f43f5e)",
};

const SUB_BRANDS = [
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const EMPTY_LINE = () => ({
  // Stable React key for the row — Date.now() + counter avoids React
  // remount churn when an inline edit re-renders.
  key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  description: "",
  qty: 1,
  unitPrice: 0,
});

function lineTotal(line) {
  const qty = Number(line.qty) || 0;
  const unit = Number(line.unitPrice) || 0;
  return qty * unit;
}

function fmt(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function QuoteBuilder() {
  const { id: routeId } = useParams();
  const isEdit = !!routeId;
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [quoteId, setQuoteId] = useState(routeId ? Number(routeId) : null);
  const [status, setStatus] = useState("Draft");
  const [contactId, setContactId] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [subBrand, setSubBrand] = useState("tmc");
  const [validUntil, setValidUntil] = useState("");
  const [items, setItems] = useState([]);
  const [discountPct, setDiscountPct] = useState(0);
  const [taxPct, setTaxPct] = useState(0);

  // Edit-mode hydration from GET /api/travel/quotes/:id.
  useEffect(() => {
    if (!isEdit) return;
    setLoading(true);
    fetchApi(`/api/travel/quotes/${routeId}`)
      .then((q) => {
        if (!q || typeof q !== "object") return;
        setQuoteId(q.id);
        setStatus(q.status || "Draft");
        setContactId(q.contactId == null ? "" : String(q.contactId));
        setCurrency(q.currency || "INR");
        setSubBrand(q.subBrand || "tmc");
        setValidUntil(q.validUntil ? String(q.validUntil).slice(0, 10) : "");
        // Future slice: hydrate q.items[] when backend ships line-items
        // persistence. For now the items table starts empty in edit mode
        // and operators rebuild the lines from the rolled-up totalAmount.
        if (Array.isArray(q.items)) {
          setItems(
            q.items.map((it, i) => ({
              key: `srv-${i}-${Date.now()}`,
              description: it.description || "",
              qty: Number(it.qty) || 1,
              unitPrice: Number(it.unitPrice) || 0,
            })),
          );
        }
      })
      .catch((err) => {
        notify.error(err?.body?.error || err?.message || "Failed to load quote");
      })
      .finally(() => setLoading(false));
    // Intentionally only re-run when the route id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  const subtotal = items.reduce((acc, it) => acc + lineTotal(it), 0);
  const discountAmount = subtotal * (Number(discountPct) || 0) / 100;
  const taxable = subtotal - discountAmount;
  const taxAmount = taxable * (Number(taxPct) || 0) / 100;
  const grandTotal = taxable + taxAmount;

  const addLine = () => setItems([...items, EMPTY_LINE()]);
  const removeLine = (key) => setItems(items.filter((it) => it.key !== key));
  const updateLine = (key, patch) =>
    setItems(items.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  const buildPayload = () => {
    const contactIdInt = parseInt(contactId, 10);
    if (!Number.isFinite(contactIdInt)) {
      notify.error("Contact ID is required (must be a number)");
      return null;
    }
    return {
      contactId: contactIdInt,
      totalAmount: Number(grandTotal.toFixed(2)),
      currency: currency || "INR",
      status: status || "Draft",
      subBrand: subBrand || "tmc",
      validUntil: validUntil || null,
    };
  };

  const handleSaveDraft = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setSaving(true);
    try {
      if (quoteId) {
        await fetchApi(`/api/travel/quotes/${quoteId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        notify.success(`Quote #${quoteId} saved`);
      } else {
        const created = await fetchApi("/api/travel/quotes", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (created?.id) setQuoteId(created.id);
        notify.success(`Quote created (#${created?.id ?? "new"})`);
      }
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleSend = async () => {
    if (!quoteId) {
      notify.error("Save the quote first before sending");
      return;
    }
    try {
      await fetchApi(`/api/travel/quotes/${quoteId}`, {
        method: "PUT",
        body: JSON.stringify({ ...buildPayload(), status: "Sent" }),
      });
      setStatus("Sent");
      notify.success(`Quote #${quoteId} marked as Sent`);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Send failed");
    }
  };

  const handleDuplicate = async () => {
    if (!quoteId) {
      notify.error("Save the quote first before duplicating");
      return;
    }
    try {
      // Agent A's endpoint, same-tick. Graceful-degrade on 404 if the
      // backend slice hasn't deployed yet.
      const dup = await fetchApi(`/api/travel/quotes/${quoteId}/duplicate`, {
        method: "POST",
      });
      notify.success(`Quote duplicated as #${dup?.id ?? "new"}`);
    } catch (err) {
      if (err?.status === 404) {
        notify.info("Duplicate endpoint not yet available — try again after backend deploy");
        return;
      }
      notify.error(err?.body?.error || err?.message || "Duplicate failed");
    }
  };

  const handleDownloadPdf = async () => {
    if (!quoteId) {
      notify.error("Save the quote first before downloading PDF");
      return;
    }
    try {
      // Cascade-tolerant. Agent A ships GET /pdf same tick.
      await fetchApi(`/api/travel/quotes/${quoteId}/pdf`);
      notify.success(`PDF download triggered for quote #${quoteId}`);
    } catch (err) {
      if (err?.status === 404) {
        notify.info("PDF endpoint not yet available — try again after backend deploy");
        return;
      }
      notify.error(err?.body?.error || err?.message || "PDF download failed");
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
        <div style={empty}>Loading&hellip;</div>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 24,
        maxWidth: 1200,
        margin: "0 auto",
        animation: "fadeIn 0.4s ease-out",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h1
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: 0,
              fontSize: "1.75rem",
              fontWeight: 600,
            }}
          >
            <Calculator size={26} aria-hidden /> Quote Builder
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
            {quoteId ? (
              <>
                Quote <strong>#{quoteId}</strong>
                {" "}
                <span
                  style={{
                    ...statusBadge,
                    background: STATUS_BG[status] || "rgba(255,255,255,0.08)",
                    color: STATUS_COLOR[status] || "var(--text-primary)",
                  }}
                >
                  {status}
                </span>
              </>
            ) : (
              "New quote — fill in the form to save a draft"
            )}
          </p>
        </div>
        {canWrite && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={handleSaveDraft}
              disabled={saving}
              style={primaryBtn}
            >
              <Save size={14} /> {saving ? "Saving…" : "Save Draft"}
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={saving || !quoteId}
              style={secondaryBtn}
              title={!quoteId ? "Save first" : "Mark as Sent"}
            >
              <Send size={14} /> Send
            </button>
            <button
              type="button"
              onClick={handleDuplicate}
              disabled={!quoteId}
              style={secondaryBtn}
              title={!quoteId ? "Save first" : "Duplicate this quote"}
            >
              <Copy size={14} /> Duplicate
            </button>
            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={!quoteId}
              style={secondaryBtn}
              title={!quoteId ? "Save first" : "Download PDF"}
            >
              <Download size={14} /> Download PDF
            </button>
          </div>
        )}
      </header>

      <section
        className="glass"
        aria-label="Quote header fields"
        style={{
          padding: 16,
          marginBottom: 16,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
          gap: 10,
          alignItems: "end",
        }}
      >
        <label style={fieldLabel}>
          Contact ID
          <input
            type="number"
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            placeholder="Contact ID *"
            style={inputStyle}
            aria-label="Contact ID"
          />
        </label>
        <label style={fieldLabel}>
          Currency
          <input
            type="text"
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            style={inputStyle}
            aria-label="Currency"
          />
        </label>
        <label style={fieldLabel}>
          Sub-brand
          <select
            value={subBrand}
            onChange={(e) => setSubBrand(e.target.value)}
            style={inputStyle}
            aria-label="Sub-brand"
          >
            {SUB_BRANDS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label style={fieldLabel}>
          Valid Until
          <input
            type="date"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
            style={inputStyle}
            aria-label="Valid until"
          />
        </label>
      </section>

      <section
        className="glass"
        aria-label="Line items"
        style={{ padding: 0, marginBottom: 16, overflow: "hidden" }}
      >
        <div
          style={{
            padding: "12px 16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid var(--border-color)",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Line Items</h2>
          {canWrite && (
            <button type="button" onClick={addLine} style={primaryBtn} aria-label="Add line">
              <Plus size={14} /> Add line
            </button>
          )}
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
              <th style={th}>Description</th>
              <th style={{ ...th, width: 100 }}>Qty</th>
              <th style={{ ...th, width: 140 }}>Unit Price</th>
              <th style={{ ...th, width: 140 }}>Total</th>
              {canWrite && <th style={{ ...th, width: 60, textAlign: "center" }}>—</th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={canWrite ? 5 : 4}
                  style={{ ...td, textAlign: "center", color: "var(--text-secondary)" }}
                >
                  No line items yet. Click <strong>Add line</strong> to start.
                </td>
              </tr>
            )}
            {items.map((it) => (
              <tr key={it.key} style={{ borderTop: "1px solid var(--border-color)" }}>
                <td style={td}>
                  <input
                    type="text"
                    value={it.description}
                    onChange={(e) => updateLine(it.key, { description: e.target.value })}
                    placeholder="Service / package description"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`Line ${it.key} description`}
                  />
                </td>
                <td style={td}>
                  <input
                    type="number"
                    min={0}
                    value={it.qty}
                    onChange={(e) => updateLine(it.key, { qty: e.target.value })}
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`Line ${it.key} quantity`}
                  />
                </td>
                <td style={td}>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={it.unitPrice}
                    onChange={(e) => updateLine(it.key, { unitPrice: e.target.value })}
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`Line ${it.key} unit price`}
                  />
                </td>
                <td style={{ ...td, fontWeight: 600 }}>{fmt(lineTotal(it))}</td>
                {canWrite && (
                  <td style={{ ...td, textAlign: "center" }}>
                    <button
                      type="button"
                      onClick={() => removeLine(it.key)}
                      style={iconBtn}
                      aria-label={`Remove line ${it.key}`}
                      title="Remove line"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section
        className="glass"
        aria-label="Totals"
        style={{
          padding: 16,
          marginBottom: 16,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
          gap: 16,
          alignItems: "center",
        }}
      >
        <div>
          <label style={fieldLabel}>
            Discount %
            <input
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={discountPct}
              onChange={(e) => setDiscountPct(e.target.value)}
              style={inputStyle}
              aria-label="Discount percent"
            />
          </label>
        </div>
        <div>
          <label style={fieldLabel}>
            Tax %
            <input
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={taxPct}
              onChange={(e) => setTaxPct(e.target.value)}
              style={inputStyle}
              aria-label="Tax percent"
            />
          </label>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={totalsRow}>
            <span style={totalsLabel}>Subtotal</span>
            <span style={totalsValue} aria-label="Subtotal">
              {currency} {fmt(subtotal)}
            </span>
          </div>
          <div style={totalsRow}>
            <span style={totalsLabel}>Discount</span>
            <span style={totalsValue} aria-label="Discount amount">
              -{currency} {fmt(discountAmount)}
            </span>
          </div>
          <div style={totalsRow}>
            <span style={totalsLabel}>Tax</span>
            <span style={totalsValue} aria-label="Tax amount">
              {currency} {fmt(taxAmount)}
            </span>
          </div>
          <div
            style={{
              ...totalsRow,
              borderTop: "1px solid var(--border-color)",
              paddingTop: 6,
              marginTop: 6,
              fontWeight: 700,
            }}
          >
            <span style={totalsLabel}>Grand Total</span>
            <span
              style={{ ...totalsValue, color: "var(--primary-color, var(--accent-color))" }}
              aria-label="Grand total"
            >
              {currency} {fmt(grandTotal)}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

const th = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-secondary)",
  background: "var(--subtle-bg)",
  fontWeight: 600,
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const empty = {
  padding: 32,
  textAlign: "center",
  color: "var(--text-secondary)",
  fontSize: 14,
};
const inputStyle = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color, rgba(255,255,255,0.05))",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
};
const fieldLabel = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--text-secondary)",
};
const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "none",
  cursor: "pointer",
};
const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  cursor: "pointer",
};
const iconBtn = {
  padding: 6,
  borderRadius: 4,
  background: "transparent",
  color: "var(--danger-color, #f43f5e)",
  border: "none",
  cursor: "pointer",
};
const statusBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
  marginLeft: 6,
};
const totalsRow = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 13,
  padding: "4px 0",
};
const totalsLabel = { color: "var(--text-secondary)" };
const totalsValue = { color: "var(--text-primary)", fontFamily: "monospace" };
