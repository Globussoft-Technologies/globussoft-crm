import {
  useState,
  useContext,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import {
  Search,
  User,
  Briefcase,
  FileText,
  X,
  LayoutDashboard,
  Ticket,
  CheckSquare,
  FolderKanban,
  FileSpreadsheet,
  Mail,
  BookOpen,
  CornerDownLeft,
  HeartPulse,
  Map,
  Plane,
  Receipt,
  Building2,
  Compass,
  UserPlus,
  Users,
  ClipboardCheck,
  Brain,
  GraduationCap,
  Package,
  LayoutTemplate,
  Luggage,
  Camera,
  Calculator,
  FileStack,
  BadgeCheck,
  Key,
  Award,
  Ban,
  Sparkles,
  Code,
  CalendarClock,
  PanelTop,
  Palette,
  Inbox,
  CalendarDays,
  MessageSquare,
  IndianRupee,
  CreditCard,
  Wallet,
  BadgePercent,
  UsersRound,
  ShieldCheck,
  ScrollText,
  Shield,
  Settings,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { AuthContext } from "../App";
import { useActiveSubBrand } from "../utils/subBrand";
import {
  filterSidebarPages,
  canUseGenericSidebarPage,
  getGenericAccessByPath,
  getGenericSidebarPages,
  mergePagesByPath,
} from "../utils/sidebarSearch";
import { fetchApi } from "../utils/api";
import { SEARCH_DEBOUNCE_MS } from "../utils/timing";
import { formatMoney } from "../utils/money";
import { usePermissions } from "../hooks/usePermissions";
import { useSearchQuery } from "./search/SearchQueryContext";

const TRAVEL_PAGE_ICONS = {
  "/travel": Compass,
  "/leads": UserPlus,
  "/travel/pipeline": Plane,
  "/contacts": Users,
  "/travel/diagnostics": ClipboardCheck,
  "/travel/trip-knowledge": Brain,
  "/travel/curriculum-mappings": GraduationCap,
  "/travel/tmc/catalogue": Package,
  "/travel/itinerary-templates": LayoutTemplate,
  "/travel/itineraries": Map,
  "/travel/trips": Luggage,
  "/travel/sightseeing": Camera,
  "/travel/religious-packets": BookOpen,
  "/travel/quotes-admin": FileText,
  "/travel/flights/quote": Plane,
  "/travel/quotes/builder": Calculator,
  "/travel/quote-templates": FileStack,
  "/travel/passport-verification": BadgeCheck,
  "/travel/suppliers-admin": Building2,
  "/travel/suppliers": Key,
  "/travel/commission-profiles": Award,
  "/travel/cancellation-policies": Ban,
  "/travel/web-checkins": Ticket,
  "/travel/visa/applications": BadgeCheck,
  "/travel/visa/checklists": CheckSquare,
  "/travel/visa/embassy-rules": Shield,
  "/travel/brochures": Sparkles,
  "/travel/forms": Code,
  "/travel/meeting-forms": CalendarClock,
  "/landing-pages": PanelTop,
  "/admin/brand-kits": Palette,
  "/inbox": Inbox,
  "/tasks": CheckSquare,
  "/calendar-sync": CalendarDays,
  "/gmail": Mail,
  "/travel/reviews": MessageSquare,
  "/travel/school-terms": CalendarDays,
  "/travel/invoices-admin": Receipt,
  "/travel/tally": Calculator,
  "/travel/milestones": CalendarClock,
  "/travel/payables": CreditCard,
  "/payments": IndianRupee,
  "/expenses": Wallet,
  "/travel/cost-master": IndianRupee,
  "/travel/pricing-rules": BadgePercent,
  "/travel/reports": FileSpreadsheet,
  "/staff": UsersRound,
  "/settings/roles": ShieldCheck,
  "/audit-log": ScrollText,
  "/developer": Code,
  "/privacy": Shield,
  "/settings": Settings,
};

// Inline top-bar global search.
//
// Pre-refactor this was a Cmd/Ctrl+K modal overlay that searched three
// entities (contacts/deals/invoices). UX feedback: the modal was
// discovery-hostile (users didn't know it existed), the placeholder
// implied a strict allow-list of three things, and the backend already
// returned seven more result types (tickets/tasks/projects/contracts/
// estimates/emails/kb) that were silently dropped on the floor.
//
// New shape (v2 — optimized search engine):
//   - Always-visible inline input in the app header.
//   - Drop-down panel below the input shows results when query length >= 2.
//   - "Pages" section searches the user's accessible sidebar pages
//     client-side (from /api/pages/me), so users can jump to any page they
//     have permission for by typing its name or part of its description.
//     This makes the search bar the canonical SPA navigator for tenants
//     with 50+ sidebar items.
//   - Then 15+ backend result types render under their own headers: contacts,
//     deals, sequences, campaigns, invoices, tickets, tasks, projects, surveys,
//     contracts, estimates, emails, WhatsApp, knowledge base, patients.
//   - Case-insensitive search + expanded entity coverage optimizes discovery.
//   - Click a row → navigate via react-router (no full page reload).
//   - Ctrl/Cmd+K focuses the input (kept for power users).
//   - Escape clears + blurs.
//   - `omnibar:open` window event still focuses the input (back-compat
//     for any legacy caller).

const ENTITY_SECTIONS = [
  // Each section: results key on the API response, plural label rendered as
  // section header, icon, an accent colour for the icon chip, and a
  // (row, navigate) renderer that turns one row into JSX + handles its
  // click navigation. Keeping all section config in one table means a new
  // backend result type only needs one entry here to surface.
  {
    key: "pages",
    label: "Pages",
    icon: LayoutDashboard,
    color: "#a855f7",
    bg: "rgba(168, 85, 247, 0.12)",
    border: "rgba(168, 85, 247, 0.25)",
    render: (p) => ({
      primary: p.label,
      secondary: p.description || (p.parent ? `${p.parent} · ${p.path}` : p.category || p.path),
      to: p.path || p.route,
      actionTarget: p.actionTarget,
      icon: TRAVEL_PAGE_ICONS[p.path] || LayoutDashboard,
    }),
  },
  {
    key: "contacts",
    label: "Contacts",
    icon: User,
    color: "#3b82f6",
    bg: "rgba(59, 130, 246, 0.12)",
    border: "rgba(59, 130, 246, 0.25)",
    render: (c) => ({
      primary: c.company ? `${c.name} • ${c.company}` : c.name,
      secondary: c.email,
      to: `/contacts/${c.id}`,
    }),
  },
  {
    key: "itineraries",
    label: "Itineraries",
    icon: Map,
    color: "#0ea5e9",
    bg: "rgba(14, 165, 233, 0.12)",
    border: "rgba(14, 165, 233, 0.25)",
    render: (itinerary) => ({
      primary: itinerary.title || itinerary.destination,
      secondary: [itinerary.contact?.name, itinerary.subBrand, itinerary.status].filter(Boolean).join(" • "),
      to: `/travel/itineraries/${itinerary.id}`,
    }),
  },
  {
    key: "tmcTrips",
    label: "TMC Trips",
    icon: Plane,
    color: "#2563eb",
    bg: "rgba(37, 99, 235, 0.12)",
    border: "rgba(37, 99, 235, 0.25)",
    render: (trip) => ({
      primary: trip.tripCode ? `${trip.tripCode} • ${trip.destination}` : trip.destination,
      secondary: trip.status || "",
      to: `/travel/trips/${trip.id}`,
    }),
  },
  {
    key: "travelQuotes",
    label: "Travel Quotes",
    icon: FileText,
    color: "#8b5cf6",
    bg: "rgba(139, 92, 246, 0.12)",
    border: "rgba(139, 92, 246, 0.25)",
    render: (quote) => ({
      primary: `QT-${String(quote.id).padStart(4, "0")}${quote.contact?.name ? ` • ${quote.contact.name}` : ""}`,
      secondary: [quote.itinerary?.title || quote.itinerary?.destination, quote.subBrand, quote.status].filter(Boolean).join(" • "),
      to: `/travel/quotes/builder/${quote.id}`,
    }),
  },
  {
    key: "travelInvoices",
    label: "Travel Invoices",
    icon: Receipt,
    color: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.12)",
    border: "rgba(245, 158, 11, 0.25)",
    render: (invoice) => ({
      primary: invoice.invoiceNum,
      secondary: [invoice.subBrand, invoice.status, formatMoney(invoice.totalAmount, { currency: invoice.currency, maximumFractionDigits: 2 })].filter(Boolean).join(" • "),
      to: "/travel/invoices-admin",
    }),
  },
  {
    key: "travelSuppliers",
    label: "Suppliers",
    icon: Building2,
    color: "#14b8a6",
    bg: "rgba(20, 184, 166, 0.12)",
    border: "rgba(20, 184, 166, 0.25)",
    render: (supplier) => ({
      primary: supplier.name,
      secondary: [supplier.supplierCategory, supplier.subBrand, supplier.contactPerson || supplier.email].filter(Boolean).join(" • "),
      to: "/travel/suppliers-admin",
    }),
  },
  {
    // #1109 — wellness Patient surfacing in global search. Backend gates
    // this section to wellness-tenant + PHI-eligible viewers; for any
    // other caller the array is empty and the section silently doesn't
    // render. Row click deep-links to the patient detail page.
    key: "patients",
    label: "Patients",
    icon: HeartPulse,
    color: "#ec4899",
    bg: "rgba(236, 72, 153, 0.12)",
    border: "rgba(236, 72, 153, 0.25)",
    render: (p) => ({
      primary: p.name,
      secondary: [p.phone, p.email].filter(Boolean).join(" • "),
      to: `/wellness/patients/${p.id}`,
    }),
  },
  {
    key: "deals",
    label: "Pipeline",
    icon: Briefcase,
    color: "#10b981",
    bg: "rgba(16, 185, 129, 0.12)",
    border: "rgba(16, 185, 129, 0.25)",
    render: (d) => ({
      primary: d.title,
      secondary: `Stage: ${d.stage} • ${formatMoney(d.amount, { currency: d.currency, maximumFractionDigits: 0 })}`,
      to: "/pipeline",
    }),
  },
  {
    key: "sequences",
    label: "Sequences",
    icon: Mail,
    color: "#06b6d4",
    bg: "rgba(6, 182, 212, 0.12)",
    border: "rgba(6, 182, 212, 0.25)",
    render: (s) => ({
      primary: s.name,
      secondary: s.status || "Draft",
      to: "/sequences",
    }),
  },
  {
    key: "campaigns",
    label: "Campaigns",
    icon: Mail,
    color: "#8b5cf6",
    bg: "rgba(139, 92, 246, 0.12)",
    border: "rgba(139, 92, 246, 0.25)",
    render: (c) => ({
      primary: c.name,
      secondary: `${c.type || ""} • ${c.status || ""}`.trim(),
      to: "/marketing",
    }),
  },
  {
    key: "invoices",
    label: "Invoices",
    icon: FileText,
    color: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.12)",
    border: "rgba(245, 158, 11, 0.25)",
    render: (i) => ({
      primary: i.invoiceNum,
      secondary: `${i.contact?.name || "Unknown"} • ${formatMoney(i.amount, { maximumFractionDigits: 2 })}`,
      badge: i.status,
      badgeOk: i.status === "PAID",
      to: "/invoices",
    }),
  },
  {
    key: "tickets",
    label: "Tickets",
    icon: Ticket,
    color: "#ef4444",
    bg: "rgba(239, 68, 68, 0.12)",
    border: "rgba(239, 68, 68, 0.25)",
    render: (t) => ({
      primary: t.subject,
      secondary: `${t.status || ""}${t.priority ? ` • ${t.priority}` : ""}`,
      to: "/tickets",
    }),
  },
  {
    key: "tasks",
    label: "Tasks",
    icon: CheckSquare,
    color: "#06b6d4",
    bg: "rgba(6, 182, 212, 0.12)",
    border: "rgba(6, 182, 212, 0.25)",
    render: (t) => ({
      primary: t.title,
      secondary: `${t.status || ""}${t.priority ? ` • ${t.priority}` : ""}`,
      to: "/tasks",
    }),
  },
  {
    key: "projects",
    label: "Projects",
    icon: FolderKanban,
    color: "#8b5cf6",
    bg: "rgba(139, 92, 246, 0.12)",
    border: "rgba(139, 92, 246, 0.25)",
    render: (p) => ({
      primary: p.name,
      secondary: p.status || "",
      to: "/projects",
    }),
  },
  {
    key: "surveys",
    label: "Surveys",
    icon: FileSpreadsheet,
    color: "#14b8a6",
    bg: "rgba(20, 184, 166, 0.12)",
    border: "rgba(20, 184, 166, 0.25)",
    render: (s) => ({
      primary: s.title,
      secondary: `${s.type || ""} • ${s.status || ""}`.trim(),
      to: "/surveys",
    }),
  },
  {
    key: "contracts",
    label: "Contracts",
    icon: FileText,
    color: "#0ea5e9",
    bg: "rgba(14, 165, 233, 0.12)",
    border: "rgba(14, 165, 233, 0.25)",
    render: (c) => ({
      primary: c.title,
      secondary: c.status || "",
      to: "/contracts",
    }),
  },
  {
    key: "estimates",
    label: "Estimates",
    icon: FileSpreadsheet,
    color: "#84cc16",
    bg: "rgba(132, 204, 22, 0.12)",
    border: "rgba(132, 204, 22, 0.25)",
    render: (e) => ({
      primary: e.estimateNum ? `${e.estimateNum} — ${e.title || ""}` : e.title,
      secondary: e.status || "",
      to: "/estimates",
    }),
  },
  {
    key: "emails",
    label: "Email",
    icon: Mail,
    color: "#f43f5e",
    bg: "rgba(244, 63, 94, 0.12)",
    border: "rgba(244, 63, 94, 0.25)",
    render: (m) => ({
      primary: m.subject || "(no subject)",
      secondary:
        `${m.direction || ""} • ${m.from || ""} → ${m.to || ""}`.trim(),
      to: "/inbox",
    }),
  },
  {
    key: "whatsappMessages",
    label: "WhatsApp",
    icon: Mail,
    color: "#25d366",
    bg: "rgba(37, 211, 102, 0.12)",
    border: "rgba(37, 211, 102, 0.25)",
    render: (m) => ({
      primary: m.phoneNumber || "WhatsApp Message",
      secondary: m.body
        ? m.body.substring(0, 50) + (m.body.length > 50 ? "…" : "")
        : m.direction || "",
      to: "/wellness/whatsapp",
    }),
  },
  {
    key: "kbArticles",
    label: "Knowledge Base",
    icon: BookOpen,
    color: "#14b8a6",
    bg: "rgba(20, 184, 166, 0.12)",
    border: "rgba(20, 184, 166, 0.25)",
    render: (a) => ({
      primary: a.title,
      secondary: a.isPublished ? "Published" : "Draft",
      to: "/knowledge-base",
    }),
  },
];

