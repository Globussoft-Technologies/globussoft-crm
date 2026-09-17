import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { AuthContext } from "../appContexts";
import { useContext } from "react";
import { usePermissions } from "../hooks/usePermissions";
import { fetchApi } from "../utils/api";
import {
  GENERIC_FEATURE_TOURS,
  findGenericFeatureForPath,
} from "./genericFeatureRegistry";
import {
  TOUR_PREFERENCES_EVENT,
  mergeTourStates,
  readTourState,
  writeTourState,
} from "./tourStorage";
import { ProductTourContext } from "./productTourContext";
import TourPageAnchors from "./TourPageAnchors";
import { GENERIC_WELCOME_TOUR, WELCOME_TOUR_KEY } from "./welcomeTour";
import {
  needsTourPreparation,
  performTourActions,
  waitForTourTarget,
} from "./tourStepActions";
import { canUseGenericSidebarPage, getGenericAccessByPath } from "../utils/sidebarSearch";

function canAccess(feature, user, permissionState) {
  const role = String(user?.role || "").toUpperCase();
  const isAdmin = role === "ADMIN" || role === "OWNER" || permissionState.isOwner;
  const isManager = isAdmin || role === "MANAGER";
  if (feature.ownerOnly && !permissionState.isOwner && role !== "OWNER") return false;
  if (feature.hideForAdmin && isAdmin) return false;
  if (feature.adminOnly && !isAdmin) return false;
  if (feature.managerOnly && !isManager) return false;
  if (feature.userOnly && isManager) return false;
  // Pattern-only/detail workflows do not represent permission-catalog pages
  // (for example /contacts/:id). Keep the generic tour catalogue limited to
  // explicitly catalogued page routes.
  if (feature.pattern && !feature.path) return false;
  // Organization Settings is an administrator-only walkthrough even when a
  // lower role has settings.read for view access to the page.
  if (feature.path === "/settings" && !isAdmin) return false;
  // Generic feature tours inherit the same page-level access contract as the
  // generic sidebar. This prevents a tour with incomplete legacy metadata
  // (for example Settings or Contacts) from opening an inaccessible page.
  if (feature.path) {
    const pageAccess = getGenericAccessByPath(feature.path);
    // A route-only tour is not part of the generic permission/page catalog;
    // do not expose it from Browse/Restart All Tours. Only catalogued pages
    // with an effective permission are tourable.
    if (!pageAccess) return false;
    if (feature.path === "/tasks") return true;
    if (pageAccess && !canUseGenericSidebarPage(pageAccess, {
      isAdmin,
      isManager,
      permissionsReady: permissionState.isReady,
      hasPermission: permissionState.hasPermission,
    })) return false;
  }
  if (feature.requiredPermission) {
    if (!permissionState.isReady) return false;
    return permissionState.hasPermission(
      feature.requiredPermission.module,
      feature.requiredPermission.action,
    );
  }
  return true;
}

function filterWelcomeStepsForAccess(steps, permissionState) {
  const canSeeDashboard = permissionState.isReady
    && permissionState.hasPermission("reports", "read");
  return steps
    .filter((step) => {
      const dashboardStep = step.navigateTo === "/dashboard"
        || String(step.target || "").includes("/dashboard");
      return !dashboardStep || canSeeDashboard;
    })
    .map((step) => {
      // The sidebar orientation remains useful without dashboard access;
      // remove only the forced navigation that would otherwise send the user
      // to an Access Denied page.
      if (!canSeeDashboard && step.navigateTo === "/dashboard") {
        const safeStep = { ...step };
        delete safeStep.navigateTo;
        return safeStep;
      }
      return step;
    });
}

