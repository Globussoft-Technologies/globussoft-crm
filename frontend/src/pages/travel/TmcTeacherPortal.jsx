import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Bell,
  ChevronDown,
  CheckCircle2,
  Clipboard,
  ClipboardCheck,
  ExternalLink,
  FileText,
  Link2,
  LayoutDashboard,
  Loader2,
  LogOut,
  Map,
  Moon,
  Plane,
  RefreshCw,
  Search,
  ShieldCheck,
  Sun,
  Users,
  UserRound,
} from "lucide-react";
import TmcTeacherDiagnostics from "./TmcTeacherDiagnostics";
import { persistTmcPortalView, readTmcPortalView } from "../../utils/tmcPortalView";

const TOKEN_KEY = "tmcTeacherPortalToken";
const THEME_KEY = "tmcTeacherPortalTheme";
const TEACHER_PORTAL_VIEWS = new Set(["dashboard", "diagnostic", "trips", "reviews", "profile"]);

const portalInteractionStyles = `
  [data-tmc-teacher-portal="true"] button:not([disabled]):not([data-tmc-no-hover]),
  [data-tmc-teacher-portal="true"] a {
    transition: transform 160ms ease, box-shadow 160ms ease, filter 160ms ease, opacity 160ms ease;
  }

  [data-tmc-teacher-portal="true"] button:not([disabled]):not([data-tmc-no-hover]):hover,
  [data-tmc-teacher-portal="true"] a:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 16px rgba(23, 59, 80, 0.12);
    filter: brightness(1.03);
  }

  [data-tmc-teacher-portal="true"] button:not([disabled]):not([data-tmc-no-hover]):active,
  [data-tmc-teacher-portal="true"] a:active {
    transform: translateY(0);
    transition-duration: 80ms;
  }

  [data-tmc-teacher-portal="true"] a:hover {
    box-shadow: none;
  }

  [data-tmc-teacher-portal="true"] [data-tmc-flat-hover="true"] {
    transition: color 160ms ease;
  }

  [data-tmc-teacher-portal="true"] [data-tmc-flat-hover="true"]:hover {
    transform: none;
    box-shadow: none;
    filter: none;
    color: var(--tmc-link);
  }

  [data-tmc-teacher-portal="true"] [data-tmc-flat-hover="true"]:hover svg {
    transform: translateX(3px);
    transition: transform 160ms ease;
  }

  [data-tmc-teacher-portal="true"] button:focus-visible,
  [data-tmc-teacher-portal="true"] a:focus-visible {
    outline: 3px solid var(--tmc-info-border);
    outline-offset: 2px;
  }

  [data-tmc-teacher-portal="true"] [data-tmc-hover-card="true"] {
    transition: transform 180ms ease, box-shadow 180ms ease;
  }

  [data-tmc-teacher-portal="true"] [data-tmc-hover-card="true"]:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 24px rgba(23, 59, 80, 0.10);
  }

  [data-tmc-teacher-portal="true"][data-theme-mode="dark"] button:not([disabled]):not([data-tmc-no-hover]):hover,
  [data-tmc-teacher-portal="true"][data-theme-mode="dark"] [data-tmc-hover-card="true"]:hover {
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28);
  }

  @media (prefers-reduced-motion: reduce) {
    [data-tmc-teacher-portal="true"] button,
    [data-tmc-teacher-portal="true"] a,
    [data-tmc-teacher-portal="true"] [data-tmc-hover-card="true"] {
      transition: none;
    }
  }
`;

const portalThemeVars = {
  light: {
    "--tmc-bg": "#f5f7f8",
    "--tmc-surface": "#ffffff",
    "--tmc-surface-soft": "#edf5f7",
    "--tmc-text": "#172b3a",
    "--tmc-heading": "#173b50",
    "--tmc-muted": "#71808a",
    "--tmc-subtle-text": "#52626c",
    "--tmc-border": "#dfe7eb",
    "--tmc-border-strong": "#d0dce1",
    "--tmc-border-light": "#edf1f3",
    "--tmc-profile-bg": "#eef4f6",
    "--tmc-primary": "#315c78",
    "--tmc-primary-contrast": "#ffffff",
    "--tmc-success-bg": "#e3f1e9",
    "--tmc-success-text": "#276a48",
    "--tmc-link": "#315c78",
    "--tmc-error-bg": "#fff1f0",
    "--tmc-error-text": "#b42318",
    "--tmc-info-bg": "#f1f7f9",
    "--tmc-info-border": "#c9dce5",
    "--tmc-badge-bg": "#e8f1f4",
    "--tmc-input-bg": "#ffffff",
    "--tmc-selected-bg": "rgba(49, 92, 120, 0.08)",
    "--tmc-question-shadow": "0 2px 10px rgba(23, 43, 58, 0.045)",
    "--tmc-shadow": "0 16px 40px rgba(23, 59, 80, 0.10)",
  },
  dark: {
    "--tmc-bg": "#111827",
    "--tmc-surface": "#1b2638",
    "--tmc-surface-soft": "#223247",
    "--tmc-text": "#e5ebf3",
    "--tmc-heading": "#f5f7fb",
    "--tmc-muted": "#9eacc0",
    "--tmc-subtle-text": "#c2cedd",
    "--tmc-border": "rgba(148, 163, 184, 0.22)",
    "--tmc-border-strong": "rgba(148, 163, 184, 0.38)",
    "--tmc-border-light": "rgba(148, 163, 184, 0.13)",
    "--tmc-profile-bg": "rgba(96, 165, 250, 0.13)",
    "--tmc-primary": "#5f91bd",
    "--tmc-primary-contrast": "#f7fbff",
    "--tmc-success-bg": "rgba(52, 211, 153, 0.14)",
    "--tmc-success-text": "#9de6c1",
    "--tmc-link": "#91bce3",
    "--tmc-error-bg": "rgba(248, 113, 113, 0.14)",
    "--tmc-error-text": "#fca5a5",
    "--tmc-info-bg": "rgba(96, 165, 250, 0.11)",
    "--tmc-info-border": "rgba(125, 180, 230, 0.34)",
    "--tmc-badge-bg": "rgba(96, 165, 250, 0.14)",
    "--tmc-input-bg": "#152033",
    "--tmc-selected-bg": "rgba(96, 165, 250, 0.15)",
    "--tmc-question-shadow": "0 2px 10px rgba(0, 0, 0, 0.2)",
    "--tmc-shadow": "0 16px 40px rgba(0, 0, 0, 0.24)",
  },
};

function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

