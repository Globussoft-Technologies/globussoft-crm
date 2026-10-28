import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  CreditCard,
  IndianRupee,
  CheckCircle,
  XCircle,
  RefreshCw,
  Clock,
  X,
  Settings as SettingsIcon,
  AlertTriangle,
  Plus,
  ChevronLeft,
  ChevronRight,
  Filter,
} from "lucide-react";
import { Link } from "react-router-dom";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";
import { AuthContext } from "../App";
import { formatMoney, currencySymbol } from "../utils/money";
import {
  DateRangeFilter,
  resolveDateRange,
  DATE_FILTER_OPTIONS,
} from "../components/wellness/DateRangeFilter";
import RazorpayGatewayCard from "../components/RazorpayGatewayCard";
import TopScrollSync from "../components/TopScrollSync";

// ── Style constants ───────────────────────────────────────────────
// Theme-aware so cards stay clearly delineated under BOTH light + dark
// modes. Pre-fix these used hardcoded `rgba(255,255,255,0.05)` which
// rendered near-invisibly on light backgrounds.
const GLASS = {
  background: "var(--surface-color)",
  border: "1px solid var(--border-color)",
  backdropFilter: "blur(12px)",
  borderRadius: "12px",
};

const STATUS_CONFIG = {
  SUCCESS: {
    color: "#10b981",
    bg: "rgba(16,185,129,0.15)",
    label: "Success",
    Icon: CheckCircle,
  },
  PENDING: {
    color: "#f59e0b",
    bg: "rgba(245,158,11,0.15)",
    label: "Pending",
    Icon: Clock,
  },
  FAILED: {
    color: "#ef4444",
    bg: "rgba(239,68,68,0.15)",
    label: "Failed",
    Icon: XCircle,
  },
  REFUNDED: {
    color: "#9ca3af",
    bg: "rgba(156,163,175,0.15)",
    label: "Refunded",
    Icon: RefreshCw,
  },
};

const GATEWAY_CONFIG = {
  stripe: { color: "#635bff", bg: "rgba(99,91,255,0.15)", label: "Stripe" },
  razorpay: {
    color: "#3395ff",
    bg: "rgba(51,149,255,0.15)",
    label: "Razorpay",
  },
};

const EMPTY_PAYMENT_COLUMN_FILTERS = {
  currency: "ALL",
  gateway: "ALL",
  status: "ALL",
  paidDatePreset: "all",
  paidDateStart: "",
  paidDateEnd: "",
};

