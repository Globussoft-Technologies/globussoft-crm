import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Clock3,
  CreditCard,
  ExternalLink,
  Bell,
  LayoutDashboard,
  Loader2,
  LogOut,
  Map,
  Moon,
  Plane,
  ReceiptText,
  RefreshCw,
  Search,
  Sun,
  UserRound,
  WalletCards,
} from "lucide-react";
import {
  TRAVEL_PAYMENT_SYNC_CHANNEL,
  TRAVEL_PAYMENT_SYNC_EVENT,
} from "../../utils/travelPaymentSync";

const TOKEN_KEY = "tmcParentPortalToken";
const THEME_KEY = "tmcParentPortalTheme";

const parentThemeVars = {
  light: {
    "--tmc-parent-bg": "#f6f7fb",
    "--tmc-parent-surface": "#ffffff",
    "--tmc-parent-surface-soft": "#f4f7fa",
    "--tmc-parent-text": "#122647",
    "--tmc-parent-heading": "#122647",
    "--tmc-parent-muted": "#66758a",
    "--tmc-parent-subtle": "#33445d",
    "--tmc-parent-border": "#dfe5ec",
    "--tmc-parent-border-strong": "#d4dce5",
    "--tmc-parent-border-light": "#edf0f4",
    "--tmc-parent-primary": "#315878",
    "--tmc-parent-primary-contrast": "#ffffff",
    "--tmc-parent-accent": "#c8ef24",
    "--tmc-parent-accent-contrast": "#122647",
    "--tmc-parent-profile-bg": "#eef3f6",
    "--tmc-parent-input-bg": "#ffffff",
    "--tmc-parent-success": "#008f66",
    "--tmc-parent-success-bg": "#e3f3ea",
    "--tmc-parent-danger": "#d84343",
    "--tmc-parent-pending": "#9b5e00",
    "--tmc-parent-pending-bg": "#fff1da",
    "--tmc-parent-error-bg": "#fff1f1",
    "--tmc-parent-error-text": "#a8323f",
    "--tmc-parent-error-border": "#f1c6c6",
    "--tmc-parent-shadow": "0 18px 50px rgba(18, 38, 71, 0.10)",
  },
  dark: {
    "--tmc-parent-bg": "#111827",
    "--tmc-parent-surface": "#1b2638",
    "--tmc-parent-surface-soft": "#223247",
    "--tmc-parent-text": "#e6edf5",
    "--tmc-parent-heading": "#f8fafc",
    "--tmc-parent-muted": "#a8b6c8",
    "--tmc-parent-subtle": "#c6d1df",
    "--tmc-parent-border": "rgba(148, 163, 184, 0.25)",
    "--tmc-parent-border-strong": "rgba(167, 187, 207, 0.42)",
    "--tmc-parent-border-light": "rgba(148, 163, 184, 0.16)",
    "--tmc-parent-primary": "#79a8cf",
    "--tmc-parent-primary-contrast": "#102033",
    "--tmc-parent-accent": "#b8dc62",
    "--tmc-parent-accent-contrast": "#162032",
    "--tmc-parent-profile-bg": "rgba(121, 168, 207, 0.14)",
    "--tmc-parent-input-bg": "#172235",
    "--tmc-parent-success": "#53c99d",
    "--tmc-parent-success-bg": "rgba(83, 201, 157, 0.15)",
    "--tmc-parent-danger": "#ff8d8d",
    "--tmc-parent-pending": "#f4bc67",
    "--tmc-parent-pending-bg": "rgba(244, 188, 103, 0.15)",
    "--tmc-parent-error-bg": "rgba(255, 141, 141, 0.12)",
    "--tmc-parent-error-text": "#ffb0b0",
    "--tmc-parent-error-border": "rgba(255, 141, 141, 0.34)",
    "--tmc-parent-shadow": "0 18px 50px rgba(0, 0, 0, 0.28)",
  },
};

const portalInteractionStyles = `
  [data-tmc-parent-portal="true"] button:not([disabled]):not([data-tmc-no-hover]),
  [data-tmc-parent-portal="true"] a {
    transition: transform 160ms ease, box-shadow 160ms ease, filter 160ms ease, opacity 160ms ease;
  }

  [data-tmc-parent-portal="true"] button:not([disabled]):not([data-tmc-no-hover]):hover,
  [data-tmc-parent-portal="true"] a:hover {
    transform: translateY(-1px);
    box-shadow: 0 8px 18px rgba(18, 38, 71, 0.10);
    filter: brightness(1.03);
  }

  [data-tmc-parent-portal="true"] button:not([disabled]):not([data-tmc-no-hover]):active,
  [data-tmc-parent-portal="true"] a:active {
    transform: translateY(0);
    transition-duration: 80ms;
  }

  [data-tmc-parent-portal="true"] a:hover {
    box-shadow: none;
  }

  [data-tmc-parent-portal="true"] button:focus-visible,
  [data-tmc-parent-portal="true"] a:focus-visible,
  [data-tmc-parent-portal="true"] input:focus-visible {
    outline: 3px solid rgba(200, 239, 36, 0.7);
    outline-offset: 2px;
  }

  [data-tmc-parent-portal="true"][data-theme-mode="dark"] button:not([disabled]):not([data-tmc-no-hover]):hover {
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28);
  }

  @media (prefers-reduced-motion: reduce) {
    [data-tmc-parent-portal="true"] button,
    [data-tmc-parent-portal="true"] a {
      transition: none;
    }
  }

  @media (max-width: 820px) {
    [data-tmc-parent-portal="true"] {
      display: block !important;
    }

    [data-tmc-parent-portal="true"] aside {
      position: static !important;
      width: auto !important;
      min-height: auto !important;
      border-right: 0 !important;
      border-bottom: 1px solid var(--tmc-parent-border) !important;
      padding: 14px !important;
    }

    [data-tmc-parent-portal="true"] aside nav {
      display: flex !important;
      overflow-x: auto;
    }

    [data-tmc-parent-portal="true"] aside nav button {
      white-space: nowrap;
    }

    [data-tmc-parent-portal="true"] main {
      padding: 18px !important;
    }

    [data-tmc-parent-portal="true"] [data-tmc-parent-grid="true"] {
      grid-template-columns: 1fr !important;
    }

    [data-tmc-parent-portal="true"] [data-tmc-installment="true"] {
      grid-template-columns: 1fr 1fr !important;
    }
  }

  @media (max-width: 520px) {
    [data-tmc-parent-portal="true"] [data-tmc-installment="true"] {
      grid-template-columns: 1fr !important;
    }

    [data-tmc-parent-portal="true"] [data-tmc-payment-overview="true"] {
      grid-template-columns: 1fr !important;
    }
  }
`;

