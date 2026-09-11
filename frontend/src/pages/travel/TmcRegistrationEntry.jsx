import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useLocation, useSearchParams } from "react-router-dom";

// TMC-only registration gateway. It does not render a second form: it
// validates the signed TMC context, stores it in an HttpOnly cookie through
// the backend, and redirects into the shared /customer/register page.
export default function TmcRegistrationEntry() {
  const [params] = useSearchParams();
  const location = useLocation();
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const token = params.get("token");
    const teacherRoute = location.pathname.endsWith("/teacher");
    if (!token && !teacherRoute) {
      setError("This registration link is incomplete. Please ask for a fresh link.");
      return () => { alive = false; };
    }

    (async () => {
      try {
        const contextQuery = token
          ? `token=${encodeURIComponent(token)}`
          : "registrationType=TEACHER";
        const response = await fetch(`/api/portal/tmc/registration-context?${contextQuery}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "This registration link is invalid or expired.");
        const next = data.next || "/tmc/parent-portal";
        const query = new URLSearchParams({ next });
        if (data.tenantSlug) query.set("tenantSlug", data.tenantSlug);
        if (data.registrationType === "TEACHER") query.set("tmcRole", "TEACHER");
        window.location.replace(`/customer/register?${query.toString()}`);
      } catch (err) {
        if (alive) setError(err.message || "Unable to open this registration link.");
      }
    })();

    return () => { alive = false; };
  }, [location.pathname, params]);

  return (
    <div style={styles.page}>
      {error ? (
        <div style={styles.card} role="alert">
          <AlertCircle size={30} color="#b42318" aria-hidden />
          <h1 style={styles.heading}>Registration link unavailable</h1>
          <p style={styles.text}>{error}</p>
        </div>
      ) : (
        <div style={styles.card} role="status" aria-live="polite">
          <Loader2 size={30} color="#5548e8" style={{ animation: "spin 1s linear infinite" }} aria-hidden />
          <h1 style={styles.heading}>Opening registration</h1>
          <p style={styles.text}>Please wait while we prepare your registration form.</p>
        </div>
      )}
      <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24,
    background: "#f5f6fb",
  },
  card: {
    width: "min(100%, 430px)",
    padding: 28,
    borderRadius: 16,
    background: "#fff",
    border: "1px solid #e5e7eb",
    boxShadow: "0 12px 35px rgba(20, 24, 40, 0.08)",
    textAlign: "center",
  },
  heading: { margin: "16px 0 8px", fontSize: 22, color: "#20213a" },
  text: { margin: 0, color: "#667085", lineHeight: 1.5 },
};
