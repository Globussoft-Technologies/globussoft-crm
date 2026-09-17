import { useState, useEffect, useMemo, useContext, useCallback, useRef } from "react";
import {
  Receipt,
  Plus,
  CheckCircle2,
  Trash2,
  IndianRupee,
  Clock,
  AlertTriangle,
  Download,
  RefreshCw,
  CreditCard,
  Link2,
  Eye,
  ChevronDown,
  X,
  Filter,
  CalendarRange,
  UserRound,
  Package,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../utils/api";
import { useNotify } from "../utils/notify";
import { AuthContext } from "../App";
import { useSearchParams } from "react-router-dom";
import { useActiveSubBrand } from "../utils/subBrand";
import { SUB_BRAND_IDS, subBrandShortLabel } from "../utils/travelSubBrand";
import TopScrollSync from "../components/TopScrollSync";
import SearchableSingleSelect from "./wellness/services/SearchableSingleSelect";
const STATUS_CONFIG = {
  PAID: { color: "#10b981", bg: "rgba(16,185,129,0.15)", label: "Paid" },
  UNPAID: { color: "#f59e0b", bg: "rgba(245,158,11,0.15)", label: "Unpaid" },
  OVERDUE: { color: "#ef4444", bg: "rgba(239,68,68,0.15)", label: "Overdue" },
  VOIDED: { color: "#6b7280", bg: "rgba(107,114,128,0.15)", label: "Voided" },
};

function StatusBadge({ status, borderless = false }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.UNPAID;
  return (
    <span
      style={{
        padding: "0.2rem 0.7rem",
        borderRadius: "999px",
        fontSize: "0.75rem",
        fontWeight: "bold",
        backgroundColor: cfg.bg,
        color: cfg.color,
        // Use a zero-width transparent border for Wellness so browsers do not
        // add a visible status outline while the shared Generic/Travel badge
        // keeps its existing colored border.
        border: borderless ? "0 solid transparent" : `1px solid ${cfg.color}33`,
      }}
    >
      {cfg.label}
    </span>
  );
}

import { formatMoney, currencySymbol } from "../utils/money";
import { formatDate } from "../utils/date";
const formatCurrency = (v) =>
  formatMoney(v, { maximumFractionDigits: 2, minimumFractionDigits: 2 });

function getInvoiceLineItems(invoice) {
  if (Array.isArray(invoice?.lineItems)) return invoice.lineItems;
  if (typeof invoice?.lineItemsJson !== "string") return [];
  try {
    const parsed = JSON.parse(invoice.lineItemsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatPaymentMode(mode) {
  return WELLNESS_PAYMENT_MODES.find((option) => option.value === mode)?.label || mode || "—";
}

const WELLNESS_PAYMENT_MODES = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "other", label: "Other" },
];

const createEmptyLineItem = () => ({
  type: "service",
  itemId: "",
  quantity: 1,
  unitPrice: "",
});

// A completed visit can have a final bill that differs from the service
// catalogue price (for example, after additional charges or taxes). Keep the
// catalogue price untouched and reconcile the service line to that persisted
// visit total when the invoice is composed from the visit.
function applyVisitFinalBill(lineItems, finalBill) {
  if (finalBill == null || finalBill === '' || !Array.isArray(lineItems)) {
    return lineItems;
  }
  const targetTotal = Number(finalBill);
  if (!Number.isFinite(targetTotal) || targetTotal < 0) {
    return lineItems;
  }

  const serviceIndex = lineItems.findIndex((item) => item.type === "service");
  if (serviceIndex < 0) return lineItems;

  const otherItemsTotal = lineItems.reduce(
    (total, item, index) => {
      if (index === serviceIndex) return total;
      return total + (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0);
    },
    0,
  );
  const serviceItem = lineItems[serviceIndex];
  const quantity = Number(serviceItem.quantity) || 1;
  const serviceTotal = targetTotal - otherItemsTotal;
  if (serviceTotal < 0) return lineItems;

  const unitPrice = Math.round(((serviceTotal / quantity) + Number.EPSILON) * 100) / 100;
  return lineItems.map((item, index) => (
    index === serviceIndex ? { ...item, unitPrice: String(unitPrice) } : item
  ));
}

const createInvoiceForm = (subBrand = "") => ({
  invoiceNum: "",
  contactId: "",
  dealId: "",
  amount: "",
  dueDate: "",
  status: "UNPAID",
  subBrand,
  patientId: "",
  visitId: "",
  customerName: "",
  customerPhone: "",
  customerEmail: "",
  customerAddress: "",
  gstin: "",
  billingAddress: "",
  shippingAddress: "",
  paymentMode: "cash",
  lineItems: [createEmptyLineItem()],
});

const INVOICE_TABLE_MIN_WIDTH = 940;
const WELLNESS_INVOICE_TABLE_MIN_WIDTH = 1540;

/**
 * Date-range presets for the invoice ledger filter.
 *
 * `days: null` means "no lower bound" (All time). Everything else is resolved
 * against the LOCAL day so the boundaries line up with what the user sees in
 * the DUE DATE / ISSUED columns; the backend parses bare YYYY-MM-DD in the
 * server's local timezone for the same reason.
 */
const DATE_RANGE_PRESETS = [
  { value: "ALL", label: "All time" },
  { value: "7", label: "Last 7 days", days: 7 },
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
  { value: "MTD", label: "This month" },
  { value: "YTD", label: "This year" },
  { value: "CUSTOM", label: "Custom range…" },
];

/** Local-midnight YYYY-MM-DD. `toISOString()` would shift the day in any
 *  timezone behind UTC and silently offset every preset by one. */
function toLocalDateInput(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayDateInput() {
  return toLocalDateInput(new Date());
}

/**
 * Turn the preset + custom inputs into the {from, to} the API expects.
 * Returns an empty object for "All time" so no date params are sent at all.
 */
function resolveDateRange(preset, customFrom, customTo) {
  if (preset === "ALL") return {};
  if (preset === "CUSTOM") {
    const range = {};
    if (customFrom) range.from = customFrom;
    if (customTo) range.to = customTo;
    return range;
  }

  const today = new Date();
  if (preset === "MTD") {
    return { from: toLocalDateInput(new Date(today.getFullYear(), today.getMonth(), 1)) };
  }
  if (preset === "YTD") {
    return { from: toLocalDateInput(new Date(today.getFullYear(), 0, 1)) };
  }

  const days = Number(preset);
  if (!Number.isFinite(days) || days <= 0) return {};
  const from = new Date(today);
  // Inclusive of today: "last 7 days" is today plus the 6 before it, which is
  // what a 7-day window means to the person reading the ledger.
  from.setDate(from.getDate() - (days - 1));
  return { from: toLocalDateInput(from) };
}

export default function Invoices() {
  const notify = useNotify();
  // Travel vertical only — invoices get tagged + filtered by sub-brand. For
  // generic/wellness tenants isTravel is false and none of this UI renders, so
  // their Invoices page is unchanged.
  // AuthContext exposes `tenant` at the top level (same source the Sidebar uses
  // to switch to the travel nav); fall back to user.tenant for safety.
  const { user, tenant } = useContext(AuthContext) || {};
  const vertical = tenant?.vertical || user?.tenant?.vertical || "generic";
  const isTravel = vertical === "travel";
  const isWellness = vertical === "wellness";
  const { activeSubBrand, setActiveSubBrand } = useActiveSubBrand() || {};
  const [invoices, setInvoices] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [patients, setPatients] = useState([]);
  const [visits, setVisits] = useState([]);
  const [services, setServices] = useState([]);
  const [products, setProducts] = useState([]);
  const [patientSearch, setPatientSearch] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [isLoadingPatients, setIsLoadingPatients] = useState(false);
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  const [isLoadingVisits, setIsLoadingVisits] = useState(false);
  const [isLoadingVisitItems, setIsLoadingVisitItems] = useState(false);
  const visitRequestRef = useRef(0);
  const patientLookupRequestRef = useRef(0);
  const productLookupRequestRef = useRef(0);
  const selectedPatientIdRef = useRef("");
  const selectedProductIdsRef = useRef(new Set());
  const [linkModal, setLinkModal] = useState(null); // { inv, url } | null
  const [linkCopied, setLinkCopied] = useState(false);
  const [openActionMenuId, setOpenActionMenuId] = useState(null);
  const [pdfPreview, setPdfPreview] = useState(null); // { url, invoiceNum } | null
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [newInvoice, setNewInvoice] = useState(() => createInvoiceForm());
  // #124: replace the old prompt() flow with a proper modal so the user can
  // pick frequency, see what they're about to activate, and stop recurring
  // explicitly instead of guessing the toggle.
  const [recurInvoice, setRecurInvoice] = useState(null);
  const [recurFreq, setRecurFreq] = useState("monthly");
  const [statusFilter, setStatusFilter] = useState("ALL");
  // Reports link to one or more invoice ids with this query parameter. Keep
  // the filter client-side because the billing ledger already returns the
  // tenant-scoped rows needed for the table and existing callers remain
  // unchanged.
  const [searchParams] = useSearchParams();
  const reportInvoiceIds = useMemo(() => {
    const raw = searchParams.get("invoiceIds") || searchParams.get("invoiceId") || "";
    return new Set(
      raw
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0),
    );
  }, [searchParams]);
  const hasReportInvoiceFilter = reportInvoiceIds.size > 0;

  // Date-range filter. Unlike `statusFilter` (which slices the already-loaded
  // array), this is applied SERVER-SIDE via ?from/?to on GET /api/billing —
  // the API uses the issued date by default. The ledger is unbounded (979
  // invoices on the demo tenant already) so narrowing it in the browser would
  // keep downloading the whole table just to hide most of it.
  const [dateRange, setDateRange] = useState("ALL");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    if (!isCreateFormOpen && !pdfPreview) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isCreateFormOpen, pdfPreview]);

  useEffect(() => {
    if (openActionMenuId == null) return undefined;
    const closeOnOutsideClick = (event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(`[data-invoice-action-menu="${openActionMenuId}"]`)
      ) {
        return;
      }
      setOpenActionMenuId(null);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpenActionMenuId(null);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openActionMenuId]);

  useEffect(
    () => () => {
      if (pdfPreview?.url) URL.revokeObjectURL(pdfPreview.url);
    },
    [pdfPreview],
  );



  // Re-fetch when the travel sub-brand filter changes (no-op for other
  // verticals — activeSubBrand stays undefined there).
  const loadData = useCallback(async () => {
    try {
      // One query string for both filters. URLSearchParams rather than manual
      // concatenation so adding the date params cannot produce a stray `&`
      // when the travel sub-brand filter is absent.
      const params = new URLSearchParams();
      if (isTravel && activeSubBrand) params.set("subBrand", activeSubBrand);
      const range = resolveDateRange(dateRange, customFrom, customTo);
      if (range.from) params.set("from", range.from);
      if (range.to) params.set("to", range.to);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const [invs, c, d] = await Promise.all([
        fetchApi(`/api/billing${qs}`),
        fetchApi("/api/contacts"),
        fetchApi("/api/deals"),
      ]);
      setInvoices(Array.isArray(invs) ? invs : []);
      setContacts(Array.isArray(c) ? c : []);
      setDeals(Array.isArray(d) ? d : []);

      if (isWellness) {
        const [serviceResult] = await Promise.allSettled([
          fetchApi("/api/wellness/services"),
        ]);
        setServices(
          serviceResult.status === "fulfilled" && Array.isArray(serviceResult.value)
            ? serviceResult.value
            : [],
        );
      } else {
        // Do not retain vertical-specific catalog data if the same SPA session
        // changes tenant context or a stale component render completes later.
        setPatients([]);
        setVisits([]);
        setServices([]);
        setProducts([]);
      }
    } catch (_err) {
      // Network or auth error handled by fetchApi
    }
  }, [activeSubBrand, isTravel, isWellness, dateRange, customFrom, customTo]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Patient and product selectors use bounded backend searches. This keeps
  // the invoice screen responsive for large clinics and avoids downloading
  // every patient record (including PHI) just to populate a combobox.
  useEffect(() => {
    if (!isWellness) return undefined;
    const requestId = ++patientLookupRequestRef.current;
    setIsLoadingPatients(true);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ limit: "50", offset: "0", fields: "full" });
        if (patientSearch.trim()) params.set("q", patientSearch.trim());
        const response = await fetchApi(`/api/wellness/patients?${params.toString()}`);
        if (requestId !== patientLookupRequestRef.current) return;
        const incoming = Array.isArray(response)
          ? response
          : Array.isArray(response?.patients)
            ? response.patients
            : [];
        setPatients((current) => {
          const selected = current.filter(
            (patient) => String(patient.id) === String(selectedPatientIdRef.current),
          );
          return [...new Map([...selected, ...incoming].map((patient) => [patient.id, patient])).values()];
        });
      } catch (_err) {
        if (requestId === patientLookupRequestRef.current) setPatients([]);
      } finally {
        if (requestId === patientLookupRequestRef.current) setIsLoadingPatients(false);
      }
    }, patientSearch.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [isWellness, patientSearch]);

  useEffect(() => {
    if (!isWellness) return undefined;
    const requestId = ++productLookupRequestRef.current;
    setIsLoadingProducts(true);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ paginate: "true", page: "1", limit: "100" });
        if (productSearch.trim()) params.set("q", productSearch.trim());
        const response = await fetchApi(`/api/wellness/products?${params.toString()}`);
        if (requestId !== productLookupRequestRef.current) return;
        const incoming = Array.isArray(response)
          ? response
          : Array.isArray(response?.items)
            ? response.items
            : [];
        setProducts((current) => {
          const selected = current.filter((product) => selectedProductIdsRef.current.has(String(product.id)));
          return [...new Map([...selected, ...incoming].map((product) => [product.id, product])).values()];
        });
      } catch (_err) {
        if (requestId === productLookupRequestRef.current) setProducts([]);
      } finally {
        if (requestId === productLookupRequestRef.current) setIsLoadingProducts(false);
      }
    }, productSearch.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [isWellness, productSearch]);

  selectedPatientIdRef.current = newInvoice.patientId;
  selectedProductIdsRef.current = new Set(
    newInvoice.lineItems
      .filter((item) => item.type === "product" && item.itemId)
      .map((item) => String(item.itemId)),
  );

  // Default the create-form brand to the currently-active sub-brand (travel).
  useEffect(() => {
    if (isTravel && activeSubBrand) {
      setNewInvoice((p) =>
        p.subBrand ? p : { ...p, subBrand: activeSubBrand },
      );
    }
  }, [isTravel, activeSubBrand]);

  const stats = useMemo(() => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const totalOutstanding = invoices
      .filter((inv) => inv.status !== "PAID" && inv.status !== "VOIDED")
      .reduce((sum, inv) => sum + Number(inv.amount), 0);

    // #119: filter on paidAt (set by /pay route). Fall back to issuedDate for legacy
    // rows from before paidAt existed — at worst they count toward the issuance month
    // rather than the (unknown) payment month.
    const totalPaidThisMonth = invoices
      .filter(
        (inv) =>
          inv.status === "PAID" &&
          new Date(inv.paidAt || inv.issuedDate) >= startOfMonth,
      )
      .reduce((sum, inv) => sum + Number(inv.amount), 0);

    const overdueCount = invoices.filter(
      (inv) => inv.status === "OVERDUE",
    ).length;

    return { totalOutstanding, totalPaidThisMonth, overdueCount };
  }, [invoices]);

  const filteredInvoices = useMemo(() => {
    let rows = invoices;
    if (hasReportInvoiceFilter) {
      rows = rows.filter((inv) => reportInvoiceIds.has(Number(inv.id)));
    }
    if (statusFilter === "ALL") return rows;
    return rows.filter((inv) => inv.status === statusFilter);
  }, [invoices, statusFilter, hasReportInvoiceFilter, reportInvoiceIds]);

  const visibleInvoices = filteredInvoices;


  const nextInvoiceNum = useMemo(() => {
    if (invoices.length === 0) return "INV-001";
    const nums = invoices
      .map((inv) => {
        const match = (inv.invoiceNum || "").match(/INV-(\d+|[A-F0-9]+)/i);
        return match ? parseInt(match[1], 16) : 0;
      })
      .filter((n) => !isNaN(n));
    const max = nums.length > 0 ? Math.max(...nums) : 0;
    return `INV-${String(max + 1).padStart(3, "0")}`;
  }, [invoices]);

  const handleFieldChange = (field, value) => {
    setNewInvoice((prev) => ({ ...prev, [field]: value }));
  };

  const catalogForType = (type) => (type === "product" ? products : services);

  const wellnessInvoiceTotal = useMemo(
    () =>
      (newInvoice.lineItems || []).reduce(
        (total, item) =>
          total + (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0),
        0,
      ),
    [newInvoice.lineItems],
  );

  const handlePatientChange = async (value) => {
    const patient = patients.find((item) => String(item.id) === String(value));
    const requestId = ++visitRequestRef.current;
    setVisits([]);
    setIsLoadingVisits(Boolean(value));
    setNewInvoice((prev) => ({
      ...prev,
      patientId: value,
      visitId: "",
      contactId: patient?.contactId ? String(patient.contactId) : "",
      customerName: patient?.name || "",
      customerPhone: patient?.phone || "",
      customerEmail: patient?.email || "",
      customerAddress: patient?.address || "",
      gstin: patient?.gst || "",
      billingAddress: patient?.billingAddress || patient?.address || "",
      shippingAddress: patient?.shippingAddress || "",
      lineItems: [createEmptyLineItem()],
    }));

    if (!value) {
      setIsLoadingVisits(false);
      return;
    }

    try {
      const response = await fetchApi(`/api/wellness/patients/${encodeURIComponent(value)}/visits`);
      if (requestId !== visitRequestRef.current) return;
      setVisits(Array.isArray(response) ? response : Array.isArray(response?.visits) ? response.visits : []);
    } catch (_err) {
      if (requestId === visitRequestRef.current) {
        notify.error("Failed to load visits for this patient");
      }
    } finally {
      if (requestId === visitRequestRef.current) setIsLoadingVisits(false);
    }
  };

  const handleVisitChange = async (value) => {
    const visit = visits.find((item) => String(item.id) === String(value));
    const requestId = ++visitRequestRef.current;
    setNewInvoice((prev) => ({ ...prev, visitId: value }));

    if (!value) {
      setIsLoadingVisitItems(false);
      setNewInvoice((prev) => ({ ...prev, lineItems: [createEmptyLineItem()] }));
      return;
    }

    setIsLoadingVisitItems(true);
    try {
      const response = await fetchApi(`/api/wellness/visits/${encodeURIComponent(value)}/consumptions`);
      if (requestId !== visitRequestRef.current) return;
      const consumptions = Array.isArray(response)
        ? response
        : Array.isArray(response?.items)
          ? response.items
          : [];
      const nextLineItems = [];
      const skippedItems = [];

      const visitService = visit?.service;
      if (visitService?.id || visitService?.name) {
        const service = services.find(
          (item) =>
            (visitService.id && String(item.id) === String(visitService.id))
            || (visitService.name && item.name?.toLowerCase() === visitService.name.toLowerCase()),
        );
        if (service) {
          const price = service.discountedPrice ?? service.basePrice;
          nextLineItems.push({
            type: "service",
            itemId: String(service.id),
            quantity: 1,
            unitPrice: String(Number(price) || 0),
          });
        } else {
          skippedItems.push(visitService.name || "Visit service");
        }
      }

      consumptions.forEach((consumption) => {
        const product = products.find(
          (item) =>
            (consumption.productId && String(item.id) === String(consumption.productId))
            || (consumption.productName && item.name?.toLowerCase() === consumption.productName.toLowerCase()),
        );
        if (!product) {
          skippedItems.push(consumption.productName || "Visit product");
          return;
        }
        const price = product.discountedPrice ?? product.price;
        const quantity = Number(consumption.qty);
        nextLineItems.push({
          type: "product",
          itemId: String(product.id),
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
          unitPrice: String(Number(price) || 0),
        });
      });

      const adjustedLineItems = applyVisitFinalBill(nextLineItems, visit?.amountCharged);

      setNewInvoice((prev) => ({
        ...prev,
        lineItems: adjustedLineItems.length ? adjustedLineItems : [createEmptyLineItem()],
      }));
      if (skippedItems.length) {
        notify.info(`${skippedItems.join(", ")} could not be matched to the active catalogue.`);
      }
      if (!nextLineItems.length) {
        notify.info("No catalogue items were recorded for this visit. Add an item manually.");
      }
    } catch (_err) {
      if (requestId === visitRequestRef.current) {
        notify.error("Failed to load products and services for this visit");
      }
    } finally {
      if (requestId === visitRequestRef.current) setIsLoadingVisitItems(false);
    }
  };

  const handleLineItemChange = (index, field, value) => {
    setNewInvoice((prev) => {
      const lineItems = [...(prev.lineItems || [])];
      const current = { ...lineItems[index], [field]: value };
      if (field === "type") {
        current.itemId = "";
        current.unitPrice = "";
      }
      if (field === "itemId") {
        const catalogItem = catalogForType(current.type).find(
          (item) => String(item.id) === String(value),
        );
        const price = current.type === "service"
          ? catalogItem?.discountedPrice ?? catalogItem?.basePrice
          : catalogItem?.discountedPrice ?? catalogItem?.price;
        current.unitPrice = catalogItem ? String(Number(price) || 0) : "";
      }
      lineItems[index] = current;
      return { ...prev, lineItems };
    });
  };

  const addLineItem = () => {
    setNewInvoice((prev) => ({
      ...prev,
      lineItems: [...(prev.lineItems || []), createEmptyLineItem()],
    }));
  };

  const removeLineItem = (index) => {
    setNewInvoice((prev) => {
      const remaining = (prev.lineItems || []).filter((_, i) => i !== index);
      return {
        ...prev,
        lineItems: remaining.length ? remaining : [createEmptyLineItem()],
      };
    });
  };

  const createInvoice = async (e) => {
    e.preventDefault();
    const today = todayDateInput();
    if (!newInvoice.dueDate) {
      notify.error("Please select a due date");
      return;
    }
    if (newInvoice.dueDate < today) {
      notify.error("Due date cannot be in the past");
      return;
    }
    // Travel: sub-brand is required so every invoice is brand-attributed for
    // analytics (the whole point of this feature).
    if (isTravel && !newInvoice.subBrand) {
      notify.error("Please pick a sub-brand for this invoice");
      return;
    }
    if (isWellness) {
      if (!newInvoice.patientId) {
        notify.error("Please select a customer or patient");
        return;
      }
      if (!newInvoice.customerName.trim()) {
        notify.error("Please enter the customer's full name");
        return;
      }
      if (!newInvoice.lineItems.some((item) => item.itemId)) {
        notify.error("Add at least one product or service");
        return;
      }
      if (wellnessInvoiceTotal <= 0) {
        notify.error("The invoice total must be greater than zero");
        return;
      }
      const selectedVisit = visits.find(
        (visit) => String(visit.id) === String(newInvoice.visitId),
      );
      if (
        selectedVisit?.amountCharged != null &&
        selectedVisit.amountCharged !== "" &&
        Math.abs(
          wellnessInvoiceTotal - Number(selectedVisit.amountCharged),
        ) > 0.009
      ) {
        notify.error(
          "The invoice line items must add up exactly to the visit final bill",
        );
        return;
      }
    }
    try {
      await fetchApi("/api/billing", {
        method: "POST",
        body: JSON.stringify({
          amount: isWellness ? wellnessInvoiceTotal : newInvoice.amount,
          dueDate: newInvoice.dueDate,
          contactId: newInvoice.contactId || undefined,
          dealId: newInvoice.dealId || undefined,
          subBrand: isTravel ? newInvoice.subBrand : undefined,
          ...(isWellness
            ? {
                patientId: newInvoice.patientId,
                visitId: newInvoice.visitId || undefined,
                customerName: newInvoice.customerName,
                customerPhone: newInvoice.customerPhone,
                customerEmail: newInvoice.customerEmail,
                customerAddress: newInvoice.customerAddress,
                gstin: newInvoice.gstin,
                billingAddress: newInvoice.billingAddress,
                shippingAddress: newInvoice.shippingAddress,
                paymentMode: newInvoice.paymentMode,
                lineItems: newInvoice.lineItems.filter((item) => item.itemId),
              }
            : {}),
        }),
      });
      setNewInvoice(createInvoiceForm(isTravel ? activeSubBrand || "" : ""));
      setVisits([]);
      setIsLoadingVisits(false);
      setIsLoadingVisitItems(false);
      setIsCreateFormOpen(false);
      notify.success("Invoice created successfully");
      await loadData();
    } catch (_err) {
      notify.error("Failed to create invoice");
    }
  };

  const markPaid = async (id) => {
    try {
      await fetchApi(`/api/billing/${id}/pay`, { method: "PUT" });
      // #119: must refetch so the "Paid This Month" KPI memo recomputes from
      // the freshly-paid row (with paidAt populated server-side). Awaiting the
      // refetch keeps the Outstanding/Paid totals consistent with what the
      // user sees in the table.
      await loadData();
    } catch (_err) {
      notify.error("Failed to mark invoice as paid");
    }
  };

  const downloadPdf = (id, invoiceNum) => {
    const token = getAuthToken();
    // Use a relative path so the request stays same-origin and goes through
    // Vite's /api proxy (same as fetchApi). Prefixing with VITE_API_URL turns
    // this into a cross-origin call → triggers a CORS preflight → backend's
    // global auth guard 401s the unauthenticated OPTIONS → browser blocks
    // the GET as a CORS error.
    const url = `/api/billing/${id}/pdf`;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.error) detail = body.error;
          } catch {
            /* response wasn't JSON — keep the HTTP status */
          }
          throw new Error(detail);
        }
        return res.blob();
      })
      .then((blob) => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `${invoiceNum || "invoice"}.pdf`;
        link.click();
        URL.revokeObjectURL(link.href);
      })
      .catch((err) => notify.error(`Failed to download PDF: ${err.message}`));
  };

  const viewInvoicePdf = (id, invoiceNum) => {
    const token = getAuthToken();
    fetch(`/api/billing/${id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.error) detail = body.error;
          } catch {
            /* response wasn't JSON — keep the HTTP status */
          }
          throw new Error(detail);
        }
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        setPdfPreview({ url, invoiceNum: invoiceNum || "Invoice" });
      })
      .catch((err) => notify.error(`Failed to open invoice preview: ${err.message}`));
  };

  const voidInvoice = async (inv) => {
    const num = inv.invoiceNum || `#${inv.id}`;
    if (
      !(await notify.confirm({
        title: `Void invoice ${num}?`,
        message:
          `This marks the invoice as VOIDED and removes it from Outstanding totals. ` +
          `The invoice row and audit trail are preserved (no data loss).`,
        confirmText: "Void",
        destructive: true,
      }))
    )
      return;
    try {
      await fetchApi(`/api/billing/${inv.id}/void`, { method: "PUT" });
      loadData();
    } catch (_err) {
      notify.error("Failed to void invoice");
    }
  };

  const generatePaymentLink = async (inv) => {
    try {
      const result = await fetchApi(`/api/billing/${inv.id}/payment-link`, {
        method: "POST",
      });
      setLinkCopied(false);
      setLinkModal({ inv, url: result.url });
    } catch (err) {
      notify.error(err?.message || "Failed to generate payment link");
    }
  };

  return (
    <div
      style={{
        padding: "2rem",
        height: "100%",
        overflowY: "auto",
        animation: "fadeIn 0.5s ease-out",
      }}
    >
      <header style={{ marginBottom: "2rem" }}>
        <h1
          style={{
            fontSize: "2rem",
            fontWeight: "bold",
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
          }}
        >
          <Receipt size={26} color="var(--accent-color)" /> Invoices
        </h1>
        <p style={{ color: "var(--text-secondary)", marginTop: "0.25rem" }}>
          Create, track, and manage all invoices across your accounts.
        </p>
      </header>

      {/* Summary Stats */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.75rem",
          marginBottom: "1.75rem",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            padding: "0.4rem 1rem",
            borderRadius: "999px",
            fontSize: "0.75rem",
            fontWeight: "600",
            background: "rgba(245,158,11,0.1)",
            color: "#f59e0b",
            border: "1px solid rgba(245,158,11,0.3)",
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
          }}
        >
          <IndianRupee size={14} /> Outstanding:{" "}
          {formatCurrency(stats.totalOutstanding)}
        </span>
        <span
          style={{
            padding: "0.4rem 1rem",
            borderRadius: "999px",
            fontSize: "0.75rem",
            fontWeight: "600",
            background: "rgba(16,185,129,0.1)",
            color: "#10b981",
            border: "1px solid rgba(16,185,129,0.3)",
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
          }}
        >
          <CheckCircle2 size={14} /> Paid This Month:{" "}
          {formatCurrency(stats.totalPaidThisMonth)}
        </span>
        {stats.overdueCount > 0 && (
          <span
            style={{
              padding: "0.4rem 1rem",
              borderRadius: "999px",
              fontSize: "0.75rem",
              fontWeight: "600",
              background: "rgba(239,68,68,0.1)",
              color: "#ef4444",
              border: "1px solid rgba(239,68,68,0.3)",
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
            }}
          >
            <AlertTriangle size={14} /> {stats.overdueCount} Overdue
          </span>
        )}
        <span
          style={{
            padding: "0.4rem 1rem",
            borderRadius: "999px",
            fontSize: "0.75rem",
            background: "var(--subtle-bg-4)",
            color: "var(--text-secondary)",
            border: "1px solid var(--border-color)",
          }}
        >
          {/* Every KPI chip above is derived from `invoices`, which is now a
              DATE-FILTERED set. Saying "total invoices" while a range is
              active would read as a tenant-wide count and quietly misreport
              the ledger, so the wording follows the filter. */}
          {invoices.length}{dateRange === "ALL" ? " total invoices" : " invoices in range"}
        </span>
        {hasReportInvoiceFilter && (
          <span
            style={{
              padding: "0.4rem 1rem",
              borderRadius: "999px",
              fontSize: "0.75rem",
              background: "rgba(59,130,246,0.12)",
              color: "var(--text-secondary)",
              border: "1px solid rgba(59,130,246,0.25)",
            }}
          >
            Report drill-down: {reportInvoiceIds.size} invoice{reportInvoiceIds.size === 1 ? "" : "s"}
          </span>
        )}

        {/* Travel vertical — Sub-brand filter for the ledger. Bound to the
            shared active-sub-brand context (same source the sidebar selector
            uses), so picking here filters the ledger AND keeps the whole travel
            vertical in sync. Hidden for generic/wellness. */}
        {isTravel && (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.25rem 0.75rem",
              borderRadius: "999px",
              background: "var(--subtle-bg-4)",
              border: "1px solid var(--border-color)",
            }}
          >
            <Filter size={14} color="var(--text-secondary)" />
            <label
              htmlFor="invoice-subbrand-filter"
              style={{
                fontSize: "0.75rem",
                color: "var(--text-secondary)",
                fontWeight: 600,
              }}
            >
              Sub-brand:
            </label>
            <select
              id="invoice-subbrand-filter"
              value={activeSubBrand || ""}
              onChange={(e) =>
                setActiveSubBrand && setActiveSubBrand(e.target.value || null)
              }
              aria-label="Filter invoices by sub-brand"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-primary)",
                fontSize: "0.75rem",
                fontWeight: 600,
                cursor: "pointer",
                outline: "none",
                padding: "0.25rem 0.25rem",
              }}
            >
              <option
                value=""
                style={{
                  background: "var(--bg-color, #0b0c10)",
                  color: "var(--text-primary, #fff)",
                }}
              >
                All sub-brands
              </option>
              {SUB_BRAND_IDS.map((id) => (
                <option
                  key={id}
                  value={id}
                  style={{
                    background: "var(--bg-color, #0b0c10)",
                    color: "var(--text-primary, #fff)",
                  }}
                >
                  {subBrandShortLabel(id)}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Date-range filter. Applied on the server (?from/?to on GET
            /api/billing); the API's default issued-date scope is the only
            date basis exposed by this ledger control. */}
        <div
          style={{
            marginLeft: isTravel ? "0.5rem" : "auto",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.25rem 0.75rem",
            borderRadius: "999px",
            background: "var(--subtle-bg-4)",
            border: "1px solid var(--border-color)",
            flexWrap: "wrap",
          }}
        >
          <CalendarRange size={14} color="var(--text-secondary)" />
          <select
            id="invoice-date-range"
            className="invoice-date-range-filter"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            aria-label="Filter invoices by date range"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-primary)",
              fontSize: "0.75rem",
              fontWeight: 600,
              cursor: "pointer",
              outline: "none",
              padding: "0.25rem 0.25rem",
            }}
          >
            {DATE_RANGE_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
          {dateRange === "CUSTOM" && (
            <>
              <input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
                aria-label="From date"
                style={{
                  background: "transparent",
                  border: "1px solid var(--border-color)",
                  borderRadius: "6px",
                  color: "var(--text-primary)",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  outline: "none",
                  padding: "0.2rem 0.35rem",
                  // NO inline `colorScheme` here. index.css already drives
                  // `color-scheme` off [data-theme] for every date/time input
                  // so the browser's native picker indicator stays visible in
                  // both themes. An inline value beats that stylesheet rule,
                  // and pinning "dark" rendered a light indicator on light
                  // mode's light input — an invisible calendar button.
                }}
              />
              <span style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>to</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
                aria-label="To date"
                style={{
                  background: "transparent",
                  border: "1px solid var(--border-color)",
                  borderRadius: "6px",
                  color: "var(--text-primary)",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  outline: "none",
                  padding: "0.2rem 0.35rem",
                  // NO inline `colorScheme` here. index.css already drives
                  // `color-scheme` off [data-theme] for every date/time input
                  // so the browser's native picker indicator stays visible in
                  // both themes. An inline value beats that stylesheet rule,
                  // and pinning "dark" rendered a light indicator on light
                  // mode's light input — an invisible calendar button.
                }}
              />
            </>
          )}
        </div>

        <div
          style={{
            marginLeft: "0.5rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.25rem 0.75rem",
            borderRadius: "999px",
            background: "var(--subtle-bg-4)",
            border: "1px solid var(--border-color)",
          }}
        >
          <Filter size={14} color="var(--text-secondary)" />
          <label
            htmlFor="invoice-status-filter"
            style={{
              fontSize: "0.75rem",
              color: "var(--text-secondary)",
              fontWeight: 600,
            }}
          >
            Status:
          </label>
          <select
            id="invoice-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter invoices by status"
            className="invoice-status-filter-select"
            ref={(el) => {
              if (el) {
                el.style.setProperty(
                  "background",
                  "var(--subtle-bg-4)",
                  "important"
                );
              }
            }}
            style={{
              background: "var(--subtle-bg-4)",
              border: "none",
              color: "var(--text-primary)",
              fontSize: "0.75rem",
              fontWeight: 600,
              cursor: "pointer",
              outline: "none",
              padding: "0.25rem 0.25rem",
            }}
          >
            {/* Options need explicit bg/color — the dropdown popup is rendered
                by the OS/browser and inherits the select's transparent bg,
                making the menu unreadable on the generic CRM dark theme. */}
            <option
              value="ALL"
              style={{
                background: "var(--bg-color, #0b0c10)",
                color: "var(--text-primary, #fff)",
              }}
            >
              All
            </option>
            <option
              value="PAID"
              style={{
                background: "var(--bg-color, #0b0c10)",
                color: "var(--text-primary, #fff)",
              }}
            >
              Paid
            </option>
            <option
              value="UNPAID"
              style={{
                background: "var(--bg-color, #0b0c10)",
                color: "var(--text-primary, #fff)",
              }}
            >
              Unpaid
            </option>
            <option
              value="OVERDUE"
              style={{
                background: "var(--bg-color, #0b0c10)",
                color: "var(--text-primary, #fff)",
              }}
            >
              Overdue
            </option>
            <option
              value="VOIDED"
              style={{
                background: "var(--bg-color, #0b0c10)",
                color: "var(--text-primary, #fff)",
              }}
            >
              Voided
            </option>
          </select>
        </div>

        <button
          type="button"
          className="btn-primary"
          onClick={() => setIsCreateFormOpen(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.45rem",
            padding: "0.65rem 1rem",
            whiteSpace: "nowrap",
            color: "#FFFFFF",
    opacity: 1,
        background: isWellness
          ? "var(--primary-color, var(--accent-color))"
          : "linear-gradient(135deg, #d99f7b 0%, #b98a4d 100%)",

          }}
        >
          <Plus size={16} /> Create Invoice
        </button>
      </div>

      {isCreateFormOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Create Invoice"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsCreateFormOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "var(--overlay-bg, rgba(0,0,0,0.6))",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            overflow: "hidden",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              padding: "1.5rem",
              width: isWellness ? "960px" : "720px",
              maxWidth: "100%",
              height: "min(92vh, 900px)",
              minHeight: 0,
              maxHeight: "calc(100vh - 2rem)",
              overflow: "hidden",
              margin: 0,
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              background: "var(--modal-bg, var(--bg-color))",
              backgroundColor: "var(--modal-bg, var(--bg-color))",
              borderRadius: "16px",
              border: "1px solid var(--border-color)",
              boxShadow: "0 25px 50px -12px rgba(0,0,0,0.28)",
            }}
          >
            <h3
              style={{
                fontSize: "1.15rem",
                fontWeight: "600",
                marginBottom: "1rem",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.5rem",
                flexShrink: 0,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Plus size={20} color="var(--accent-color)" /> Create Invoice
              </span>
              <button
                type="button"
                onClick={() => setIsCreateFormOpen(false)}
                style={{
                  background: "transparent",
                  border: "1px solid var(--border-color)",
                  cursor: "pointer",
                  color: "var(--text-secondary)",
                  padding: "0.45rem",
                  borderRadius: "6px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                aria-label="Close create invoice form"
              >
                <X size={18} />
              </button>
            </h3>
            <form
              onSubmit={createInvoice}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "1.25rem",
                minHeight: 0,
                flex: 1,
                overflow: "hidden",
              }}
            >
              <div
                className="invoice-create-form-scroll"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "1.25rem",
                  minHeight: 0,
                  flex: 1,
                  overflowY: "auto",
                  overflowX: "hidden",
                  paddingRight: "0.35rem",
                  overscrollBehavior: "contain",
                  scrollbarGutter: "stable",
                }}
              >
              {/* #314: Invoice # is server-generated and was being silently
                  overwritten on save, leaving the user confused about why their
                  custom number didn't stick. Make the field read-only and surface
                  the next number that will be assigned, so what the user sees
                  up-front matches what the backend writes. Custom numbering is an
                  admin-only feature and isn't part of this form. */}
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.875rem",
                    marginBottom: "0.5rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  Invoice #
                </label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="Auto-generated on save"
                  value={nextInvoiceNum}
                  readOnly
                  aria-label="Invoice number (auto-generated on save)"
                  style={{ opacity: 0.75, cursor: "not-allowed" }}
                />
                <span
                  style={{
                    fontSize: "0.7rem",
                    color: "var(--text-secondary)",
                    marginTop: "0.25rem",
                    display: "block",
                  }}
                >
                  Auto-generated on save
                </span>
              </div>

              {isWellness ? (
                <section
                  aria-labelledby="invoice-customer-details-heading"
                  style={{
                    padding: "1rem",
                    borderRadius: "12px",
                    border: "1px solid var(--border-color)",
                    background: "var(--subtle-bg-2)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "1rem",
                  }}
                >
                  <div>
                    <h4
                      id="invoice-customer-details-heading"
                      style={{
                        margin: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: "0.45rem",
                        fontSize: "1rem",
                        color: "var(--text-primary)",
                      }}
                    >
                      <UserRound size={18} color="var(--primary-color, var(--accent-color))" />
                      Customer Details
                    </h4>
                    <p
                      style={{
                        margin: "0.35rem 0 0",
                        color: "var(--text-secondary)",
                        fontSize: "0.78rem",
                      }}
                    >
                      Select a patient from the master database. The details below
                      are saved as an invoice snapshot.
                    </p>
                  </div>

                  <div>
                    <label
                      style={{
                        display: "block",
                        fontSize: "0.875rem",
                        marginBottom: "0.5rem",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Customer / Patient
                    </label>
                    <SearchableSingleSelect
                      value={newInvoice.patientId}
                      onChange={handlePatientChange}
                      options={patients.map((patient) => ({
                        value: String(patient.id),
                        label: `${patient.name || "Unnamed patient"}${patient.phone ? ` · ${patient.phone}` : ""}`,
                      }))}
                      placeholder="Search patient by name or phone..."
                      onSearchChange={setPatientSearch}
                      loading={isLoadingPatients}
                      aria-label="Customer or patient"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="invoice-patient-visit"
                      style={{
                        display: "block",
                        fontSize: "0.78rem",
                        marginBottom: "0.35rem",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Visit (Optional)
                    </label>
                    <select
                      id="invoice-patient-visit"
                      className="input-field"
                      value={newInvoice.visitId}
                      onChange={(e) => handleVisitChange(e.target.value)}
                      disabled={!newInvoice.patientId || isLoadingVisits}
                      aria-label="Patient visit"
                      style={{ background: "var(--input-bg)" }}
                    >
                      <option value="">
                        {!newInvoice.patientId
                          ? "Select a patient first"
                          : isLoadingVisits
                            ? "Loading visits..."
                            : visits.length
                              ? "-- Select a visit --"
                              : "No visits found"}
                      </option>
                      {visits.map((visit) => (
                        <option key={visit.id} value={visit.id}>
                          {formatDate(visit.visitDate)} · {visit.service?.name || "Visit"} · {visit.status || "recorded"}
                        </option>
                      ))}
                    </select>
                    {isLoadingVisitItems && (
                      <span style={{ display: "block", fontSize: "0.7rem", color: "var(--text-secondary)", marginTop: "0.3rem" }}>
                        Loading items recorded for this visit...
                      </span>
                    )}
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
                      gap: "0.85rem",
                    }}
                  >
                    <div>
                      <label
                        style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.35rem", color: "var(--text-secondary)" }}
                      >
                        Full Name
                      </label>
                      <input
                        type="text"
                        className="input-field"
                        required
                        value={newInvoice.customerName}
                        onChange={(e) => handleFieldChange("customerName", e.target.value)}
                        placeholder="Customer full name"
                        aria-label="Full name"
                      />
                    </div>
                    <div>
                      <label
                        style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.35rem", color: "var(--text-secondary)" }}
                      >
                        Phone Number
                      </label>
                      <input
                        type="tel"
                        className="input-field"
                        value={newInvoice.customerPhone}
                        onChange={(e) => handleFieldChange("customerPhone", e.target.value)}
                        placeholder="Phone number"
                        aria-label="Phone number"
                      />
                    </div>
                    <div>
                      <label
                        style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.35rem", color: "var(--text-secondary)" }}
                      >
                        Email Address
                      </label>
                      <input
                        type="email"
                        className="input-field"
                        value={newInvoice.customerEmail}
                        onChange={(e) => handleFieldChange("customerEmail", e.target.value)}
                        placeholder="name@example.com"
                        aria-label="Email address"
                      />
                    </div>
                    <div>
                      <label
                        style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.35rem", color: "var(--text-secondary)" }}
                      >
                        GSTIN <span style={{ fontWeight: 400 }}>(Optional)</span>
                      </label>
                      <input
                        type="text"
                        className="input-field"
                        maxLength={15}
                        value={newInvoice.gstin}
                        onChange={(e) => handleFieldChange("gstin", e.target.value.toUpperCase())}
                        placeholder="15-character GSTIN"
                        aria-label="GSTIN"
                      />
                    </div>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
                      gap: "0.85rem",
                    }}
                  >
                    <div>
                      <label
                        style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.35rem", color: "var(--text-secondary)" }}
                      >
                        Address
                      </label>
                      <textarea
                        className="input-field"
                        rows={2}
                        value={newInvoice.customerAddress}
                        onChange={(e) => handleFieldChange("customerAddress", e.target.value)}
                        placeholder="Customer address"
                        aria-label="Address"
                        style={{ resize: "vertical" }}
                      />
                    </div>
                    <div>
                      <label
                        style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.35rem", color: "var(--text-secondary)" }}
                      >
                        Billing Address
                      </label>
                      <textarea
                        className="input-field"
                        rows={2}
                        value={newInvoice.billingAddress}
                        onChange={(e) => handleFieldChange("billingAddress", e.target.value)}
                        placeholder="Billing address"
                        aria-label="Billing address"
                        style={{ resize: "vertical" }}
                      />
                    </div>
                    <div>
                      <label
                        style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.35rem", color: "var(--text-secondary)" }}
                      >
                        Shipping / Service Address
                      </label>
                      <textarea
                        className="input-field"
                        rows={2}
                        value={newInvoice.shippingAddress}
                        onChange={(e) => handleFieldChange("shippingAddress", e.target.value)}
                        placeholder="Where the service is delivered, if different"
                        aria-label="Shipping or service address"
                        style={{ resize: "vertical" }}
                      />
                    </div>
                  </div>
                </section>
              ) : (
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.875rem",
                      marginBottom: "0.5rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Contact
                  </label>
                  <SearchableSingleSelect
                    value={newInvoice.contactId}
                    onChange={(value) => handleFieldChange("contactId", value)}
                    options={(contacts || []).map((c) => ({
                      value: String(c.id),
                      label: `${c.name} (${c.email})`,
                    }))}
                    placeholder="Search contact..."
                    aria-label="Contact"
                  />
                </div>
              )}

              {isTravel && (
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.875rem",
                      marginBottom: "0.5rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Sub-brand
                  </label>
                  <select
                    className="input-field"
                    required
                    value={newInvoice.subBrand}
                    onChange={(e) =>
                      handleFieldChange("subBrand", e.target.value)
                    }
                    style={{ background: "var(--input-bg)" }}
                    aria-label="Sub-brand"
                  >
                    <option value="">-- Select Sub-brand --</option>
                    {SUB_BRAND_IDS.map((id) => (
                      <option key={id} value={id}>
                        {subBrandShortLabel(id)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {!isWellness && (
                <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.875rem",
                    marginBottom: "0.5rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  Deal (Optional)
                </label>
                <select
                  className="input-field"
                  value={newInvoice.dealId}
                  onChange={(e) => handleFieldChange("dealId", e.target.value)}
                  style={{ background: "var(--input-bg)" }}
                  aria-label="Associated deal"
                >
                  <option value="">-- No Deal --</option>
                    {deals.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title} - {formatCurrency(d.amount)}
                    </option>
                    ))}
                  </select>
                </div>
              )}

              {isWellness && (
                <section
                  aria-labelledby="invoice-products-services-heading"
                  style={{
                    padding: "1rem",
                    borderRadius: "12px",
                    border: "1px solid var(--border-color)",
                    background: "var(--subtle-bg-2)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.85rem",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}>
                    <h4
                      id="invoice-products-services-heading"
                      style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.45rem", fontSize: "1rem" }}
                    >
                      <Package size={18} color="var(--primary-color, var(--accent-color))" />
                      Products &amp; Services
                    </h4>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={addLineItem}
                      style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.45rem 0.65rem", fontSize: "0.78rem" }}
                    >
                      <Plus size={14} /> Add item
                    </button>
                  </div>

                  <div className="invoice-line-items-list" style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
                    {newInvoice.lineItems.map((item, index) => {
                      const options = catalogForType(item.type);
                      const lineTotal = (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0);
                      return (
                        <div
                          key={`invoice-line-${index}`}
                          className="invoice-line-item-row"
                        >
                          <div>
                            <label style={{ display: "block", fontSize: "0.72rem", marginBottom: "0.3rem", color: "var(--text-secondary)" }}>
                              Type
                            </label>
                            <select
                              className="input-field"
                              value={item.type}
                              onChange={(e) => handleLineItemChange(index, "type", e.target.value)}
                              aria-label={`Line item ${index + 1} type`}
                              style={{ background: "var(--input-bg)", padding: "0.55rem 0.45rem" }}
                            >
                              <option value="service">Service</option>
                              <option value="product">Product</option>
                            </select>
                          </div>
                          <div>
                            <label style={{ display: "block", fontSize: "0.72rem", marginBottom: "0.3rem", color: "var(--text-secondary)" }}>
                              Product / Service
                            </label>
                            {item.type === "product" ? (
                              <SearchableSingleSelect
                                value={item.itemId}
                                onChange={(value) => handleLineItemChange(index, "itemId", value)}
                                options={options.map((option) => ({
                                  value: String(option.id),
                                  label: option.name,
                                }))}
                                placeholder="Search product..."
                                noneLabel="Select product"
                                onSearchChange={setProductSearch}
                                loading={isLoadingProducts}
                                aria-label={`Line item ${index + 1} product or service`}
                              />
                            ) : (
                              <select
                                className="input-field"
                                required
                                value={item.itemId}
                                onChange={(e) => handleLineItemChange(index, "itemId", e.target.value)}
                                aria-label={`Line item ${index + 1} product or service`}
                                style={{ background: "var(--input-bg)", padding: "0.55rem 0.45rem" }}
                              >
                                <option value="">Select {item.type}</option>
                                {options.map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {option.name}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                          <div>
                            <label style={{ display: "block", fontSize: "0.72rem", marginBottom: "0.3rem", color: "var(--text-secondary)" }}>
                              Qty
                            </label>
                            <input
                              type="number"
                              min="1"
                              step="0.01"
                              required
                              className="input-field"
                              value={item.quantity}
                              onChange={(e) => handleLineItemChange(index, "quantity", e.target.value)}
                              aria-label={`Line item ${index + 1} quantity`}
                            />
                          </div>
                          <div>
                            <label style={{ display: "block", fontSize: "0.72rem", marginBottom: "0.3rem", color: "var(--text-secondary)" }}>
                              Unit price
                            </label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              required
                              className="input-field"
                              value={item.unitPrice}
                              onChange={(e) => handleLineItemChange(index, "unitPrice", e.target.value)}
                              aria-label={`Line item ${index + 1} unit price`}
                            />
                            <span style={{ display: "block", fontSize: "0.68rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                              {formatCurrency(lineTotal)}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeLineItem(index)}
                            aria-label={`Remove line item ${index + 1}`}
                            style={{ background: "transparent", border: "1px solid rgba(239,68,68,0.3)", color: "var(--text-secondary)", cursor: "pointer", padding: "0.55rem", borderRadius: "6px", display: "inline-flex", marginTop: "1.55rem", alignSelf: "start" }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "0.6rem", borderTop: "1px solid var(--border-color)", paddingTop: "0.75rem" }}>
                    <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Invoice total</span>
                    <strong style={{ color: "var(--success-color)", fontSize: "1.1rem" }}>{formatCurrency(wellnessInvoiceTotal)}</strong>
                  </div>
                </section>
              )}

              <div style={{ display: "flex", gap: "1rem" }}>
                {!isWellness && (
                  <div style={{ flex: 1 }}>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.875rem",
                      marginBottom: "0.5rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Amount ({currencySymbol()})
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    className="input-field"
                    placeholder="0.00"
                    value={newInvoice.amount}
                    onChange={(e) => handleFieldChange("amount", e.target.value)}
                    aria-label="Invoice amount"
                  />
                  </div>
                )}
                <div style={{ flex: 1 }}>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.875rem",
                      marginBottom: "0.5rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Due Date
                  </label>
                  <input
                    type="date"
                    required
                    min={todayDateInput()}
                    className="input-field"
                    value={newInvoice.dueDate}
                    onChange={(e) => {
                      const value = e.target.value;
                      handleFieldChange("dueDate", value);
                      if (value && value < todayDateInput()) {
                        notify.error("Due date cannot be in the past");
                      }
                    }}
                    onClick={(e) => {
                      // Native date inputs normally open from the calendar
                      // icon. showPicker() also makes the text/placeholder
                      // area open the same picker when the browser supports it.
                      if (typeof e.currentTarget.showPicker === "function") {
                        try {
                          e.currentTarget.showPicker();
                        } catch (_err) {
                          // The browser may already have opened the picker via
                          // its default action; no fallback is needed.
                        }
                      }
                    }}
                    aria-label="Due date"
                  />
                </div>
              </div>

              {isWellness && (
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.875rem",
                      marginBottom: "0.5rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Payment Mode
                  </label>
                  <select
                    className="input-field"
                    value={newInvoice.paymentMode}
                    onChange={(e) => handleFieldChange("paymentMode", e.target.value)}
                    style={{ background: "var(--input-bg)" }}
                    aria-label="Payment mode"
                  >
                    {WELLNESS_PAYMENT_MODES.map((mode) => (
                      <option key={mode.value} value={mode.value}>
                        {mode.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.875rem",
                    marginBottom: "0.5rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  Status
                </label>
                <select
                  className="input-field"
                  value={newInvoice.status}
                  onChange={(e) => handleFieldChange("status", e.target.value)}
                  style={{ background: "var(--input-bg)" }}
                  aria-label="Invoice status"
                >
                  <option value="UNPAID">Unpaid</option>
                  <option value="PAID">Paid</option>
                  <option value="OVERDUE">Overdue</option>
                </select>
              </div>

              </div>

              <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => setIsCreateFormOpen(false)}
                  className="btn-secondary"
                  style={{ flex: "1 1 180px", padding: "1rem" }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  style={{ flex: "2 1 240px", padding: "1rem" }}
                >
                  Issue Invoice
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Invoice Table */}
      <div className="card" style={{ padding: "1.5rem" }}>
        <h3
          style={{
            fontSize: "1.15rem",
            fontWeight: "600",
            marginBottom: "1rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <Receipt size={20} color="var(--success-color)" /> Invoice Ledger
        </h3>

        {invoices.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "2.5rem 1.5rem",
              background: "var(--subtle-bg-2)",
              border: "1px dashed var(--border-color)",
              borderRadius: "8px",
            }}
          >
            <Receipt
              size={48}
              style={{
                opacity: 0.2,
                margin: "0 auto 1rem",
                color: "var(--accent-color)",
              }}
            />
            <p style={{ color: "var(--text-secondary)" }}>
              No invoices yet. Create one to get started.
            </p>
          </div>
        ) : filteredInvoices.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "2.5rem 1.5rem",
              background: "var(--subtle-bg-2)",
              border: "1px dashed var(--border-color)",
              borderRadius: "8px",
            }}
          >
            <Filter
              size={48}
              style={{
                opacity: 0.2,
                margin: "0 auto 1rem",
                color: "var(--accent-color)",
              }}
            />
            <p style={{ color: "var(--text-secondary)" }}>
              {hasReportInvoiceFilter
                ? "No invoices from this report drill-down are available."
                : <>No invoices match the “{STATUS_CONFIG[statusFilter]?.label || statusFilter}” filter.</>}
            </p>
          </div>
        ) : (
          <div className="invoice-table-scroll">
            <TopScrollSync
              scrollWidth={`${isWellness ? WELLNESS_INVOICE_TABLE_MIN_WIDTH : INVOICE_TABLE_MIN_WIDTH}px`}
            >
              {/* #243: table-layout fixed + per-column widths so the Contact
                  cell can no longer expand past its allotted space and bleed
                  on top of the sticky Actions column. The Contact cell itself
                  also truncates with ellipsis (see <td> below). */}
              <table
                className="stable-table"
                data-wellness-invoice={isWellness ? "true" : undefined}
                style={{
                  width: "100%",
                  minWidth: `${isWellness ? WELLNESS_INVOICE_TABLE_MIN_WIDTH : INVOICE_TABLE_MIN_WIDTH}px`,
                  borderCollapse: "collapse",
                  fontSize: "0.875rem",
                  tableLayout: "fixed",
                }}
                role="table"
                aria-label="Invoices table"
              >
                <colgroup>
                  <col style={{ width: isWellness ? "180px" : "110px" }} />
                  {isWellness && <col style={{ width: "190px" }} />}
                  {isWellness && <col style={{ width: "310px" }} />}
                  {isWellness && <col style={{ width: "70px" }} />}
                  <col style={{ width: isWellness ? "105px" : "104px" }} />
                  {isWellness && <col style={{ width: "125px" }} />}
                  <col style={{ width: isWellness ? "100px" : "96px" }} />
                  <col style={{ width: isWellness ? "105px" : "108px" }} />
                  <col style={{ width: isWellness ? "105px" : "108px" }} />
                  {!isWellness && <col style={{ width: "170px" }} />}
                  <col style={{ width: isWellness ? "250px" : "244px" }} />
                </colgroup>
                <thead className="invoice-table-header">
                  <tr
                    style={{
                      borderBottom: "1px solid var(--border-color)",
                      textAlign: "left",
                    }}
                  >
                    <th
                      style={{
                        padding: "0.65rem 0.4rem",
                        color: "var(--text-secondary)",
                        fontWeight: "600",
                        fontSize: "0.75rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Invoice #
                    </th>
                    {isWellness && (
                      <>
                        <th
                          style={{
                            padding: "0.65rem 0.4rem",
                            color: "var(--text-secondary)",
                            fontWeight: "600",
                            fontSize: "0.75rem",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          Customer / Patient
                        </th>
                        <th
                          style={{
                            padding: "0.65rem 0.4rem",
                            color: "var(--text-secondary)",
                            fontWeight: "600",
                            fontSize: "0.75rem",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          Products / Services
                        </th>
                        <th
                          style={{
                            padding: "0.65rem 0.4rem",
                            color: "var(--text-secondary)",
                            fontWeight: "600",
                            fontSize: "0.75rem",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          Qty
                        </th>
                      </>
                    )}
                    <th
                      style={{
                        padding: "0.65rem 0.4rem",
                        color: "var(--text-secondary)",
                        fontWeight: "600",
                        fontSize: "0.75rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Amount
                    </th>
                    {isWellness && (
                      <th
                        style={{
                          padding: "0.65rem 0.4rem",
                          color: "var(--text-secondary)",
                          fontWeight: "600",
                          fontSize: "0.75rem",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        Payment Mode
                      </th>
                    )}
                    <th
                      style={{
                        padding: "0.65rem 0.4rem",
                        color: "var(--text-secondary)",
                        fontWeight: "600",
                        fontSize: "0.75rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Status
                    </th>
                    <th
                      style={{
                        padding: "0.65rem 0.4rem",
                        color: "var(--text-secondary)",
                        fontWeight: "600",
                        fontSize: "0.75rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Due Date
                    </th>
                    <th
                      style={{
                        padding: "0.65rem 0.4rem",
                        color: "var(--text-secondary)",
                        fontWeight: "600",
                        fontSize: "0.75rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Issued
                    </th>
                    {!isWellness && <th
                      style={{
                        padding: "0.65rem 0.4rem",
                        color: "var(--text-secondary)",
                        fontWeight: "600",
                        fontSize: "0.75rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Contact
                    </th>}
                    {/* #119 polish: sticky right-edge so action buttons are always
                        visible regardless of horizontal scroll position. */}
                    <th
                      className="invoice-actions-cell"
                      style={{
                        padding: "0.65rem 0.4rem",
                        color: "var(--text-secondary)",
                        fontWeight: "600",
                        fontSize: "0.75rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        textAlign: "left",
                      }}
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleInvoices.map((inv) => {
                    const wellnessLineItems = getInvoiceLineItems(inv);
                    const wellnessQuantity = wellnessLineItems.reduce(
                      (total, item) => total + (Number(item.quantity) || 0),
                      0,
                    );
                    const customerName = inv.customerName || inv.contact?.name || "Unknown";
                    const customerContact = inv.customerPhone || inv.customerEmail || "";
                    return (
                    <tr
                      key={inv.id}
                      style={{
                        borderBottom: "1px solid var(--border-color)",
                        transition: "background 0.15s",
                      }}
                      onMouseOver={(e) =>
                        (e.currentTarget.style.background = "var(--hover-bg)")
                      }
                      onMouseOut={(e) =>
                        (e.currentTarget.style.background = "transparent")
                      }
                    >
                      <td
                        style={{
                          padding: "0.75rem 0.4rem",
                          fontWeight: "600",
                          letterSpacing: "0.03em",
                        }}
                      >
                        {inv.invoiceNum}
                      </td>
                      {isWellness && (
                        <td
                          style={{
                            padding: "0.75rem 0.4rem",
                            color: "var(--text-secondary)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          title={[customerName, customerContact].filter(Boolean).join(" · ")}
                        >
                          <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
                            {customerName}
                          </div>
                          {customerContact && (
                            <div style={{ fontSize: "0.72rem", marginTop: "0.2rem", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {customerContact}
                            </div>
                          )}
                        </td>
                      )}
                      {isWellness && (
                        <td
                          style={{
                            padding: "0.75rem 0.4rem",
                            color: "var(--text-secondary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          title={wellnessLineItems.map((item) => item.name).filter(Boolean).join(", ") || "No line items"}
                        >
                          {wellnessLineItems.length > 0 ? (
                            wellnessLineItems.map((item, index) => (
                              <div key={`${item.type || "item"}-${item.itemId || index}`} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                                {item.name || "Unnamed item"}
                              </div>
                            ))
                          ) : (
                            "—"
                          )}
                        </td>
                      )}
                      {isWellness && (
                        <td style={{ padding: "0.75rem 0.4rem", color: "var(--text-secondary)" }}>
                          {wellnessQuantity || "—"}
                        </td>
                      )}
                      <td style={{ padding: "0.75rem 0.4rem" }}>
                        {/* #242: removed the hardcoded $ IndianRupee icon — formatCurrency()
                            already prefixes the right symbol (₹ for INR tenants, $ for USD,
                            etc.). Stacking the icon caused "$ ₹1,500.00" on Indian tenants. */}
                        <span
                          style={{
                            color: "var(--success-color)",
                            fontWeight: 600,
                          }}
                        >
                          {formatCurrency(inv.amount)}
                        </span>
                      </td>
                      {isWellness && (
                        <td style={{ padding: "0.75rem 0.4rem", color: "var(--text-secondary)" }}>
                          {formatPaymentMode(inv.paymentMode)}
                        </td>
                      )}
                      <td style={{ padding: "0.75rem 0.4rem" }}>
                        <StatusBadge status={inv.status} borderless={isWellness} />
                      </td>
                      <td
                        style={{
                          padding: "0.75rem 0.4rem",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {isWellness ? (
                          formatDate(inv.dueDate)
                        ) : (
                          <span
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.25rem",
                            }}
                          >
                            <Clock size={13} />
                            {formatDate(inv.dueDate)}
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "0.75rem 0.4rem",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {/* #111: Invoice schema uses issuedDate, not createdAt. */}
                        {inv.issuedDate ? formatDate(inv.issuedDate) : "—"}
                      </td>
                      {!isWellness && <td
                        style={{
                          padding: "0.75rem 0.4rem",
                          color: "var(--text-secondary)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                         title={customerName}
                       >
                         {customerName}
                        {isTravel &&
                          (inv.subBrand || inv.contact?.subBrand) && (
                            <span
                              style={{
                                display: "inline-block",
                                marginLeft: 8,
                                padding: "1px 7px",
                                borderRadius: 999,
                                fontSize: "0.65rem",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                letterSpacing: 0.3,
                                background: "rgba(79,70,229,0.16)",
                                color: "#818cf8",
                                verticalAlign: "middle",
                              }}
                            >
                              {subBrandShortLabel(
                                inv.subBrand || inv.contact?.subBrand,
                              )}
                            </span>
                          )}
                      </td>}
                      <td
                        className={`invoice-actions-cell${openActionMenuId === inv.id ? " invoice-actions-cell--menu-open" : ""}`}
                        style={{
                          padding: "0.75rem 0.4rem",
                          textAlign: "left",
                        }}
                      >
                        <div
                          className="invoice-actions-toolbar"
                          data-invoice-action-menu={String(inv.id)}
                        >
                          <button
                            type="button"
                            className="invoice-action-button invoice-action-button--view"
                            onClick={() => {
                              setOpenActionMenuId(null);
                              viewInvoicePdf(inv.id, inv.invoiceNum);
                            }}
                            aria-label={`View invoice ${inv.invoiceNum}`}
                          >
                            <Eye size={15} aria-hidden="true" />
                            <span>View</span>
                          </button>
                          <span
                            className="invoice-action-divider"
                            aria-hidden="true"
                          />
                          <div className="invoice-more-action">
                            <button
                              type="button"
                              className="invoice-action-button invoice-action-button--more"
                              onClick={() =>
                                setOpenActionMenuId((current) =>
                                  current === inv.id ? null : inv.id,
                                )
                              }
                              aria-haspopup="menu"
                              aria-expanded={openActionMenuId === inv.id}
                              aria-controls={`invoice-actions-menu-${inv.id}`}
                              aria-label={`More actions for invoice ${inv.invoiceNum}`}
                            >
                              <span>More</span>
                              <ChevronDown size={14} aria-hidden="true" />
                            </button>
                            {openActionMenuId === inv.id && (
                              <div
                                id={`invoice-actions-menu-${inv.id}`}
                                className="invoice-actions-menu"
                                role="menu"
                                aria-label={`Actions for invoice ${inv.invoiceNum}`}
                              >
                                {inv.status !== "PAID" && inv.status !== "VOIDED" && (
                                  <>
                                    <button
                                      type="button"
                                      className="invoice-action-menu-item"
                                      role="menuitem"
                                      onClick={() => {
                                        setOpenActionMenuId(null);
                                        generatePaymentLink(inv);
                                      }}
                                      aria-label={`Generate payment link for invoice ${inv.invoiceNum}`}
                                    >
                                      <Link2 size={16} aria-hidden="true" />
                                      <span>Generate Payment Link</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="invoice-action-menu-item"
                                      role="menuitem"
                                      onClick={() => {
                                        setOpenActionMenuId(null);
                                        markPaid(inv.id);
                                      }}
                                      aria-label={`Mark invoice ${inv.invoiceNum} as paid`}
                                    >
                                      <CheckCircle2 size={16} aria-hidden="true" />
                                      <span>Mark as Paid</span>
                                    </button>
                                  </>
                                )}
                                <button
                                  type="button"
                                  className="invoice-action-menu-item"
                                  role="menuitem"
                                  onClick={() => {
                                    setOpenActionMenuId(null);
                                    downloadPdf(inv.id, inv.invoiceNum);
                                  }}
                                  aria-label={`Download PDF for invoice ${inv.invoiceNum}`}
                                >
                                  <Download size={16} aria-hidden="true" />
                                  <span>Download PDF</span>
                                </button>
                                {inv.status !== "VOIDED" && (
                                  <>
                                    <button
                                      type="button"
                                      className="invoice-action-menu-item invoice-action-menu-item--danger"
                                      role="menuitem"
                                      onClick={() => {
                                        setOpenActionMenuId(null);
                                        voidInvoice(inv);
                                      }}
                                      aria-label={`Void invoice ${inv.invoiceNum}`}
                                    >
                                      <Trash2 size={16} aria-hidden="true" />
                                      <span>Mark as Void</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="invoice-action-menu-item"
                                      role="menuitem"
                                      onClick={() => {
                                        setOpenActionMenuId(null);
                                        setRecurInvoice(inv);
                                        setRecurFreq(inv.recurFrequency || "monthly");
                                      }}
                                    >
                                      <RefreshCw size={16} aria-hidden="true" />
                                      <span>
                                        {inv.isRecurring
                                          ? `Recurring: ${inv.recurFrequency}`
                                          : "Create Recurring"}
                                      </span>
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                          {/* #304: a voided invoice should never offer recurring
                              billing — the user already cancelled it, and
                              activating recurrence on a voided row would silently
                              auto-generate live invoices from a cancelled
                              template. Hide the button entirely for VOIDED. */}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </TopScrollSync>
          </div>
        )}
      </div>

      {/* #124: Recur modal — replaces the old prompt(). */}
      {recurInvoice && (
        <div
          onClick={() => setRecurInvoice(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card"
            style={{
              background: "var(--surface-color)",
              color: "var(--text-primary)",
              padding: "1.5rem",
              borderRadius: "12px",
              minWidth: "380px",
              maxWidth: "460px",
              border: "1px solid var(--border-color)",
              backdropFilter: "blur(12px)",
            }}
          >
            <h3
              style={{
                fontSize: "1.1rem",
                fontWeight: 600,
                marginBottom: "0.5rem",
              }}
            >
              {recurInvoice.isRecurring
                ? "Stop recurring billing"
                : "Set up recurring billing"}
            </h3>
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: "0.85rem",
                marginBottom: "1rem",
              }}
            >
              Invoice {recurInvoice.invoiceNum} ·{" "}
              {formatCurrency(recurInvoice.amount)}
            </p>

            {recurInvoice.isRecurring ? (
              <p style={{ fontSize: "0.85rem", marginBottom: "1.25rem" }}>
                This invoice currently recurs{" "}
                <strong>{recurInvoice.recurFrequency}</strong>. Stopping it will
                prevent any further auto-generated invoices.
              </p>
            ) : (
              <>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.75rem",
                    color: "var(--text-secondary)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: "0.25rem",
                  }}
                >
                  Frequency
                </label>
                <select
                  value={recurFreq}
                  onChange={(e) => setRecurFreq(e.target.value)}
                  className="input-field"
                  style={{
                    width: "100%",
                    padding: "0.55rem",
                    marginBottom: "1rem",
                  }}
                >
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
                <p
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-secondary)",
                    marginBottom: "1rem",
                  }}
                >
                  A new invoice will be auto-generated every{" "}
                  {recurFreq.replace("ly", "")} starting from this invoice due
                  date.
                </p>
              </>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "0.5rem",
              }}
            >
              <button
                onClick={() => setRecurInvoice(null)}
                style={{
                  padding: "0.5rem 1rem",
                  background: "transparent",
                  border: "1px solid var(--border-color)",
                  color: "var(--text-primary)",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const isStopping = recurInvoice.isRecurring;
                  try {
                    await fetchApi(
                      `/api/billing/${recurInvoice.id}/recurring`,
                      {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          isRecurring: !isStopping,
                          recurFrequency: isStopping ? null : recurFreq,
                        }),
                      },
                    );
                    setRecurInvoice(null);
                    loadData();
                  } catch (err) {
                    notify.error(
                      `Failed to ${isStopping ? "stop" : "activate"} recurring billing: ${err.message || err}`,
                    );
                  }
                }}
                style={{
                  padding: "0.5rem 1rem",
                  background: recurInvoice.isRecurring
                    ? "#ef4444"
                    : "var(--accent-color)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontWeight: 500,
                }}
              >
                {recurInvoice.isRecurring
                  ? "Stop recurring"
                  : `Activate ${recurFreq}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Invoice preview */}
      {pdfPreview && (
        <div
          onClick={() => setPdfPreview(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1.5rem",
            background: "rgba(15, 23, 42, 0.55)",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card"
            style={{
              display: "flex",
              flexDirection: "column",
              width: "min(980px, 100%)",
              height: "min(92vh, 900px)",
              overflow: "hidden",
              padding: 0,
              background: "var(--surface-color)",
              border: "1px solid var(--border-color)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
                padding: "0.85rem 1rem",
                borderBottom: "1px solid var(--border-color)",
              }}
            >
              <strong style={{ color: "var(--text-primary)" }}>
                Invoice preview: {pdfPreview.invoiceNum}
              </strong>
              <button
                type="button"
                onClick={() => setPdfPreview(null)}
                aria-label="Close invoice preview"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "2rem",
                  height: "2rem",
                  padding: 0,
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                <X size={17} />
              </button>
            </div>
            <iframe
              src={pdfPreview.url}
              title={`Invoice preview ${pdfPreview.invoiceNum}`}
              style={{
                width: "100%",
                flex: 1,
                minHeight: 0,
                border: 0,
                background: "#fff",
              }}
            />
          </div>
        </div>
      )}

      {/* Payment Link Modal */}
      {linkModal && (
        <div
          onClick={() => setLinkModal(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card"
            style={{
              background: "var(--surface-color)",
              color: "var(--text-primary)",
              padding: "2rem",
              borderRadius: "12px",
              minWidth: "420px",
              maxWidth: "520px",
              border: "1px solid var(--border-color)",
              backdropFilter: "blur(12px)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "1.25rem",
              }}
            >
              <h3
                style={{
                  fontSize: "1.1rem",
                  fontWeight: 600,
                  margin: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <CreditCard size={18} /> Payment Link
              </h3>
              <button
                onClick={() => setLinkModal(null)}
                aria-label="Close payment dialog"
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-secondary)",
                }}
              >
                <X size={18} />
              </button>
            </div>
            <p
              style={{
                fontSize: "0.85rem",
                color: "var(--text-secondary)",
                marginBottom: "1rem",
              }}
            >
              Share this link with{" "}
              <strong>{linkModal.inv.contact?.name || "the customer"}</strong>{" "}
              to collect payment for invoice{" "}
              <strong>{linkModal.inv.invoiceNum}</strong> (
              {formatCurrency(linkModal.inv.amount)}).
            </p>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                alignItems: "center",
                background: "var(--subtle-bg-2)",
                border: "1px solid var(--border-color)",
                borderRadius: "8px",
                padding: "0.6rem 0.75rem",
              }}
            >
              <span
                style={{
                  flex: 1,
                  fontSize: "0.82rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--text-primary)",
                }}
              >
                {linkModal.url}
              </span>
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(linkModal.url);
                  setLinkCopied(true);
                  setTimeout(() => setLinkCopied(false), 2500);
                }}
                style={{
                  flexShrink: 0,
                  padding: "0.35rem 0.75rem",
                  background: linkCopied
                    ? "var(--success-color)"
                    : "var(--accent-color)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  transition: "background 0.2s",
                }}
              >
                {linkCopied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p
              style={{
                fontSize: "0.75rem",
                color: "var(--text-secondary)",
                marginTop: "0.75rem",
                marginBottom: 0,
              }}
            >
              Powered by Razorpay · Payment is processed via your configured
              gateway keys.
            </p>
          </div>
        </div>
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        .invoices-grid { display: grid; grid-template-columns: minmax(360px, 420px) minmax(0, 1fr); gap: 1.5rem; align-items: start; }
        .invoices-grid > .card { align-self: start; }
        .invoice-create-form-scroll {
          scrollbar-width: thin;
          scrollbar-color: var(--border-color) transparent;
        }
        .invoice-create-form-scroll::-webkit-scrollbar {
          width: 8px;
        }
        .invoice-create-form-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .invoice-create-form-scroll::-webkit-scrollbar-thumb {
          background: var(--border-color);
          border-radius: 999px;
        }
        .invoice-line-items-list {
          min-width: 0;
          overflow-x: auto;
          padding-bottom: 0.15rem;
        }
        .invoice-line-item-row {
          display: grid;
          grid-template-columns: minmax(112px, 0.9fr) minmax(220px, 1.8fr) minmax(72px, 0.55fr) minmax(150px, 1fr) 40px;
          gap: 0.75rem;
          align-items: start;
          min-width: 650px;
        }
        .invoice-line-item-row > * {
          min-width: 0;
        }
        .invoice-line-item-row .input-field {
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
        }
        .invoice-table-scroll .top-scroll-sync__bottom {
          max-height: none;
          min-height: 0;
          overflow-y: visible;
        }
        .invoice-table-header th {
          position: sticky;
          top: 0;
          z-index: 3;
          background: var(--bg-color, #15171c) !important;
          background-color: var(--bg-color, #15171c) !important;
          background-clip: border-box;
          box-shadow: inset 0 -1px 0 var(--border-color);
        }
        [data-wellness-invoice="true"] th,
        [data-wellness-invoice="true"] td {
          vertical-align: middle;
          padding: 0.75rem !important;
          line-height: 1.35;
          box-sizing: border-box;
          text-align: left;
        }
        [data-wellness-invoice="true"] th {
          white-space: nowrap;
        }
        [data-wellness-invoice="true"] td:nth-child(1) {
          overflow-wrap: anywhere;
        }
        [data-wellness-invoice="true"] td:nth-child(2) > div,
        [data-wellness-invoice="true"] td:nth-child(3) > div {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        [data-wellness-invoice="true"] .invoice-actions-cell > div {
          display: flex;
          align-items: center;
          justify-content: flex-start;
          flex-wrap: wrap;
          column-gap: 0.35rem;
          row-gap: 0.4rem;
        }
        .invoice-actions-toolbar,
        .wellness-invoice-table .invoice-actions-cell > div.invoice-actions-toolbar {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: flex-start;
          gap: 0.6rem;
          min-width: max-content;
          flex-wrap: nowrap;
        }
        .invoice-action-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.4rem;
          min-height: 2rem;
          padding: 0.4rem 0.7rem;
          border: 1px solid var(--border-color);
          border-radius: 10px;
          background: var(--surface-color);
          color: var(--text-primary);
          cursor: pointer;
          font: inherit;
          font-size: 0.75rem;
          font-weight: 600;
          line-height: 1;
          transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
        }
        .invoice-action-button:hover,
        .invoice-action-button:focus-visible {
          border-color: var(--accent-color);
          background: color-mix(in srgb, var(--accent-color) 8%, var(--surface-color));
          box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
          outline: none;
        }
        .invoice-action-button--view svg {
          color: var(--accent-color);
        }
        .invoice-action-button--more {
          min-width: 5.25rem;
          justify-content: center;
          text-align: center;
        }
        .invoice-action-divider {
          width: 1px;
          height: 1.5rem;
          flex: 0 0 1px;
          background: var(--border-color);
        }
        .invoice-more-action {
          position: relative;
          display: inline-flex;
        }
        .invoice-actions-menu {
          position: absolute;
          top: calc(100% + 0.45rem);
          left: auto;
          right: 0;
          z-index: 100;
          width: 14.5rem;
          max-width: calc(100vw - 2rem);
          padding: 0.4rem;
          border: 1px solid var(--border-color);
          border-radius: 12px;
          background: var(--surface-color);
          box-shadow: 0 12px 28px rgba(15, 23, 42, 0.16);
          text-align: left;
        }
        .invoice-action-menu-item {
          display: flex;
          align-items: center;
          width: 100%;
          gap: 0.65rem;
          padding: 0.6rem 0.65rem;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: var(--text-primary);
          cursor: pointer;
          font: inherit;
          font-size: 0.78rem;
          line-height: 1.2;
          text-align: left;
        }
        .invoice-action-menu-item:hover,
        .invoice-action-menu-item:focus-visible {
          background: var(--hover-bg);
          outline: none;
        }
        .invoice-action-menu-item svg {
          flex: 0 0 auto;
          color: var(--accent-color);
        }
        .invoice-action-menu-item--danger,
        .invoice-action-menu-item--danger svg {
          color: var(--danger-color, #dc2626);
        }
        .invoice-actions-cell {
          white-space: nowrap;
          overflow: visible;
          text-align: left;
        }
        .invoice-actions-cell--menu-open {
          position: relative;
          z-index: 50;
          overflow: visible !important;
        }
        .invoice-actions-cell button {
          flex-shrink: 0;
          white-space: nowrap;
        }
        @media (max-width: 768px) {
          .invoices-grid { grid-template-columns: 1fr; gap: 1.25rem; }
          .invoice-table-scroll .top-scroll-sync__bottom {
            max-height: none;
          }
        }
      `}</style>
    </div>
  );
}
