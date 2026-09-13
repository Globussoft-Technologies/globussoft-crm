import { Inbox } from "lucide-react";
import { Link } from "react-router-dom";
import { usePermissions } from "../hooks/usePermissions";
import { recordOnboardingEvent } from "../onboarding/analytics";

export default function ContextualEmptyState({
  featureKey,
  title,
  description,
  actions = [],
  compact = false,
}) {
  const { hasPermission, isReady } = usePermissions();
  const visibleActions = actions.filter((action) => {
    if (action.visible === false) return false;
    if (!action.permission) return true;
    return isReady && hasPermission(action.permission.module, action.permission.action);
  });

  const activate = (action) => {
    recordOnboardingEvent({ eventType: "CHECKLIST_ACTIONED", featureKey: action.analyticsKey || featureKey });
    action.onClick?.();
  };

  return (
    <div data-testid="contextual-empty-state" style={{ display: "grid", justifyItems: "center", gap: compact ? 8 : 12, padding: compact ? "8px 4px" : "24px 16px", textAlign: "center", color: "var(--text-secondary)" }}>
      <span aria-hidden style={{ width: 40, height: 40, display: "grid", placeItems: "center", borderRadius: 12, background: "var(--subtle-bg)" }}><Inbox size={20} /></span>
      <div><strong style={{ display: "block", color: "var(--text-primary)", marginBottom: 4 }}>{title}</strong><span>{description}</span></div>
      {visibleActions.length > 0 && <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: 8 }}>
        {visibleActions.map((action, index) => action.to ? (
          <Link key={action.label} to={action.to} className={index === 0 ? "btn-primary" : "btn-secondary"} onClick={() => activate(action)}>{action.label} <span aria-hidden style={{ marginLeft: 5 }}>→</span></Link>
        ) : (
          <button key={action.label} type="button" className={index === 0 ? "btn-primary" : "btn-secondary"} onClick={() => activate(action)}>{action.label} <span aria-hidden style={{ marginLeft: 5 }}>→</span></button>
        ))}
      </div>}
    </div>
  );
}
