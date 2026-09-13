import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Megaphone, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { AuthContext } from "../App";
import { fetchApi } from "../utils/api";
import { pendingAnnouncements } from "../onboarding/releaseAnnouncements";
import { recordOnboardingEvent } from "../onboarding/analytics";

const EMPTY_STATE = { checklist: [], completed: 0, total: 0, completionPercentage: 0, dismissedAnnouncements: [] };

export default function OnboardingCenter() {
  const { user, tenant } = useContext(AuthContext) || {};
  const navigate = useNavigate();
  const dialogRef = useRef(null);
  const launcherRef = useRef(null);
  const [state, setState] = useState(EMPTY_STATE);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("checklist");
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const role = String(user?.role || "USER").toUpperCase();
  const canViewAnalytics = user?.isOwner || ["ADMIN", "MANAGER"].includes(role);
  const announcements = useMemo(
    () => pendingAnnouncements(state.dismissedAnnouncements),
    [state.dismissedAnnouncements],
  );

  const load = async () => {
    try {
      setState(await fetchApi("/api/onboarding/state", { silent: true }));
    } catch {
      // The core CRM remains usable if onboarding is temporarily unavailable.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tenant?.vertical === "generic") load();
  }, [tenant?.id, tenant?.vertical, user?.userId, user?.id]);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    dialogRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      (launcherRef.current || previous)?.focus?.();
    };
  }, [open]);

  if (tenant?.vertical !== "generic") return null;

  const dismiss = async (id) => {
    const result = await fetchApi(`/api/onboarding/announcements/${encodeURIComponent(id)}/dismiss`, { method: "PUT" });
    setState((current) => ({ ...current, dismissedAnnouncements: result.dismissedAnnouncements }));
    recordOnboardingEvent({ eventType: "ANNOUNCEMENT_DISMISSED", featureKey: id });
  };

  const openPanel = (nextTab) => {
    load();
    setTab(nextTab);
    setOpen(true);
    recordOnboardingEvent({ eventType: nextTab === "announcements" ? "ANNOUNCEMENT_VIEWED" : "CHECKLIST_OPENED", featureKey: "onboarding-center" });
    if (nextTab === "analytics" && canViewAnalytics) {
      fetchApi("/api/onboarding/analytics", { silent: true }).then(setAnalytics).catch(() => setAnalytics(null));
    }
  };

  const goToItem = (item) => {
    recordOnboardingEvent({ eventType: "CHECKLIST_ACTIONED", featureKey: item.key });
    setOpen(false);
    navigate(item.path);
  };

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        onClick={() => openPanel(announcements.length ? "announcements" : "checklist")}
        className="btn-secondary"
        aria-label="Open onboarding and what's new"
        title="Onboarding and what's new"
        data-testid="onboarding-launcher"
        style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 9px" }}
      >
        <span aria-hidden>✦</span>
        <span className="desktop-only">{loading ? "Setup" : `${state.completionPercentage}%`}</span>
        {announcements.length > 0 && <span aria-label={`${announcements.length} new announcement${announcements.length === 1 ? "" : "s"}`} style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--danger-color, #dc2626)", position: "absolute", right: 3, top: 2 }} />}
      </button>

      {open && (
        <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(15,23,42,.55)", display: "grid", placeItems: "center", padding: 16 }}>
          <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="onboarding-title" data-testid="onboarding-center" style={{ width: "min(720px, 100%)", maxHeight: "min(760px, calc(100vh - 32px))", overflow: "auto", background: "var(--surface-color, #fff)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: 16, boxShadow: "0 24px 72px rgba(0,0,0,.35)", padding: "clamp(18px, 3vw, 28px)" }}>
            <header style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span aria-hidden style={{ color: "var(--primary-color, var(--accent-color))", fontSize: 22 }}>✦</span>
              <div style={{ flex: 1 }}><h2 id="onboarding-title" style={{ margin: 0 }}>Get started</h2><small style={{ color: "var(--text-secondary)" }}>Your progress is saved to your account.</small></div>
              <button type="button" className="btn-secondary" aria-label="Close onboarding" onClick={() => setOpen(false)}><X size={16} /></button>
            </header>

            <nav aria-label="Onboarding sections" style={{ display: "flex", gap: 8, margin: "20px 0", flexWrap: "wrap" }}>
              <button type="button" className={tab === "checklist" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("checklist")}>Checklist</button>
              <button type="button" className={tab === "announcements" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("announcements")}>What&apos;s new {announcements.length ? `(${announcements.length})` : ""}</button>
              {canViewAnalytics && <button type="button" className={tab === "analytics" ? "btn-primary" : "btn-secondary"} onClick={() => openPanel("analytics")}>Analytics</button>}
            </nav>

            {tab === "checklist" && <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><strong>{state.completed} of {state.total} complete</strong><span>{state.completionPercentage}%</span></div>
              <div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={state.completionPercentage} style={{ height: 9, background: "var(--border-color)", borderRadius: 999, overflow: "hidden", marginBottom: 16 }}><div style={{ height: "100%", width: `${state.completionPercentage}%`, background: "var(--primary-color, var(--accent-color))" }} /></div>
              <div style={{ display: "grid", gap: 9 }}>
                {state.checklist.map((item) => <button key={item.key} type="button" onClick={() => goToItem(item)} className="btn-secondary" style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left", padding: 12, opacity: item.completedAt ? .72 : 1 }}>
                  <span aria-hidden style={{ width: 24, height: 24, borderRadius: "50%", display: "grid", placeItems: "center", background: item.completedAt ? "var(--success-color, #16a34a)" : "var(--subtle-bg)", color: item.completedAt ? "white" : "inherit" }}>{item.completedAt ? <Check size={15} /> : "○"}</span>
                  <span style={{ flex: 1 }}>{item.label}</span><ChevronRight size={16} aria-hidden />
                </button>)}
              </div>
            </div>}

            {tab === "announcements" && <div aria-live="polite">
              {announcements.length === 0 ? <p style={{ color: "var(--text-secondary)" }}>You are caught up. New product features will appear here.</p> : announcements.map((announcement) => <article key={announcement.id} style={{ border: "1px solid var(--border-color)", borderRadius: 12, padding: 16, marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "start" }}><Megaphone size={18} aria-hidden /><div style={{ flex: 1 }}><strong>{announcement.title}</strong><div style={{ color: "var(--text-secondary)", fontSize: 13 }}>Version {announcement.version}</div></div><button type="button" className="btn-secondary" onClick={() => dismiss(announcement.id)}>Dismiss permanently</button></div>
                <ul>{announcement.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
              </article>)}
            </div>}

            {tab === "analytics" && <div>
              {!analytics ? <p style={{ color: "var(--text-secondary)" }}>Loading onboarding analytics…</p> : <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
                  {[['Started', analytics.tours.started], ['Completion rate', `${analytics.tours.completionRate}%`], ['Abandonment rate', `${analytics.tours.abandonmentRate}%`]].map(([label, value]) => <div key={label} className="card" style={{ padding: 14 }}><small>{label}</small><div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div></div>)}
                </div>
                <h3>Frequently skipped steps</h3><MetricList rows={analytics.skippedSteps} empty="No skipped steps recorded." />
                <h3>Missing tour targets</h3><MetricList rows={analytics.missingTargets} empty="No missing targets recorded." />
                <h3>Features users could not locate</h3><MetricList rows={analytics.featuresNotFound} empty="No failed feature lookups recorded." />
                <p style={{ color: "var(--text-secondary)", fontSize: 12 }}>{analytics.privacy}</p>
              </>}
            </div>}
          </section>
        </div>
      )}
    </>
  );
}

function MetricList({ rows, empty }) {
  if (!rows?.length) return <p style={{ color: "var(--text-secondary)" }}>{empty}</p>;
  return <ul>{rows.map((row, index) => <li key={`${row.tourKey || row.featureKey}-${row.stepKey || index}`}>{[row.featureKey, row.tourKey, row.stepKey, row.reason].filter(Boolean).join(" · ")} — {row.count}</li>)}</ul>;
}
