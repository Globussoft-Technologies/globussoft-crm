import { useEffect, useState } from "react";
import { Outlet, useNavigate, NavLink } from "react-router-dom";
import { ShieldCheck, Clock, LogOut, BarChart3, Activity, Sun, Moon, Monitor } from "lucide-react";
import {
  getSuperAdminToken,
  getSuperAdminUsername,
  clearSuperAdminSession,
  superAdminFetch,
} from "../../utils/superAdminApi";

// Sidebar modules. Add a new module by appending one entry here + one
// <Route> in App.jsx; nothing else in this shell needs to change.
const MODULES = [
  { path: "/super-admin/cron", label: "Cron Maintenance", icon: Clock },
  { path: "/super-admin/cron-analytics", label: "Cron Analytics", icon: BarChart3 },
  { path: "/super-admin/api-analytics", label: "API Analytics", icon: Activity },
];

function getThemeIcon(theme) {
  if (theme === "light") return Sun;
  if (theme === "dark") return Moon;
  return Monitor;
}

export default function SuperAdminLayout() {
  const navigate = useNavigate();
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem("theme");
    if (stored) return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    let effectiveTheme = theme;
    if (theme === "system") {
      effectiveTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", effectiveTheme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const toggleTheme = () => {
    const advance = () => setTheme((t) => t === "light" ? "dark" : t === "dark" ? "system" : "light");
    if (typeof document.startViewTransition === "function") {
      // flushSync not available here without importing from react-dom; use direct setState inside transition
      document.startViewTransition(advance);
    } else {
      advance();
    }
  };

  useEffect(() => {
    if (!getSuperAdminToken()) {
      navigate("/super-admin/login", { replace: true });
    }
  }, [navigate]);

  const handleLogout = async () => {
    try {
      await superAdminFetch("/auth/logout", { method: "POST" });
    } catch {
      // stateless JWT — logout locally regardless of network result
    }
    clearSuperAdminSession();
    navigate("/super-admin/login", { replace: true });
  };

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "var(--bg-color, #0b0c10)", color: "var(--text-primary, #fff)" }}>
      <aside
        style={{
          width: 220,
          flexShrink: 0,
          height: "100%",
          borderRight: "1px solid var(--border-color, rgba(255,255,255,0.08))",
          display: "flex",
          flexDirection: "column",
          padding: "1.25rem 0.75rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 0.5rem", marginBottom: "1.5rem" }}>
          <ShieldCheck size={20} color="var(--accent-color, #3b82f6)" />
          <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>Super Admin</span>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
          {MODULES.map((m) => (
            <NavLink
              key={m.path}
              to={m.path}
              style={({ isActive }) => ({
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0.55rem 0.6rem",
                borderRadius: 8,
                fontSize: "0.85rem",
                textDecoration: "none",
                color: isActive ? "var(--accent-color, #3b82f6)" : "var(--text-primary, #fff)",
                background: isActive ? "rgba(59,130,246,0.12)" : "transparent",
              })}
            >
              <m.icon size={16} />
              {m.label}
            </NavLink>
          ))}
        </nav>

        <div style={{ borderTop: "1px solid var(--border-color, rgba(255,255,255,0.08))", paddingTop: "0.75rem", marginTop: "0.75rem" }}>
          <div style={{ fontSize: "0.75rem", color: "var(--text-secondary, #9aa0ab)", padding: "0 0.5rem", marginBottom: "0.5rem", wordBreak: "break-all" }}>
            {getSuperAdminUsername()}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={handleLogout}
              className="btn-secondary"
              style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: "0.8rem" }}
            >
              <LogOut size={14} /> Log out
            </button>
            {(() => {
              const ThemeIcon = getThemeIcon(theme);
              const label = theme === "light" ? "Switch to dark mode" : theme === "dark" ? "Switch to system mode" : "Switch to light mode";
              return (
                <button
                  onClick={toggleTheme}
                  className="btn-secondary"
                  title={label}
                  aria-label={label}
                  style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 0.5rem" }}
                >
                  <ThemeIcon size={14} />
                </button>
              );
            })()}
          </div>
        </div>
      </aside>

      <main style={{ flex: 1, padding: "1.75rem", overflow: "auto" }}>
        <Outlet />
      </main>
    </div>
  );
}
