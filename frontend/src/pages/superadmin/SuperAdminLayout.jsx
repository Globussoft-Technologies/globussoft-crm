import { useEffect, useRef, useState } from "react";
import { Outlet, useNavigate, NavLink, useLocation } from "react-router-dom";
import { ShieldCheck, Clock, LogOut, BarChart3, Activity, Sun, Moon, Monitor, Bot, CreditCard, Building2, Key, PanelsTopLeft, UsersRound, Eye, TrendingUp, Trash2, ClipboardList, Menu, X } from "lucide-react";
import {
  getSuperAdminToken,
  getSuperAdminUsername,
  clearSuperAdminSession,
  superAdminFetch,
} from "../../utils/superAdminApi";
import "./super-admin.css";

// Sidebar modules. Add a new module by appending one entry here + one
// <Route> in App.jsx; nothing else in this shell needs to change.
const MODULES = [
  { path: "/super-admin/cron", label: "Cron Maintenance", icon: Clock },
  { path: "/super-admin/cron-analytics", label: "Cron Analytics", icon: BarChart3 },
  { path: "/super-admin/api-analytics", label: "API Analytics", icon: Activity },
  { path: "/super-admin/ai-management", label: "AI Management", icon: Bot },
  { path: "/super-admin/ai-management/api-keys", label: "API Key Management", icon: Key },
  { path: "/super-admin/ai-management/plans", label: "AI Subscription Plans", icon: CreditCard },
  { path: "/super-admin/tenant-management", label: "Tenant Management", icon: Building2 },
  { path: "/super-admin/organization-deletion", label: "Delete Organization", icon: Trash2 },
  { path: "/super-admin/organization-audit-log", label: "Organization Audit Log", icon: ClipboardList },
  { path: "/super-admin/role-management", label: "Role Management", icon: UsersRound },
  { path: "/super-admin/page-visibility", label: "Page Visibility", icon: Eye },
  { path: "/super-admin/revenue", label: "Revenue Analytics", icon: TrendingUp },
  { path: "/super-admin/landing-form", label: "Landing Page Form", icon: PanelsTopLeft },
  { path: "/super-admin/generic-chat-knowledge", label: "CRM Chatbox Knowledge", icon: Bot },
];

function getThemeIcon(theme) {
  if (theme === "light") return Sun;
  if (theme === "dark") return Moon;
  return Monitor;
}

function isModuleActive(pathname, modulePath) {
  if (modulePath === "/super-admin/ai-management") {
    return pathname === modulePath || /^\/super-admin\/ai-management\/\d+$/.test(pathname);
  }
  return pathname === modulePath;
}

export default function SuperAdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuToggleRef = useRef(null);
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

  useEffect(() => {
    if (!mobileMenuOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
        mobileMenuToggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenuOpen]);

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
    <div className="super-admin-shell">
      <header className="super-admin-mobile-header">
        <div className="super-admin-sidebar__brand">
          <ShieldCheck size={20} color="var(--accent-color, #3b82f6)" />
          <span>Super Admin</span>
        </div>
        <button
          type="button"
          className="super-admin-mobile-menu-toggle btn-secondary"
          ref={mobileMenuToggleRef}
          onClick={() => setMobileMenuOpen((open) => !open)}
          aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={mobileMenuOpen}
          aria-controls="super-admin-navigation"
        >
          {mobileMenuOpen ? <X size={19} /> : <Menu size={19} />}
        </button>
      </header>

      {mobileMenuOpen && (
        <button
          type="button"
          className="super-admin-mobile-backdrop"
          onClick={() => {
            setMobileMenuOpen(false);
            mobileMenuToggleRef.current?.focus();
          }}
          aria-label="Close navigation menu"
        />
      )}

      <aside id="super-admin-navigation" className={`super-admin-sidebar${mobileMenuOpen ? " is-open" : ""}`} aria-label="Super admin navigation">
        <div className="super-admin-sidebar__brand">
          <ShieldCheck size={20} color="var(--accent-color, #3b82f6)" />
          <span>Super Admin</span>
        </div>

        <nav className="super-admin-sidebar__nav">
          {MODULES.map((m) => {
            const active = isModuleActive(location.pathname, m.path);
            return (
              <NavLink
                key={m.path}
                to={m.path}
                aria-current={active ? "page" : undefined}
                className="super-admin-sidebar__link"
                onClick={() => {
                  setMobileMenuOpen(false);
                  mobileMenuToggleRef.current?.focus();
                }}
              >
                <m.icon size={16} />
                {m.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="super-admin-sidebar__footer">
          <div className="super-admin-sidebar__username">
            {getSuperAdminUsername()}
          </div>
          <div className="super-admin-sidebar__actions">
            <button
              onClick={handleLogout}
              className="btn-secondary super-admin-sidebar__logout"
            >
              <LogOut size={14} /> Log out
            </button>
            {(() => {
              const ThemeIcon = getThemeIcon(theme);
              const label = theme === "light" ? "Switch to dark mode" : theme === "dark" ? "Switch to system mode" : "Switch to light mode";
              return (
                <button
                  onClick={toggleTheme}
                  className="btn-secondary super-admin-sidebar__theme-toggle"
                  title={label}
                  aria-label={label}
                >
                  <ThemeIcon size={14} />
                </button>
              );
            })()}
          </div>
        </div>
      </aside>

      <main className="super-admin-main">
        <Outlet />
      </main>
    </div>
  );
}