function TourOverlay({ tour, stepIndex, onPrevious, onNext, onClose, onSkip, onSkipAll }) {
  const step = tour.steps[stepIndex];
  const [rect, setRect] = useState(null);
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  ));
  const dialogRef = useRef(null);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useLayoutEffect(() => {
    let frame = null;
    let observer = null;
    let mutationObserver = null;
    const resolveTarget = () => {
      const direct = step?.target ? document.querySelector(step.target) : null;
      if (direct) return direct;
      const root = document.querySelector('[data-tour="page-content"]')
        || document.querySelector('main, [role="main"]');
      if (!root) return null;
      const candidates = Array.from(root.querySelectorAll(
        '[data-tour]:not([data-tour="page-content"]), .card, section, form, button, input, [role="button"], [role="tab"]',
      )).filter((element) => {
        if (!element.isConnected || element.hidden || element.closest('[aria-hidden="true"]')) return false;
        const style = window.getComputedStyle?.(element);
        return style?.display !== "none" && style?.visibility !== "hidden" && element.getClientRects().length > 0;
      });
      const terms = `${step?.title || ""} ${step?.content || ""}`.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [];
      const match = candidates.map((element) => ({
        element,
        score: terms.reduce((score, term) => score + (element.textContent?.toLowerCase().includes(term) ? 1 : 0), 0),
      })).sort((a, b) => b.score - a.score)[0];
      return match?.score > 0 ? match.element : candidates[0] || root;
    };
    const update = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target = resolveTarget();
        if (!target || target.getClientRects().length === 0) {
          setRect(null);
          return;
        }
        const next = target.getBoundingClientRect();
        setRect({ top: next.top, left: next.left, width: next.width, height: next.height });
      });
    };
    const target = resolveTarget();
    target?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    if (typeof ResizeObserver !== "undefined" && target) {
      observer = new ResizeObserver(update);
      observer.observe(target);
    }
    // Target-only steps can render before page-owned anchors are attached.
    // Re-measure when the page finishes rendering instead of leaving the
    // tour stuck on the full-page fallback overlay.
    mutationObserver = new MutationObserver(update);
    mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [reducedMotion, step]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll("button:not([disabled]), [href]"),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.querySelector("button")?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, stepIndex]);

  const viewportWidth = Math.max(0, window.innerWidth);
  const viewportHeight = Math.max(0, window.innerHeight);
  const isCompact = viewportWidth < 600;
  const cardWidth = Math.min(380, Math.max(0, viewportWidth - 32));
  const centeredCardHeight = Math.min(280, Math.max(0, viewportHeight - 32));
  const estimatedCardHeight = Math.min(300, Math.max(0, viewportHeight - 32));
  const maxCardTop = Math.max(16, viewportHeight - estimatedCardHeight - 16);
  let cardPosition = {
    left: Math.max(16, (viewportWidth - cardWidth) / 2),
    top: Math.max(16, (viewportHeight - centeredCardHeight) / 2),
  };
  if (rect && step?.placement !== "center") {
    const gap = 18;
    const belowTop = rect.top + rect.height + gap;
    const aboveTop = rect.top - estimatedCardHeight - gap;
    const canFitBelow = belowTop + estimatedCardHeight <= viewportHeight - 16;
    const canFitAbove = aboveTop >= 16;
    if (canFitBelow || canFitAbove) {
      cardPosition = {
        left: Math.max(16, Math.min(rect.left + rect.width / 2 - cardWidth / 2, viewportWidth - cardWidth - 16)),
        top: canFitBelow ? belowTop : aboveTop,
      };
    } else {
      const proposedLeft = rect.left + rect.width + gap;
      cardPosition = {
        left: Math.max(16, Math.min(proposedLeft, viewportWidth - cardWidth - 16)),
        top: Math.min(Math.max(16, rect.top), maxCardTop),
      };
    }
  }

  return createPortal(
    <div
      data-testid="product-tour-overlay"
      data-tour-layout={isCompact ? "mobile" : "desktop"}
    >
      {rect ? (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            top: Math.max(4, rect.top - 6),
            left: Math.min(Math.max(4, rect.left - 6), Math.max(4, viewportWidth - 8)),
            width: Math.min(rect.width + 12, Math.max(0, viewportWidth - 8)),
            height: rect.height + 12,
            border: "3px solid var(--primary-color, var(--accent-color))",
            borderRadius: 10,
            boxShadow: "0 0 0 9999px rgba(5, 8, 20, 0.68)",
            pointerEvents: "none",
            zIndex: 10000,
          }}
        />
      ) : (
        <div
          aria-hidden="true"
          style={{ position: "fixed", inset: 0, background: "rgba(5, 8, 20, 0.68)", zIndex: 10000 }}
        />
      )}
      <section
        ref={dialogRef}
        data-tour-surface="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-tour-title"
        style={{
          position: "fixed",
          ...cardPosition,
          width: cardWidth,
          height: Math.min(320, Math.max(0, viewportHeight - 32)),
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          scrollbarGutter: "stable",
          padding: isCompact ? 16 : 20,
          borderRadius: 14,
          border: "1px solid var(--border-color)",
          background: "#ffffff",
          opacity: 1,
          color: "var(--text-primary, #111827)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
          transition: reducedMotion ? "none" : "top 160ms ease, left 160ms ease",
          zIndex: 10001,
        }}
      >
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}
        >
          Step {stepIndex + 1} of {tour.steps.length}: {step.title}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close tour"
          title="Close and resume later"
          style={{ position: "absolute", top: 10, right: 10, border: 0, background: "none", color: "inherit", cursor: "pointer", padding: 6 }}
        >
          <X size={18} />
        </button>
        <div style={{ color: "var(--text-secondary)", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>
          Step {stepIndex + 1} of {tour.steps.length}
        </div>
        <h2 id="product-tour-title" style={{ fontSize: 20, margin: "0 32px 8px 0" }}>
          {step.title}
        </h2>
        <p style={{ color: "var(--text-secondary)", lineHeight: 1.55, margin: "0 0 18px" }}>
          {step.content}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between", marginTop: "auto" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn-secondary" onClick={onSkip}>Skip tour</button>
            <button type="button" className="btn-secondary" onClick={onSkipAll}>Skip all</button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {stepIndex > 0 && <button type="button" className="btn-secondary" onClick={onPrevious}>Back</button>}
            <button type="button" className="btn-primary" onClick={onNext}>
              {stepIndex === tour.steps.length - 1 ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

export default function ProductTourProvider({ children }) {
  const { user, tenant } = useContext(AuthContext) || {};
  const permissionState = usePermissions();
  const location = useLocation();
  const navigate = useNavigate();
  const tenantId = tenant?.id;
  const userId = user?.userId || user?.id || user?.email;
  const isAvailable = !!user && (tenant?.vertical || "generic") === "generic";
  const [state, setState] = useState(() => readTourState(tenantId, userId));
  const stateRef = useRef(state);
  const [active, setActive] = useState(null);
  const autoStartedRef = useRef(new Set());
  const syncTimerRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const syncGenerationRef = useRef(0);
  const suppressModuleAutoPathRef = useRef(null);
  const originScreenRef = useRef(null);
  const stepRestorersRef = useRef([]);
  const advanceRef = useRef(null);
  const launcherFocusRef = useRef(null);
  const [remoteReady, setRemoteReady] = useState(false);

  useEffect(() => {
    syncGenerationRef.current += 1;
    if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
    setRemoteReady(false);
    const next = readTourState(tenantId, userId);
    stateRef.current = next;
    setState(next);
    setActive(null);
    autoStartedRef.current.clear();
    suppressModuleAutoPathRef.current = null;
  }, [tenantId, userId]);

  useEffect(() => {
    const content = document.querySelector('[data-tour="page-content"]');
    const candidates = [content?.parentElement, content?.parentElement?.parentElement].filter(Boolean);
    if (active) {
      candidates.forEach((element) => {
        element.setAttribute("inert", "");
        element.setAttribute("aria-hidden", "true");
      });
    }
    return () => candidates.forEach((element) => {
      element.removeAttribute("inert");
      element.removeAttribute("aria-hidden");
    });
  }, [active]);

  const pushRemote = useCallback(async (next) => {
    if (!isAvailable || !userId || !tenantId) return;
    return fetchApi("/api/tours/state", {
      method: "PUT",
      body: JSON.stringify({
        preferences: next.preferences,
        progress: next.progress,
        progressResetAt: next.progressResetAt,
      }),
      silent: true,
    });
  }, [isAvailable, tenantId, userId]);

  const syncRemote = useCallback(async () => {
    if (!isAvailable || !userId || !tenantId) return;
    const generation = syncGenerationRef.current;
    try {
      const remote = await fetchApi("/api/tours/state", { silent: true });
      if (generation !== syncGenerationRef.current) return;
      const merged = mergeTourStates(stateRef.current, remote);
      applyingRemoteRef.current = true;
      stateRef.current = merged;
      setState(merged);
      writeTourState(tenantId, userId, merged);
      applyingRemoteRef.current = false;
      if (JSON.stringify(merged) !== JSON.stringify(mergeTourStates(remote, remote))) {
        await pushRemote(merged);
      }
    } catch {
      // Local state remains authoritative while offline. The online listener
      // below retries reconciliation without interrupting the user's tour.
      if (generation === syncGenerationRef.current) applyingRemoteRef.current = false;
    } finally {
      if (generation === syncGenerationRef.current) setRemoteReady(true);
    }
  }, [isAvailable, pushRemote, tenantId, userId]);

  useEffect(() => {
    syncRemote();
    window.addEventListener("online", syncRemote);
    window.addEventListener("focus", syncRemote);
    return () => {
      window.removeEventListener("online", syncRemote);
      window.removeEventListener("focus", syncRemote);
    };
  }, [syncRemote]);

  useEffect(() => {
    const sync = (event) => {
      if (event.detail?.tenantId !== tenantId || event.detail?.userId !== userId) return;
      const next = readTourState(tenantId, userId);
      stateRef.current = next;
      setState(next);
    };
    window.addEventListener(TOUR_PREFERENCES_EVENT, sync);
    return () => window.removeEventListener(TOUR_PREFERENCES_EVENT, sync);
  }, [tenantId, userId]);

  const persist = useCallback((updater) => {
    const current = stateRef.current;
    const next = typeof updater === "function" ? updater(current) : updater;
    stateRef.current = next;
    setState(next);
    writeTourState(tenantId, userId, next);
    if (!applyingRemoteRef.current && isAvailable) {
      if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = window.setTimeout(() => {
        pushRemote(next).catch(() => {});
      }, 500);
    }
  }, [isAvailable, pushRemote, tenantId, userId]);

  useEffect(() => () => {
    if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
  }, []);

  const availableTours = useMemo(
    () => isAvailable
    ? [GENERIC_WELCOME_TOUR, ...GENERIC_FEATURE_TOURS].filter((feature) => canAccess(feature, user, permissionState)).map((tour) => ({
        ...tour,
        steps: filterWelcomeStepsForAccess(
          tour.steps.filter((step) => !step.roles || step.roles.includes(String(user?.role || "").toUpperCase())),
          permissionState,
        ),
      }))
      : [],
    [isAvailable, permissionState, user],
  );
  const currentFeature = useMemo(
    () => findGenericFeatureForPath(location.pathname),
    [location.pathname],
  );
  const effectiveEnabled = isAvailable
    && state.organizationEnabled !== false
    && state.preferences.enabled !== false;
  const canManageOrganization = !!user
    && (user?.isOwner === true || ["ADMIN", "OWNER"].includes(String(user?.role || "").toUpperCase()));

  const startTour = useCallback((tourId, options = {}) => {
    if (!effectiveEnabled) return false;
    const tour = availableTours.find((candidate) => candidate.id === tourId);
    if (!tour) return false;
    originScreenRef.current = `${location.pathname}${location.search}${location.hash}`;
    launcherFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    stepRestorersRef.current = [];
    if (tour.path && options.navigate !== false && location.pathname !== tour.path) {
      navigate(tour.path);
    }
    // Whether started automatically or manually, do not immediately reopen a
    // tour that the user closes during this browser session. Persisted status
    // still allows it to resume after a reload or through the explicit Help
    // action.
    autoStartedRef.current.add(`${tour.id}:${tour.version}`);
    if (tour.welcome) suppressModuleAutoPathRef.current = location.pathname;
    const saved = state.progress[`${tour.id}:${tour.version}`];
    const stepIndex = options.restart ? 0 : Math.min(saved?.currentStep || 0, tour.steps.length - 1);
    // Persist the first automatic start immediately. Without this marker, a
    // browser refresh before the user clicks Next/Close looks like a brand-new
    // tour and the auto-start effect opens it again.
    persist((current) => ({
      ...current,
      progress: {
        ...current.progress,
        [`${tour.id}:${tour.version}`]: {
          ...(current.progress[`${tour.id}:${tour.version}`] || {}),
          status: "IN_PROGRESS",
          currentStep: stepIndex,
          updatedAt: new Date().toISOString(),
        },
      },
    }));
    setActive({ tour, stepIndex, preparing: needsTourPreparation(tour.steps[stepIndex]), continueSequence: options.continueSequence !== false });
    return true;
  }, [availableTours, effectiveEnabled, location.hash, location.pathname, location.search, navigate, persist, state.progress]);

  const record = useCallback((tour, patch) => {
    const key = `${tour.id}:${tour.version}`;
    persist((current) => ({
      ...current,
      progress: {
        ...current.progress,
        [key]: { ...(current.progress[key] || {}), ...patch, updatedAt: new Date().toISOString() },
      },
    }));
  }, [persist]);

  const restoreOriginalScreen = useCallback(() => {
    for (const restore of stepRestorersRef.current.splice(0)) {
      try { restore(); } catch { /* A removed target needs no restoration. */ }
    }
    const origin = originScreenRef.current;
    originScreenRef.current = null;
    if (origin && origin !== `${location.pathname}${location.search}${location.hash}`) navigate(origin);
    const launcher = launcherFocusRef.current;
    launcherFocusRef.current = null;
    window.setTimeout(() => {
      const focusTarget = launcher?.isConnected
        ? launcher
        : document.querySelector('[data-tour="tour-launcher"]');
      focusTarget?.focus?.({ preventScroll: true });
    }, 0);
  }, [location.hash, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (!active) return;
    if (!availableTours.some((tour) => tour.id === active.tour.id)) {
      setActive(null);
      restoreOriginalScreen();
    }
  }, [active, availableTours, restoreOriginalScreen]);

  const closeTour = useCallback(() => {
    if (active) record(active.tour, { status: "IN_PROGRESS", currentStep: active.stepIndex });
    setActive(null);
    restoreOriginalScreen();
  }, [active, record, restoreOriginalScreen]);
  const skipTour = useCallback(() => {
    if (active) record(active.tour, { status: "DISMISSED", currentStep: active.stepIndex, dismissedAt: new Date().toISOString() });
    setActive(null);
    restoreOriginalScreen();
  }, [active, record, restoreOriginalScreen]);
  const skipAllTours = useCallback(() => {
    if (active) record(active.tour, { status: "DISMISSED", currentStep: active.stepIndex, dismissedAt: new Date().toISOString() });
    persist((current) => ({ ...current, preferences: { ...current.preferences, enabled: false, updatedAt: new Date().toISOString() } }));
    setActive(null);
    restoreOriginalScreen();
  }, [active, persist, record, restoreOriginalScreen]);
  const setPreferences = useCallback((patch) => {
    persist((current) => ({ ...current, preferences: { ...current.preferences, ...patch, updatedAt: new Date().toISOString() } }));
    if (patch.enabled === false) {
      setActive(null);
      restoreOriginalScreen();
    }
  }, [persist, restoreOriginalScreen]);
  const restartAllTours = useCallback(() => {
    if (!isAvailable) return;
    const progressResetAt = new Date().toISOString();
    persist((current) => ({
      ...current,
      progress: {},
      progressResetAt,
    }));
    autoStartedRef.current.clear();
    startTour(GENERIC_WELCOME_TOUR.id, { restart: true, navigate: false });
  }, [isAvailable, persist, startTour]);
  const setOrganizationEnabled = useCallback(async (enabled) => {
    if (!canManageOrganization || typeof enabled !== "boolean") return false;
    try {
      const response = await fetchApi("/api/tours/organization-preferences", {
        method: "PUT",
        body: JSON.stringify({ organizationEnabled: enabled }),
      });
      persist((current) => ({ ...current, organizationEnabled: response.organizationEnabled !== false }));
      if (response.organizationEnabled === false) setActive(null);
      return true;
    } catch {
      return false;
    }
  }, [canManageOrganization, persist]);

  const next = useCallback(() => {
    if (!active) return;
    if (active.stepIndex >= active.tour.steps.length - 1) {
      record(active.tour, { status: "COMPLETED", currentStep: active.stepIndex, completedAt: new Date().toISOString() });
      setActive(null);
      const currentIndex = availableTours.findIndex((tour) => tour.id === active.tour.id);
      const nextTour = active.continueSequence !== false && currentIndex >= 0
        ? availableTours[currentIndex + 1]
        : null;
      if (nextTour && isAvailable) {
        for (const restore of stepRestorersRef.current.splice(0)) {
          try { restore(); } catch { /* target may have unmounted */ }
        }
        originScreenRef.current = null;
        launcherFocusRef.current = null;
        startTour(nextTour.id, { restart: true });
      } else {
        restoreOriginalScreen();
      }
      return;
    }
    const stepIndex = active.stepIndex + 1;
    record(active.tour, { status: "IN_PROGRESS", currentStep: stepIndex });
    setActive({ ...active, stepIndex, preparing: needsTourPreparation(active.tour.steps[stepIndex]) });
  }, [active, availableTours, isAvailable, record, restoreOriginalScreen, startTour]);
  advanceRef.current = next;

  const activeTourId = active?.tour.id;
  const activeStepIndex = active?.stepIndex;
  const activeStep = active?.tour.steps[activeStepIndex];

  useEffect(() => {
    if (!active?.preparing) return undefined;
    const step = activeStep;
    const controller = new AbortController();
    let current = true;

    const prepare = async () => {
      if (step.navigateTo && location.pathname !== step.navigateTo) {
        navigate(step.navigateTo);
        return;
      }
      const actionResult = await performTourActions(step.actions, { signal: controller.signal });
      if (!current || controller.signal.aborted) return;
      stepRestorersRef.current.unshift(...actionResult.restorers);

      const requiredSelector = step.requiresRecords || step.waitFor || step.target;
      const target = requiredSelector
        ? await waitForTourTarget(requiredSelector, {
          timeoutMs: step.timeoutMs || 4000,
          requireVisible: step.requireVisible !== false,
          signal: controller.signal,
        })
        : null;
      if (!current || controller.signal.aborted) return;
      if (!actionResult.ok || (!target && (step.skipIfMissing || step.requiresRecords))) {
        advanceRef.current?.();
        return;
      }
      setActive((value) => value?.tour.id === activeTourId && value.stepIndex === activeStepIndex
        ? { ...value, preparing: false }
        : value);
    };
    prepare();
    return () => {
      current = false;
      controller.abort();
    };
  }, [active?.preparing, activeStep, activeStepIndex, activeTourId, location.pathname, navigate]);

  useEffect(() => {
    if (!remoteReady || !effectiveEnabled || active || !currentFeature || !state.preferences.autoStart) return undefined;
    const welcomeStatus = state.progress[WELCOME_TOUR_KEY]?.status;
    if (welcomeStatus !== "COMPLETED" && welcomeStatus !== "DISMISSED") return undefined;
    if (suppressModuleAutoPathRef.current === location.pathname) return undefined;
    const key = `${currentFeature.id}:${currentFeature.version}`;
    const saved = state.progress[key];
    if (saved?.status || autoStartedRef.current.has(key)) return undefined;
    autoStartedRef.current.add(key);
    const timer = window.setTimeout(() => startTour(currentFeature.id, { navigate: false }), 700);
    return () => window.clearTimeout(timer);
  }, [active, currentFeature, effectiveEnabled, location.pathname, remoteReady, startTour, state.preferences.autoStart, state.progress]);

  useEffect(() => {
    if (!remoteReady || !effectiveEnabled || active || !state.preferences.autoStart) return undefined;
    const saved = state.progress[WELCOME_TOUR_KEY];
    if (saved?.status || autoStartedRef.current.has(WELCOME_TOUR_KEY)) return undefined;
    const timer = window.setTimeout(() => startTour(GENERIC_WELCOME_TOUR.id, { navigate: false, continueSequence: false }), 500);
    return () => window.clearTimeout(timer);
  }, [active, effectiveEnabled, remoteReady, startTour, state.preferences.autoStart, state.progress]);

  const value = useMemo(() => ({
    isAvailable,
    effectiveEnabled,
    organizationEnabled: state.organizationEnabled !== false,
    canManageOrganization,
    preferences: state.preferences,
    progress: state.progress,
    currentFeature,
    availableTours,
    activeTour: active,
    startTour,
    startCurrentTour: () => currentFeature ? startTour(currentFeature.id, { restart: true, navigate: false, continueSequence: false }) : false,
    closeTour,
    skipTour,
    skipAllTours,
    setPreferences,
    setOrganizationEnabled,
    restartAllTours,
  }), [active, availableTours, canManageOrganization, closeTour, currentFeature, effectiveEnabled, isAvailable, restartAllTours, setOrganizationEnabled, setPreferences, skipAllTours, skipTour, startTour, state.organizationEnabled, state.preferences, state.progress]);

  return (
    <ProductTourContext.Provider value={value}>
      {children}
      {isAvailable && <TourPageAnchors />}
      {active && !active.preparing && (
        <TourOverlay
          tour={active.tour}
          stepIndex={active.stepIndex}
          onPrevious={() => {
            const stepIndex = Math.max(0, active.stepIndex - 1);
            setActive({ ...active, stepIndex, preparing: needsTourPreparation(active.tour.steps[stepIndex]) });
          }}
          onNext={next}
          onClose={closeTour}
          onSkip={skipTour}
          onSkipAll={skipAllTours}
        />
      )}
    </ProductTourContext.Provider>
  );
}