function isWithinOneEdit(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + substitutionCost,
      );
      rowMinimum = Math.min(rowMinimum, current[column]);
    }
    if (rowMinimum > 1) return false;
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] <= 1;
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasCloseWordMatch(fieldWords, queryWords) {
  if (queryWords.length === 0 || queryWords.some((word) => word.length < 4)) return false;
  return queryWords.every((queryWord) =>
    fieldWords.some((fieldWord) => isWithinOneEdit(queryWord, fieldWord)),
  );
}

// Relevance scorer for the client-side page filter. It is case/diacritic
// insensitive, supports separated query words ("school calendar" matches
// "School Term Calendar"), and prioritizes visible labels over descriptions
// and task aliases. Travel also accepts one spelling error per query word.
function scorePageMatch(page, q, allowFuzzy = false) {
  if (!page || !q) return null;
  if (!allowFuzzy) {
    // Preserve the established Generic/Wellness substring behavior. The
    // relevance and typo-tolerance upgrade in this change is Travel-only.
    const needle = String(q).toLowerCase();
    const fields = [
      page.label,
      page.title,
      page.name,
      page.description,
      page.parent,
      page.category,
      page.path,
      page.route,
      ...(Array.isArray(page.aliases) ? page.aliases : [page.aliases]),
    ];
    let best = null;
    for (const field of fields) {
      if (!field) continue;
      const index = String(field).toLowerCase().indexOf(needle);
      if (index === -1) continue;
      const weight = field === page.label || field === page.title || field === page.name
        ? 0
        : field === page.description
          ? 100
          : field === page.parent
            ? 150
            : 200;
      const candidate = { score: weight + index, fuzzy: false, fieldRank: 0 };
      if (!best || candidate.score < best.score) best = candidate;
    }
    return best;
  }
  const needle = normalizeSearchText(q);
  const queryWords = needle.split(" ").filter(Boolean);
  if (!needle || queryWords.length === 0) return null;
  const fields = [
    { value: page.label, weight: 0, fieldRank: 0 },
    { value: page.title, weight: 0, fieldRank: 0 },
    { value: page.name, weight: 0, fieldRank: 0 },
    { value: page.description, weight: 200, fieldRank: 1 },
    { value: page.parent, weight: 300, fieldRank: 2 },
    ...((Array.isArray(page.aliases) ? page.aliases : [page.aliases])
      .map((value) => ({ value, weight: 400, fieldRank: 3 }))),
    { value: page.category, weight: 500, fieldRank: 4 },
    { value: page.path, weight: 550, fieldRank: 5 },
    { value: page.route, weight: 550, fieldRank: 5 },
  ];
  let best = null;
  for (const { value, weight, fieldRank } of fields) {
    if (!value) continue;
    const field = normalizeSearchText(value);
    const fieldWords = field.split(" ").filter(Boolean);
    const phraseIndex = field.indexOf(needle);
    const allWordsMatch = queryWords.every((word) => fieldWords.includes(word));
    const fuzzy = phraseIndex === -1 && !allWordsMatch && allowFuzzy && hasCloseWordMatch(fieldWords, queryWords);
    if (phraseIndex === -1 && !allWordsMatch && !fuzzy) continue;

    let matchScore;
    if (field === needle) matchScore = 0;
    else if (field.startsWith(`${needle} `)) matchScore = 10;
    else if (phraseIndex >= 0) matchScore = 20 + phraseIndex;
    else if (allWordsMatch) matchScore = 60;
    else matchScore = 100;

    const candidate = { score: weight + matchScore, fuzzy, fieldRank };
    if (!best || candidate.score < best.score) best = candidate;
  }
  return best;
}