async function api(path, token, { method = "GET", body } = {}) {
  const response = await fetch(`/api/portal/tmc${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || "Request failed"), {
      status: response.status,
      code: data.code,
    });
  }
  return data;
}

async function travelApi(path, token, { method = "GET", body } = {}) {
  const response = await fetch(`/api/portal${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || "Request failed"), {
      status: response.status,
      code: data.code,
    });
  }
  return data;
}

function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export default function TmcParentPortal() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [themeMode, setThemeMode] = useState(readTheme);
  const [contact, setContact] = useState(null);
  const [portalData, setPortalData] = useState({
    trips: [],
    parentLinks: [],
    registrations: [],
    participants: [],
  });
  const [bookings, setBookings] = useState([]);
  const [activeView, setActiveView] = useState("dashboard");
  const [selectedBookingId, setSelectedBookingId] = useState(null);
  const [form, setForm] = useState({ email: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, themeMode);
    } catch {
      // Theme persistence is optional when storage is unavailable.
    }
  }, [themeMode]);

  const logout = useCallback((message = "") => {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setContact(null);
    setPortalData({ trips: [], parentLinks: [], registrations: [], participants: [] });
    setBookings([]);
    setSelectedBookingId(null);
    setActiveView("dashboard");
    setError(message);
  }, []);

  const load = useCallback(async (options = {}) => {
    if (!token) return;
    const silent = options?.silent === true;
    if (!silent) setLoading(true);
    setError("");
    try {
      const [meResult, tripsResult, bookingsResult] = await Promise.all([
        api("/parent/me", token),
        api("/parent/trips", token),
        travelApi("/travel/bookings", token),
      ]);
      setContact(meResult.contact || null);
      setPortalData({
        trips: Array.isArray(tripsResult.trips) ? tripsResult.trips : [],
        parentLinks: Array.isArray(tripsResult.parentLinks) ? tripsResult.parentLinks : [],
        registrations: Array.isArray(tripsResult.registrations) ? tripsResult.registrations : [],
        participants: Array.isArray(tripsResult.participants) ? tripsResult.participants : [],
      });
      setBookings(Array.isArray(bookingsResult) ? bookingsResult : []);
    } catch (err) {
      if (err.status === 401 || err.status === 403 || err.status === 404) {
        logout(err.status === 403
          ? "This account is not registered as a TMC parent. Please use the parent registration link from your teacher."
          : "Your parent session has expired. Please sign in again.");
      } else {
        setError(err.message || "Unable to load your parent portal.");
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [logout, token]);

  useEffect(() => {
    if (token) load();
  }, [load, token]);

  // Payment opens in a separate tab, just like the customer portal. Refresh
  // immediately when the payment success page broadcasts, then retry briefly
  // so the UI catches a delayed webhook without asking the parent to pay again.
  useEffect(() => {
    if (!token) return undefined;
    let burstTimer = null;
    const stopBurst = () => {
      if (burstTimer !== null) {
        window.clearInterval(burstTimer);
        burstTimer = null;
      }
    };
    const refresh = () => {
      if (document.visibilityState === "visible") load({ silent: true });
    };
    const refreshBurst = () => {
      stopBurst();
      refresh();
      let attempts = 0;
      burstTimer = window.setInterval(() => {
        attempts += 1;
        if (document.visibilityState !== "visible" || attempts >= 8) {
          stopBurst();
          return;
        }
        refresh();
      }, 1000);
    };
    const handleMessage = (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== TRAVEL_PAYMENT_SYNC_EVENT) return;
      refreshBurst();
    };
    const handleChannelMessage = (event) => {
      if (event.data?.type === TRAVEL_PAYMENT_SYNC_EVENT) refreshBurst();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshBurst();
    };
    let channel = null;
    try {
      if (typeof window.BroadcastChannel === "function") {
        channel = new window.BroadcastChannel(TRAVEL_PAYMENT_SYNC_CHANNEL);
        channel.addEventListener("message", handleChannelMessage);
      }
    } catch (_err) {
      channel = null;
    }
    const interval = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refreshBurst);
    window.addEventListener("pageshow", refreshBurst);
    window.addEventListener("message", handleMessage);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopBurst();
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshBurst);
      window.removeEventListener("pageshow", refreshBurst);
      window.removeEventListener("message", handleMessage);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      channel?.removeEventListener("message", handleChannelMessage);
      channel?.close();
    };
  }, [load, token]);

  useEffect(() => {
    if (activeView !== "bookings") setSelectedBookingId(null);
  }, [activeView]);

  const login = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, portalRole: "PARENT" }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.token) throw new Error(result.error || "Invalid credentials");
      localStorage.setItem(TOKEN_KEY, result.token);
      setToken(result.token);
    } catch (err) {
      setError(err.message || "Unable to sign in.");
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div data-tmc-parent-portal="true" data-theme-mode={themeMode} style={{ ...styles.authPage, ...parentThemeVars[themeMode] }}>
        <style>{portalInteractionStyles}</style>
        <form onSubmit={login} style={styles.authCard}>
          <div style={styles.authBrand}><Plane size={27} /> <strong>Parent Portal</strong></div>
          <div>
            <h1 style={styles.authTitle}>Welcome back</h1>
            <p style={styles.muted}>Sign in to manage your child&apos;s trips, registrations, and payments.</p>
          </div>
          {error && <div role="alert" style={styles.error}>{error}</div>}
          <label style={styles.label}>Email<input aria-label="Email" type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} required style={styles.input} /></label>
          <label style={styles.label}>Password<input aria-label="Password" type="password" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} required style={styles.input} /></label>
          <button type="submit" style={styles.primary} disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button>
        </form>
      </div>
    );
  }

  const trips = portalData.trips.length ? portalData.trips : portalData.parentLinks;
  const selectedBooking = bookings.find((booking) => String(booking.id) === String(selectedBookingId));
  const viewTitle = activeView === "dashboard"
    ? "Dashboard"
    : activeView === "trips"
      ? "Trips"
      : activeView === "bookings"
        ? "My Bookings"
        : "My Profile";

  return (
    <div data-tmc-parent-portal="true" data-theme-mode={themeMode} style={{ ...styles.page, ...parentThemeVars[themeMode] }}>
      <style>{portalInteractionStyles}</style>
      <aside style={styles.sidebar}>
        <div style={styles.brand}><Plane size={21} /> <strong>Parent Portal</strong></div>
        <div style={styles.profileCard}>
          <div style={styles.avatar}>{(contact?.name || "P").slice(0, 1).toUpperCase()}</div>
          <div style={styles.profileText}><strong>{contact?.name || "Parent"}</strong><span>{contact?.email || ""}</span></div>
        </div>
        <nav aria-label="Parent portal sections" style={styles.sidebarNav}>
          <PortalNavButton icon={LayoutDashboard} label="Dashboard" active={activeView === "dashboard"} onClick={() => setActiveView("dashboard")} />
          <PortalNavButton icon={Map} label="Trips" active={activeView === "trips"} onClick={() => setActiveView("trips")} />
          <PortalNavButton icon={ReceiptText} label="My Bookings" count={bookings.length} active={activeView === "bookings"} onClick={() => setActiveView("bookings")} />
        </nav>
        <div style={styles.sidebarFooter}>Use this portal to explore school trips, complete registrations, and keep track of payments.</div>
      </aside>

      <div style={styles.shell}>
        <header style={styles.header}>
          <div><span style={styles.eyebrow}>Parent workspace</span><h1 style={styles.headerTitle}>{viewTitle}</h1></div>
          <div style={styles.headerActions}>
            <button type="button" onClick={load} style={styles.secondary} disabled={loading}><RefreshCw size={15} /> {loading ? "Refreshing..." : "Refresh"}</button>
            <ParentNotificationBell token={token} onNavigate={setActiveView} />
            <ThemeToggleButton theme={themeMode} onToggle={() => setThemeMode((current) => current === "dark" ? "light" : "dark")} />
            <button type="button" onClick={() => setActiveView("profile")} style={{ ...styles.profilePill, ...(activeView === "profile" ? styles.profilePillActive : {}) }} aria-label="Open profile" title="Open profile">
              <span style={styles.headerAvatar}>{(contact?.name || "P").slice(0, 1).toUpperCase()}</span>
              <span style={styles.profilePillText}><strong>{contact?.name || "Parent"}</strong><ChevronDown size={14} aria-hidden /></span>
            </button>
            <button type="button" onClick={() => logout()} style={styles.iconButton} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>
          </div>
        </header>

        <main style={styles.main}>
          {error && <div role="alert" style={styles.error}>{error}</div>}
          {activeView === "dashboard" && <DashboardView contact={contact} trips={trips} bookings={bookings} registrations={portalData.registrations} onNavigate={setActiveView} onOpenBooking={(id) => { setActiveView("bookings"); setSelectedBookingId(id); }} />}
          {activeView === "trips" && <TripsView trips={trips} loading={loading} />}
          {activeView === "bookings" && (selectedBooking ? <BookingDetail booking={selectedBooking} onBack={() => setSelectedBookingId(null)} /> : <BookingsView bookings={bookings} loading={loading} onSelect={setSelectedBookingId} />)}
          {activeView === "profile" && <ParentProfileView contact={contact} />}
        </main>
      </div>
    </div>
  );
}

