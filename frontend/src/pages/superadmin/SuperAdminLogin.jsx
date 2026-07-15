import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { superAdminFetch, setSuperAdminSession, getSuperAdminToken } from "../../utils/superAdminApi";

export default function SuperAdminLogin() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (getSuperAdminToken()) {
    navigate("/super-admin/cron", { replace: true });
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await superAdminFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setSuperAdminSession(data.token, data.username);
      navigate("/super-admin/cron", { replace: true });
    } catch (err) {
      setError(err.message || "Login failed");
    }
    setLoading(false);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-color, #0b0c10)",
        color: "var(--text-primary, #fff)",
      }}
    >
      <form
        onSubmit={handleSubmit}
        autoComplete="off"
        style={{
          width: "min(380px, 90vw)",
          background: "var(--card-bg, rgba(255,255,255,0.04))",
          border: "1px solid var(--border-color, rgba(255,255,255,0.08))",
          borderRadius: 12,
          padding: "2rem",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "0.5rem" }}>
          <ShieldCheck size={22} color="var(--accent-color, #3b82f6)" />
          <h1 style={{ fontSize: "1.15rem", fontWeight: 700, margin: 0 }}>Super Admin Portal</h1>
        </div>
        <p style={{ fontSize: "0.8rem", color: "var(--text-secondary, #9aa0ab)", margin: 0 }}>
          System administration only. This is not your regular CRM login.
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
          Username
          <input
            className="input-field"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
          Password
          <input
            className="input-field"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
          />
        </label>

        {error && (
          <div style={{ fontSize: "0.8rem", color: "#f28b82" }}>{error}</div>
        )}

        <button
          type="submit"
          className="btn-primary"
          disabled={loading || !username || !password}
          style={{ padding: "0.6rem", fontWeight: 600 }}
        >
          {loading ? "Signing in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