function resultKey(sectionKey, row, idx) {
  return `${sectionKey}-${row.id ?? row.path ?? idx}`;
}

export default function Omnibar() {
  const [results, setResults] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [pagesIndex, setPagesIndex] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const { query, setQuery, clearQuery } = useSearchQuery();

  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const optionRefs = useRef([]);
  const searchRequestIdRef = useRef(0);
  const navigate = useNavigate();
  const { user, tenant } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  const { hasPermission, isReady: permissionsReady } = usePermissions();
  const role = user?.role || "USER";
  const isAdmin = role === "ADMIN";
  const isManager = role === "ADMIN" || role === "MANAGER";


  // Pull the user's accessible pages once so the "Pages" section can match
  // sidebar items locally — no server round-trip per keystroke. The same
  // endpoint feeds the wellness sidebar, so the cache is shared.
  useEffect(() => {
    let cancelled = false;
    fetchApi("/api/pages/me", { silent: true })
      .then((res) => {
        if (cancelled) return;
        setPagesIndex(Array.isArray(res) ? res : (Array.isArray(res?.pages) ? res.pages : []));
      })
      .catch(() => {
        if (cancelled) return;
        setPagesIndex([]);
      });
    const onInvalidate = () => {
      fetchApi("/api/pages/me", { silent: true })
        .then((res) =>
            setPagesIndex(Array.isArray(res) ? res : (Array.isArray(res?.pages) ? res.pages : [])),
        )
        .catch(() => {});
    };
    window.addEventListener("sidebar:pages-changed", onInvalidate);
    return () => {
      cancelled = true;
      window.removeEventListener("sidebar:pages-changed", onInvalidate);
    };
  }, []);

  // Generic Pages are queried server-side as the user types. This keeps the
  // API's permission-filtered page catalog as the search source while the
  // existing local merge remains available for Generic sidebar-only links.
  useEffect(() => {
    if (tenant?.vertical !== "generic" || query.trim().length < 2) return undefined;
    let cancelled = false;
    fetchApi(`/api/pages/me?q=${encodeURIComponent(query.trim())}`, { silent: true })
      .then((res) => {
        if (!cancelled && (Array.isArray(res) || Array.isArray(res?.pages))) setPagesIndex(Array.isArray(res) ? res : res.pages);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [query, tenant?.vertical]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ctrl/Cmd+K focuses the inline input. No more open/close toggle —
      // the input is always in the DOM, so the shortcut becomes a
      // "jump to search" affordance.
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select?.();
      }
      if (e.key === "Escape") {
        if (document.activeElement === inputRef.current || query) {
          clearQuery();
          setIsFocused(false);
          inputRef.current?.blur();
        }
      }
    };

    // #851 — let other components (e.g. the legacy header magnifier icon)
    // focus the search input via a custom event. Kept for back-compat with
    // callers that haven't migrated.
    const handleExternalOpen = () => {
      inputRef.current?.focus();
      inputRef.current?.select?.();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("omnibar:open", handleExternalOpen);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("omnibar:open", handleExternalOpen);
    };
  }, [query, clearQuery]);

  // Close dropdown on outside click. Doesn't blur the input — users can
  // re-focus and resume the same query without retyping.
  useEffect(() => {
    const onPointerDown = (e) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target)) return;
      setIsFocused(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  // Server-backed search debounced behind SEARCH_DEBOUNCE_MS. Page matches
  // are client-side and update synchronously on every keystroke (so the
  // user sees their sidebar results without waiting on the network).
  useEffect(() => {
    const requestId = ++searchRequestIdRef.current;
    const normalizedQuery = query.trim();
    if (tenant?.vertical === "travel" && normalizedQuery.length >= 2) {
      // Do not display record matches from the previous query while the new
      // request is waiting for the debounce/network.
      setResults({});
      setSearchError(false);
      setIsLoading(true);
    }
    const fetchOmni = async () => {
      if (normalizedQuery.length < 2) {
        setResults({});
        setSearchError(false);
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      try {
        let searchUrl = `/api/search?q=${encodeURIComponent(normalizedQuery)}`;
        if (tenant?.vertical === "travel" && activeSubBrand) {
          searchUrl += `&subBrand=${encodeURIComponent(activeSubBrand)}`;
        }
        const data = tenant?.vertical === "travel"
          ? await fetchApi(searchUrl, { silent: true })
          : await fetchApi(searchUrl);
        if (requestId === searchRequestIdRef.current) {
          setResults(data || {});
          setSearchError(false);
        }
      } catch (err) {
        if (requestId === searchRequestIdRef.current) {
          console.error(err);
          setResults({});
          setSearchError(true);
        }
      }
      if (requestId === searchRequestIdRef.current) setIsLoading(false);
    };
    const debounce = setTimeout(fetchOmni, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(debounce);
  }, [query, tenant?.vertical, activeSubBrand]);

  // Client-side page match. The catalog is small (~70 entries) so a linear
  // scan + sort per keystroke is cheap. Keep every matching sidebar page in
  // the scrollable panel; an arbitrary eight-item cap made broad searches
  // hide valid destinations.
  const visiblePagesIndex = useMemo(
    () => {
      const genericSidebarPages =
        tenant?.vertical === "generic" || !tenant?.vertical
          ? getGenericSidebarPages({
              isAdmin,
              isManager,
              permissionsReady,
              hasPermission,
            })
          : [];
      // The API catalog is normally permission-filtered, but keep the client
      // side merge defensive: a stale response must not reintroduce a generic
      // page that the current role cannot access (notably Settings).
      const permissionFilteredPages =
        tenant?.vertical === "generic"
          ? pagesIndex.filter((page) => {
              const spec = getGenericAccessByPath(page?.path);
              return !spec || canUseGenericSidebarPage(spec, {
                isAdmin,
                isManager,
                permissionsReady,
                hasPermission,
              });
            })
          : pagesIndex;
      const mergedPages = mergePagesByPath(permissionFilteredPages, genericSidebarPages);
      return filterSidebarPages(mergedPages, {
        vertical: tenant?.vertical || null,
        activeSubBrand,
        subBrandAccess: user?.subBrandAccess,
      });
    },
    [
      pagesIndex,
      tenant?.vertical,
      activeSubBrand,
      user?.subBrandAccess,
      isAdmin,
      isManager,
      permissionsReady,
      hasPermission,
    ],
  );

  const pageMatches = useMemo(() => {
    const queryLength = tenant?.vertical === "travel" ? query.trim().length : query.length;
    if (queryLength < 2 || !Array.isArray(visiblePagesIndex)) return [];
    const scored = [];
    for (const p of visiblePagesIndex) {
      const match = scorePageMatch(p, query, tenant?.vertical === "travel");
      if (match) scored.push({ page: p, ...match });
    }
    scored.sort((a, b) => a.score - b.score);
    // When at least one Travel page title matches, suppress alias/category/
    // path-only matches. Description matches remain useful for broad searches,
    // while Meeting Forms' "calendar booking" alias no longer pollutes an
    // actual Calendar title search.
    const hasTravelLabelMatch = tenant?.vertical === "travel"
      && scored.some((item) => item.fieldRank === 0);
    return scored
      .filter((item) => !hasTravelLabelMatch || item.fieldRank <= 2)
      .map((item) => item.page);
  }, [query, visiblePagesIndex, tenant?.vertical]);

  // Merge pages (client) + backend results into a single resultSet that the
  // section table iterates over.
  const resultSet = useMemo(
    () => ({ pages: pageMatches, ...results }),
    [pageMatches, results],
  );

  const totalResultCount = useMemo(() => {
    return ENTITY_SECTIONS.reduce(
      (sum, s) => sum + (resultSet[s.key]?.length || 0),
      0,
    );
  }, [resultSet]);

  const flatResults = useMemo(() => {
    const rows = [];
    ENTITY_SECTIONS.forEach((section) => {
      (resultSet[section.key] || []).forEach((row, idx) => {
        rows.push({
          section,
          row,
          idx,
          key: resultKey(section.key, row, idx),
          rendered: section.render(row),
        });
      });
    });
    return rows;
  }, [resultSet]);

  const handleRowClick = useCallback(
    ({ to, actionTarget } = {}) => {
      if (to) navigate(to);
      else if (actionTarget) document.querySelector(actionTarget)?.click();
      setIsFocused(false);
      inputRef.current?.blur();
    },
    [navigate],
  );

  const showDropdown = isFocused && (tenant?.vertical === "travel" ? query.trim().length : query.length) >= 2;
  const activeOptionId = activeIndex >= 0 ? `omnibar-option-${flatResults[activeIndex]?.key}` : undefined;

  useEffect(() => {
    setActiveIndex(flatResults.length > 0 ? 0 : -1);
  }, [query, flatResults.length]);

  useEffect(() => {
    if (activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeIndex]);

  const handleInputKeyDown = (e) => {
    if (!showDropdown || flatResults.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((current) => (current + 1) % flatResults.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((current) =>
        current <= 0 ? flatResults.length - 1 : current - 1,
      );
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(flatResults.length - 1);
      return;
    }
    if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      handleRowClick(flatResults[activeIndex]?.rendered);
    }
  };

  return (
    <div
      className="omnibar-root"
      ref={containerRef}
      data-testid="omnibar-root"
      data-tour="welcome-global-search"
      style={{
        position: "relative",
        // Left-aligned, fixed-but-comfortable width. Earlier shape was
        // `flex: 1 1 540px` which stretched the bar across all free
        // header space, visually centering it between the hamburger and
        // the right-side controls. Switched to a bounded width + margin-
        // right: auto so the bar sits at the start of the header and
        // the right-side controls (chip / bell / profile / theme /
        // logout) keep their natural flex-end alignment.
        width: "min(420px, 38vw)",
        minWidth: 220,
        marginRight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          // Use the theme's neutral subtle-bg directly. The earlier
          // var(--input-bg, …) chain inherited the generic dark theme's
          // slate-blue tint on wellness (which has no --input-bg override),
          // making the bar read as off-brand blue against the wellness
          // cream/teal palette. --subtle-bg is already theme-tinted in
          // both verticals.
          background: "var(--subtle-bg)",
          border: `1px solid ${isFocused ? "var(--accent-color)" : "var(--border-color)"}`,
          borderRadius: 10,
          padding: "6px 10px",
          height: 36,
          transition: "border-color 0.15s ease, box-shadow 0.15s ease",
          boxShadow: isFocused
            ? "0 0 0 3px var(--accent-glow, rgba(99,102,241,0.18))"
            : "none",
        }}
      >
        <Search
          size={16}
          color="var(--text-secondary)"
          style={{ flexShrink: 0 }}
        />
        <input
          ref={inputRef}
          type="text"
          // The wellness theme injects a global `input:focus` rule
          // (border + box-shadow with `!important`) that overrides inline
          // styles and renders a rectangular teal focus ring INSIDE this
          // search bar. `naked-input` is the documented opt-out (see
          // theme/wellness.css:213) for icon-prefixed inputs where the
          // wrapper already owns the focus chrome.
          className="naked-input"
          placeholder={tenant?.vertical === "travel"
            ? "Search Travel CRM…"
            : "Search pages, contacts, deals, invoices, campaigns, sequences, surveys…"}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsFocused(true);
          }}
          onFocus={() => setIsFocused(true)}
          onKeyDown={handleInputKeyDown}
          aria-label={tenant?.vertical === "travel" ? "Search Travel CRM" : "Global search"}
          aria-autocomplete="list"
          aria-controls="omnibar-results"
          aria-expanded={showDropdown}
          aria-activedescendant={activeOptionId}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            color: "var(--text-primary)",
            fontSize: "0.9rem",
            padding: 0,
            outline: "none",
            minWidth: 0,
          }}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              clearQuery();
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              padding: 2,
              display: "flex",
              alignItems: "center",
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {showDropdown && (
        <div
          id="omnibar-results"
          role="listbox"
          aria-label="Search results"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            right: 0,
            zIndex: 999,
            background: "var(--surface-color)",
            border: "1px solid var(--border-color)",
            borderRadius: 12,
            boxShadow: "var(--shadow-lg, 0 25px 50px -12px rgba(0,0,0,0.5))",
            backdropFilter: "blur(12px)",
            maxHeight: "70vh",
            overflowY: "auto",
          }}
        >
          {isLoading && totalResultCount === 0 && (
            <div
              style={{
                padding: "1.5rem 1.25rem",
                textAlign: "center",
                color: "var(--text-secondary)",
                fontSize: "0.85rem",
              }}
            >
              Searching…
            </div>
          )}

          {tenant?.vertical === "travel" && searchError && totalResultCount === 0 && (
            <div
              role="status"
              style={{
                padding: "2rem 1.25rem",
                textAlign: "center",
                color: "var(--text-secondary)",
                fontSize: "0.875rem",
              }}
            >
              Search is temporarily unavailable. Please try again.
            </div>
          )}

          {!isLoading && (tenant?.vertical !== "travel" || !searchError) && totalResultCount === 0 && (
            <div
              style={{
                padding: "2rem 1.25rem",
                textAlign: "center",
                color: "var(--text-secondary)",
                fontSize: "0.875rem",
              }}
            >
              {tenant?.vertical === "travel" ? "No results for “" : "No algorithmic matches located for “"}
              <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                {tenant?.vertical === "travel" ? query.trim() : query}
              </span>
              {tenant?.vertical === "travel"
                ? "”. Try a customer, destination, trip code, quote, invoice, supplier, or page."
                : "” within the enterprise dataset."}
            </div>
          )}

          {totalResultCount > 0 && (
            <div style={{ padding: "0.4rem" }}>
              {ENTITY_SECTIONS.map((section) => {
                const rows = resultSet[section.key] || [];
                if (rows.length === 0) return null;
                const Icon = section.icon;
                return (
                  <div key={section.key} style={{ marginBottom: "0.25rem" }}>
                    <h4
                      style={{
                        fontSize: "0.7rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "var(--text-secondary)",
                        padding: "0.5rem 0.75rem 0.25rem",
                        margin: 0,
                        fontWeight: 700,
                      }}
                    >
                      {section.label}
                    </h4>
                    {rows.map((row, idx) => {
                      const optionKey = resultKey(section.key, row, idx);
                      const optionIndex = flatResults.findIndex((item) => item.key === optionKey);
                      const isActive = optionIndex === activeIndex;
                      const r = flatResults[optionIndex]?.rendered || section.render(row);
                      const RowIcon = r.icon || Icon;
                      return (
                        <button
                          key={optionKey}
                          id={`omnibar-option-${optionKey}`}
                          ref={(node) => {
                            if (optionIndex >= 0) optionRefs.current[optionIndex] = node;
                          }}
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          onClick={() => handleRowClick(r)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.75rem",
                            padding: "0.5rem 0.75rem",
                            width: "100%",
                            background: isActive
                              ? "var(--hover-bg, var(--subtle-bg))"
                              : "transparent",
                            border: "none",
                            cursor: "pointer",
                            borderRadius: 8,
                            textAlign: "left",
                            transition: "background 0.12s ease",
                            color: "var(--text-primary)",
                          }}
                          onMouseOver={(e) => {
                            if (optionIndex >= 0) setActiveIndex(optionIndex);
                            e.currentTarget.style.background =
                              "var(--hover-bg, var(--subtle-bg))";
                          }}
                          onMouseOut={(e) => {
                            e.currentTarget.style.background = isActive
                              ? "var(--hover-bg, var(--subtle-bg))"
                              : "transparent";
                          }}
                        >
                          <div
                            style={{
                              background: section.bg,
                              padding: 7,
                              borderRadius: 8,
                              border: `1px solid ${section.border}`,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                            }}
                          >
                            <RowIcon size={16} color={section.color} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                fontWeight: 500,
                                fontSize: "0.9rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {r.primary}
                              {r.badge && (
                                <span
                                  style={{
                                    fontSize: "0.65rem",
                                    padding: "0.1rem 0.4rem",
                                    borderRadius: 4,
                                    background: r.badgeOk
                                      ? "rgba(16, 185, 129, 0.18)"
                                      : "rgba(239, 68, 68, 0.18)",
                                    color: r.badgeOk ? "#10b981" : "#ef4444",
                                    marginLeft: "0.5rem",
                                    verticalAlign: "middle",
                                    fontWeight: 600,
                                  }}
                                >
                                  {r.badge}
                                </span>
                              )}
                            </div>
                            {r.secondary && (
                              <div
                                style={{
                                  fontSize: "0.78rem",
                                  color: "var(--text-secondary)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  marginTop: 2,
                                }}
                              >
                                {r.secondary}
                              </div>
                            )}
                          </div>
                          <CornerDownLeft
                            size={12}
                            color="var(--text-secondary)"
                            style={{ opacity: 0.5, flexShrink: 0 }}
                          />
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}

          <div
            style={{
              padding: "0.5rem 0.9rem",
              borderTop: "1px solid var(--border-color)",
              fontSize: "0.7rem",
              color: "var(--text-secondary)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>
              Press{" "}
              <kbd
                style={{
                  padding: "0.1rem 0.35rem",
                  border: "1px solid var(--border-color)",
                  borderRadius: 4,
                  background: "var(--kbd-bg, var(--subtle-bg-3))",
                  fontFamily: "inherit",
                }}
              >
                Esc
              </kbd>{" "}
              to close
            </span>
            <span style={{ opacity: 0.6 }}>
              {tenant?.vertical === "travel"
                ? "Use ↑↓ to navigate · Enter to open"
                : "Federated Multi-Index Search Matrix"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
