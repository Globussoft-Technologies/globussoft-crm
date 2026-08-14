import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Bot, CreditCard, Loader2, TrendingUp, Zap } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";
import { tokensToCredits } from "../utils/aiCredits";

function StatCard({ label, value, sub, icon: Icon, accent }) {
  return (
    <div className="card" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-secondary)", fontSize: "0.8rem" }}>
        <Icon size={15} color={accent || "var(--accent-color)"} />
        {label}
      </div>
      <div style={{ fontSize: "1.5rem", fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>{sub}</div>}
    </div>
  );
}

export default function AiUsageDashboard() {
  const navigate = useNavigate();
  const notify = useNotify();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);

  useEffect(() => {
    fetchApi("/api/ai-subscriptions/usage")
      .then(setData)
      .catch((err) => notify.error(err.message || "Failed to load AI usage dashboard."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "4rem" }}>
        <Loader2 size={28} className="spin" />
      </div>
    );
  }

  if (!data) return null;

  const { subscription, credits, recentTransactions, recentRequests } = data;
  const usagePercent = Math.max(0, Math.min(100, credits.usagePercent || 0));
  const barColor = usagePercent >= 95 ? "#ef4444" : usagePercent >= 75 ? "#f59e0b" : "#10b981";

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(1rem, 3vw, 2rem)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem", flexWrap: "wrap", gap: "0.75rem" }}>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="btn-secondary"
          style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
        >
          <ArrowLeft size={16} /> Back
        </button>
        <button type="button" className="btn-primary" onClick={() => navigate("/ai-subscription")}>
          {subscription ? "Upgrade / Buy More Credits" : "Get AI Subscription"}
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1.5rem" }}>
        <Bot size={26} color="var(--accent-color)" />
        <h1 style={{ fontSize: "1.6rem", fontWeight: 700, margin: 0 }}>AI Usage Dashboard</h1>
      </div>

      {!subscription && (
        <div
          style={{
            padding: "1rem",
            marginBottom: "1.5rem",
            borderRadius: 8,
            background: "rgba(245, 158, 11, 0.1)",
            border: "1px solid #f59e0b",
            fontSize: "0.85rem",
          }}
        >
          Your organization does not have an active CRM-managed AI subscription. Purchase a plan to see usage here.
        </div>
      )}

      {subscription && (
        <div className="card" style={{ padding: "1.25rem", marginBottom: "1.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <div>
              <strong style={{ fontSize: "1.05rem" }}>{subscription.planName}</strong>
              {subscription.renewalDate && (
                <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                  Renews / expires {new Date(subscription.renewalDate).toLocaleDateString()}
                </div>
              )}
            </div>
            <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>{usagePercent}% used</div>
          </div>
          <div style={{ height: 10, borderRadius: 6, background: "var(--border-color)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${usagePercent}%`, background: barColor, transition: "width 0.3s" }} />
          </div>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <StatCard label="Remaining Credits" value={tokensToCredits(credits.remainingTokens).toLocaleString()} icon={Zap} accent="#10b981" />
        <StatCard label="Used Credits" value={tokensToCredits(credits.usedTokens).toLocaleString()} icon={TrendingUp} accent="#f59e0b" />
        <StatCard label="Total Credits" value={tokensToCredits(credits.totalTokens).toLocaleString()} icon={CreditCard} />
        <StatCard label="Usage" value={`${usagePercent}%`} icon={Bot} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: "1.5rem" }}>
        <div className="card" style={{ padding: "1.25rem" }}>
          <h3 style={{ margin: "0 0 0.75rem 0", fontSize: "1rem" }}>Recent AI Requests</h3>
          {recentRequests?.length ? (
            <div style={{ display: "grid", gap: "0.5rem", maxHeight: 360, overflowY: "auto" }}>
              {recentRequests.map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "0.8rem",
                    borderBottom: "1px solid var(--border-color)",
                    paddingBottom: "0.4rem",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{r.task || r.surface || "AI request"}</div>
                    <div style={{ color: "var(--text-secondary)" }}>
                      {r.provider} / {r.model} · {new Date(r.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", color: "var(--text-secondary)" }}>{r.totalTokens} tok</div>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>No CRM-managed AI requests yet.</p>
          )}
        </div>

        <div className="card" style={{ padding: "1.25rem" }}>
          <h3 style={{ margin: "0 0 0.75rem 0", fontSize: "1rem" }}>Token Consumption History</h3>
          {recentTransactions?.length ? (
            <div style={{ display: "grid", gap: "0.5rem", maxHeight: 360, overflowY: "auto" }}>
              {recentTransactions.map((t) => (
                <div
                  key={t.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "0.8rem",
                    borderBottom: "1px solid var(--border-color)",
                    paddingBottom: "0.4rem",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{t.type}</div>
                    <div style={{ color: "var(--text-secondary)" }}>{new Date(t.createdAt).toLocaleString()}</div>
                  </div>
                  <div style={{ textAlign: "right", color: t.tokens >= 0 ? "#10b981" : "var(--text-secondary)" }}>
                    {t.tokens >= 0 ? "+" : ""}
                    {t.tokens.toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>No transactions yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
