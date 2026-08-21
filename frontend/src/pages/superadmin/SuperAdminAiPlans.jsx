import { useEffect, useState } from "react";
import { BarChart3, CreditCard, Edit2, Plus, Save, Trash2, Users, X } from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import { creditsToTokens, tokensToCredits } from "../../utils/aiCredits";

const EMPTY_FORM = {
  name: "",
  description: "",
  price: "",
  currency: "INR",
  billingCycle: "monthly",
  credits: "",
  fairUsagePolicy: "",
  featureRestrictions: "",
  validityDays: "",
  displayOrder: "0",
  isActive: true,
  apiKeys: [],
};

function toFormState(plan, availableKeys = []) {
  const attached = Array.isArray(plan.apiKeys) ? plan.apiKeys : [];
  return {
    name: plan.name || "",
    description: plan.description || "",
    price: String(plan.price ?? ""),
    currency: plan.currency || "INR",
    billingCycle: plan.billingCycle || "monthly",
    // The API still stores/returns raw tokens (creditTokens) — the form
    // works in credits (1 credit = 1,000 tokens) so admins enter a
    // human-friendly number instead of a raw token count.
    credits: String(tokensToCredits(plan.creditTokens) || ""),
    fairUsagePolicy: plan.fairUsagePolicy || "",
    featureRestrictions: (plan.featureRestrictions || []).join(", "),
    validityDays: plan.validityDays != null ? String(plan.validityDays) : "",
    displayOrder: String(plan.displayOrder ?? 0),
    isActive: plan.isActive !== false,
    apiKeys: availableKeys
      .filter((k) => k.isEnabled)
      .map((k) => {
        const match = attached.find((a) => a.keyId === k.id);
        return { keyId: k.id, providerId: k.providerId, label: k.label, model: k.model, isEnabled: match ? match.isEnabled !== false : false };
      }),
  };
}

function toPayload(form) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    price: Number(form.price),
    currency: form.currency.trim() || "INR",
    billingCycle: form.billingCycle,
    creditTokens: creditsToTokens(form.credits),
    fairUsagePolicy: form.fairUsagePolicy.trim() || null,
    featureRestrictions: form.featureRestrictions
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    validityDays: form.validityDays === "" ? null : Number(form.validityDays),
    displayOrder: Number(form.displayOrder) || 0,
    isActive: form.isActive,
    apiKeys: Array.isArray(form.apiKeys)
      ? form.apiKeys.filter((k) => k.isEnabled).map(({ keyId, isEnabled }) => ({ keyId, isEnabled }))
      : [],
  };
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatCost(value) {
  return `$${Number(value || 0).toFixed(Number(value || 0) < 1 ? 6 : 2)}`;
}