function PortalNavButton({ icon: Icon, label, count, active, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? "page" : undefined} style={{ ...styles.navButton, ...(active ? styles.navButtonActive : {}) }}>
      <Icon size={17} />
      <span>{label}</span>
      {count > 0 && <span style={styles.navCount}>{count > 9 ? "9+" : count}</span>}
    </button>
  );
}

function ThemeToggleButton({ theme, onToggle }) {
  const goingDark = theme !== "dark";
  return (
    <button
      type="button"
      onClick={onToggle}
      style={styles.iconButton}
      title={goingDark ? "Switch to dark mode" : "Switch to light mode"}
      aria-label={goingDark ? "Switch to dark mode" : "Switch to light mode"}
      aria-pressed={theme === "dark"}
    >
      {goingDark ? <Moon size={16} aria-hidden /> : <Sun size={16} aria-hidden />}
    </button>
  );
}

function ParentNotificationBell({ token, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(() => {
    travelApi("/travel/notifications?limit=30", token)
      .then((result) => {
        setItems(Array.isArray(result.notifications) ? result.notifications : []);
        setUnread(Number(result.unreadCount) || 0);
      })
      .catch(() => {
        // Notifications are optional; the rest of the parent portal stays usable.
      });
  }, [token]);

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 45000);
    return () => window.clearInterval(interval);
  }, [load]);

  const markRead = async (notification) => {
    if (notification.isRead) return;
    try {
      await travelApi(`/travel/notifications/${notification.id}/read`, token, { method: "PUT" });
      setItems((current) => current.map((item) => (
        item.id === notification.id ? { ...item, isRead: true } : item
      )));
      setUnread((current) => Math.max(0, current - 1));
    } catch {
      // Keep the notification unread if the read update fails.
    }
  };

  const openNotification = (notification) => {
    markRead(notification);
    setOpen(false);
    if (["dashboard", "trips", "bookings", "profile"].includes(notification.link)) {
      onNavigate(notification.link);
    }
  };

  const markAllRead = async () => {
    try {
      await travelApi("/travel/notifications/mark-all-read", token, { method: "POST" });
      setItems((current) => current.map((item) => ({ ...item, isRead: true })));
      setUnread(0);
    } catch {
      // Non-blocking action; the next poll will refresh the count.
    }
  };

  return (
    <div style={styles.notificationWrap}>
      <button
        type="button"
        onClick={() => { setOpen((current) => !current); load(); }}
        style={styles.iconButton}
        title="Notifications"
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        aria-expanded={open}
      >
        <Bell size={16} aria-hidden />
        {unread > 0 && <span style={styles.notificationBadge}>{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <>
          <button type="button" onClick={() => setOpen(false)} style={styles.notificationBackdrop} data-tmc-no-hover aria-label="Close notifications" />
          <div role="dialog" aria-label="Notifications" style={styles.notificationPanel}>
            <div style={styles.notificationHeader}>
              <strong>Notifications</strong>
              {unread > 0 && <button type="button" onClick={markAllRead} style={styles.markRead}>Mark all read</button>}
            </div>
            {items.length === 0 ? (
              <div style={styles.notificationEmpty}>No notifications yet.</div>
            ) : items.map((notification) => (
              <button
                key={notification.id}
                type="button"
                onClick={() => openNotification(notification)}
                style={{ ...styles.notificationItem, ...(notification.isRead ? {} : styles.notificationItemUnread) }}
              >
                <span style={styles.notificationItemTitle}>
                  {!notification.isRead && <span style={styles.unreadDot} aria-hidden />}
                  {notification.title || "Parent portal update"}
                </span>
                {notification.body && <span style={styles.notificationItemBody}>{notification.body}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ParentProfileView({ contact }) {
  const name = contact?.name || "Parent";
  return (
    <div style={styles.profilePage}>
      <section style={styles.profileHero}>
        <div style={styles.profileHeroAvatar}>{name.slice(0, 1).toUpperCase()}</div>
        <div>
          <h2 style={styles.profileName}>{name}</h2>
          <p style={styles.muted}>{contact?.email || "No email provided"}</p>
        </div>
      </section>
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <div><h2 style={styles.cardTitle}>Profile details</h2><p style={styles.muted}>The account details linked to your parent portal.</p></div>
          <UserRound size={20} color={styles.colors.primary} />
        </div>
        <dl style={styles.profileDetails}>
          <div><dt style={styles.profileLabel}>Name</dt><dd style={styles.profileValue}>{name}</dd></div>
          <div><dt style={styles.profileLabel}>Email</dt><dd style={styles.profileValue}>{contact?.email || "Not provided"}</dd></div>
          <div><dt style={styles.profileLabel}>Portal access</dt><dd style={styles.profileValue}>TMC Parent</dd></div>
        </dl>
      </section>
    </div>
  );
}

function DashboardView({ contact, trips, bookings, registrations, onNavigate, onOpenBooking }) {
  const firstName = (contact?.name || "Parent").split(" ")[0];
  const nextBooking = [...bookings].sort((left, right) => dateValue(left.startDate) - dateValue(right.startDate))[0];
  const pendingPayments = bookings.reduce((sum, booking) => sum + getPaymentSummary(booking).pending, 0);
  const pendingRegistrations = registrations.filter((row) => String(row.status || "").toUpperCase() !== "REJECTED").length;

  return (
    <div style={styles.contentStack}>
      <section style={styles.hero}>
        <div>
          <span style={styles.eyebrow}>Your family travel workspace</span>
          <h2 style={styles.heroTitle}>Welcome, {firstName}!</h2>
          <p style={styles.heroText}>Explore your child&apos;s school trips and stay on top of every registration and payment.</p>
        </div>
        <button type="button" onClick={() => onNavigate("trips")} style={styles.primary}><Map size={16} /> Explore trips</button>
      </section>

      <div data-tmc-parent-grid="true" style={styles.statsGrid}>
        <StatCard icon={Map} label="Trips shared with you" value={trips.length} hint="Open a trip to register" />
        <StatCard icon={ReceiptText} label="My bookings" value={bookings.length} hint="Registered school trips" />
        <StatCard icon={WalletCards} label="Pending payments" value={formatMoney(pendingPayments)} hint={pendingRegistrations ? `${pendingRegistrations} registration${pendingRegistrations === 1 ? "" : "s"} in progress` : "You're all caught up"} />
      </div>

      <div data-tmc-parent-grid="true" style={styles.twoColumnGrid}>
        <section style={styles.card}>
          <div style={styles.cardHeader}><div><h2 style={styles.cardTitle}>Upcoming trip</h2><p style={styles.muted}>Your next registered school trip.</p></div><button type="button" onClick={() => onNavigate("bookings")} style={styles.textButton}>View bookings <ChevronRight size={15} /></button></div>
          {nextBooking ? <TripSummary booking={nextBooking} onClick={() => onOpenBooking(nextBooking.id)} /> : <EmptyState icon={CalendarDays} title="No upcoming trips yet" text="When a registration is approved, it will appear here." action="View trips" onClick={() => onNavigate("trips")} />}
        </section>
        <section style={styles.card}>
          <div style={styles.cardHeader}><div><h2 style={styles.cardTitle}>Payment overview</h2><p style={styles.muted}>A quick view of your trip payment status.</p></div><CreditCard size={19} color={styles.colors.primary} /></div>
          <div data-tmc-payment-overview="true" style={styles.paymentOverview}>
            <PaymentMetric label="Total registered" value={formatMoney(bookings.reduce((sum, booking) => sum + getPaymentSummary(booking).total, 0))} />
            <PaymentMetric label="Paid so far" value={formatMoney(bookings.reduce((sum, booking) => sum + getPaymentSummary(booking).paid, 0))} color={styles.colors.success} />
            <PaymentMetric label="Balance due" value={formatMoney(pendingPayments)} color={pendingPayments > 0 ? styles.colors.danger : styles.colors.success} />
          </div>
          <div style={styles.paymentAction}>
            <button type="button" onClick={() => onNavigate("bookings")} style={styles.secondaryWide}>Open payment details <ChevronRight size={15} /></button>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, hint }) {
  return <div style={styles.statCard}><div style={styles.statIcon}><Icon size={18} /></div><div style={styles.statCopy}><span>{label}</span><strong>{value}</strong><small>{hint}</small></div></div>;
}

function PaymentMetric({ label, value, color }) {
  return <div style={styles.paymentMetric}><span style={styles.paymentMetricLabel}>{label}</span><strong style={{ ...styles.paymentMetricValue, ...(color ? { color } : {}) }}>{value}</strong></div>;
}

function TripsView({ trips, loading }) {
  const [query, setQuery] = useState("");
  const filteredTrips = useMemo(() => {
    const term = query.trim().toLowerCase();
    return trips.filter((row) => {
      const trip = row.trip || row;
      return !term || [trip.destination, trip.tripCode, row.teacher?.name].filter(Boolean).join(" ").toLowerCase().includes(term);
    });
  }, [query, trips]);

  return (
    <div style={styles.contentStack}>
      <section style={styles.pageIntro}><div><h2 style={styles.pageTitle}>Trips</h2><p style={styles.muted}>Trips shared with you by your teacher. Open a trip to view its registration page.</p></div><span style={styles.countPill}>{trips.length} {trips.length === 1 ? "trip" : "trips"}</span></section>
      <div style={styles.searchWrap}><Search size={16} aria-hidden /><input type="search" aria-label="Search trips" placeholder="Search by destination..." value={query} onChange={(event) => setQuery(event.target.value)} style={styles.searchInput} /></div>
      <section style={styles.card}>
        {loading && trips.length === 0 ? <LoadingState /> : filteredTrips.length === 0 ? <EmptyState icon={Map} title={query ? "No trips match your search" : "No trips shared yet"} text={query ? "Try another destination or trip code." : "Your teacher's shared registration trips will appear here."} /> : <div style={styles.list}>{filteredTrips.map((row) => <TripCard key={`${row.tripId || row.trip?.id || row.id}`} row={row} />)}</div>}
      </section>
    </div>
  );
}

function TripCard({ row }) {
  const trip = row.trip || row;
  const landingUrl = row.landingUrl || (trip.landingPage?.status === "PUBLISHED" && trip.landingPage.id != null ? `/trips/${encodeURIComponent(String(trip.landingPage.id))}` : null);
  return (
    <div style={styles.tripCard}>
      <div style={styles.tripCardIcon}><Plane size={22} /></div>
      <div style={styles.tripCardContent}><div style={styles.tripCardTop}><div><h3 style={styles.tripTitle}>{trip.destination || trip.tripCode || "School trip"}</h3><span style={styles.muted}>{trip.tripCode || "TMC trip"}</span></div></div><div style={styles.tripMeta}><span style={styles.tripMetaItem}><CalendarDays size={14} /> {formatDateRange(trip.departDate, trip.returnDate)}</span>{row.teacher?.name && <span style={styles.tripMetaItem}>Teacher: {row.teacher.name}</span>}</div></div>
      {landingUrl ? <a href={landingUrl} style={styles.tripAction}><span>View trip & register</span><ExternalLink size={15} /></a> : <span style={styles.unavailable}>Registration page unavailable</span>}
    </div>
  );
}

function BookingsView({ bookings, loading, onSelect }) {
  const [query, setQuery] = useState("");
  const filteredBookings = useMemo(() => {
    const term = query.trim().toLowerCase();
    return bookings.filter((booking) => !term || String(booking.destination || "").toLowerCase().includes(term));
  }, [bookings, query]);

  return (
    <div style={styles.contentStack}>
      <section style={styles.pageIntro}><div><h2 style={styles.pageTitle}>My Bookings</h2><p style={styles.muted}>Track your child&apos;s registration status and complete trip payments.</p></div><span style={styles.countPill}>{bookings.length} {bookings.length === 1 ? "booking" : "bookings"}</span></section>
      <div style={styles.searchWrap}><Search size={16} aria-hidden /><input type="search" aria-label="Search bookings" placeholder="Search by location..." value={query} onChange={(event) => setQuery(event.target.value)} style={styles.searchInput} /></div>
      <section style={styles.card}>
        {loading && bookings.length === 0 ? <LoadingState /> : filteredBookings.length === 0 ? <EmptyState icon={ReceiptText} title={query ? "No bookings match your search" : "No bookings yet"} text={query ? "Try another destination." : "Your registered trips will appear here once you complete a registration."} /> : <div style={styles.list}>{filteredBookings.map((booking) => <BookingCard key={booking.id} booking={booking} onSelect={onSelect} />)}</div>}
      </section>
    </div>
  );
}

function BookingCard({ booking, onSelect }) {
  const summary = getPaymentSummary(booking);
  return <button type="button" onClick={() => onSelect(booking.id)} aria-label={`View ${booking.destination || "booking"} details`} style={styles.bookingCard}><div><strong>{booking.destination || "School trip"}</strong><span>{formatDateRange(booking.startDate, booking.endDate)}</span><b>{formatMoney(summary.total, booking.currency)}</b></div><div style={styles.bookingCardRight}><span style={styles.textButton}>View details <ChevronRight size={15} /></span></div></button>;
}

function BookingDetail({ booking, onBack }) {
  const summary = getPaymentSummary(booking);
  const installments = getInstallments(booking);
  return (
    <div style={styles.contentStack}>
      <button type="button" onClick={onBack} style={styles.backButton}><ChevronLeft size={16} /> Back to bookings</button>
      <section style={styles.detailHero}><div style={styles.detailHeroIcon}><Plane size={28} /></div><div style={styles.detailHeroContent}><h2 style={styles.detailTitle}>{booking.destination || "Your trip"}</h2><p style={styles.muted}>{formatDateRange(booking.startDate, booking.endDate)}</p></div></section>
      <section style={styles.card}><h2 style={styles.cardTitle}>Trip cost</h2><dl style={styles.costList}><div style={styles.costItem}><dt style={styles.costLabel}>Per person</dt><dd style={styles.costValue}>{formatMoney(summary.total, booking.currency)}</dd></div><div style={styles.costItem}><dt style={styles.costLabel}>Paid so far</dt><dd style={{ ...styles.costValue, color: styles.colors.success }}>{formatMoney(summary.paid, booking.currency)}</dd></div><div style={styles.costItem}><dt style={styles.costLabel}>Balance due</dt><dd style={styles.costValue}>{formatMoney(summary.pending, booking.currency)}</dd></div></dl><div data-tmc-parent-grid="true" style={styles.paymentSummaryGrid}><PaymentSummaryCard label="Total amount" amount={summary.total} currency={booking.currency} /><PaymentSummaryCard label="Paid" amount={summary.paid} currency={booking.currency} color={styles.colors.success} /><PaymentSummaryCard label="Pending" amount={summary.pending} currency={booking.currency} color={summary.pending > 0 ? styles.colors.danger : styles.colors.success} /></div></section>
      <section style={styles.card}><div style={styles.cardHeader}><div><h2 style={styles.cardTitle}>Payment schedule</h2><p style={styles.muted}>{installments.length ? "Review each installment and pay any outstanding balance." : "Your payment schedule will appear here once it is set up."}</p></div><WalletCards size={20} color={styles.colors.primary} /></div>{installments.length ? <div>{installments.map((row) => <InstallmentRow key={row.id || row.instalmentIndex} row={row} booking={booking} />)}</div> : <EmptyState icon={Clock3} title="No installment schedule yet" text="Please contact your teacher or travel coordinator for payment details." />}</section>
    </div>
  );
}

function PaymentSummaryCard({ label, amount, currency, color }) {
  return <div style={styles.paymentSummaryCard}><span>{label}</span><strong style={color ? { color } : undefined}>{formatMoney(amount, currency)}</strong></div>;
}

function InstallmentRow({ row, booking }) {
  const amount = Number(row.amount || 0);
  const paid = paidForInstallment(row);
  const isPaid = String(row.status || "").toLowerCase() === "paid" || paid >= amount;
  const id = Number(row.id);
  const paymentUrl = row.paymentLinkUrl || (booking.tripId && Number.isInteger(id) && id > 0 ? `/pay/trip/${booking.tripId}/installment/${id}` : null);
  return (
    <div
      data-tmc-installment="true"
      style={{
        ...styles.installmentRow,
        ...(isPaid ? styles.installmentPaidRow : styles.installmentPendingRow),
        borderLeftColor: isPaid ? styles.colors.success : styles.colors.accent,
        background: isPaid ? "var(--tmc-parent-success-bg)" : "var(--tmc-parent-surface)",
      }}
    >
      <div style={styles.installmentName}>
        <span
          style={{
            ...styles.installmentIcon,
            background: isPaid ? "var(--tmc-parent-success-bg)" : "var(--tmc-parent-profile-bg)",
            color: isPaid ? styles.colors.success : styles.colors.primary,
          }}
        >
          {isPaid ? <CheckCircle2 size={17} /> : String((row.instalmentIndex ?? 0) + 1).padStart(2, "0")}
        </span>
        <div style={styles.installmentNameText}>
          <strong style={styles.installmentValue}>Installment {(row.instalmentIndex ?? 0) + 1}</strong>
          <span style={{ ...styles.installmentStatus, color: isPaid ? styles.colors.success : styles.colors.primary }}>
            {isPaid ? "Paid" : "Upcoming"}
          </span>
        </div>
      </div>
      <div style={styles.installmentAmount}>
        <small style={styles.installmentLabel}>Amount</small>
        <strong style={styles.installmentValue}>{formatMoney(amount, booking.currency)}</strong>
        <small style={styles.installmentLabel}>Paid {formatMoney(paid, booking.currency)}</small>
      </div>
      <div style={styles.installmentDate}>
        <small style={styles.installmentLabel}>{isPaid ? "Paid on" : "Due before trip"}</small>
        <strong style={styles.installmentValue}>{row.paidAt ? formatDate(row.paidAt) : row.dueDate ? formatDate(row.dueDate) : "Date to be confirmed"}</strong>
      </div>
      <div style={styles.installmentAction} aria-hidden={isPaid}>
        {!isPaid && (paymentUrl ? (
          <a href={paymentUrl} target="_blank" rel="noreferrer" style={styles.payButton}>
            <CreditCard size={14} /> Pay now
          </a>
        ) : (
          <span style={styles.paidMark}>Payment link pending</span>
        ))}
      </div>
    </div>
  );
}

function TripSummary({ booking, onClick }) {
  const summary = getPaymentSummary(booking);
  return <button type="button" onClick={onClick} style={styles.summaryButton}><div style={styles.summaryButtonMain}><div style={styles.miniTripIcon}><Plane size={17} /></div><div><strong>{booking.destination || "School trip"}</strong><span>{formatDateRange(booking.startDate, booking.endDate)}</span></div></div><div style={styles.summaryButtonRight}><strong>{formatMoney(summary.pending, booking.currency)}</strong><span>balance due <ChevronRight size={14} /></span></div></button>;
}

function EmptyState({ icon: Icon, title, text, action, onClick }) {
  return <div style={styles.emptyState}><Icon size={24} color={styles.colors.primary} /><strong>{title}</strong><p>{text}</p>{action && <button type="button" onClick={onClick} style={styles.secondary}>{action}</button>}</div>;
}

function LoadingState() {
  return <div style={styles.loadingState}><Loader2 size={22} style={{ animation: "spin 1s linear infinite" }} /> Loading...</div>;
}

function getInstallments(booking) {
  return Array.isArray(booking?.instalments) ? booking.instalments : Array.isArray(booking?.installments) ? booking.installments : [];
}

function paidForInstallment(row) {
  const amount = Math.max(0, Number(row?.amount || 0));
  const recorded = Math.max(0, Number(row?.paidAmount || 0));
  if (recorded > 0) return Math.min(amount, recorded);
  return String(row?.status || "").toLowerCase() === "paid" ? amount : 0;
}

function getPaymentSummary(booking) {
  const installments = getInstallments(booking);
  const total = installments.length ? installments.reduce((sum, row) => sum + Number(row.amount || 0), 0) : Number(booking?.totalAmount || 0);
  const paid = installments.length ? installments.reduce((sum, row) => sum + paidForInstallment(row), 0) : Number(booking?.advancePaidAmount || 0);
  return { total, paid, pending: Math.max(0, total - paid) };
}

function formatMoney(amount, currency = "INR") {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency} ${Math.round(value).toLocaleString("en-IN")}`;
  }
}

function formatDate(value) {
  if (!value) return "Date to be confirmed";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Date to be confirmed" : parsed.toLocaleDateString();
}

function formatDateRange(start, end) {
  return `${formatDate(start)} → ${formatDate(end)}`;
}

function dateValue(value) {
  const timestamp = value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER;
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}

const styles = {
  colors: {
    primary: "var(--tmc-parent-primary)",
    accent: "var(--tmc-parent-accent)",
    success: "var(--tmc-parent-success)",
    danger: "var(--tmc-parent-danger)",
  },
  page: { minHeight: "100vh", display: "grid", gridTemplateColumns: "236px minmax(0, 1fr)", background: "var(--tmc-parent-bg)", color: "var(--tmc-parent-text)" },
  sidebar: { minHeight: "100vh", display: "flex", flexDirection: "column", padding: "18px 8px", boxSizing: "border-box", background: "var(--tmc-parent-surface)", borderRight: "1px solid var(--tmc-parent-border)" },
  brand: { display: "flex", alignItems: "center", gap: 9, padding: "8px 9px 22px", color: "var(--tmc-parent-heading)", fontSize: 16 },
  profileCard: { display: "flex", alignItems: "center", gap: 10, minWidth: 0, padding: "0 8px 22px", borderBottom: "1px solid var(--tmc-parent-border-light)" },
  avatar: { flex: "0 0 auto", width: 38, height: 38, display: "grid", placeItems: "center", borderRadius: "50%", background: "var(--tmc-parent-accent)", color: "var(--tmc-parent-accent-contrast)", fontWeight: 800 },
  profileText: { minWidth: 0, display: "grid", gap: 3, fontSize: 12 },
  sidebarNav: { display: "grid", gap: 5, marginTop: 22 },
  navButton: { width: "100%", display: "flex", alignItems: "center", gap: 11, padding: "11px 12px", border: 0, borderRadius: 9, background: "transparent", color: "var(--tmc-parent-subtle)", cursor: "pointer", fontSize: 13, fontWeight: 650, textAlign: "left" },
  navButtonActive: { background: "var(--tmc-parent-accent)", color: "var(--tmc-parent-accent-contrast)" },
  navCount: { minWidth: 19, height: 19, display: "inline-grid", placeItems: "center", marginLeft: "auto", padding: "0 5px", borderRadius: 10, background: "var(--tmc-parent-profile-bg)", fontSize: 11 },
  sidebarFooter: { marginTop: "auto", padding: "16px 10px 4px", borderTop: "1px solid var(--tmc-parent-border-light)", color: "var(--tmc-parent-muted)", fontSize: 11, lineHeight: 1.5 },
  shell: { minWidth: 0, minHeight: "100vh", display: "flex", flexDirection: "column" },
  header: { minHeight: 78, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "0 30px", background: "var(--tmc-parent-surface)", borderBottom: "1px solid var(--tmc-parent-border)" },
  headerActions: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  headerName: { maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, color: "var(--tmc-parent-subtle)" },
  headerTitle: { margin: 0, color: "var(--tmc-parent-heading)", fontSize: 20 },
  headerAvatar: { display: "grid", placeItems: "center", width: 25, height: 25, borderRadius: "50%", background: "var(--tmc-parent-primary)", color: "var(--tmc-parent-primary-contrast)", fontSize: 11, fontWeight: 800 },
  profilePill: { display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: 190, padding: "5px 9px 5px 6px", border: "1px solid var(--tmc-parent-border-strong)", borderRadius: 999, background: "var(--tmc-parent-surface)", color: "var(--tmc-parent-heading)", cursor: "pointer" },
  profilePillActive: { borderColor: "var(--tmc-parent-primary)", boxShadow: "0 0 0 2px var(--tmc-parent-profile-bg)" },
  profilePillText: { display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 },
  main: { width: "100%", maxWidth: 1120, boxSizing: "border-box", margin: "0 auto", padding: 30, display: "grid", alignContent: "start" },
  contentStack: { display: "grid", gap: 18 },
  hero: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, padding: 26, border: "1px solid var(--tmc-parent-border)", borderRadius: 16, background: "linear-gradient(115deg, var(--tmc-parent-surface) 0%, var(--tmc-parent-surface-soft) 100%)" },
  heroTitle: { margin: "5px 0 8px", fontSize: 29, color: "var(--tmc-parent-heading)" },
  heroText: { maxWidth: 550, margin: 0, color: "var(--tmc-parent-muted)", fontSize: 14, lineHeight: 1.55 },
  statsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 210px), 1fr))", gap: 13 },
  statCard: { minWidth: 0, display: "flex", alignItems: "flex-start", gap: 12, padding: 17, border: "1px solid var(--tmc-parent-border)", borderRadius: 12, background: "var(--tmc-parent-surface)" },
  statIcon: { flex: "0 0 auto", width: 34, height: 34, display: "grid", placeItems: "center", borderRadius: 9, background: "var(--tmc-parent-profile-bg)", color: "var(--tmc-parent-primary)" },
  statCopy: { minWidth: 0, display: "grid", gap: 3 },
  twoColumnGrid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 18 },
  card: { minWidth: 0, padding: 20, border: "1px solid var(--tmc-parent-border)", borderRadius: 14, background: "var(--tmc-parent-surface)" },
  cardHeader: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 15 },
  cardTitle: { margin: 0, color: "var(--tmc-parent-heading)", fontSize: 17 },
  pageIntro: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 },
  pageTitle: { margin: 0, color: "var(--tmc-parent-heading)", fontSize: 25 },
  countPill: { flex: "0 0 auto", padding: "7px 11px", borderRadius: 999, background: "var(--tmc-parent-profile-bg)", color: "var(--tmc-parent-heading)", fontSize: 12, fontWeight: 700 },
  searchWrap: { display: "flex", alignItems: "center", gap: 9, padding: "0 12px", border: "1px solid var(--tmc-parent-border)", borderRadius: 10, background: "var(--tmc-parent-input-bg)", color: "var(--tmc-parent-muted)" },
  searchInput: { flex: 1, minWidth: 0, padding: "10px 0", border: 0, outline: 0, background: "transparent", color: "var(--tmc-parent-text)", fontSize: 14 },
  list: { display: "grid", gap: 11 },
  tripCard: { display: "flex", alignItems: "center", gap: 14, minWidth: 0, padding: 15, border: "1px solid var(--tmc-parent-border)", borderRadius: 12, background: "var(--tmc-parent-surface)" },
  tripCardIcon: { flex: "0 0 auto", width: 44, height: 44, display: "grid", placeItems: "center", borderRadius: "50%", background: "var(--tmc-parent-primary)", color: "var(--tmc-parent-accent)" },
  tripCardContent: { flex: 1, minWidth: 0 },
  tripCardTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 },
  tripTitle: { margin: 0, color: "var(--tmc-parent-heading)", fontSize: 16 },
  tripMeta: { display: "flex", flexWrap: "wrap", gap: 12, marginTop: 10, color: "var(--tmc-parent-muted)", fontSize: 12 },
  tripMetaItem: { display: "inline-flex", alignItems: "center", gap: 5 },
  tripAction: { flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 11px", borderRadius: 8, background: "var(--tmc-parent-accent)", color: "var(--tmc-parent-accent-contrast)", fontSize: 12, fontWeight: 750, textDecoration: "none" },
  unavailable: { flex: "0 0 auto", color: "var(--tmc-parent-muted)", fontSize: 11 },
  bookingCard: { width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "14px 12px", border: "1px solid var(--tmc-parent-border)", borderRadius: 11, background: "var(--tmc-parent-surface)", color: "var(--tmc-parent-text)", cursor: "pointer", textAlign: "left" },
  bookingCardRight: { display: "grid", justifyItems: "end", gap: 9, flex: "0 0 auto" },
  textButton: { display: "inline-flex", alignItems: "center", gap: 4, border: 0, background: "transparent", color: "var(--tmc-parent-primary)", cursor: "pointer", fontSize: 12, fontWeight: 700 },
  summaryButton: { width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 12, border: "1px solid var(--tmc-parent-border)", borderRadius: 10, background: "var(--tmc-parent-surface)", color: "var(--tmc-parent-text)", cursor: "pointer", textAlign: "left" },
  summaryButtonMain: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  summaryButtonRight: { display: "grid", justifyItems: "end", gap: 2, color: "var(--tmc-parent-danger)", fontSize: 12 },
  miniTripIcon: { display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: "50%", background: "var(--tmc-parent-primary)", color: "var(--tmc-parent-accent)" },
  paymentOverview: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 9, margin: "17px 0 12px" },
  paymentMetric: { minWidth: 0, display: "grid", gap: 6, padding: "11px 12px", border: "1px solid var(--tmc-parent-border)", borderRadius: 10, background: "var(--tmc-parent-surface-soft)" },
  paymentMetricLabel: { color: "var(--tmc-parent-muted)", fontSize: 11, lineHeight: 1.35 },
  paymentMetricValue: { display: "block", overflow: "hidden", color: "var(--tmc-parent-heading)", fontSize: 16, lineHeight: 1.2, fontWeight: 750, textOverflow: "ellipsis", whiteSpace: "nowrap" },
  paymentAction: { marginTop: 4 },
  paymentSummaryCard: { display: "grid", gap: 6, padding: "13px 14px", borderRadius: 10, background: "var(--tmc-parent-surface-soft)" },
  secondaryWide: { width: "100%", display: "inline-flex", justifyContent: "center", alignItems: "center", gap: 5, padding: "10px 13px", border: "1px solid var(--tmc-parent-border-strong)", borderRadius: 8, background: "var(--tmc-parent-surface)", color: "var(--tmc-parent-primary)", cursor: "pointer", fontSize: 12, fontWeight: 700 },
  backButton: { display: "inline-flex", alignItems: "center", gap: 5, justifySelf: "start", padding: "8px 10px", border: "1px solid var(--tmc-parent-border-strong)", borderRadius: 8, background: "var(--tmc-parent-surface)", color: "var(--tmc-parent-subtle)", cursor: "pointer", fontSize: 12, fontWeight: 700 },
  detailHero: { display: "flex", alignItems: "center", gap: 14, padding: "21px 20px", border: "1px solid var(--tmc-parent-border)", borderRadius: 14, background: "linear-gradient(115deg, var(--tmc-parent-surface) 0%, #f1f8df 100%)" },
  detailHeroIcon: { display: "grid", placeItems: "center", width: 58, height: 58, borderRadius: "50%", background: "var(--tmc-parent-accent)", color: "var(--tmc-parent-accent-contrast)" },
  detailHeroContent: { display: "grid", gap: 5, minWidth: 0 },
  detailTitle: { margin: 0, color: "var(--tmc-parent-heading)", fontSize: 24 },
  costList: { display: "grid", gap: 9, margin: "18px 0 0" },
  costItem: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 },
  costLabel: { color: "var(--tmc-parent-subtle)", fontSize: 14 },
  costValue: { margin: 0, color: "var(--tmc-parent-heading)", fontSize: 14, fontWeight: 700, textAlign: "right" },
  paymentSummaryGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 18 },
  installmentRow: { display: "grid", alignItems: "center", gap: 18, marginTop: 10, padding: "16px 18px", border: "1px solid var(--tmc-parent-border)", borderLeft: "3px solid", borderRadius: 10 },
  installmentPaidRow: { gridTemplateColumns: "minmax(220px, 1.35fr) minmax(140px, 0.8fr) minmax(160px, 0.9fr) minmax(104px, auto)" },
  installmentPendingRow: { gridTemplateColumns: "minmax(220px, 1.35fr) minmax(140px, 0.8fr) minmax(160px, 0.9fr) minmax(104px, auto)" },
  installmentName: { display: "flex", alignItems: "center", gap: 10 },
  installmentNameText: { display: "grid", gap: 4, minWidth: 0 },
  installmentIcon: { display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: "50%", fontSize: 12, fontWeight: 800 },
  installmentAmount: { display: "grid", gap: 4, minWidth: 0 },
  installmentDate: { display: "grid", gap: 4, minWidth: 0 },
  installmentAction: { display: "flex", justifyContent: "flex-end", minWidth: 0 },
  installmentLabel: { color: "var(--tmc-parent-muted)", fontSize: 11, lineHeight: 1.2 },
  installmentValue: { color: "var(--tmc-parent-heading)", fontSize: 14, lineHeight: 1.25 },
  installmentStatus: { fontSize: 12, fontWeight: 700, lineHeight: 1.2 },
  payButton: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, minWidth: 94, padding: "9px 12px", borderRadius: 7, background: "var(--tmc-parent-accent)", color: "var(--tmc-parent-accent-contrast)", fontSize: 12, fontWeight: 750, textDecoration: "none", whiteSpace: "nowrap" },
  paidMark: { color: "var(--tmc-parent-success)", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  emptyState: { display: "grid", justifyItems: "center", gap: 8, padding: "32px 16px", color: "var(--tmc-parent-muted)", textAlign: "center" },
  loadingState: { display: "flex", alignItems: "center", justifyContent: "center", gap: 9, minHeight: 140, color: "var(--tmc-parent-muted)", fontSize: 13 },
  muted: { margin: 0, color: "var(--tmc-parent-muted)", fontSize: 13, lineHeight: 1.5 },
  error: { padding: "10px 13px", border: "1px solid var(--tmc-parent-error-border)", borderRadius: 9, background: "var(--tmc-parent-error-bg)", color: "var(--tmc-parent-error-text)", fontSize: 13 },
  primary: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "10px 14px", border: 0, borderRadius: 8, background: "var(--tmc-parent-primary)", color: "var(--tmc-parent-primary-contrast)", cursor: "pointer", fontSize: 13, fontWeight: 700 },
  secondary: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 12px", border: "1px solid var(--tmc-parent-border-strong)", borderRadius: 8, background: "var(--tmc-parent-surface)", color: "var(--tmc-parent-primary)", cursor: "pointer", fontSize: 12, fontWeight: 700 },
  iconButton: { position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 35, height: 35, border: "1px solid var(--tmc-parent-border-strong)", borderRadius: 8, background: "var(--tmc-parent-surface)", color: "var(--tmc-parent-heading)", cursor: "pointer" },
  label: { display: "grid", gap: 4, color: "var(--tmc-parent-subtle)", fontSize: 13, fontWeight: 700 },
  input: { width: "100%", boxSizing: "border-box", padding: "10px 12px", border: "1px solid var(--tmc-parent-border-strong)", borderRadius: 8, background: "var(--tmc-parent-input-bg)", color: "var(--tmc-parent-text)", fontSize: 14 },
  authPage: { minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, boxSizing: "border-box", background: "var(--tmc-parent-bg)", color: "var(--tmc-parent-text)" },
  authCard: { width: "min(100%, 420px)", display: "grid", gap: 17, padding: 30, border: "1px solid var(--tmc-parent-border)", borderRadius: 16, background: "var(--tmc-parent-surface)", boxShadow: "var(--tmc-parent-shadow)" },
  authBrand: { display: "flex", alignItems: "center", gap: 9, color: "var(--tmc-parent-heading)", fontSize: 17 },
  authTitle: { margin: 0, color: "var(--tmc-parent-heading)", fontSize: 28 },
  notificationWrap: { position: "relative", flex: "0 0 auto" },
  notificationBadge: { position: "absolute", top: -5, right: -5, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "#dc2626", color: "#fff", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1 },
  notificationBackdrop: { position: "fixed", inset: 0, zIndex: 40, border: 0, background: "transparent", cursor: "default" },
  notificationPanel: { position: "absolute", right: 0, top: "calc(100% + 8px)", width: 340, maxWidth: "90vw", maxHeight: 420, overflowY: "auto", zIndex: 41, background: "var(--tmc-parent-surface)", color: "var(--tmc-parent-text)", border: "1px solid var(--tmc-parent-border)", borderRadius: 12, boxShadow: "var(--tmc-parent-shadow)" },
  notificationHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--tmc-parent-border-light)" },
  markRead: { border: 0, padding: 0, background: "transparent", color: "var(--tmc-parent-primary)", cursor: "pointer", fontSize: 12, fontWeight: 600 },
  notificationEmpty: { padding: 18, color: "var(--tmc-parent-muted)", fontSize: 13, textAlign: "center" },
  notificationItem: { display: "grid", gap: 4, width: "100%", padding: "10px 14px", border: 0, borderBottom: "1px solid var(--tmc-parent-border-light)", background: "transparent", color: "var(--tmc-parent-text)", cursor: "pointer", textAlign: "left" },
  notificationItemUnread: { background: "var(--tmc-parent-profile-bg)" },
  notificationItemTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700 },
  notificationItemBody: { color: "var(--tmc-parent-muted)", fontSize: 12 },
  unreadDot: { width: 7, height: 7, flex: "0 0 auto", borderRadius: "50%", background: "#dc2626" },
  profilePage: { display: "grid", gap: 18 },
  profileHero: { display: "flex", alignItems: "center", gap: 16, padding: 24, border: "1px solid var(--tmc-parent-border)", borderRadius: 14, background: "var(--tmc-parent-surface)" },
  profileHeroAvatar: { display: "grid", placeItems: "center", width: 64, height: 64, borderRadius: "50%", background: "var(--tmc-parent-primary)", color: "var(--tmc-parent-primary-contrast)", fontSize: 24, fontWeight: 700 },
  profileName: { margin: 0, color: "var(--tmc-parent-heading)", fontSize: 22 },
  profileDetails: { display: "grid", gap: 14, margin: 0 },
  profileLabel: { color: "var(--tmc-parent-muted)", fontSize: 12 },
  profileValue: { margin: "3px 0 0", color: "var(--tmc-parent-text)", fontSize: 14, fontWeight: 600 },
};