function PaymentHeaderFilter({ label, filterKey, activeFilter, hasValue, onToggle, children }) {
  const isOpen = activeFilter === filterKey;
  const triggerRef = useRef(null);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    const positionPopover = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const popupWidth = 210;
      setPopoverPosition({
        top: rect.bottom + 8,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - popupWidth - 8)),
      });
    };
    positionPopover();
    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
    };
  }, [isOpen]);

  return (
    <div className="payment-header-filter" data-payment-column-filter>
      <span>{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className={`payment-header-filter-button${hasValue ? " is-active" : ""}`}
        onClick={() => onToggle(isOpen ? null : filterKey)}
        aria-label={`Filter ${label}`}
        aria-expanded={isOpen}
      >
        <Filter size={14} aria-hidden="true" />
      </button>
      {isOpen && createPortal(
        <div className="payment-header-filter-popover" data-payment-column-filter style={{ top: popoverPosition.top, left: popoverPosition.left }}>
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const normalizedStatus = ["PAID", "CAPTURED"].includes(String(status || "").toUpperCase())
    ? "SUCCESS"
    : status;
  const cfg = STATUS_CONFIG[normalizedStatus] || STATUS_CONFIG.PENDING;
  const Icon = cfg.Icon;
  return (
    <span
      style={{
        padding: "0.25rem 0.6rem",
        borderRadius: "999px",
        fontSize: "0.72rem",
        fontWeight: 600,
        backgroundColor: cfg.bg,
        color: cfg.color,
        border: `1px solid ${cfg.color}33`,
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
      }}
    >
      <Icon size={12} />
      {cfg.label}
    </span>
  );
}

function GatewayBadge({ gateway }) {
  const key = String(gateway || "").toLowerCase();
  const cfg = GATEWAY_CONFIG[key] || {
    color: "#9ca3af",
    bg: "rgba(156,163,175,0.15)",
    label: gateway || "Unknown",
  };
  return (
    <span
      style={{
        padding: "0.2rem 0.6rem",
        borderRadius: "6px",
        fontSize: "0.7rem",
        fontWeight: 600,
        backgroundColor: cfg.bg,
        color: cfg.color,
        border: `1px solid ${cfg.color}33`,
        textTransform: "capitalize",
      }}
    >
      {cfg.label}
    </span>
  );
}

function plotPaymentSubjectLabel(payment) {
  if (payment?.metadata?.kind !== "plot-booking-payment" || !payment.plotSite) return null;
  const plotName = String(payment.plotSite.name || "").trim();
  const plotNumber = String(payment.plotSite.plotNumber || "").trim();
  if (plotName && plotNumber) return `${plotName} (Plot No. ${plotNumber})`;
  return plotName || (plotNumber ? `Plot No. ${plotNumber}` : null);
}

function paymentSubjectLabel(payment, { preferPlotSite = false } = {}) {
  if (!payment) return null;
  if (preferPlotSite) {
    const plotLabel = plotPaymentSubjectLabel(payment);
    if (plotLabel) return plotLabel;
  }
  if (payment.description) return payment.description;
  if (payment.service?.name) return payment.service.name;
  if (payment.product?.name) return payment.product.name;
  if (payment.invoiceId) return `Invoice #${payment.invoiceId}`;
  return payment.travelInvoiceNum || null;
}

// Generic CRM pickup/plot payments are denominated in INR even when an older
// tenant record still carries USD as its default. Other verticals retain the
// existing tenant-aware currency behavior.
function formatCurrency(amount, currency) {
  return formatMoney(amount || 0, currency ? { currency, locale: currency === "INR" ? "en-IN" : undefined } : undefined);
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function formatPaidDate(value) {
  if (!value) return "—";
  try {
    // Payment dates entered through a date picker are calendar dates, not
    // user-facing timestamps. Avoid showing UTC midnight as 5:30 AM in IST.
    return new Date(value).toLocaleDateString();
  } catch {
    return String(value);
  }
}

function openNativeDatePicker(event) {
  try {
    event.currentTarget.showPicker?.();
  } catch {
    // Browsers that open date inputs automatically may reject showPicker().
  }
}

export default function Payments() {
  const { user, tenant } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";
  const isCustomer = user?.role === "CUSTOMER" || user?.userType === "CUSTOMER";
  const isGenericCrm = (tenant?.vertical || user?.tenant?.vertical) === "generic";
  const displayCurrency = isGenericCrm ? tenant?.defaultCurrency || user?.tenant?.defaultCurrency : undefined;
  const notify = useNotify();

  const [payments, setPayments] = useState([]);
  const [availableCurrencies, setAvailableCurrencies] = useState([]);
  const [customerLedger, setCustomerLedger] = useState({ total: 0, stats: { collected: 0, pending: 0, failed: 0 } });
  const [genericStats, setGenericStats] = useState(null);
  const loadSequence = useRef(0);
  const [config, setConfig] = useState(null);
  const [tab, setTab] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refundingId, setRefundingId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [showGatewayConfiguration, setShowGatewayConfiguration] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [columnFilters, setColumnFilters] = useState(() => ({
    ...EMPTY_PAYMENT_COLUMN_FILTERS,
    paidDatePreset: "last30",
  }));
  const [activeColumnFilter, setActiveColumnFilter] = useState(null);
  const selectGateway = useCallback((gateway) => {
    setTab(gateway);
    if (isGenericCrm && !isCustomer) {
      setColumnFilters((current) => ({
        ...current,
        gateway: gateway === "all" ? "ALL" : gateway,
      }));
    }
  }, [isGenericCrm, isCustomer]);
  const toggleStatusFilter = useCallback((status) => {
    setColumnFilters((current) => ({
      ...current,
      status: current.status === status ? "ALL" : status,
    }));
    setActiveColumnFilter(null);
  }, []);
  // Default to last30 to preserve the prior "Total Collected (30D)" semantics —
  // user can now switch to today / this week / this month / this year / custom
  // and the KPI label and table follow.
  const [dateFilter, setDateFilter] = useState({
    preset: "last30",
    start: "",
    end: "",
  });
  const [rangeStart, rangeEnd] = useMemo(() => resolveDateRange(dateFilter), [dateFilter]);
  const filterLabel = useMemo(() => {
    const o = DATE_FILTER_OPTIONS.find((x) => x.value === dateFilter.preset);
    return o ? o.label : "All time";
  }, [dateFilter.preset]);

  const currencyRateByCode = useMemo(
    () => new Map(availableCurrencies.map((currency) => [
      String(currency.code || "").toUpperCase(),
      Number(currency.exchangeRate),
    ])),
    [availableCurrencies],
  );
  const inferredLedgerCurrency = useMemo(() => {
    const currencies = [...new Set(payments.map((payment) => payment.currency).filter(Boolean).map((currency) => String(currency).toUpperCase()))];
    return currencies.length === 1 ? currencies[0] : String(displayCurrency || "USD").toUpperCase();
  }, [payments, displayCurrency]);
  const selectedDisplayCurrency = columnFilters.currency === "ALL"
    ? inferredLedgerCurrency
    : columnFilters.currency;
  const convertPaymentAmount = useCallback((value, sourceCurrency, targetCurrency = selectedDisplayCurrency) => {
    const amount = Number(value || 0);
    const source = String(sourceCurrency || inferredLedgerCurrency).toUpperCase();
    const target = String(targetCurrency || source).toUpperCase();
    if (source === target) return amount;
    const sourceRate = currencyRateByCode.get(source);
    const targetRate = currencyRateByCode.get(target);
    if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) return amount;
    return (amount / sourceRate) * targetRate;
  }, [currencyRateByCode, inferredLedgerCurrency, selectedDisplayCurrency]);

  const paymentUrl = useMemo(() => {
    if (!isCustomer) return "/api/payments";
    const params = new URLSearchParams({ page: String(page), limit: String(pageSize), dateBasis: "payment" });
    if (tab !== "all") params.set("gateway", tab);
    if (rangeStart) params.set("from", rangeStart.toISOString());
    if (rangeEnd) params.set("to", rangeEnd.toISOString());
    return `/api/payments?${params}`;
  }, [isCustomer, page, pageSize, tab, rangeStart, rangeEnd]);

  const genericStatsUrl = useMemo(() => {
    if (!isGenericCrm || isCustomer) return null;
    const params = new URLSearchParams({ dateBasis: "payment" });
    if (tab !== "all") params.set("gateway", tab);
    if (rangeStart) params.set("from", rangeStart.toISOString());
    if (rangeEnd) params.set("to", rangeEnd.toISOString());
    return `/api/payments/stats?${params}`;
  }, [isGenericCrm, isCustomer, tab, rangeStart, rangeEnd]);

  const loadAll = useCallback(async ({ silent = false } = {}) => {
    const request = ++loadSequence.current;
    if (!silent) setLoading(true);
    setError("");
    try {
      const [list, cfg, aggregate] = await Promise.all([
        isCustomer ? fetchApi(paymentUrl) : fetchApi(paymentUrl).catch(() => []),
        isCustomer ? Promise.resolve(null) : fetchApi("/api/payments/config").catch(() => null),
        genericStatsUrl ? fetchApi(genericStatsUrl).catch(() => null) : Promise.resolve(null),
      ]);
      if (request !== loadSequence.current) return;
      setPayments(isCustomer ? (list?.data || []) : (Array.isArray(list) ? list : []));
      if (isCustomer) setCustomerLedger({ total: list?.total || 0, stats: list?.stats || { collected: 0, pending: 0, failed: 0 } });
      if (genericStatsUrl) setGenericStats(aggregate);
      if (isCustomer && Number(list?.page) > (list?.totalPages || 1)) setPage(list?.totalPages || 1);
      setConfig(cfg);
    } catch (err) {
      if (request === loadSequence.current) setError(err.message || "Failed to load payments");
    } finally {
      if (request === loadSequence.current) setLoading(false);
    }
  }, [isCustomer, paymentUrl, genericStatsUrl]);

  useEffect(() => {
    loadAll();
    const refreshTimer = window.setInterval(() => loadAll({ silent: true }), 15000);
    return () => { window.clearInterval(refreshTimer); loadSequence.current += 1; };
  }, [loadAll]);

  useEffect(() => {
    if (!isGenericCrm || isCustomer) return undefined;
    let active = true;
    fetchApi("/api/currencies?fields=summary")
      .then((rows) => { if (active) setAvailableCurrencies(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (active) setAvailableCurrencies([]); });
    return () => { active = false; };
  }, [isGenericCrm, isCustomer]);

  // A travel BOOKING collection (advance / milestone / full-invoice link). These
  // refund through the booking's CANCELLATION flow so the retention policy
  // applies; the Payments page only lets an ADMIN override (with a reason).
  const isBookingPayment = useCallback((p) => {
    const m = p && p.metadata;
    return Boolean(
      m &&
      (m.type === "travel-quote-advance" ||
        m.type === "travel-payment-schedule" ||
        m.type === "travel-itinerary" ||
        m.kind === "travel-milestone" ||
        m.kind === "travel-invoice"),
    );
  }, []);

  // Resolve the Refund button state for a row: whether it's clickable, whether
  // it's an admin OVERRIDE (booking payment), and the tooltip explaining why.
  const refundState = useCallback(
    (p) => {
      if (!p) return { enabled: false };
      if (p.status === "REFUNDED") return { refunded: true };
      const captured =
        p.status === "SUCCESS" &&
        String(p.gateway || "").toLowerCase() === "razorpay" &&
        /^pay_/.test(String(p.gatewayId || ""));
      const booking = isBookingPayment(p);
      const canManage = isAdmin || user?.role === "MANAGER";
      if (!captured) {
        return {
          enabled: false,
          title:
            "Only captured Razorpay payments can be refunded (not pending / manual / failed)",
        };
      }
      if (booking && !isAdmin) {
        return {
          enabled: false,
          title:
            "Refund this booking through its cancellation flow (Itineraries → cancellation)",
        };
      }
      if (!booking && !canManage) {
        return {
          enabled: false,
          title: "Only admins / managers can issue refunds",
        };
      }
      return {
        enabled: true,
        override: booking,
        title: booking
          ? "Admin override — refund now (bypasses the cancellation policy)"
          : `Refund ${formatCurrency(p.amount, p.currency || displayCurrency)} via Razorpay`,
      };
    },
    [isBookingPayment, isAdmin, user, displayCurrency],
  );

  async function handleRefund(p) {
    const st = refundState(p);
    if (!st.enabled || refundingId) return;
    let reason = null;
    if (st.override) {
      reason = await notify.prompt({
        title: "Refund override",
        message:
          "This refund bypasses the cancellation policy. Reason (required):",
        placeholder: "e.g. goodwill / billing error",
        confirmText: "Refund",
      });
      if (reason == null || String(reason).trim() === "") return; // cancelled / empty
    } else {
      const ok = await notify.confirm({
        title: "Refund payment?",
        message: `Refund ${formatCurrency(p.amount, p.currency || displayCurrency)} back to the customer via Razorpay? This cannot be undone.`,
        confirmText: "Refund",
        cancelText: "Cancel",
        destructive: true,
      });
      if (!ok) return;
    }
    setRefundingId(p.id);
    setError("");
    setNotice("");
    try {
      const res = await fetchApi(`/api/payments/${p.id}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reason ? { reason: String(reason).trim() } : {}),
      });
      setNotice(
        `Refund of ${formatCurrency(p.amount, p.currency || displayCurrency)} issued${res?.refund?.id ? ` (${res.refund.id})` : ""}.`,
      );
      await loadAll();
    } catch (err) {
      setError(err?.message || "Refund failed. Please try again.");
    } finally {
      setRefundingId(null);
    }
  }

  // Row date: paidAt when set (SUCCESS / REFUNDED), createdAt otherwise.
  // useCallback so it's stable across renders for the useMemo dep arrays below.
  const inDateRange = useCallback(
    (p) => {
      if (!rangeStart || !rangeEnd) return true;
      const ts = new Date(p.paidAt || p.createdAt).getTime();
      return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
    },
    [rangeStart, rangeEnd],
  );

  useEffect(() => {
    if (!activeColumnFilter) return undefined;
    const closeColumnFilter = (event) => {
      if (event.key === "Escape") {
        setActiveColumnFilter(null);
        return;
      }
      if (event.type === "pointerdown" && !event.target.closest?.("[data-payment-column-filter]")) {
        setActiveColumnFilter(null);
      }
    };
    document.addEventListener("pointerdown", closeColumnFilter);
    document.addEventListener("keydown", closeColumnFilter);
    return () => {
      document.removeEventListener("pointerdown", closeColumnFilter);
      document.removeEventListener("keydown", closeColumnFilter);
    };
  }, [activeColumnFilter]);

  const [paidDateStart, paidDateEnd] = useMemo(() => resolveDateRange({
    preset: columnFilters.paidDatePreset,
    start: columnFilters.paidDateStart,
    end: columnFilters.paidDateEnd,
  }), [columnFilters.paidDatePreset, columnFilters.paidDateStart, columnFilters.paidDateEnd]);

  const filtered = useMemo(() => {
    if (isCustomer) return payments;
    return payments.filter((p) => {
      if (tab !== "all" && String(p.gateway || "").toLowerCase() !== tab)
        return false;
      if (!inDateRange(p)) return false;
      if (!isGenericCrm) return true;
      const normalizedStatus = ["PAID", "CAPTURED"].includes(String(p.status || "").toUpperCase())
        ? "SUCCESS"
        : String(p.status || "").toUpperCase();
      // Preserve the removed toolbar's payment-date behavior: successful rows
      // use paidAt, while pending/failed rows fall back to createdAt.
      const paidAt = (p.paidAt || p.createdAt)
        ? new Date(p.paidAt || p.createdAt).getTime()
        : Number.NaN;
      return (
        (columnFilters.gateway === "ALL" || String(p.gateway || "").toLowerCase() === columnFilters.gateway)
        && (columnFilters.status === "ALL" || normalizedStatus === columnFilters.status)
        && (!paidDateStart || (!Number.isNaN(paidAt) && paidAt >= paidDateStart.getTime()))
        && (!paidDateEnd || (!Number.isNaN(paidAt) && paidAt <= paidDateEnd.getTime()))
      );
    });
  }, [payments, tab, inDateRange, isCustomer, isGenericCrm, columnFilters, paidDateStart, paidDateEnd]);

  const hasColumnFilters = isGenericCrm && !isCustomer && (
    columnFilters.currency !== "ALL"
    || columnFilters.gateway !== "ALL"
    || columnFilters.status !== "ALL"
    || columnFilters.paidDatePreset !== "all"
  );

  // Reset to the first page whenever the filter changes so the user does not
  // land on an empty page after narrowing the result set.
  useEffect(() => {
    setPage(1);
  }, [tab, dateFilter, columnFilters]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((isCustomer ? customerLedger.total : filtered.length) / pageSize)),
    [filtered.length, pageSize, isCustomer, customerLedger.total],
  );
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(() => {
    if (isCustomer) return payments;
    const start = (safePage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, safePage, pageSize, isCustomer, payments]);

  const stats = useMemo(() => {
    if (isCustomer) return customerLedger.stats;
    if (isGenericCrm && genericStats) {
      const statusCount = (names) => names.reduce(
        (total, name) => total + Number(genericStats.byStatus?.[name] || 0),
        0,
      );
      return {
        collected: Number(genericStats.successfulAmount || 0),
        pending: statusCount(["PENDING", "pending"]),
        failed: statusCount(["FAILED", "failed"]),
      };
    }
    let collected = 0,
      pending = 0,
      failed = 0;
    for (const p of payments) {
      if (!inDateRange(p)) continue;
      if (["SUCCESS", "PAID", "CAPTURED"].includes(String(p.status || "").toUpperCase())) {
        collected += Number(p.amount || 0);
      }
      else if (p.status === "PENDING") pending += 1;
      else if (p.status === "FAILED") failed += 1;
    }
    return { collected, pending, failed };
  }, [payments, inDateRange, isCustomer, isGenericCrm, genericStats, customerLedger.stats]);

  const displayedCollected = useMemo(() => {
    if (!isGenericCrm || isCustomer) return stats.collected;
    const totals = Object.entries(genericStats?.successfulAmountByCurrency || {});
    if (totals.length > 0) {
      return totals.reduce(
        (sum, [currency, amount]) => sum + convertPaymentAmount(amount, currency, selectedDisplayCurrency),
        0,
      );
    }
    return convertPaymentAmount(stats.collected, inferredLedgerCurrency, selectedDisplayCurrency);
  }, [isGenericCrm, isCustomer, stats.collected, genericStats, convertPaymentAmount, inferredLedgerCurrency, selectedDisplayCurrency]);

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div
      className={`finance-page${isGenericCrm && !isCustomer ? " finance-page--generic-ledger" : ""}`}
      style={{
        padding: "2rem",
        color: "var(--text-primary)",
        minHeight: "100%",
      }}
    >
      {/* Header */}
      <div
        className="finance-page__header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
        }}
      >
        <div className="finance-page__title-row" style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <CreditCard className="finance-page__title-icon" size={28} style={{ color: "#635bff" }} />
          <h1 className="finance-page__title" style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700 }}>
            {isCustomer ? "Payments" : "Payments Received"}
          </h1>
        </div>
        <button
          onClick={loadAll}
          disabled={loading}
          style={{
            ...GLASS,
            padding: "0.5rem 1rem",
            color: "var(--text-primary)",
            cursor: loading ? "not-allowed" : "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "0.85rem",
          }}
        >
          <RefreshCw
            size={14}
            style={{ animation: loading ? "spin 1s linear infinite" : "none" }}
          />
          Refresh
        </button>
      </div>

      <p
        className="finance-page__subtitle"
        style={{
          margin: "0 0 1.5rem 0",
          color: "var(--text-secondary)",
          fontSize: "0.85rem",
        }}
      >
        {isCustomer
          ? "Your invoice payments and payment status."
          : "Customer payment UI is implemented at the invoice level (separate page) — this dashboard is for tenants to track received payments."}
      </p>

      {error && (
        <div
          style={{
            ...GLASS,
            padding: "0.8rem 1rem",
            marginBottom: "1rem",
            borderColor: "rgba(239,68,68,0.3)",
            color: "#ef4444",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {notice && (
        <div
          style={{
            ...GLASS,
            padding: "0.8rem 1rem",
            marginBottom: "1rem",
            borderColor: "rgba(16,185,129,0.3)",
            color: "#10b981",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <CheckCircle size={16} /> {notice}
        </div>
      )}

      {/* #848: per-tenant Razorpay keys (BYOK) for CUSTOMER payments. Admin-only.
          Distinct from the platform env-var gateway below (which powers the
          payments table + subscription billing). */}
      {isAdmin && (
        <RazorpayGatewayCard
          onViewGatewayConfiguration={isGenericCrm ? () => setShowGatewayConfiguration(true) : undefined}
        />
      )}

      {/* #371: surface a clear configuration banner when neither Stripe
          nor Razorpay is wired up. Previously the page rendered a
          "Configure provider →" button that linked to /settings, but
          /settings has no payment-config UI (#560 — pen-test 2026-05-07).
          Key storage is env-var-driven, not DB-backed, so the honest UX
          is to name the env vars + direct admins to ops. The full
          DB-backed provider-config UI is tracked separately. */}
      {!loading &&
        config &&
        !config?.stripe?.configured &&
        !config?.razorpay?.configured && (
          <div
            style={{
              ...GLASS,
              padding: "1rem 1.25rem",
              marginBottom: "1.5rem",
              borderColor: "rgba(245,158,11,0.35)",
              background: "rgba(245,158,11,0.08)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "0.75rem",
                marginBottom: "0.75rem",
              }}
            >
              <AlertTriangle
                size={18}
                style={{
                  color: "#f59e0b",
                  flexShrink: 0,
                  marginTop: "0.15rem",
                }}
              />
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "0.95rem",
                    marginBottom: "0.2rem",
                  }}
                >
                  Stripe / Razorpay not configured
                </div>
                <div
                  style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}
                >
                  Payment-gateway keys are configured server-side as environment
                  variables (not via this UI). Ask your administrator to set the
                  variables below and restart the backend. Activating either
                  gateway will enable the payment table + the per-invoice
                  Pay-Now flow.
                </div>
              </div>
            </div>
            <div
              style={{
                marginLeft: "2.5rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              <details
                style={{
                  background: "rgba(0,0,0,0.18)",
                  borderRadius: 6,
                  padding: "0.5rem 0.75rem",
                }}
              >
                <summary
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Stripe — required env vars
                </summary>
                <pre
                  style={{
                    fontSize: "0.75rem",
                    margin: "0.5rem 0 0 0",
                    color: "var(--text-secondary)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {`STRIPE_SECRET_KEY=sk_live_...        # from dashboard.stripe.com → Developers → API keys
STRIPE_WEBHOOK_SECRET=whsec_...     # from dashboard.stripe.com → Developers → Webhooks
                                      # endpoint URL: <BASE_URL>/api/payments/webhook/stripe`}
                </pre>
              </details>
              <details
                style={{
                  background: "rgba(0,0,0,0.18)",
                  borderRadius: 6,
                  padding: "0.5rem 0.75rem",
                }}
              >
                <summary
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Razorpay — required env vars
                </summary>
                <pre
                  style={{
                    fontSize: "0.75rem",
                    margin: "0.5rem 0 0 0",
                    color: "var(--text-secondary)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {`RAZORPAY_KEY_ID=rzp_live_...        # from dashboard.razorpay.com → Settings → API Keys
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...         # from dashboard.razorpay.com → Settings → Webhooks
                                      # endpoint URL: <BASE_URL>/api/payments/webhook/razorpay`}
                </pre>
              </details>
            </div>
          </div>
        )}

      {/* Stats row — labels are window-aware so the KPI value the user sees
          always matches what the date filter is showing. */}
      {isGenericCrm && !isCustomer ? (
        <div className="payment-summary-chips" data-testid="payment-summary-chips">
          <PaymentStatChip icon={<span aria-hidden="true">{currencySymbol(selectedDisplayCurrency)}</span>} label={`Total Collected (${filterLabel})`} value={formatCurrency(displayedCollected, selectedDisplayCurrency)} color="#10b981" active={columnFilters.status === "SUCCESS"} onClick={() => toggleStatusFilter("SUCCESS")} />
          <PaymentStatChip icon={<Clock size={14} />} label={`Pending (${filterLabel})`} value={stats.pending} color="#f59e0b" active={columnFilters.status === "PENDING"} onClick={() => toggleStatusFilter("PENDING")} />
          <PaymentStatChip icon={<XCircle size={14} />} label={`Failed (${filterLabel})`} value={stats.failed} color="#ef4444" active={columnFilters.status === "FAILED"} onClick={() => toggleStatusFilter("FAILED")} />
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "1rem",
            marginBottom: "1.5rem",
          }}
        >
          <StatCard
            icon={<IndianRupee size={20} />}
            label={`${isCustomer ? "Total Paid" : "Total Collected"} (${filterLabel})`}
            value={formatCurrency(stats.collected, displayCurrency)}
            color="#10b981"
          />
          <StatCard icon={<Clock size={20} />} label={`Pending (${filterLabel})`} value={stats.pending} color="#f59e0b" />
          <StatCard icon={<XCircle size={20} />} label={`Failed (${filterLabel})`} value={stats.failed} color="#ef4444" />
        </div>
      )}

      {/* Gateway chips + date filter — share a row, gateway chips on the left,
          date picker right-pinned via marginLeft: auto so they wrap together
          when the viewport narrows. Theme-aware: bg/border use --surface
          + --border so tabs stay readable on light AND dark. */}
      {(!isGenericCrm || isCustomer) && <div
        className="finance-page__filters"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        {["all", "stripe", "razorpay"].map((t) => (
          <button
            key={t}
            onClick={() => selectGateway(t)}
            aria-pressed={tab === t}
            style={{
              padding: "0.5rem 1.1rem",
              borderRadius: "8px",
              border:
                tab === t
                  ? "1px solid rgba(99,91,255,0.5)"
                  : "1px solid var(--border-color)",
              background:
                tab === t ? "rgba(99,91,255,0.18)" : "var(--surface-color)",
              color: "var(--text-primary)",
              cursor: "pointer",
              fontSize: "0.85rem",
              textTransform: "capitalize",
              fontWeight: tab === t ? 600 : 400,
              transition: "background 0.15s, border-color 0.15s",
            }}
          >
            {t === "all" ? "All" : t}
          </button>
        ))}
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          <DateRangeFilter value={dateFilter} onChange={setDateFilter} />
        </div>
      </div>}

      {/* Payments table — wrap in a clearly-delineated card. `box-shadow`
          + padding give it visual weight against the page background, and
          theme variables keep contrast under both modes. */}
      <div
        className="finance-page__table-card"
        style={{
          ...GLASS,
          overflow: "visible",
          boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        }}
      >
        <TopScrollSync hideTopBar disabled>
          <table
            className="payment-ledger-table"
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.85rem",
              tableLayout: "fixed",
            }}
          >
            <thead className="payment-ledger-head">
              <tr
                style={{
                  background: "var(--surface-hover)",
                  borderBottom: "1px solid var(--border-color)",
                }}
              >
                <Th>{isCustomer ? "Payer" : "Customer"}</Th>
                <Th>For</Th>
                <Th>{isGenericCrm && !isCustomer ? (
                  <PaymentHeaderFilter label="Amount" filterKey="currency" activeFilter={activeColumnFilter} hasValue={columnFilters.currency !== "ALL"} onToggle={setActiveColumnFilter}>
                    <select autoFocus value={columnFilters.currency} onChange={(event) => setColumnFilters((current) => ({ ...current, currency: event.target.value }))} aria-label="Filter payments by currency">
                      <option value="ALL">Original currencies</option>
                      {[...new Set([
                        displayCurrency,
                        ...availableCurrencies.map((currency) => currency.code),
                        ...payments.map((payment) => payment.currency),
                      ].filter(Boolean).map((currency) => String(currency).toUpperCase()))].map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                    </select>
                  </PaymentHeaderFilter>
                ) : "Amount"}</Th>
                <Th>{isGenericCrm && !isCustomer ? (
                  <PaymentHeaderFilter label="Gateway" filterKey="gateway" activeFilter={activeColumnFilter} hasValue={columnFilters.gateway !== "ALL"} onToggle={setActiveColumnFilter}>
                    <select autoFocus value={columnFilters.gateway} onChange={(event) => selectGateway(event.target.value === "ALL" ? "all" : event.target.value)} aria-label="Filter payments by gateway">
                      <option value="ALL">All gateways</option>
                      {[...new Set(["stripe", "razorpay", ...payments.map((payment) => String(payment.gateway || "").toLowerCase()).filter(Boolean)])].map((gateway) => <option key={gateway} value={gateway}>{GATEWAY_CONFIG[gateway]?.label || gateway}</option>)}
                    </select>
                  </PaymentHeaderFilter>
                ) : "Gateway"}</Th>
                <Th>{isGenericCrm && !isCustomer ? (
                  <PaymentHeaderFilter label="Status" filterKey="status" activeFilter={activeColumnFilter} hasValue={columnFilters.status !== "ALL"} onToggle={setActiveColumnFilter}>
                    <select autoFocus value={columnFilters.status} onChange={(event) => setColumnFilters((current) => ({ ...current, status: event.target.value }))} aria-label="Filter payments by status">
                      <option value="ALL">All statuses</option>
                      {Object.entries(STATUS_CONFIG).map(([value, configValue]) => <option key={value} value={value}>{configValue.label}</option>)}
                    </select>
                  </PaymentHeaderFilter>
                ) : "Status"}</Th>
                <Th>{isGenericCrm && !isCustomer ? (
                  <PaymentHeaderFilter label="Paid Date" filterKey="paidDate" activeFilter={activeColumnFilter} hasValue={columnFilters.paidDatePreset !== "all"} onToggle={setActiveColumnFilter}>
                    <select autoFocus value={columnFilters.paidDatePreset} onChange={(event) => {
                      const preset = event.target.value;
                      setColumnFilters((current) => ({ ...current, paidDatePreset: preset }));
                      setDateFilter((current) => ({ ...current, preset }));
                    }} aria-label="Filter payments by paid date">
                      {DATE_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    {columnFilters.paidDatePreset === "custom" && <div className="payment-header-custom-range">
                      <label>From<input type="date" value={columnFilters.paidDateStart} onClick={openNativeDatePicker} onChange={(event) => {
                        const start = event.target.value;
                        setColumnFilters((current) => ({ ...current, paidDateStart: start }));
                        setDateFilter((current) => ({ ...current, start }));
                      }} aria-label="Filter paid date from" /></label>
                      <label>To<input type="date" value={columnFilters.paidDateEnd} min={columnFilters.paidDateStart || undefined} onClick={openNativeDatePicker} onChange={(event) => {
                        const end = event.target.value;
                        setColumnFilters((current) => ({ ...current, paidDateEnd: end }));
                        setDateFilter((current) => ({ ...current, end }));
                      }} aria-label="Filter paid date to" /></label>
                    </div>}
                  </PaymentHeaderFilter>
                ) : "Paid Date"}</Th>
                <Th style={{ width: "1%", whiteSpace: "nowrap" }}>
                  <div className="payment-actions-header">
                    <span>Actions</span>
                    {hasColumnFilters && (
                      <button
                        type="button"
                        className="payment-clear-filters"
                        onClick={() => {
                          setColumnFilters(EMPTY_PAYMENT_COLUMN_FILTERS);
                          setTab("all");
                          setDateFilter({ preset: "all", start: "", end: "" });
                          setActiveColumnFilter(null);
                        }}
                        aria-label="Clear payment filters"
                      >
                        <X size={13} aria-hidden="true" /> Clear filters
                      </button>
                    )}
                  </div>
                </Th>
              </tr>
            </thead>
            <tbody className="payment-ledger-body">
              {/* #372: empty-state with column headers visible above (the
                <thead> sits outside this conditional) plus an explicit
                "Process your first payment" CTA. Previously the empty
                ledger rendered as a single grey "No payments found."
                line under what looked like a blank box. */}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    style={{
                      padding: "3rem 2rem",
                      textAlign: "center",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {loading ? (
                      "Loading payments..."
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: "0.75rem",
                        }}
                      >
                        <CreditCard
                          size={36}
                          style={{ opacity: 0.35, color: "#635bff" }}
                        />
                        <div
                          style={{
                            fontSize: "1rem",
                            fontWeight: 600,
                            color: "var(--text-primary)",
                          }}
                        >
                          No payments yet
                        </div>
                        <div style={{ fontSize: "0.82rem", maxWidth: 380 }}>
                          {isCustomer
                            ? "Your invoice payments will appear here with their status and amount."
                            : "Once a customer pays an invoice via Stripe or Razorpay, the transaction will appear here with status, amount, and gateway details."}
                        </div>
                        {!isCustomer && <Link
                          to="/invoices"
                          style={{
                            marginTop: "0.4rem",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.4rem",
                            padding: "0.5rem 1rem",
                            background: "rgba(99,91,255,0.18)",
                            border: "1px solid rgba(99,91,255,0.4)",
                            borderRadius: "8px",
                            color: "#a4a0ff",
                            fontSize: "0.85rem",
                            fontWeight: 600,
                            textDecoration: "none",
                          }}
                        >
                          <Plus size={14} /> Process your first payment
                        </Link>}
                      </div>
                    )}
                  </td>
                </tr>
              )}
              {paginated.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setSelected(p)}
                  style={{
                    borderTop: "1px solid var(--border-color)",
                    cursor: "pointer",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "var(--surface-hover)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  <Td>
                    {isCustomer ? (
                      <span style={{ fontWeight: 600 }}>You</span>
                    ) : p.contact ? (
                      <span style={{ fontWeight: 600 }}>
                        {p.contact.name || p.contact.email || `#${p.contactId}`}
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-secondary)" }}>—</span>
                    )}
                  </Td>
                  <Td
                    style={{
                      maxWidth: 200,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {(() => {
                      const label = paymentSubjectLabel(p, { preferPlotSite: isGenericCrm });
                      if (!label)
                        return (
                          <span style={{ color: "var(--text-secondary)" }}>
                            —
                          </span>
                        );
                      if (p.itineraryId) {
                        return (
                          <Link
                            to={`/travel/itineraries/${p.itineraryId}`}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              color: "var(--accent-color)",
                              textDecoration: "none",
                              fontWeight: 500,
                            }}
                            title="View itinerary"
                          >
                            {label}
                          </Link>
                        );
                      }
                      return <span title={String(label)}>{label}</span>;
                    })()}
                  </Td>
                  <Td>
                    <strong>{isGenericCrm && !isCustomer && columnFilters.currency !== "ALL"
                      ? formatCurrency(convertPaymentAmount(p.amount, p.currency || inferredLedgerCurrency), selectedDisplayCurrency)
                      : formatCurrency(p.amount, p.currency || selectedDisplayCurrency)}</strong>
                  </Td>
                  <Td>
                    <GatewayBadge gateway={p.gateway} />
                  </Td>
                  <Td>
                    <StatusBadge status={p.status} />
                  </Td>
                  <Td>{formatPaidDate(p.paidAt)}</Td>
                  <Td
                    onClick={(e) => e.stopPropagation()}
                    style={{ width: "1%", whiteSpace: "nowrap" }}
                  >
                    <button
                      onClick={() => setSelected(p)}
                      style={{
                        padding: "0.3rem 0.7rem",
                        background: "rgba(99,91,255,0.15)",
                        border: "1px solid rgba(99,91,255,0.3)",
                        borderRadius: "6px",
                        color: "#a4a0ff",
                        cursor: "pointer",
                        fontSize: "0.75rem",
                        marginRight: "0.4rem",
                      }}
                    >
                      View
                    </button>
                    {(() => {
                      const st = refundState(p);
                      if (st.refunded) {
                        return (
                          <button
                            disabled
                            title="Already refunded"
                            style={{
                              padding: "0.3rem 0.7rem",
                              background: "rgba(156,163,175,0.1)",
                              border: "1px solid rgba(156,163,175,0.2)",
                              borderRadius: "6px",
                              color: "#9ca3af",
                              cursor: "not-allowed",
                              fontSize: "0.75rem",
                            }}
                          >
                            Refunded
                          </button>
                        );
                      }
                      const busy = refundingId === p.id;
                      return (
                        <button
                          onClick={() => handleRefund(p)}
                          disabled={!st.enabled || busy}
                          title={st.title}
                          style={{
                            padding: "0.3rem 0.7rem",
                            background: st.enabled
                              ? "rgba(239,68,68,0.15)"
                              : "rgba(156,163,175,0.1)",
                            border: `1px solid ${st.enabled ? "rgba(239,68,68,0.3)" : "rgba(156,163,175,0.2)"}`,
                            borderRadius: "6px",
                            color: st.enabled ? "#f87171" : "#9ca3af",
                            cursor:
                              st.enabled && !busy ? "pointer" : "not-allowed",
                            fontSize: "0.75rem",
                            opacity: busy ? 0.6 : 1,
                          }}
                        >
                          {busy
                            ? "Refunding…"
                            : st.override
                              ? "Refund*"
                              : "Refund"}
                        </button>
                      );
                    })()}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TopScrollSync>
        {filtered.length > 0 && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "0.85rem 1rem",
              borderTop: "1px solid var(--border-color)",
              fontSize: "0.8rem",
              color: "var(--text-secondary)",
              flexWrap: "wrap",
              gap: "0.75rem",
            }}
          >
            <div data-testid="payment-pagination">
              Page{" "}
              <strong style={{ color: "var(--text-primary)" }}>
                {safePage}
              </strong>{" "}
              of{" "}
              <strong style={{ color: "var(--text-primary)" }}>
                {totalPages}
              </strong>{" "}
              · {(isCustomer ? customerLedger.total : filtered.length).toLocaleString()} payments
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                }}
              >
                Per page:
                <select
                  aria-label="Payments per page"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                  style={{
                    padding: "0.35rem 0.5rem",
                    borderRadius: "6px",
                    border: "1px solid var(--border-color)",
                    background: "var(--surface-color)",
                    color: "var(--text-primary)",
                    fontSize: "0.8rem",
                    cursor: "pointer",
                  }}
                >
                  {[10, 25, 50].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                aria-label="Previous page"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(p - 1, 1))}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  padding: "0.4rem 0.8rem",
                  borderRadius: "6px",
                  border: "1px solid var(--border-color)",
                  background: "var(--surface-color)",
                  color: "var(--text-primary)",
                  cursor: safePage <= 1 ? "not-allowed" : "pointer",
                  opacity: safePage <= 1 ? 0.4 : 1,
                  fontSize: "0.8rem",
                }}
              >
                <ChevronLeft size={14} /> Previous
              </button>
              <button
                type="button"
                aria-label="Next page"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  padding: "0.4rem 0.8rem",
                  borderRadius: "6px",
                  border: "1px solid var(--border-color)",
                  background: "var(--surface-color)",
                  color: "var(--text-primary)",
                  cursor: safePage >= totalPages ? "not-allowed" : "pointer",
                  opacity: safePage >= totalPages ? 0.4 : 1,
                  fontSize: "0.8rem",
                }}
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Admin configuration section */}
      {isAdmin && !isGenericCrm && (
        <div style={{ ...GLASS, padding: "1.25rem", marginTop: "2rem" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginBottom: "1rem",
            }}
          >
            <SettingsIcon size={18} />
            <h3 style={{ margin: 0, fontSize: "1rem" }}>
              Gateway Configuration
            </h3>
          </div>

          <div
            className="payment-gateway-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
              gap: "1rem",
            }}
          >
            <ConfigCard
              name="Stripe"
              configured={!!config?.stripe?.configured}
              extras={[
                {
                  label: "API key (STRIPE_SECRET_KEY)",
                  ok: !!config?.stripe?.configured,
                },
                {
                  label: "Webhook secret (STRIPE_WEBHOOK_SECRET)",
                  ok: !!config?.stripe?.webhookConfigured,
                },
              ]}
              hint="Get keys from dashboard.stripe.com → Developers → API keys. Configure webhook endpoint at /api/payments/webhook/stripe."
              brandColor="#635bff"
            />
            <ConfigCard
              name="Razorpay"
              configured={!!config?.razorpay?.configured}
              extras={[
                {
                  label: "Key ID (RAZORPAY_KEY_ID)",
                  ok: !!config?.razorpay?.configured,
                  value: config?.razorpay?.keyId,
                },
                {
                  label: "Key secret (RAZORPAY_KEY_SECRET)",
                  ok: !!config?.razorpay?.configured,
                },
              ]}
              hint="Get keys from dashboard.razorpay.com → Settings → API Keys. Webhook endpoint: /api/payments/webhook/razorpay."
              brandColor="#3395ff"
            />
          </div>

          <p
            style={{
              marginTop: "1rem",
              fontSize: "0.78rem",
              color: "var(--text-secondary)",
            }}
          >
            Add the env vars to your root <code>.env</code> file and restart the
            backend (PM2). Keys are loaded once at startup and never exposed to
            the frontend.
          </p>
        </div>
      )}

      {showGatewayConfiguration && (
        <GatewayConfigurationModal
          config={config}
          onClose={() => setShowGatewayConfiguration(false)}
        />
      )}

      {/* Detail modal */}
      {selected && (
        <DetailModal
          payment={selected}
          displayCurrency={displayCurrency}
          preferPlotSite={isGenericCrm}
          onClose={() => setSelected(null)}
        />
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
        .payment-header-filter { display: flex; align-items: center; gap: 0.35rem; min-width: 0; }
        .payment-header-filter-button { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 25px; height: 25px; padding: 0; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--text-secondary); cursor: pointer; }
        .payment-header-filter-button:hover, .payment-header-filter-button[aria-expanded="true"], .payment-header-filter-button.is-active { border-color: color-mix(in srgb, var(--primary-color, var(--accent-color)) 35%, transparent); background: color-mix(in srgb, var(--primary-color, var(--accent-color)) 10%, transparent); color: var(--primary-color, var(--accent-color)); }
        .payment-header-filter-popover { position: fixed; display: flex; flex-direction: column; gap: 0.55rem; z-index: 10020; width: 210px; padding: 0.65rem; border: 1px solid var(--border-color); border-radius: 8px; background: var(--popover-bg, #fff); opacity: 1; box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18); text-transform: none; letter-spacing: normal; }
        .payment-header-filter-popover input, .payment-header-filter-popover select { width: 100%; min-width: 0; height: 36px; box-sizing: border-box; padding: 0 0.65rem; border: 1px solid var(--border-color); border-radius: 6px; outline: none; background: var(--surface-color); color: var(--text-primary); font: inherit; font-size: 0.78rem; font-weight: 400; }
        .payment-header-filter-popover input:focus, .payment-header-filter-popover select:focus { border-color: var(--primary-color, var(--accent-color)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary-color, var(--accent-color)) 14%, transparent); }
        .payment-header-custom-range { display: grid; grid-template-columns: 1fr; gap: 0.45rem; }
        .payment-header-custom-range label { display: grid; gap: 0.25rem; color: var(--text-secondary); font-size: 0.68rem; font-weight: 600; text-transform: none; letter-spacing: normal; }
        .payment-actions-header { display: flex; align-items: center; justify-content: flex-start; gap: 0.65rem; }
        .payment-clear-filters { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.3rem 0.45rem; border: 1px solid var(--border-color); border-radius: 6px; background: var(--surface-color); color: var(--text-secondary); cursor: pointer; font: inherit; font-size: 0.68rem; font-weight: 600; text-transform: none; letter-spacing: normal; }
        .payment-clear-filters:hover { border-color: var(--primary-color, var(--accent-color)); color: var(--primary-color, var(--accent-color)); }
        .payment-summary-chips { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
        .app-main > main.generic-page-content:has(.finance-page--generic-ledger) { overflow-y: hidden !important; }
        .finance-page--generic-ledger { display: flex; flex-direction: column; height: 100%; min-height: 0 !important; padding-bottom: 0 !important; overflow: hidden; box-sizing: border-box; }
        .finance-page--generic-ledger > .finance-page__header,
        .finance-page--generic-ledger > .finance-page__subtitle,
        .finance-page--generic-ledger > .razorpay-gateway-card,
        .finance-page--generic-ledger > .payment-summary-chips { flex: 0 0 auto; }
        .finance-page--generic-ledger > .finance-page__table-card { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow: hidden !important; }
        .finance-page--generic-ledger .top-scroll-sync--disabled { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
        .finance-page--generic-ledger .payment-ledger-head { position: sticky; top: 0; z-index: 2; }
        .finance-page--generic-ledger .payment-ledger-head > tr { background: var(--surface-hover); }
      `}</style>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────
function Th({ children, style }) {
  return (
    <th
      style={{
        padding: "0.75rem 1rem",
        textAlign: "left",
        fontSize: "0.75rem",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--text-secondary)",
        fontWeight: 600,
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, onClick, style }) {
  return (
    <td
      onClick={onClick}
      style={{ padding: "0.75rem 1rem", verticalAlign: "middle", ...style }}
    >
      {children}
    </td>
  );
}

function PaymentStatChip({ icon, label, value, color, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.4rem 1rem",
        borderRadius: "999px",
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        color,
        fontSize: "0.75rem",
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: "pointer",
        boxShadow: active ? `inset 0 0 0 1px ${color}` : "none",
      }}
    >
      {icon} {label}: <strong>{value}</strong>
    </button>
  );
}

function StatCard({ icon, label, value, color }) {
  const bgAlpha =
    color === "#10b981" ? "0.08" : color === "#f59e0b" ? "0.08" : "0.08";
  const getBgColor = () => {
    if (color === "#10b981") return "rgba(16,185,129,0.1)";
    if (color === "#f59e0b") return "rgba(245,158,11,0.1)";
    if (color === "#ef4444") return "rgba(239,68,68,0.1)";
    return "rgba(99,91,255,0.1)";
  };

  return (
    <div
      style={{
        padding: "1.5rem",
        borderRadius: "12px",
        background: getBgColor(),
        border: `1.5px solid ${color}40`,
        boxShadow: `0 0 20px ${color}15`,
        transition: "all 0.3s ease",
        cursor: "default",
        position: "relative",
        overflow: "hidden",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = getBgColor();
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = `0 8px 24px ${color}25`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = getBgColor();
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = `0 0 20px ${color}15`;
      }}
    >
      <div style={{ position: "relative", zIndex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginBottom: "1rem",
          }}
        >
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "10px",
              background: `${color}20`,
              border: `1px solid ${color}60`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color,
            }}
          >
            {icon}
          </div>
          <span
            style={{
              fontSize: "0.75rem",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--text-secondary)",
              fontWeight: 600,
            }}
          >
            {label}
          </span>
        </div>
        <div
          style={{ fontSize: "2.2rem", fontWeight: 700, color, lineHeight: 1 }}
        >
          {value}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          top: 0,
          right: -40,
          width: "120px",
          height: "120px",
          borderRadius: "50%",
          background: `${color}10`,
          filter: "blur(30px)",
        }}
      />
    </div>
  );
}

function ConfigCard({ name, configured, extras, hint, brandColor }) {
  const borderColor = configured ? `${brandColor}60` : "rgba(255,255,255,0.1)";
  const bgColor = configured ? `${brandColor}08` : "rgba(255,255,255,0.02)";

  return (
    <div
      className="payment-gateway-card"
      style={{
        padding: "1.25rem",
        borderRadius: "12px",
        background: bgColor,
        border: `1px solid ${borderColor}`,
        boxShadow: `0 0 16px ${configured ? `${brandColor}12` : "rgba(0,0,0,0.1)"}`,
        transition: "all 0.3s ease",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "4px",
          height: "100%",
          background: brandColor,
          borderRadius: "12px 0 0 12px",
          opacity: configured ? 1 : 0.3,
        }}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "1rem",
          paddingLeft: "0.5rem",
        }}
      >
        <div>
          <strong style={{ color: brandColor, fontSize: "0.95rem" }}>
            {name}
          </strong>
        </div>
        {configured ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              color: "#10b981",
              fontSize: "0.78rem",
              fontWeight: 600,
              background: "rgba(16,185,129,0.1)",
              padding: "0.3rem 0.7rem",
              borderRadius: "6px",
              border: "1px solid rgba(16,185,129,0.3)",
            }}
          >
            <CheckCircle size={14} /> Configured
          </span>
        ) : (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              color: "#f59e0b",
              fontSize: "0.78rem",
              fontWeight: 600,
              background: "rgba(245,158,11,0.1)",
              padding: "0.3rem 0.7rem",
              borderRadius: "6px",
              border: "1px solid rgba(245,158,11,0.3)",
            }}
          >
            <AlertTriangle size={14} /> Not configured
          </span>
        )}
      </div>

      <ul
        className="payment-gateway-keys"
        style={{
          listStyle: "none",
          padding: "0 0 0 0.5rem",
          margin: "0 0 1rem 0",
          fontSize: "0.78rem",
        }}
      >
        {extras.map((x, i) => (
          <li
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginBottom: "0.45rem",
              color: "var(--text-secondary)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                width: "16px",
                justifyContent: "center",
              }}
            >
              {x.ok ? (
                <CheckCircle size={13} color="#10b981" />
              ) : (
                <XCircle size={13} color="#ef4444" />
              )}
            </div>
            <span>{x.label}</span>
            {x.value && (
              <code
                className="payment-gateway-key-value"
                style={{
                  marginLeft: "auto",
                  color: "var(--text-primary)",
                  fontSize: "0.7rem",
                  background: "rgba(255,255,255,0.05)",
                  padding: "0.2rem 0.4rem",
                  borderRadius: "4px",
                }}
              >
                {x.value}
              </code>
            )}
          </li>
        ))}
      </ul>

      <p
        style={{
          margin: 0,
          fontSize: "0.73rem",
          color: "var(--text-secondary)",
          lineHeight: 1.6,
          paddingLeft: "0.5rem",
        }}
      >
        {hint}
      </p>
    </div>
  );
}

function GatewayConfigurationModal({ config, onClose }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        background: "var(--overlay-bg, rgba(0, 0, 0, 0.6))",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gateway-configuration-title"
        style={{
          ...GLASS,
          background: "var(--modal-bg, #ffffff)",
          color: "var(--text-primary)",
          width: "min(1100px, 100%)",
          maxHeight: "calc(100vh - 2rem)",
          overflowY: "auto",
          padding: "1.25rem",
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            marginBottom: "1rem",
          }}
        >
          <SettingsIcon size={18} />
          <h3 id="gateway-configuration-title" style={{ margin: 0, fontSize: "1rem", flex: 1 }}>
            Gateway Configuration
          </h3>
          <button
            type="button"
            aria-label="Close gateway configuration"
            onClick={onClose}
            autoFocus
            style={{
              width: 34,
              height: 34,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 8,
              border: "1px solid var(--border-color)",
              background: "var(--subtle-bg)",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div
          className="payment-gateway-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
            gap: "1rem",
          }}
        >
          <ConfigCard
            name="Stripe"
            configured={!!config?.stripe?.configured}
            extras={[
              { label: "API key (STRIPE_SECRET_KEY)", ok: !!config?.stripe?.configured },
              { label: "Webhook secret (STRIPE_WEBHOOK_SECRET)", ok: !!config?.stripe?.webhookConfigured },
            ]}
            hint="Get keys from dashboard.stripe.com → Developers → API keys. Configure webhook endpoint at /api/payments/webhook/stripe."
            brandColor="#635bff"
          />
          <ConfigCard
            name="Razorpay"
            configured={!!config?.razorpay?.configured}
            extras={[
              {
                label: "Key ID (RAZORPAY_KEY_ID)",
                ok: !!config?.razorpay?.configured,
                value: config?.razorpay?.keyId,
              },
              { label: "Key secret (RAZORPAY_KEY_SECRET)", ok: !!config?.razorpay?.configured },
            ]}
            hint="Get keys from dashboard.razorpay.com → Settings → API Keys. Webhook endpoint: /api/payments/webhook/razorpay."
            brandColor="#3395ff"
          />
        </div>

        <p style={{ margin: "1rem 0 0", fontSize: "0.78rem", color: "var(--text-secondary)" }}>
          Add the env vars to your root <code>.env</code> file and restart the backend (PM2). Keys are loaded once at startup and never exposed to the frontend.
        </p>
      </div>
    </div>,
    document.body
  );
}

function DetailModal({ payment, displayCurrency, preferPlotSite = false, onClose }) {
  const meta =
    payment.metadata && typeof payment.metadata === "object"
      ? payment.metadata
      : {};
  const contact = payment.contact || null;
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "1rem",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-color)",
          border: "1px solid var(--border-color)",
          borderRadius: "12px",
          boxShadow: "var(--glass-shadow, 0 8px 32px rgba(0,0,0,0.25))",
          padding: "1.5rem",
          maxWidth: "560px",
          width: "100%",
          maxHeight: "85vh",
          overflowY: "auto",
          color: "var(--text-primary)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "1rem",
          }}
        >
          <h3 style={{ margin: 0 }}>Payment #{payment.id}</h3>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            <X size={20} />
          </button>
        </div>

        <DetailRow label="Status">
          <StatusBadge status={payment.status} />
        </DetailRow>
        <DetailRow label="Amount">
          <strong>
            {formatCurrency(payment.amount, payment.currency || displayCurrency)} {payment.currency || displayCurrency}
          </strong>
        </DetailRow>
        <DetailRow label="Gateway">
          <GatewayBadge gateway={payment.gateway} />
        </DetailRow>
        <DetailRow label="Paid On">
          {formatPaidDate(payment.paidAt)}
        </DetailRow>
        <DetailRow label="Created">{formatDate(payment.createdAt)}</DetailRow>

        {contact && (
          <div
            style={{
              marginTop: "1rem",
              padding: "0.75rem",
              background: "var(--subtle-bg)",
              borderRadius: "8px",
              border: "1px solid var(--border-color)",
            }}
          >
            <div
              style={{
                fontSize: "0.73rem",
                color: "var(--text-secondary)",
                marginBottom: "0.4rem",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Customer
            </div>
            <div style={{ fontWeight: 600 }}>{contact.name || "—"}</div>
            {contact.email && (
              <div
                style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}
              >
                {contact.email}
              </div>
            )}
            {contact.phone && (
              <div
                style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}
              >
                {contact.phone}
              </div>
            )}
          </div>
        )}

        {paymentSubjectLabel(payment, { preferPlotSite }) && (
          <div
            style={{
              marginTop: "0.75rem",
              padding: "0.75rem",
              background: "var(--subtle-bg)",
              borderRadius: "8px",
              border: "1px solid var(--border-color)",
            }}
          >
            <div
              style={{
                fontSize: "0.73rem",
                color: "var(--text-secondary)",
                marginBottom: "0.3rem",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Payment for
            </div>
            <div style={{ fontWeight: 500 }}>
              {paymentSubjectLabel(payment, { preferPlotSite })}
            </div>
          </div>
        )}

        <div style={{ marginTop: "0.75rem" }}>
          <div
            style={{
              fontSize: "0.73rem",
              color: "var(--text-secondary)",
              marginBottom: "0.4rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Reference
          </div>
          <div
            style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}
          >
            {payment.gatewayId && (
              <div style={{ fontSize: "0.8rem" }}>
                Gateway ID:{" "}
                <code
                  style={{
                    fontSize: "0.75rem",
                    background: "rgba(0,0,0,0.06)",
                    padding: "0.15rem 0.4rem",
                    borderRadius: 4,
                  }}
                >
                  {payment.gatewayId}
                </code>
              </div>
            )}
            {payment.invoiceId && (
              <div style={{ fontSize: "0.8rem" }}>
                Invoice: <strong>#{payment.invoiceId}</strong>
              </div>
            )}
            {!payment.invoiceId && payment.travelInvoiceNum && (
              <div style={{ fontSize: "0.8rem" }}>
                Invoice: <strong>{payment.travelInvoiceNum}</strong>
              </div>
            )}
            {(payment.itineraryId || meta.itineraryId) && (
              <div style={{ fontSize: "0.8rem" }}>
                Itinerary:{" "}
                <Link
                  to={`/travel/itineraries/${payment.itineraryId || meta.itineraryId}`}
                  onClick={onClose}
                  style={{
                    color: "var(--accent-color)",
                    fontWeight: 600,
                    textDecoration: "none",
                  }}
                >
                  View itinerary →
                </Link>
              </div>
            )}
            {meta.quoteId && (
              <div style={{ fontSize: "0.8rem" }}>
                Quote: <strong>#{meta.quoteId}</strong>
              </div>
            )}
            {meta.subBrand && (
              <div style={{ fontSize: "0.8rem" }}>
                Sub-brand:{" "}
                <strong style={{ textTransform: "capitalize" }}>
                  {meta.subBrand}
                </strong>
              </div>
            )}
            {meta.destination && (
              <div style={{ fontSize: "0.8rem" }}>
                Destination: <strong>{meta.destination}</strong>
              </div>
            )}
            {meta.kind && (
              <div style={{ fontSize: "0.8rem" }}>
                Type:{" "}
                <strong style={{ textTransform: "capitalize" }}>
                  {meta.kind}
                </strong>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DetailRow({ label, children }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "0.45rem 0",
        borderBottom: "1px solid var(--border-color)",
      }}
    >
      <span style={{ color: "var(--text-secondary)", fontSize: "0.82rem" }}>
        {label}
      </span>
      <span style={{ fontSize: "0.85rem" }}>{children}</span>
    </div>
  );
}