export default function SuperAdminAiPlans() {
  const [plans, setPlans] = useState([]);
  const [availableKeys, setAvailableKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [editingId, setEditingId] = useState(null); // 'new' | plan.id | null
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [expandedPlanId, setExpandedPlanId] = useState(null);
  const [subscriberAnalytics, setSubscriberAnalytics] = useState({});
  const [loadingSubscribersFor, setLoadingSubscribersFor] = useState(null);

  const load = async () => {
    setLoading(true);
    setMessage("");
    try {
      const [plansRes, keysRes] = await Promise.all([
        superAdminFetch("/ai-management/plans"),
        superAdminFetch("/ai-management/api-keys"),
      ]);
      setPlans(Array.isArray(plansRes?.plans) ? plansRes.plans : []);
      setAvailableKeys(Array.isArray(keysRes?.keys) ? keysRes.keys : []);
    } catch (err) {
      setMessage(err.message || "Failed to load AI subscription plans.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const keysForForm = () =>
    availableKeys
      .filter((k) => k.isEnabled)
      .map((k) => ({ keyId: k.id, providerId: k.providerId, label: k.label, model: k.model, isEnabled: false }));

  const startCreate = () => {
    setForm({ ...EMPTY_FORM, apiKeys: keysForForm() });
    setEditingId("new");
  };

  const startEdit = (plan) => {
    setForm(toFormState(plan, availableKeys));
    setEditingId(plan.id);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !(Number(form.price) >= 0) || !(Number(form.credits) > 0)) {
      setMessage("Plan name, a non-negative price, and a positive credit amount are required.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const payload = toPayload(form);
      if (editingId === "new") {
        await superAdminFetch("/ai-management/plans", { method: "POST", body: JSON.stringify(payload) });
        setMessage("Plan created successfully.");
      } else {
        await superAdminFetch(`/ai-management/plans/${editingId}`, { method: "PUT", body: JSON.stringify(payload) });
        setMessage("Plan updated successfully.");
      }
      cancelEdit();
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to save plan.");
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async (plan) => {
    if (!window.confirm(`Deactivate "${plan.name}"? Existing subscribers keep their access; the plan just stops appearing to new buyers.`)) {
      return;
    }
    setMessage("");
    try {
      await superAdminFetch(`/ai-management/plans/${plan.id}`, { method: "DELETE" });
      setMessage("Plan deactivated.");
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to deactivate plan.");
    }
  };

  const loadSubscribers = async (plan) => {
    if (expandedPlanId === plan.id) {
      setExpandedPlanId(null);
      return;
    }
    setExpandedPlanId(plan.id);
    if (subscriberAnalytics[plan.id]) return;
    setLoadingSubscribersFor(plan.id);
    setMessage("");
    try {
      const res = await superAdminFetch(`/ai-management/plans/${plan.id}/subscribers`);
      setSubscriberAnalytics((prev) => ({ ...prev, [plan.id]: res }));
    } catch (err) {
      setMessage(err.message || "Failed to load plan subscribers.");
    } finally {
      setLoadingSubscribersFor(null);
    }
  };

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
        <div>
          <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <CreditCard size={24} color="var(--accent-color)" /> AI Subscription Plans
          </h1>
          <p style={{ margin: "0.4rem 0 0 0", color: "var(--text-secondary)" }}>
            Create and manage reusable CRM-managed AI plans. Tenants buy these directly — nothing here requires manual
            per-tenant approval.
          </p>
        </div>
        <button className="btn-primary" onClick={startCreate} style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
          <Plus size={16} /> New Plan
        </button>
      </header>

      {message && (
        <div className="card" style={{ padding: "0.85rem 1rem", borderLeft: `4px solid ${/failed|error/i.test(message) ? "#ef4444" : "#22c55e"}` }}>
          {message}
        </div>
      )}

      {editingId && (
        <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
          <div style={{ fontWeight: 700 }}>{editingId === "new" ? "New Plan" : "Edit Plan"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.75rem" }}>
            <input className="input-field" type="text" placeholder="Plan name" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
            <input className="input-field" type="number" min="0" step="0.01" placeholder="Price" value={form.price} onChange={(e) => setForm((p) => ({ ...p, price: e.target.value }))} />
            <input className="input-field" type="text" placeholder="Currency (e.g. INR)" value={form.currency} onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))} />
            <select className="input-field" value={form.billingCycle} onChange={(e) => setForm((p) => ({ ...p, billingCycle: e.target.value }))} style={{ background: "var(--input-bg)" }}>
              <option value="monthly">Monthly</option>
              <option value="one_time">One-time</option>
            </select>
            <input className="input-field" type="number" min="1" placeholder="AI credits included (1 credit = 1,000 tokens)" value={form.credits} onChange={(e) => setForm((p) => ({ ...p, credits: e.target.value }))} />
            <input className="input-field" type="number" min="0" placeholder="Validity (days, optional)" value={form.validityDays} onChange={(e) => setForm((p) => ({ ...p, validityDays: e.target.value }))} />
            <input className="input-field" type="number" placeholder="Display order" value={form.displayOrder} onChange={(e) => setForm((p) => ({ ...p, displayOrder: e.target.value }))} />
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.checked }))} />
              Active (visible to tenants)
            </label>
          </div>
          <textarea className="input-field" rows={2} placeholder="Description" value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} />
          <textarea className="input-field" rows={2} placeholder="Fair usage policy (optional)" value={form.fairUsagePolicy} onChange={(e) => setForm((p) => ({ ...p, fairUsagePolicy: e.target.value }))} />
          <input
            className="input-field"
            type="text"
            placeholder="Feature restrictions, comma-separated (optional; blank = all features)"
            value={form.featureRestrictions}
            onChange={(e) => setForm((p) => ({ ...p, featureRestrictions: e.target.value }))}
          />

          <div>
            <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.4rem" }}>Attached API keys</div>
            {form.apiKeys.length === 0 ? (
              <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                No enabled CRM-managed API keys available. Add and enable keys in API Key Management first.
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.5rem" }}>
                {form.apiKeys.map((k) => (
                  <label
                    key={k.keyId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      padding: "0.55rem 0.7rem",
                      borderRadius: 8,
                      border: "1px solid var(--border-color, rgba(255,255,255,0.08))",
                      fontSize: "0.85rem",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={k.isEnabled}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          apiKeys: p.apiKeys.map((item) =>
                            item.keyId === k.keyId ? { ...item, isEnabled: e.target.checked } : item
                          ),
                        }))
                      }
                    />
                    <span style={{ fontWeight: 500 }}>{k.label}</span>
                    <span style={{ color: "var(--text-secondary)", fontSize: "0.75rem" }}>({k.providerId} · {k.model || "default model"})</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: "0.6rem" }}>
            <button className="btn-primary" onClick={handleSave} disabled={saving} style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
              <Save size={15} /> {saving ? "Saving..." : "Save Plan"}
            </button>
            <button className="btn-secondary" onClick={cancelEdit} style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
              <X size={15} /> Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>Loading plans...</div>
      ) : plans.length === 0 ? (
        <div className="card" style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-secondary)" }}>
          No AI subscription plans yet. Create one to let tenants buy CRM-managed AI credits.
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {plans.map((plan) => (
            <div key={plan.id} className="card" style={{ padding: "1rem", display: "grid", gap: "0.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    {plan.name}
                    {!plan.isActive && (
                      <span style={{ fontSize: "0.7rem", padding: "0.15rem 0.5rem", borderRadius: 999, background: "rgba(148,163,184,0.15)", color: "var(--text-secondary)" }}>
                        inactive
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                    {plan.currency} {plan.price} / {plan.billingCycle === "one_time" ? "one-time" : "month"} ·{" "}
                    {tokensToCredits(plan.creditTokens).toLocaleString()} credits
                    {plan.validityDays ? ` · valid ${plan.validityDays}d` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  <button className="btn-secondary" onClick={() => loadSubscribers(plan)} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                    <Users size={14} /> {expandedPlanId === plan.id ? "Hide Usage" : "Subscribers"}
                  </button>
                  <button className="btn-secondary" onClick={() => startEdit(plan)} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                    <Edit2 size={14} /> Edit
                  </button>
                  {plan.isActive && (
                    <button
                      onClick={() => handleDeactivate(plan)}
                      style={{
                        padding: "0.5rem 0.8rem",
                        borderRadius: 8,
                        border: "1px solid #ef4444",
                        background: "rgba(239, 68, 68, 0.1)",
                        color: "#ef4444",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.4rem",
                      }}
                    >
                      <Trash2 size={14} /> Deactivate
                    </button>
                  )}
                </div>
              </div>
              {plan.description && <div style={{ fontSize: "0.85rem" }}>{plan.description}</div>}
              {Array.isArray(plan.apiKeys) && plan.apiKeys.length > 0 && (
                <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", display: "flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "center" }}>
                  <span>Keys:</span>
                  {plan.apiKeys.map((k) => (
                    <span
                      key={k.keyId}
                      style={{
                        padding: "0.15rem 0.45rem",
                        borderRadius: 999,
                        background: k.isEnabled ? "rgba(34,197,94,0.12)" : "rgba(148,163,184,0.12)",
                        color: k.isEnabled ? "#22c55e" : "#94a3b8",
                      }}
                    >
                      {k.label} ({k.providerId} · {k.model || "default model"})
                    </span>
                  ))}
                </div>
              )}
              {expandedPlanId === plan.id && (
                <div style={{ borderTop: "1px solid var(--border-color, rgba(255,255,255,0.08))", paddingTop: "0.85rem", marginTop: "0.35rem" }}>
                  {loadingSubscribersFor === plan.id ? (
                    <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Loading subscribers...</div>
                  ) : !subscriberAnalytics[plan.id] ? (
                    <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>No subscriber analytics loaded.</div>
                  ) : (
                    <PlanSubscriberAnalytics data={subscriberAnalytics[plan.id]} />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanSubscriberAnalytics({ data }) {
  const subscribers = Array.isArray(data?.subscribers) ? data.subscribers : [];
  const totals = data?.totals || {};
  return (
    <div style={{ display: "grid", gap: "0.85rem" }}>
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", fontSize: "0.82rem" }}>
        <strong style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
          <BarChart3 size={14} /> {totals.subscribers || 0} subscribers
        </strong>
        <span>{totals.activeSubscribers || 0} active</span>
        <span>{Number(totals.calls || 0).toLocaleString()} calls</span>
        <span>{tokensToCredits(totals.tokens || 0).toLocaleString()} credits used</span>
        <span>{formatCost(totals.cost)}</span>
      </div>

      {subscribers.length === 0 ? (
        <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>No tenants have purchased this plan yet.</div>
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid var(--border-color, rgba(255,255,255,0.08))", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem", minWidth: 920 }}>
            <thead style={{ background: "rgba(107,114,128,0.08)" }}>
              <tr>
                {["Client", "Emails", "Subscription", "Purchases", "Remaining", "Used", "Calls", "Failures", "Cost", "Last activity"].map((h) => (
                  <th key={h} style={{ padding: "0.5rem 0.6rem", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subscribers.map((subscriber) => (
                <tr key={subscriber.tenantId} style={{ borderTop: "1px solid var(--border-color, rgba(255,255,255,0.08))" }}>
                  <td style={{ padding: "0.5rem 0.6rem", fontWeight: 700 }}>
                    {subscriber.organization}
                    <div style={{ color: "var(--text-secondary)", fontWeight: 400, fontSize: "0.72rem" }}>{subscriber.slug || `Tenant #${subscriber.tenantId}`}</div>
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem", maxWidth: 260 }}>
                    {(subscriber.clientEmails || []).join(", ") || "-"}
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>
                    {subscriber.subscription?.status || "-"}
                    <div style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
                      {formatDate(subscriber.subscription?.startDate)}
                    </div>
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>
                    {subscriber.purchaseCount || 0}
                    <div style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
                      {subscriber.currency} {Number(subscriber.revenue || 0).toLocaleString()}
                    </div>
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>
                    {tokensToCredits(subscriber.credits?.balanceTokens || 0).toLocaleString()}
                    <div style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>{subscriber.credits?.percentRemaining || 0}%</div>
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>{tokensToCredits(subscriber.credits?.totalUsedTokens || 0).toLocaleString()}</td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>{Number(subscriber.usage?.calls || 0).toLocaleString()}</td>
                  <td style={{ padding: "0.5rem 0.6rem", color: subscriber.usage?.failures ? "#ef4444" : "inherit" }}>
                    {subscriber.usage?.failures || 0}
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>{formatCost(subscriber.usage?.cost)}</td>
                  <td style={{ padding: "0.5rem 0.6rem", whiteSpace: "nowrap" }}>{formatDate(subscriber.usage?.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.appliedFilters?.attribution && (
        <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem" }}>{data.appliedFilters.attribution}</div>
      )}
    </div>
  );
}