async function api(path, { token, method = "GET", body, basePath = "/api/portal/tmc" } = {}) {
  const response = await fetch(`${basePath}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status });
  }
  return data;
}

export default function TmcTeacherPortal() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [contact, setContact] = useState(null);
  const [tenant, setTenant] = useState(null);
  const [trips, setTrips] = useState([]);
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [tripTab, setTripTab] = useState("students");
  const [participants, setParticipants] = useState([]);
  const [landingPage, setLandingPage] = useState(null);
  const [landingPageLoading, setLandingPageLoading] = useState(false);
  const [landingPageError, setLandingPageError] = useState("");
  const [diagnosticReports, setDiagnosticReports] = useState([]);
  const [teacherReviews, setTeacherReviews] = useState([]);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [activeView, setActiveView] = useState(() => readTmcPortalView(TEACHER_PORTAL_VIEWS));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [login, setLogin] = useState({ email: "", password: "" });
  const [themeMode, setThemeMode] = useState(readTheme);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, themeMode);
    } catch {
      /* ignore storage restrictions */
    }
  }, [themeMode]);

  useEffect(() => {
    persistTmcPortalView(activeView, TEACHER_PORTAL_VIEWS);
  }, [activeView]);

  const toggleTheme = useCallback(() => {
    setThemeMode((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const logout = useCallback((message = "") => {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setContact(null);
    setTenant(null);
    setTrips([]);
    setSelectedTrip(null);
    setTripTab("students");
    setParticipants([]);
    setLandingPage(null);
    setLandingPageLoading(false);
    setLandingPageError("");
    setDiagnosticReports([]);
    setTeacherReviews([]);
    setReviewSaving(false);
    setActiveView("dashboard");
    setError(message);
  }, []);

  const loadTrips = useCallback(async (activeToken = token) => {
    setLoading(true);
    setError("");
    try {
      const [me, result, reviewResult] = await Promise.all([
        api("/teacher/me", { token: activeToken }),
        api("/teacher/trips", { token: activeToken }),
        api("/teacher/reviews", { token: activeToken }),
      ]);
      const diagnosticResult = await api("/teacher/diagnostics", { token: activeToken });
      setContact(me.contact);
      setTenant(me.tenant || null);
      setTrips(result.trips || []);
      setDiagnosticReports(diagnosticResult.diagnostics || []);
      setTeacherReviews(reviewResult.trips || []);
    } catch (err) {
      if (err.status === 401 || err.status === 403 || err.status === 404) {
        logout(err.status === 404
          ? "Your teacher profile is no longer active. Please contact the travel administrator."
          : err.status === 403
          ? "This account is not registered as a TMC teacher. Please use the teacher registration page."
          : "Your teacher session has expired. Please sign in again.");
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [logout, token]);

  useEffect(() => {
    if (token) loadTrips(token);
  }, [token, loadTrips]);

  const openTrip = async (trip) => {
    setSelectedTrip(trip);
    setTripTab("students");
    setLandingPage(null);
    setLandingPageError("");
    setError("");
    try {
      const participantResult = await api(`/teacher/trips/${trip.id}/participants`, { token });
      setParticipants(participantResult.participants || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const openLandingPage = async (trip) => {
    if (!trip) return;
    setTripTab("landing");
    setLandingPageError("");
    setLandingPageLoading(true);
    try {
      const result = await api(`/teacher/trips/${trip.id}/landing-page`, { token });
      setLandingPage(result.landingPage
        ? { ...result.landingPage, publicUrl: result.publicUrl || "" }
        : null);
    } catch (err) {
      setLandingPage(null);
      setLandingPageError(err.status === 404
        ? "This trip does not have a published landing page yet."
        : err.message);
    } finally {
      setLandingPageLoading(false);
    }
  };

  const submitTeacherReview = async (tripId, reviewData) => {
    setReviewSaving(true);
    setError("");
    try {
      const result = await api(`/teacher/trips/${tripId}/review`, {
        token,
        method: "PUT",
        body: reviewData,
      });
      setTeacherReviews((current) => current.map((item) => (
        item.id === Number(tripId)
          ? { ...item, review: result.review, reviewSubmitted: true }
          : item
      )));
      return result.review;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setReviewSaving(false);
    }
  };

  const submitLogin = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...login, portalRole: "TEACHER" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.token) throw new Error(data.error || "Invalid credentials");
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <TmcAuthCard
        title="TMC Teacher Portal"
        subtitle="Complete your diagnostic and view finalized trips shared with your travel team."
        login={login}
        setLogin={setLogin}
        loading={loading}
        error={error}
        onSubmit={submitLogin}
        theme={themeMode}
      />
    );
  }

  const viewTitle = activeView === "dashboard"
    ? "Dashboard"
    : activeView === "diagnostic"
      ? "Complete diagnostic"
      : activeView === "trips"
        ? "Your trips"
        : activeView === "reviews"
          ? "Trip review"
        : "My Profile";

  return (
    <div
      data-tmc-teacher-portal="true"
      data-theme-mode={themeMode}
      style={{ ...styles.page, ...portalThemeVars[themeMode] }}
    >
      <style>{portalInteractionStyles}</style>
      <aside style={styles.sidebar}>
        <div style={styles.sidebarBrand}><Plane size={20} /> <strong>TMC Teacher Portal</strong></div>
        <div style={styles.profileCard}>
          <div style={styles.avatar}>{(contact?.name || "T").slice(0, 1).toUpperCase()}</div>
          <div style={styles.profileText}><strong>{contact?.name || "Teacher"}</strong><span>{contact?.email || ""}</span></div>
        </div>
        <nav style={styles.sidebarNav} aria-label="Teacher portal sections">
          <PortalNavButton icon={LayoutDashboard} label="Dashboard" active={activeView === "dashboard"} onClick={() => setActiveView("dashboard")} />
          <PortalNavButton icon={ClipboardCheck} label="Diagnostic" active={activeView === "diagnostic"} onClick={() => setActiveView("diagnostic")} />
          <PortalNavButton icon={Map} label="Trips" active={activeView === "trips"} onClick={() => setActiveView("trips")} />
          <PortalNavButton icon={Clipboard} label="Trip review" active={activeView === "reviews"} onClick={() => setActiveView("reviews")} />
        </nav>
        <div style={styles.sidebarFooter}>Use this portal to complete your diagnostic, view assigned trips, submit trip reports, and review trip landing pages.</div>
      </aside>

      <div style={styles.shell}>
        <header style={styles.header}>
          <div><span style={styles.eyebrow}>Teacher workspace</span><h1 style={styles.headerTitle}>{viewTitle}</h1></div>
          <div style={styles.headerActions}>
            <TeacherNotificationBell
              token={token}
              onNavigate={(view) => setActiveView(view)}
            />
            <ThemeToggleButton theme={themeMode} onToggle={toggleTheme} />
            <button
              type="button"
              onClick={() => setActiveView("profile")}
              title="View your profile"
              aria-label="View your profile"
              style={{ ...styles.profilePill, ...(activeView === "profile" ? styles.profilePillActive : {}) }}
            >
              <span style={styles.headerAvatar}>{(contact?.name || "T").slice(0, 1).toUpperCase()}</span>
              <span>{contact?.name || "Teacher"}</span>
              <ChevronDown size={14} aria-hidden />
            </button>
            <button type="button" onClick={() => logout()} style={styles.logoutButton} title="Sign out" aria-label="Sign out"><LogOut size={16} /></button>
          </div>
        </header>
        <main style={styles.main}>
          <div style={styles.contentScroll}>
            {error && <div role="alert" style={styles.error}>{error}</div>}
            {activeView === "dashboard" && <TeacherDashboard
              contact={contact}
              trips={trips}
              diagnosticReports={diagnosticReports}
              teacherReviews={teacherReviews}
              loading={loading}
              onOpenDiagnostic={() => setActiveView("diagnostic")}
              onOpenTrips={() => setActiveView("trips")}
              onOpenReviews={() => setActiveView("reviews")}
              onOpenTrip={(trip) => { setActiveView("trips"); openTrip(trip); }}
            />}
            {activeView === "diagnostic" && <TmcTeacherDiagnostics token={token} tenantSlug={tenant?.slug} contact={contact} onSessionExpired={(message) => logout(message || "Your teacher session is no longer available. Please sign in again.")} />}
            {activeView === "trips" && <TripsView
              trips={trips}
              loading={loading}
              selectedTrip={selectedTrip}
              tripTab={tripTab}
              participants={participants}
              landingPage={landingPage}
              landingPageLoading={landingPageLoading}
              landingPageError={landingPageError}
              onRefresh={() => loadTrips()}
              onOpenTrip={openTrip}
              onOpenLandingPage={openLandingPage}
              onSelectTripTab={setTripTab}
              onOpenReviews={() => setActiveView("reviews")}
            />}
            {activeView === "reviews" && <TeacherReviewView
              reviewTrips={teacherReviews}
              loading={loading}
              saving={reviewSaving}
              onRefresh={() => loadTrips()}
              onSubmit={submitTeacherReview}
            />}
            {activeView === "profile" && <TeacherProfileView contact={contact} />}
          </div>
        </main>
      </div>
    </div>
  );
}

function PortalNavButton({ icon: Icon, label, active, onClick }) {
  return <button type="button" onClick={onClick} style={{ ...styles.navButton, ...(active ? styles.navButtonActive : {}) }}><Icon size={17} /> <span>{label}</span></button>;
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

function TeacherNotificationBell({ token, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(() => {
    api("/travel/notifications?limit=30", { token, basePath: "/api/portal" })
      .then((result) => {
        setItems(Array.isArray(result.notifications) ? result.notifications : []);
        setUnread(Number(result.unreadCount) || 0);
      })
      .catch(() => {
        // Notifications are optional; the rest of the teacher portal stays usable.
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
      await api(`/travel/notifications/${notification.id}/read`, { token, method: "PUT", basePath: "/api/portal" });
      setItems((current) => current.map((item) => (
        item.id === notification.id ? { ...item, isRead: true } : item
      )));
      setUnread((current) => Math.max(0, current - 1));
    } catch {
      // Keep the notification open if the read update fails.
    }
  };

  const openNotification = (notification) => {
    markRead(notification);
    setOpen(false);
    if (["dashboard", "diagnostic", "trips", "reviews", "profile"].includes(notification.link)) {
      onNavigate(notification.link);
    }
  };

  const markAllRead = async () => {
    try {
      await api("/travel/notifications/mark-all-read", { token, method: "POST", basePath: "/api/portal" });
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
                  {notification.title || "Teacher portal update"}
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

function TeacherProfileView({ contact }) {
  return (
    <div style={styles.profilePage}>
      <div style={styles.titleRow}>
        <div>
          <h2 style={styles.title}>My Profile</h2>
          <p style={styles.muted}>View the account details linked to your teacher portal.</p>
        </div>
      </div>
      <section style={styles.profileHero} aria-label="Teacher profile summary">
        <div style={styles.profileHeroAvatar}>{(contact?.name || "T").slice(0, 1).toUpperCase()}</div>
        <div>
          <h2 style={styles.profileName}>{contact?.name || "Teacher"}</h2>
          <p style={styles.muted}>{contact?.email || "Email not available"}</p>
        </div>
      </section>
      <section style={styles.card} aria-labelledby="teacher-profile-details">
        <div style={styles.cardHeading}><UserRound size={19} color="var(--tmc-primary)" /><h3 id="teacher-profile-details" style={styles.sectionTitle}>Profile details</h3></div>
        <dl style={styles.profileDetails}>
          <div><dt style={styles.profileLabel}>Name</dt><dd style={styles.profileValue}>{contact?.name || "Not available"}</dd></div>
          <div><dt style={styles.profileLabel}>Email</dt><dd style={styles.profileValue}>{contact?.email || "Not available"}</dd></div>
          <div><dt style={styles.profileLabel}>Portal access</dt><dd style={styles.profileValue}>TMC Teacher</dd></div>
        </dl>
      </section>
    </div>
  );
}

function TeacherDashboard({ contact, trips, diagnosticReports, teacherReviews, loading, onOpenDiagnostic, onOpenTrips, onOpenReviews, onOpenTrip }) {
  const studentCount = trips.reduce((total, trip) => total + (trip._count?.participants || 0), 0);
  const latestReports = diagnosticReports.slice(0, 3);
  const submittedReviewCount = teacherReviews.filter((trip) => trip.reviewSubmitted).length;

  return <div style={styles.dashboard}>
    <section style={styles.dashboardHero}>
      <div>
        <span style={styles.eyebrow}>TMC teacher workspace</span>
        <h2 style={styles.dashboardWelcome}>Welcome{contact?.name ? `, ${contact.name}` : ""}!</h2>
        <p style={styles.dashboardSubtitle}>Manage your school trip preparation from one place.</p>
      </div>
      <div style={styles.heroBadge}><ShieldCheck size={18} /><span>Teacher account</span></div>
    </section>

    <section style={styles.metricGrid} aria-label="Teacher overview">
      <MetricCard icon={Map} label="Assigned trips" value={trips.length} detail="Finalized trips" />
      <MetricCard icon={Users} label="Participants" value={studentCount} detail="Currently registered" />
      <MetricCard icon={FileText} label="Diagnostic reports" value={diagnosticReports.length} detail={diagnosticReports.length ? "Reports available" : "Not completed yet"} />
      <MetricCard icon={Clipboard} label="Trip reports" value={submittedReviewCount} detail={`${teacherReviews.length} completed trip${teacherReviews.length === 1 ? "" : "s"} eligible`} />
    </section>

    <section style={styles.actionGrid} aria-label="Teacher actions">
      <QuickAction icon={ClipboardCheck} title="Complete your diagnostic" description={diagnosticReports.length ? "Review your latest readiness report or submit another diagnostic." : "Answer the school-readiness questions and receive your report."} action="Open diagnostic" onClick={onOpenDiagnostic} />
      <QuickAction icon={Link2} title="Review parent registration" description="Open a finalized trip to review its participants and landing page. Parent links are generated by your administrator." action="Open trips" onClick={onOpenTrips} />
      <QuickAction icon={Clipboard} title="Submit a trip report" description={teacherReviews.length ? "Share feedback for a completed trip with the travel team." : "Your completed trips will appear here when they are ready for feedback."} action="Open trip review" onClick={onOpenReviews} />
    </section>

    <div style={styles.dashboardGrid}>
      <section data-tmc-hover-card="true" style={{ ...styles.card, ...styles.dashboardCard }} aria-labelledby="teacher-dashboard-trips">
        <div style={styles.dashboardSectionHeader}>
          <div><h2 id="teacher-dashboard-trips" style={styles.sectionTitle}>Your trips</h2><p style={styles.muted}>Trips finalized with the travel team.</p></div>
          <button type="button" onClick={onOpenTrips} style={styles.textButton}>View all <ArrowRight size={15} /></button>
        </div>
        {loading ? <div style={styles.empty}><Loader2 size={18} style={styles.spin} /> Loading your workspace...</div> : trips.length === 0 ? <div style={styles.empty}>No finalized trips have been assigned to you yet.</div> : <div style={styles.dashboardList}>{trips.slice(0, 4).map((trip) => <button key={trip.id} type="button" onClick={() => onOpenTrip(trip)} data-tmc-flat-hover="true" style={styles.dashboardTrip}><div><strong>{trip.destination || trip.tripCode}</strong><div style={styles.muted}>{trip.tripCode} · {formatDate(trip.departDate)}</div></div><div style={styles.dashboardTripMeta}><span>{trip._count?.participants || 0} participants</span><ArrowRight size={15} /></div></button>)}</div>}
      </section>

      <section data-tmc-hover-card="true" style={{ ...styles.card, ...styles.dashboardCard }} aria-labelledby="teacher-dashboard-reports">
        <div style={styles.dashboardSectionHeader}>
          <div><h2 id="teacher-dashboard-reports" style={styles.sectionTitle}>Diagnostic reports</h2><p style={styles.muted}>Your school-readiness results.</p></div>
          <button type="button" onClick={onOpenDiagnostic} style={styles.textButton}>Open <ArrowRight size={15} /></button>
        </div>
        {latestReports.length === 0 ? <div style={styles.empty}>Complete the diagnostic to create your first report.</div> : <div style={styles.dashboardList}>{latestReports.map((report) => <div key={report.id} style={styles.reportSummary}><div><strong>Readiness report #{report.id}</strong><div style={styles.muted}>{formatDate(report.createdAt)}</div></div><button type="button" onClick={onOpenDiagnostic} style={styles.reportLink}>Open diagnostic</button></div>)}</div>}
      </section>
    </div>
  </div>;
}

function MetricCard({ icon: Icon, label, value, detail }) {
  return <article style={styles.metricCard}><div style={styles.metricIcon}><Icon size={18} /></div><div style={styles.metricValue}>{value}</div><div style={styles.metricLabel}>{label}</div><div style={styles.metricDetail}>{detail}</div></article>;
}

function QuickAction({ icon: Icon, title, description, action, onClick }) {
  return <article data-tmc-hover-card="true" style={styles.quickAction}><div style={styles.quickActionIcon}><Icon size={19} /></div><div style={styles.quickActionBody}><h3 style={styles.quickActionTitle}>{title}</h3><p style={{ ...styles.muted, ...styles.quickActionDescription }}>{description}</p><button type="button" onClick={onClick} style={{ ...styles.secondary, ...styles.quickActionButton }}>{action} <ArrowRight size={15} /></button></div></article>;
}

const TEACHER_REVIEW_RATING_OPTIONS = [
  { value: "excellent", label: "Excellent" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
  { value: "poor", label: "Poor" },
];

const TEACHER_REVIEW_RATING_ROWS = [
  { field: "travelRating", label: "Travel" },
  { field: "foodRating", label: "Food" },
  { field: "activitiesRating", label: "Activities" },
  { field: "careSupportRating", label: "Care & support" },
  { field: "overallRating", label: "Overall" },
];

function dateInputValue(value) {
  if (!value) return "";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function buildTeacherReviewForm(trip, review) {
  return {
    reportDate: dateInputValue(review?.reportDate || trip?.returnDate),
    institution: review?.institution || "",
    tourDestination: review?.tourDestination || trip?.destination || "",
    coordinator: review?.coordinator || "",
    grade: review?.grade || "",
    travelRating: review?.travelRating || "",
    foodRating: review?.foodRating || "",
    activitiesRating: review?.activitiesRating || "",
    careSupportRating: review?.careSupportRating || "",
    overallRating: review?.overallRating || "",
    feedback: review?.feedback || "",
    studentCount: review?.studentCount == null ? "" : String(review.studentCount),
    staffCount: review?.staffCount == null ? "" : String(review.staffCount),
    totalPassengers: review?.totalPassengers == null ? "" : String(review.totalPassengers),
    signature: review?.signature || "",
  };
}

function TeacherReviewView({ reviewTrips, loading, saving, onRefresh, onSubmit }) {
  const [selectedTripId, setSelectedTripId] = useState("");
  const [tripSearch, setTripSearch] = useState("");
  const [form, setForm] = useState(() => buildTeacherReviewForm(null, null));
  const [message, setMessage] = useState("");
  const selectedTrip = reviewTrips.find((trip) => String(trip.id) === String(selectedTripId));
  const normalizedTripSearch = tripSearch.trim().toLowerCase();
  const filteredTrips = normalizedTripSearch
    ? reviewTrips.filter((trip) => (
      [trip.destination, trip.tripCode, trip.tripType]
        .some((value) => String(value || "").toLowerCase().includes(normalizedTripSearch))
    ))
    : reviewTrips;

  useEffect(() => {
    setSelectedTripId((current) => (
      reviewTrips.some((trip) => String(trip.id) === String(current))
        ? current
        : ""
    ));
  }, [reviewTrips]);

  useEffect(() => {
    setForm(buildTeacherReviewForm(selectedTrip, selectedTrip?.review));
  }, [selectedTrip]);

  useEffect(() => {
    setMessage("");
  }, [selectedTripId]);

  useEffect(() => {
    if (!message) return undefined;
    const timeoutId = window.setTimeout(() => setMessage(""), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [message]);

  const updateField = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  const submit = async (event) => {
    event.preventDefault();
    if (!selectedTrip) return;
    const isUpdate = Boolean(selectedTrip.reviewSubmitted);
    try {
      await onSubmit(selectedTrip.id, form);
      setMessage(isUpdate
        ? "Your trip report has been updated successfully."
        : "Your trip report has been submitted successfully.");
    } catch {
      // The parent displays the API error in the shared portal alert.
    }
  };

  return <div style={styles.reviewPage}>
    {message && <div role="status" aria-live="polite" aria-atomic="true" style={styles.toast}>
      <CheckCircle2 size={18} aria-hidden />
      <span>{message}</span>
    </div>}
    <div style={styles.titleRow}>
      <div>
        <h2 style={styles.title}>Trip review</h2>
        <p style={styles.muted}>Submit a tour report for a completed trip. The travel team can review your feedback from the admin portal.</p>
      </div>
      <button type="button" onClick={onRefresh} disabled={loading} style={styles.secondary}><RefreshCw size={15} /> Refresh</button>
    </div>

    {loading ? <div style={{ ...styles.card, ...styles.empty }}><Loader2 size={18} style={styles.spin} /> Loading completed trips...</div> : reviewTrips.length === 0 ? (
      <section style={styles.card} aria-label="Completed trips for review">
        <div style={styles.empty}>No completed trips are ready for a review yet. A report becomes available after your assigned trip is marked completed.</div>
      </section>
    ) : <>
      <section style={styles.reviewSelectCard} aria-labelledby="teacher-review-trip-heading">
        <div>
          <span style={styles.eyebrow}>Completed trips</span>
          <h3 id="teacher-review-trip-heading" style={styles.sectionTitle}>Choose a trip to review</h3>
          <p style={styles.reviewSelectHint}>Select the completed tour you are reporting on.</p>
        </div>
        <div style={styles.reviewSelectControls}>
          {reviewTrips.length > 1 && <label style={styles.reviewSelectField}>
            <span style={styles.fieldLabel}>Search trips</span>
            <input
              type="search"
              aria-label="Search trips"
              placeholder="Search destination or trip code"
              value={tripSearch}
              onChange={(event) => setTripSearch(event.target.value)}
              style={styles.input}
            />
          </label>}
          <label style={styles.reviewSelectField}>
            <span style={styles.fieldLabel}>Trip</span>
            <select aria-label="Select completed trip" value={selectedTripId} onChange={(event) => setSelectedTripId(event.target.value)} style={styles.input}>
              <option value="">Select a trip to review</option>
              {filteredTrips.map((trip) => <option key={trip.id} value={trip.id}>{trip.destination || trip.tripCode} · {trip.tripCode}</option>)}
            </select>
            {normalizedTripSearch && filteredTrips.length === 0 && <span style={styles.reviewSearchEmpty}>No completed trips match your search.</span>}
          </label>
        </div>
        {selectedTrip?.reviewSubmitted && <span style={styles.reviewBadge}>Report submitted — you can update it below</span>}
      </section>

      {selectedTrip && <form onSubmit={submit} style={styles.reviewForm}>
        <section style={styles.card} aria-labelledby="teacher-review-details-heading">
          <div style={styles.cardHeading}><Clipboard size={18} color="var(--tmc-primary)" /><h3 id="teacher-review-details-heading" style={styles.sectionTitle}>Tour details</h3></div>
          <div style={styles.reviewFieldGrid}>
            <label style={styles.label}>Date<input type="date" required value={form.reportDate} onChange={(event) => updateField("reportDate", event.target.value)} style={styles.input} /></label>
            <label style={styles.label}>Institution<input type="text" required value={form.institution} onChange={(event) => updateField("institution", event.target.value)} style={styles.input} /></label>
            <label style={styles.label}>Tour destination<input type="text" required value={form.tourDestination} onChange={(event) => updateField("tourDestination", event.target.value)} style={styles.input} /></label>
            <label style={styles.label}>Coordinator<input type="text" required value={form.coordinator} onChange={(event) => updateField("coordinator", event.target.value)} style={styles.input} /></label>
            <label style={styles.label}>Grade<input type="text" required value={form.grade} onChange={(event) => updateField("grade", event.target.value)} style={styles.input} /></label>
          </div>
        </section>

        <section style={styles.card} aria-labelledby="teacher-review-ratings-heading">
          <div style={styles.cardHeading}><ClipboardCheck size={18} color="var(--tmc-primary)" /><h3 id="teacher-review-ratings-heading" style={styles.sectionTitle}>Rate the tour</h3></div>
          <div style={styles.ratingMatrix}>
            <div style={styles.ratingHeader}><span style={styles.ratingHeaderArea}>Area</span>{TEACHER_REVIEW_RATING_OPTIONS.map((option) => <span key={option.value}>{option.label}</span>)}</div>
            {TEACHER_REVIEW_RATING_ROWS.map((row) => <fieldset key={row.field} style={styles.ratingRow}>
              <legend style={styles.visuallyHidden}>{row.label}</legend>
              <div style={styles.ratingRowInner}>
                <span style={styles.ratingArea}>{row.label}</span>
                {TEACHER_REVIEW_RATING_OPTIONS.map((option) => <label key={option.value} style={{ ...styles.ratingOption, ...(form[row.field] === option.value ? styles.ratingOptionSelected : {}) }}>
                  <input type="radio" name={row.field} value={option.value} required checked={form[row.field] === option.value} onChange={(event) => updateField(row.field, event.target.value)} style={styles.ratingInput} />
                  <span>{option.label}</span>
                </label>)}
              </div>
            </fieldset>)}
          </div>
        </section>

        <section style={styles.card} aria-labelledby="teacher-review-feedback-heading">
          <div style={styles.cardHeading}><FileText size={18} color="var(--tmc-primary)" /><h3 id="teacher-review-feedback-heading" style={styles.sectionTitle}>Feedback & suggestion</h3></div>
          <label style={styles.label}><span style={styles.fieldLabel}>Comments and suggestions <span style={styles.optional}>(Optional)</span></span><textarea value={form.feedback} onChange={(event) => updateField("feedback", event.target.value)} placeholder="Share what went well and what could be improved..." style={styles.reviewTextArea} rows={5} /></label>
          <div style={{ ...styles.reviewFieldGrid, ...styles.reviewFeedbackFields }}>
            <label style={styles.label}>No. of students<input type="number" min="0" required value={form.studentCount} onChange={(event) => updateField("studentCount", event.target.value)} style={styles.input} /></label>
            <label style={styles.label}>No. of staff<input type="number" min="0" required value={form.staffCount} onChange={(event) => updateField("staffCount", event.target.value)} style={styles.input} /></label>
            <label style={styles.label}>Total passengers<input type="number" min="0" required value={form.totalPassengers} onChange={(event) => updateField("totalPassengers", event.target.value)} style={styles.input} /></label>
            <label style={styles.label}>Signature (type your full name)<input type="text" required value={form.signature} onChange={(event) => updateField("signature", event.target.value)} style={styles.input} /></label>
          </div>
          <div style={styles.reviewFooter}>
            <button type="submit" disabled={saving} style={styles.primary}>{saving ? "Submitting..." : selectedTrip.reviewSubmitted ? "Update report" : "Submit report"}</button>
          </div>
        </section>
      </form>}
    </>}
  </div>;
}

function TripsView({ trips, loading, selectedTrip, tripTab, participants, landingPage, landingPageLoading, landingPageError, onRefresh, onOpenTrip, onOpenLandingPage, onSelectTripTab, onOpenReviews }) {
  const [tripSearch, setTripSearch] = useState("");
  const normalizedTripSearch = tripSearch.trim().toLowerCase();
  const filteredTrips = normalizedTripSearch
    ? trips.filter((trip) => [trip.destination, trip.tripCode, trip.tripType].some((value) => String(value || "").toLowerCase().includes(normalizedTripSearch)))
    : trips;

  return <>
    <div style={styles.titleRow}>
      <div><h2 style={styles.title}>Trips finalized with your travel team</h2><p style={styles.muted}>Open a trip to view its participants and landing page.</p></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={onOpenReviews} style={styles.secondary}><Clipboard size={15} /> Review a completed trip</button>
        <button type="button" onClick={onRefresh} style={styles.secondary}><RefreshCw size={15} /> Refresh</button>
      </div>
    </div>
    <div style={styles.grid}>
      <section style={styles.card} aria-label="Assigned trips">
        <div style={styles.cardHeading}><Map size={18} color="var(--tmc-primary)" /><h3 style={styles.sectionTitle}>Assigned trips</h3></div>
        <label style={styles.tripSearch}>
          <Search size={16} aria-hidden />
          <input type="search" aria-label="Search assigned trips" placeholder="Search destination or trip code" value={tripSearch} onChange={(event) => setTripSearch(event.target.value)} style={styles.tripSearchInput} />
        </label>
        {loading ? <div style={styles.empty}><Loader2 size={20} style={styles.spin} /> Loading trips...</div> : trips.length === 0 ? <div style={styles.empty}>No trips have been assigned to you yet.</div> : filteredTrips.length === 0 ? <div style={styles.empty}>No trips match “{tripSearch}”.</div> : filteredTrips.map((trip) => (
          <button key={trip.id} type="button" onClick={() => onOpenTrip(trip)} style={{ ...styles.trip, ...(selectedTrip?.id === trip.id ? styles.tripActive : {}) }}>
            <div><strong>{trip.destination || trip.tripCode}</strong><div style={styles.muted}>{trip.tripCode} · {formatDate(trip.departDate)}</div></div>
            <div style={styles.count}>{trip._count?.participants || 0} participants</div>
          </button>
        ))}
      </section>
      <section style={styles.card} aria-label="Trip students">
        {!selectedTrip ? <div style={styles.empty}>Select a trip to view its students and landing page.</div> : <>
          <div style={styles.sectionHeader}><div><h3 style={styles.sectionTitle}>{selectedTrip.destination || selectedTrip.tripCode}</h3><div style={styles.muted}>{formatDate(selectedTrip.departDate)} - {formatDate(selectedTrip.returnDate)}</div></div></div>
          <div style={styles.tripTabs} role="tablist" aria-label="Trip information">
            <button type="button" role="tab" aria-selected={tripTab === "students"} onClick={() => onSelectTripTab("students")} style={{ ...styles.tripTab, ...(tripTab === "students" ? styles.tripTabActive : {}) }}><Users size={15} /> Participants</button>
            <button type="button" role="tab" aria-selected={tripTab === "landing"} onClick={() => onOpenLandingPage(selectedTrip)} style={{ ...styles.tripTab, ...(tripTab === "landing" ? styles.tripTabActive : {}) }}><ExternalLink size={15} /> Landing page</button>
          </div>
          {tripTab === "landing" ? <TripLandingPageView landingPage={landingPage} loading={landingPageLoading} error={landingPageError} /> : <>
            <h4 style={styles.subheading}>Participants</h4>
            {participants.length === 0 ? <div style={styles.muted}>No participants have registered yet.</div> : <div style={styles.list}>{participants.map((row) => <div key={`p-${row.id}`} style={styles.listRow}>
              <div style={styles.participantPeople}>
                <div style={styles.personBlock}>
                  <span style={styles.personLabel}>Child / student</span>
                  <strong>{row.fullName || "Name not provided"}</strong>
                </div>
                <div style={styles.personBlock}>
                  <span style={styles.personLabel}>Parent / guardian</span>
                  <strong>{row.parentName || "Name not provided"}</strong>
                  {(row.parentEmail || row.parentPhone) && <div style={styles.personContact}>
                    {row.parentEmail && <span>{row.parentEmail}</span>}
                    {row.parentPhone && <span>{row.parentPhone}</span>}
                  </div>}
                </div>
              </div>
              <span style={styles.badge}>Participant</span>
            </div>)}</div>}
          </>}
        </>}
      </section>
    </div>
  </>;
}

function TripLandingPageView({ landingPage, loading, error }) {
  if (loading) return <div style={styles.empty}>Loading the published landing page...</div>;
  if (error) return <div style={styles.landingEmpty}><strong>Landing page unavailable</strong><span>{error}</span></div>;
  if (!landingPage?.publicUrl) return <div style={styles.landingEmpty}><strong>No landing page available</strong><span>The travel team has not published a landing page for this trip yet.</span></div>;

  return <div style={styles.landingView}>
    <div style={styles.landingSummary}>
      <div>
        <div style={styles.landingStatus}><span style={styles.badge}>Published</span></div>
        <h4 style={styles.landingTitle}>{landingPage.title || "Trip landing page"}</h4>
        <p style={styles.muted}>Review the trip information that parents will see.</p>
      </div>
      <a href={landingPage.publicUrl} target="_blank" rel="noreferrer" style={styles.primary}><ExternalLink size={15} /> Open full page</a>
    </div>
    <div style={styles.landingFrame}>
      <iframe
        src={landingPage.publicUrl}
        title={`${landingPage.title || "Trip"} landing page`}
        sandbox="allow-scripts allow-same-origin"
        style={styles.landingIframe}
      />
    </div>
  </div>;
}

function TmcAuthCard({ title, subtitle, login, setLogin, loading, error, onSubmit, theme }) {
  return <div data-tmc-teacher-portal="true" data-theme-mode={theme} style={{ ...styles.authPage, ...portalThemeVars[theme] }}><style>{portalInteractionStyles}</style><form onSubmit={onSubmit} style={styles.authCard}><Plane size={30} color="var(--tmc-primary)" /><h1 style={styles.authTitle}>{title}</h1><p style={styles.muted}>{subtitle}</p>{error && <div role="alert" style={styles.error}>{error}</div>}<label style={styles.label}>Email<input style={styles.input} type="email" value={login.email} onChange={(event) => setLogin((value) => ({ ...value, email: event.target.value }))} required /></label><label style={styles.label}>Password<input style={styles.input} type="password" value={login.password} onChange={(event) => setLogin((value) => ({ ...value, password: event.target.value }))} required /></label><button type="submit" style={styles.primary} disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button></form></div>;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString() : "Date to be confirmed";
}

const styles = {
  page: { height: "100vh", minHeight: 0, display: "grid", gridTemplateColumns: "250px minmax(0, 1fr)", overflow: "hidden", background: "var(--tmc-bg)", color: "var(--tmc-text)" },
  sidebar: { height: "100vh", minHeight: 0, display: "flex", flexDirection: "column", overflowY: "auto", overscrollBehavior: "contain", padding: "24px 16px", boxSizing: "border-box", background: "var(--tmc-surface)", borderRight: "1px solid var(--tmc-border)" },
  sidebarBrand: { display: "flex", alignItems: "center", gap: 9, padding: "0 9px", color: "var(--tmc-heading)", fontSize: 16 },
  profileCard: { display: "flex", alignItems: "center", gap: 10, margin: "32px 8px 24px", padding: "12px 10px", borderRadius: 10, background: "var(--tmc-profile-bg)" },
  avatar: { display: "grid", placeItems: "center", width: 38, height: 38, borderRadius: "50%", background: "var(--tmc-primary)", color: "var(--tmc-primary-contrast)", fontWeight: 700 },
  profileText: { display: "grid", gap: 3, minWidth: 0, fontSize: 13 },
  sidebarNav: { display: "grid", gap: 7 },
  navButton: { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "12px 11px", border: 0, borderRadius: 9, background: "transparent", color: "var(--tmc-subtle-text)", cursor: "pointer", textAlign: "left", fontSize: 14, fontWeight: 600 },
  navButtonActive: { background: "var(--tmc-primary)", color: "var(--tmc-primary-contrast)" },
  sidebarFooter: { marginTop: "auto", padding: "16px 9px 0", borderTop: "1px solid var(--tmc-border-light)", color: "var(--tmc-muted)", fontSize: 11, lineHeight: 1.5 },
  shell: { minWidth: 0, minHeight: 0, height: "100vh", display: "grid", gridTemplateRows: "78px minmax(0, 1fr)", overflow: "hidden" },
  header: { minHeight: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "0 32px", background: "var(--tmc-surface)", borderBottom: "1px solid var(--tmc-border)", zIndex: 2 },
  headerActions: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 9, minWidth: 0 },
  eyebrow: { display: "block", marginBottom: 3, color: "var(--tmc-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" },
  headerTitle: { margin: 0, color: "var(--tmc-heading)", fontSize: 20 },
  iconButton: { position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, border: "1px solid var(--tmc-border-strong)", borderRadius: 9, background: "var(--tmc-surface)", color: "var(--tmc-subtle-text)", cursor: "pointer" },
  profilePill: { display: "inline-flex", alignItems: "center", gap: 8, maxWidth: 220, minWidth: 0, padding: "4px 10px 4px 4px", border: "1px solid var(--tmc-border)", borderRadius: 999, background: "transparent", color: "var(--tmc-text)", cursor: "pointer", fontSize: 13, fontWeight: 600 },
  profilePillActive: { background: "var(--tmc-profile-bg)" },
  headerAvatar: { display: "grid", placeItems: "center", width: 28, height: 28, flex: "0 0 auto", borderRadius: "50%", background: "var(--tmc-primary)", color: "var(--tmc-primary-contrast)", fontSize: 12, fontWeight: 700 },
  logoutButton: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, border: "1px solid var(--tmc-border-strong)", borderRadius: 9, padding: 0, background: "var(--tmc-surface)", color: "var(--tmc-subtle-text)", cursor: "pointer" },
  main: { minWidth: 0, minHeight: 0, height: "100%", overflow: "hidden" },
  contentScroll: { width: "100%", minHeight: 0, height: "100%", boxSizing: "border-box", padding: 32, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain" },
  dashboard: { display: "grid", gap: 18 },
  reviewPage: { display: "grid", gap: 18, width: "min(100%, 1180px)", maxWidth: 1180, margin: "0 auto", paddingBottom: 24, boxSizing: "border-box" },
  reviewSelectCard: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(280px, .9fr)", alignItems: "center", gap: "16px 24px", padding: 22, border: "1px solid var(--tmc-info-border)", borderRadius: 14, background: "linear-gradient(135deg, var(--tmc-info-bg) 0%, var(--tmc-surface) 72%)", boxShadow: "var(--tmc-question-shadow)" },
  reviewSelectHint: { margin: "6px 0 0", color: "var(--tmc-muted)", fontSize: 13, lineHeight: 1.5 },
  reviewSelectControls: { display: "grid", gap: 10, minWidth: 0 },
  reviewSelectField: { display: "grid", gap: 7, minWidth: 0 },
  reviewSearchEmpty: { color: "var(--tmc-muted)", fontSize: 11 },
  reviewBadge: { gridColumn: "1 / -1", justifySelf: "start", padding: "7px 10px", borderRadius: 999, background: "var(--tmc-success-bg)", color: "var(--tmc-success-text)", fontSize: 11, fontWeight: 700 },
  reviewForm: { display: "grid", gap: 18 },
  reviewFieldGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 16 },
  reviewFeedbackFields: { marginTop: 22 },
  reviewTextArea: { width: "100%", boxSizing: "border-box", minHeight: 125, resize: "vertical", padding: "10px 11px", border: "1px solid var(--tmc-border-strong)", borderRadius: 8, fontFamily: "inherit", fontSize: 14, lineHeight: 1.5, background: "var(--tmc-input-bg)", color: "var(--tmc-text)" },
  ratingMatrix: { display: "grid", overflowX: "auto", border: "1px solid var(--tmc-border)", borderRadius: 12, background: "var(--tmc-surface)" },
  ratingHeader: { display: "grid", gridTemplateColumns: "minmax(170px, 1.25fr) repeat(4, minmax(100px, 1fr))", gap: 8, minWidth: 620, padding: "12px 14px", color: "var(--tmc-muted)", fontSize: 11, fontWeight: 700, textAlign: "center", letterSpacing: "0.02em" },
  ratingHeaderArea: { textAlign: "left" },
  ratingRow: { minWidth: 620, margin: 0, padding: "6px 14px", border: 0, borderTop: "1px solid var(--tmc-border-light)", background: "var(--tmc-surface-soft)" },
  ratingRowInner: { display: "grid", gridTemplateColumns: "minmax(170px, 1.25fr) repeat(4, minmax(100px, 1fr))", gap: 8, alignItems: "center" },
  ratingArea: { color: "var(--tmc-heading)", fontSize: 13, fontWeight: 700 },
  ratingOption: { display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 36, gap: 6, padding: "0 7px", borderRadius: 8, color: "var(--tmc-subtle-text)", fontSize: 12, cursor: "pointer", transition: "background 140ms ease, color 140ms ease, box-shadow 140ms ease" },
  ratingOptionSelected: { background: "var(--tmc-selected-bg)", color: "var(--tmc-primary)", boxShadow: "inset 0 0 0 1px var(--tmc-info-border)", fontWeight: 700 },
  ratingInput: { accentColor: "var(--tmc-primary)", margin: 0 },
  reviewFooter: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 20, paddingTop: 18, borderTop: "1px solid var(--tmc-border-light)" },
  toast: { position: "fixed", top: 88, right: 24, zIndex: 100, display: "flex", alignItems: "center", gap: 9, maxWidth: "min(420px, calc(100vw - 32px))", padding: "13px 16px", border: "1px solid var(--tmc-info-border)", borderRadius: 10, background: "var(--tmc-success-bg)", color: "var(--tmc-success-text)", boxShadow: "0 12px 28px rgba(23, 59, 80, 0.18)", fontSize: 13, fontWeight: 700, pointerEvents: "none" },
  dashboardHero: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 18, padding: 24, border: "1px solid var(--tmc-border)", borderRadius: 14, background: "linear-gradient(135deg, var(--tmc-surface) 0%, var(--tmc-surface-soft) 100%)" },
  dashboardWelcome: { margin: "3px 0 5px", color: "var(--tmc-heading)", fontSize: 28 },
  dashboardSubtitle: { margin: 0, color: "var(--tmc-muted)", fontSize: 14 },
  heroBadge: { display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 12px", borderRadius: 999, background: "var(--tmc-success-bg)", color: "var(--tmc-success-text)", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" },
  metricGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: 12 },
  metricCard: { minWidth: 0, padding: 17, border: "1px solid var(--tmc-border)", borderRadius: 12, background: "var(--tmc-surface)" },
  metricIcon: { display: "grid", placeItems: "center", width: 34, height: 34, marginBottom: 12, borderRadius: 9, background: "var(--tmc-profile-bg)", color: "var(--tmc-primary)" },
  metricValue: { color: "var(--tmc-heading)", fontSize: 25, fontWeight: 750, lineHeight: 1 },
  metricLabel: { marginTop: 8, color: "var(--tmc-subtle-text)", fontSize: 13, fontWeight: 700 },
  metricDetail: { marginTop: 4, color: "var(--tmc-muted)", fontSize: 11 },
  actionGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 16, alignItems: "stretch" },
  quickAction: { display: "flex", alignItems: "flex-start", gap: 14, minWidth: 0, padding: 20, border: "1px solid var(--tmc-border)", borderRadius: 12, background: "var(--tmc-surface)", boxSizing: "border-box" },
  quickActionIcon: { display: "grid", placeItems: "center", flex: "0 0 auto", width: 38, height: 38, borderRadius: 10, background: "var(--tmc-primary)", color: "var(--tmc-primary-contrast)" },
  quickActionBody: { display: "grid", gridTemplateRows: "auto 1fr auto", alignItems: "start", gap: 8, minWidth: 0, flex: 1 },
  quickActionTitle: { margin: "0 0 4px", color: "var(--tmc-heading)", fontSize: 16 },
  quickActionDescription: { margin: 0 },
  quickActionButton: { justifySelf: "start", width: "auto", padding: "8px 12px", fontSize: 12 },
  dashboardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 390px), 1fr))", gap: 16, alignItems: "stretch" },
  dashboardCard: { display: "flex", flexDirection: "column" },
  dashboardSectionHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 13 },
  textButton: { display: "inline-flex", alignItems: "center", gap: 5, border: 0, padding: 0, background: "transparent", color: "var(--tmc-link)", cursor: "pointer", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" },
  dashboardList: { display: "grid", gap: 7 },
  dashboardTrip: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, width: "100%", padding: "12px 0", border: 0, borderTop: "1px solid var(--tmc-border-light)", background: "transparent", color: "var(--tmc-text)", cursor: "pointer", textAlign: "left" },
  dashboardTripMeta: { display: "inline-flex", alignItems: "center", gap: 7, color: "var(--tmc-muted)", fontSize: 12, whiteSpace: "nowrap" },
  reportSummary: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--tmc-border-light)" },
  reportLink: { color: "var(--tmc-link)", fontSize: 12, fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap", border: 0, background: "transparent", padding: 0, cursor: "pointer", font: "inherit" },
  authPage: { minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "var(--tmc-bg)" },
  authCard: { width: "min(100%, 430px)", display: "grid", gap: 14, padding: 32, borderRadius: 16, background: "var(--tmc-surface)", border: "1px solid var(--tmc-border)", boxShadow: "var(--tmc-shadow)" },
  authTitle: { margin: 0, color: "var(--tmc-heading)", fontSize: 27 },
  titleRow: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 22 },
  title: { margin: 0, color: "var(--tmc-heading)", fontSize: 25 },
  sectionTitle: { margin: 0, color: "var(--tmc-heading)", fontSize: 17 },
  cardHeading: { display: "flex", alignItems: "center", gap: 8, marginBottom: 15 },
  muted: { color: "var(--tmc-muted)", fontSize: 13, lineHeight: 1.5 },
  tripSearch: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "9px 11px", border: "1px solid var(--tmc-border-strong)", borderRadius: 9, background: "var(--tmc-input-bg)", color: "var(--tmc-muted)" },
  tripSearchInput: { flex: 1, minWidth: 0, border: 0, outline: "none", padding: 0, background: "transparent", color: "var(--tmc-text)", fontSize: 13 },
  grid: { display: "grid", gridTemplateColumns: "minmax(250px, .8fr) minmax(0, 1.5fr)", gap: 18, alignItems: "start" },
  card: { minWidth: 0, padding: 20, border: "1px solid var(--tmc-border)", borderRadius: 14, background: "var(--tmc-surface)" },
  sectionHeader: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" },
  trip: { display: "flex", justifyContent: "space-between", gap: 10, width: "100%", marginBottom: 9, padding: 13, border: "1px solid var(--tmc-border)", borderRadius: 10, background: "var(--tmc-surface)", color: "var(--tmc-text)", cursor: "pointer", textAlign: "left" },
  tripActive: { borderColor: "var(--tmc-primary)", boxShadow: "0 0 0 2px var(--tmc-border-strong)" },
  count: { color: "var(--tmc-muted)", fontSize: 12, whiteSpace: "nowrap" },
  primary: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, border: 0, borderRadius: 8, padding: "10px 13px", background: "var(--tmc-primary)", color: "var(--tmc-primary-contrast)", cursor: "pointer", fontWeight: 600 },
  secondary: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, border: "1px solid var(--tmc-border-strong)", borderRadius: 8, padding: "9px 12px", background: "var(--tmc-surface)", color: "var(--tmc-subtle-text)", cursor: "pointer", fontWeight: 600 },
  error: { padding: "11px 13px", marginBottom: 16, borderRadius: 8, background: "var(--tmc-error-bg)", color: "var(--tmc-error-text)", fontSize: 13 },
  label: { display: "grid", gap: 7, color: "var(--tmc-subtle-text)", fontSize: 13, fontWeight: 600 },
  fieldLabel: { display: "inline-flex", alignItems: "center", gap: 5, color: "var(--tmc-subtle-text)", fontSize: 12, fontWeight: 700 },
  optional: { color: "var(--tmc-muted)", fontSize: 11, fontWeight: 500 },
  visuallyHidden: { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 },
  input: { width: "100%", boxSizing: "border-box", padding: "10px 11px", border: "1px solid var(--tmc-border-strong)", borderRadius: 8, fontSize: 14, background: "var(--tmc-input-bg)", color: "var(--tmc-text)" },
  linkBox: { display: "grid", gap: 9, marginTop: 18, padding: 13, border: "1px solid var(--tmc-info-border)", borderRadius: 10, background: "var(--tmc-info-bg)" },
  link: { overflowWrap: "anywhere", color: "var(--tmc-link)", fontSize: 12 },
  tripTabs: { display: "flex", gap: 5, marginTop: 20, paddingBottom: 3, borderBottom: "1px solid var(--tmc-border)" },
  tripTab: { display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 11px", border: 0, borderBottomWidth: 2, borderBottomStyle: "solid", borderBottomColor: "transparent", background: "transparent", color: "var(--tmc-muted)", cursor: "pointer", fontSize: 13, fontWeight: 700 },
  tripTabActive: { borderBottomColor: "var(--tmc-primary)", color: "var(--tmc-primary)" },
  landingView: { display: "grid", gap: 14, marginTop: 18 },
  landingSummary: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, padding: 15, border: "1px solid var(--tmc-border)", borderRadius: 10, background: "var(--tmc-surface-soft)" },
  landingStatus: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  landingTitle: { margin: 0, color: "var(--tmc-heading)", fontSize: 17 },
  landingFrame: { minHeight: 560, overflow: "hidden", border: "1px solid var(--tmc-border)", borderRadius: 10, background: "#fff" },
  landingIframe: { display: "block", width: "100%", height: 720, border: 0, background: "#fff" },
  landingEmpty: { display: "grid", gap: 6, marginTop: 18, padding: 24, border: "1px dashed var(--tmc-border-strong)", borderRadius: 10, color: "var(--tmc-muted)", fontSize: 13, lineHeight: 1.5 },
  subheading: { margin: "24px 0 10px", color: "var(--tmc-heading)", fontSize: 15 },
  list: { display: "grid", gap: 8 },
  listRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 0", borderTop: "1px solid var(--tmc-border-light)" },
  participantPeople: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: "10px 24px", minWidth: 0, flex: 1 },
  personBlock: { display: "grid", gap: 3, minWidth: 0 },
  personLabel: { color: "var(--tmc-muted)", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" },
  personContact: { display: "grid", gap: 2, color: "var(--tmc-muted)", fontSize: 11, overflowWrap: "anywhere" },
  badge: { padding: "4px 8px", borderRadius: 999, background: "var(--tmc-badge-bg)", color: "var(--tmc-link)", fontSize: 11, whiteSpace: "nowrap" },
  empty: { display: "flex", alignItems: "center", justifyContent: "center", flex: 1, gap: 8, minHeight: 88, padding: "24px 10px", color: "var(--tmc-muted)", fontSize: 14, lineHeight: 1.5, textAlign: "center", boxSizing: "border-box" },
  notificationWrap: { position: "relative", flex: "0 0 auto" },
  notificationBadge: { position: "absolute", top: -5, right: -5, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "#dc2626", color: "#fff", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1 },
  notificationBackdrop: { position: "fixed", inset: 0, zIndex: 40, border: 0, background: "transparent", cursor: "default" },
  notificationPanel: { position: "absolute", right: 0, top: "calc(100% + 8px)", width: 340, maxWidth: "90vw", maxHeight: 420, overflowY: "auto", zIndex: 41, background: "var(--tmc-surface)", color: "var(--tmc-text)", border: "1px solid var(--tmc-border)", borderRadius: 12, boxShadow: "var(--tmc-shadow)" },
  notificationHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--tmc-border-light)" },
  markRead: { border: 0, padding: 0, background: "transparent", color: "var(--tmc-link)", cursor: "pointer", fontSize: 12, fontWeight: 600 },
  notificationEmpty: { padding: 18, color: "var(--tmc-muted)", fontSize: 13, textAlign: "center" },
  notificationItem: { display: "grid", gap: 4, width: "100%", padding: "10px 14px", border: 0, borderBottom: "1px solid var(--tmc-border-light)", background: "transparent", color: "var(--tmc-text)", cursor: "pointer", textAlign: "left" },
  notificationItemUnread: { background: "var(--tmc-profile-bg)" },
  notificationItemTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700 },
  notificationItemBody: { color: "var(--tmc-muted)", fontSize: 12 },
  unreadDot: { width: 7, height: 7, flex: "0 0 auto", borderRadius: "50%", background: "#dc2626" },
  profilePage: { display: "grid", gap: 18 },
  profileHero: { display: "flex", alignItems: "center", gap: 16, padding: 24, border: "1px solid var(--tmc-border)", borderRadius: 14, background: "var(--tmc-surface)" },
  profileHeroAvatar: { display: "grid", placeItems: "center", width: 64, height: 64, borderRadius: "50%", background: "var(--tmc-primary)", color: "var(--tmc-primary-contrast)", fontSize: 24, fontWeight: 700 },
  profileName: { margin: 0, color: "var(--tmc-heading)", fontSize: 22 },
  profileDetails: { display: "grid", gap: 14, margin: 0 },
  profileLabel: { color: "var(--tmc-muted)", fontSize: 12 },
  profileValue: { margin: "3px 0 0", color: "var(--tmc-text)", fontSize: 14, fontWeight: 600 },
  spin: { animation: "spin 1s linear infinite" },
};
