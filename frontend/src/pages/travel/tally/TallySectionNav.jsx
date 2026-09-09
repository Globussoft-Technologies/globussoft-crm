import { ArrowLeft } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import PermissionGate from "../../../components/PermissionGate";

export default function TallySectionNav({ showBack = false }) {
  const navigate = useNavigate();
  const location = useLocation();

  if (!showBack && location.pathname === "/travel/tally") return null;

  return (
    <button
      type="button"
      onClick={() => navigate(-1)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        marginBottom: 18,
        padding: "8px 12px",
        border: "1px solid var(--border-color, rgba(148,163,184,.2))",
        borderRadius: 8,
        textDecoration: "none",
        color: "var(--text-primary)",
        fontWeight: 600,
        fontSize: 13,
      }}
    >
      <ArrowLeft size={15} />
      Back
    </button>
  );
}

export function TallyWriteGate({ children }) {
  return (
    <PermissionGate module="tally" action="update">
      {children}
    </PermissionGate>
  );
}
